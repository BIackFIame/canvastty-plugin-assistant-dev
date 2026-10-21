// Auto (Jev) autopilot, phase 2 (jev-autopilot-design.md §5, B7 and B8), feature-detected:
// - B7: where CanvasTTY shows a launch service what the launch asks for (`requested`, `peerOptions`), every subagent of
//   an Auto tree must match its single-use pick_route decision: the CLI, the model, the effort and the Accounts
//   account (once Accounts shares it with `visibleTo`). The launch policy closes phase 1's gaps: a child on another
//   CLI that did not name the Assistant, and a grandchild on another CLI. Older cores keep phase 1's checks.
// - B8: "Start with Auto (Jev)" starts the top-level orchestrator with `sessions.create {role: "orchestrator"}` on the
//   CLI, sign-in, model and effort Jev chose, only with the person's "May start orchestrators"; otherwise nothing
//   starts and the answer says how to start Auto instead.
// Against the real core when CANVASTTY_REPO points at a checkout: TerminalManager + LaunchPipeline (+ PluginSessions),
// with a fake PTY (no CLI runs). Fake HOME, no model, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Assistant } from '../src/service/assistant.ts';
import { Bindings, expectedOf, isBoundValue, isTopValue, launchAsk, mismatchOf } from '../src/autopilot/binding.ts';
import { AUTOPILOT_STRINGS } from '../src/autopilot/i18n.ts';
import { DEFAULT_ROUTE_SETTINGS } from '../src/route/settings.ts';
import { limitsAnswer } from './helpers/route-fixtures.mjs';
import { manifestForCore } from './helpers/core-manifest.mjs';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'canvastty-autopilot2-')));
process.on('exit', () => rmSync(base, { recursive: true, force: true }));
const core = process.env.CANVASTTY_REPO;
const project = name => { const dir = join(base, name); mkdirSync(dir, { recursive: true }); return dir; };
const EN = AUTOPILOT_STRINGS.en;
const ACCOUNTS = 'canvastty-accounts';
const ASSISTANT = 'canvastty-assistant';
const manifest = JSON.parse(readFileSync(new URL('../canvastty.plugin.json', import.meta.url), 'utf8'));

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Condition was not met in time.');
};

const plans = ({ claude = true } = {}) => ({
  ...structuredClone(DEFAULT_ROUTE_SETTINGS), trust: { 'host:api.z.ai': 'D2' },
  plans: [
    ...(claude ? [{ id: 'claude-max', cli: 'claude', kind: 'subscription', label: 'Max', models: ['opus', 'sonnet'], reserve: 20, maxParallel: 4, allow: 'allow', trust: 'D2' }] : []),
    { id: 'codex-pro', cli: 'codex', kind: 'subscription', label: 'Pro', models: ['gpt-5.5'], reserve: 20, maxParallel: 4, allow: 'allow', trust: 'D2' }
  ]
});
const providers = ['claude', 'codex'].map(id => ({ id, installed: true, available: true, signIn: 'ok', subagent: true, orchestrator: true, efforts: id === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['minimal', 'low', 'medium', 'high', 'xhigh'], launchOptions: [{ pluginId: ASSISTANT }, { pluginId: ACCOUNTS }] }));
const accountRoutes = [
  { provider: 'claude', accountId: 'glm-53', account: 'GLM 5.3 · Z.AI Coding Plan', model: 'glm-5.3', endpoint: 'api.z.ai', state: 'ready', launchOptions: { [ACCOUNTS]: { account: 'glm-53', effort: 'default', trustFolder: false } } },
  { provider: 'claude', accountId: 'glm-air', account: 'GLM Air · Z.AI Coding Plan', model: 'glm-5.3-flash', endpoint: 'api.z.ai', state: 'ready', launchOptions: { [ACCOUNTS]: { account: 'glm-air', effort: 'default', trustFolder: false } } }
];
const lastJson = answer => JSON.parse(String(answer.content).split('\n').at(-1));

