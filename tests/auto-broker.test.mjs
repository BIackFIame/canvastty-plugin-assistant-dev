// Auto through another extension's account (CanvasTTY's brokered requests, B6): the broker client against a fake
// host that plays CanvasTTY's accounts.* (list, request, body, cancel and the head/chunk/end notifications), and the
// router sending an account upstream's turns through it: never fetch, never openrouter.ai, failover and cooldowns as
// for a direct upstream. No model, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountBroker, brokeredAccountOf } from '../src/auto/broker.ts';
import { AutoRouter } from '../src/auto/router.ts';
import { accountUpstream, validateAutoSettings, validateAutoUpstream } from '../src/auto/settings.ts';
import { buildInventory } from '../src/auto/inventory.ts';
import { startFakeUpstream } from './helpers/fake-upstream.mjs';

const NO_CATALOG = { asOf: 0, benchmarks: [], models: [], providers: [], pricesStale: true, openRouter: null, openRouterPricesStale: true };
const base = realpathSync(mkdtempSync(join(tmpdir(), 'canvastty-auto-broker-')));
process.on('exit', () => rmSync(base, { recursive: true, force: true }));
const REF = 'canvastty-accounts:glm-plan';
const ACCOUNT = { ref: REF, owner: 'canvastty-accounts', ownerName: 'CanvasTTY Accounts', id: 'glm-plan', label: 'GLM plan', protocol: 'openai', origin: 'https://api.z.ai', paths: ['/chat/completions', '/models'], models: ['glm-4.6'], flatRate: true };

const sse = frames => frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';

/**
 * CanvasTTY's side, faked: `answer(params)` decides each request — `{ refuse: reason }`, `{ status, chunks }` (2xx,
 * streamed), `{ upstream: status, retryAfter }`, `{ network: true }` or `{ hang: true }`.
 */
function fakeCore({ unsupported = false, accounts = [ACCOUNT], answer = () => ({ status: 200, chunks: [sse([{ choices: [{ delta: { content: 'hi' } }] }])] }) } = {}) {
  const calls = [];
  let broker = null;
  const notify = (kind, params) => setImmediate(() => broker.notification(kind, params));
  const host = {
    callHost: async (method, params) => {
      calls.push({ method, params: structuredClone(params) });
      if (unsupported) throw Object.assign(new Error(`Unknown host method: ${method}.`), { code: -32601 });
      if (method === 'accounts.list') return { accounts };
      if (method === 'accounts.body') return { received: params.data.length };
      if (method === 'accounts.cancel') { notify('end', { requestId: params.requestId, status: 0, usage: { input: 0, output: 0, cached: 0 }, error: { reason: 'cancelled', message: 'cancelled' } }); return { cancelled: true }; }
      if (method === 'accounts.request') {
        const plan = answer(params);
        if (plan.refuse) throw Object.assign(new Error(`${plan.refuse}: refused`), { code: -32000, data: { reason: plan.refuse } });
        const { requestId } = params;
        setImmediate(() => {
          if (plan.network) return notify('end', { requestId, status: 0, usage: { input: 0, output: 0, cached: 0 }, error: { reason: 'network', message: 'connect failed' } });
          if (plan.upstream) return notify('end', { requestId, status: plan.upstream, usage: { input: 0, output: 0, cached: 0 }, error: { reason: 'upstream', status: plan.upstream, ...(plan.retryAfter ? { retryAfter: plan.retryAfter } : {}), message: 'plan limit' } });
          notify('head', { requestId, status: plan.status, contentType: 'text/event-stream' });
          if (plan.hang) { notify('chunk', { requestId, data: plan.chunks?.[0] ?? ': ping\n\n' }); return; }
          for (const data of plan.chunks) notify('chunk', { requestId, data });
          notify('end', { requestId, status: plan.status, usage: { input: 3, output: 2, cached: 0 } });
        });
        return { requestId, accepted: true };
      }
      throw new Error(`host: ${method} not allowed`);
    },
    log: () => undefined,
    emit: () => undefined
  };
  return { host, calls, attach: value => { broker = value; } };
}

