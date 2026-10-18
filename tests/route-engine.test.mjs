// Route v2, pure units: limit windows and the subscription cost model (reserve, pace, stale and unknown), aliases,
// scoring within one cohort and the quality window, "prefer subscriptions", trust per mode, gates, the parallel cap,
// tunnels and their demotion, the new-model policy (unscored, pins, boosts, provisional scores, exploration), and
// launch options that always name every model-setting plugin (CanvasTTY 1.8.2's inheritance rules). No I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BenchmarkIndex } from '../src/auto/catalog/scoring.ts';
import { resolveModel, ALIAS_TABLE_AS_OF } from '../src/route/aliases.ts';
import { anchorFit, decide, estimateText, launchOptionsFor, MIN_ANCHORS, PROVISIONAL_PENALTY, whyLine } from '../src/route/engine.ts';
import { parseLimits, quotaOf, shadowPrice, STALE_MS } from '../src/route/limits.ts';
import { classifyOutcome, RouteRecords, EXPLORE_JUDGE_AT } from '../src/route/records.ts';
import { DEFAULT_ROUTE_SETTINGS, normalizeRouteSettings, validateRouteSettings } from '../src/route/settings.ts';
import { accountRowsFrom, providersFrom } from '../src/route/service.ts';
import { accountRows, catalog, declared, index, limitsAnswer, NOW, providers, view } from './helpers/route-fixtures.mjs';

const CAT = catalog();
const INDEX = index(CAT);
const P = providersFrom(providers());

function ctx(extra = {}) {
  return {
    view: view('coding', 'medium'), preference: 'balanced', settings: declared(), providers: P.list, providersGiven: P.given, accountRows: accountRowsFrom(accountRows()),
    callerProvider: 'claude', cardClass: 'D1', mode: 'warn', limits: parseLimits(limitsAnswer(), NOW), catalog: CAT, index: INDEX,
    auto: { model: 'z-ai/glm-5.3', identity: 'glm-5-3', effort: 'max', priceIn: 0.6, priceOut: 2.2, trusted: true },
    now: NOW, busy: () => 0, launches: () => 0, cooldown: () => null, stats: new Map(), prefer: null, orchestrate: false,
    explore: { roll: 0.99, retired: new Set(), highRisk: false }, ...extra
  };
}
const keys = decision => [decision.top, ...decision.alternatives].map(c => c?.key);

// ---------------------------------------------------------------------------------------------------------------
// Windows and cost
// ---------------------------------------------------------------------------------------------------------------

test('limits: only window fields are kept; an account scope never is; stale after 30 min is unknown, never exhausted', () => {
  const answer = limitsAnswer();
  answer.snapshot.providers[0].accountScope = 'epoch-SECRET';
  const parsed = parseLimits(answer, NOW);
  assert.ok(!JSON.stringify(parsed).includes('SECRET'));
  assert.deepEqual(parsed.providers.map(p => [p.provider, p.state]), [['claude', 'available'], ['codex', 'available'], ['qwen', 'unavailable'], ['grok', 'unavailable']]);
  assert.equal(parseLimits('junk', NOW), null);
  const claude = parsed.providers[0];
  const fresh = quotaOf(claude, 20, NOW);
  assert.deepEqual([fresh.state, fresh.headroom, fresh.window.label], ['known', 39, '5 h'], 'tightest window: 100 − 41 − 20');
  // The same read, 31 minutes later.
  const stale = quotaOf(claude, 20, NOW + STALE_MS - 3 * 60_000 + 60_001);
  assert.equal(stale.state, 'unknown');
  assert.match(stale.note, /more than 30 min/u);
  assert.equal(quotaOf(undefined, 20, NOW).state, 'unknown');
  assert.match(quotaOf(parsed.providers[2], 20, NOW).note, /unsupported-protocol/u, 'Qwen: not readable by design');
  // At the reserve: exhausted (only a fresh read can say that).
  const full = parseLimits(limitsAnswer({ claude: 85 }), NOW).providers[0];
  assert.equal(quotaOf(full, 20, NOW).state, 'exhausted');
  assert.equal(quotaOf(full, 10, NOW).state, 'known', 'a smaller reserve leaves headroom');
  // A window whose reset time passed since the read: probably reset, ranked mid-pack, not used up.
  const passed = parseLimits(limitsAnswer({ claude: 95 }), NOW).providers[0];
  passed.windows[0].resetsAt = NOW + 60_000;
  const later = quotaOf(passed, 20, NOW + 2 * 60_000);
  assert.equal(later.state, 'presumed-reset', 'ranked mid-pack, not used up');
  assert.equal(later.window.label, 'weekly', 'the window that still holds');
  passed.windows[1].resetsAt = NOW + 60_000;
  assert.equal(quotaOf(passed, 20, NOW + 2 * 60_000).state, 'presumed-reset');
  assert.equal(quotaOf(passed, 20, NOW + 40 * 60_000).state, 'unknown', 'and stale after 30 min like any read');
});

