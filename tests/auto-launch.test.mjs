// Model: Auto (Jev) — the launch side and the Assistant wiring: the contribution through CanvasTTY's own launch
// pipeline (when CANVASTTY_REPO is set), refusals, the subagent class clamp, route handing out Auto, the decision
// model asked once per turn (a fake Ollama as the decision model), badges, keys dead after close, the page methods.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Assistant } from '../src/service/assistant.ts';
import { AUTO_STRINGS } from '../src/auto/i18n.ts';
import { modelChoiceIn, parseJsonc, projectModelConfig } from '../src/auto/launch.ts';
import { startFakeUpstream } from './helpers/fake-upstream.mjs';
import { startFakeOllama } from './helpers/fake-ollama.mjs';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'canvastty-auto-launch-')));
process.on('exit', () => rmSync(base, { recursive: true, force: true }));
const core = process.env.CANVASTTY_REPO;

function project(name, files = {}) {
  const dir = join(base, name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text); }
  return dir;
}

function fakeHost({ secrets = {} } = {}) {
  const calls = [], events = [], storage = {};
  return {
    calls, events, storage, secrets,
    badges: sessionId => calls.filter(call => call.method === 'cards.setBadge' && call.params.sessionId === sessionId).map(call => call.params.badge),
    callHost: async (method, params) => {
      calls.push({ method, params });
      if (method === 'storage.set') { storage[params.key] = params.value; return null; }
      if (method === 'storage.get') return storage[params.key] ?? null;
      if (method === 'secrets.get') return secrets[params.key] ?? null;
      return null;
    },
    log() {},
    emit(event, data) { events.push({ event, data }); }
  };
}

const autoSettings = (url, extra = {}) => ({
  upstreams: [{ id: 'fake', preset: 'openai-compatible', baseUrl: url, trust: 'D2', key: 'own', enabled: true, models: [{ id: 'vendor/small', tier: 'small', context: 64_000, output: 4_096 }, { id: 'vendor/medium', tier: 'medium', context: 200_000 }, { id: 'vendor/large', tier: 'large' }] }],
  preference: 'balanced', cheaperFallback: false, decider: 'jev', dailyUsdCap: 1, perCardUsdCap: 0.5, ...extra
});

async function assistantWith(t, { auto, settings, upstream: upstreamOptions = {} } = {}) {
  const upstream = await startFakeUpstream(upstreamOptions);
  t.after(() => upstream.close());
  const host = fakeHost({ secrets: { 'auto-upstream-fake': JSON.stringify({ origin: new URL(upstream.url).origin, value: 'up-key' }) } });
  const assistant = new Assistant({ host, dataDir: mkdtempSync(join(base, 'data-')), git: null, locale: 'en', autoRouting: auto ?? autoSettings(upstream.url), ...(settings ? { settings } : {}) });
  t.after(() => assistant.auto.stop());
  return { assistant, host, upstream };
}

const launch = (extra = {}) => ({ sessionId: 'card-aaaa1111', provider: 'opencode', profile: 'normal', role: 'agent', cwd: project('plain'), restoring: false, resume: false, options: { task: '', dataClass: 'default', model: 'auto' }, chosen: true, environment: null, ...extra });

async function chat(port, token, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: response.status, text: await response.text() };
}
const turn = text => ({ model: 'auto', stream: true, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: text }] });
const portOf = contribution => Number(/127\.0\.0\.1:(\d+)/u.exec(contribution.files[0].content)[1]);

