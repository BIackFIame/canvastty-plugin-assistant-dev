// Auto (Jev) chooses from data, offline: matching upstream model ids to catalog rows (no score moves between
// variants; unmatched stays unknown), the inventory (OpenRouter's list, the person's ids, exclusions, prices and
// limits), selection for each preference, unknown scores, the conservative "small" rule, Jev's answers → type and
// difficulty, the word-rule fallback, and — through the real router — effort variants, cooldowns, caps and the log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeArtificialAnalysis } from '../src/auto/catalog/artificialAnalysis.ts';
import { normalizeBenchmarks, normalizeModels } from '../src/auto/catalog/catalog.ts';
import { normalizeOpenRouterModels } from '../src/auto/catalog/openrouter.ts';
import { BenchmarkIndex, bareModelId, effectiveEffort, variantScores } from '../src/auto/catalog/scoring.ts';
import { buildInventory } from '../src/auto/inventory.ts';
import { limitsFor } from '../src/auto/launch.ts';
import { AutoRouter } from '../src/auto/router.ts';
import { decisionFromTriage, plan, ruleTaskType, turnView, QUALITY_LOSS, SMALL_CONFIDENCE } from '../src/auto/select.ts';
import { validateAutoSettings } from '../src/auto/settings.ts';
import { readTriage } from '../src/triage/triage.ts';
import { scoreAnswer, choiceAnswer } from '../src/shared/systemOne.ts';
import { aaHtml, DAY, livebenchCategories, livebenchCsv, modelsDev, openRouterList } from './helpers/catalog-fixtures.mjs';
import { startFakeUpstream } from './helpers/fake-upstream.mjs';

const epoch = Date.parse('2026-10-18T10:00:00Z');
const base = realpathSync(mkdtempSync(join(tmpdir(), 'canvastty-auto-select-')));
process.on('exit', () => rmSync(base, { recursive: true, force: true }));

function routingCatalog({ at = epoch, now = epoch, openRouter = true } = {}) {
  const { models, providers } = normalizeModels(modelsDev());
  const benchmarks = [...normalizeArtificialAnalysis(aaHtml(), at), ...normalizeBenchmarks(livebenchCsv(), livebenchCategories(), '2026-10-01', at)];
  return {
    asOf: now, benchmarks: benchmarks.map(row => ({ ...row, historical: now - row.source.fetchedAt > 7 * DAY })), models, providers,
    pricesStale: now - at > 7 * DAY,
    openRouter: openRouter ? { version: 1, fetchedAt: at, models: normalizeOpenRouterModels(openRouterList()) } : null,
    openRouterPricesStale: now - at > 7 * DAY
  };
}

const settings = (upstreams, extra = {}) => validateAutoSettings({ upstreams, preference: 'balanced', cheaperFallback: false, decider: 'jev', dailyUsdCap: 1, perCardUsdCap: 1, ...extra });
const openRouter = (extra = {}) => ({ id: 'or', preset: 'openrouter', trust: 'D1', key: 'own', enabled: true, models: [], ...extra });
const direct = (models, extra = {}) => ({ id: 'direct', preset: 'openai-compatible', baseUrl: 'https://api.direct.example/v1', trust: 'D1', key: 'own', enabled: true, models, ...extra });
const view = (type, level, confidence = null, from = 'jev') => turnView({ difficulty: level === 'small' ? 'simple' : level === 'large' ? 'hard' : 'normal', strong: false, type, confidence }, from, '');
const healthy = inventory => inventory.entries.filter(entry => entry.upstream.enabled && !entry.excluded);
const first = (inventory, request, preference = 'balanced') => {
  const chosen = plan(healthy(inventory), { kind: 'turn', preferred: null, ...request }, { preference, cheaperFallback: false });
  return { key: chosen.list[0]?.key ?? null, why: chosen.why, chosen };
};

