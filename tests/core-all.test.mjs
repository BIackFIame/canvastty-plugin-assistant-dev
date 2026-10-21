// What the Assistant reads itself on a CanvasTTY that lets services read it (each feature-detected, with the old path
// kept): Accounts' routes, pools and quota through plugins.request (after the person approved the pair; refused
// before), providers.list for routing and "Start with Auto (Jev)", measured usage instead of ~2 % per launch (and in
// the agent tree), limit.exhausted resting a CLI's own sign-in, and the person's servers for subagents by name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RouteService } from '../src/route/service.ts';
import { AccountsFeed, ProvidersFeed, poolRoutesFrom, sharedReadReason } from '../src/route/peers.ts';
import { UsageMeter, effectiveTokens, measuredUsd } from '../src/route/usage.ts';
import { quotaOf, PER_LAUNCH_PERCENT } from '../src/route/limits.ts';
import { buildTree, measuredCost } from '../src/tree/agentTree.ts';
import { accountRows, catalog, declared, index, limitsAnswer, NOW, providers } from './helpers/route-fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = realpathSync(mkdtempSync(join(tmpdir(), 'canvastty-core-all-')));
process.on('exit', () => rmSync(base, { recursive: true, force: true }));

/** Accounts' accounts.routes answer: model accounts, pool members and pools (no keys). */
function sharedRoutes({ ready = 2 } = {}) {
  return {
    routes: [
      ...accountRows().slice(0, 3),
      { provider: 'claude', agent: 'Claude Code', accountId: 'claude-work', account: 'Work', kind: 'subscription', model: 'the account\'s own models', endpoint: 'Claude Code sign-in on this computer', state: 'ready', launchOptions: { 'canvastty-accounts': { account: 'sub:claude-work', effort: 'default', trustFolder: false } } }
    ],
    pools: [{ agent: 'claude', label: 'Claude Code pool', members: 3, ready, best: { state: 'ok', remainingPercent: 80, window: '5 h', resetsAt: new Date(NOW + 3_600_000).toISOString(), observedAt: new Date(NOW - 60_000).toISOString(), source: 'canvastty-limits', confidence: 'exact', note: '' }, trust: 'D2' }]
  };
}

/** A host whose answers the test sets per method; a missing method answers like an older core. */
function host(handlers = {}) {
  const calls = [];
  return {
    calls,
    callHost: async (method, params) => {
      calls.push({ method, params });
      const handler = handlers[method];
      if (!handler) throw Object.assign(new Error(`Unknown host method: ${method}.`), { code: -32601 });
      return handler(params);
    },
    log() {}, emit() {}
  };
}

function service(h, extra = {}) {
  let now = NOW;
  const route = new RouteService({
    host: h, dataDir: mkdtempSync(join(base, 'data-')), saved: declared({ plans: declared().plans.filter(plan => plan.id !== 'glm-plan') }), enabled: () => true,
    classify: async () => ({ difficulty: 'normal', strong: false, type: 'research', confidence: 0.2 }),
    catalog: () => ({ catalog: catalog(), index: index() }), preference: () => 'balanced',
    autoExpectation: async () => null, cardClass: () => 'D1', dataClassMode: () => 'warn', now: () => now, random: () => 0.5,
    accounts: new AccountsFeed(h, () => now), providersFeed: new ProvidersFeed(h, () => now), usage: new UsageMeter(h, () => now), ...extra
  });
  route.receiveLimits(limitsAnswer());
  return { route, tick: ms => { now += ms; } };
}
const orch = { id: 'orch-core-all-1', provider: 'claude', role: 'orchestrator', title: 'Lead', status: 'working', cwd: base, workingDirectory: base };
const lastJson = answer => JSON.parse(answer.content.split('\n').at(-1));
const notApproved = () => { throw Object.assign(new Error('not_approved: The person has not approved this plugin reading that data.'), { code: -32000, data: { reason: 'not_approved' } }); };

