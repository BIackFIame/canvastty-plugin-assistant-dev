// Route v2 against CanvasTTY's own code (CANVASTTY_REPO: run once per core worktree, 1.8.1 main and 1.8.2):
// list_providers comes from core's real `listProviderDirectory`, and every answer (the choice and each alternative)
// goes through core's real `spawn_agent` path: the MCP argument schema, ScopedOrchestrationHandler.spawn (model and
// effort checks, profile), AgentControlService (1.8.2: launch-option inheritance and its refusals), and
// LaunchPipeline.normalizeOptions + prepare (delegable fields, a model next to options that set the model, two
// plugins setting the model). Only the terminal itself is a stand-in, and the two plugins' prepare answers are shaped
// like theirs (the Assistant's is its own `openCodeContribution`). Offline replay over realistic provider sets: no
// model is called, nothing is spent. The answer must be refused 0 times.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouteService } from '../src/route/service.ts';
import { openCodeContribution } from '../src/auto/launch.ts';
import { manifestForCore } from './helpers/core-manifest.mjs';
import { accountRows, catalog, declared, index, limitsAnswer, NOW } from './helpers/route-fixtures.mjs';
import { DEFAULT_ROUTE_SETTINGS } from '../src/route/settings.ts';

const core = process.env.CANVASTTY_REPO;
const root = new URL('../', import.meta.url).pathname;
const base = realpathSync(mkdtempSync(join(tmpdir(), 'canvastty-route-core-')));
process.on('exit', () => rmSync(base, { recursive: true, force: true }));
const project = join(base, 'project');
mkdirSync(project, { recursive: true });