test('cost model: free with headroom and an even pace; priced as it burns; unavailable at 0; unknown windows cost 0', () => {
  const codex = parseLimits(limitsAnswer({ codex: 72, codexElapsed: 0.5 }), NOW).providers[1];
  const q = quotaOf(codex, 20, NOW);
  assert.equal(q.pace, 1.44, '72% used half way through the window');
  assert.deepEqual(shadowPrice(q, 8, 0.2), { usd: 0.088, basis: 'burning' }, 'priced at the API cost × (pace − 1)');
  const calm = quotaOf(parseLimits(limitsAnswer({ codex: 30, codexElapsed: 0.5 }), NOW).providers[1], 20, NOW);
  assert.deepEqual(shadowPrice(calm, 8, 0.2), { usd: 0, basis: 'free' });
  const low = quotaOf(parseLimits(limitsAnswer({ codex: 75, codexElapsed: 0.9 }), NOW).providers[1], 20, NOW);
  assert.deepEqual([low.headroom, shadowPrice(low, 8, 0.2).basis], [5, 'low'], 'headroom below the task\'s expected share');
  assert.equal(shadowPrice(quotaOf(parseLimits(limitsAnswer({ codex: 90 }), NOW).providers[1], 20, NOW), 8, 0.2).basis, 'unavailable');
  assert.deepEqual(shadowPrice(quotaOf(undefined, 20, NOW), 8, 0.2), { usd: 0, basis: 'unknown' });
});

test('in a decision: an exhausted subscription is dropped with the reason; a stale one stays as unknown and is never "exhausted"', () => {
  const research = view('research', 'medium');
  const used = decide(ctx({ view: research, limits: parseLimits(limitsAnswer({ claude: 85 }), NOW) }));
  assert.ok(!keys(used).some(key => key?.startsWith('claude|plan:claude-max')));
  assert.ok(used.dropped.some(d => d.key.startsWith('claude|plan:claude-max') && /no headroom above the reserve/u.test(d.reason)));
  const stale = decide(ctx({ view: research, limits: parseLimits(limitsAnswer({ claude: 85, fetchedAt: NOW - STALE_MS - 1 }), NOW) }));
  const claude = stale.groups.flat().find(c => c.key.startsWith('claude|plan:claude-max|opus'));
  assert.equal(claude.availability.state, 'unknown');
  assert.equal(claude.costBasis, 'unknown');
  assert.match(whyLine(claude, stale, NOW), /quota unknown \(read more than 30 min ago\)/u);
});

// ---------------------------------------------------------------------------------------------------------------
// Aliases and scores
// ---------------------------------------------------------------------------------------------------------------

test('aliases: a full id is its own identity; a short alias only through the dated table or the person\'s; unknown stays unscored', () => {
  const known = id => INDEX.rows(id).length > 0;
  assert.deepEqual(resolveModel('codex', 'gpt-5.5', [], known), { identity: 'gpt-5-5', from: 'id' });
  assert.deepEqual(resolveModel('claude', 'opus', [], known), { identity: 'claude-opus-4-8', from: 'bundled' });
  assert.deepEqual(resolveModel('claude', 'opus', [{ cli: 'claude', alias: 'opus', identity: 'claude-opus-5' }], known), { identity: 'claude-opus-5', from: 'person' });
  assert.deepEqual(resolveModel('opencode', 'zai-coding-plan/glm-5.3', [], known), { identity: 'glm-5-3', from: 'id' });
  assert.deepEqual(resolveModel('kimi', 'my-alias', [], known), { identity: null, from: 'none' });
  assert.match(ALIAS_TABLE_AS_OF, /^\d{4}-\d{2}-\d{2}$/u);
  // In a decision, an unknown alias is never guessed: it is left out with the reason.
  const settings = declared({ plans: [{ id: 'kimi', cli: 'kimi', kind: 'subscription', label: 'Kimi', models: ['my-alias'], reserve: 20, maxParallel: 2, allow: 'allow', trust: 'D2' }] });
  const decision = decide(ctx({ settings }));
  assert.ok(decision.dropped.some(d => d.key === 'kimi|plan:kimi|my-alias|' && /no measured score/u.test(d.reason)));
});

test('scores: one cohort per decision; the quality window per preference and level; unknown never beats known', () => {
  const decision = decide(ctx({ view: view('coding', 'medium') }));
  assert.ok(decision.cohort, 'a cohort was chosen');
  for (const c of decision.groups.flat()) if (c.score) assert.ok(!c.score.label.includes('LiveBench') || decision.cohort.startsWith('livebench'), 'scores from one source only');
  assert.equal(decision.window, 5);
  assert.equal(decide(ctx({ view: view('coding', 'large') })).window, 3);
  assert.equal(decide(ctx({ preference: 'best' })).window, 0);
  assert.equal(decide(ctx({ view: view('coding', 'small'), preference: 'cheap' })).window, 15);
  // Scored groups first; the CLIs' own defaults (no score) only after every scored option.
  const flat = decision.groups.map(group => group[0]);
  const firstUnscored = flat.findIndex(c => !c.score);
  assert.ok(firstUnscored > 0 && flat.slice(firstUnscored).every(c => !c.score));
  assert.match(estimateText(decision.top.estimate), /launch|%|\$/u);
});

