// Live run 17 (2026-10-21) follow-ups, with fixtures shaped like that profile: Accounts shares its routes through
// plugins.request (glm-flash and glm-53 on the Z.AI Coding Plan with keys, two MiniMax accounts without), every CLI's
// own sign-in is set to Never, and only OpenCode is installed. No model, no network, fake HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouteService, droppedReasons } from '../src/route/service.ts';
import { AccountsFeed, ProvidersFeed, unreadQuota } from '../src/route/peers.ts';
import { UsageMeter } from '../src/route/usage.ts';
import { DEFAULT_ROUTE_SETTINGS } from '../src/route/settings.ts';
import { Assistant } from '../src/service/assistant.ts';
import { buildTree } from '../src/tree/agentTree.ts';
import { catalog, index, providers } from './helpers/route-fixtures.mjs';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'canvastty-run17-')));
process.on('exit', () => rmSync(base, { recursive: true, force: true }));
const ACCOUNTS = 'canvastty-accounts';
const CLIS = ['claude', 'codex', 'grok', 'kimi', 'qwen', 'opencode', 'hermes'];

const quotaOf = (observed, percent = 99) => observed
  ? { state: 'ok', remainingPercent: percent, window: '5h', resetsAt: '2026-10-22T00:00:13.709Z', source: 'zai-quota-api', observedAt: '2026-10-21T21:28:30.107Z', ageMinutes: 0, confidence: 'exact', launchesSinceRead: 0, note: `5h: ${percent}% left` }
  : { state: 'unknown', remainingPercent: null, window: null, resetsAt: null, source: null, observedAt: null, ageMinutes: null, confidence: 'none', launchesSinceRead: 0, note: 'not read yet' };
/** Accounts' accounts.routes answer in run 17 (no keys: hosts, account ids and labels only). */
const routesAnswer = (observed = true) => ({
  at: new Date().toISOString(),
  routes: [
    { provider: 'opencode', agent: 'OpenCode', accountId: 'glm-flash', account: 'GLM 5.3 Flash · Z.AI Coding Plan (acceptance)', kind: 'api-key', model: 'glm-5.3-flash', endpoint: 'api.z.ai', state: 'ready', launchOptions: { [ACCOUNTS]: { account: 'glm-flash', effort: 'default', trustFolder: false } }, quota: quotaOf(observed) },
    { provider: 'opencode', agent: 'OpenCode', accountId: 'glm-53', account: 'GLM 5.3 · Z.AI Coding Plan (acceptance)', kind: 'api-key', model: 'glm-5.3', endpoint: 'api.z.ai', state: 'ready', launchOptions: { [ACCOUNTS]: { account: 'glm-53', effort: 'default', trustFolder: false } }, quota: quotaOf(observed) },
    { provider: 'opencode', agent: 'OpenCode', accountId: 'minimax-m3', account: 'MiniMax M3 · MiniMax API (acceptance)', kind: 'api-key', model: 'MiniMax-M3', endpoint: 'api.minimax.io', state: 'no-key', reason: 'no key is saved for it (Accounts settings)' },
    { provider: 'opencode', agent: 'OpenCode', accountId: 'minimax-fast', account: 'MiniMax M2.7 highspeed · MiniMax API (acceptance)', kind: 'api-key', model: 'MiniMax-M2.7-highspeed', endpoint: 'api.minimax.io', state: 'no-key', reason: 'no key is saved for it (Accounts settings)' }
  ],
  pools: [], defaultSignIns: []
});
const quotaAnswer = (observed = true) => ({
  at: new Date().toISOString(),
  accounts: [
    { accountId: 'glm-flash', account: 'GLM 5.3 Flash · Z.AI Coding Plan (acceptance)', kind: 'model-account', agents: ['opencode'], quota: quotaOf(observed) },
    { accountId: 'glm-53', account: 'GLM 5.3 · Z.AI Coding Plan (acceptance)', kind: 'model-account', agents: ['opencode'], quota: quotaOf(observed) },
    { accountId: 'minimax-m3', account: 'MiniMax M3 · MiniMax API (acceptance)', kind: 'model-account', agents: ['opencode'] }
  ],
  poolAccounts: [], pools: [], defaultSignIns: []
});
/** Run 17's limits: every CLI but OpenCode not found, OpenCode's own needs a subscription. */
const limits = () => ({ providers: ['codex', 'claude', 'qwen', 'kimi', 'opencode', 'grok'].map(provider => ({ provider, state: 'unavailable', reason: provider === 'opencode' ? 'subscription-required' : 'cli-not-found', fetchedAt: Date.now(), windows: [] })) });

