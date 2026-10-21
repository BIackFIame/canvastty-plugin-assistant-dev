// End to end against a CanvasTTY checkout with shared reads (CANVASTTY_REPO) and the built Accounts plugin
// (CANVASTTY_ACCOUNTS: a checkout of canvastty-plugin-accounts with the shares): both real services run under
// CanvasTTY's own PluginManager, PluginServiceSupervisor and PluginSharedReads. The Assistant's read of Accounts' quota
// is refused before the person approves the pair, and answered after; revoking it refuses again. CanvasTTY's own
// limit.exhausted activity and language change reach the Assistant's service. Nothing is launched, no model is
// called, nothing leaves this computer.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { manifestForCore } from './helpers/core-manifest.mjs';

const core = process.env.CANVASTTY_REPO;
const accounts = process.env.CANVASTTY_ACCOUNTS;
const root = new URL('../', import.meta.url).pathname;
const ready = core && existsSync(join(core, 'src/main/services/PluginSharedReads.ts')) && accounts && existsSync(join(accounts, 'canvastty.plugin.json'));
const ASSISTANT = 'canvastty-assistant';
const ACCOUNTS = 'canvastty-accounts';

const waitFor = async (predicate, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Condition was not met in time.');
};

async function packageOf(source, validate, work, name) {
  const manifest = JSON.parse(await readFile(join(source, 'canvastty.plugin.json'), 'utf8'));
  const dir = join(work, name);
  await mkdir(dir, { recursive: true });
  for (const file of ['LICENSE', ...manifest.coreFiles.map(entry => entry.path)]) {
    if (!existsSync(join(source, file))) continue;
    await mkdir(join(dir, dirname(file)), { recursive: true });
    await cp(join(source, file), join(dir, file));
  }
  await writeFile(join(dir, 'canvastty.plugin.json'), JSON.stringify(manifestForCore(validate, manifest).manifest, null, 2));
  return dir;
}