/** An Assistant in this process; `sessions` answers its sessions.* host calls (a real PluginSessions or a stand-in). */
function assistantWith({ routing = plans(), sessions = null } = {}) {
  const calls = [], storage = {};
  const host = {
    calls,
    callHost: async (method, params) => {
      calls.push({ method, params: structuredClone(params) });
      if (method === 'storage.set') { storage[params.key] = params.value; return null; }
      if (method === 'storage.get') return storage[params.key] ?? null;
      if (method.startsWith('sessions.') && sessions) return sessions(method, params);
      return null;
    },
    log() {}, emit() {}
  };
  const assistant = new Assistant({ host, dataDir: mkdtempSync(join(base, 'data-')), git: null, locale: 'en', routing, harness: { routing: true, loopAlerts: true, flows: true } });
  assistant.routing.receiveLimits(limitsAnswer({ now: Date.now() }));
  return { assistant, host };
}

// ---------------------------------------------------------------------------------------------------------------
// The comparison itself
// ---------------------------------------------------------------------------------------------------------------

test('B7 comparison: model, effort, the account when Accounts shares it; Accounts "none" may be left out; an added account is refused', () => {
  const ask = (requested, peerOptions = {}) => launchAsk({ requested, peerOptions });
  assert.equal(launchAsk({}), null, 'an older core sends no requested');
  assert.equal(launchAsk({ requested: { model: 'x' } }), null, 'malformed: no plugins');
  const routed = expectedOf({ provider: 'claude', model: 'opus', effort: 'max', launchOptions: { [ASSISTANT]: { model: 'r:x' }, [ACCOUNTS]: { account: 'none' } } });
  assert.deepEqual(routed, { model: 'opus', effort: 'max', options: { [ACCOUNTS]: { account: 'none' } } });
  assert.equal(mismatchOf(routed, ask({ model: 'opus', effort: 'max', plugins: [ACCOUNTS, ASSISTANT] }, { [ACCOUNTS]: { account: 'none' } })), null);
  assert.equal(mismatchOf(routed, ask({ model: 'opus', effort: 'max', plugins: [ASSISTANT] })), null, 'Accounts "none" left out: the CLI\'s own sign-in');
  assert.equal(mismatchOf(routed, ask({ model: 'sonnet', effort: 'max', plugins: [ASSISTANT] })), 'wrong-model');
  assert.equal(mismatchOf(routed, ask({ effort: 'max', plugins: [ASSISTANT] })), 'wrong-model', 'the CLI\'s default is not the decision\'s model');
  assert.equal(mismatchOf(routed, ask({ model: 'opus', effort: 'low', plugins: [ASSISTANT] })), 'wrong-effort');
  assert.equal(mismatchOf(routed, ask({ model: 'opus', effort: 'max', plugins: [ACCOUNTS, ASSISTANT] }, { [ACCOUNTS]: { account: 'glm-53' } })), 'wrong-account', 'an account added');
  const account = expectedOf({ provider: 'claude', launchOptions: { [ASSISTANT]: { model: 'r:x' }, [ACCOUNTS]: { account: 'glm-53', effort: 'default', trustFolder: false } } });
  assert.equal(mismatchOf(account, ask({ plugins: [ACCOUNTS, ASSISTANT] }, { [ACCOUNTS]: { account: 'glm-53' } })), null);
  assert.equal(mismatchOf(account, ask({ plugins: [ACCOUNTS, ASSISTANT] }, { [ACCOUNTS]: { account: 'glm-air' } })), 'wrong-account', 'swapped');
  assert.equal(mismatchOf(account, ask({ plugins: [ASSISTANT] })), 'wrong-account', 'dropped');
  assert.equal(mismatchOf(account, ask({ plugins: [ACCOUNTS, ASSISTANT] })), null, 'Accounts does not share its account (no visibleTo): not checkable, as in phase 1');
  assert.equal(mismatchOf(account, ask({ model: 'opus', plugins: [ACCOUNTS, ASSISTANT] })), 'wrong-model', 'a model next to the account');
  // Every refusal says what to do, and fits CanvasTTY's 240 characters.
  for (const locale of ['en', 'ru']) for (const [key, value] of Object.entries(AUTOPILOT_STRINGS[locale])) {
    assert.ok(value.length <= 240, `${locale} ${key}`);
    if (key.startsWith('wrong-')) assert.match(value, /pick_route/u, `${locale} ${key}`);
  }
  // Top values: for the orchestrator "Start with Auto (Jev)" starts, never for a subagent.
  const b = new Bindings();
  b.markAuto('orch');
  const top = b.bindTop('codex', 'own:gpt-5.5~high', 'd0', expectedOf({ launchOptions: {} }));
  assert.ok(isBoundValue(top) && isTopValue(top));
  assert.deepEqual(b.check({ value: top, parent: 'orch', provider: 'codex', sessionId: 'c' }), { ok: false, reason: 'unrouted' });
  assert.deepEqual(b.checkTop({ value: top, provider: 'claude' }), { ok: false, reason: 'wrong-cli' });
  assert.deepEqual(b.checkTop({ value: top, provider: 'codex', ask: launchAsk({ requested: { plugins: [ASSISTANT] } }) }), { ok: true, target: 'own:gpt-5.5~high', fresh: true });
  assert.deepEqual(b.checkTop({ value: top, provider: 'codex' }), { ok: true, target: 'own:gpt-5.5~high', fresh: false }, 'a restart: the same route');
});