test('matching: the bare model name, separators only; vendor prefixes and routing suffixes go, nothing else', () => {
  assert.equal(bareModelId('z-ai/glm-5.3'), 'glm-5.3');
  assert.equal(bareModelId('vendor/alpha-1:free'), 'alpha-1');
  assert.equal(bareModelId('vendor/alpha-1:thinking'), 'alpha-1:thinking', 'a different setup stays different');
  assert.equal(bareModelId('~anthropic/claude-opus-latest'), null, 'a moving alias never matches');
  const index = new BenchmarkIndex(routingCatalog());
  const ctx = { openRouter: true, origin: null };
  assert.equal(variantScores(index, 'alpha-1', 'high', ctx, 'coding').size, 2, 'one row per source (Artificial Analysis, LiveBench)');
  assert.equal(variantScores(index, 'Alpha_1', 'high', ctx, 'coding').size, 2, 'case and separators');
  assert.equal(variantScores(index, 'alpha-1', null, ctx, 'coding').size, 0, 'no effort: no row of its own, so unknown — never the high or low score');
  assert.equal(variantScores(index, 'alpha-1', 'medium', ctx, 'coding').size, 0, 'an unmeasured effort stays unknown');
  assert.equal(variantScores(index, 'alpha-1-mini', 'high', ctx, 'coding').size, 0, 'no family match');
  assert.equal(variantScores(index, 'gamma-3', null, ctx, 'coding').size, 0, 'an unnamed reasoning setup is never scored');
  assert.equal(variantScores(index, 'epsilon-5', 'high', ctx, 'coding').size, 0, 'a token-budget variant is never scored');
  assert.deepEqual(index.measuredEfforts('alpha-1').sort(), ['high', 'low']);
  // A vendor's documented default applies on its own API only, never through a reseller.
  assert.deepEqual(effectiveEffort('glm-5.3', null, { openRouter: false, origin: 'https://api.z.ai' }), { effort: 'max', documentedDefault: true });
  assert.deepEqual(effectiveEffort('glm-5.3', null, { openRouter: true, origin: null }), { effort: null, documentedDefault: false });
  assert.equal(variantScores(index, 'glm-5.3', null, { openRouter: false, origin: 'https://api.z.ai' }, 'coding').values().next().value.documentedDefault, true);
  assert.equal(variantScores(index, 'glm-5.3', null, { openRouter: true, origin: null }, 'coding').size, 0);
  assert.equal(variantScores(index, 'beta-2', null, ctx, 'coding').size, 2, 'Artificial Analysis and LiveBench');
});

