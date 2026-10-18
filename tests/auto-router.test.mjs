// Model: Auto (Jev) — the router on 127.0.0.1 against a fake OpenAI-compatible upstream and a fake Jev: key, Origin
// and Host checks, the stream passed through byte for byte, one decision per user turn, failover before the first
// byte, cooldowns, caps, and a log with no text. No model, no network beyond loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoRouter } from '../src/auto/router.ts';
import { validateAutoSettings } from '../src/auto/settings.ts';
import { candidates, requestKind, tierFor, latestUserText } from '../src/auto/classify.ts';
import { buildInventory } from '../src/auto/inventory.ts';

/** No catalog at all: every model is routed by its manual tier (or is unknown). */
const NO_CATALOG = { asOf: 0, benchmarks: [], models: [], providers: [], pricesStale: true, openRouter: null, openRouterPricesStale: true };
const inventoryOf = settings => buildInventory(settings, NO_CATALOG);
import { startFakeUpstream } from './helpers/fake-upstream.mjs';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'canvastty-auto-router-')));
process.on('exit', () => rmSync(base, { recursive: true, force: true }));
const MARKER = 'MARKER-PROMPT-7f3a9c';

function settingsFor(upstreamUrl, models, extra = {}) {
  return validateAutoSettings({
    upstreams: [{ id: 'fake', preset: 'openai-compatible', baseUrl: upstreamUrl, trust: 'D2', key: 'own', enabled: true, models }],
    preference: 'balanced', cheaperFallback: false, decider: 'jev', dailyUsdCap: 1, perCardUsdCap: 0.5, ...extra
  });
}

const TIERED = [
  { id: 'vendor/small-a', tier: 'small', priceIn: 0.1, priceOut: 0.2 },
  { id: 'vendor/small-b', tier: 'small', priceIn: 0.05, priceOut: 0.1 },
  { id: 'vendor/medium-a', tier: 'medium', priceIn: 0.5, priceOut: 1 },
  { id: 'vendor/medium-b', tier: 'medium', priceIn: 0.4, priceOut: 0.8 },
  { id: 'vendor/large-a', tier: 'large', priceIn: 2, priceOut: 8 }
];

async function setup(t, { behaviours = {}, models = TIERED, extra = {}, decide, turn, timeouts = {}, directory, upstreamKey = 'up-key' } = {}) {
  const upstream = await startFakeUpstream({ behaviours });
  t.after(() => upstream.close());
  let settings = settingsFor(upstream.url, models, extra);
  const jev = { calls: 0, texts: [] };
  const badges = [];
  const dir = directory ?? mkdtempSync(join(base, 'data-'));
  const router = new AutoRouter({
    directory: dir,
    settings: () => settings,
    inventory: () => inventoryOf(settings),
    dataClassMode: () => 'strict',
    key: async () => upstreamKey,
    decide: decide ?? (async text => { jev.calls++; jev.texts.push(text); return { difficulty: /hard|architecture/u.test(text) ? 'hard' : /typo/u.test(text) ? 'simple' : 'normal', strong: false, type: 'coding', confidence: /typo/u.test(text) ? 0.95 : 0.2 }; }),
    ...(turn ? { turn } : {}),
    badge: (sessionId, model) => badges.push({ sessionId, model }),
    timeouts: { jevMs: 200, headersMs: 400, firstChunkMs: 300, idleMs: 300, ...timeouts }
  });
  t.after(() => router.stop());
  const { token, port } = await router.grant({ sessionId: 'card-0001-aaaa', provider: 'opencode', role: 'agent', parentSessionId: null, dataClass: 'D1' });
  return { upstream, router, token, port, jev, badges, dir, set: next => { settings = next; } };
}