test('Accounts through plugins.request: refused before the person approves (rows the orchestrator passed still count), Accounts\' own answer after', async () => {
  let approved = false;
  const h = host({ 'plugins.request': params => {
    assert.equal(params.plugin, 'canvastty-accounts');
    if (!approved) notApproved();
    return { plugin: 'canvastty-accounts', method: params.method, dataClass: 'D1', data: params.method === 'accounts.routes' ? sharedRoutes() : { accounts: [] } };
  } });
  const { route, tick } = service(h);
  const before = await route.tool('pick_route', orch, { task: 'Explain the cache layer', providers: providers(), accountRoutes: accountRows(), prefer: 'zai-glm' });
  assert.equal(lastJson(before).spawn.launchOptions['canvastty-accounts'].account, 'zai-glm', 'refused: the passed rows still route');
  const feed = route['options'].accounts.state();
  assert.equal(feed.mode, 'refused');
  assert.equal(feed.reason, 'not_approved');
  // Refused reads are asked again only after a minute, not on every route.
  const asked = h.calls.filter(call => call.method === 'plugins.request').length;
  await route.tool('pick_route', orch, { task: 'Explain the cache layer', providers: providers() });
  assert.equal(h.calls.filter(call => call.method === 'plugins.request').length, asked);

  approved = true;
  tick(61_000);
  // Accounts' own rows replace what an orchestrator passes (an account it does not list is not offered).
  const after = await route.tool('pick_route', orch, { task: 'Explain the cache layer', providers: providers(), accountRoutes: [{ ...accountRows()[0], accountId: 'stale-row' }], prefer: 'or-opus' });
  assert.equal(route['options'].accounts.state().mode, 'ready');
  assert.equal(lastJson(after).spawn.launchOptions['canvastty-accounts'].account, 'or-opus');
  assert.equal(after.content.includes('stale-row'), false);
  assert.equal(route.state().accounts.rows.some(row => row.accountId === 'claude-work'), false, 'pool members are not model account rows');
  assert.equal(route.state().pools.pools[0].cli, 'claude');
});

test('pools: Accounts\' pool:<agent> is a subscription route with the pool\'s own quota, not the default login\'s', async () => {
  const h = host({ 'plugins.request': () => ({ data: sharedRoutes() }) });
  // The default login is used up; the pool has room.
  const { route } = service(h);
  route.receiveLimits(limitsAnswer({ claude: 99, claudeWeekly: 99 }));
  const answer = await route.tool('route', orch, { task: 'Explain the cache layer', providers: providers(), prefer: 'claude' });
  const json = lastJson(answer);
  const all = [json, ...json.alternatives];
  const pool = all.find(entry => entry.spawn.launchOptions['canvastty-accounts']?.account === 'pool:claude');
  assert.ok(pool, `the pool is offered: ${answer.content}`);
  assert.equal(pool.route?.kind ?? pool.kind, 'subscription');
  assert.equal(pool.spawn.provider, 'claude');
  assert.ok(['opus', 'sonnet'].includes(pool.spawn.model), 'the declared Claude plan names its models');
  assert.equal(all.some(entry => entry.spawn.provider === 'claude' && entry.spawn.launchOptions['canvastty-accounts']?.account === 'none'), false, 'the used-up default login is not');
  // No free member: the pool is not offered.
  const full = service(host({ 'plugins.request': () => ({ data: sharedRoutes({ ready: 0 }) }) })).route;
  full.receiveLimits(limitsAnswer({ claude: 99, claudeWeekly: 99 }));
  const none = await full.tool('route', orch, { task: 'Explain the cache layer', providers: providers(), prefer: 'claude' });
  assert.equal(none.content.includes('pool:claude'), false);
  assert.deepEqual(poolRoutesFrom({ pools: [{ agent: 'Bad Agent!' }, { agent: 'codex', members: 'x', ready: -1 }] }).map(pool => [pool.cli, pool.members, pool.ready]), [['codex', 0, 0]]);
});

