// Auto (Jev) autopilot, phase 1 (jev-autopilot-design.md): Auto on a Claude Code or Codex card's own sign-in (model
// and effort chosen, the vendor endpoint pinned), every subagent of an Auto card bound to a pick_route decision
// (single-use, its orchestrator and CLI, the plan's child count), OpenCode plan routes pinned, autopilot_plan
// (task.shape), leaf cards on declared servers, and the egress rule (OpenRouter only for Jev's /systemone).
// Fake HOME, no model, no network beyond loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Assistant } from '../src/service/assistant.ts';
import { Bindings, BIND_TTL_MS, isBoundValue } from '../src/autopilot/binding.ts';
import { askTaskShape, planFor, planText, ruleShape } from '../src/autopilot/shape.ts';
import { openCodePlanContribution, ownSignInArgs } from '../src/autopilot/topLevel.ts';
import { AUTOPILOT_STRINGS } from '../src/autopilot/i18n.ts';
import { DEFAULT_ROUTE_SETTINGS } from '../src/route/settings.ts';
import { turnView } from '../src/auto/select.ts';
import { limitsAnswer } from './helpers/route-fixtures.mjs';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'canvastty-autopilot-')));
process.on('exit', () => rmSync(base, { recursive: true, force: true }));
const core = process.env.CANVASTTY_REPO;
const project = name => { const dir = join(base, name); mkdirSync(dir, { recursive: true }); return dir; };

function fakeHost({ secrets = {} } = {}) {
  const calls = [], storage = {};
  let n = 0;
  return {
    calls, storage, secrets,
    callHost: async (method, params) => {
      calls.push({ method, params });
      if (method === 'storage.set') { storage[params.key] = params.value; return null; }
      if (method === 'storage.get') return storage[params.key] ?? null;
      if (method === 'secrets.get') return secrets[params.key] ?? null;
      if (method === 'sessions.create') return { sessionId: `leaf-${++n}` };
      if (method === 'sessions.send') return { sent: true };
      return null;
    },
    log() {}, emit() {}
  };
}

const plans = () => ({ ...structuredClone(DEFAULT_ROUTE_SETTINGS), pins: { 'glm-5-3': 'small' }, plans: [
  { id: 'claude-max', cli: 'claude', kind: 'subscription', label: 'Max', models: ['opus', 'sonnet'], reserve: 20, maxParallel: 2, allow: 'allow', trust: 'D2' },
  { id: 'codex-pro', cli: 'codex', kind: 'subscription', label: 'Pro', models: ['gpt-5.5'], reserve: 20, maxParallel: 2, allow: 'allow', trust: 'D2' },
  { id: 'glm-plan', cli: 'opencode', kind: 'coding-plan', label: 'GLM Coding Plan', models: ['zai-coding-plan/*'], reserve: 20, maxParallel: 2, allowance: 100, windowHours: 5, allow: 'allow', trust: 'D2' }
] });

function assistantWith({ routing = plans(), transport, secrets, settings } = {}) {
  const host = fakeHost({ secrets });
  const assistant = new Assistant({ host, dataDir: mkdtempSync(join(base, 'data-')), git: null, locale: 'en', routing, harness: { routing: true, loopAlerts: true, flows: true }, ...(transport ? { transport, catalogTransport: transport } : {}), ...(settings ? { settings } : {}) });
  return { assistant, host };
}
const launch = (extra = {}) => ({ sessionId: 'orch-0001', provider: 'claude', profile: 'normal', role: 'orchestrator', cwd: project('p'), restoring: false, resume: false, options: { task: '', dataClass: 'default', model: 'auto' }, chosen: true, environment: null, ...extra });
const providers = [
  { id: 'claude', installed: true, available: true, signIn: 'ok', subagent: true, orchestrator: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], launchPlugins: ['canvastty-assistant'] },
  { id: 'codex', installed: true, available: true, signIn: 'ok', subagent: true, orchestrator: true, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'], launchPlugins: ['canvastty-assistant'] },
  { id: 'opencode', installed: true, available: true, signIn: 'ok', subagent: true, orchestrator: true, model: { supported: true, known: ['zai-coding-plan/glm-5.3', 'zai-coding-plan/glm-5.3-flash'] }, launchPlugins: ['canvastty-assistant'] }
];
const lastJson = answer => JSON.parse(String(answer.content).split('\n').at(-1));