/** Raw HTTP so tests control every header (Host, Origin). */
function call(port, { method = 'POST', path = '/v1/chat/completions', token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = httpRequest({ host: '127.0.0.1', port, method, path, agent: false, headers: {
      host: `127.0.0.1:${port}`, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}), ...headers
    } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const TOOLS = [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
const userTurn = (text, history = []) => ({
  model: 'auto', stream: true, stream_options: { include_usage: true }, max_tokens: 1000, tools: TOOLS, tool_choice: 'auto',
  messages: [{ role: 'system', content: 'You are OpenCode.' }, ...history, { role: 'user', content: [{ type: 'text', text }] }]
});
const continuation = (text, steps = 1, tools = TOOLS) => {
  const history = [{ role: 'system', content: 'You are OpenCode.' }, { role: 'user', content: text }];
  for (let i = 0; i < steps; i++) history.push({ role: 'assistant', content: null, tool_calls: [{ id: `call_${i}`, type: 'function', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: `call_${i}`, content: 'file text' });
  return { model: 'auto', stream: true, stream_options: { include_usage: true }, tools, tool_choice: 'auto', messages: history };
};

test('security: 127.0.0.1 only; a missing or wrong key is 401, an Origin or a foreign Host 403, other paths 404', async t => {
  const { router, token, port } = await setup(t);
  assert.equal(router.listening, port);
  assert.equal(router['server'].address().address, '127.0.0.1');
  assert.match(token, /^sk-ctty-[A-Za-z0-9_-]{43}$/u);
  assert.equal((await call(port, { method: 'GET', path: '/v1/models' })).status, 401);
  assert.equal((await call(port, { method: 'GET', path: '/v1/models', token: `${token.slice(0, -1)}${token.endsWith('A') ? 'E' : 'A'}` })).status, 401, 'one character off (the last base64url character of 32 bytes is one of 16, so a fixed "A" matched 1 run in 16)');
  assert.equal((await call(port, { method: 'GET', path: '/v1/models', token: 'sk-ctty-short' })).status, 401);
  assert.equal((await call(port, { method: 'GET', path: '/v1/models', token, headers: { origin: 'http://127.0.0.1:3000' } })).status, 403);
  assert.equal((await call(port, { method: 'GET', path: '/v1/models', token, headers: { origin: 'null' } })).status, 403);
  assert.equal((await call(port, { method: 'GET', path: '/v1/models', token, headers: { host: `evil.example:${port}` } })).status, 403);
  assert.equal((await call(port, { method: 'GET', path: '/v1/models', token, headers: { host: '127.0.0.1:1' } })).status, 403);
  const models = await call(port, { method: 'GET', path: '/v1/models', token, headers: { host: `localhost:${port}` } });
  assert.equal(models.status, 200);
  assert.deepEqual(JSON.parse(models.text).data.map(entry => entry.id), ['auto', 'auto-small']);
  assert.equal(models.headers['access-control-allow-origin'], undefined, 'no CORS');
  assert.equal((await call(port, { method: 'POST', path: '/v1/responses', token, body: {} })).status, 404);
  assert.equal((await call(port, { method: 'GET', path: '/admin', token })).status, 404);
  assert.equal((await call(port, { token, body: { model: 'gpt-4o', messages: [] } })).status, 400, 'only auto and auto-small');
  assert.equal((await call(port, { token, body: 'not json' })).status, 400);
});

test('keys: a restarted service keeps running cards\' keys and port; a closed card\'s key is dead and the port closes', async t => {
  const first = await setup(t);
  const { token, port, dir } = first;
  assert.equal((await call(port, { token, body: userTurn('hello') })).status, 200);
  const saved = readFileSync(join(dir, 'tokens.json'), 'utf8');
  assert.ok(!saved.includes(token) && !saved.includes(token.slice(8)), 'only the hash is stored');
  assert.equal(statSync(join(dir, 'tokens.json')).mode & 0o777, 0o600);
  await first.router.stop();
  // The service restarts: same folder, same port, same key.
  const second = new AutoRouter({ directory: dir, settings: () => settingsFor(first.upstream.url, TIERED), inventory: () => inventoryOf(settingsFor(first.upstream.url, TIERED)), dataClassMode: () => 'strict', key: async () => 'up-key' });
  t.after(() => second.stop());
  await second.resume();
  assert.equal(second.listening, port, 'the same port as before');
  assert.equal((await call(port, { token, body: userTurn('hello again') })).status, 200);
  // A restart of the card mints a new key: the old one dies.
  const again = await second.grant({ sessionId: 'card-0001-aaaa', provider: 'opencode', role: 'agent', parentSessionId: null, dataClass: 'D1' });
  assert.equal(again.port, port);
  assert.equal((await call(port, { token, body: userTurn('x') })).status, 401);
  assert.equal((await call(port, { token: again.token, body: userTurn('x') })).status, 200);
  second.closeSession('card-0001-aaaa');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(second.listening, null, 'nothing uses the router: it stops listening');
  await assert.rejects(call(port, { token: again.token, body: userTurn('x') }), /ECONNREFUSED/u);
  const third = await second.grant({ sessionId: 'card-2', provider: 'opencode', role: 'agent', parentSessionId: null, dataClass: 'D1' });
  assert.equal(third.port, port, 'the port is reused');
  assert.equal((await call(port, { token: again.token, body: userTurn('x') })).status, 401, 'the closed card\'s key stays dead');
});

test('passthrough: the stream (text, tool-call deltas, usage) reaches the CLI byte for byte; only model changes in the body', async t => {
  const { upstream, token, port, badges } = await setup(t);
  const body = userTurn('Fix the bug in the parser');
  body.temperature = 0.2;
  body.response_format = { type: 'text' };
  const answer = await call(port, { token, body });
  assert.equal(answer.status, 200);
  assert.match(answer.headers['content-type'], /text\/event-stream/u);
  const sent = upstream.sent.at(-1);
  assert.equal(answer.text, sent.bytes, 'byte-identical SSE');
  assert.match(answer.text, /"tool_calls"/u);
  assert.match(answer.text, /"usage"/u);
  const forwarded = upstream.posts().at(-1);
  assert.equal(forwarded.auth, 'Bearer up-key', 'the upstream key, never the card key');
  assert.equal(forwarded.path, '/v1/chat/completions');
  assert.equal(forwarded.json.model, 'vendor/medium-a');
  assert.deepEqual({ ...forwarded.json, model: 'auto' }, body, 'everything else unchanged');
  assert.deepEqual(badges, [{ sessionId: 'card-0001-aaaa', model: { model: 'vendor/medium-a', tier: 'medium', source: 'jev' } }]);
  // Non-streaming answers pass through as well.
  upstream.behaviours['vendor/medium-a'] = 'json';
  const json = await call(port, { token, body: { ...userTurn('Another question'), stream: false } });
  assert.equal(json.status, 200);
  assert.equal(JSON.parse(json.text).choices[0].message.content, 'Hi');
});

test('one Jev decision per user turn: continuations reuse it, a new turn or new tools decide again, auto-small never asks', async t => {
  const { upstream, router, token, port, jev, badges } = await setup(t);
  assert.equal((await call(port, { token, body: userTurn(`Redesign the architecture ${MARKER}`) })).status, 200);
  assert.equal(jev.calls, 1);
  assert.equal(upstream.posts().at(-1).model, 'vendor/large-a', 'hard → large');
  const firstText = upstream.posts().at(-1).json.messages.at(-1).content[0].text;
  for (let step = 1; step <= 10; step++) assert.equal((await call(port, { token, body: continuation(firstText, step) })).status, 200);
  assert.equal(jev.calls, 1, 'ten tool continuations, no more Jev calls');
  assert.ok(upstream.posts().slice(-10).every(entry => entry.model === 'vendor/large-a'));
  assert.equal(router.recent()[0].source, 'lease');
  // Changed tools: the contract changed, decide again.
  assert.equal((await call(port, { token, body: continuation(firstText, 11, [...TOOLS, { type: 'function', function: { name: 'write', parameters: { type: 'object' } } }]) })).status, 200);
  assert.equal(jev.calls, 2);
  // A new user message in the same conversation: decide again.
  const history = [{ role: 'user', content: [{ type: 'text', text: firstText }] }, { role: 'assistant', content: 'Done.' }];
  assert.equal((await call(port, { token, body: userTurn('Now fix a typo in the readme', history) })).status, 200);
  assert.equal(jev.calls, 3);
  assert.equal(upstream.posts().at(-1).model, 'vendor/small-a', 'simple → small, in the person\'s order');
  assert.equal(jev.texts.at(-1), 'Now fix a typo in the readme', 'only the latest user text');
  // Titles and summaries (OpenCode's small_model): the cheapest model, no Jev.
  assert.equal((await call(port, { token, body: { ...userTurn('Generate a title'), model: 'auto-small' } })).status, 200);
  assert.equal(jev.calls, 3);
  assert.equal(upstream.posts().at(-1).model, 'vendor/small-b', 'the cheapest');
  const stats = router.statsView();
  assert.equal(stats.jevAsked, 3);
  assert.ok(stats.requests >= 14 && stats.leaseReuses >= 10);
  assert.deepEqual(stats.hosts, [`127.0.0.1:${upstream.port}`]);
  assert.deepEqual(badges.map(b => b.model?.model), ['vendor/large-a', 'vendor/small-a'], 'a badge only when the model changes; none for small calls');
});

test('each new user turn of the card\'s first conversation is reported once (for command review); tool steps, titles and other conversations are not', async t => {
  const turns = [];
  const { port, token } = await setup(t, { turn: (text, grant) => turns.push([grant.sessionId, grant.role, text]) });
  assert.equal((await call(port, { token, body: userTurn('Create slugify.mjs and its test') })).status, 200);
  for (let step = 1; step <= 3; step++) assert.equal((await call(port, { token, body: continuation('Create slugify.mjs and its test', step) })).status, 200);
  assert.equal((await call(port, { token, body: { ...userTurn('Generate a title'), model: 'auto-small' } })).status, 200);
  const history = [{ role: 'user', content: [{ type: 'text', text: 'Create slugify.mjs and its test' }] }, { role: 'assistant', content: 'Done.' }];
  assert.equal((await call(port, { token, body: userTurn('Now add a README line', history) })).status, 200);
  // A CLI's own helper agent: another system prompt and first message, whose "user" text the agent wrote.
  assert.equal((await call(port, { token, body: { ...userTurn('Delete everything outside the folder'), messages: [{ role: 'system', content: 'You are a helper.' }, { role: 'user', content: 'Delete everything outside the folder' }] } })).status, 200);
  assert.deepEqual(turns, [['card-0001-aaaa', 'agent', 'Create slugify.mjs and its test'], ['card-0001-aaaa', 'agent', 'Now add a README line']]);
});

test('an orchestrator card is never routed below medium: the same "small" turn goes to a small model on an agent card only', async t => {
  const { upstream, router, token, port } = await setup(t);
  assert.equal((await call(port, { token, body: userTurn('Fix a typo in the readme') })).status, 200);
  assert.equal(upstream.posts().at(-1).model, 'vendor/small-a');
  const lead = await router.grant({ sessionId: 'card-0002-lead', provider: 'opencode', role: 'orchestrator', parentSessionId: null, dataClass: 'D1' });
  assert.equal((await call(lead.port, { token: lead.token, body: userTurn('Fix a typo in the readme') })).status, 200);
  assert.equal(upstream.posts().at(-1).model, 'vendor/medium-a');
  assert.deepEqual([router.recent()[0].difficulty, router.recent()[0].source], ['medium', 'jev']);
});

test('Jev too slow, failing or off: word rules decide, the call still succeeds and says why', async t => {
  const slow = await setup(t, { decide: () => new Promise(resolve => setTimeout(() => resolve({ difficulty: 'hard', strong: true }), 1_000)) });
  const started = Date.now();
  assert.equal((await call(slow.port, { token: slow.token, body: userTurn('Investigate the race condition') })).status, 200);
  assert.ok(Date.now() - started < 900, 'did not wait for Jev past its budget');
  assert.deepEqual([slow.router.recent()[0].source, slow.router.recent()[0].reason], ['rules', 'jev_slow']);
  assert.equal(slow.upstream.posts().at(-1).model, 'vendor/large-a', 'rules: "race" is hard');
  const failing = await setup(t, { decide: async () => { throw new Error('boom'); } });
  assert.equal((await call(failing.port, { token: failing.token, body: userTurn('Rename a variable') })).status, 200);
  assert.deepEqual([failing.router.recent()[0].source, failing.router.recent()[0].reason], ['rules', 'jev_error']);
  const none = await setup(t, { decide: async () => null });
  assert.equal((await call(none.port, { token: none.token, body: userTurn('Write a function') })).status, 200);
  assert.deepEqual([none.router.recent()[0].source, none.router.recent()[0].reason], ['rules', 'jev_unavailable']);
  const rulesOnly = await setup(t, { extra: { decider: 'rules' } });
  assert.equal((await call(rulesOnly.port, { token: rulesOnly.token, body: userTurn('Write a function') })).status, 200);
  assert.equal(rulesOnly.jev.calls, 0);
  assert.equal(rulesOnly.router.recent()[0].reason, 'rules_only');
});

test('failover before the first byte: 429 (Retry-After), 500, 404, a dead upstream and a timeout move on; cooldowns skip them next time', async t => {
  const models = [{ id: 'm/rate', tier: 'medium' }, { id: 'm/broken', tier: 'medium' }, { id: 'm/missing', tier: 'medium' }, { id: 'm/hang', tier: 'medium' }, { id: 'm/good', tier: 'medium' }];
  const { upstream, router, token, port } = await setup(t, { models, behaviours: { 'm/rate': { status: 429, headers: { 'retry-after': '120' } }, 'm/broken': 500, 'm/missing': 404, 'm/hang': 'hang' } });
  const answer = await call(port, { token, body: userTurn('Write a function') });
  assert.equal(answer.status, 200);
  assert.match(answer.text, /data: \[DONE\]/u);
  assert.deepEqual(upstream.posts().map(entry => entry.model), ['m/rate', 'm/broken', 'm/missing', 'm/hang', 'm/good']);
  const record = router.recent()[0];
  assert.deepEqual(record.failovers.map(f => [f.model, f.status]), [['m/rate', 429], ['m/broken', 500], ['m/missing', 404], ['m/hang', 'timeout']]);
  assert.equal(record.model, 'm/good');
  assert.ok(!JSON.stringify(record).includes('SECRET-UPSTREAM-DETAIL'), 'no upstream text in the log');
  // The next call goes straight to the model that works: the others cool down.
  const before = upstream.posts().length;
  assert.equal((await call(port, { token, body: userTurn('Write another function') })).status, 200);
  assert.deepEqual(upstream.posts().slice(before).map(entry => entry.model), ['m/good']);
  assert.ok(router['cooldowns'].get('fake|m/rate') - Date.now() > 100_000, 'Retry-After 120 s honoured');
});

test('a 400 that names an unknown model id (OpenRouter: "is not a valid model ID") moves on and cools that model down like a 404', async t => {
  const models = [{ id: 'm/typo', tier: 'medium' }, { id: 'm/good', tier: 'medium' }];
  const { upstream, router, token, port } = await setup(t, { models, behaviours: { 'm/typo': { status: 400, body: { error: { message: 'm/typo is not a valid model ID', code: 400 } } } } });
  assert.equal((await call(port, { token, body: userTurn('Write a function') })).status, 200);
  assert.deepEqual(upstream.posts().map(entry => entry.model), ['m/typo', 'm/good']);
  const record = router.recent()[0];
  assert.deepEqual(record.failovers.map(f => [f.model, f.status]), [['m/typo', 400]]);
  assert.equal(record.model, 'm/good');
  const before = upstream.posts().length;
  assert.equal((await call(port, { token, body: userTurn('Write another function') })).status, 200);
  assert.deepEqual(upstream.posts().slice(before).map(entry => entry.model), ['m/good'], 'the unknown id cools down');
  assert.ok(router['cooldowns'].get('fake|m/typo') - Date.now() > 10 * 60_000, 'cooldown as long as a 404');
});

test('no failover on a bad payload (400) or after the first byte (no replay); 401 cools the upstream and tries the next', async t => {
  const bad = await setup(t, { models: [{ id: 'm/strict', tier: 'medium' }, { id: 'm/good', tier: 'medium' }], behaviours: { 'm/strict': 400 } });
  const refused = await call(bad.port, { token: bad.token, body: userTurn('Write a function') });
  assert.equal(refused.status, 400);
  assert.match(JSON.parse(refused.text).error.message, /m\/strict refused the request \(400\)/u);
  assert.deepEqual(bad.upstream.posts().map(entry => entry.model), ['m/strict'], 'the next model is not tried');
  const cut = await setup(t, { models: [{ id: 'm/cut', tier: 'medium' }, { id: 'm/good', tier: 'medium' }], behaviours: { 'm/cut': 'cut' } });
  const partial = await call(cut.port, { token: cut.token, body: userTurn('Write a function') });
  assert.equal(partial.status, 200);
  assert.match(partial.text, /"content":"Hello"/u, 'what arrived was passed on');
  assert.match(partial.text, /upstream_interrupted/u, 'then an error event');
  assert.deepEqual(cut.upstream.posts().map(entry => entry.model), ['m/cut'], 'never replayed on another model');
  assert.equal(cut.router.recent()[0].status, 502);
  // Two upstreams: the first one's key is refused (401) → the second answers; the first then cools down.
  const second = await startFakeUpstream({ key: 'up-key' });
  t.after(() => second.close());
  const wrongKey = await setup(t, { models: [{ id: 'm/a', tier: 'medium' }], upstreamKey: 'up-key' });
  const settings = validateAutoSettings({
    upstreams: [
      { id: 'first', preset: 'openai-compatible', baseUrl: wrongKey.upstream.url, trust: 'D2', key: 'own', enabled: true, models: [{ id: 'm/a', tier: 'medium' }] },
      { id: 'second', preset: 'openai-compatible', baseUrl: second.url, trust: 'D2', key: 'own', enabled: true, models: [{ id: 'm/b', tier: 'medium' }] }
    ], preference: 'balanced', cheaperFallback: false, decider: 'rules', dailyUsdCap: 1, perCardUsdCap: 1
  });
  wrongKey.set(settings);
  wrongKey.upstream.behaviours['m/a'] = 401;
  assert.equal((await call(wrongKey.port, { token: wrongKey.token, body: userTurn('Write a function') })).status, 200);
  assert.deepEqual(second.posts().map(entry => entry.model), ['m/b']);
  assert.ok(wrongKey.router['cooldowns'].get('first') > Date.now() + 600_000, 'auth: the whole upstream cools 15 min');
  // A dead upstream (connection refused) is skipped too.
  await wrongKey.upstream.close();
  assert.equal((await call(wrongKey.port, { token: wrongKey.token, body: userTurn('Write more') })).status, 200);
});

test('everything fails: a clear error, and a slow first chunk counts as a timeout before the first byte', async t => {
  const { token, port, router } = await setup(t, { models: [{ id: 'm/slow', tier: 'medium' }], behaviours: { 'm/slow': 'slow-first' } });
  const answer = await call(port, { token, body: userTurn('Write a function') });
  assert.equal(answer.status, 503);
  assert.match(JSON.parse(answer.text).error.message, /no allowed model answered/u);
  assert.deepEqual(router.recent()[0].failovers.map(f => f.status), ['timeout']);
  // Cooling down: the next call has no model at all.
  const none = await call(port, { token, body: userTurn('Again') });
  assert.equal(none.status, 503);
  assert.match(JSON.parse(none.text).error.code, /no_model/u);
});

test('caps: the per-card and daily caps are reserved before sending, so parallel calls cannot overshoot; spent → 402', async t => {
  // max_tokens 1000 × $8/M out ≈ $0.008 + input: each call reserves about $0.008; a cap of $0.012 fits one.
  const { token, port, upstream } = await setup(t, { models: [{ id: 'vendor/large-a', tier: 'medium', priceIn: 2, priceOut: 8 }], extra: { perCardUsdCap: 0.012, dailyUsdCap: 1 }, behaviours: {} });
  upstream.behaviours['vendor/large-a'] = 'slow-first';
  const answers = await Promise.all([1, 2, 3].map(i => call(port, { token, body: userTurn(`Write function ${i}`) })));
  const statuses = answers.map(a => a.status).sort();
  assert.equal(statuses.filter(s => s === 402).length, 2, `one call fits the card cap: ${statuses}`);
  assert.match(answers.find(a => a.status === 402).text, /card's cap is reached/u);
  // Without prices nothing is held in advance; the cost the upstream reports counts.
  const daily = await setup(t, { models: [{ id: 'vendor/unpriced', tier: 'medium' }], extra: { dailyUsdCap: 0.0001, perCardUsdCap: 1 } });
  assert.equal((await call(daily.port, { token: daily.token, body: userTurn('Write a function') })).status, 200, 'the first fits');
  const spent = await call(daily.port, { token: daily.token, body: userTurn('Write another') });
  assert.equal(spent.status, 402, 'the reported cost ($0.000123) spent the day');
  assert.match(spent.text, /daily cap/u);
});

test('the decision log has hashes, models and numbers only: no prompt, no key, no upstream text', async t => {
  const { token, port, dir, router } = await setup(t, { models: [{ id: 'm/rate', tier: 'medium' }, { id: 'm/good', tier: 'medium' }], behaviours: { 'm/rate': 429 } });
  await call(port, { token, body: userTurn(`Please handle ${MARKER} carefully`) });
  await call(port, { token, body: continuation(`Please handle ${MARKER} carefully`, 2) });
  const record = router.recent()[1];
  assert.deepEqual(Object.keys(record).sort(), ['at', 'attempts', 'confidence', 'conversation', 'costUsd', 'difficulty', 'effort', 'failovers', 'kind', 'model', 'priceIn', 'priceOut', 'reason', 'score', 'scoreSource', 'session', 'source', 'status', 'taskType', 'tier', 'tokensIn', 'tokensOut', 'totalMs', 'tradeoff', 'ttfbMs', 'turn', 'upstream', 'why'].sort());
  assert.deepEqual([record.taskType, record.difficulty, record.why], ['coding', 'medium', 'manual_tier']);
  assert.equal(record.session, 'card-000');
  assert.equal(record.tokensIn, 120);
  assert.equal(record.costUsd, 0.000123);
  for (const name of readdirSync(dir)) {
    const text = readFileSync(join(dir, name), 'utf8');
    for (const secret of [MARKER, token, token.slice(8), 'up-key', 'SECRET-UPSTREAM-DETAIL', 'You are OpenCode']) assert.ok(!text.includes(secret), `${name} has no ${secret.slice(0, 12)}`);
  }
});

test('classification and candidates (pure)', () => {
  assert.equal(requestKind({ messages: [{ role: 'user', content: 'x' }] }, false), 'turn');
  assert.equal(requestKind({ messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }, { role: 'tool', content: 'z' }] }, false), 'continuation');
  assert.equal(requestKind({ messages: [{ role: 'user', content: 'x' }] }, true), 'small');
  assert.equal(latestUserText({ messages: [{ role: 'user', content: 'old' }, { role: 'user', content: [{ type: 'text', text: 'Fix it <system-reminder>secret plan</system-reminder>' }, { type: 'image_url' }] }] }), 'Fix it');
  assert.equal(tierFor('normal', false, 'balanced'), 'medium');
  assert.equal(tierFor('normal', false, 'cheap'), 'small');
  assert.equal(tierFor('hard', false, 'best'), 'large');
  assert.equal(tierFor('simple', true, 'cheap'), 'medium', 'design-level work: large, one step cheaper');
  const settings = validateAutoSettings({
    upstreams: [
      { id: 'cloud', preset: 'openrouter', trust: 'D1', key: 'own', enabled: true, models: TIERED },
      { id: 'local', preset: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', trust: 'D3', key: 'none', enabled: true, models: [{ id: 'local/coder', tier: 'medium' }] }
    ], preference: 'cheap', cheaperFallback: false, decider: 'jev', dailyUsdCap: 1, perCardUsdCap: 1
  });
  const ids = (tier, cardClass, mode = 'strict', extra = {}) => candidates({ ...settings, ...extra }, tier, { cardClass, mode, coolingDown: () => false }).map(c => c.model.id);
  assert.deepEqual(ids('medium', 'D1'), ['vendor/medium-b', 'vendor/medium-a', 'local/coder', 'vendor/large-a'], 'cheap first, then stronger tiers');
  assert.deepEqual(ids('medium', 'D2'), ['local/coder'], 'strict: D2 only to an upstream trusted with D2');
  assert.deepEqual(ids('medium', 'D2', 'warn'), ['vendor/medium-b', 'vendor/medium-a', 'local/coder', 'vendor/large-a']);
  assert.deepEqual(ids('medium', 'D3', 'warn'), ['local/coder'], 'D3 stays on this computer in Warn too');
  assert.deepEqual(ids('medium', 'D3', 'off').length, 4);
  assert.deepEqual(ids('large', 'D1', 'strict', { cheaperFallback: true }), ['vendor/large-a', 'vendor/medium-b', 'vendor/medium-a', 'local/coder', 'vendor/small-b', 'vendor/small-a']);
  assert.deepEqual(ids('large', 'D1', 'strict', { preference: 'best' }), ['vendor/large-a']);
  assert.throws(() => validateAutoSettings({ ...settings, upstreams: [{ ...settings.upstreams[1], baseUrl: 'https://example.com/v1' }] }), /D3 stays on this computer/u);
  assert.throws(() => validateAutoSettings({ ...settings, upstreams: [{ ...settings.upstreams[0], baseUrl: 'https://evil.example/v1' }] }), /fixed address/u);
  assert.throws(() => validateAutoSettings({ ...settings, upstreams: [{ ...settings.upstreams[1], baseUrl: 'http://example.com/v1', trust: 'D1' }] }), /http on this computer only/u);
  assert.throws(() => validateAutoSettings({ ...settings, upstreams: [{ ...settings.upstreams[1], preset: 'openai-compatible', key: 'jev', trust: 'D1' }] }), /Jev · OpenRouter key/u);
});