test('settings: an account upstream names its account, takes no key, keeps the OpenRouter rule and the D3 rule', () => {
  const upstream = validateAutoUpstream({ id: 'acc-glm', preset: 'account', account: REF, baseUrl: 'https://api.z.ai', trust: 'D1', key: 'own', models: [{ id: 'glm-4.6' }], enabled: true, flatRate: true });
  assert.equal(upstream.key, 'none', 'the key stays with the other extension');
  assert.equal(upstream.account, REF);
  assert.equal(upstream.flatRate, true);
  assert.throws(() => validateAutoUpstream({ id: 'acc-x', preset: 'account', baseUrl: 'https://api.z.ai', trust: 'D1', models: [], enabled: true }), /names one account/);
  assert.throws(() => validateAutoUpstream({ id: 'x', preset: 'openai-compatible', account: REF, baseUrl: 'https://api.z.ai', trust: 'D1', models: [], enabled: true }), /names one account/);
  assert.throws(() => validateAutoUpstream({ id: 'acc-or', preset: 'account', account: REF, baseUrl: 'https://openrouter.ai', trust: 'D1', models: [], enabled: true }), /OpenRouter/);
  assert.throws(() => validateAutoUpstream({ id: 'acc-d3', preset: 'account', account: REF, baseUrl: 'https://api.z.ai', trust: 'D3', models: [], enabled: true }), /D3 stays on this computer/);
  // The page's "Use in Auto" makes exactly such an upstream.
  const made = accountUpstream(ACCOUNT, []);
  assert.deepEqual(validateAutoUpstream(made), made);
  assert.equal(made.trust, 'D1');
  // A flat-rate plan costs nothing per token in the inventory.
  const settings = validateAutoSettings({ upstreams: [made], preference: 'balanced', cheaperFallback: false, decider: 'rules', dailyUsdCap: 1, perCardUsdCap: 0.5 });
  const [entry] = buildInventory(settings, NO_CATALOG).entries;
  assert.deepEqual([entry.priceIn, entry.priceOut, entry.priceSource], [0, 0, 'plan']);
  assert.equal(brokeredAccountOf({ ...ACCOUNT, origin: 'https://api.z.ai/path' }), null);
  assert.equal(brokeredAccountOf({ ...ACCOUNT, secretKey: 'key.x' }).ref, REF, 'extra fields are not kept');
  assert.equal('secretKey' in brokeredAccountOf({ ...ACCOUNT, secretKey: 'key.x' }), false);
});

test('broker client: an older core is detected once and asked again only after a rest', async () => {
  let now = 1_000;
  const core = fakeCore({ unsupported: true });
  const broker = new AccountBroker(core.host, { now: () => now });
  core.attach(broker);
  assert.deepEqual(await broker.list(), []);
  assert.equal(broker.mode, 'unsupported');
  assert.deepEqual(await broker.list(), []);
  now += 60_000;
  await broker.list();
  assert.equal(core.calls.length, 1, 'not asked again within 30 minutes');
  const answer = await broker.send(REF, '/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'glm-4.6' }) });
  assert.equal(answer.status, 503);
  assert.equal(core.calls.length, 1, 'nothing is sent on a core without brokered requests');
});

test('broker client: a streamed answer, refusals as statuses, upstream errors with Retry-After, cancel, bodies in parts', async () => {
  let plan = { status: 200, chunks: ['data: {"a":1}\n\n', 'data: [DONE]\n\n'] };
  const core = fakeCore({ answer: () => plan });
  const broker = new AccountBroker(core.host);
  core.attach(broker);
  assert.deepEqual((await broker.list()).map(account => account.ref), [REF]);
  assert.equal(broker.known(REF).flatRate, true);

  const ok = await broker.send(REF, '/chat/completions', { method: 'POST', body: Buffer.from(JSON.stringify({ model: 'glm-4.6', stream: true })) });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'text/event-stream');
  assert.equal(await ok.text(), 'data: {"a":1}\n\ndata: [DONE]\n\n');
  const sent = core.calls.find(call => call.method === 'accounts.request').params;
  assert.deepEqual(Object.keys(sent).sort(), ['body', 'path', 'ref', 'requestId', 'stream']);
  assert.equal(sent.stream, true);

  for (const [reason, status] of [['budget_refused', 429], ['rate_limited', 429], ['not_granted', 403], ['grant_changed', 403], ['model_refused', 404], ['owner_unavailable', 503], ['too_large', 413]]) {
    plan = { refuse: reason };
    const answer = await broker.send(REF, '/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'glm-4.6' }) });
    assert.equal(answer.status, status, reason);
  }
  plan = { upstream: 429, retryAfter: 42 };
  const limited = await broker.send(REF, '/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'glm-4.6' }) });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '42');
  plan = { network: true };
  await assert.rejects(broker.send(REF, '/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'glm-4.6' }) }), /network/);

  plan = { status: 200, hang: true, chunks: ['data: {"b":1}\n\n'] };
  const controller = new AbortController();
  const hanging = await broker.send(REF, '/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'glm-4.6', stream: true }), signal: controller.signal });
  const reader = hanging.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /"b":1/);
  controller.abort();
  await assert.rejects(reader.read());
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(core.calls.some(call => call.method === 'accounts.cancel'), 'the host is told to cancel');

  plan = { status: 200, chunks: ['data: [DONE]\n\n'] };
  const big = JSON.stringify({ model: 'glm-4.6', messages: [{ role: 'user', content: 'x'.repeat(1_200_000) }] });
  await (await broker.send(REF, '/chat/completions', { method: 'POST', body: big })).text();
  const parts = core.calls.filter(call => call.method === 'accounts.body');
  assert.ok(parts.length >= 3);
  assert.equal(parts.map(call => call.params.data).join(''), big);
  assert.equal(core.calls.at(-1).params.body, undefined, 'the request names the parts, not the body');
});

async function routerWith(t, { core, upstreams, timeouts = {} }) {
  const settings = validateAutoSettings({ upstreams, preference: 'balanced', cheaperFallback: false, decider: 'rules', dailyUsdCap: 1, perCardUsdCap: 0.5 });
  const broker = new AccountBroker(core.host);
  core.attach(broker);
  const fetched = [];
  const router = new AutoRouter({
    directory: mkdtempSync(join(base, 'data-')),
    settings: () => settings,
    inventory: () => buildInventory(settings, NO_CATALOG),
    dataClassMode: () => 'strict',
    key: async () => 'up-key',
    broker: {
      send: (upstream, path, init) => broker.send(upstream.account, path, init),
      ready: upstream => !!broker.known(upstream.account),
      refresh: async () => { await broker.list(); }
    },
    transport: async (url, init) => { fetched.push(url); return fetch(url, init); },
    timeouts: { jevMs: 200, headersMs: 1_000, firstChunkMs: 1_000, idleMs: 1_000, ...timeouts }
  });
  t.after(() => router.stop());
  const { token, port } = await router.grant({ sessionId: 'card-0001-aaaa', provider: 'opencode', role: 'agent', parentSessionId: null, dataClass: 'D1' });
  return { router, token, port, fetched, broker };
}

function call(port, token, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', agent: false, headers: {
      host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': payload.length
    } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const turn = (extra = {}) => ({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'fix the bug in parser.ts' }], ...extra });

test('router: an account upstream answers through the broker, never through fetch', async (t) => {
  const core = fakeCore({ answer: () => ({ status: 200, chunks: [sse([{ choices: [{ delta: { content: 'from the plan' } }] }, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } }])] }) });
  const { token, port, fetched } = await routerWith(t, { core, upstreams: [accountUpstream(ACCOUNT, [])] });
  const answer = await call(port, token, turn());
  assert.equal(answer.status, 200);
  assert.match(answer.text, /from the plan/);
  assert.deepEqual(fetched, [], 'no direct HTTP call');
  const sent = core.calls.find(entry => entry.method === 'accounts.request').params;
  assert.equal(sent.ref, REF);
  assert.equal(sent.path, '/chat/completions');
  assert.equal(sent.body.model, 'glm-4.6');
  assert.equal(JSON.stringify(core.calls).includes('up-key'), false, 'the router sends the broker no key');
});