// ---------------------------------------------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------------------------------------------

test('binding: single-use, for its orchestrator and CLI, within 10 minutes and the plan\'s child count; a child that may split is an Auto card too', () => {
  let now = 1_000;
  const b = new Bindings(() => now);
  b.markAuto('orch');
  const value = b.bind('orch', 'codex', 'off', 'd1', false);
  assert.ok(isBoundValue(value));
  assert.deepEqual(b.check({ value: 'auto', parent: 'orch', provider: 'codex', sessionId: 'c0' }), { ok: false, reason: 'unrouted' });
  assert.deepEqual(b.check({ value: 'r:000000000000:off', parent: 'orch', provider: 'codex', sessionId: 'c0' }), { ok: false, reason: 'unknown' });
  assert.deepEqual(b.check({ value, parent: 'other', provider: 'codex', sessionId: 'c1' }), { ok: false, reason: 'wrong-parent' });
  assert.deepEqual(b.check({ value, parent: 'orch', provider: 'claude', sessionId: 'c1' }), { ok: false, reason: 'wrong-cli' });
  assert.equal(b.check({ value, parent: 'orch', provider: 'codex', sessionId: 'c1' }).ok, true);
  assert.deepEqual(b.check({ value, parent: 'orch', provider: 'codex', sessionId: 'c2' }), { ok: false, reason: 'used' });
  const old = b.bind('orch', 'codex', 'off', 'd2', false);
  now += BIND_TTL_MS + 1;
  assert.deepEqual(b.check({ value: old, parent: 'orch', provider: 'codex', sessionId: 'c3' }), { ok: false, reason: 'expired' });
  b.setPlan('orch', 2);
  assert.equal(b.check({ value: b.bind('orch', 'claude', 'off', 'd3', true), parent: 'orch', provider: 'claude', sessionId: 'deep-1' }).ok, true);
  assert.equal(b.isAuto('deep-1'), true, 'it may split: its own subagents are routed too');
  assert.deepEqual(b.check({ value: b.bind('orch', 'claude', 'off', 'd4', false), parent: 'orch', provider: 'claude', sessionId: 'c5' }), { ok: false, reason: 'over-plan' });
  b.ended('c1');
  assert.equal(b.check({ value: b.bind('orch', 'claude', 'off', 'd5', false), parent: 'orch', provider: 'claude', sessionId: 'c6' }).ok, true, 'a child ended: room again');
});

// ---------------------------------------------------------------------------------------------------------------
// Top-level: the card's own sign-in
// ---------------------------------------------------------------------------------------------------------------