/** A host like run 17's core: plugins.request (approved), providers.list (only OpenCode installed), limits.get. */
function host({ observedAfter = 0 } = {}) {
  const calls = [];
  let routesRead = 0;
  return {
    calls,
    callHost: async (method, params) => {
      calls.push({ method, params });
      if (method === 'plugins.request') {
        if (params.method === 'accounts.routes') routesRead++;
        // Accounts reads the quota only after a routes read asked for it (its quota.demand), and not at once.
        const observed = routesRead > observedAfter;
        return { plugin: ACCOUNTS, method: params.method, dataClass: 'D1', data: params.method === 'accounts.routes' ? routesAnswer(observed) : quotaAnswer(observed) };
      }
      if (method === 'providers.list') return { providers: providers({ installed: ['opencode'] }) };
      if (method === 'limits.subscribe') return { state: 'loading' };
      if (method === 'limits.get') return limits();
      if (method === 'storage.get') return null;
      if (method === 'storage.set') return null;
      if (method === 'usage.session' || method === 'usage.summary') throw Object.assign(new Error('Unknown host method'), { code: -32601 });
      throw Object.assign(new Error(`Unknown host method: ${method}.`), { code: -32601 });
    },
    log() {}, emit(event) { calls.push({ method: `emit:${event}` }); }
  };
}

const neverOwn = () => ({ ...structuredClone(DEFAULT_ROUTE_SETTINGS), plans: [], allow: Object.fromEntries(CLIS.map(cli => [`cli:${cli}`, 'never'])) });

function route(h, type) {
  return new RouteService({
    host: h, dataDir: mkdtempSync(join(base, 'data-')), saved: neverOwn(), enabled: () => true,
    classify: async () => ({ difficulty: 'trivial', strong: false, type, confidence: 0.9 }),
    catalog: () => ({ catalog: catalog(), index: index() }), preference: () => 'balanced',
    autoExpectation: async () => null, cardClass: () => 'D1', dataClassMode: () => 'warn',
    accounts: new AccountsFeed(h), providersFeed: new ProvidersFeed(h), usage: new UsageMeter(h)
  });
}
const orch = { id: 'c11e2af6-50e0-4a78-a9dc-141aaac5ea8f', provider: 'opencode', role: 'orchestrator', title: 'Auto (Jev)', status: 'working', cwd: base, workingDirectory: base };
const lastJson = answer => JSON.parse(String(answer.content).split('\n').at(-1));
const PART_T = 'Part T: In two sentences explain what a Bloom filter is for and its main trade-off. No tools; answer as text only.';

test('run 17 pick_route: a writing part routes to a ready GLM account; the benchmark is chosen among usable routes only, not a key-less MiniMax account\'s', async () => {
  for (const type of ['writing', 'chat', 'research', 'coding', 'review']) {
    const answer = await route(host(), type).tool('pick_route', orch, { task: PART_T, cwd: base });
    assert.doesNotMatch(String(answer.content), /No route is usable now/u, `${type}: ${answer.content}`);
    const spawn = lastJson(answer).spawn;
    assert.equal(spawn.provider, 'opencode', type);
    assert.ok(['glm-flash', 'glm-53'].includes(spawn.launchOptions[ACCOUNTS].account), `${type}: ${JSON.stringify(spawn)}`);
  }
});

test('run 17 pick_route: when nothing is usable, every ready account left out is named first, the CLIs not installed share a line', async () => {
  const lines = droppedReasons([
    { key: 'a', cli: 'opencode', label: 'MiniMax', model: 'MiniMax-M3', reason: 'account no-key: no key is saved for it (Accounts settings)' },
    ...['codex', 'claude', 'qwen', 'kimi', 'hermes', 'grok'].map(cli => ({ key: cli, cli, label: 'its own sign-in', model: null, reason: 'its CLI is not installed or not available' })),
    { key: 'g1', cli: 'opencode', label: 'GLM', model: 'glm-5.3-flash', reason: 'no measured score for this model (pin or boost it, or turn on new models)' },
    { key: 'g2', cli: 'opencode', label: 'GLM', model: 'glm-5.3', reason: 'no measured score for this model (pin or boost it, or turn on new models)' }
  ], 6);
  assert.deepEqual(lines, [
    'opencode glm-5.3-flash: no measured score for this model (pin or boost it, or turn on new models)',
    'opencode glm-5.3: no measured score for this model (pin or boost it, or turn on new models)',
    'opencode MiniMax-M3: account no-key: no key is saved for it (Accounts settings)',
    'codex, claude, qwen, kimi, hermes, grok: its CLI is not installed or not available'
  ]);
  const many = droppedReasons(Array.from({ length: 9 }, (_, i) => ({ key: String(i), cli: 'opencode', label: 'x', model: `m${i}`, reason: 'account no-key' })), 4);
  assert.deepEqual(many.at(-1), 'and 6 more');
  assert.equal(many.length, 4);
});