test('providers.list: routing without an orchestrator\'s list, and "Start with Auto (Jev)" offers only installed, signed-in CLIs plus Accounts\' accounts and pools', async () => {
  const listed = providers({ installed: ['claude', 'opencode'], signIn: { claude: 'ok' } });
  const h = host({ 'providers.list': () => ({ providers: listed, note: 'x' }), 'plugins.request': () => ({ data: sharedRoutes() }) });
  const { route } = service(h);
  const answer = await route.tool('pick_route', orch, { task: 'Explain the cache layer' });
  assert.notEqual(answer.isError, true);
  assert.notEqual(lastJson(answer).spawn.provider, 'codex', 'codex is not installed here');
  const { candidates } = await route.orchestratorRoutes({ type: 'coding', level: 'large', difficulty: 'hard', strong: true, confidence: 0.5, typeFrom: 'rules' }, 'D1');
  assert.ok(candidates.length);
  assert.equal(candidates.some(c => c.cli === 'codex'), false, 'a declared plan on a CLI CanvasTTY does not list is not offered');
  assert.ok(candidates.some(c => c.spawn.launchOptions['canvastty-accounts']?.account === 'pool:claude'), 'the pool is a candidate');
  assert.ok(candidates.some(c => c.kind === 'account'), 'Accounts\' model accounts are candidates without an orchestrator having listed them');
  // An older core: no providers.list, no shared reads: the declared plans, as before.
  const old = service(host({})).route;
  const legacy = await old.orchestratorRoutes({ type: 'coding', level: 'large', difficulty: 'hard', strong: true, confidence: 0.5, typeFrom: 'rules' }, 'D1');
  assert.ok(legacy.candidates.some(c => c.cli === 'codex'));
});

test('measured usage replaces ~2 % per launch; an older core keeps the estimate', async () => {
  const limits = limitsAnswer().snapshot.providers.find(entry => entry.provider === 'claude');
  const parsed = { ...limits, reason: null, windows: limits.windows.map(w => ({ ...w, label: w.label })) };
  const estimated = quotaOf(parsed, 20, NOW, 3);
  assert.match(estimated.note, /3 routed launch\(es\) since the read counted as ~6%/u);
  const measured = quotaOf(parsed, 20, NOW, 3, { tokens: 120_000, percent: 1.5 });
  assert.match(measured.note, /120,000 tokens measured since the read counted as ~1.5%/u);
  assert.equal(Math.round((measured.headroom - estimated.headroom) * 10) / 10, 3 * PER_LAUNCH_PERCENT - 1.5);

  let summaries = 0;
  const h = host({ 'usage.summary': params => { summaries++; assert.deepEqual(params.groupBy, ['provider']); return { since: params.since, until: NOW, groupBy: ['provider'], totals: {}, rows: [{ provider: 'claude', input: 500_000, cached: 400_000, output: 20_000, events: 9, sessions: 2 }], truncated: false, coverage: { collectedAt: NOW, complete: true } }; } });
  const { route } = service(h);
  const answer = await route.tool('route', orch, { task: 'Explain the cache layer', providers: providers(), prefer: 'claude' });
  assert.match(answer.content, /headroom 34\.\d+% above the reserve/u, 'the measured share comes off the headroom');
  assert.match(route.state().plans.find(plan => plan.id === 'claude-max').quota.note, /tokens measured since the read counted as/u);
  assert.ok(summaries >= 1);
  // Counted once per read time, cached 30 s.
  await route.tool('route', orch, { task: 'Explain the cache layer again', providers: providers(), prefer: 'claude' });
  assert.equal(summaries, 1);
  const old = service(host({})).route;
  const legacy = await old.tool('route', orch, { task: 'Explain the cache layer', providers: providers(), prefer: 'claude' });
  assert.match(legacy.content, /headroom 39% above the reserve/u);
  assert.doesNotMatch(old.state().plans.find(plan => plan.id === 'claude-max').quota.note, /tokens measured/u);
  assert.equal(effectiveTokens({ input: 1000, cached: 500, output: 100, events: 1 }), 650);
  assert.equal(measuredUsd({ input: 1_000_000, cached: 0, output: 1_000_000, events: 1 }, { priceIn: 1, priceOut: 3 }), 4);
});

