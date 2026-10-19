// Auto (Jev) strategies at request level: when a hard text turn fans out to several models (consensus or, only when
// the person turned it on, best-of-N), how drafts are chosen (diverse vendors, other upstreams, a subscription-like
// upstream's parallel cap, per-route outcomes), the expected-value rule and the caps; then the router against a fake
// upstream: the judge's answer streamed, a failed or late draft dropped, a tool call passing the single choice's
// answer through, a failed judge leaving the best draft, and every draft reserved against the caps. No model, no
// network beyond loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoRouter } from '../src/auto/router.ts';
import { chooseStrategy, eligible, familyOf, judgeBody, parseAnswer, COST_WEIGHT, OUTCOME_MIN } from '../src/auto/consensus.ts';
import { plan, turnView } from '../src/auto/select.ts';
import { DEFAULT_AUTO_SETTINGS, normalizeAutoSettings, validateAutoSettings } from '../src/auto/settings.ts';
import { startFakeUpstream, streamChunks } from './helpers/fake-upstream.mjs';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'canvastty-auto-consensus-')));
process.on('exit', () => rmSync(base, { recursive: true, force: true }));
const MARKER = 'MARKER-CONSENSUS-41b7';

const score = (value) => ({ value, cohort: 'artificial-analysis:4.3.2:1:research', label: 'Artificial Analysis v4.3.2', rowId: 'aa:x', historical: false, effort: null, documentedDefault: false });
function entry(upstream, model, value, priceIn, priceOut, speed = null) {
  return { key: `${upstream.id}|${model}|`, upstream, model, effort: null, sendEffort: false, tier: null, listed: true, fromList: false, excluded: false, priceIn, priceOut, priceSource: 'person',
    context: 400_000, output: 32_000, known: true, measuredEfforts: [], scores: value === null ? {} : { research: score(value), chat: score(value) }, speed };
}
const up = (id, url = 'https://up.example/v1') => ({ id, preset: 'openai-compatible', baseUrl: url, trust: 'D2', key: 'own', models: [], allModels: false, excluded: [], enabled: true });

/** Strong and dear (a), two cheaper vendors (b, c), and b's second model (same vendor). */
function lineup(one, two) {
  return [
    entry(one, 'a/strong', 70, 5, 25),
    entry(two, 'b/swift', 66, 0.5, 2),
    entry(two, 'c/steady', 65, 0.4, 1.6),
    entry(one, 'b/other', 64, 0.3, 1.2)
  ];
}
const hard = (type = 'research', strong = true) => turnView({ difficulty: 'hard', strong, type, confidence: 0.05 }, 'jev', 'x');
const strategy = (extra = {}) => ({ ...DEFAULT_AUTO_SETTINGS.strategy, ...extra });
const estimateOf = entry => (375 * (entry.priceIn ?? 0) + 4_096 * (entry.priceOut ?? 0)) / 1e6;

function decide({ entries, view = hard(), preference = 'balanced', settings = strategy(), role = 'agent', agentic = false, busy = () => 0, cap = () => null, outcome = () => undefined, seconds = () => null }) {
  const chosen = plan(entries, { kind: 'turn', view, preferred: null }, { preference, cheaperFallback: false });
  return chooseStrategy({ plan: chosen, view, role, agentic, settings, preference, estimate: estimateOf, seconds, busy, parallelCap: cap, outcome });
}

// ---------------------------------------------------------------------------------------------------------------
// Selection (pure)
// ---------------------------------------------------------------------------------------------------------------

test('settings: consensus Auto by default, best-of-N off, K 2–3, a cap per turn; older saves get the defaults', () => {
  assert.deepEqual(DEFAULT_AUTO_SETTINGS.strategy, { consensus: 'auto', k: 3, bestOfN: false, turnUsdCap: 1 });
  const saved = { ...structuredClone(DEFAULT_AUTO_SETTINGS) };
  delete saved.strategy;
  assert.deepEqual(validateAutoSettings(saved).strategy, DEFAULT_AUTO_SETTINGS.strategy, 'saved before strategies existed');
  for (const bad of [{ consensus: 'sometimes' }, { k: 4 }, { k: 1 }, { bestOfN: 'yes' }, { turnUsdCap: -1 }, { extra: 1 }]) {
    assert.throws(() => validateAutoSettings({ ...saved, strategy: { ...DEFAULT_AUTO_SETTINGS.strategy, ...bad } }));
  }
  assert.deepEqual(normalizeAutoSettings({ ...saved, strategy: { consensus: 'nope' } }).strategy, DEFAULT_AUTO_SETTINGS.strategy, 'an invalid choice falls back alone');
});