test('router: a used-up plan (owner veto) or a 429 fails over to the next upstream; an account not listed is skipped', async (t) => {
  const direct = await startFakeUpstream({ behaviours: { 'vendor/medium': 'stream' } });
  t.after(() => direct.close());
  let plan = { refuse: 'budget_refused' };
  const core = fakeCore({ answer: () => plan });
  const upstreams = [
    { ...accountUpstream(ACCOUNT, []), models: [{ id: 'glm-4.6', tier: 'medium' }] },
    { id: 'direct', preset: 'openai-compatible', baseUrl: direct.url, trust: 'D2', key: 'own', enabled: true, models: [{ id: 'vendor/medium', tier: 'medium', priceIn: 1, priceOut: 2 }] }
  ];
  const { token, port, fetched, router } = await routerWith(t, { core, upstreams });
  const first = await call(port, token, turn());
  assert.equal(first.status, 200);
  assert.equal(fetched.length, 1, 'the direct upstream answered after the plan refused');
  assert.equal(core.calls.filter(entry => entry.method === 'accounts.request').length, 1);
  // The plan cools down like a 429 quota: the next turn goes straight to the direct upstream.
  plan = { status: 200, chunks: [sse([{ choices: [{ delta: { content: 'x' } }] }])] };
  await call(port, token, turn({ messages: [{ role: 'user', content: 'another task entirely' }] }));
  assert.equal(core.calls.filter(entry => entry.method === 'accounts.request').length, 1, 'cooling down');
  void router;
});

test('router: with no listed account and no other upstream the card gets the no-provider answer', async (t) => {
  const core = fakeCore({ accounts: [] });
  const { token, port, fetched } = await routerWith(t, { core, upstreams: [accountUpstream(ACCOUNT, [])] });
  const answer = await call(port, token, turn());
  assert.equal(answer.status, 503);
  assert.deepEqual(fetched, []);
  assert.equal(core.calls.filter(entry => entry.method === 'accounts.request').length, 0);
});