test('prefer subscriptions: a subscription with headroom wins within the window over a cheaper API route; off, price decides', () => {
  // Research: Opus on the Max plan (free, 3 points below the best) against Auto's GLM (API, best) and the GLM plan.
  const settings = declared({ plans: declared().plans.filter(plan => plan.id !== 'glm-plan') });
  const on = decide(ctx({ view: view('research', 'medium'), settings, accountRows: [] }));
  assert.equal(on.top.key, 'claude|plan:claude-max|opus|max');
  assert.match(whyLine(on.top, on, NOW), /subscription: free \(5 h 41% used, headroom 39% above the reserve, read 3 min ago\)/u);
  assert.match(estimateText(on.top.estimate), /≈ 8% of the 5 h/u);
  // Burning fast (Max at 70% after a fifth of the window): with the preference on it still wins inside the window…
  const burning = parseLimits(limitsAnswer({ claude: 70 }), NOW);
  burning.providers[0].windows[0].resetsAt = NOW + 240 * 60_000;
  assert.equal(decide(ctx({ view: view('research', 'medium'), settings, accountRows: [], limits: burning })).top.key, 'claude|plan:claude-max|opus|max');
  // …and off, the cheaper API route takes it.
  const off = decide(ctx({ view: view('research', 'medium'), settings: { ...settings, preferSubscriptions: false }, accountRows: [], limits: burning }));
  assert.equal(off.top.kind, 'auto');
});

// ---------------------------------------------------------------------------------------------------------------
// The person's rules, gates, capacity
// ---------------------------------------------------------------------------------------------------------------

