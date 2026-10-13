// End to end against a CanvasTTY checkout (CANVASTTY_REPO=/path/to/CanvasTTY at the version under test): the built
// package goes through CanvasTTY's own PluginManager (preview, install, native-code trust), its service runs under
// the real PluginServiceSupervisor, and fake cards from a real TerminalManager (with a fake PTY spawner, so no CLI
// runs) reach it through PluginSessions, PluginAgentTools, PluginCards and DecisionHooks, wired as the app wires them.
// No model, no network, no real agent.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const core = process.env.CANVASTTY_REPO;
const root = new URL('../', import.meta.url).pathname;

const waitFor = async (predicate, timeoutMs = 8_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('Condition was not met in time.');
};

function clis() {
  return {
    get(provider) { return { state: 'available', provider, executable: `/resolved/${provider}`, launcher: 'native', environment: { PATH: '/usr/bin' }, checked: [] }; },
    snapshot() { return {}; }
  };
}

/** node-pty stand-in: nothing is spawned. */
function spawner(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return {
      pid: 70_000 + calls.length, process: command, write() {}, resize() {}, kill() {}, pause() {}, resume() {},
      onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }
    };
  };
}

test('the built plugin installs into CanvasTTY\'s PluginManager and its tools, hooks, badges and card actions work', { skip: !core && 'set CANVASTTY_REPO to a CanvasTTY checkout' }, async t => {
  const { PluginManager } = await import(join(core, 'src/main/services/PluginManager.ts'));
  const { PluginServiceSupervisor } = await import(join(core, 'src/main/services/PluginServiceSupervisor.ts'));
  const { PluginAgentTools, pluginToolName } = await import(join(core, 'src/main/services/PluginAgentTools.ts'));
  const { PluginSessions } = await import(join(core, 'src/main/services/PluginSessions.ts'));
  const { PluginCards } = await import(join(core, 'src/main/services/PluginCards.ts'));
  const { DecisionHooks } = await import(join(core, 'src/main/services/DecisionHooks.ts'));
  const { TerminalManager } = await import(join(core, 'src/main/services/TerminalManager.ts'));

  const work = await mkdtemp(join(tmpdir(), 'canvastty-assistant-e2e-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  // The repository as GitHub would serve it: the manifest and every file it declares.
  const manifest = JSON.parse(await readFile(join(root, 'canvastty.plugin.json'), 'utf8'));
  const fixture = join(work, 'repository');
  await mkdir(fixture);
  for (const file of ['canvastty.plugin.json', 'LICENSE', ...manifest.coreFiles.map(entry => entry.path)]) {
    await mkdir(join(fixture, dirname(file)), { recursive: true });
    await cp(join(root, file), join(fixture, file));
  }
  const project = join(work, 'project');
  await mkdir(join(project, '.canvastty', 'flows'), { recursive: true });

  // Install the way Settings → Plugins does: inspect, install, then trust the native code.
  const userData = join(work, 'userData');
  const manager = new PluginManager(userData, async (_url, destination) => cp(fixture, destination, { recursive: true }),
    async (_url, destination, files) => {
      for (const file of files) {
        await mkdir(join(destination, dirname(file.path)), { recursive: true });
        await cp(join(fixture, file.path), join(destination, file.path));
      }
    });
  t.after(() => manager.dispose());
  await manager.load();
  const preview = await manager.previewInstall('https://github.com/example/canvastty-plugin-assistant');
  assert.equal(preview.manifest.id, 'canvastty-assistant');
  assert.ok(!preview.manifest.permissions.includes('model:route'));
  const installed = await manager.install(preview.token);
  assert.equal(installed.enabled, true);
  for (const page of ['settings/harness.html', 'settings/assistant.html', 'apps/flows.html', 'apps/board.html', 'apps/harness.css', 'apps/flows.js']) {
    assert.equal((await manager.protocolResponse(`canvastty-plugin://canvastty-assistant/${page}`)).status, 200, page);
  }
  await manager.setNativeCodeTrusted('canvastty-assistant', true);
  const specs = manager.trustedServiceSpecs();
  assert.equal(specs.length, 1);

  // Cards: a real TerminalManager with a fake PTY; its events feed PluginSessions as in the main process.
  let sessions = null;
  const terminals = new TerminalManager((channel, payload) => sessions?.observe(channel, payload), clis(), undefined, undefined, true, spawner([]));
  const badges = [];
  const surfaceEvents = [];
  let cards = null;
  const supervisor = new PluginServiceSupervisor({
    command: process.execPath, hostVersion: '9.9.9', locale: () => 'en', stopGraceMs: 300,
    host: {
      storageGet: (pluginId, key) => manager.storageGet(pluginId, key),
      storageSet: (pluginId, key, value) => manager.storageSet(pluginId, key, value),
      emit: (_pluginId, _serviceId, event, data) => surfaceEvents.push({ event, data }),
      registerSecrets: () => undefined,
      secretGet: async () => null,
      sessions: (pluginId, serviceId, method, params, granted) => sessions.handle(pluginId, serviceId, method, params, granted),
      setBadge: (pluginId, params) => cards.setBadge(pluginId, params),
      stopped: (pluginId, serviceId) => sessions.serviceStopped(pluginId, serviceId)
    }
  });
  t.after(() => supervisor.dispose());
  sessions = new PluginSessions({ terminals, notify: (pluginId, serviceId, method, params) => supervisor.notify(pluginId, serviceId, method, params) });
  const call = (pluginId, serviceId, method, params, budget) => supervisor.hostCall(pluginId, serviceId, method, params, budget);
  cards = new PluginCards({
    providers: () => manager.cardActionProviders(), trustedPlugins: () => new Set(['canvastty-assistant']), call,
    session: id => sessions.summary(id), redact: text => text, changed: decorations => badges.push(decorations.badges)
  });
  const tools = new PluginAgentTools({ providers: () => manager.agentToolProviders(), call, caller: id => sessions.summary(id), redact: text => text });
  const hooks = new DecisionHooks({
    baseProtection: () => true, services: () => manager.decisionServices(), call,
    session: id => { const s = sessions.summary(id); return s && { provider: s.provider, role: s.role, cwd: s.cwd, configDirs: [], profile: 'normal' }; },
    home: join(work, 'home')
  });

  const orchestrator = terminals.create({ provider: 'claude', cwd: project, profile: 'normal', position: { x: 0, y: 0 }, role: 'orchestrator', title: 'Lead' });
  await supervisor.sync(specs);
  await waitFor(() => sessions.subscribers.size === 1);
  const child = terminals.create({ provider: 'claude', cwd: project, profile: 'normal', position: { x: 0, y: 0 }, role: 'subagent', parentSessionId: orchestrator.id, title: 'Worker' });

  // Tools: listed per role under the plugin's prefix.
  const name = tool => pluginToolName('canvastty-assistant', tool);
  assert.ok(tools.names('orchestrator').includes(name('route')));
  assert.deepEqual(tools.names('subagent').filter(tool => tool.startsWith('canvastty-assistant__')).sort(), [name('task_list'), name('task_update')]);
  const providers = [{ id: 'claude', available: true, signIn: 'ok', subagent: true, model: { supported: true, known: ['claude-haiku-4', 'claude-opus-4'] } }];
  const routed = await tools.call(orchestrator.id, 'orchestrator', name('route'), { task: 'Fix a typo in the README', providers });
  assert.equal(routed.isError, false);
  assert.match(routed.content, /"provider":"claude","model":"claude-haiku-4"/u);
  await assert.rejects(tools.call(orchestrator.id, 'orchestrator', name('route'), { task: 'x', unknownKey: 1 }), /Unexpected argument/u, 'CanvasTTY checks the input schema first');

  // A flow: proposed by the orchestrator, started by the person in the Flow preview card (a surface request).
  const planned = await tools.call(orchestrator.id, 'orchestrator', name('flow_plan'), { flow: 'executor-reviewer', goal: 'CSV export', providers });
  const planId = JSON.parse(planned.content.split('\n').at(-1)).planId;
  await waitFor(() => badges.at(-1)?.[orchestrator.id]?.[0]?.text === 'flow: preview');
  const view = await supervisor.request('canvastty-assistant', 'assistant', 'harness.view', {});
  assert.equal(view.plans[0].id, planId);
  assert.ok(!JSON.stringify(view).includes(project), 'no folder path reaches a page');
  await supervisor.request('canvastty-assistant', 'assistant', 'flows.decide', { planId, decision: 'approved' });
  const status = await tools.call(orchestrator.id, 'orchestrator', name('flow_status'), { planId });
  assert.match(status.content, /The person approved flow "Executor and reviewer"/u);
  assert.ok(surfaceEvents.some(event => event.event === 'changed'));

  // The board: the flow's roles, a subagent claims one.
  const listed = await tools.call(child.id, 'subagent', name('task_list'), {});
  assert.match(listed.content, /0\/2 done/u);
  assert.match((await tools.call(child.id, 'subagent', name('task_update'), { id: 't1', status: 'done' })).content, /Updated t1: done/u);
  await waitFor(() => badges.at(-1)?.[orchestrator.id]?.[0]?.text === 'tasks 1/2');

  // Decision hook: base protection first (core), then the plugin (command review on Warn by default).
  const request = command => ({ requestId: 'req-00000001', provider: 'claude', toolName: 'Bash', toolInput: { command }, toolInputPreview: null, cwd: project, truncated: false });
  const live = () => new AbortController().signal;
  assert.equal((await hooks.decide(child.id, request('sudo ls'), live())).behavior, 'deny');
  assert.equal((await hooks.decide(child.id, request('git status'), live())).behavior, 'none', 'Warn enforces nothing beyond the hard rules');
  // Loop alert: the same command five times without a file write.
  for (let i = 0; i < 5; i++) await hooks.decide(child.id, request('npm test'), live());
  await waitFor(() => badges.at(-1)?.[child.id]?.[0]?.text === 'loop?');

  // Card actions: shown per role, answered as toasts.
  const report = await cards.invoke('canvastty-assistant', 'report', child.id);
  assert.equal(report.tone, 'info');
  assert.match(report.message, /Report: Worker \(claude, subagent\)/u);
  assert.match(report.message, /Loop alerts: 1/u);
  const board = await cards.invoke('canvastty-assistant', 'task-board', orchestrator.id);
  assert.match(board.message, /Task board now shows "Lead" \(1\/2 done\)/u);
  assert.ok(surfaceEvents.some(event => event.event === 'focus' && event.data.board === orchestrator.id));

  // The settings page's four controls go through the service; storage is CanvasTTY's own.
  const settings = await supervisor.request('canvastty-assistant', 'assistant', 'harness.settings', {});
  assert.deepEqual(settings, { commandReview: 'warn', routing: true, loopAlerts: true, flows: true, models: 0 });
  await supervisor.request('canvastty-assistant', 'assistant', 'harness.saveSettings', { settings: { commandReview: 'off', routing: true, loopAlerts: false, flows: true } });
  assert.deepEqual(await manager.storageGet('canvastty-assistant', 'harness'), { routing: true, loopAlerts: false, flows: true });
  assert.equal((await manager.storageGet('canvastty-assistant', 'settings')).modes['command.review'], 'off');
});