test('the Assistant reads Accounts\' quota through plugins.request only after the person approves the pair; limit.exhausted and a language change reach it', { skip: !ready && 'set CANVASTTY_REPO (a core with shared reads) and CANVASTTY_ACCOUNTS (the Accounts plugin with shares)' }, async t => {
  const { PluginManager, validatePluginManifest } = await import(join(core, 'src/main/services/PluginManager.ts'));
  const { PluginServiceSupervisor } = await import(join(core, 'src/main/services/PluginServiceSupervisor.ts'));
  const { PluginSharedReads } = await import(join(core, 'src/main/services/PluginSharedReads.ts'));
  const { SecretRedactionRegistry } = await import(join(core, 'src/main/services/safety/SecretRedaction.ts'));

  const work = await mkdtemp(join(tmpdir(), 'canvastty-assistant-shares-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const packages = {
    'https://github.com/example/canvastty-plugin-assistant': await packageOf(root, validatePluginManifest, work, 'assistant'),
    'https://github.com/example/canvastty-plugin-accounts': await packageOf(accounts, validatePluginManifest, work, 'accounts')
  };
  const source = url => packages[Object.keys(packages).find(key => key.toLowerCase() === String(url).toLowerCase().replace(/\.git$/u, ''))];
  const manager = new PluginManager(join(work, 'userData'), async (url, destination) => cp(source(url), destination, { recursive: true }),
    async (url, destination, files) => {
      for (const file of files) { await mkdir(join(destination, dirname(file.path)), { recursive: true }); await cp(join(source(url), file.path), join(destination, file.path)); }
    });
  await manager.load();
  const storage = new Map();
  const redaction = new SecretRedactionRegistry();
  let supervisor = null;
  let locale = 'en';
  const shared = new PluginSharedReads({
    route: (consumer, provider, method) => manager.sharedReadRoute(consumer, provider, method),
    running: (pluginId, serviceId) => supervisor.running(pluginId, serviceId),
    call: (pluginId, serviceId, params, timeoutMs) => supervisor.hostCall(pluginId, serviceId, 'canvastty.shares.read', params, timeoutMs),
    containsSecret: text => redaction.redact(text) !== text,
    audit: (pluginId, serviceId, level, message) => supervisor.audit(pluginId, serviceId, level, message)
  });
  supervisor = new PluginServiceSupervisor({
    command: process.execPath, hostVersion: '9.9.9', locale: () => locale, requestTimeoutMs: 10_000, stopGraceMs: 300,
    host: {
      storageGet: async (pluginId, key) => storage.get(`${pluginId}:${key}`) ?? null,
      storageSet: async (pluginId, key, value) => { storage.set(`${pluginId}:${key}`, structuredClone(value)); },
      emit: () => undefined,
      registerSecrets: (pluginId, values) => redaction.add(`plugin:${pluginId}`, values),
      plugins: (pluginId, serviceId, method, params) => shared.handle(pluginId, serviceId, method, params)
    }
  });
  manager.setServiceObserver(specs => supervisor.sync(specs));
  t.after(async () => { await supervisor.dispose(); await manager.dispose(); });

  for (const url of Object.keys(packages)) await manager.install((await manager.previewInstall(url)).token);
  // Install grants nothing: the pair needs the reader's native-code trust and then the person's approval.
  await manager.setNativeCodeTrusted(ACCOUNTS, true);
  await manager.setNativeCodeTrusted(ASSISTANT, true);
  const listed = manager.list().find(plugin => (plugin.manifest?.id ?? plugin.id) === ASSISTANT);
  assert.deepEqual(listed.sharedReads.map(read => [read.method, read.state]), [['accounts.routes', 'needs-approval'], ['accounts.quota', 'needs-approval']]);
  await waitFor(() => supervisor.running(ASSISTANT, 'assistant') && supervisor.running(ACCOUNTS, 'accounts'));
  const page = (method, params = {}) => supervisor.request(ASSISTANT, 'assistant', method, params);

  // Before approval: refused with the reason, Accounts is never asked.
  const before = await page('route.accountsQuota', { force: true });
  assert.equal(before.mode, 'refused');
  assert.equal(before.reason, 'not_approved');
  assert.equal(before.quota, null);
  assert.equal(supervisor.report(ACCOUNTS).log.some(entry => /Shared read .*answered|ok/u.test(entry.message) && /accounts\.quota/u.test(entry.message)), false);
  const state = await page('route.state');
  assert.equal(state.peers.accounts.reason, 'not_approved', 'the settings page can say what to allow');

  // The person approves the pair (the main renderer's IPC; no plugin can).
  await manager.setSharedReadApproved(ASSISTANT, ACCOUNTS, 'accounts.quota', true);
  const after = await page('route.accountsQuota', { force: true });
  assert.equal(after.mode, 'ready', JSON.stringify(after));
  assert.ok(Array.isArray(after.quota.accounts) && Array.isArray(after.quota.poolAccounts) && Array.isArray(after.quota.pools), JSON.stringify(after.quota));
  assert.deepEqual(after.quota.defaultSignIns, []);
  const logs = supervisor.report(ASSISTANT).log.map(entry => entry.message).join('\n');
  assert.match(logs, /Shared read/u);

  // accounts.routes is a separate pair: still not approved.
  await manager.setSharedReadApproved(ASSISTANT, ACCOUNTS, 'accounts.quota', false);
  const revoked = await page('route.accountsQuota', { force: true });
  assert.equal(revoked.mode, 'refused');
  assert.equal(revoked.reason, 'not_approved');

  // CanvasTTY's limit.exhausted (provider-wide) rests Claude's own sign-in in the Assistant, and Accounts remembers it.
  const resetAt = Date.now() + 3_600_000;
  const event = { type: 'limit.exhausted', at: Date.now(), provider: 'claude', accountId: 'default', window: { id: 'claude:five_hour', label: '5h', windowMinutes: 300 }, resetAt };
  assert.equal(supervisor.notify(ASSISTANT, 'assistant', 'canvastty.activity', event), true);
  assert.equal(supervisor.notify(ACCOUNTS, 'accounts', 'canvastty.activity', event), true);
  const rested = await waitFor(async () => (await page('route.state')).cooldowns.find(entry => entry.signIn === 'cli:claude'));
  assert.equal(rested.until, resetAt);
  await manager.setSharedReadApproved(ASSISTANT, ACCOUNTS, 'accounts.quota', true);
  const remembered = await page('route.accountsQuota', { force: true });
  assert.deepEqual(remembered.quota.defaultSignIns.map(entry => [entry.provider, entry.state]), [['claude', 'exhausted']]);

  // A language change reaches the running service (its pages and badges follow).
  assert.equal((await page('harness.view')).locale, 'en');
  locale = 'ru';
  assert.ok(supervisor.localeChanged() >= 1);
  await waitFor(async () => (await page('harness.view')).locale === 'ru');
});