test('eligible turns: hard and design-level or text-typed, never a tool-calling orchestrator or a conversation that already called tools', () => {
  const settings = strategy();
  assert.equal(eligible({ view: hard(), role: 'agent', agentic: false, settings }), null);
  assert.equal(eligible({ view: hard('coding', true), role: 'agent', agentic: false, settings }), null, 'architecture: design-level coding');
  assert.equal(eligible({ view: hard('coding', false), role: 'agent', agentic: false, settings }), 'not_text_type', 'a hard bug fix stays single');
  assert.equal(eligible({ view: turnView({ difficulty: 'normal', strong: false, type: 'research', confidence: 0.2 }, 'jev', 'x'), role: 'agent', agentic: false, settings }), 'not_hard');
  assert.equal(eligible({ view: hard(), role: 'orchestrator', agentic: false, settings }), 'orchestrator');
  assert.equal(eligible({ view: hard(), role: 'agent', agentic: true, settings }), 'agentic_conversation');
  assert.equal(eligible({ view: hard(), role: 'agent', agentic: false, settings: strategy({ consensus: 'off' }) }), 'strategy_off');
  assert.equal(eligible({ view: hard('coding', false), role: 'agent', agentic: false, settings: strategy({ bestOfN: true }) }), null, 'best-of-N, when on, compares coding answers too');
});

test('drafts: the single choice first, then diverse vendors (one model each), other upstreams first, at most K', () => {
  const one = up('one'), two = up('two');
  const d = decide({ entries: lineup(one, two) });
  assert.equal(d.kind, 'consensus');
  assert.deepEqual(d.members.map(e => e.model), ['a/strong', 'b/swift', 'c/steady'], 'b/other is b\'s vendor again');
  assert.deepEqual(d.judges.map(e => e.model), ['a/strong'], 'the judge is strong: within 3 points of the best');
  assert.equal(new Set(d.members.map(familyOf)).size, 3);
  assert.equal(decide({ entries: lineup(one, two), settings: strategy({ k: 2 }) }).members.length, 2);
  assert.equal(familyOf({ model: 'anthropic/claude-x' }), 'anthropic');
  assert.equal(familyOf({ model: 'glm-5.3-flash' }), 'glm');
  // Too few vendors: single.
  assert.equal(decide({ entries: [entry(one, 'a/strong', 70, 5, 25), entry(one, 'a/mini', 66, 0.5, 2)] }).reason, 'no_diverse_models');
  // Too weak to be "slightly weaker" (more than 8 points below): not a draft.
  assert.equal(decide({ entries: [entry(one, 'a/strong', 70, 5, 25), entry(two, 'b/weak', 61, 0.1, 0.4)] }).reason, 'no_diverse_models');
  assert.equal(decide({ entries: [entry(one, 'a/x', null, 1, 1), entry(two, 'b/y', null, 1, 1)] }).reason, 'unscored', 'unknown scores never fan out');
});

test('a subscription-like upstream keeps its parallel cap (2), counting calls already running on it', () => {
  const one = up('one'), flat = up('plan');
  const entries = [entry(flat, 'a/strong', 70, 5, 25), entry(flat, 'b/swift', 66, 0.5, 2), entry(flat, 'c/steady', 65, 0.4, 1.6)];
  const cap = upstream => upstream.id === 'plan' ? 2 : null;
  assert.deepEqual(decide({ entries, cap }).members.map(e => e.model), ['a/strong', 'b/swift'], 'two at once on the plan');
  assert.equal(decide({ entries, cap, busy: upstream => upstream.id === 'plan' ? 1 : 0 }).reason, 'no_diverse_models', 'one already running: no room for a second draft');
  assert.equal(decide({ entries: [...entries, entry(one, 'd/other', 64, 0.2, 1)], cap }).members.length, 3, 'another upstream takes the third');
});

