// Auto (Jev) through the person's own plan account, end to end against a CanvasTTY checkout with brokered requests
// (CANVASTTY_REPO) and the Accounts plugin's built package (CANVASTTY_ACCOUNTS): both packages are installed by the
// real PluginManager and run under the real PluginServiceSupervisor; the real PluginAccountBroker carries the call.
// A person-started OpenCode card on "Model: Auto (Jev)" sends one turn: the Assistant's router -> CanvasTTY's broker
// -> a fake Z.AI endpoint on 127.0.0.1, with the Accounts key added by CanvasTTY. Every byte CanvasTTY writes to the
// Assistant's process is scanned: the key never reaches it. No model, no network beyond loopback, no real secret.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { manifestForCore } from './helpers/core-manifest.mjs';
import { accountUpstream } from '../src/auto/settings.ts';

const core = process.env.CANVASTTY_REPO;
const accountsRepo = process.env.CANVASTTY_ACCOUNTS;
const root = new URL('../', import.meta.url).pathname;
// Assembled at run time: a fixture key, never a real one.
const KEY = ['sk', 'fixture', 'zai', 'b6b6b6b6'.repeat(4)].join('-');

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
      pid: 72_000 + calls.length, process: command, write() {}, resize() {}, kill() {}, pause() {}, resume() {},
      onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }
    };
  };
}

/** A fake Z.AI OpenAI-compatible endpoint: refuses any other key, streams an answer that echoes the key it got. */
async function fakeZai() {
  const posts = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      posts.push({ method: request.method, url: request.url, headers: { ...request.headers }, body: body ? JSON.parse(body) : null });
      if (request.headers.authorization !== `Bearer ${KEY}`) { response.writeHead(401, { 'content-type': 'application/json' }); response.end('{"error":{"message":"bad key"}}'); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'x-zai-request': 'r-1', 'set-cookie': 'zai=1' });
      const frames = [
        { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Fixed through the plan. ' } }] },
        { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: `(it saw ${request.headers.authorization})` }, finish_reason: 'stop' }] },
        { id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 120, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 40 } } }
      ];
      response.end(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, posts, close: () => new Promise(resolve => server.close(resolve)) };
}

async function packageFrom(source, target, validatePluginManifest) {
  const manifest = JSON.parse(await readFile(join(source, 'canvastty.plugin.json'), 'utf8'));
  for (const file of ['LICENSE', ...manifest.coreFiles.map(entry => entry.path)]) {
    await mkdir(join(target, dirname(file)), { recursive: true });
    await cp(join(source, file), join(target, file));
  }
  await writeFile(join(target, 'canvastty.plugin.json'), JSON.stringify(manifestForCore(validatePluginManifest, manifest).manifest, null, 2));
}