test('inventory: OpenRouter\'s suitable models with list prices and limits, effort variants only where measured, the person\'s overrides and exclusions', () => {
  const s = settings([openRouter({ models: [{ id: 'vendor/gamma-3', tier: 'large' }, { id: 'vendor/extra', priceIn: 2, priceOut: 3 }], excluded: ['vendor/delta-4'] })]);
  const inventory = buildInventory(s, routingCatalog());
  const keys = inventory.entries.map(entry => entry.key).sort();
  assert.deepEqual(keys, ['or|vendor/alpha-1|', 'or|vendor/alpha-1|high', 'or|vendor/alpha-1|low', 'or|vendor/beta-2|', 'or|vendor/delta-4|', 'or|vendor/delta-4|high', 'or|vendor/extra|', 'or|vendor/gamma-3|'].sort());
  const byKey = Object.fromEntries(inventory.entries.map(entry => [entry.key, entry]));
  assert.deepEqual([byKey['or|vendor/alpha-1|high'].priceIn, byKey['or|vendor/alpha-1|high'].priceOut, byKey['or|vendor/alpha-1|high'].priceSource, byKey['or|vendor/alpha-1|high'].context], [1, 4, 'openrouter', 400_000]);
  assert.equal(byKey['or|vendor/alpha-1|high'].sendEffort, true);
  assert.equal(byKey['or|vendor/alpha-1|high'].scores.coding.value, 57.5);
  assert.equal(byKey['or|vendor/alpha-1|'].scores.coding, undefined, 'the default variant stays unknown');
  assert.equal(byKey['or|vendor/beta-2|'].scores.coding.value, 55);
  assert.equal(byKey['or|vendor/gamma-3|'].tier, 'large');
  assert.equal(byKey['or|vendor/gamma-3|'].scores.coding, undefined);
  assert.equal(byKey['or|vendor/extra|'].priceSource, 'person');
  assert.equal(byKey['or|vendor/extra|'].known, false);
  assert.equal(byKey['or|vendor/delta-4|high'].excluded, true);
  assert.match(inventory.cohorts.coding, /^artificial-analysis:4\.3\.2:/u, 'the source covering the most models');
  // The writing type: Artificial Analysis has none; LiveBench is the only cohort.
  assert.match(inventory.cohorts.writing, /^livebench:2026-10-01/u);
  // An OpenAI-compatible upstream: the person's ids only; prices from models.dev for that origin.
  const own = buildInventory(settings([direct([{ id: 'beta-2' }, { id: 'unknown-model' }])]), routingCatalog());
  assert.deepEqual(own.entries.map(entry => [entry.model, entry.priceIn, entry.priceOut, entry.priceSource, entry.context, !!entry.scores.coding]),
    [['beta-2', 0.3, 1, 'models.dev', 128_000, true], ['unknown-model', null, null, null, null, false]]);
  // Old prices are not compared: after 8 days the list's and models.dev's prices are unknown (scores stay).
  const old = buildInventory(s, routingCatalog({ now: epoch + 8 * DAY }));
  const stale = old.entries.find(entry => entry.key === 'or|vendor/alpha-1|high');
  assert.deepEqual([stale.priceIn, stale.priceSource, stale.scores.coding.value, stale.scores.coding.historical], [null, null, 57.5, true]);
  // Without the list yet: the upstream waits for it.
  assert.deepEqual(buildInventory(s, routingCatalog({ openRouter: false })).waitingForList, ['or']);
});

test('selection by preference: best score always; price may cost score only on a confidently small turn (cheap 10, balanced 3, best 0)', () => {
  const inventory = buildInventory(settings([openRouter({ excluded: ['vendor/delta-4'] })]), routingCatalog());
  assert.deepEqual(QUALITY_LOSS, { best: 0, balanced: 3, cheap: 10 });
  for (const preference of ['cheap', 'balanced', 'best']) {
    assert.equal(first(inventory, { view: view('coding', 'large') }, preference).key, 'or|vendor/alpha-1|high', `${preference}: a large turn takes the best score`);
    assert.equal(first(inventory, { view: view('coding', 'medium') }, preference).key, 'or|vendor/alpha-1|high', `${preference}: so does a medium one`);
  }
  // A confidently small coding turn: alpha@high 57.5 ($13 blended) vs beta 55 ($6.5).
  const small = view('coding', 'small', 0.95);
  assert.equal(small.level, 'small'); assert.equal(small.confident, true);
  assert.deepEqual(Object.values(first(inventory, { view: small }, 'cheap')).slice(0, 2), ['or|vendor/beta-2|', 'cheaper_within_loss']);
  assert.deepEqual(Object.values(first(inventory, { view: small }, 'balanced')).slice(0, 2), ['or|vendor/beta-2|', 'cheaper_within_loss'], '2.5 points ≤ 3');
  assert.deepEqual(Object.values(first(inventory, { view: small }, 'best')).slice(0, 2), ['or|vendor/alpha-1|high', 'best_score']);
  // Not confident enough: "small" becomes medium, no loss allowed.
  const unsure = view('coding', 'small', SMALL_CONFIDENCE - 0.01);
  assert.equal(unsure.level, 'medium');
  assert.equal(first(inventory, { view: unsure }, 'cheap').key, 'or|vendor/alpha-1|high');
  // Rules: a "simple" turn is small but never confident: no loss either.
  const rules = turnView({ difficulty: 'simple', strong: false }, 'rules', 'Fix a typo in the README');
  assert.deepEqual([rules.level, rules.confident, rules.type], ['small', false, 'writing']);
  assert.equal(first(inventory, { view: rules }, 'cheap').key, 'or|vendor/beta-2|', 'writing compares in LiveBench (Artificial Analysis has no writing): beta 82.5 over alpha@high 72.5');
});