test('expected value: consensus only when it beats the single strong model; Cheap practically never, Best by quality and time', () => {
  const one = up('one'), two = up('two');
  const balanced = decide({ entries: lineup(one, two) });
  assert.equal(balanced.reason, 'consensus_pays');
  assert.equal(balanced.ev.gain, 3, '1.5 points per extra vendor, at most 3');
  assert.ok(balanced.ev.cost > 0 && balanced.ev.total > 0, JSON.stringify(balanced.ev));
  const cheap = decide({ entries: lineup(one, two), preference: 'cheap' });
  assert.equal(cheap.kind, 'single');
  assert.equal(cheap.reason, 'single_better');
  assert.ok(cheap.ev.cost > balanced.ev.cost * COST_WEIGHT.cheap, 'Cheap weighs cost 3× and starts from its own cheaper single choice');
  assert.equal(decide({ entries: lineup(one, two), preference: 'best' }).ev.cost, 0, 'Best: cost does not count');
  // Time: drafts wait for the slowest, then the judge. Known speeds that make it 8× slower tip Best to single.
  const slow = decide({ entries: lineup(one, two), preference: 'best', seconds: e => e.model === 'c/steady' ? 7 * 10 : 10 });
  assert.equal(slow.ev.time, Math.round(0.5 * Math.log2(80 / 10) * 1000) / 1000);
  assert.equal(slow.kind, 'consensus', 'gain 3 − time 1.5 still pays');
  assert.equal(decide({ entries: lineup(one, two), preference: 'best', seconds: e => e.model === 'c/steady' ? 630 : 10 }).kind, 'single', '64× slower does not');
  assert.equal(decide({ entries: lineup(one, two), preference: 'best', seconds: e => e.model === 'c/steady' ? null : 10 }).ev.time, 0, 'an unknown speed is neutral');
  // Always: every eligible hard turn the caps allow, whatever the estimate says.
  assert.equal(decide({ entries: lineup(one, two), preference: 'cheap', settings: strategy({ consensus: 'always' }) }).kind, 'consensus');
  assert.equal(decide({ entries: lineup(one, two), settings: strategy({ consensus: 'off' }) }).kind, 'single');
});

test('best-of-N: off by default; when on, it compares (the judge picks) and needs no expected-value win', () => {
  const one = up('one'), two = up('two');
  assert.equal(decide({ entries: lineup(one, two), view: hard('coding', false) }).kind, 'single');
  const on = decide({ entries: lineup(one, two), view: hard('coding', false), preference: 'cheap', settings: strategy({ bestOfN: true }) });
  assert.equal(on.kind, 'best-of-n');
  assert.equal(on.reason, 'best_of_n_on');
  assert.equal(decide({ entries: lineup(one, two), settings: strategy({ bestOfN: true }) }).kind, 'consensus', 'research turns still merge');
  assert.equal(decide({ entries: lineup(one, two), settings: strategy({ bestOfN: true, consensus: 'off' }) }).kind, 'best-of-n');
});

test('caps per turn: the dearest extra draft goes first; still over → single. Routes that keep failing are left out', () => {
  const one = up('one'), two = up('two');
  const total = decide({ entries: lineup(one, two) }).estimateUsd;
  const tight = decide({ entries: lineup(one, two), settings: strategy({ turnUsdCap: total - 0.001 }) });
  assert.deepEqual(tight.members.map(e => e.model), ['a/strong', 'c/steady'], 'b/swift (the dearer extra) dropped');
  assert.equal(decide({ entries: lineup(one, two), settings: strategy({ turnUsdCap: 0.05 }) }).reason, 'over_turn_cap');
  assert.equal(decide({ entries: lineup(one, two), settings: strategy({ turnUsdCap: 0 }) }).reason, 'over_turn_cap');
  const failing = { n: OUTCOME_MIN, text: 4, toolCalls: 0, failed: 3, timeout: 3 };
  assert.deepEqual(decide({ entries: lineup(one, two), outcome: key => key === 'two|b/swift|' ? failing : undefined }).members.map(e => e.model), ['a/strong', 'c/steady', 'b/other']);
  assert.ok(decide({ entries: lineup(one, two), outcome: key => key === 'two|b/swift|' ? { ...failing, n: OUTCOME_MIN - 1 } : undefined }).members.some(e => e.model === 'b/swift'), 'fewer than 10 outcomes: not judged yet');
});