test('prepare: an OpenCode config in the run folder points a random canvastty provider at the router; Zen and other providers are off', async t => {
  const { assistant } = await assistantWith(t);
  const answer = await assistant.launch(launch());
  assert.deepEqual(Object.keys(answer).sort(), ['args', 'env', 'files', 'thirdPartyModel']);
  assert.equal(answer.env.OPENCODE_CONFIG, '{launchFiles}/opencode.json');
  assert.match(answer.env.CTTY_JEV_ROUTER_KEY, /^sk-ctty-[A-Za-z0-9_-]{43}$/u);
  assert.equal(answer.thirdPartyModel, true);
  const config = JSON.parse(answer.files[0].content);
  const [id] = Object.keys(config.provider);
  assert.match(id, /^ctty-jev-[0-9a-f]{6}$/u);
  assert.deepEqual(config.enabled_providers, [id], 'only this provider: no OpenCode Zen, nothing from the global config');
  assert.equal(config.model, `${id}/auto`);
  assert.equal(config.small_model, `${id}/auto-small`, 'titles and summaries go through the router too');
  assert.deepEqual(answer.args, ['--model', `${id}/auto`]);
  assert.equal(config.provider[id].npm, '@ai-sdk/openai-compatible');
  assert.equal(config.provider[id].options.apiKey, '{env:CTTY_JEV_ROUTER_KEY}', 'the key itself is not in the file');
  assert.ok(!answer.files[0].content.includes(answer.env.CTTY_JEV_ROUTER_KEY));
  assert.match(config.provider[id].options.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
  assert.deepEqual(config.provider[id].models.auto.limit, { context: 64_000, output: 4_096 }, 'the smallest limits of the allow-list');
  assert.doesNotMatch(answer.files[0].content, /permission|approv|yolo|sandbox|dangerous|bypass|auto_?accept|trust/iu, 'no key CanvasTTY reads as an approval setting');
  // A second launch of the same card (restart): a new key, the old one dead.
  const port = portOf(answer);
  assert.equal((await chat(port, answer.env.CTTY_JEV_ROUTER_KEY, turn('hi'))).status, 200);
  const again = await assistant.launch(launch({ restoring: true }));
  assert.notEqual(again.env.CTTY_JEV_ROUTER_KEY, answer.env.CTTY_JEV_ROUTER_KEY);
  assert.notEqual(Object.keys(JSON.parse(again.files[0].content).provider)[0], id, 'a new provider id per launch');
  assert.equal((await chat(port, answer.env.CTTY_JEV_ROUTER_KEY, turn('hi'))).status, 401);
  // Card closed: its key stops working.
  assert.equal((await chat(port, again.env.CTTY_JEV_ROUTER_KEY, turn('hi'))).status, 200);
  assistant.sessionEvent({ type: 'closed', session: { id: 'card-aaaa1111', provider: 'opencode', role: 'agent' } });
  await assert.rejects(chat(port, again.env.CTTY_JEV_ROUTER_KEY, turn('hi')), /fetch failed/u, 'no card left: the port is closed');
  // Off: no contribution at all.
  assert.equal(await assistant.launch(launch({ options: { task: '', dataClass: 'default', model: 'off' } })), null);
});

test('refusals: other CLIs, containers and remote hosts, a project config that picks models, no upstream, data class, unknown value', async t => {
  const { assistant } = await assistantWith(t);
  const reason = async (extra, locale = 'en') => (await assistant.launch(launch(extra)))?.refuse?.reason;
  assert.equal(await reason({ provider: 'codex' }), AUTO_STRINGS.en.provider);
  assert.equal(await reason({ environment: { pluginId: 'canvastty-environments', kind: 'container' } }), AUTO_STRINGS.en.environment);
  assert.equal(await reason({ environment: { pluginId: 'canvastty-environments', kind: 'ssh' } }), AUTO_STRINGS.en.environment);
  assert.equal(await reason({ environment: { pluginId: 'canvastty-environments', kind: 'worktree' } }), undefined, 'a worktree runs on this computer');
  assert.equal(await reason({ cwd: project('p1', { 'opencode.json': '{"model":"opencode/big-pickle"}' }) }), AUTO_STRINGS.en.project);
  assert.equal(await reason({ cwd: project('p2', { '.opencode/opencode.jsonc': '{\n // ours\n "enabled_providers": ["opencode"],\n}' }) }), AUTO_STRINGS.en.project);
  assert.equal(await reason({ cwd: project('p3', { 'opencode.json': '{"agent":{"build":{"model":"x/y"}}}' }) }), AUTO_STRINGS.en.project);
  assert.equal(await reason({ cwd: project('p4', { 'opencode.json': '{"model": ' }) }), AUTO_STRINGS.en.projectUnreadable);
  assert.equal(await reason({ cwd: project('p5', { 'opencode.json': '{"theme":"dark","provider":{"zai":{}}}' }) }), undefined, 'other settings are fine');
  const nested = project('p6', { 'opencode.json': '{"small_model":"opencode/x"}' });
  mkdirSync(join(nested, 'pkg', 'src'), { recursive: true });
  assert.equal(await reason({ cwd: join(nested, 'pkg', 'src') }), AUTO_STRINGS.en.project, 'found from a subfolder up to the git root');
  assert.equal(await reason({ options: { task: '', dataClass: 'default', model: 'turbo' } }), AUTO_STRINGS.en.unknownValue);
  for (const text of Object.values(AUTO_STRINGS.en).concat(Object.values(AUTO_STRINGS.ru)).filter(value => typeof value === 'string')) assert.ok(`CanvasTTY Assistant: ${text}`.length <= 240, text);
  // D3 (secret) with no upstream on this computer; D2 cards with an upstream trusted only with D1 (Strict).
  assistant.settings = { ...assistant.settings, dataClassMode: 'strict' };
  assert.equal(await reason({ options: { task: '', dataClass: 'D3', model: 'auto' } }), AUTO_STRINGS.en.dataClass);
  await assistant.auto.save({ ...assistant.auto.settings, upstreams: assistant.auto.settings.upstreams.map(u => ({ ...u, trust: 'D1' })) });
  assert.equal(await reason({ options: { task: '', dataClass: 'D2', model: 'auto' } }), AUTO_STRINGS.en.dataClass);
  assert.equal(await reason({ options: { task: '', dataClass: 'D1', model: 'auto' } }), undefined);
  // An orchestrator cannot lower its subagent's class: D2 parent, the child asks for D0 → still D2 → refused.
  await assistant.launch(launch({ sessionId: 'parent-1', role: 'orchestrator', options: { task: '', dataClass: 'D2', model: 'off' } }));
  assert.equal(await reason({ sessionId: 'child-1', role: 'subagent', parentSessionId: 'parent-1', options: { task: '', dataClass: 'D0', model: 'auto' } }), AUTO_STRINGS.en.dataClass);
  await assistant.auto.save({ ...assistant.auto.settings, upstreams: [] });
  assert.equal(await reason({}), AUTO_STRINGS.en.noUpstream);
  // Russian.
  const ru = new Assistant({ host: fakeHost(), dataDir: mkdtempSync(join(base, 'data-')), git: null, locale: 'ru' });
  assert.equal((await ru.launch(launch({ provider: 'claude' }))).refuse.reason, AUTO_STRINGS.ru.provider);
  assert.match(AUTO_STRINGS.ru.provider, /OpenCode/u);
});

test('project config reading (JSONC, keys, the git root)', () => {
  assert.deepEqual(parseJsonc('{ /* a */ "a": "http://x//y", // b\n "b": [1,2,], }'), { a: 'http://x//y', b: [1, 2] });
  assert.equal(parseJsonc('{'), undefined);
  assert.equal(modelChoiceIn({ provider: { 'ctty-jev-abc123': {} } }), 'provider');
  assert.equal(modelChoiceIn({ mode: { plan: { model: 'a/b' } } }), 'mode.plan.model');
  assert.equal(modelChoiceIn({ plugin: [] }), null);
  const outer = join(base, 'outer');
  mkdirSync(join(outer, 'repo', '.git'), { recursive: true });
  writeFileSync(join(outer, 'opencode.json'), '{"model":"x/y"}');
  assert.deepEqual(projectModelConfig(join(outer, 'repo')), { found: null, unreadable: null }, 'OpenCode stops at the git root; so does the check');
});

test('the decision model is asked once per user turn; continuations and small calls never; the badge shows the model', async t => {
  const ollama = await startFakeOllama({ prefer: ['true', 'debug', '3'] });
  t.after(() => ollama.close());
  const port = Number(new URL(ollama.url).port);
  const { assistant, host, upstream } = await assistantWith(t, { settings: {
    enabled: true, modes: { 'task.route': 'suggest', 'command.review': 'off' },
    backends: [{ id: 'ollama-1', preset: 'emulated', runtime: 'ollama', model: 'qwen3.5:9b', url: ollama.url, enabled: true, localConfirmed: { port, at: 1 } }]
  } });
  const answer = await assistant.launch(launch());
  const token = answer.env.CTTY_JEV_ROUTER_KEY;
  const posts = () => ollama.requests.filter(r => r.method === 'POST' && r.path === '/api/chat').length;
  const prepared = posts();
  const first = { model: 'auto', stream: true, tools: [{ type: 'function', function: { name: 'bash' } }], messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Investigate the intermittent failure in the scheduler' }] };
  assert.equal((await chat(portOf(answer), token, first)).status, 200);
  const afterTurn = posts();
  assert.ok(afterTurn > prepared, 'the decision model answered the turn');
  const record = assistant.auto.router.recent()[0];
  assert.equal(record.source, 'jev');
  for (let step = 0; step < 5; step++) {
    first.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${step}`, type: 'function', function: { name: 'bash', arguments: '{}' } }] }, { role: 'tool', tool_call_id: `c${step}`, content: 'ok' });
    assert.equal((await chat(portOf(answer), token, first)).status, 200);
  }
  assert.equal((await chat(portOf(answer), token, { ...turn('title please'), model: 'auto-small' })).status, 200);
  assert.equal(posts(), afterTurn, 'no decision-model call for 5 continuations and a small call');
  assert.equal(upstream.posts().length, 7);
  const stats = assistant.auto.router.statsView();
  assert.equal(stats.jevAsked, 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  const badges = host.badges('card-aaaa1111').filter(Boolean);
  assert.ok(badges.some(badge => /^vendor\//u.test(badge.tooltip ?? '') || /small|medium|large/u.test(badge.text)), JSON.stringify(badges));
  assert.match(badges.at(-1).tooltip, /^Auto \(Jev\): (small|medium|large) model, chosen by/u);
  // A loop alert outranks the model badge.
  const decide = command => ({ event: 'pre-tool', sessionId: 'card-aaaa1111', provider: 'opencode', role: 'agent', cwd: base, agentCwd: base, tool: { name: 'bash', kind: 'shell', command, paths: [] }, input: { command }, truncated: false, budgetMs: 5_000 });
  assistant.sessionEvent({ type: 'created', session: { id: 'card-aaaa1111', provider: 'opencode', role: 'agent', title: 'x', status: 'working', cwd: base, workingDirectory: base } });
  for (let i = 0; i < 5; i++) await assistant.decide(decide('make check'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(host.badges('card-aaaa1111').at(-1).text, 'loop?');
});

test('several Auto cards: Jev answers up to 10 turns a minute per card, then that card falls back to word rules while the others keep Jev; each turn is the card\'s task for command review', async t => {
  const ollama = await startFakeOllama({ prefer: ['true', 'debug', '3'] });
  t.after(() => ollama.close());
  const port = Number(new URL(ollama.url).port);
  const { assistant } = await assistantWith(t, { settings: {
    enabled: true, modes: { 'task.route': 'suggest', 'command.review': 'off' },
    backends: [{ id: 'ollama-1', preset: 'emulated', runtime: 'ollama', model: 'qwen3.5:9b', url: ollama.url, enabled: true, localConfirmed: { port, at: 1 } }]
  } });
  const busy = await assistant.launch(launch({ sessionId: 'card-busy0001' }));
  const quiet = await assistant.launch(launch({ sessionId: 'card-quiet001' }));
  const history = [];
  for (let i = 0; i < 11; i++) {
    history.push({ role: 'user', content: `Investigate failure number ${i} in the scheduler` });
    assert.equal((await chat(portOf(busy), busy.env.CTTY_JEV_ROUTER_KEY, { model: 'auto', stream: true, messages: [{ role: 'system', content: 'sys' }, ...history] })).status, 200);
    history.push({ role: 'assistant', content: 'Done.' });
  }
  const turns = assistant.auto.router.recent().filter(record => record.session === 'card-bus' && record.kind === 'turn').reverse();
  assert.deepEqual(turns.map(record => record.source), [...Array(10).fill('jev'), 'rules']);
  assert.equal(turns.at(-1).reason, 'jev_unavailable');
  assert.equal(turns.at(-1).status, 200, 'the call itself still succeeds');
  assert.equal((await chat(portOf(quiet), quiet.env.CTTY_JEV_ROUTER_KEY, turn('Investigate the flaky login test'))).status, 200);
  assert.equal(assistant.auto.router.recent()[0].source, 'jev', 'another card still gets Jev');
  // The router's turns reach command review (the card's task, latest first).
  assert.match(assistant.review.requestFor('card-busy0001').text, /^Investigate failure number 10 in the scheduler\n\nInvestigate failure number 9/u);
  assert.equal(assistant.review.requestFor('card-busy0001').byPerson, true);
  assert.equal(assistant.review.requestFor('card-quiet001').text, 'Investigate the flaky login test');
});

test('route: Model: Auto (Jev) is a route for an OpenCode subagent: Auto launch options and no fixed model; OpenCode\'s own default is never offered', async t => {
  const { assistant } = await assistantWith(t);
  const caller = { id: 'orch-on-auto', provider: 'opencode', role: 'orchestrator', title: 'o', status: 'idle', cwd: base, workingDirectory: base };
  const providers = [{ id: 'opencode', available: true, subagent: true, model: { supported: true, known: ['zai/glm-flash', 'zai/glm-pro'] }, efforts: [] }];
  await assistant.launch(launch({ sessionId: 'orch-on-auto', role: 'orchestrator' }));
  const answer = await assistant.tool('route', caller, { task: 'Rename a variable', providers });
  const json = JSON.parse(answer.content.split('\n').at(-1));
  assert.deepEqual(json.spawn, { provider: 'opencode', launchOptions: { 'canvastty-assistant': { model: 'auto' } } });
  assert.match(answer.content, /Model: Auto \(Jev\)/u);
  assert.equal(json.alternatives.length, 0, 'zai/glm-* were not declared, and OpenCode Zen is never used silently');
  // Auto turned off: nothing usable on OpenCode, and route says so instead of falling back to OpenCode's default.
  await assistant.auto.save({ ...assistant.auto.settings, upstreams: assistant.auto.settings.upstreams.map(upstream => ({ ...upstream, enabled: false })) });
  assert.match((await assistant.tool('route', caller, { task: 'Rename a variable', providers })).content, /^No route is usable now/u);
});

test('the page: save validates and stores, state shows whether keys are saved (never a key), test lists missing models', async t => {
  const { assistant, host, upstream } = await assistantWith(t, { upstream: { behaviours: { 'vendor/small': 'stream', 'vendor/medium': 'stream' } } });
  const state = await assistant.auto.state();
  assert.deepEqual(state.keys, { fake: true });
  assert.ok(!JSON.stringify(state).includes('up-key'));
  await assert.rejects(assistant.auto.save({ ...state.settings, preference: 'fastest' }), /preference/u);
  await assistant.auto.save({ ...state.settings, preference: 'cheap' });
  assert.equal(host.storage.autoRouting.preference, 'cheap');
  assert.ok(host.events.some(event => event.event === 'settings'));
  assert.deepEqual(assistant.auto.keySlot('fake'), { secret: 'auto-upstream-fake', origin: new URL(upstream.url).origin });
  const result = await assistant.auto.test('fake');
  assert.deepEqual(result, { ok: true, status: 200, missing: ['vendor/large'], listed: 2 });
  assert.deepEqual(upstream.requests.map(r => [r.method, r.path]), [['GET', '/v1/models']], 'one GET, no prompt, no tokens');
  // A key saved for another address is not used.
  host.secrets['auto-upstream-fake'] = JSON.stringify({ origin: 'https://other.example', value: 'up-key' });
  assert.deepEqual((await assistant.auto.state()).keys, { fake: false });
  assert.equal((await assistant.auto.test('fake')).ok, false);
});

test('through CanvasTTY\'s own launch pipeline: the contribution passes its checks, is written 0600, and an account on the same launch is refused', { skip: !core && 'set CANVASTTY_REPO to a CanvasTTY checkout' }, async t => {
  const { LaunchPipeline } = await import(join(core, 'src/main/services/LaunchPipeline.ts'));
  const { assistant } = await assistantWith(t);
  const manifest = JSON.parse(readFileSync(new URL('../canvastty.plugin.json', import.meta.url), 'utf8'));
  const ours = { pluginId: 'canvastty-assistant', pluginName: 'CanvasTTY Assistant', serviceId: 'assistant', launch: manifest.services[0].launch, secrets: true };
  const accounts = { pluginId: 'canvastty-accounts', pluginName: 'CanvasTTY Accounts', serviceId: 'accounts', launch: { delegable: true, fields: [{ key: 'account', label: 'Account', kind: 'select', options: [{ value: 'a', label: 'A' }] }] }, secrets: true };
  const runsRoot = mkdtempSync(join(base, 'runs-'));
  const pipeline = new LaunchPipeline({
    contributors: () => [accounts, ours], runsRoot, secret: async () => 'acct-key',
    call: async (pluginId, _service, method, params) => pluginId === 'canvastty-assistant' ? assistant.launch(params)
      : { env: { OPENCODE_CONFIG: '{launchFiles}/opencode.json' }, secretEnv: { CTTY_MODEL_API_KEY: 'acct' }, files: [{ relPath: 'opencode.json', content: '{"model":"acct/m"}' }], thirdPartyModel: true }
  });
  const options = pipeline.normalizeOptions('opencode', { 'canvastty-assistant': { model: 'auto' } }, { delegated: true });
  assert.deepEqual(options['canvastty-assistant'], { task: '', dataClass: 'default', model: 'auto' }, 'delegable: an orchestrator may choose it');
  const context = { sessionId: 'card-pipe-1', provider: 'opencode', profile: 'auto', role: 'subagent', parentSessionId: 'p', cwd: project('pipe'), restoring: false, resume: false, environment: null, options };
  const prepared = await pipeline.prepare(context);
  assert.equal(prepared.ok, true, prepared.reason);
  assert.equal(prepared.thirdPartyModel, true);
  const file = prepared.env.OPENCODE_CONFIG;
  assert.ok(file.startsWith(runsRoot) && file.endsWith('/canvastty-assistant/opencode.json'));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const config = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(config.enabled_providers.length, 1);
  assert.match(prepared.env.CTTY_JEV_ROUTER_KEY, /^sk-ctty-/u);
  assert.deepEqual(prepared.args.slice(0, 1), ['--model']);
  await prepared.cleanup();
  // The same launch with an account too: the core refuses it and names both plugins.
  const both = pipeline.normalizeOptions('opencode', { 'canvastty-assistant': { model: 'auto' }, 'canvastty-accounts': { account: 'a' } });
  const refused = await pipeline.prepare({ ...context, sessionId: 'card-pipe-2', options: both });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /CanvasTTY Accounts and CanvasTTY Assistant both set (?:OPENCODE_CONFIG|the model of this launch)/u);
  // A refusal reaches the card with the plugin's name.
  const codex = await pipeline.prepare({ ...context, provider: 'codex', sessionId: 'card-pipe-3', options: pipeline.normalizeOptions('codex', { 'canvastty-assistant': { model: 'auto' } }) });
  assert.equal(codex.ok, false);
  assert.equal(codex.reason, `CanvasTTY Assistant: ${AUTO_STRINGS.en.provider}`);
});