test('ties go to the cheaper model; a lower effort wins among equals; the failover list continues by score, then unknowns', () => {
  const s = settings([openRouter({ excluded: ['vendor/alpha-1', 'vendor/delta-4'] }), direct([{ id: 'beta-2' }])]);
  const inventory = buildInventory(s, routingCatalog());
  const chosen = first(inventory, { view: view('coding', 'large') });
  assert.equal(chosen.key, 'direct|beta-2|', 'the same row (55) on both upstreams: the cheaper one ($0.3/$1 vs $0.5/$2)');
  assert.equal(chosen.why, 'cheaper_tie');
  assert.deepEqual(chosen.chosen.list.map(entry => entry.key), ['direct|beta-2|', 'or|vendor/beta-2|', 'or|vendor/gamma-3|']);
});

test('unknown scores: never ahead of known ones; with none known, manual tiers first, else the known model of middle price', () => {
  const s = settings([direct([{ id: 'beta-2' }, { id: 'mystery', priceIn: 0.01, priceOut: 0.01 }])]);
  const inventory = buildInventory(s, routingCatalog());
  assert.equal(first(inventory, { view: view('coding', 'small', 0.99) }, 'cheap').key, 'direct|beta-2|', 'a cheap unknown never beats a known score');
  // Nothing scored: middle price among models the catalog knows (here via models.dev), not the cheapest.
  const unscored = buildInventory(settings([direct([{ id: 'alpha-1', priceIn: 0.1, priceOut: 0.1 }, { id: 'glm-5.3' }, { id: 'beta-2', priceIn: 9, priceOut: 9 }, { id: 'mystery', priceIn: 0.01, priceOut: 0.01 }])]),
    { ...routingCatalog(), benchmarks: [] });
  const fallback = first(unscored, { view: view('coding', 'medium') });
  assert.equal(fallback.why, 'unknown_scores');
  assert.equal(fallback.key, 'direct|glm-5.3|', 'known (models.dev) and the middle of 0.4 / 14.6 / 36 blended');
  assert.deepEqual(fallback.chosen.list.map(entry => entry.key), ['direct|glm-5.3|', 'direct|beta-2|', 'direct|mystery|', 'direct|alpha-1|'], 'known models by distance from the middle price, then the unknown ones by price');
  // A manual tier: the person's choice answers its tier first, whatever the scores say.
  const tiered = buildInventory(settings([openRouter({ models: [{ id: 'vendor/gamma-3', tier: 'medium' }] })]), routingCatalog());
  assert.deepEqual(Object.values(first(tiered, { view: view('coding', 'medium') })).slice(0, 2), ['or|vendor/gamma-3|', 'manual_tier']);
  assert.equal(first(tiered, { view: view('coding', 'large') }).key, 'or|vendor/alpha-1|high', 'other tiers still go by score');
  // Titles: the cheapest priced model, no matter the score.
  assert.equal(plan(healthy(tiered), { kind: 'small' }, { preference: 'best', cheaperFallback: false }).list[0].key, 'or|vendor/delta-4|');
});

test('cooldowns and limits shape the candidates before scoring; the launch tells OpenCode a context the router can serve', () => {
  const inventory = buildInventory(settings([openRouter({ excluded: ['vendor/delta-4'] })]), routingCatalog());
  const cooled = healthy(inventory).filter(entry => entry.model !== 'vendor/alpha-1');
  assert.equal(plan(cooled, { kind: 'turn', view: view('coding', 'large'), preferred: null }, { preference: 'best', cheaperFallback: false }).list[0].key, 'or|vendor/beta-2|', 'the best healthy score');
  const limit = limitsFor(inventory);
  assert.equal(limit.context, 300_000, 'the median context of the scored or tiered models (one per model: 400k, 200k)');
  assert.equal(limitsFor(buildInventory(settings([direct([{ id: 'a', context: 64_000, output: 4_096 }, { id: 'b', context: 200_000 }])]), routingCatalog())).context, 64_000, 'a short list of your own: the smallest');
});