test('older core (no requested): phase 1 behaviour; the policy lets everything through; a mismatched model is not seen', async () => {
  const { assistant } = assistantWith();
  const ctx = (extra = {}) => ({ sessionId: 'orch-1', provider: 'claude', profile: 'normal', role: 'orchestrator', cwd: project('old'), restoring: false, resume: false, options: { task: '', dataClass: 'default', model: 'auto' }, chosen: true, environment: null, ...extra });
  await assistant.launch(ctx());
  assert.equal(assistant.bindings.isAuto('orch-1'), true);
  // A child on another CLI that did not name the Assistant: on an older core the policy is not consulted for it.
  assert.equal(await assistant.launch(ctx({ sessionId: 'x', role: 'subagent', parentSessionId: 'orch-1', provider: 'codex', chosen: false, options: {} })), null);
  const caller = { id: 'orch-1', provider: 'claude', role: 'orchestrator', title: 'o', status: 'idle', cwd: base, workingDirectory: base };
  const spawn = lastJson(await assistant.tool('pick_route', caller, { task: 'Explain the cache layer', providers, prefer: 'codex' })).spawn;
  assert.equal(spawn.provider, 'codex');
  const child = await assistant.launch(ctx({ sessionId: 'c1', role: 'subagent', parentSessionId: 'orch-1', provider: 'codex', options: { task: '', dataClass: 'default', model: spawn.launchOptions[ASSISTANT].model } }));
  assert.ok(!child?.refuse, 'the value, its orchestrator and its CLI match: allowed, whatever model it asks for (not visible)');
  assert.equal((await assistant.launch(ctx({ sessionId: 'c2', role: 'subagent', parentSessionId: 'orch-1', provider: 'codex', options: { task: '', dataClass: 'default', model: spawn.launchOptions[ASSISTANT].model } }))).refuse.reason, EN.used);
});