test('limit.exhausted (provider-wide): that CLI\'s own sign-in rests until the reset; pools and accounts keep running; malformed events change nothing', async () => {
  const h = host({ 'plugins.request': () => ({ data: sharedRoutes() }) });
  const { route } = service(h);
  assert.equal(route.limitExhausted({ type: 'limit.exhausted', provider: 'claude', accountId: 'someone', at: NOW }), false);
  assert.equal(route.limitExhausted({ type: 'other', provider: 'claude' }), false);
  assert.equal(route.limitExhausted({ type: 'limit.exhausted', provider: 'Claude Code!' }), false);
  assert.equal(route.limitExhausted({ type: 'limit.exhausted', at: NOW, provider: 'claude', accountId: 'default', window: { id: 'claude:five_hour', label: '5h', windowMinutes: 300 }, resetAt: NOW + 2 * 3_600_000 }), true);
  const state = route.state();
  const rests = state.cooldowns.map(entry => entry.signIn).sort();
  assert.deepEqual(rests, ['cli:claude', 'plan:claude-max']);
  assert.equal(state.cooldowns[0].until, NOW + 2 * 3_600_000);
  assert.ok(state.quotaEvents.some(event => event.kind === 'exhausted' && event.provider === 'claude'));
  const answer = await route.tool('route', orch, { task: 'Explain the cache layer', providers: providers(), prefer: 'claude' });
  const json = lastJson(answer);
  const all = [json, ...json.alternatives];
  assert.equal(all.some(entry => entry.spawn.provider === 'claude' && entry.spawn.launchOptions['canvastty-accounts']?.account === 'none'), false);
  assert.ok(all.some(entry => entry.spawn.launchOptions['canvastty-accounts']?.account === 'pool:claude'), 'the pool is another sign-in');
});

test('servers on: the person\'s declared servers that CanvasTTY offers subagents (by name) come with the route; off, or not offered, nothing', async () => {
  const environments = [{ pluginId: 'canvastty-environments', plugin: 'Environments', kind: 'ssh-host', name: 'SSH host', providers: ['claude', 'codex'], options: [{ key: 'host', kind: 'select' }], maxParallel: 2, running: 0, capBy: 'host', servers: [{ name: 'ctty-1', running: 0 }, { name: 'ctty-2', running: 2 }], profiles: ['normal'], localProtection: false }];
  const h = host({ 'providers.list': () => ({ providers: providers(), environments, note: 'x' }) });
  const servers = [{ label: 'ctty-1', clis: ['claude'], maxParallel: 1 }, { label: 'ctty-2', clis: ['codex'], maxParallel: 2 }, { label: 'not-offered', clis: ['claude'], maxParallel: 1 }];
  const on = service(h, { saved: declared({ serversOn: true, servers }) }).route;
  const answer = await on.tool('pick_route', orch, { task: 'Write the README section' });
  const json = lastJson(answer);
  assert.deepEqual(json.servers?.map(entry => entry.server), ['ctty-1'], 'ctty-2 is full; an undeclared or unoffered name never');
  assert.deepEqual(json.servers[0].spawn.environment, { pluginId: 'canvastty-environments', kind: 'ssh-host', options: { host: 'ctty-1' } });
  assert.equal(json.servers[0].spawn.provider, 'claude');
  assert.match(answer.content, /On your server ctty-1/u);
  const orchestrating = await on.tool('pick_route', orch, { task: 'Lead a big refactor', orchestrate: true });
  assert.equal(lastJson(orchestrating).servers, undefined, 'a server card is a leaf');
  const off = service(h, { saved: declared({ serversOn: false, servers }) }).route;
  assert.equal(lastJson(await off.tool('pick_route', orch, { task: 'Write the README section' })).servers, undefined);
  // Environments an orchestrator passes in list_providers count as well (labels only).
  const passed = service(host({}), { saved: declared({ serversOn: true, servers }) }).route;
  const viaList = await passed.tool('pick_route', orch, { task: 'Write the README section', providers: { providers: providers(), environments } });
  assert.deepEqual(lastJson(viaList).servers.map(entry => entry.server), ['ctty-1']);
});