test('Auto on Claude Code and Codex: the model and effort on the CLI\'s own subscription, the vendor endpoint pinned; an exhausted subscription is refused, never moved to a paid route', async () => {
  assert.deepEqual(ownSignInArgs('claude', { model: 'opus', effort: 'max' }), ['--model', 'opus', '--effort', 'max', '--settings', '{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com"}}']);
  assert.deepEqual(ownSignInArgs('codex', { model: 'gpt-5.5', effort: 'xhigh' }), ['--model', 'gpt-5.5', '-c', 'model_reasoning_effort="xhigh"', '-c', 'model_provider="openai"']);
  assert.deepEqual(ownSignInArgs('codex', { model: 'x y', effort: 'ultra' }), ['-c', 'model_provider="openai"'], 'nothing unchecked');
  const { assistant } = assistantWith();
  assistant.routing.receiveLimits(limitsAnswer({ now: Date.now() }));
  const claude = await assistant.launch(launch());
  assert.equal(claude.args[0], '--model');
  assert.ok(['opus', 'sonnet'].includes(claude.args[1]), claude.args.join(' '));
  assert.ok(claude.args.includes('--settings'));
  assert.equal(assistant.bindings.isAuto('orch-0001'), true);
  const codex = await assistant.launch(launch({ sessionId: 'orch-0002', provider: 'codex' }));
  assert.deepEqual(codex.args.slice(0, 2), ['--model', 'gpt-5.5']);
  assert.ok(codex.args.includes('model_provider="openai"'));
  // The Claude subscription at 95% of its 5 h window (reserve 20%): refused with the reason.
  const { assistant: full } = assistantWith();
  full.routing.receiveLimits(limitsAnswer({ now: Date.now(), claude: 95 }));
  const refused = await full.launch(launch({ sessionId: 'orch-0003' }));
  assert.match(refused.refuse.reason, /subscription has no room left now/u);
  // A CLI Auto does not run on yet.
  assert.equal((await full.launch(launch({ sessionId: 'x', provider: 'grok' }))).refuse.reason, AUTOPILOT_STRINGS.en.provider);
});

test('through CanvasTTY\'s own launch pipeline: the Claude and Codex arguments pass its checks', { skip: !core && 'set CANVASTTY_REPO to a CanvasTTY checkout' }, async () => {
  const { LaunchPipeline } = await import(join(core, 'src/main/services/LaunchPipeline.ts'));
  const { assistant } = assistantWith();
  const manifest = JSON.parse(readFileSync(new URL('../canvastty.plugin.json', import.meta.url), 'utf8'));
  const ours = { pluginId: 'canvastty-assistant', pluginName: 'CanvasTTY Assistant', serviceId: 'assistant', launch: manifest.services[0].launch, secrets: true };
  const pipeline = new LaunchPipeline({ contributors: () => [ours], runsRoot: mkdtempSync(join(base, 'runs-')), secret: async () => null, call: async (_p, _s, _m, params) => assistant.launch(params) });
  for (const provider of ['claude', 'codex']) {
    const options = pipeline.normalizeOptions(provider, { 'canvastty-assistant': { model: 'auto' } });
    const prepared = await pipeline.prepare({ sessionId: `pipe-${provider}`, provider, profile: 'normal', role: 'orchestrator', cwd: project('pipe'), restoring: false, resume: false, environment: null, options });
    assert.equal(prepared.ok, true, `${provider}: ${prepared.reason}`);
    assert.ok(prepared.args.length >= 2, prepared.args.join(' '));
    await prepared.cleanup?.();
  }
  // A route value from pick_route is accepted by the model field (optionsFrom: service).
  const options = pipeline.normalizeOptions('codex', { 'canvastty-assistant': { model: 'r:abcdefabcdef:off' } }, { delegated: true });
  assert.equal(options['canvastty-assistant'].model, 'r:abcdefabcdef:off');
});

// ---------------------------------------------------------------------------------------------------------------
// Every subagent of an Auto card goes through pick_route
// ---------------------------------------------------------------------------------------------------------------