test('B8 without a core that has it, without consent, without routing: nothing starts, the answer says how to start Auto', async () => {
  // An older core: role is ignored, so the probe (no provider, no folder) is refused for those; no orchestrator call follows.
  const old = assistantWith({ sessions: async method => { if (method === 'sessions.create') throw new Error('provider and cwd are required.'); return null; } });
  assert.deepEqual(await old.assistant.startAuto({ task: 'Add a dark theme', cwd: project('b8') }), { started: false, code: 'core' });
  assert.deepEqual(old.host.calls.filter(call => call.method === 'sessions.create').map(call => call.params), [{ role: 'probe' }], 'only the probe, never a card');
  // A core with B8, consent not given.
  const refused = assistantWith({ sessions: async (method, params) => {
    if (method !== 'sessions.create') return null;
    if (params.role !== 'agent' && params.role !== 'orchestrator') throw new Error('role must be agent or orchestrator.');
    throw new Error('The person has not allowed this plugin to start orchestrators. They can allow it in Settings, under Extension native code.');
  } });
  assert.deepEqual(await refused.assistant.startAuto({ task: 'Add a dark theme', cwd: project('b8') }), { started: false, code: 'consent' });
  assert.equal(refused.host.calls.filter(call => call.method === 'sessions.send').length, 0);
  // Input and the routing switch.
  assert.deepEqual(await refused.assistant.startAuto({ task: '', cwd: project('b8') }), { started: false, code: 'input' });
  assert.deepEqual(await refused.assistant.startAuto({ task: 'x', cwd: 'relative/path' }), { started: false, code: 'input' });
  await refused.assistant.saveHarness({ commandReview: 'off', routing: false, loopAlerts: true, flows: true, trustChain: false });
  assert.deepEqual(await refused.assistant.startAuto({ task: 'Add a dark theme', cwd: project('b8') }), { started: false, code: 'routingOff' });
  // Nothing declared but an OpenRouter account an orchestrator showed: no route (never OpenRouter for model traffic).
  const none = assistantWith({ routing: { ...structuredClone(DEFAULT_ROUTE_SETTINGS), plans: [] }, sessions: async (method, params) => { if (params.role === 'probe') throw new Error('role must be agent or orchestrator.'); return { sessionId: 'never' }; } });
  none.assistant.routing.accountsSeen = { at: Date.now(), rows: [{ provider: 'claude', accountId: 'or-1', account: 'OpenRouter', model: 'anthropic/claude-opus-4.8', endpoint: 'openrouter.ai', state: 'ready' }] };
  await none.assistant.startAuto({ task: 'Add a dark theme', cwd: project('b8') });
  const orchestrators = none.host.calls.filter(call => call.method === 'sessions.create' && call.params.role === 'orchestrator');
  assert.ok(orchestrators.every(call => !JSON.stringify(call.params).includes('or-1') && !JSON.stringify(call.params).includes('openrouter')), 'at most the CLI\'s own sign-in, never the OpenRouter account');
  // Nothing declared and no account seen: no route at all.
  const empty = assistantWith({ routing: { ...structuredClone(DEFAULT_ROUTE_SETTINGS), plans: [] }, sessions: async (method, params) => { if (params.role === 'probe') throw new Error('role must be agent or orchestrator.'); return { sessionId: 'never' }; } });
  assert.deepEqual(await empty.assistant.startAuto({ task: 'Add a dark theme', cwd: project('b8') }), { started: false, code: 'noRoute' });
  assert.ok(!empty.host.calls.some(call => call.method === 'sessions.create' && call.params.role === 'orchestrator'));
});

// ---------------------------------------------------------------------------------------------------------------
// Against the real core: TerminalManager + LaunchPipeline (+ PluginSessions)
// ---------------------------------------------------------------------------------------------------------------

