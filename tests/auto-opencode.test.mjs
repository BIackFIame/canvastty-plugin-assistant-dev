// Model: Auto (Jev) with the real OpenCode CLI (opt-in: OPENCODE_BIN=/path/to/opencode), offline: OpenCode runs
// `opencode run` with a fake HOME and the run-folder config Auto writes; the router answers from a fake upstream
// on 127.0.0.1. On macOS the CLI runs under sandbox-exec with outbound network denied except loopback, so nothing
// can reach OpenCode Zen, models.dev or any model. Checks: titles go to auto-small, the turn to auto, a tool-call
// continuation reuses the turn's decision, only the fake upstream is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoRouter } from '../src/auto/router.ts';
import { openCodeContribution } from '../src/auto/launch.ts';
import { validateAutoSettings } from '../src/auto/settings.ts';
import { startFakeUpstream } from './helpers/fake-upstream.mjs';

const bin = process.env.OPENCODE_BIN;
const SANDBOX = '/usr/bin/sandbox-exec';

test('the real OpenCode CLI on Auto (Jev): titles on auto-small, one decision per turn, only the configured upstream', { skip: !bin && 'set OPENCODE_BIN to an OpenCode binary', timeout: 90_000 }, async t => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'canvastty-auto-opencode-')));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const home = join(work, 'home');
  const project = join(work, 'project');
  for (const dir of [home, join(home, 'tmp'), join(project, '.git')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(project, 'a.txt'), 'alpha\n');
  const upstream = await startFakeUpstream();
  t.after(() => upstream.close());
  const settings = validateAutoSettings({
    upstreams: [{ id: 'fake', preset: 'openai-compatible', baseUrl: upstream.url, trust: 'D2', key: 'own', enabled: true, models: [{ id: 'vendor/small', tier: 'small' }, { id: 'vendor/medium', tier: 'medium' }, { id: 'vendor/large', tier: 'large' }] }],
    preference: 'balanced', cheaperFallback: false, decider: 'jev', dailyUsdCap: 1, perCardUsdCap: 1
  });
  const jev = [];
  const router = new AutoRouter({ directory: join(work, 'auto'), settings: () => settings, dataClassMode: () => 'strict', key: async () => 'up-key', decide: async text => { jev.push(text.length); return { difficulty: 'normal', strong: false }; } });
  t.after(() => router.stop());
  const { token, port } = await router.grant({ sessionId: 'card-oc-1', provider: 'opencode', role: 'agent', parentSessionId: null, dataClass: 'D1' });
  const contribution = openCodeContribution({ port, token, settings });
  const runDir = join(work, 'run');
  mkdirSync(runDir);
  writeFileSync(join(runDir, 'opencode.json'), contribution.files[0].content, { mode: 0o600 });
  const env = {
    PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local/state'), TMPDIR: join(home, 'tmp'), OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_CONFIG: join(runDir, 'opencode.json'), CTTY_JEV_ROUTER_KEY: token
  };
  const args = ['run', ...contribution.args, 'Read a.txt and say what it contains'];
  let command = bin, argv = args;
  if (process.platform === 'darwin' && existsSync(SANDBOX)) {
    const profile = join(work, 'nonet.sb');
    writeFileSync(profile, '(version 1)\n(allow default)\n(deny network-outbound)\n(allow network-outbound (remote ip "localhost:*"))\n(allow network-outbound (remote unix-socket))\n');
    command = SANDBOX; argv = ['-f', profile, bin, ...args];
  }
  // stdin closed: `opencode run` would otherwise wait to read a message from it.
  const output = await new Promise(resolve => { execFile(command, argv, { cwd: project, env, timeout: 60_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr })).stdin.end(); });
  assert.equal(output.error, null, output.stderr.slice(-2_000));
  const models = upstream.posts().map(entry => entry.model);
  assert.ok(models.includes('vendor/small'), `the title call went to auto-small → the cheapest model: ${models}`);
  assert.ok(models.filter(model => model === 'vendor/medium').length >= 2, `the turn and its tool-call continuation: ${models}`);
  assert.ok(upstream.posts().every(entry => entry.auth === 'Bearer up-key'));
  assert.equal(jev.length, 1, 'one decision for the turn; the continuation and the title asked nobody');
  const stats = router.statsView();
  assert.ok(stats.leaseReuses >= 1);
  assert.deepEqual(stats.hosts, [`127.0.0.1:${upstream.port}`]);
  assert.match(output.stdout, /DONE-AFTER-TOOL/u);
});