test('an Auto orchestrator\'s subagents: only with pick_route\'s value, once; the person\'s own launches and other orchestrators are never refused', async () => {
  const { assistant } = assistantWith();
  assistant.routing.receiveLimits(limitsAnswer({ now: Date.now() }));
  await assistant.launch(launch());
  const caller = { id: 'orch-0001', provider: 'claude', role: 'orchestrator', title: 'o', status: 'idle', cwd: base, workingDirectory: base };
  const answer = await assistant.tool('pick_route', caller, { task: 'Explain the cache layer', providers });
  const json = lastJson(answer);
  const value = json.spawn.launchOptions['canvastty-assistant'].model;
  assert.match(value, /^r:[a-z0-9]{12}:(?:off|auto|plan:.+)$/u);
  const child = (extra = {}) => assistant.launch({ ...launch(), sessionId: 'child-1', role: 'subagent', parentSessionId: 'orch-0001', provider: json.spawn.provider, options: { task: '', dataClass: 'default', model: value }, ...extra });
  // Unrouted (inherited "auto", or "off" named), another CLI, then the right one, then a second use.
  assert.equal((await child({ options: { task: '', dataClass: 'default', model: 'auto' } })).refuse.reason, AUTOPILOT_STRINGS.en.unrouted);
  assert.equal((await child({ options: { task: '', dataClass: 'default', model: 'off' } })).refuse.reason, AUTOPILOT_STRINGS.en.unrouted);
  assert.equal((await child({ provider: json.spawn.provider === 'codex' ? 'claude' : 'codex' })).refuse.reason, AUTOPILOT_STRINGS.en['wrong-cli']);
  assert.ok(!(await child())?.refuse, 'the routed child starts');
  assert.equal((await child({ sessionId: 'child-2' })).refuse.reason, AUTOPILOT_STRINGS.en.used);
  // Another orchestrator (not on Auto): its subagents are never checked; nor a person's own launch.
  await assistant.launch(launch({ sessionId: 'orch-plain', options: { task: '', dataClass: 'default', model: 'off' } }));
  assert.equal(await assistant.launch({ ...launch(), sessionId: 'kid', role: 'subagent', parentSessionId: 'orch-plain', options: { task: '', dataClass: 'default', model: 'off' } }), null);
  assert.equal(await assistant.launch(launch({ sessionId: 'mine', role: 'agent', options: { task: '', dataClass: 'default', model: 'off' } })), null);
  // A non-Auto caller's pick_route keeps the plain values (nothing bound).
  const plain = lastJson(await assistant.tool('pick_route', { ...caller, id: 'orch-plain' }, { task: 'Explain the cache layer', providers }));
  assert.ok(['off', 'auto'].includes(plain.spawn.launchOptions['canvastty-assistant']?.model ?? 'off'));
});

test('OpenCode plan routes are pinned: the model travels in the Assistant\'s value, the launch gets one provider for the model and the small model', async () => {
  assert.deepEqual(JSON.parse(openCodePlanContribution('zai-coding-plan/glm-5.3').files[0].content), { $schema: 'https://opencode.ai/config.json', model: 'zai-coding-plan/glm-5.3', small_model: 'zai-coding-plan/glm-5.3', enabled_providers: ['zai-coding-plan'] });
  assert.equal(openCodePlanContribution('openrouter/z-ai/glm-5.3'), null, 'never OpenRouter');
  const { assistant } = assistantWith();
  assistant.routing.receiveLimits(limitsAnswer({ now: Date.now() }));
  await assistant.launch(launch());
  const caller = { id: 'orch-0001', provider: 'claude', role: 'orchestrator', title: 'o', status: 'idle', cwd: base, workingDirectory: base };
  // Only OpenCode offered: the GLM plan.
  const json = lastJson(await assistant.tool('pick_route', caller, { task: 'Fix a typo in the README', providers: [providers[2]] }));
  assert.equal(json.spawn.provider, 'opencode');
  assert.equal(json.spawn.model, undefined, 'no model next to the Assistant\'s option (CanvasTTY 1.8.2 refuses that)');
  const value = json.spawn.launchOptions['canvastty-assistant'].model;
  assert.match(value, /^r:[a-z0-9]{12}:plan:zai-coding-plan\/glm-5\.3/u);
  const prepared = await assistant.launch({ ...launch(), sessionId: 'glm-child', provider: 'opencode', role: 'subagent', parentSessionId: 'orch-0001', options: { task: '', dataClass: 'default', model: value } });
  assert.equal(prepared.env.OPENCODE_CONFIG, '{launchFiles}/opencode.json');
  assert.deepEqual(JSON.parse(prepared.files[0].content).enabled_providers, ['zai-coding-plan']);
});

// ---------------------------------------------------------------------------------------------------------------
// autopilot_plan (task.shape)
// ---------------------------------------------------------------------------------------------------------------