function registry() {
  return { get(provider) { return { state: 'available', provider, executable: `/resolved/${provider}`, launcher: 'native', environment: { PATH: '/usr/bin' }, checked: [] }; }, snapshot() { return {}; } };
}
function spawner(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return { pid: 52_000 + calls.length, process: command, write() {}, resize() {}, kill() {}, pause() {}, resume() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; } };
  };
}
/** An Accounts-like contributor (the real plugin's launch fields), sharing `account` with the Assistant (B7 visibleTo). */
const accountsContributor = {
  pluginId: ACCOUNTS, pluginName: 'CanvasTTY Accounts', serviceId: 'accounts', secrets: true,
  launch: { delegable: true, fields: [
    { key: 'account', label: 'Model account', kind: 'select', optionsFrom: 'service', default: 'none', options: [{ value: 'none', label: 'The agent\'s own sign-in' }], visibleTo: [ASSISTANT] },
    { key: 'effort', label: 'Effort', kind: 'select', default: 'default', options: ['default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(value => ({ value, label: value })) },
    { key: 'trustFolder', label: 'Trust the folder', kind: 'boolean', default: false }
  ] }
};

async function coreFixture(t, { routing } = {}) {
  const { LaunchPipeline } = await import(join(core, 'src/main/services/LaunchPipeline.ts'));
  const { validatePluginManifest } = await import(join(core, 'src/main/services/PluginManager.ts'));
  // The manifest as this core accepts it: the scoped policy, or none at all on a core without the scoped form.
  const accepted = manifestForCore(validatePluginManifest, manifest);
  const launch = validatePluginManifest(accepted.manifest).services[0].launch;
  const { TerminalManager } = await import(join(core, 'src/main/services/TerminalManager.ts'));
  const { PluginSessions } = await import(join(core, 'src/main/services/PluginSessions.ts'));
  const consent = { allowed: false };
  const down = { value: false };
  let sessions = null;
  const { assistant, host } = assistantWith({ routing, sessions: async (method, params) => sessions.handle(ASSISTANT, 'assistant', method, params, manifest.permissions) });
  const seen = [];
  const spawned = [];
  const runsRoot = mkdtempSync(join(base, 'runs-'));
  const pipeline = new LaunchPipeline({
    contributors: () => [{ pluginId: ASSISTANT, pluginName: 'CanvasTTY Assistant', serviceId: 'assistant', launch, secrets: true }, accountsContributor],
    call: async (pluginId, _serviceId, method, params) => {
      seen.push({ pluginId, method, params: structuredClone(params) });
      if (pluginId === ASSISTANT && down.value) throw new Error('The service is not running.');
      return pluginId === ASSISTANT ? assistant.launch(params) : null;
    },
    secret: async () => null, runsRoot, timeoutMs: 2_000
  });
  const terminals = new TerminalManager((channel, payload) => sessions?.observe?.(channel, payload), registry(), undefined, undefined, true, spawner(spawned));
  t.after(() => terminals.shutdown?.());
  terminals.configureLaunchPipeline(pipeline);
  sessions = new PluginSessions({ terminals, notify: () => true, mayStartOrchestrators: pluginId => pluginId === ASSISTANT && consent.allowed });
  const card = id => terminals.list().find(session => session.id === id);
  const settled = async id => waitFor(() => { const c = card(id); return c && (c.status === 'failed' || spawned.some(entry => entry.options?.env?.CANVASTTY_SESSION_ID === id || entry.options?.cwd)) ? c : null; });
  /** Started (the fake PTY spawned it) or refused (the card failed with the reason). */
  const outcome = async (id, before) => {
    await waitFor(() => spawned.length > before || card(id)?.status === 'failed');
    const c = card(id);
    return c.status === 'failed' ? { refused: c.failureDetails ?? '' } : { started: spawned.at(-1) };
  };
  const b7 = () => seen.some(entry => entry.params.requested !== undefined);
  /** Policy answers reached the Assistant (chosen: false): only with the scoped policy, on a core that has it. */
  const policed = () => seen.some(entry => entry.pluginId === ASSISTANT && entry.params.chosen === false);
  return { assistant, host, terminals, pipeline, spawned, seen, consent, card, settled, outcome, b7, sessions, scoped: accepted.policy, policed, down };
}

const at = { x: 0, y: 0 };
const coreHas = (file, word) => readFileSync(join(core, 'src/main/services', file), 'utf8').includes(word);

test('core: an Auto orchestrator\'s subagents match their decision (CLI, model, effort, account), a grandchild on another CLI is checked; an older core keeps phase 1', { skip: !core && 'set CANVASTTY_REPO to a CanvasTTY checkout' }, async t => {
  const f = await coreFixture(t);
  const cwd = project('core-b7');
  const orch = f.terminals.create({ provider: 'claude', cwd, profile: 'normal', position: at, role: 'orchestrator', title: 'Lead', launchOptions: { [ASSISTANT]: { model: 'auto' } } });
  await waitFor(() => f.spawned.length === 1);
  assert.equal(f.assistant.bindings.isAuto(orch.id), true);
  const b7 = f.b7();
  assert.equal(b7, coreHas('LaunchPipeline.ts', 'peerOptions'), 'B7 is detected exactly where the core has it');
  const caller = { id: orch.id, provider: 'claude', role: 'orchestrator', title: 'Lead', status: 'idle', cwd, workingDirectory: cwd };
  const route = async extra => lastJson(await f.assistant.tool('pick_route', caller, { task: 'Explain the cache layer', providers, accountRoutes, ...extra })).spawn;
  const child = async (spawn, extra = {}) => {
    const before = f.spawned.length;
    const created = f.terminals.create({ provider: spawn.provider, cwd, profile: 'normal', position: at, role: 'subagent', parentSessionId: extra.parent ?? orch.id,
      ...(spawn.model !== undefined ? { model: spawn.model } : {}), ...(spawn.effort !== undefined ? { effort: spawn.effort } : {}), ...(spawn.launchOptions ? { launchOptions: spawn.launchOptions } : {}) });
    return { id: created.id, ...(await f.outcome(created.id, before)) };
  };

  // A matching spawn starts: a subscription route (model and effort as decided) and an account route.
  const sub = await route({ prefer: 'codex' });
  assert.equal(sub.provider, 'codex');
  const ok = await child(sub);
  assert.ok(ok.started, ok.refused);
  const acct = await route({ prefer: 'glm-53' });
  assert.equal(acct.launchOptions[ACCOUNTS].account, 'glm-53');
  const okAccount = await child(acct);
  assert.ok(okAccount.started, okAccount.refused);
  if (b7) {
    const asked = f.seen.filter(entry => entry.params.sessionId === okAccount.id && entry.pluginId === ASSISTANT).at(-1).params;
    assert.deepEqual(asked.peerOptions, { [ACCOUNTS]: { account: 'glm-53' } }, 'Accounts shares only its account');
  }

  // Mismatches: another model, another effort, another account, another CLI.
  const wrongModel = await child({ ...(await route({ prefer: 'codex' })), model: 'gpt-5.4' });
  const wrongEffortSpawn = await route({ prefer: 'codex' });
  const wrongEffort = await child({ ...wrongEffortSpawn, effort: wrongEffortSpawn.effort === 'low' ? 'high' : 'low' });
  const swapped = await route({ prefer: 'glm-53' });
  const wrongAccount = await child({ ...swapped, launchOptions: { ...swapped.launchOptions, [ACCOUNTS]: { ...swapped.launchOptions[ACCOUNTS], account: 'glm-air' } } });
  const otherCli = await route({ prefer: 'codex' });
  const wrongCli = await child({ ...otherCli, provider: 'claude', model: undefined, effort: undefined });
  assert.match(wrongCli.refused ?? '', new RegExp(EN['wrong-cli'].slice(0, 40).replace(/[()]/gu, '.'), 'u'), 'another CLI: refused on every core');
  if (b7) {
    assert.ok((wrongModel.refused ?? '').includes(EN['wrong-model']), wrongModel.refused);
    assert.ok((wrongEffort.refused ?? '').includes(EN['wrong-effort']), wrongEffort.refused);
    assert.ok((wrongAccount.refused ?? '').includes(EN['wrong-account']), wrongAccount.refused);
  } else {
    // Older core: the Assistant does not see the model, effort or account (phase 1); it does not refuse them itself.
    for (const result of [wrongModel, wrongEffort, wrongAccount]) assert.ok(!(result.refused ?? '').includes('Auto (Jev): this subagent'), result.refused);
  }

  // Phase 1's gap: a child on another CLI that does not name the Assistant (only Accounts) never reached it.
  const unnamed = await child({ provider: 'codex', launchOptions: { [ACCOUNTS]: { account: 'none' } } });
  // Only the scoped policy reaches it; without it (a core without the scoped form) phase 1: not asked.
  if (b7 && f.scoped) assert.ok((unnamed.refused ?? '').includes(EN.unrouted), unnamed.refused);
  else assert.ok(!(unnamed.refused ?? '').includes(EN.unrouted), 'no policy: not asked (phase 1)');

  // A deep child (orchestrate: true) on Claude; its grandchild on Codex without a route is refused, with one it starts.
  const deepSpawn = await route({ prefer: 'claude', orchestrate: true });
  assert.equal(deepSpawn.provider, 'claude');
  const deep = await child(deepSpawn);
  assert.ok(deep.started, deep.refused);
  assert.equal(f.assistant.bindings.isAuto(deep.id), true);
  const grand = await child({ provider: 'codex', launchOptions: { [ACCOUNTS]: { account: 'none' } } }, { parent: deep.id });
  if (b7 && f.scoped) assert.ok((grand.refused ?? '').includes(EN.unrouted), grand.refused);
  const deepCaller = { ...caller, id: deep.id };
  const grandRoute = lastJson(await f.assistant.tool('pick_route', deepCaller, { task: 'Write the tests', providers, accountRoutes, prefer: 'codex' })).spawn;
  const routedGrand = await child(grandRoute, { parent: deep.id });
  assert.ok(routedGrand.started, routedGrand.refused);
  // A leaf child (no orchestrate): its own subagent on another CLI is refused where the core shows every launch.
  const leafGrand = await child({ provider: 'codex', launchOptions: { [ACCOUNTS]: { account: 'none' } } }, { parent: ok.id });
  if (b7 && f.scoped) assert.ok((leafGrand.refused ?? '').includes(EN.leaf), leafGrand.refused);
  // The depth rule on the leaf's own CLI: its subagent inherits the Assistant's options (as spawn_agent passes them),
  // so it is checked without a policy.
  const inherited = f.terminals.launchOptionsOf?.(ok.id);
  if (inherited) {
    const leafSame = await child({ provider: 'codex', launchOptions: inherited }, { parent: ok.id });
    if (b7) assert.ok((leafSame.refused ?? '').includes(EN.leaf), leafSame.refused);
  }

  // The person's own launches are never refused, on any CLI, with or without options.
  for (const provider of ['claude', 'codex']) {
    const before = f.spawned.length;
    const mine = f.terminals.create({ provider, cwd, profile: 'normal', position: at, role: 'agent' });
    const result = await f.outcome(mine.id, before);
    assert.ok(result.started, result.refused);
    assert.deepEqual(f.seen.filter(entry => entry.params.sessionId === mine.id).map(entry => [entry.pluginId, entry.params.chosen]), [], 'a launch the person starts never reaches the Assistant\'s policy');
  }
});

test('core: a Claude Auto orchestrator without a declared plan (no --model): its children on another CLI are checked too', { skip: !core && 'set CANVASTTY_REPO to a CanvasTTY checkout' }, async t => {
  const f = await coreFixture(t, { routing: plans({ claude: false }) });
  const cwd = project('core-noplan');
  const orch = f.terminals.create({ provider: 'claude', cwd, profile: 'normal', position: at, role: 'orchestrator', launchOptions: { [ASSISTANT]: { model: 'auto' } } });
  await waitFor(() => f.spawned.length === 1);
  assert.ok(!f.spawned[0].args.includes('--model'), 'no declared plan: the CLI\'s own default model');
  const before = f.spawned.length;
  const child = f.terminals.create({ provider: 'codex', cwd, profile: 'normal', position: at, role: 'subagent', parentSessionId: orch.id });
  const result = await f.outcome(child.id, before);
  if (f.b7() && f.scoped) assert.ok((result.refused ?? '').includes(EN.unrouted), result.refused);
  else assert.ok(result.started, 'no scoped policy on this core: phase 1, not asked');
});

test('core: "Start with Auto (Jev)" is refused without the person\'s consent and starts a marked orchestrator with a plan with it', { skip: !core && 'set CANVASTTY_REPO to a CanvasTTY checkout' }, async t => {
  const f = await coreFixture(t);
  const cwd = project('core-b8');
  const task = 'Do these:\n- add a dark theme\n- add tests for it\n- update the docs';
  const supported = (() => { try { f.sessions.handle(ASSISTANT, 'assistant', 'sessions.create', { role: 'probe' }, manifest.permissions); return false; } catch (error) { return /role must be agent or orchestrator/u.test(error.message); } })();
  assert.equal(supported, coreHas('PluginSessions.ts', 'mayStartOrchestrators'), 'B8 is detected exactly where the core has it');
  const refused = await f.assistant.startAuto({ task, cwd });
  assert.equal(refused.started, false);
  assert.equal(refused.code, supported ? 'consent' : 'core');
  assert.equal(f.terminals.list().length, 0, 'no card');
  assert.equal(f.spawned.length, 0);
  if (!supported) return;

  f.consent.allowed = true;
  const started = await f.assistant.startAuto({ task, cwd });
  assert.equal(started.started, true, JSON.stringify(started));
  assert.ok(['claude', 'codex'].includes(started.provider), started.provider);
  assert.deepEqual(started.plan, { mode: 'orchestrate', children: 3 });
  await waitFor(() => f.spawned.length === 1);
  const metadata = f.terminals.getMetadata(started.sessionId);
  assert.equal(metadata.role, 'orchestrator');
  assert.equal(metadata.startedByPlugin, ASSISTANT, 'marked: started by the Assistant');
  const create = f.host.calls.find(call => call.method === 'sessions.create' && call.params.role === 'orchestrator').params;
  assert.ok(isTopValue(create.launchOptions[ASSISTANT].model), create.launchOptions[ASSISTANT].model);
  assert.ok(!JSON.stringify(create).includes('openrouter'));
  const args = f.spawned[0].args;
  assert.ok(args.includes('--model'), args.join(' '));
  assert.equal(f.assistant.bindings.isAuto(started.sessionId), true);
  assert.equal(f.assistant.bindings.planned(started.sessionId), 3, 'the plan binds its subagents');
  const send = await waitFor(() => f.host.calls.find(call => call.method === 'sessions.send'));
  assert.equal(send.params.sessionId, started.sessionId);
  assert.match(send.params.text, /add a dark theme.*pick_route.*at most 3 parts/su);
  // Its subagents are routed like any Auto card's: an unrouted one on another CLI is refused (B7), a routed one starts.
  const caller = { id: started.sessionId, provider: started.provider, role: 'orchestrator', title: 'Auto (Jev)', status: 'idle', cwd, workingDirectory: cwd };
  const spawn = lastJson(await f.assistant.tool('pick_route', caller, { task: 'add tests for it', providers, accountRoutes, prefer: 'codex' })).spawn;
  const before = f.spawned.length;
  const kid = f.terminals.create({ provider: spawn.provider, cwd, profile: 'normal', position: at, role: 'subagent', parentSessionId: started.sessionId, ...(spawn.model ? { model: spawn.model } : {}), ...(spawn.effort ? { effort: spawn.effort } : {}), launchOptions: spawn.launchOptions });
  const result = await f.outcome(kid.id, before);
  assert.ok(result.started, result.refused);
  // Turning the consent off: the next start is refused at once.
  f.consent.allowed = false;
  assert.equal((await f.assistant.startAuto({ task, cwd })).code, 'consent');
});

test('core: with the Assistant\'s service down, a launch the person starts is never held by it; an Auto tree\'s subagent is', { skip: !core && 'set CANVASTTY_REPO to a CanvasTTY checkout' }, async t => {
  const f = await coreFixture(t);
  const cwd = project('core-down');
  const orch = f.terminals.create({ provider: 'claude', cwd, profile: 'normal', position: at, role: 'orchestrator', launchOptions: { [ASSISTANT]: { model: 'auto' } } });
  await waitFor(() => f.spawned.length === 1);
  f.down.value = true;
  for (const provider of ['claude', 'codex']) {
    const before = f.spawned.length;
    const mine = f.terminals.create({ provider, cwd, profile: 'normal', position: at, role: 'agent' });
    const result = await f.outcome(mine.id, before);
    assert.ok(result.started, `the person's ${provider} launch: ${result.refused}`);
    const beforeOrch = f.spawned.length;
    const minesOrch = f.terminals.create({ provider, cwd, profile: 'normal', position: at, role: 'orchestrator' });
    const orchestrated = await f.outcome(minesOrch.id, beforeOrch);
    assert.ok(orchestrated.started, `the person's ${provider} orchestrator: ${orchestrated.refused}`);
  }
  // A subagent in the Auto tree on another CLI: with the scoped policy the core asks the (down) service and refuses.
  const before = f.spawned.length;
  const kid = f.terminals.create({ provider: 'codex', cwd, profile: 'normal', position: at, role: 'subagent', parentSessionId: orch.id });
  const result = await f.outcome(kid.id, before);
  if (f.scoped) assert.ok(result.refused, 'held while the service is down');
  else assert.ok(result.started, 'no policy: phase 1');
});