test('agent tree: measured tokens price a paid route at the catalog price, a plan as a share; the agent\'s own estimate is shown as one', () => {
  const usage = { tokens: 650, input: 1000, output: 100, cached: 500, usd: 0.012, share: 0.5, providerEstimate: 0.02 };
  assert.deepEqual(measuredCost({ kind: 'usd', low: 0.1, high: 0.4 }, usage), { kind: 'usd', low: 0.012, high: 0.012, measured: true });
  assert.deepEqual(measuredCost({ kind: 'plan', label: 'Max', share: 8, window: '5 h' }, usage), { kind: 'plan', label: 'Max', share: 0.5, window: '5 h', measured: true });
  // A flat-rate plan account (run 18): its measured tokens as a share of the plan, still never dollars.
  assert.deepEqual(measuredCost({ kind: 'flat', label: 'GLM' }, usage), { kind: 'plan', label: 'GLM', share: 0.5, window: null, measured: true, subscription: true });
  assert.deepEqual(measuredCost({ kind: 'flat', label: 'GLM' }, null), { kind: 'flat', label: 'GLM' });
  const view = buildTree({
    cards: [{ id: 'o', provider: 'claude', role: 'orchestrator', title: 'Lead', status: 'working', startedAt: NOW }, { id: 'k', provider: 'opencode', role: 'subagent', parentSessionId: 'o', title: 'Kid', status: 'working', startedAt: NOW }],
    route: id => id === 'k' ? { model: 'glm-5.3', identity: 'glm-5-3', kind: 'account', label: 'Z.AI', costBasis: 'api', estimate: { kind: 'usd', low: 0.1, high: 0.4 } } : null,
    usage: id => id === 'k' ? usage : null, task: () => null, planChildren: () => null, endedAt: () => null
  });
  const tree = view.trees[0];
  assert.equal(tree.root.children[0].cost.measured, true);
  assert.equal(tree.totals.tokens, 650);
  assert.equal(tree.totals.providerEstimate, 0.02);
  assert.deepEqual(tree.totals.usd, { low: 0.012, high: 0.012 });
});

test('feeds: refusal reasons from error data or the message; an unknown answer shape is not "no accounts"', async () => {
  assert.equal(sharedReadReason(Object.assign(new Error('x'), { data: { reason: 'not_declared' } })), 'not_declared');
  assert.equal(sharedReadReason(new Error('approval_changed: changed since you allowed it')), 'approval_changed');
  assert.equal(sharedReadReason(new Error('Something else')), null);
  const odd = new AccountsFeed(host({ 'plugins.request': () => ({ data: null }) }));
  assert.equal(await odd.routes(), null);
  assert.equal(odd.state().mode, 'failing');
  const old = new AccountsFeed(host({}));
  assert.equal(await old.routes(), null);
  assert.equal(old.state().mode, 'unsupported');
  const meter = new UsageMeter(host({ 'usage.summary': () => null }));
  assert.equal(await meter.byProviderSince(NOW - 60_000), null);
});

test('manifest: providers:read, usage:read and the Accounts methods it reads (uses), all stamped', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'canvastty.plugin.json'), 'utf8'));
  for (const permission of ['providers:read', 'usage:read', 'limits:read', 'sessions:launch', 'sessions:read']) assert.ok(manifest.permissions.includes(permission), permission);
  assert.deepEqual(manifest.uses, [{ plugin: 'canvastty-accounts', method: 'accounts.routes' }, { plugin: 'canvastty-accounts', method: 'accounts.quota' }]);
  assert.deepEqual(manifest.services[0].launch.policy, { scope: 'own-trees' });
});