test('task.shape: Jev\'s answers above 0.6, else word rules; the plan: solo, orchestrate N, deep; the child count is enforced', async () => {
  const view = (level, type = 'coding') => turnView({ difficulty: level === 'small' ? 'simple' : level === 'large' ? 'hard' : 'normal', strong: false, type, confidence: level === 'small' ? 0.9 : 0.1 }, 'jev', '');
  assert.equal(planFor(view('small'), ruleShape('Fix a typo in the README'), { perTaskUsd: 0.5 }).mode, 'solo');
  const list = ruleShape('Do these:\n- add a dark theme\n- add tests for it\n- update the docs');
  assert.deepEqual([list.shape, list.parts], ['independent_parts', 'two_three']);
  assert.deepEqual(planFor(view('medium'), list, { perTaskUsd: 0.5 }), { mode: 'orchestrate', children: 3, deepChildren: 0, strategy: 'single-strong', budgetUsd: 0.5, why: 'independent parts: one subagent per part, at the same time' });
  assert.equal(planFor(view('large'), { shape: 'unclear_large', parts: 'seven_plus', from: 'jev', confidence: 0.8 }, { perTaskUsd: 1 }).mode, 'deep');
  assert.deepEqual(planFor(view('large'), { shape: 'unclear_large', parts: 'seven_plus', from: 'rules', confidence: null }, { perTaskUsd: 1 }).children, 3, 'unsure: orchestrate, at most 3');
  assert.match(planText(planFor(view('medium'), list, { perTaskUsd: 0.5 })), /pick_route .* a spawn without them is refused/u);
  // Jev's typed answers, through a scripted engine: confident → used; unsure → null (word rules).
  const engine = top => ({ ask: async () => ({ fallbackReason: null, answers: { shape: { type: 'choice', choice: 'pipeline', top, probabilities: {} }, parts: { type: 'choice', choice: 'four_six', top: 0.7, probabilities: {} } } }) });
  assert.deepEqual(await askTaskShape(engine(0.8), { task: 'x', dataClass: 'D1' }, {}), { shape: 'pipeline', parts: 'four_six', from: 'jev', confidence: 0.8 });
  assert.equal(await askTaskShape(engine(0.4), { task: 'x', dataClass: 'D1' }, {}), null);
  // The tool on an Auto card: the plan's child count binds the subagent launches.
  const { assistant } = assistantWith();
  assistant.routing.receiveLimits(limitsAnswer({ now: Date.now() }));
  await assistant.launch(launch());
  const caller = { id: 'orch-0001', provider: 'claude', role: 'orchestrator', title: 'o', status: 'idle', cwd: base, workingDirectory: base };
  const planned = await assistant.tool('autopilot_plan', caller, { task: 'Fix a typo in the README' });
  assert.equal(lastJson(planned).mode, 'solo');
  const value = lastJson(await assistant.tool('pick_route', caller, { task: 'Fix a typo in the README', providers })).spawn;
  const refused = await assistant.launch({ ...launch(), sessionId: 'kid-solo', role: 'subagent', parentSessionId: 'orch-0001', provider: value.provider, options: { task: '', dataClass: 'default', model: value.launchOptions['canvastty-assistant'].model } });
  assert.equal(refused.refuse.reason, AUTOPILOT_STRINGS.en['over-plan'], 'solo: no subagent');
  await assistant.tool('autopilot_plan', caller, { task: 'Do these:\n- add a dark theme\n- add tests\n- update the docs' });
  const again = lastJson(await assistant.tool('pick_route', caller, { task: 'add a dark theme', providers })).spawn;
  assert.ok(!(await assistant.launch({ ...launch(), sessionId: 'kid-1', role: 'subagent', parentSessionId: 'orch-0001', provider: again.provider, options: { task: '', dataClass: 'default', model: again.launchOptions['canvastty-assistant'].model } }))?.refuse, 're-planned: room for 3');
});

// ---------------------------------------------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------------------------------------------

