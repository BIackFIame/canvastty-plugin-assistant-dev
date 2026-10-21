// Model: Auto (Jev) end to end against a CanvasTTY checkout (CANVASTTY_REPO): the built package is installed by
// CanvasTTY's PluginManager, its service runs under the real PluginServiceSupervisor, and a real TerminalManager
// (fake PTY: no CLI runs) launches OpenCode cards through the real LaunchPipeline with "Model: Auto (Jev)". The
// spawned process gets the run-folder OpenCode config and the per-launch key; the router answers that key against a
// fake upstream; refusals reach the card; the key dies when the card closes. No model, no network beyond loopback.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { manifestForCore } from './helpers/core-manifest.mjs';
import { startFakeUpstream } from './helpers/fake-upstream.mjs';
import { aaHtml, livebenchCategories, livebenchCsv, modelsDev } from './helpers/catalog-fixtures.mjs';
import { normalizeArtificialAnalysis } from '../src/auto/catalog/artificialAnalysis.ts';
import { normalizeBenchmarks, normalizeModels, RATINGS_CACHE_FILE } from '../src/auto/catalog/catalog.ts';

const core = process.env.CANVASTTY_REPO;
const root = new URL('../', import.meta.url).pathname;

const waitFor = async (predicate, timeoutMs = 8_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
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

function spawner(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return {
      pid: 71_000 + calls.length, process: command, write() {}, resize() {}, kill() {}, pause() {}, resume() {},
      onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }
    };
  };
}