test('run 17 quota: Accounts\' routes and quota are read at service start and again when the page first opens, not "not read yet" until something routes', async () => {
  // AccountsFeed.warm: routes (Accounts reads its quota on that demand), quota; once more while one is unread.
  const h = host({ observedAfter: 1 });
  const feed = new AccountsFeed(h);
  const waits = [];
  const warm = await feed.warm(2_500, async ms => { waits.push(ms); });
  assert.deepEqual(warm, { routes: true, quota: true, unread: 0 });
  assert.deepEqual(waits, [2_500], 'one more round after the first read found unread quota');
  assert.equal(h.calls.filter(call => call.params?.method === 'accounts.routes').length, 2);
  assert.equal(h.calls.filter(call => call.params?.method === 'accounts.quota').length, 2);
  assert.equal(unreadQuota(quotaAnswer(false)), 2, 'MiniMax (no quota field) is not counted');
  assert.equal(unreadQuota(quotaAnswer(true)), 0);
  // Already read: one round.
  const once = new AccountsFeed(host());
  const noWait = [];
  await once.warm(2_500, async ms => { noWait.push(ms); });
  assert.deepEqual(noWait, []);

  // The service: warmReads (as at start) fills the routing view; the first route.state-like call reads once more.
  const sh = host();
  const assistant = new Assistant({ host: sh, dataDir: mkdtempSync(join(base, 'svc-')), git: null, locale: 'en', routing: neverOwn(), harness: { routing: true, loopAlerts: true, flows: true } });
  assert.equal(assistant.routing.state().accounts, null, 'nothing read before');
  await assistant.warmReads();
  const state = assistant.routing.state();
  assert.deepEqual(state.accounts.rows.map(row => [row.accountId, row.state, row.quota?.remainingPercent ?? null]), [['glm-flash', 'ready', 99], ['glm-53', 'ready', 99], ['minimax-m3', 'no-key', null], ['minimax-fast', 'no-key', null]]);
  assert.equal(assistant.accounts.state().mode, 'ready');
  assert.ok(assistant.accounts.state().quotaAt, 'accounts.quota read');
  assert.ok(sh.calls.some(call => call.method === 'limits.get'), 'limits.get read');
  const before = sh.calls.length;
  assistant.pageOpened();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(sh.calls.slice(before).some(call => call.params?.method === 'accounts.quota'), 'first page open: read again');
  assert.ok(sh.calls.some(call => call.method === 'emit:settings'), 'the page is told to reload');
  const after = sh.calls.length;
  assistant.pageOpened();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sh.calls.length, after, 'only the first page open');
  assistant.limitsFeed.stop();
});

test('run 17 agent tree: refused launches are not agents and not planned parts; they are counted apart', () => {
  const now = Date.now();
  const card = (id, role, status, parent) => ({ id, provider: 'opencode', role, ...(parent ? { parentSessionId: parent } : {}), title: id, status, exitCode: null, startedAt: now });
  const view = buildTree({
    cards: [card('orch', 'orchestrator', 'working'), card('c', 'subagent', 'idle', 'orch'), card('t', 'subagent', 'idle', 'orch'), card('x', 'subagent', 'failed', 'orch')],
    route: id => id === 'orch' ? { model: 'glm-5.3', identity: 'glm-5-3', kind: 'account', label: 'GLM 5.3 · Z.AI Coding Plan (acceptance) · api.z.ai', costBasis: 'flat', estimate: { kind: 'flat' } } : null,
    task: () => null, planChildren: id => id === 'orch' ? 3 : null, endedAt: () => null, refused: id => id === 'x'
  });
  const { root, totals } = view.trees[0];
  assert.equal(root.model, 'GLM-5.3');
  assert.deepEqual(root.cost, { kind: 'flat', label: 'GLM 5.3 · Z.AI Coding Plan (acceptance) · api.z.ai' });
  assert.deepEqual([root.children.map(child => child.id), root.refused, root.descendants, root.planChildren], [['c', 't'], 1, 2, 3]);
  assert.deepEqual([totals.agents, totals.refused], [3, 1]);
  // Without the input (an older service): as before.
  const old = buildTree({ cards: [card('orch', 'orchestrator', 'working'), card('x', 'subagent', 'failed', 'orch')], route: () => null, task: () => null, planChildren: () => 3, endedAt: () => null });
  assert.deepEqual([old.trees[0].root.children.length, old.trees[0].root.refused, old.trees[0].totals.agents], [1, 0, 2]);
});