test('Jev\'s answers: type only inside its band, "small" needs ≥ 0.9 on the two lowest levels; parsing the real answer shape', () => {
  const answers = (kind, kindTop, probabilities) => {
    const labels = ['code_change', 'debug', 'review', 'research', 'writing', 'operations', 'other', 'unclear'];
    const vector = labels.map(label => label === kind ? kindTop : (1 - kindTop) / (labels.length - 1));
    return { kind: choiceAnswer(labels, vector, kind), difficulty: scoreAnswer(probabilities) };
  };
  const decide = (kind, kindTop, probabilities, bands) => decisionFromTriage(readTriage(answers(kind, kindTop, probabilities), bands), 0.6);
  const sure = decide('review', 0.9, [0.85, 0.1, 0.04, 0.01], { kind: 'auto', difficulty: 'auto' });
  assert.deepEqual([sure.type, sure.difficulty, sure.confidence, sure.strong], ['review', 'simple', 0.95, false]);
  assert.deepEqual([turnView(sure, 'jev', '').level, turnView(sure, 'jev', '').confident], ['small', true]);
  const below = decide('research', 0.5, [0.5, 0.3, 0.15, 0.05], { kind: 'verify', difficulty: 'auto' });
  assert.equal(below.type, null, 'type below its band: the rules name it');
  assert.equal(turnView(below, 'jev', 'Explain how the scheduler works').type, 'research');
  assert.equal(turnView(below, 'jev', 'x').typeFrom, 'rules');
  const hard = decide('debug', 0.95, [0.02, 0.08, 0.2, 0.7], { kind: 'auto', difficulty: 'auto' });
  assert.deepEqual([hard.type, hard.strong, turnView(hard, 'jev', '').level], ['coding', true, 'large']);
  const operations = decide('operations', 0.9, [0.1, 0.5, 0.3, 0.1], { kind: 'auto', difficulty: 'verify' });
  assert.deepEqual([operations.type, operations.difficulty, turnView(operations, 'jev', '').level], ['coding', 'normal', 'medium']);
  // Jev says simple without probabilities: not confident → medium.
  assert.equal(turnView({ difficulty: 'simple', strong: false, type: 'chat' }, 'jev', '').level, 'medium');
});

test('word rules for the task type, English and Russian', () => {
  for (const [text, type] of [
    ['Review this diff for security problems', 'review'], ['Проведи ревью изменений в модуле оплаты', 'review'],
    ['Update the README with the new flags', 'writing'], ['Напиши документацию к API', 'writing'],
    ['Fix the failing test in parser.ts', 'coding'], ['Исправь баг в функции сортировки', 'coding'],
    ['Explain how the scheduler decides priorities', 'research'], ['Объясни, как работает кэш', 'research'],
    ['Hello there', 'chat'], ['Привет, как дела?', 'chat']
  ]) assert.equal(ruleTaskType(text), type, text);
});

// ---------------------------------------------------------------------------------------------------------------
// Through the router: OpenRouter's address is served by a fake upstream (the transport rewrites it), nothing leaves
// ---------------------------------------------------------------------------------------------------------------