test('a person-started OpenCode card on Auto (Jev) answers through the person\'s Accounts plan; the key never reaches the Assistant', {
  skip: (!core || !accountsRepo) && 'set CANVASTTY_REPO (a core with brokered requests) and CANVASTTY_ACCOUNTS (the Accounts plugin, built)'
}, async t => {
  const { PluginManager, validatePluginManifest } = await import(join(core, 'src/main/services/PluginManager.ts'));
  const { PluginServiceSupervisor } = await import(join(core, 'src/main/services/PluginServiceSupervisor.ts'));
  const { PluginSessions } = await import(join(core, 'src/main/services/PluginSessions.ts'));
  const { TerminalManager } = await import(join(core, 'src/main/services/TerminalManager.ts'));
  const { LaunchPipeline } = await import(join(core, 'src/main/services/LaunchPipeline.ts'));
  const { PluginAccountBroker } = await import(join(core, 'src/main/services/PluginAccountBroker.ts'));
  const { SecretRedactionRegistry } = await import(join(core, 'src/main/services/safety/SecretRedaction.ts'));

  const work = await mkdtemp(join(tmpdir(), 'canvastty-broker-e2e-'));
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

  const zai = await fakeZai();
  t.after(() => zai.close());

  const repos = { 'canvastty-plugin-assistant': join(work, 'repo-assistant'), 'canvastty-plugin-accounts': join(work, 'repo-accounts') };
  await packageFrom(root, repos['canvastty-plugin-assistant'], validatePluginManifest);
  await packageFrom(accountsRepo, repos['canvastty-plugin-accounts'], validatePluginManifest);
  const project = join(work, 'project');
  await mkdir(join(project, '.git'), { recursive: true });

  const userData = join(work, 'userData');
  const fixtureOf = url => repos[String(url).replace(/^https:\/\/github\.com\/example\//u, '').replace(/\.git$/u, '')];
  const manager = new PluginManager(userData, async (url, destination) => cp(fixtureOf(url), destination, { recursive: true }),
    async (url, destination, files) => {
      for (const file of files) {
        await mkdir(join(destination, dirname(file.path)), { recursive: true });
        await cp(join(fixtureOf(url), file.path), join(destination, file.path));
      }
    });
  t.after(() => manager.dispose());
  await manager.load();
  for (const name of Object.keys(repos)) await manager.install((await manager.previewInstall(`https://github.com/example/${name}`)).token);
  assert.ok(manager.list().find(plugin => plugin.manifest.id === 'canvastty-assistant').manifest.permissions.includes('accounts:broker'));
  assert.equal(manager.list().find(plugin => plugin.manifest.id === 'canvastty-accounts').manifest.services[0].brokerable, true);
  await manager.setNativeCodeTrusted('canvastty-accounts', true);
  await manager.setNativeCodeTrusted('canvastty-assistant', true);

  // Plugin secrets: the Accounts key for its plan account, as its page writes it. Only Accounts may read it.
  const secrets = new Map([['canvastty-accounts key.glm-plan', KEY]]);
  const secretOf = async (pluginId, key) => secrets.get(`${pluginId} ${key}`) ?? null;
  const redaction = new SecretRedactionRegistry();
  let sessions = null;
  const spawned = [];
  const terminals = new TerminalManager((channel, payload) => sessions?.observe(channel, payload), clis(), undefined, undefined, true, spawner(spawned));
  let supervisor = null;
  const broker = new PluginAccountBroker({
    owners: () => manager.brokerOwners(),
    callers: () => manager.brokerCallers(),
    grant: (caller, owner, account) => manager.brokerGrant(caller, owner, account),
    saveGrant: async (caller, owner, account, fingerprint) => { await manager.setBrokerGrant(caller, owner, account, fingerprint); },
    running: (pluginId, serviceId) => supervisor.running(pluginId, serviceId),
    call: (pluginId, serviceId, method, params, timeoutMs) => supervisor.hostCall(pluginId, serviceId, method, params, timeoutMs),
    notify: (pluginId, serviceId, method, params) => supervisor.notify(pluginId, serviceId, method, params),
    secret: secretOf,
    registerSecret: (owner, value) => redaction.add(`plugin:${owner}`, [value]),
    redact: text => redaction.redact(text),
    audit: (pluginId, serviceId, level, message) => supervisor.audit(pluginId, serviceId, level, message)
  });
  supervisor = new PluginServiceSupervisor({
    command: process.execPath, hostVersion: '9.9.9', locale: () => 'en', stopGraceMs: 300,
    host: {
      storageGet: (pluginId, key) => manager.storageGet(pluginId, key),
      storageSet: (pluginId, key, value) => manager.storageSet(pluginId, key, value),
      emit: () => undefined,
      registerSecrets: (pluginId, values) => redaction.add(`plugin:${pluginId}`, values),
      secretGet: secretOf,
      sessions: (pluginId, serviceId, method, params, granted) => sessions.handle(pluginId, serviceId, method, params, granted),
      setBadge: () => null,
      accounts: (pluginId, serviceId, method, params) => broker.handle(pluginId, serviceId, method, params),
      stopped: (pluginId, serviceId) => { sessions.serviceStopped(pluginId, serviceId); broker.serviceStopped(pluginId, serviceId); }
    }
  });
  // Everything CanvasTTY writes to the Assistant's process (answers, notifications), kept for the scan below.
  const toAssistant = [];
  const write = supervisor.write.bind(supervisor);
  supervisor.write = (record, frame) => { if (record.spec.pluginId === 'canvastty-assistant') toAssistant.push(frame); return write(record, frame); };
  manager.setServiceObserver(async specs => { broker.recheck(); await supervisor.sync(specs); });
  t.after(() => supervisor.dispose());
  sessions = new PluginSessions({ terminals, notify: (pluginId, serviceId, method, params) => supervisor.notify(pluginId, serviceId, method, params) });
  const call = (pluginId, serviceId, method, params, budget) => supervisor.hostCall(pluginId, serviceId, method, params, budget);
  const runsRoot = join(userData, 'launch-runs');
  terminals.configureLaunchPipeline(new LaunchPipeline({ contributors: () => manager.launchContributors(), call, secret: secretOf, runsRoot }));
  await supervisor.sync(manager.trustedServiceSpecs());
  await waitFor(() => supervisor.running('canvastty-accounts', 'accounts') && supervisor.running('canvastty-assistant', 'assistant'));

  // 1. On the Accounts page the person adds the plan account on Z.AI's OpenAI endpoint, saves its key and ticks
  //    "other extensions may use this account".
  const zaiBase = `${zai.url}/api/coding/paas/v4`;
  await supervisor.request('canvastty-accounts', 'accounts', 'save', { settings: { version: 1, accounts: [
    { id: 'glm-plan', label: 'GLM coding plan', preset: 'zai-openai', baseUrl: zaiBase, model: 'glm-4.6', agents: ['opencode'], brokerable: true }
  ] } });
  await supervisor.request('canvastty-accounts', 'accounts', 'keyChanged', { accountId: 'glm-plan' });

  // Nothing is offered to the Assistant before the person allows the pair in CanvasTTY.
  const offered = await broker.ownerAccounts('canvastty-accounts');
  assert.deepEqual(offered.accounts.map(account => [account.ref, account.origin, account.models]), [['canvastty-accounts:glm-plan', zai.url, ['glm-4.6']]]);
  assert.deepEqual(offered.callers.map(caller => caller.pluginId), ['canvastty-assistant']);
  assert.deepEqual(offered.grants, []);
  const before = await supervisor.request('canvastty-assistant', 'assistant', 'auto.state', {});
  assert.deepEqual(before.brokered.accounts, []);

  // 2. Settings -> Agents -> Extension native code -> CanvasTTY Accounts: the person allows Assistant on this account.
  await broker.setGrant('canvastty-assistant', 'canvastty-accounts', 'glm-plan', true);

  // 3. On the Assistant's decision models page the account is listed; the person uses it in Auto (trust as chosen).
  const state = await waitFor(async () => {
    const next = await supervisor.request('canvastty-assistant', 'assistant', 'auto.state', {});
    return next.brokered.accounts.length ? next : null;
  }, 20_000);
  const [account] = state.brokered.accounts;
  assert.equal(account.ref, 'canvastty-accounts:glm-plan');
  assert.equal(account.origin, zai.url);
  await supervisor.request('canvastty-assistant', 'assistant', 'auto.save', { settings: {
    upstreams: [accountUpstream(account, [])],
    preference: 'balanced', cheaperFallback: false, decider: 'rules', dailyUsdCap: 1, perCardUsdCap: 0.5, catalog: { autoRefresh: false, refreshHours: 168 }
  } });
  const ready = await supervisor.request('canvastty-assistant', 'assistant', 'auto.state', {});
  assert.deepEqual(Object.values(ready.keys), [true], 'the account upstream is reachable through CanvasTTY');

  // 4. The person starts an OpenCode card with Model: Auto (Jev): it is not refused (run 17 refused it).
  const card = terminals.create({ provider: 'opencode', cwd: project, profile: 'normal', position: { x: 0, y: 0 }, role: 'agent', title: 'Fix', launchOptions: { 'canvastty-assistant': { model: 'auto' } } });
  const started = await waitFor(() => spawned.find(entry => entry.options?.env?.CTTY_JEV_ROUTER_KEY), 20_000).catch(() => null);
  if (!started) assert.fail(`the Auto card did not start: ${JSON.stringify(terminals.list().find(entry => entry.id === card.id))}`);
  const env = started.options.env;
  assert.ok(!Object.values(env).some(value => String(value).includes(KEY)), 'the plan key is not in the card\'s environment');
  const config = JSON.parse(readFileSync(env.OPENCODE_CONFIG, 'utf8'));
  const [providerId] = Object.keys(config.provider);
  const port = Number(/127\.0\.0\.1:(\d+)/u.exec(config.provider[providerId].options.baseURL)[1]);

  // 5. OpenCode's call, as it makes it: Auto picks the plan account and streams the answer through CanvasTTY.
  const answer = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${env.CTTY_JEV_ROUTER_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'Fix the failing parser test' }] })
  });
  assert.equal(answer.status, 200);
  const text = await answer.text();
  assert.match(text, /Fixed through the plan/u);
  assert.match(text, /it saw Bearer \[redacted\]/u, 'the provider echoed the key; CanvasTTY masked it');
  assert.match(text, /data: \[DONE\]/u);

  // The fake Z.AI endpoint got exactly one request: CanvasTTY's, with the Accounts key and nothing from the caller.
  assert.equal(zai.posts.length, 1);
  const [post] = zai.posts;
  assert.equal(post.url, '/api/coding/paas/v4/chat/completions');
  assert.equal(post.headers.authorization, `Bearer ${KEY}`);
  assert.equal(post.body.model, 'glm-4.6');
  assert.equal(post.body.messages[0].content, 'Fix the failing parser test');
  assert.deepEqual(Object.keys(post.headers).filter(name => !['authorization', 'content-type', 'accept', 'content-length', 'host', 'connection'].includes(name)), []);

  // Usage reached Auto's record (the stream's usage) and the owner settled (its log has the host's audit line).
  const decided = await waitFor(async () => (await supervisor.request('canvastty-assistant', 'assistant', 'auto.state', {})).recent[0]);
  assert.equal(decided.upstream, ready.settings.upstreams[0].id);
  assert.equal(decided.model, 'glm-4.6');
  assert.equal(decided.status, 200);
  assert.equal(decided.costUsd ?? 0, 0, 'a plan account costs Auto nothing per token');
  const ownerLog = supervisor.report('canvastty-accounts').log.map(entry => entry.message).join('\n');
  assert.match(ownerLog, /Brokered request by canvastty-assistant through glm-plan \/chat\/completions model glm-4\.6: ok 200/u);

  // The scan: nothing CanvasTTY wrote to the Assistant's process, its logs, its storage or its page state holds the key.
  const assistantLog = JSON.stringify(supervisor.report('canvastty-assistant').log);
  const assistantStorage = JSON.stringify(await manager.storageGet('canvastty-assistant', 'autoRouting'));
  const page = JSON.stringify(await supervisor.request('canvastty-assistant', 'assistant', 'auto.state', {}));
  assert.ok(toAssistant.length > 10, 'frames were captured');
  for (const [where, value] of Object.entries({ frames: toAssistant.join('\n'), assistantLog, assistantStorage, page, ownerLog, answer: text })) {
    assert.ok(!value.includes(KEY), `${where} holds the key`);
  }
  assert.ok(!toAssistant.join('\n').includes('key.glm-plan'), 'nor the name of the secret');
  assert.ok(!toAssistant.join('\n').includes('x-zai-request') && !toAssistant.join('\n').includes('zai=1'), 'no provider headers');

  // 6. The person withdraws the grant: CanvasTTY refuses the next turn before anything is sent, and the card is told.
  await broker.setGrant('canvastty-assistant', 'canvastty-accounts', 'glm-plan', false);
  const refused = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${env.CTTY_JEV_ROUTER_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'Another fix' }] })
  });
  assert.equal(refused.status, 503);
  await refused.text();
  assert.equal(zai.posts.length, 1, 'nothing more reached the provider');
  terminals.dispose(card.id);
});