test('leaf tasks on servers: off by default; on, a card on a declared server\'s own sign-in, within its parallel cap; only the asking orchestrator sees it', async () => {
  const { assistant, host } = assistantWith();
  const caller = { id: 'orch-0001', provider: 'claude', role: 'orchestrator', title: 'o', status: 'idle', cwd: base, workingDirectory: base };
  assert.match((await assistant.tool('start_leaf', caller, { task: 'Run the benchmarks', cwd: '/srv/p' })).content, /Servers are off/u);
  await assistant.routing.save({ ...plans(), serversOn: true, servers: [{ label: 'ctty-1', clis: ['codex'], maxParallel: 1 }] }, 'en');
  const started = await assistant.tool('start_leaf', caller, { task: 'Run the benchmarks', cwd: '/srv/p' });
  const json = lastJson(started);
  assert.deepEqual(json, { sessionId: 'leaf-1', server: 'ctty-1', provider: 'codex' });
  const create = host.calls.find(call => call.method === 'sessions.create').params;
  assert.deepEqual(create.environment, { pluginId: 'canvastty-environments', kind: 'ssh-host', options: { host: 'ctty-1' } });
  assert.deepEqual(create.launchOptions, { 'canvastty-assistant': { model: 'off' } }, 'nothing from this computer: the server\'s own sign-in');
  assert.deepEqual(host.calls.find(call => call.method === 'sessions.send').params, { sessionId: 'leaf-1', text: 'Run the benchmarks' });
  assert.match((await assistant.tool('start_leaf', caller, { task: 'Another', cwd: '/srv/p' })).content, /No declared server has room/u, 'its cap is 1');
  assert.equal(JSON.parse((await assistant.tool('leaf_status', caller, { sessionId: 'leaf-1' })).content).server, 'ctty-1');
  assert.equal((await assistant.tool('leaf_status', { ...caller, id: 'someone-else' }, { sessionId: 'leaf-1' })).isError, true);
});

// ---------------------------------------------------------------------------------------------------------------
// Egress: OpenRouter only for Jev's own decision calls
// ---------------------------------------------------------------------------------------------------------------

test('egress: with a Jev · OpenRouter key, the only openrouter.ai calls are Jev\'s /api/v1/systemone; Auto, routes and plans send no model call there', async () => {
  const seen = [];
  const transport = async (url, init) => { const u = new URL(String(url)); seen.push({ method: init?.method ?? 'GET', host: u.hostname, path: u.pathname }); return new Response(JSON.stringify({ error: 'offline test' }), { status: 401 }); };
  const key = ['sk', 'or', 'v1', 'a'.repeat(24)].join('-');
  const { assistant } = assistantWith({ transport, secrets: { 'assistant-openrouter': JSON.stringify({ origin: 'https://openrouter.ai', value: key }) },
    settings: { enabled: true, grant: 'D2', dataClassMode: 'off', modes: { 'task.route': 'auto', 'command.review': 'off' }, backends: [{ id: 'openrouter-1', preset: 'openrouter', enabled: true, model: 'typesafe/jev-1.13', trust: 'D2' }] } });
  assistant.routing.receiveLimits(limitsAnswer({ now: Date.now() }));
  await assistant.launch(launch({ options: { task: 'Design the plugin API', dataClass: 'default', model: 'auto' } }));
  const caller = { id: 'orch-0001', provider: 'claude', role: 'orchestrator', title: 'o', status: 'idle', cwd: base, workingDirectory: base };
  await assistant.tool('autopilot_plan', caller, { task: 'Design the plugin API and write its docs' });
  await assistant.tool('pick_route', caller, { task: 'Write the docs', providers });
  assert.deepEqual((await assistant.auto.state()).settings.upstreams, [], 'the Jev key adds no model upstream');
  const openRouter = seen.filter(entry => entry.host === 'openrouter.ai' || entry.host.endsWith('.openrouter.ai'));
  assert.ok(openRouter.length > 0, 'Jev was asked');
  assert.ok(openRouter.every(entry => entry.method === 'POST' && entry.path === '/api/v1/systemone'), JSON.stringify(openRouter));
});