async function routerWith(t, { extra = {}, upstreamExtra = {}, decide, behaviours = {} } = {}) {
  const upstream = await startFakeUpstream({ behaviours });
  t.after(() => upstream.close());
  let current = settings([openRouter({ excluded: ['vendor/delta-4'], ...upstreamExtra })], { preference: 'best', ...extra });
  const catalog = routingCatalog({ at: Date.now(), now: Date.now() });
  const jev = { calls: 0 };
  const router = new AutoRouter({
    directory: mkdtempSync(join(base, 'router-')),
    settings: () => current,
    inventory: () => buildInventory(current, catalog),
    dataClassMode: () => 'strict',
    key: async () => 'up-key',
    decide: decide ?? (async () => { jev.calls++; return { difficulty: 'hard', strong: false, type: 'coding', confidence: 0.05 }; }),
    transport: (url, init) => fetch(String(url).replace('https://openrouter.ai/api/v1', upstream.url), init),
    timeouts: { jevMs: 300, headersMs: 500, firstChunkMs: 500, idleMs: 500 }
  });
  t.after(() => router.stop());
  const { token, port } = await router.grant({ sessionId: 'card-sel-0001', provider: 'opencode', role: 'agent', parentSessionId: null, dataClass: 'D1' });
  const ask = (text, body = {}) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', stream: true, max_tokens: 1000, messages: [{ role: 'user', content: text }], ...body }) });
  return { upstream, router, ask, jev, set: next => { current = next; } };
}

test('router: the best coding score with its effort sent to OpenRouter; the decision says type, difficulty, score, price and why — no text', async t => {
  const { upstream, router, ask } = await routerWith(t);
  const answer = await ask('Redesign the storage layer MARKER-SELECT-91');
  assert.equal(answer.status, 200);
  await answer.text();
  const sent = upstream.posts().at(-1).json;
  assert.equal(sent.model, 'vendor/alpha-1');
  assert.deepEqual(sent.reasoning, { effort: 'high' }, 'the variant it was scored at');
  const record = router.recent()[0];
  assert.deepEqual([record.taskType, record.difficulty, record.model, record.effort, record.score, record.why, record.priceIn, record.priceOut],
    ['coding', 'large', 'vendor/alpha-1', 'high', 57.5, 'best_score', 1, 4]);
  assert.match(record.scoreSource, /^Artificial Analysis v4\.3\.2/u);
  assert.ok(!JSON.stringify(router.recent()).includes('MARKER-SELECT-91'));
  // The CLI's own effort is never overridden.
  await (await ask('Another redesign', { reasoning: { effort: 'low' } })).text();
  assert.deepEqual(upstream.posts().at(-1).json.reasoning, { effort: 'low' });
});

test('router: a failing best model cools down (all its variants) and the next best answers; a cap skips an expensive model for one that fits', async t => {
  const { upstream, router, ask } = await routerWith(t, { behaviours: { 'vendor/alpha-1': 429 } });
  await (await ask('Refactor the parser')).text();
  assert.deepEqual(upstream.posts().map(post => post.model), ['vendor/alpha-1', 'vendor/beta-2']);
  assert.equal(router.recent()[0].model, 'vendor/beta-2');
  await (await ask('Refactor the lexer')).text();
  assert.deepEqual(upstream.posts().slice(2).map(post => post.model), ['vendor/beta-2'], 'cooling down: straight to the next');
  // Caps: alpha's estimate ($0.004 + input) does not fit $0.0035; beta's ($0.002 + input) does.
  const capped = await routerWith(t, { extra: { perCardUsdCap: 0.0035 } });
  await (await capped.ask('Refactor the parser')).text();
  assert.deepEqual(capped.upstream.posts().map(post => post.model), ['vendor/beta-2']);
});

test('router: Jev unavailable → word rules decide type and difficulty, the call still goes by score', async t => {
  const { upstream, router, ask } = await routerWith(t, { decide: async () => null, extra: { preference: 'cheap' } });
  await (await ask('Fix a typo in the readme')).text();
  const record = router.recent()[0];
  assert.deepEqual([record.source, record.taskType, record.difficulty, record.confidence], ['rules', 'writing', 'small', null]);
  assert.equal(record.why, 'best_score', 'rules are never confident: no score is given up');
  assert.equal(upstream.posts().at(-1).model, 'vendor/beta-2', 'the best writing score (LiveBench)');
  assert.equal(upstream.posts().at(-1).json.reasoning, undefined, 'its default variant: no effort sent');
  const log = readFileSync(join(router['deps'].directory, 'decisions.jsonl'), 'utf8');
  assert.ok(!log.includes('typo'), 'no text in the log');
});