test('drafts are read from SSE or JSON; the judge gets the request, the drafts, and tools it may not call', () => {
  const sse = streamChunks('m', { toolCall: false, text: 'Hello there' }).join('');
  assert.deepEqual(parseAnswer(sse), { text: 'Hello there', toolCalls: false, usage: { in: 90, out: 3, cost: 0.000123 } });
  assert.equal(parseAnswer(streamChunks('m').join('')).toolCalls, true);
  assert.equal(parseAnswer(JSON.stringify({ choices: [{ message: { content: 'Hi' } }], usage: { prompt_tokens: 1, completion_tokens: 2 } })).text, 'Hi');
  const body = { model: 'auto', stream: true, tools: [{ type: 'function', function: { name: 'read' } }], tool_choice: 'auto', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'Q' }] };
  const judged = judgeBody(body, ['one', 'two'], 'consensus');
  assert.equal(judged.tool_choice, 'none');
  assert.deepEqual(judged.tools, body.tools, 'the contract stays (history may hold tool calls)');
  assert.deepEqual(judged.messages.slice(0, 2), body.messages);
  assert.match(judged.messages[2].content, /--- Draft 1 ---\none\n\n--- Draft 2 ---\ntwo$/u);
  assert.match(judgeBody(body, ['x'], 'best-of-n').messages[2].content, /Choose the best one/u);
  assert.equal(judgeBody({ ...body, tools: undefined }, ['x'], 'consensus').tool_choice, undefined);
  assert.ok(judgeBody(body, ['y'.repeat(30_000)], 'consensus').messages[2].content.length < 25_000, 'a draft is bounded');
});

// ---------------------------------------------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------------------------------------------