/** The Accounts plugin's launch block (canvastty-plugin-accounts canvastty.plugin.json, delegable). */
const ACCOUNTS_LAUNCH = {
  appliesTo: ['claude', 'codex', 'opencode', 'qwen', 'kimi', 'grok'],
  fields: [
    { key: 'account', label: 'Model account', kind: 'select', optionsFrom: 'service', default: 'none', options: [{ value: 'none', label: 'The agent\'s own sign-in' }] },
    { key: 'effort', label: 'Reasoning effort', kind: 'select', default: 'default', options: ['default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(value => ({ value, label: value })) },
    { key: 'trustFolder', label: 'I trust this folder', kind: 'boolean', default: false }
  ],
  delegable: true
};

/** Tasks an orchestrator hands out, with the view Jev would give (type, difficulty, p(small)); null: word rules. */
const TASKS = [
  ['Fix the typo in README.md', { difficulty: 'simple', strong: false, type: 'writing', confidence: 0.93 }],
  ['Rename the helper parseArgs to parseArguments across src/', { difficulty: 'normal', strong: false, type: 'coding', confidence: 0.71 }],
  ['Add a CSV export button to the reports table with tests', { difficulty: 'normal', strong: false, type: 'coding', confidence: 0.31 }],
  ['Find the cause of the intermittent deadlock in the scheduler', { difficulty: 'hard', strong: false, type: 'coding', confidence: 0.05 }],
  ['Design the migration of the session store to SQLite', { difficulty: 'hard', strong: true, type: 'coding', confidence: 0.02 }],
  ['Review the diff of the auth middleware for security problems', { difficulty: 'normal', strong: false, type: 'review', confidence: 0.4 }],
  ['Explain how Raft differs from Paxos in four bullets', { difficulty: 'simple', strong: false, type: 'research', confidence: 0.75 }],
  ['Сделай сводку изменений за неделю для changelog', null]
];

const ALL = ['claude', 'codex', 'opencode', 'grok', 'qwen', 'kimi', 'hermes'];
/** Realistic machines: what is installed, signed in, declared, read. */
const SCENARIOS = [
  { name: 'everything: Max + Pro + GLM plan, accounts, Auto, fresh windows', installed: ALL, settings: () => declared(), accounts: true, rows: accountRows, auto: true, limits: () => limitsAnswer() },
  { name: 'fresh install: nothing declared, nothing read', installed: ['claude', 'codex'], settings: () => structuredClone(DEFAULT_ROUTE_SETTINGS), accounts: false, rows: () => [], auto: false, limits: () => null },
  { name: 'Max used up, Codex burning, windows stale', installed: ALL, settings: () => declared(), accounts: true, rows: accountRows, auto: true, limits: () => limitsAnswer({ claude: 95, codex: 70, codexElapsed: 0.3, fetchedAt: NOW - 45 * 60_000 }) },
  { name: 'OpenCode only, coding plan + Auto, no Accounts plugin', installed: ['opencode'], settings: () => declared({ plans: [declared().plans[2]] }), accounts: false, rows: () => [], auto: true, limits: () => null },
  { name: 'new models: provisional and exploration on', installed: ALL, settings: () => declared({ newModels: 'explore', exploreShare: 0.2, pins: { 'glm-5-3-flash': 'small' }, boosts: { 'claude-sonnet-5': 3 } }), accounts: true, rows: accountRows, auto: true, limits: () => limitsAnswer() },
  { name: 'signed out of Claude, Kimi and Qwen declared with unknown windows', installed: ALL, signIn: { claude: 'signed_out' }, settings: () => declared({ plans: [...declared().plans, { id: 'kimi', cli: 'kimi', kind: 'subscription', label: 'Kimi', models: ['kimi-k3'], reserve: 20, maxParallel: 2, allow: 'prefer', trust: 'D2' }, { id: 'qwen', cli: 'qwen', kind: 'subscription', label: 'Qwen', models: [], reserve: 20, maxParallel: 1, allow: 'allow', trust: 'D2' }] }), accounts: true, rows: accountRows, auto: true, limits: () => limitsAnswer() }
];

/** Orchestrators: their CLI and the launch options the person started them with (and which of those set the model). */
const ORCHESTRATORS = [
  { id: 'orch-claude-plain', provider: 'claude', options: undefined, modelSetBy: [] },
  { id: 'orch-claude-account', provider: 'claude', options: { 'canvastty-accounts': { account: 'or-opus', effort: 'default', trustFolder: false } }, modelSetBy: ['canvastty-accounts'], needs: 'canvastty-accounts' },
  { id: 'orch-opencode-auto', provider: 'opencode', options: { 'canvastty-assistant': { task: '', dataClass: 'default', model: 'auto' } }, modelSetBy: ['canvastty-assistant'] },
  { id: 'orch-codex-plain', provider: 'codex', options: undefined, modelSetBy: [] }
];

test('route answers pass CanvasTTY\'s real listProviderDirectory and spawn_agent validation: 0 refusals over the offline replay', { skip: !core && 'set CANVASTTY_REPO to a CanvasTTY checkout' }, async () => {
  const { listProviderDirectory } = await import(join(core, 'src/main/services/providerDirectory.ts'));
  const { ScopedOrchestrationHandler } = await import(join(core, 'src/main/services/agent-browser/OrchestrationTools.ts'));
  const { AgentControlService } = await import(join(core, 'src/main/services/AgentControlService.ts'));
  const { LaunchPipeline } = await import(join(core, 'src/main/services/LaunchPipeline.ts'));
  const { validatePluginManifest } = await import(join(core, 'src/main/services/PluginManager.ts'));
  const { pluginToolName } = await import(join(core, 'src/main/services/PluginAgentTools.ts'));
  const { validateOrchestrationArguments } = await import(join(core, 'src/agent-browser/orchestration-catalog.mjs'));
  const manifest = JSON.parse(readFileSync(join(root, 'canvastty.plugin.json'), 'utf8'));
  const assistant = validatePluginManifest(manifestForCore(validatePluginManifest, manifest).manifest);
  const is182 = typeof AgentControlService.prototype.subagentLaunchOptions === 'function';

  let total = 0;
  const refusals = [];
  const servedBy = [];
  const kinds = {};
  for (const scenario of SCENARIOS) {
    const contributors = [
      { pluginId: 'canvastty-assistant', pluginName: 'CanvasTTY Assistant', serviceId: 'assistant', launch: assistant.services[0].launch, secrets: true },
      ...(scenario.accounts ? [{ pluginId: 'canvastty-accounts', pluginName: 'CanvasTTY Accounts', serviceId: 'accounts', launch: ACCOUNTS_LAUNCH, secrets: true }] : [])
    ];
    const known = { opencode: ['opencode/big-pickle', 'zai-coding-plan/glm-5.3', 'zai-coding-plan/glm-5.3-flash'] };
    const limits = scenario.limits();
    const sources = {
      cli: id => scenario.installed.includes(id) ? 'available' : 'unavailable',
      limits: () => limits ? { ...limits.snapshot, providers: limits.snapshot.providers.filter(p => !(scenario.signIn?.[p.provider] === 'signed_out')).concat(Object.entries(scenario.signIn ?? {}).map(([provider]) => ({ provider, state: 'unavailable', source: 'claude-usage-api', checkedAt: NOW, reason: 'not-authenticated' }))) } : null,
      models: id => known[id] ? { models: known[id], checkedAt: NOW } : null,
      checkModel: async (id, model) => known[id] && !known[id].includes(model) ? `${model} is not in opencode models.` : null,
      launchContributors: () => contributors.map(c => ({ pluginId: c.pluginId, pluginName: c.pluginName, launch: c.launch })),
      containment: () => false
    };
    const tools = [...['route', 'pick_route', 'route_outcome'].map(name => pluginToolName('canvastty-assistant', name)), ...(scenario.accounts ? ['list_routes', 'pick_account'].map(name => pluginToolName('canvastty-accounts', name)) : [])];
    const directory = listProviderDirectory(sources, tools);
    assert.match(directory.note, /canvastty-assistant__pick_route/u, 'list_providers().note names pick_route');

    // The plugins' prepare answers, shaped like theirs.
    const call = async (pluginId, _serviceId, _method, params) => {
      if (pluginId === 'canvastty-assistant') return params.options.model === 'auto' ? openCodeContribution({ port: 49_152, token: `sk-ctty-${'A'.repeat(43)}`, limit: { context: 128_000, output: 8_192 }, providerId: 'ctty-jev-test' }) : null;
      if (pluginId === 'canvastty-accounts') return params.options.account && params.options.account !== 'none' ? { env: {}, args: ['--model', params.provider === 'opencode' ? 'acct/model' : 'acct-model'], files: [] } : null;
      throw new Error(`unexpected plugin ${pluginId}`);
    };
    const pipeline = new LaunchPipeline({ contributors: () => contributors, call, secret: async () => null, runsRoot: join(base, 'runs') });
    for (const orchestrator of ORCHESTRATORS) {
      if (!scenario.installed.includes(orchestrator.provider)) continue;
      if (orchestrator.needs && !contributors.some(c => c.pluginId === orchestrator.needs)) continue;
      const terminals = fakeTerminals(pipeline, contributors);
      terminals.add({ id: orchestrator.id, provider: orchestrator.provider, role: 'orchestrator', cwd: project, profile: 'normal' }, orchestrator.options, orchestrator.modelSetBy);
      const control = new AgentControlService(terminals, { limits: () => ({ maxDepth: 3, maxSubagents: 64 }), containment: () => false, userDataPath: join(base, 'userData') });
      const handler = new ScopedOrchestrationHandler(control, null, sources);
      const route = new RouteService({
        host: { callHost: async () => null, log() {}, emit() {} }, dataDir: mkdtempSync(join(base, 'data-')), saved: scenario.settings(),
        enabled: () => true,
        classify: async task => TASKS.find(([text]) => text === task)?.[1] ?? null,
        catalog: () => ({ catalog: catalog(), index: index() }), preference: () => 'balanced',
        autoExpectation: async () => scenario.auto ? { model: 'z-ai/glm-5.3', identity: 'glm-5-3', effort: 'max', priceIn: 0.6, priceOut: 2.2, trusted: true } : null,
        cardClass: () => 'D1', dataClassMode: () => 'warn', now: () => NOW, random: () => 0.1
      });
      if (limits) route.receiveLimits(limits);
      const caller = { id: orchestrator.id, provider: orchestrator.provider, role: 'orchestrator' };
      for (const [n, [task]] of TASKS.entries()) {
        // The full lists once; later calls send only the task (the service keeps the lists), as a compact orchestrator does.
        const lists = n === 0 ? { providers: directory.providers, ...(scenario.accounts ? { accountRoutes: scenario.rows() } : {}) } : {};
        const answer = await route.tool('pick_route', caller, { task, ...lists });
        assert.notEqual(answer.isError, true, answer.content);
        if (/^No route is usable now/u.test(answer.content)) continue;
        const json = JSON.parse(answer.content.split('\n').at(-1));
        assert.doesNotMatch(answer.content, new RegExp(task.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), 'the answer never repeats the task');
        for (const option of [json, ...json.alternatives]) {
          total++;
          kinds[option.kind] = (kinds[option.kind] ?? 0) + 1;
          const args = { ...option.spawn, cwd: project, title: 'Worker' };
          const where = `${scenario.name} / ${orchestrator.id} / ${task.slice(0, 30)} → ${JSON.stringify(option.spawn)}`;
          const schema = validateOrchestrationArguments('spawn_agent', args);
          if (!schema.ok) { refusals.push(`${where}: ${schema.error}`); continue; }
          try {
            const spawned = await handler.execute(orchestrator.id, { tool: 'spawn_agent', arguments: schema.value ?? args });
            const launch = terminals.last();
            const prepared = launch.options && Object.keys(launch.options).length ? await pipeline.prepare({ sessionId: spawned.sessionId, provider: launch.request.provider, profile: 'normal', role: 'subagent', cwd: project, parentSessionId: orchestrator.id, restoring: false, resume: false, environment: null, options: launch.options }, launch.request.model !== undefined ? { model: launch.request.model } : {}) : { ok: true, cleanup: async () => undefined };
            if (!prepared.ok) refusals.push(`${where}: launch ${prepared.reason}`);
            else { await prepared.cleanup?.(); if (spawned.servedBy) servedBy.push(spawned.servedBy); }
            // Closed again, so the next option does not count against the 16 cards one orchestrator may have.
            terminals.remove(spawned.sessionId);
          } catch (error) { refusals.push(`${where}: ${error?.message ?? error}`); }
        }
      }
    }
  }
  assert.deepEqual(refusals, [], `${refusals.length} of ${total} spawns refused`);
  assert.ok(total >= 150, `${total} spawn values checked`);
  if (is182) {
    assert.ok(servedBy.length > 0);
    assert.ok(servedBy.every(s => Object.values(s.launchOptions).every(source => source === 'explicit')), 'every model-setting plugin was named: nothing inherited');
  }
  assert.ok(['subscription', 'coding-plan', 'account', 'auto', 'cli-default'].every(kind => kinds[kind] > 0), `every kind of route is exercised: ${JSON.stringify(kinds)}`);
  console.log(`route-core: ${total} spawn values (${JSON.stringify(kinds)}) from ${SCENARIOS.length} provider sets × ${ORCHESTRATORS.length} orchestrators × ${TASKS.length} tasks, 0 refused (core ${is182 ? '1.8.2' : '1.8.1'})`);
});

test('the same core path does refuse what route v1 answered (control: the check above can fail)', { skip: !core && 'set CANVASTTY_REPO to a CanvasTTY checkout' }, async () => {
  const { ScopedOrchestrationHandler } = await import(join(core, 'src/main/services/agent-browser/OrchestrationTools.ts'));
  const { AgentControlService } = await import(join(core, 'src/main/services/AgentControlService.ts'));
  const { LaunchPipeline } = await import(join(core, 'src/main/services/LaunchPipeline.ts'));
  const { validatePluginManifest } = await import(join(core, 'src/main/services/PluginManager.ts'));
  const manifest = JSON.parse(readFileSync(join(root, 'canvastty.plugin.json'), 'utf8'));
  const assistant = validatePluginManifest(manifestForCore(validatePluginManifest, manifest).manifest);
  const contributors = [{ pluginId: 'canvastty-assistant', pluginName: 'CanvasTTY Assistant', serviceId: 'assistant', launch: assistant.services[0].launch, secrets: true }];
  const call = async (_p, _s, _m, params) => params.options.model === 'auto' ? openCodeContribution({ port: 49_152, token: `sk-ctty-${'A'.repeat(43)}`, limit: { context: 128_000, output: 8_192 }, providerId: 'ctty-jev-test' }) : null;
  const pipeline = new LaunchPipeline({ contributors: () => contributors, call, secret: async () => null, runsRoot: join(base, 'runs-control') });
  const terminals = fakeTerminals(pipeline, contributors);
  terminals.add({ id: 'orch-auto', provider: 'opencode', role: 'orchestrator', cwd: project, profile: 'normal' }, { 'canvastty-assistant': { task: '', dataClass: 'default', model: 'auto' } }, ['canvastty-assistant']);
  const handler = new ScopedOrchestrationHandler(new AgentControlService(terminals, { limits: () => ({ maxDepth: 3, maxSubagents: 64 }), userDataPath: join(base, 'userData') }), null, { cli: () => 'available', limits: () => null });
  const refusal = async (spawn) => {
    try {
      const spawned = await handler.execute('orch-auto', { tool: 'spawn_agent', arguments: { ...spawn, cwd: project } });
      const launch = terminals.last();
      const prepared = launch.options ? await pipeline.prepare({ sessionId: spawned.sessionId, provider: spawn.provider, profile: 'normal', role: 'subagent', cwd: project, parentSessionId: 'orch-auto', restoring: false, resume: false, environment: null, options: launch.options }, spawn.model ? { model: spawn.model } : {}) : { ok: true };
      terminals.remove(spawned.sessionId);
      return prepared.ok ? null : prepared.reason;
    } catch (error) { return error.message; }
  };
  const is182 = typeof AgentControlService.prototype.subagentLaunchOptions === 'function';
  // Route v1's answers to an orchestrator on Auto: another CLI with nothing named, and a model next to the inherited Auto option.
  const crossCli = await refusal({ provider: 'claude', model: 'claude-opus-4' });
  const modelNextToAuto = await refusal({ provider: 'opencode', model: 'zai/glm-pro' });
  if (is182) {
    assert.match(crossCli ?? '', /a claude subagent would not get that model/u);
    assert.match(modelNextToAuto ?? '', /cannot also take model/u);
  }
  assert.match(await refusal({ provider: 'opencode', model: 'zai/glm-pro', launchOptions: { 'canvastty-assistant': { model: 'auto' } } }) ?? (is182 ? '' : 'main has no model-next-to-options rule'), is182 ? /sets the model of this launch, and the launch also asks for model/u : /main has no/u);
  // Route v2's form of the same choices passes.
  assert.equal(await refusal({ provider: 'claude', model: 'opus', launchOptions: { 'canvastty-assistant': { model: 'off' } } }), null);
  assert.equal(await refusal({ provider: 'opencode', launchOptions: { 'canvastty-assistant': { model: 'auto' } } }), null);
});

/** The terminal manager as far as AgentControlService and spawn_agent use it; launch options go through the real pipeline. */
function fakeTerminals(pipeline, contributors) {
  const sessions = new Map();
  let n = 0;
  let last = null;
  const meta = (s) => ({ id: s.id, provider: s.provider, role: s.role, parentSessionId: s.parentSessionId, cwd: s.cwd, profile: s.profile, status: 'idle', exitCode: null, startedAt: s.startedAt, position: { x: 0, y: 0 }, title: s.title ?? s.id, ...(s.model ? { model: s.model } : {}), ...(s.effort ? { effort: s.effort } : {}) });
  return {
    add(session, options, modelSetBy) { sessions.set(session.id, { ...session, startedAt: n++, options, modelSetBy }); },
    last: () => last,
    remove: id => { sessions.delete(id); },
    getMetadata: id => sessions.has(id) ? meta(sessions.get(id)) : null,
    listMetadata: () => [...sessions.values()].map(meta),
    launchOptionsOf: id => sessions.get(id)?.options ? structuredClone(sessions.get(id).options) : undefined,
    modelSetByOf: id => [...(sessions.get(id)?.modelSetBy ?? [])],
    unavailableLaunchPlugins: options => Object.keys(options ?? {}).filter(id => !contributors.some(c => c.pluginId === id)),
    create(request) {
      const parent = request.parentSessionId ? sessions.get(request.parentSessionId) : undefined;
      const inherited = parent && parent.provider === request.provider ? parent.options : undefined;
      const options = request.launchOptions === undefined ? undefined : pipeline.normalizeOptions(request.provider, request.launchOptions, { delegated: true, ...(inherited ? { inherited } : {}) });
      const id = `sub-${n}`;
      sessions.set(id, { id, provider: request.provider, role: 'subagent', parentSessionId: request.parentSessionId, cwd: request.cwd, profile: request.profile, startedAt: n++, options, modelSetBy: [], model: request.model, effort: request.effort });
      last = { request, options };
      return meta(sessions.get(id));
    }
  };
}