test('trust per mode: Strict drops what is trusted below the card\'s class, Warn keeps it with a notice, Off ignores it; D3 stays local', () => {
  const strict = decide(ctx({ mode: 'strict', cardClass: 'D2' }));
  assert.ok(strict.dropped.some(d => d.key.startsWith('opencode|plan:glm-plan') && /trust D1 is below this card's D2 \(Strict\)/u.test(d.reason)));
  assert.ok(strict.dropped.some(d => d.key.startsWith('claude|account:zai-glm') && /trust unset/u.test(d.reason)), 'a model account has no trust until the person sets it');
  const warn = decide(ctx({ mode: 'warn', cardClass: 'D2' }));
  const plan = warn.groups.flat().find(c => c.key.startsWith('opencode|plan:glm-plan'));
  assert.equal(plan.trust.warn, true);
  assert.match(whyLine(plan, warn, NOW), /trust D1 is below this card's class \(Warn\)/u);
  const off = decide(ctx({ mode: 'off', cardClass: 'D3' }));
  assert.ok(off.groups.flat().some(c => c.key.startsWith('claude|plan:')));
  const secret = decide(ctx({ mode: 'warn', cardClass: 'D3', auto: { ...ctx().auto, trusted: false } }));
  assert.equal(secret.top, null, 'D3 never leaves this computer, and no local route is ready');
  // The person's trust for an account address applies (and a local Ollama address is trusted with D3 by default).
  const trusted = decide(ctx({ mode: 'strict', cardClass: 'D2', settings: declared({ trust: { 'host:api.z.ai': 'D2' } }) }));
  assert.ok(trusted.groups.flat().some(c => c.key.startsWith('claude|account:zai-glm')));
});

test('allow and Never, explicit prefer, and gates (not installed, signed out, cannot orchestrate, inheritance across CLIs)', () => {
  const never = decide(ctx({ settings: declared({ allow: { 'host:api.z.ai': 'never', auto: 'never' } }) }));
  assert.ok(!never.groups.flat().some(c => c.endpoint === 'api.z.ai' || c.kind === 'auto'));
  assert.ok(never.dropped.some(d => /Never/u.test(d.reason)));
  const prefer = decide(ctx({ prefer: 'codex' }));
  assert.equal(prefer.top.cli, 'codex');
  assert.equal(prefer.preferred, true);
  assert.equal(decide(ctx({ prefer: 'opus' })).top.model, 'opus');
  const signedOut = providersFrom(providers({ signIn: { claude: 'signed_out' } }));
  const out = decide(ctx({ providers: signedOut.list }));
  assert.ok(!out.groups.flat().some(c => c.cli === 'claude' && c.kind !== 'account'), 'the sign-in of a subscription; a model account does not use it');
  assert.ok(out.dropped.some(d => /signed out/u.test(d.reason)));
  const notInstalled = providersFrom(providers({ installed: ['opencode'] }));
  assert.ok(decide(ctx({ providers: notInstalled.list })).dropped.some(d => d.cli === 'claude' && /not installed/u.test(d.reason)));
  const orchestrate = decide(ctx({ orchestrate: true }));
  assert.ok(orchestrate.groups.flat().every(c => ['codex', 'claude', 'qwen', 'kimi', 'opencode', 'hermes'].includes(c.cli)));
  // Hermes is outside the Accounts plugin: from a Claude orchestrator (whose model may come from an account) it is left out.
  const hermes = decide(ctx({ settings: declared({ plans: [] }), accountRows: [], auto: null }));
  assert.ok(hermes.dropped.some(d => d.cli === 'hermes' && /canvastty-accounts cannot be named for it/u.test(d.reason)));
  assert.ok(hermes.groups.flat().some(c => c.cli === 'grok'), 'Grok takes Accounts options, so it can be named explicitly');
});

test('parallel cap and cooldowns: a subscription with 2 routed children running is busy; a usage-limit exit rests it', () => {
  const research = view('research', 'medium');
  const settings = declared({ plans: declared().plans.filter(plan => plan.id !== 'glm-plan') });
  assert.equal(decide(ctx({ view: research, settings, accountRows: [] })).top.key, 'claude|plan:claude-max|opus|max');
  const busy = decide(ctx({ view: research, settings, accountRows: [], busy: key => key === 'plan:claude-max' ? 2 : 0 }));
  assert.notEqual(busy.top.cli, 'claude');
  assert.ok(busy.dropped.some(d => /2 routed children already run on it \(at most 2\)/u.test(d.reason)));
  const one = decide(ctx({ view: research, settings, accountRows: [], busy: key => key === 'plan:claude-max' ? 1 : 0 }));
  assert.equal(one.top.cli, 'claude', 'one running: still room');
  const cooling = decide(ctx({ view: research, settings, accountRows: [], cooldown: key => key === 'plan:claude-max' ? { until: NOW + 60_000, reason: 'it hit a usage limit' } : null }));
  assert.notEqual(cooling.top.cli, 'claude');
  // A coding plan without a read API: counted launches against the person's allowance.
  const plan = decide(ctx({ view: view('coding', 'small'), launches: () => 100 }));
  assert.ok(plan.dropped.some(d => d.key.startsWith('opencode|plan:glm-plan') && /100 of 100 launches used/u.test(d.reason)));
});

test('tunnels: routes to one model are grouped; the route is chosen by availability, trust, cost; a clearly worse route is demoted', () => {
  const decision = decide(ctx({ view: view('coding', 'small') }));
  const glm = decision.groups.find(group => group[0].identity === 'glm-5-3' && group.length > 1);
  assert.ok(glm, 'GLM-5.3 reached through the coding plan, Auto and the Z.AI account is one model');
  assert.deepEqual(new Set(glm.map(c => c.kind)), new Set(['coding-plan', 'auto', 'account']));
  assert.equal(glm[0].kind, 'coding-plan', 'free within the plan, trusted, ready');
  // 12 runs on the plan route, 6 failed; 12 on the others, 1 failed: the plan route goes last, with the reason.
  const stats = new Map([[glm[0].key, { n: 12, fail: 6 }], ...glm.slice(1).map(c => [c.key, { n: 6, fail: 0 }]), [glm[1].key, { n: 12, fail: 1 }]]);
  const demoted = decide(ctx({ view: view('coding', 'small'), stats })).groups.find(group => group.some(c => c.key === glm[0].key));
  assert.notEqual(demoted[0].key, glm[0].key);
  assert.match(demoted.at(-1).demoted, /50% of 12 runs failed on this route/u);
  // Fewer than 10 outcomes: nothing is demoted.
  const few = decide(ctx({ view: view('coding', 'small'), stats: new Map([[glm[0].key, { n: 9, fail: 9 }], [glm[1].key, { n: 20, fail: 0 }]]) })).groups.find(group => group.some(c => c.key === glm[0].key));
  assert.equal(few[0].key, glm[0].key);
  // "Not equivalent": the person splits a route off into its own model.
  const split = decide(ctx({ view: view('coding', 'small'), settings: declared({ notEquivalent: [glm[1].key] }) }));
  assert.ok(split.groups.some(group => group.length === 1 && group[0].key === glm[1].key));
});

// ---------------------------------------------------------------------------------------------------------------
// New models
// ---------------------------------------------------------------------------------------------------------------

/**
 * A catalog where 10 anchor models are measured in both sources (LiveBench = Artificial Analysis + 10), two models
 * only in LiveBench (so LiveBench is the decision's cohort), and "fresh-1" only in Artificial Analysis.
 */
function provisionalCatalog() {
  const at = NOW - 3_600_000;
  const lb = { kind: 'livebench', url: 'https://x', releaseDate: '2026-10-01', fetchedAt: at };
  const aa = { kind: 'artificial-analysis', url: 'https://y', releaseDate: null, fetchedAt: at, indexVersion: '4.3.2' };
  const lbRow = (id, v) => ({ id: `lb-${id}`, modelId: id, reasoningEffort: 'high', thinking: null, categories: { 'Agentic Coding': v, Coding: v, Reasoning: v }, overall: v, source: lb, historical: false });
  const aaRow = (id, v) => ({ id: `aa-${id}`, modelId: id, reasoningEffort: 'high', thinking: null, categories: { 'Terminal-Bench 4.0': v, SciCode: v, 'Intelligence Index': v }, overall: v, source: aa, historical: false });
  const rows = [];
  for (let i = 0; i < 10; i++) { const v = 30 + i * 4; rows.push(lbRow(`anchor-${i}`, v + 10), aaRow(`anchor-${i}`, v)); }
  rows.push(lbRow('lb-only-1', 20), lbRow('lb-only-2', 22), aaRow('fresh-1', 70));
  const prices = Object.fromEntries([...Array(10).keys()].map(i => [`v/anchor-${i}`, [1 + i, 4 + i]]));
  const cat = catalog({ prices: { ...prices, 'v/fresh-1': [0.2, 0.8], 'v/lb-only-1': [0.1, 0.1], 'v/lb-only-2': [0.1, 0.1] } });
  cat.benchmarks = rows;
  return cat;
}
const anchorSettings = (extra = {}) => declared({
  plans: [{ id: 'codex-pro', cli: 'codex', kind: 'subscription', label: 'Pro', models: [...[...Array(10).keys()].map(i => `anchor-${i}`).slice(4, 10), 'lb-only-1', 'lb-only-2', 'fresh-1'], reserve: 20, maxParallel: 2, allow: 'allow', trust: 'D2' }],
  ...extra
});
/** Codex at 60% after 30% of its window (pace 2): priced like its API, so prices still tell models apart. */
const busyCodex = parseLimits(limitsAnswer({ codex: 60, codexElapsed: 0.3 }), NOW);

test('new models: unscored is not used; a pin or a boost lets it in; provisional maps through ≥ 8 anchors with a penalty', () => {
  const cat = provisionalCatalog();
  const idx = new BenchmarkIndex(cat);
  const cohorts = [...idx.exact('anchor-0', 'high').keys()];
  const fit = anchorFit(idx, 'coding', cohorts.find(k => k.startsWith('artificial')), cohorts.find(k => k.startsWith('livebench')));
  assert.equal(fit.anchors, 10);
  assert.ok(fit.anchors >= MIN_ANCHORS && fit.r2 > 0.99);
  const base = { catalog: cat, index: idx, accountRows: [], auto: null, view: view('coding', 'medium'), callerProvider: 'codex', limits: busyCodex };
  const wait = decide(ctx({ ...base, settings: anchorSettings() }));
  assert.ok(!wait.groups.flat().some(c => c.identity === 'fresh-1'), 'wait for a score (default)');
  assert.ok(wait.dropped.some(d => d.model === 'fresh-1' && /no measured score/u.test(d.reason)));
  const pinned = decide(ctx({ ...base, settings: anchorSettings({ pins: { 'fresh-1': 'medium' } }) }));
  assert.equal(pinned.top.identity, 'fresh-1', 'the person\'s pin answers its level first');
  assert.match(whyLine(pinned.top, pinned, NOW), /your pin: medium/u);
  const provisional = decide(ctx({ ...base, settings: anchorSettings({ newModels: 'provisional' }) }));
  const fresh = provisional.groups.flat().find(c => c.identity === 'fresh-1');
  assert.equal(fresh.score.source, 'provisional');
  assert.equal(fresh.score.value, Math.round((fit.a * 70 + fit.b) * 100) / 100 - PROVISIONAL_PENALTY);
  assert.match(whyLine(fresh, provisional, NOW), /provisional: mapped from Artificial Analysis v4\.3\.2 through 10 anchor models \(R² 1\), −5/u);
  // Mapped to 80 − 5 = 75 against a best of 76: within the window, and cheaper, so it may win a medium task…
  assert.equal(provisional.top.identity, 'fresh-1');
  // …but never displaces a measured model of the same price band on a large task.
  const cheapAnchor = anchorSettings({ newModels: 'provisional' });
  const largeCat = provisionalCatalog();
  largeCat.openRouter.models.find(m => m.id === 'v/anchor-9').priceIn = 0.3;
  largeCat.openRouter.models.find(m => m.id === 'v/anchor-9').priceOut = 1.0;
  const large = decide(ctx({ ...base, catalog: largeCat, index: new BenchmarkIndex(largeCat), view: view('coding', 'large'), settings: cheapAnchor }));
  assert.equal(large.top.identity, 'anchor-9');
  // A boost moves a scored model; on an unscored one it lets it in after the scored options.
  const boosted = decide(ctx({ ...base, settings: anchorSettings({ boosts: { 'fresh-1': 3 } }) }));
  assert.ok(boosted.groups.flat().some(c => c.identity === 'fresh-1'));
});

test('exploration (default off): a share of small, low-risk tasks tries the best new model; never large, risky or orchestrating; judged after 20', () => {
  const cat = provisionalCatalog();
  const idx = new BenchmarkIndex(cat);
  const base = { catalog: cat, index: idx, accountRows: [], auto: null, view: view('coding', 'small'), callerProvider: 'codex', limits: busyCodex };
  const settings = anchorSettings({ newModels: 'explore', exploreShare: 0.05 });
  // Make the new model lose on data, so only exploration picks it.
  cat.openRouter.models.find(m => m.id === 'v/fresh-1').priceIn = 50;
  assert.notEqual(decide(ctx({ ...base, settings, explore: { roll: 0.5, retired: new Set(), highRisk: false } })).top.identity, 'fresh-1', 'roll above the share');
  const explored = decide(ctx({ ...base, settings, explore: { roll: 0.01, retired: new Set(), highRisk: false } }));
  assert.equal(explored.explored, true);
  assert.equal(explored.top.identity, 'fresh-1');
  assert.equal(decide(ctx({ ...base, settings: anchorSettings({ newModels: 'provisional' }), explore: { roll: 0.01, retired: new Set(), highRisk: false } })).explored, false, 'off unless the person chose explore');
  for (const extra of [{ view: view('coding', 'large') }, { explore: { roll: 0.01, retired: new Set(), highRisk: true } }, { orchestrate: true }, { explore: { roll: 0.01, retired: new Set(['fresh-1']), highRisk: false } }]) {
    assert.equal(decide(ctx({ ...base, settings, explore: { roll: 0.01, retired: new Set(), highRisk: false }, ...extra })).explored, false, JSON.stringify(Object.keys(extra)));
  }
  // Outcomes: 20 explored runs at 18/20 against the incumbents' 90%: "use it"; at 10/20: retired.
  const records = (okExplored) => {
    const r = new RouteRecords([], () => undefined);
    const option = (identity) => ({ key: identity, cli: 'codex', kind: 'subscription', signIn: 'plan:x', label: 'x', model: identity, identity, effort: null, score: null, scoreSource: null, cost: 0, costBasis: 'free', estimate: '', why: '' });
    for (let i = 0; i < EXPLORE_JUDGE_AT; i++) r.add({ id: `e${i}`, at: i, card: 'orch', type: 'coding', level: 'small', typeFrom: 'jev', confidence: 0.9, strategy: 'single-cheap', cohort: null, candidates: 1, dropped: 0, explored: true, preferred: false, options: [option('fresh-1')], outcome: { result: i < okExplored ? 'done' : 'failed', ok: i < okExplored, by: 'orchestrator', at: i } });
    for (let i = 0; i < 20; i++) r.add({ id: `b${i}`, at: i, card: 'orch', type: 'coding', level: 'small', typeFrom: 'jev', confidence: 0.9, strategy: 'single-cheap', cohort: null, candidates: 1, dropped: 0, explored: false, preferred: false, options: [option('anchor-9')], outcome: { result: i < 18 ? 'done' : 'failed', ok: i < 18, by: 'orchestrator', at: i } });
    return r.exploration().find(entry => entry.identity === 'fresh-1');
  };
  assert.equal(records(18).verdict, 'use');
  assert.equal(records(10).verdict, 'retire');
  assert.equal(records(16).verdict, 'pending', 'neither clearly as good nor clearly worse');
});

// ---------------------------------------------------------------------------------------------------------------
// Launch options (CanvasTTY 1.8.2: every model-setting plugin named)
// ---------------------------------------------------------------------------------------------------------------

test('launch options always name every model-setting plugin the CLI takes; a model never sits next to an account or Auto', () => {
  for (const level of ['small', 'medium', 'large']) for (const type of ['coding', 'research', 'chat']) {
    const decision = decide(ctx({ view: view(type, level) }));
    for (const c of decision.groups.flat()) {
      const plugins = new Set(P.list.find(p => p.id === c.cli).launchPlugins);
      for (const id of ['canvastty-assistant', 'canvastty-accounts']) if (plugins.has(id)) assert.ok(c.spawn.launchOptions[id], `${c.key}: names ${id}`);
      if (c.kind === 'account') { assert.equal(c.spawn.model, undefined); assert.equal(c.spawn.launchOptions['canvastty-accounts'].account, c.accountId); assert.equal(c.spawn.launchOptions['canvastty-assistant'].model, 'off'); }
      else if (c.kind === 'auto') { assert.deepEqual(c.spawn, { provider: 'opencode', launchOptions: { 'canvastty-accounts': { account: 'none' }, 'canvastty-assistant': { model: 'auto' } } }); }
      else { assert.equal(c.spawn.launchOptions['canvastty-assistant'].model, 'off'); if (plugins.has('canvastty-accounts')) assert.equal(c.spawn.launchOptions['canvastty-accounts'].account, 'none'); }
      if (c.spawn.effort) assert.ok(P.list.find(p => p.id === c.cli).efforts.includes(c.spawn.effort), `${c.key}: an effort its CLI takes`);
      if (c.cli === 'opencode' && c.spawn.model) assert.match(c.spawn.model, /^[^/]+\/.+$/u);
    }
  }
  assert.deepEqual(launchOptionsFor('hermes', new Set(['canvastty-assistant']), { kind: 'cli-default' }), { 'canvastty-assistant': { model: 'off' } });
  // Without list_providers: the Assistant is named (it is running), Accounts only when its rows name that CLI.
  const bare = decide(ctx({ providers: [], providersGiven: false, accountRows: [], auto: null, settings: declared({ plans: [] }) }));
  assert.deepEqual(bare.top.spawn, { provider: 'claude', launchOptions: { 'canvastty-assistant': { model: 'off' } } });
});

// ---------------------------------------------------------------------------------------------------------------
// Inputs, settings, outcomes
// ---------------------------------------------------------------------------------------------------------------

test('inputs from the orchestrator are rebuilt field by field: account rows keep only Accounts\' own options for their own account', () => {
  const rows = accountRowsFrom([{ provider: 'claude', accountId: 'a', model: 'm', endpoint: 'h.example', state: 'ready', apiKey: 'sk-SECRET', launchOptions: { 'canvastty-accounts': { account: 'b', effort: 'high' }, other: { x: 1 } } },
    { provider: 'claude', accountId: 'c', model: 'm', endpoint: 'h.example', state: 'ready', launchOptions: { 'canvastty-accounts': { account: 'c', effort: 'high', trustFolder: true } } }]);
  assert.ok(!JSON.stringify(rows).includes('SECRET'));
  assert.equal(rows[0].launchOptions, undefined, 'options for another account are dropped');
  assert.deepEqual(rows[1].launchOptions, { 'canvastty-accounts': { account: 'c', effort: 'high', trustFolder: false } }, 'trustFolder is never passed on as true');
  assert.deepEqual(providersFrom({ providers: [{ id: 'claude', launchOptions: [{ pluginId: 'canvastty-assistant' }, 'x'] }] }).list[0].launchPlugins, ['canvastty-assistant']);
  assert.equal(providersFrom(null).given, false);
});

test('settings: validated as a whole; defaults on anything invalid; bounded; outcomes classified, the text not kept', () => {
  assert.deepEqual(normalizeRouteSettings(null), DEFAULT_ROUTE_SETTINGS);
  assert.deepEqual(normalizeRouteSettings({ version: 2 }), DEFAULT_ROUTE_SETTINGS);
  assert.equal(DEFAULT_ROUTE_SETTINGS.newModels, 'wait');
  assert.equal(DEFAULT_ROUTE_SETTINGS.preferSubscriptions, true);
  assert.throws(() => validateRouteSettings({ ...DEFAULT_ROUTE_SETTINGS, plans: [{ id: 'x', cli: 'evil', kind: 'subscription', label: 'x', models: [], reserve: 20, maxParallel: 2, allow: 'allow', trust: 'unset' }] }), /CLI/u);
  assert.throws(() => validateRouteSettings({ ...DEFAULT_ROUTE_SETTINGS, allow: { __proto__: null, 'cli:claude': 'maybe' } }), /allow/u);
  assert.throws(() => validateRouteSettings({ ...DEFAULT_ROUTE_SETTINGS, boosts: { 'a': 50 } }), /boosts/u);
  assert.throws(() => validateRouteSettings({ ...DEFAULT_ROUTE_SETTINGS, extra: 1 }), /field/u);
  assert.equal(classifyOutcome('done', ['You have hit your usage limit. Try again at 5pm.']), 'limit');
  assert.equal(classifyOutcome('failed', ['TypeError: x']), 'failed');
  assert.equal(classifyOutcome('done', []), 'done');
});

// ---------------------------------------------------------------------------------------------------------------
// Plan cost: quota share and speed, not "free" (owner's policy, runs 8 and 9)
// ---------------------------------------------------------------------------------------------------------------

test('on a plan, cost is the quota a model uses and its time: GLM-5.3-flash beats GLM-5.3 on small tasks; medium out of the window and large stay quality-first', () => {
  const cat = catalog({ prices: { 'z-ai/glm-5.3': [0.6, 2.2], 'z-ai/glm-5.3-flash': [0.1, 0.4] } });
  const idx = new BenchmarkIndex(cat);
  const rows = accountRowsFrom([
    { provider: 'opencode', accountId: 'glm-53', account: 'GLM 5.3 · Z.AI Coding Plan', model: 'glm-5.3', endpoint: 'api.z.ai', state: 'ready', launchOptions: { 'canvastty-accounts': { account: 'glm-53', effort: 'default', trustFolder: false } } },
    { provider: 'opencode', accountId: 'glm-flash', account: 'GLM flash', model: 'glm-5.3-flash', endpoint: 'api.z.ai', state: 'ready', launchOptions: { 'canvastty-accounts': { account: 'glm-flash', effort: 'default', trustFolder: false } } }
  ]);
  const p = providersFrom(providers({ installed: ['opencode'] }));
  const settings = (extra = {}) => declared({ plans: [], flat: ['host:api.z.ai'], trust: { 'host:api.z.ai': 'D2' }, ...extra });
  const run = (type, level, extra = {}, more = {}) => decide(ctx({ catalog: cat, index: idx, providers: p.list, providersGiven: true, accountRows: rows, callerProvider: 'opencode', auto: null, view: view(type, level), settings: settings(extra), ...more }));
  // PONG (chat, small): flash is 3 points below, inside the window of 8, and uses far less of the plan.
  const small = run('chat', 'small');
  assert.equal(small.top.accountId, 'glm-flash');
  const flash = small.top.planCost;
  // 1.2 × the tokens at a sixth of the token price: about a fifth of the quota GLM-5.3 would use.
  assert.equal(flash.quota, Math.round(1.2 * ((0.1 + 0.4 * 3) / (0.6 + 2.2 * 3)) * 1_000) / 1_000);
  assert.match(whyLine(small.top, small, NOW), /flat-rate plan, unpriced: no cost per task within the plan's limits; ~22% of the plan quota glm-5-3 would use · 3\.0 points below the best, allowed 8/u);
  // Speeds known (the person's figures): flash 4× the output speed, so about 3.3× sooner with 1.2× the tokens.
  const timed = run('chat', 'small', { speeds: { 'glm-5-3': 50, 'glm-5-3-flash': 200 } });
  assert.equal(timed.top.planCost.faster, 3.3);
  assert.match(whyLine(timed.top, timed, NOW), /~3\.3× faster/u);
  // Coding, medium: flash is 8.7 points below (window 5) — outside, so GLM-5.3.
  assert.equal(run('coding', 'medium').top.accountId, 'glm-53');
  // Research, large: flash is 3.0 below and inside the window of 3, but large tasks stay quality-first.
  assert.equal(run('research', 'large').top.accountId, 'glm-53');
  assert.equal(run('research', 'small').top.accountId, 'glm-flash', 'the same pair on a small task');
  assert.equal(run('research', 'small', {}, { explore: { roll: 0.99, retired: new Set(), highRisk: true } }).top.accountId, 'glm-53', 'a risky task stays quality-first');
  // The person's quota weight wins over the price ratio; learned tokens replace the 1.2× default.
  assert.equal(run('chat', 'small', { quotaWeights: { 'glm-5-3-flash': 1 } }).top.accountId, 'glm-53', 'flash tokens count like GLM-5.3 tokens: 1.2× the quota');
  assert.equal(run('chat', 'small', {}, { tokenFactor: id => id === 'glm-5-3-flash' ? 6 : null }).top.accountId, 'glm-53', 'flash took 6× the tokens in practice');
});

test('a declared plan counting prompts: every model costs one prompt, so score decides; by tokens the cheaper model wins; learned tokens from outcomes', () => {
  const cat = catalog({ prices: { 'z-ai/glm-5.3': [0.6, 2.2], 'z-ai/glm-5.3-flash': [0.1, 0.4] } });
  const idx = new BenchmarkIndex(cat);
  const plan = (quotaBy) => declared({ plans: [{ ...declared().plans[2], ...(quotaBy ? { quotaBy } : {}) }] });
  const base = { catalog: cat, index: idx, accountRows: [], auto: null, callerProvider: 'opencode', view: view('research', 'small'), providers: providersFrom(providers({ installed: ['opencode'] })).list };
  assert.equal(decide(ctx({ ...base, settings: plan() })).top.model, 'zai-coding-plan/glm-5.3-flash', 'by tokens (the default)');
  assert.equal(decide(ctx({ ...base, settings: plan('prompts') })).top.model, 'zai-coding-plan/glm-5.3', 'by prompts');
  assert.equal(validateRouteSettings({ ...plan('prompts') }).plans[0].quotaBy, 'prompts');
  assert.throws(() => validateRouteSettings({ ...declared(), plans: [{ ...declared().plans[2], quotaBy: 'coins' }] }), /quota kind/u);
  assert.equal(validateRouteSettings({ ...declared(), valueSpeed: undefined }).valueSpeed, 'moderate', 'older saves');
  // Tokens the orchestrator reports with route_outcome: the median of ≥ 5, as a factor of the level's default.
  const records = new RouteRecords([], () => undefined);
  const option = { key: 'k', cli: 'opencode', kind: 'coding-plan', signIn: 'plan:glm-plan', label: 'x', model: 'zai-coding-plan/glm-5.3-flash', identity: 'glm-5-3-flash', effort: null, score: null, scoreSource: null, cost: 0, costBasis: 'plan', estimate: '', why: '' };
  for (let i = 0; i < 5; i++) records.add({ id: `r${i}`, at: i, card: 'o', type: 'research', level: 'small', typeFrom: 'jev', confidence: 0.9, strategy: 'single-cheap', cohort: null, candidates: 1, dropped: 0, explored: false, preferred: false, options: [option], outcome: { result: 'done', ok: true, by: 'orchestrator', at: i, tokens: 130_000 + i } });
  assert.equal(records.tokenFactor('glm-5-3-flash', () => 65_000), 2);
  assert.equal(records.tokenFactor('glm-5-3', () => 65_000), null);
});

test('live run 10: "prefer plans for small tasks" (on by default) sends a confidently small writing task to the flat-rate GLM plan instead of paid Auto; medium, unsure or off: unchanged', async () => {
  const { turnView } = await import('../src/auto/select.ts');
  const cat = catalog({ prices: { ...{ 'z-ai/glm-5.3': [0.6, 2.2], 'z-ai/glm-5.3-flash': [0.1, 0.4], 'google/gemini-3.5-flash': [1.5, 9] } } });
  const idx = new BenchmarkIndex(cat);
  const rows = accountRowsFrom([
    { provider: 'opencode', accountId: 'glm-53', account: 'GLM 5.3 · Z.AI Coding Plan', model: 'glm-5.3', endpoint: 'api.z.ai', state: 'ready', launchOptions: { 'canvastty-accounts': { account: 'glm-53', effort: 'default', trustFolder: false } } },
    { provider: 'opencode', accountId: 'glm-flash', account: 'GLM flash', model: 'glm-5.3-flash', endpoint: 'api.z.ai', state: 'ready', launchOptions: { 'canvastty-accounts': { account: 'glm-flash', effort: 'default', trustFolder: false } } }
  ]);
  const p = providersFrom(providers({ installed: ['opencode'] }));
  // Run 10's T: Jev read "Bloom filter in two sentences" as writing/small; Auto's expected model was gemini-3.5-flash@high (80.1).
  const auto = { model: 'google/gemini-3.5-flash', identity: 'gemini-3-5-flash', effort: 'high', priceIn: 1.5, priceOut: 9, trusted: true };
  const run = (v, extra = {}) => decide(ctx({ catalog: cat, index: idx, providers: p.list, providersGiven: true, accountRows: rows, callerProvider: 'opencode', auto, view: v,
    settings: declared({ plans: [], flat: ['host:api.z.ai'], trust: { 'host:api.z.ai': 'D2' }, ...extra }) }));
  const small = run(view('writing', 'small'));
  assert.equal(small.top.accountId, 'glm-flash', 'the plan, and on it the model that uses less quota');
  assert.equal(small.top.score, null, 'no writing score: judged by its overall score');
  assert.match(whyLine(small.top, small, NOW), /a plan is good enough for a small task: within 30 points of the best \(overall score 41\.8\), so it goes before paid routes \(your setting\)/u);
  assert.equal(small.alternatives.some(c => c.kind === 'auto'), true, 'Auto stays an alternative');
  assert.equal(run(view('writing', 'small'), { preferPlansSmall: false }).top.kind, 'auto', 'off: as in run 10');
  const narrow = run(view('writing', 'small'), { planWindowSmall: 0 });
  assert.deepEqual([narrow.top.accountId, narrow.top.planPreferred], ['glm-53', 0], 'a window of 0 points: only the best overall score among the plans, GLM-5.3 (44.8)');
  assert.equal(run(view('writing', 'medium')).top.kind, 'auto', 'medium tasks unchanged');
  assert.equal(run(turnView({ difficulty: 'simple', strong: false }, 'rules', 'fix a typo in the readme', { role: 'subagent' })).top.kind, 'auto', 'a small task from word rules is not "confidently" small');
  assert.equal(validateRouteSettings({ ...declared(), preferPlansSmall: undefined }).preferPlansSmall, true, 'older saves: on');
  assert.throws(() => validateRouteSettings({ ...declared(), planWindowSmall: 99 }), /plan window/u);
});