function call(port, { token, body }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', agent: false, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': payload.length } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const TOOLS = [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
const userTurn = (text, history = []) => ({ model: 'auto', stream: true, stream_options: { include_usage: true }, max_tokens: 4096, tools: TOOLS, tool_choice: 'auto',
  messages: [{ role: 'system', content: 'You are OpenCode.' }, { role: 'user', content: `Compare designs ${MARKER}` }, ...history, ...(history.length ? [{ role: 'user', content: text }] : [])] });

async function setup(t, { behaviours = {}, extra = {}, strategyExtra = {}, timeouts = {}, parallelCap } = {}) {
  const upstream = await startFakeUpstream({ behaviours: { 'a/strong': 'text', 'b/swift': 'text', 'c/steady': 'text', 'b/other': 'text', ...behaviours } });
  t.after(() => upstream.close());
  const settings = validateAutoSettings({
    upstreams: [{ id: 'one', preset: 'openai-compatible', baseUrl: upstream.url, trust: 'D2', key: 'own', enabled: true, models: [] }, { id: 'two', preset: 'openai-compatible', baseUrl: upstream.url, trust: 'D2', key: 'own', enabled: true, models: [] }],
    preference: 'balanced', cheaperFallback: false, decider: 'jev', dailyUsdCap: 1, perCardUsdCap: 0.5, strategy: strategy(strategyExtra), ...extra
  });
  const entries = lineup(settings.upstreams[0], settings.upstreams[1]);
  const dir = mkdtempSync(join(base, 'data-'));
  const router = new AutoRouter({
    directory: dir, settings: () => settings, inventory: () => ({ entries, cohorts: {}, waitingForList: [] }), dataClassMode: () => 'strict', key: async () => 'up-key',
    decide: async () => ({ difficulty: 'hard', strong: true, type: 'research', confidence: 0.05 }),
    ...(parallelCap ? { parallelCap } : {}),
    timeouts: { jevMs: 200, headersMs: 400, firstChunkMs: 300, idleMs: 300, memberMs: 600, ...timeouts }
  });
  t.after(() => router.stop());
  const { token, port } = await router.grant({ sessionId: 'card-cons-0001', provider: 'opencode', role: 'agent', parentSessionId: null, dataClass: 'D1' });
  return { upstream, router, token, port, dir };
}

test('consensus: three diverse drafts, buffered; the judge\'s merged answer reaches the CLI byte for byte; the record has no text', async t => {
  const { upstream, router, token, port, dir } = await setup(t);
  const answer = await call(port, { token, body: userTurn() });
  assert.equal(answer.status, 200);
  const posts = upstream.posts();
  assert.deepEqual(posts.slice(0, 3).map(p => p.model).sort(), ['a/strong', 'b/swift', 'c/steady']);
  const judge = posts[3];
  assert.equal(judge.model, 'a/strong');
  assert.equal(judge.json.tool_choice, 'none');
  assert.equal(judge.json.messages.length, 3);
  assert.match(judge.json.messages[2].content, /--- Draft 3 ---/u);
  assert.match(judge.json.messages[2].content, /Draft from a\/strong[\s\S]*Draft from b\/swift[\s\S]*Draft from c\/steady/u, 'the single choice\'s draft first');
  assert.equal(answer.text, upstream.sent.at(-1).bytes, 'the judge\'s stream, unchanged');
  assert.match(answer.text, /MERGED ANSWER from 3 drafts/u);
  const record = router.recent()[0];
  assert.equal(record.strategy, 'consensus');
  assert.equal(record.strategyWhy, 'consensus_pays');
  assert.equal(record.fanOut.outcome, 'merged');
  assert.deepEqual(record.fanOut.drafts.map(d => d.status), ['text', 'text', 'text']);
  assert.deepEqual(record.fanOut.judge, { upstream: 'one', model: 'a/strong' });
  assert.equal(Math.round(record.costUsd * 1e6), 800, 'three drafts and the judge, as reported');
  assert.equal(router.statsView().spentToday, 0.0008);
  assert.deepEqual(router.routeOutcomes()['two|b/swift|'], { n: 1, text: 1, toolCalls: 0, failed: 0, timeout: 0 });
  for (const name of readdirSync(dir)) {
    const text = readFileSync(join(dir, name), 'utf8');
    for (const secret of [MARKER, 'Draft from', 'MERGED ANSWER', token, 'up-key']) assert.ok(!text.includes(secret), `${name} has no ${secret.slice(0, 14)}`);
  }
});

test('a failed and a late draft are dropped: two left are merged; one left is the answer; none → the single path', async t => {
  {
    const { upstream, router, token, port } = await setup(t, { behaviours: { 'c/steady': 500 } });
    const answer = await call(port, { token, body: userTurn() });
    assert.equal(answer.status, 200);
    assert.match(answer.text, /MERGED ANSWER from 2 drafts/u);
    const record = router.recent()[0];
    assert.deepEqual(record.fanOut.drafts.map(d => [d.model, d.status]), [['a/strong', 'text'], ['b/swift', 'text'], ['c/steady', 'failed']]);
    assert.equal(record.fanOut.drafts[2].http, 500);
    assert.ok(router['cooldowns'].has('two|c/steady'), 'it cools down like any failed call');
    void upstream;
  }
  {
    const { upstream, router, token, port } = await setup(t, { behaviours: { 'b/swift': 503, 'c/steady': 'hang' } });
    const started = Date.now();
    const answer = await call(port, { token, body: userTurn() });
    assert.equal(answer.status, 200);
    assert.ok(Date.now() - started < 3_000, 'a hanging draft costs its deadline, not the whole call');
    const record = router.recent()[0];
    assert.deepEqual(record.fanOut.drafts.map(d => d.status), ['text', 'failed', 'timeout']);
    assert.equal(record.fanOut.outcome, 'one_draft');
    assert.equal(record.model, 'a/strong');
    assert.equal(answer.text, upstream.sent.find(s => s.model === 'a/strong').bytes, 'the remaining draft, as it came');
    assert.equal(upstream.posts().length, 3, 'no judge for one draft');
    assert.equal(router.stats.fanOutDegraded, 1);
  }
  {
    const { upstream, router, token, port } = await setup(t, { behaviours: { 'a/strong': 502, 'b/swift': 503, 'c/steady': 500 } });
    const answer = await call(port, { token, body: userTurn() });
    assert.equal(answer.status, 200, 'b/other answers on the single path');
    const record = router.recent()[0];
    assert.equal(record.fanOut.outcome, 'no_draft');
    assert.equal(record.model, 'b/other');
    assert.deepEqual(upstream.posts().slice(3).map(p => p.model), ['b/other'], 'the failed drafts are not asked again');
  }
});

test('a failed judge: the best-scored draft that answered is the answer', async t => {
  const { upstream, router, token, port } = await setup(t);
  // a/strong answers its draft but refuses the judge's request (its second call).
  let calls = 0;
  Object.defineProperty(upstream.behaviours, 'a/strong', { get: () => (++calls === 1 ? 'text' : 500), configurable: true });
  const answer = await call(port, { token, body: userTurn() });
  assert.equal(answer.status, 200);
  const record = router.recent()[0];
  assert.equal(record.fanOut.outcome, 'judge_failed');
  assert.equal(record.reason, 'judge_failed');
  assert.equal(record.model, 'a/strong', 'the best-scored draft');
  assert.match(answer.text, /Draft from a\/strong/u);
  assert.equal(router.stats.judgeFailed, 1);
});

test('a tool call in any draft: the turn is agentic, the single choice\'s answer passes through, the others stop; that conversation stays single', async t => {
  const { upstream, router, token, port } = await setup(t, { behaviours: { 'b/swift': 'stream', 'c/steady': 'text-slow' }, timeouts: { memberMs: 2_000, firstChunkMs: 1_000 } });
  const answer = await call(port, { token, body: userTurn() });
  assert.equal(answer.status, 200);
  const record = router.recent()[0];
  assert.equal(record.fanOut.outcome, 'tool_calls');
  const statuses = Object.fromEntries(record.fanOut.drafts.map(d => [d.model, d.status]));
  assert.deepEqual(statuses, { 'a/strong': 'text', 'b/swift': 'tool_calls', 'c/steady': 'stopped' });
  assert.equal(answer.text, upstream.sent.find(s => s.model === 'a/strong').bytes, 'the single choice\'s own answer');
  assert.equal(upstream.posts().length, 3, 'no judge');
  // The next turn of that conversation goes straight to the single choice.
  const next = await call(port, { token, body: userTurn('And now?', [{ role: 'assistant', content: 'x' }]) });
  assert.equal(next.status, 200);
  assert.equal(router.recent()[0].strategy, 'single');
  assert.equal(router.recent()[0].strategyWhy, 'agentic_conversation');
  assert.equal(upstream.posts().length, 4);
});

test('budget: every draft and the judge are reserved first; a draft that does not fit is left out; no room for the judge → single', async t => {
  {
    // Card cap $0.28: the judge (~$0.166) + a/strong (~$0.104) + b/swift (~$0.008) fit, c/steady does not.
    const { router, token, port } = await setup(t, { extra: { perCardUsdCap: 0.28 } });
    const answer = await call(port, { token, body: userTurn() });
    assert.equal(answer.status, 200);
    const record = router.recent()[0];
    assert.deepEqual(record.fanOut.drafts.map(d => [d.model, d.status]), [['c/steady', 'capped'], ['a/strong', 'text'], ['b/swift', 'text']]);
    assert.equal(record.fanOut.outcome, 'merged');
    assert.ok(Math.abs(router['spend'].held) < 1e-9, 'every reservation is settled');
  }
  {
    const { upstream, router, token, port } = await setup(t, { extra: { dailyUsdCap: 0.12 } });
    const answer = await call(port, { token, body: userTurn() });
    assert.equal(answer.status, 200);
    const record = router.recent()[0];
    assert.equal(record.strategy, 'single');
    assert.equal(record.strategyWhy, 'judge_over_cap');
    assert.equal(upstream.posts().length, 1, 'nothing fanned out');
  }
  {
    // While drafts run, their reservations are held: a parallel call sees the room they take.
    const { router, token, port } = await setup(t, { behaviours: { 'c/steady': 'text-slow' }, timeouts: { memberMs: 2_000, firstChunkMs: 1_000 } });
    const pending = call(port, { token, body: userTurn() });
    await new Promise(resolve => setTimeout(resolve, 150));
    const held = router['spend'].held;
    assert.ok(held > 0.25 && held < 0.3, `drafts and judge held together (${held})`);
    assert.equal((await pending).status, 200);
    assert.ok(Math.abs(router['spend'].held) < 1e-9);
  }
});

test('a subscription-like upstream at its parallel cap takes fewer drafts; an orchestrator card never fans out', async t => {
  const { upstream, router, token, port } = await setup(t, { parallelCap: u => u.id === 'two' ? 1 : null });
  assert.equal((await call(port, { token, body: userTurn() })).status, 200);
  assert.deepEqual(router.recent()[0].fanOut.drafts.map(d => d.model), ['a/strong', 'b/swift'], 'one draft on "two" (c/steady waits); b/other is b\'s vendor again');
  const grant = await router.grant({ sessionId: 'card-orch-0001', provider: 'opencode', role: 'orchestrator', parentSessionId: null, dataClass: 'D1' });
  const before = upstream.posts().length;
  assert.equal((await call(port, { token: grant.token, body: userTurn() })).status, 200);
  assert.equal(router.recent()[0].strategyWhy, 'orchestrator');
  assert.equal(upstream.posts().length - before, 1);
});