test('Model: Auto (Jev) through CanvasTTY: install, launch an OpenCode card, route a call, refusals, key dead after close', { skip: !core && 'set CANVASTTY_REPO to a CanvasTTY checkout' }, async t => {
  const { PluginManager, validatePluginManifest } = await import(join(core, 'src/main/services/PluginManager.ts'));
  const { PluginServiceSupervisor } = await import(join(core, 'src/main/services/PluginServiceSupervisor.ts'));
  const { PluginSessions } = await import(join(core, 'src/main/services/PluginSessions.ts'));
  const { PluginCards } = await import(join(core, 'src/main/services/PluginCards.ts'));
  const { PluginAgentTools, pluginToolName } = await import(join(core, 'src/main/services/PluginAgentTools.ts'));
  const { TerminalManager } = await import(join(core, 'src/main/services/TerminalManager.ts'));
  const { LaunchPipeline } = await import(join(core, 'src/main/services/LaunchPipeline.ts'));

  const work = await mkdtemp(join(tmpdir(), 'canvastty-auto-e2e-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const fakeHome = join(work, 'home');
  await mkdir(fakeHome, { recursive: true });
  const homeVars = {
    HOME: fakeHome, USERPROFILE: fakeHome, XDG_CONFIG_HOME: join(fakeHome, '.config'), XDG_DATA_HOME: join(fakeHome, '.local/share'),
    XDG_CACHE_HOME: join(fakeHome, '.cache'), XDG_STATE_HOME: join(fakeHome, '.local/state'), CODEX_HOME: join(fakeHome, '.codex'),
    GROK_HOME: join(fakeHome, '.grok'), CLAUDE_CONFIG_DIR: join(fakeHome, '.claude')
  };
  const savedEnv = Object.fromEntries(Object.keys(homeVars).map(key => [key, process.env[key]]));
  Object.assign(process.env, homeVars);
  t.after(() => { for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

  const upstream = await startFakeUpstream();
  t.after(() => upstream.close());

  const manifest = JSON.parse(await readFile(join(root, 'canvastty.plugin.json'), 'utf8'));
  const fixture = join(work, 'repository');
  for (const file of ['LICENSE', ...manifest.coreFiles.map(entry => entry.path)]) {
    await mkdir(join(fixture, dirname(file)), { recursive: true });
    await cp(join(root, file), join(fixture, file));
  }
  await writeFile(join(fixture, 'canvastty.plugin.json'), JSON.stringify(manifestForCore(validatePluginManifest, manifest).manifest, null, 2));
  const project = join(work, 'project');
  await mkdir(join(project, '.git'), { recursive: true });
  const zenProject = join(work, 'zen-project');
  await mkdir(join(zenProject, '.git'), { recursive: true });
  await writeFile(join(zenProject, 'opencode.json'), '{"model":"opencode/big-pickle"}');

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
  const checked = preview.manifest.services[0].launch;
  assert.equal(checked.delegable, true, 'the core keeps delegable');
  assert.deepEqual(checked.fields.find(field => field.key === 'model').options.map(option => option.value), ['off', 'auto']);
  await manager.install(preview.token);
  await manager.setNativeCodeTrusted('canvastty-assistant', true);

  // The plugin's secrets, as the page would write them (the upstream key bound to its origin).
  const secrets = new Map([['auto-upstream-fake', JSON.stringify({ origin: new URL(upstream.url).origin, value: 'up-key' })]]);
  let sessions = null;
  const spawned = [];
  const terminals = new TerminalManager((channel, payload) => sessions?.observe(channel, payload), clis(), undefined, undefined, true, spawner(spawned));
  let cards = null;
  const badges = [];
  const supervisor = new PluginServiceSupervisor({
    command: process.execPath, hostVersion: '9.9.9', locale: () => 'en', stopGraceMs: 300,
    host: {
      storageGet: (pluginId, key) => manager.storageGet(pluginId, key),
      storageSet: (pluginId, key, value) => manager.storageSet(pluginId, key, value),
      emit: () => undefined,
      registerSecrets: () => undefined,
      secretGet: async (_pluginId, key) => secrets.get(key) ?? null,
      sessions: (pluginId, serviceId, method, params, granted) => sessions.handle(pluginId, serviceId, method, params, granted),
      setBadge: (pluginId, params) => cards.setBadge(pluginId, params),
      stopped: (pluginId, serviceId) => sessions.serviceStopped(pluginId, serviceId)
    }
  });
  t.after(() => supervisor.dispose());
  sessions = new PluginSessions({ terminals, notify: (pluginId, serviceId, method, params) => supervisor.notify(pluginId, serviceId, method, params) });
  const call = (pluginId, serviceId, method, params, budget) => supervisor.hostCall(pluginId, serviceId, method, params, budget);
  let cardLocale = 'en';
  cards = new PluginCards({
    providers: () => manager.cardActionProviders(), trustedPlugins: () => new Set(['canvastty-assistant']), call,
    session: id => sessions.summary(id), redact: text => text, changed: decorations => badges.push(decorations.badges),
    // CanvasTTY with the language in card actions (older cores ignore it).
    locale: () => cardLocale
  });
  const tools = new PluginAgentTools({ providers: () => manager.agentToolProviders(), call, caller: id => sessions.summary(id), redact: text => text });
  const runsRoot = join(userData, 'launch-runs');
  terminals.configureLaunchPipeline(new LaunchPipeline({
    contributors: () => manager.launchContributors(), call, secret: async (_pluginId, key) => secrets.get(key) ?? null, runsRoot
  }));
  // A catalog the service already downloaded (fresh, so nothing is due: the service fetches nothing).
  const catalogAt = Date.now() - 60_000;
  const { models: catalogModels, providers } = normalizeModels(modelsDev());
  await mkdir(join(userData, 'plugin-data', 'canvastty-assistant', 'auto'), { recursive: true });
  await writeFile(join(userData, 'plugin-data', 'canvastty-assistant', 'auto', RATINGS_CACHE_FILE), JSON.stringify({
    version: 2, fetchedAt: catalogAt, modelsFetchedAt: catalogAt, models: catalogModels, providers, sourceErrors: {},
    benchmarks: [...normalizeArtificialAnalysis(aaHtml(), catalogAt), ...normalizeBenchmarks(livebenchCsv(), livebenchCategories(), '2026-10-01', catalogAt)]
  }));
  await supervisor.sync(manager.trustedServiceSpecs());
  await waitFor(() => sessions.subscribers.size === 1);

  // The person configures an upstream on the Decision models page.
  await supervisor.request('canvastty-assistant', 'assistant', 'auto.save', { settings: {
    upstreams: [{ id: 'fake', preset: 'openai-compatible', baseUrl: upstream.url, trust: 'D2', key: 'own', enabled: true, models: [{ id: 'vendor/small', tier: 'small' }, { id: 'vendor/medium', tier: 'medium' }, { id: 'vendor/large', tier: 'large' }] }],
    preference: 'balanced', cheaperFallback: false, decider: 'rules', dailyUsdCap: 1, perCardUsdCap: 0.5, catalog: { autoRefresh: false, refreshHours: 168 }
  } });
  assert.equal((await manager.storageGet('canvastty-assistant', 'autoRouting')).upstreams[0].id, 'fake');
  const state = await supervisor.request('canvastty-assistant', 'assistant', 'auto.state', {});
  assert.deepEqual(state.keys, { fake: true });
  assert.ok(!JSON.stringify(state).includes('up-key'));

  // Launch an OpenCode orchestrator with Model: Auto (Jev).
  const card = terminals.create({ provider: 'opencode', cwd: project, profile: 'normal', position: { x: 0, y: 0 }, role: 'orchestrator', title: 'Lead', launchOptions: { 'canvastty-assistant': { model: 'auto' } } });
  const started = await waitFor(() => spawned.find(entry => entry.options?.env?.CTTY_JEV_ROUTER_KEY));
  const env = started.options.env;
  const token = env.CTTY_JEV_ROUTER_KEY;
  assert.match(token, /^sk-ctty-[A-Za-z0-9_-]{43}$/u);
  assert.ok(env.OPENCODE_CONFIG.startsWith(runsRoot), 'the config is in the run folder');
  assert.equal(statSync(env.OPENCODE_CONFIG).mode & 0o777, 0o600);
  const config = JSON.parse(readFileSync(env.OPENCODE_CONFIG, 'utf8'));
  const [providerId] = Object.keys(config.provider);
  assert.deepEqual(config.enabled_providers, [providerId], 'OpenCode Zen and every other provider are off');
  assert.equal(config.small_model, `${providerId}/auto-small`);
  assert.ok(!readFileSync(env.OPENCODE_CONFIG, 'utf8').includes(token), 'the key is not in the file');
  const modelAt = started.args.indexOf('--model');
  assert.equal(started.args[modelAt + 1], `${providerId}/auto`);

  // The CLI's call, as OpenCode makes it: routed to the upstream, streamed back.
  const port = Number(/127\.0\.0\.1:(\d+)/u.exec(config.provider[providerId].options.baseURL)[1]);
  const ask = (key, text) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: text }] }) });
  const answer = await ask(token, 'Fix a typo in the readme');
  assert.equal(answer.status, 200);
  assert.match(await answer.text(), /data: \[DONE\]/u);
  // A small task, but this card is an orchestrator: its turns are never below medium.
  assert.equal(upstream.posts().at(-1).model, 'vendor/medium');
  assert.equal(upstream.posts().at(-1).auth, 'Bearer up-key');
  await waitFor(() => badges.at(-1)?.[card.id]?.[0]?.text === 'medium');
  assert.equal((await ask('sk-ctty-' + 'A'.repeat(43), 'x')).status, 401);

  // route hands out Auto for an OpenCode subagent of this orchestrator; the subagent launched with it inherits the class.
  const routed = await tools.call(card.id, 'orchestrator', pluginToolName('canvastty-assistant', 'route'), { task: 'Rename a helper', providers: [{ id: 'opencode', available: true, subagent: true, model: { supported: true, known: ['a/b'] } }] });
  assert.match(routed.content, /"launchOptions":\{"canvastty-assistant":\{"model":"r:[a-z0-9]{12}:auto"\}\}/u);
  // Auto (Jev) routes every subagent: a plain "auto" (or nothing) is refused with what to do; the routed value starts it.
  const unrouted = terminals.create({ provider: 'opencode', cwd: project, profile: 'normal', position: { x: 0, y: 0 }, role: 'subagent', parentSessionId: card.id, title: 'Unrouted', launchOptions: { 'canvastty-assistant': { model: 'auto' } } });
  const unroutedState = await waitFor(() => { const s = terminals.list().find(entry => entry.id === unrouted.id); return s?.failureDetails || s?.status === 'failed' ? s : null; });
  assert.match(JSON.stringify(unroutedState), /call canvastty-assistant__pick_route/u);
  const routedSpawn = JSON.parse(routed.content.split('\n').at(-1)).spawn;
  const child = terminals.create({ provider: 'opencode', cwd: project, profile: 'normal', position: { x: 0, y: 0 }, role: 'subagent', parentSessionId: card.id, title: 'Worker', launchOptions: routedSpawn.launchOptions });
  const childStarted = await waitFor(() => spawned.find(entry => entry.options?.env?.CTTY_JEV_ROUTER_KEY && entry.options.env.CTTY_JEV_ROUTER_KEY !== token));
  assert.notEqual(childStarted.options.env.CTTY_JEV_ROUTER_KEY, token, 'each card has its own key');

  // Refusals reach the card: a project whose OpenCode config picks a model, and a CLI Auto does not run on.
  const refused = terminals.create({ provider: 'opencode', cwd: zenProject, profile: 'normal', position: { x: 0, y: 0 }, role: 'agent', title: 'Zen', launchOptions: { 'canvastty-assistant': { model: 'auto' } } });
  const refusedState = await waitFor(() => { const s = terminals.list().find(entry => entry.id === refused.id); return s?.failureDetails || s?.status === 'failed' ? s : null; });
  assert.match(JSON.stringify(refusedState), /This project's OpenCode config chooses its own model/u);
  const codex = terminals.create({ provider: 'kimi', cwd: project, profile: 'normal', position: { x: 0, y: 0 }, role: 'agent', title: 'Codex', launchOptions: { 'canvastty-assistant': { model: 'auto' } } });
  const codexState = await waitFor(() => { const s = terminals.list().find(entry => entry.id === codex.id); return s?.failureDetails || s?.status === 'failed' ? s : null; });
  assert.match(JSON.stringify(codexState), /works on Claude Code and Codex/u);

  // A card closes: its key dies at once; the other card's still works. The last one closes the port.
  const childKey = childStarted.options.env.CTTY_JEV_ROUTER_KEY;
  terminals.dispose(child.id);
  await waitFor(async () => (await ask(childKey, 'x').then(r => r.status, () => 0)) === 401);
  assert.equal((await ask(token, 'Fix a typo')).status, 200);
  terminals.dispose(card.id);
  await waitFor(async () => (await ask(token, 'x').then(r => r.status, () => 'refused')) === 'refused');
  await assert.rejects(ask(childKey, 'x'), /fetch failed/u, 'nothing listens once no card uses Auto');
  // Only the configured upstream was contacted.
  const stats = await supervisor.request('canvastty-assistant', 'assistant', 'auto.state', {});
  assert.deepEqual(stats.stats.hosts, [`127.0.0.1:${upstream.port}`]);
  assert.ok(stats.recent.every(record => !JSON.stringify(record).includes('typo')), 'no text in the decisions');

  // From data: the person lists model ids without tiers; the service scores them from its catalog cache and the
  // router picks the best coding score (alpha-1 at high effort, 57.5) over a cheaper one (beta-2, 55) and an unknown one.
  await supervisor.request('canvastty-assistant', 'assistant', 'auto.save', { settings: {
    upstreams: [{ id: 'fake', preset: 'openai-compatible', baseUrl: upstream.url, trust: 'D2', key: 'own', enabled: true,
      models: [{ id: 'vendor/beta-2', priceIn: 0.5, priceOut: 2 }, { id: 'vendor/alpha-1', effort: 'high', priceIn: 1, priceOut: 4 }, { id: 'vendor/mystery', priceIn: 0.01, priceOut: 0.01 }] }],
    preference: 'best', cheaperFallback: false, decider: 'rules', dailyUsdCap: 1, perCardUsdCap: 0.5, catalog: { autoRefresh: false, refreshHours: 168 }
  } });
  const scored = await supervisor.request('canvastty-assistant', 'assistant', 'auto.state', {});
  assert.equal(scored.catalog.bundled, false, 'the cache, not the bundled snapshot');
  assert.equal(scored.catalog.sources.find(source => source.id === 'artificial-analysis').fetchedAt, catalogAt);
  assert.deepEqual(scored.models.fake.map(row => [row.id, row.scores.coding?.value ?? null]), [['vendor/alpha-1', 57.5], ['vendor/beta-2', 55], ['vendor/mystery', null]]);
  const dataCard = terminals.create({ provider: 'opencode', cwd: project, profile: 'normal', position: { x: 0, y: 0 }, role: 'agent', title: 'Data', launchOptions: { 'canvastty-assistant': { model: 'auto' } } });
  const dataStarted = await waitFor(() => spawned.find(entry => entry.options?.env?.CTTY_JEV_ROUTER_KEY && ![token, childKey].includes(entry.options.env.CTTY_JEV_ROUTER_KEY)));
  const dataConfig = JSON.parse(readFileSync(dataStarted.options.env.OPENCODE_CONFIG, 'utf8'));
  const dataPort = Number(/127\.0\.0\.1:(\d+)/u.exec(Object.values(dataConfig.provider)[0].options.baseURL)[1]);
  const routed2 = await fetch(`http://127.0.0.1:${dataPort}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${dataStarted.options.env.CTTY_JEV_ROUTER_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'Fix the failing parser test' }] }) });
  assert.equal(routed2.status, 200);
  await routed2.text();
  assert.equal(upstream.posts().at(-1).model, 'vendor/alpha-1');
  assert.equal(upstream.posts().at(-1).json.reasoning, undefined, 'an OpenAI-compatible upstream gets no effort field: the effort only names its setting');
  const decided = (await supervisor.request('canvastty-assistant', 'assistant', 'auto.state', {})).recent[0];
  assert.deepEqual([decided.taskType, decided.difficulty, decided.model, decided.score, decided.why, decided.priceIn], ['coding', 'medium', 'vendor/alpha-1', 57.5, 'best_score', 1]);
  assert.ok(!JSON.stringify(decided).includes('parser'), 'no text in the decision');
  terminals.dispose(dataCard.id);
});
