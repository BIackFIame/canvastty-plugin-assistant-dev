// Subscription quotas for routing without the settings page: the service reads CanvasTTY's limits itself where the
// core allows it (feature-detected, with the core's push), falls back to the page on an older core, keeps the windows
// across restarts with their age, notices early resets (Claude, Codex banked resets, a push flag) and ends the rests
// they make obsolete, takes reset times from limit messages, counts its own launches between reads, and uses the
// Accounts plugin's per-account quota. Provider shapes are fixtures; when CANVASTTY_REPO points at a checkout they go
// through CanvasTTY's own normalizers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouteService, accountRowsFrom } from '../src/route/service.ts';
import { coreEarlyResets, earlyResetOf, limitChanges, mergeLimits, parseLimits, quotaOf, resetFromText, PER_LAUNCH_PERCENT } from '../src/route/limits.ts';
import { LimitsFeed, FEED } from '../src/route/limitsFeed.ts';
import { accountRows, catalog, declared, index, NOW, providers } from './helpers/route-fixtures.mjs';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'canvastty-route-quota-')));
process.on('exit', () => rmSync(base, { recursive: true, force: true }));
const MIN = 60_000, H = 3_600_000;
const raw = name => JSON.parse(readFileSync(new URL(`./fixtures/quota/${name}`, import.meta.url), 'utf8'));
const lines = raw('exit-lines.json');

// ---------------------------------------------------------------------------------------------------------------
// Provider shapes → CanvasTTY's LimitsSnapshot (the core's normalizers when available, else the same rules here)
// ---------------------------------------------------------------------------------------------------------------

const core = process.env.CANVASTTY_REPO ? await import(join(process.env.CANVASTTY_REPO, 'src/main/services/LimitsService.ts')).catch(() => null) : null;
const localClaude = usage => ['five_hour', 'seven_day'].flatMap((key, i) => usage[key] ? [{ id: `claude:${key}`, bucketId: 'claude', slot: i ? 'secondary' : 'primary', isDefaultBucket: true, label: i ? '7d' : '5h', usedPercent: usage[key].utilization, used: null, limit: null, windowMinutes: i ? 10_080 : 300, resetsAt: usage[key].resets_at ? Date.parse(usage[key].resets_at) : null }] : []);
const localCodex = answer => ['primary', 'secondary'].flatMap(slot => answer.rateLimits[slot] ? [{ id: `codex:${slot}`, bucketId: 'codex', slot, isDefaultBucket: true, label: null, usedPercent: answer.rateLimits[slot].usedPercent, used: null, limit: null, windowMinutes: answer.rateLimits[slot].windowDurationMins, resetsAt: answer.rateLimits[slot].resetsAt * 1_000 }] : []);
const claudeWindows = usage => core ? core.normalizeClaudeLimits(usage) : localClaude(usage);
const codexWindows = answer => core ? core.normalizeCodexLimits(answer) : localCodex(answer);

function snapshot({ claude = 'claude-oauth-usage.json', codex = 'codex-rate-limits.json', at = NOW } = {}) {
  const providers = [];
  if (claude) providers.push({ provider: 'claude', state: 'available', source: 'claude-usage-api', fetchedAt: at, windows: claudeWindows(raw(claude)), accountScope: 'scope-SECRET' });
  if (codex) providers.push({ provider: 'codex', state: 'available', source: 'codex-app-server', fetchedAt: at, windows: codexWindows(raw(codex)) });
  return { state: 'ready', snapshot: { fetchedAt: at, providers } };
}

test('provider shapes: the core\'s normalizers give the windows routing reads (ids kept to compare reads)', { skip: !core }, () => {
  assert.deepEqual(core.normalizeClaudeLimits(raw('claude-oauth-usage.json')), localClaude(raw('claude-oauth-usage.json')));
  assert.deepEqual(core.normalizeCodexLimits(raw('codex-rate-limits.json')), localCodex(raw('codex-rate-limits.json')));
  assert.deepEqual(core.normalizeClaudeLimits(raw('claude-oauth-usage-early.json')).map(w => [w.id, w.usedPercent, w.resetsAt]), [['claude:five_hour', 0, null], ['claude:seven_day', 0, Date.parse('2026-10-25T12:10:00Z')]]);
});

test('parseLimits keeps window ids and drops the account scope', () => {
  const parsed = parseLimits(snapshot(), NOW);
  assert.deepEqual(parsed.providers[0].windows.map(w => [w.id, w.usedPercent]), [['claude:five_hour', 41], ['claude:seven_day', 41]]);
  assert.ok(!JSON.stringify(parsed).includes('SECRET'));
});

// ---------------------------------------------------------------------------------------------------------------
// Changes between reads
// ---------------------------------------------------------------------------------------------------------------

test('early resets: Claude 5 h back to 0 before 14:30, Codex banked reset, a 100 % window with room again', () => {
  const before = parseLimits(snapshot({ claude: 'claude-oauth-usage-exhausted.json', codex: 'codex-rate-limits-exhausted.json' }), NOW);
  const at = NOW + 60 * MIN;
  const after = parseLimits(snapshot({ claude: 'claude-oauth-usage-early.json', codex: 'codex-rate-limits-banked.json', at }), at);
  const changes = limitChanges(before, after, at);
  assert.deepEqual(changes.map(c => [c.provider, c.kind]), [['claude', 'early-reset'], ['codex', 'early-reset']]);
  assert.match(changes[0].note, /5h 100% → 0% before 14:30 UTC/u);
  // At the predicted time it is a reset, not an early one; a window going to 100 % is an exhaustion.
  const late = NOW + 155 * MIN;
  const fiveHourOnly = (used, resetsAt, at) => ({ snapshot: { providers: [{ provider: 'claude', state: 'available', fetchedAt: at, windows: [{ id: 'claude:five_hour', label: '5h', usedPercent: used, windowMinutes: 300, resetsAt }, { id: 'claude:seven_day', label: '7d', usedPercent: 44, windowMinutes: 10_080, resetsAt: Date.parse('2026-10-22T09:00:00Z') }] }] } });
  assert.deepEqual(limitChanges(parseLimits(fiveHourOnly(100, NOW + 150 * MIN, NOW), NOW), parseLimits(fiveHourOnly(0, null, late), late), late).map(c => c.kind), ['reset']);
  const normal = parseLimits(snapshot(), NOW);
  assert.deepEqual(limitChanges(normal, parseLimits(snapshot({ claude: 'claude-oauth-usage-exhausted.json', codex: null, at }), at), at).map(c => [c.provider, c.kind]), [['claude', 'exhausted']]);
  // Ordinary use, or the same read again, changes nothing.
  assert.deepEqual(limitChanges(normal, parseLimits(snapshot({ at }), at), at), []);
  assert.deepEqual(limitChanges(normal, normal, at), []);
});

test('the owner\'s rule: a clear drop before the announced time is an early reset, with the old time shown or a new one; moved times and dips are noise', () => {
  const before = parseLimits(snapshot({ claude: 'claude-oauth-usage-exhausted.json', codex: null }), NOW);
  const at = NOW + 30 * MIN;
  const kept = limitChanges(before, parseLimits(snapshot({ claude: 'claude-oauth-usage-early-kept.json', codex: null, at }), at), at);
  assert.deepEqual(kept.map(c => c.kind), ['early-reset']);
  assert.deepEqual(kept[0].early, [{ provider: 'claude', window: 'claude:five_hour', label: '5h', usedBefore: 100, usedAfter: 2, announcedResetAt: Date.parse('2026-10-18T14:30:00Z'), reportedResetAtAfter: Date.parse('2026-10-18T14:30:00Z'), resetTimeKept: true }]);
  assert.match(kept[0].note, /old reset time still shown/u);
  // The kept old time then arrives with little use: not another reset.
  const afterKept = parseLimits(snapshot({ claude: 'claude-oauth-usage-early-kept.json', codex: null, at }), at);
  const late = Date.parse('2026-10-18T14:31:00Z');
  const arrival = parseLimits(snapshot({ claude: 'claude-oauth-usage-early-kept.json', codex: null, at: late }), late);
  arrival.providers[0].windows[0] = { ...arrival.providers[0].windows[0], usedPercent: 6, resetsAt: Date.parse('2026-10-18T19:31:00Z') };
  assert.deepEqual(limitChanges(afterKept, arrival, late), []);
  // Noise: the 5 h reset moved an hour, use 41 → 38 and 41 → 40.
  const normal = parseLimits(snapshot({ codex: null }), NOW);
  assert.deepEqual(limitChanges(normal, parseLimits(snapshot({ claude: 'claude-oauth-usage-noise.json', codex: null, at }), at), at), []);
  // A used-up window with a little room: usable, "recovered", and no rest ends for it.
  const nearly = parseLimits(snapshot({ claude: 'claude-oauth-usage-exhausted.json', codex: null, at }), at);
  nearly.providers[0].windows[0] = { ...nearly.providers[0].windows[0], usedPercent: 96 };
  assert.deepEqual(limitChanges(before, nearly, at).map(c => c.kind), ['recovered']);
});

test('CanvasTTY\'s earlyResets entries (final fields; the first build\'s names still read); account homes are left out', () => {
  assert.deepEqual(coreEarlyResets([
    { provider: 'claude', windowId: 'claude:five_hour', slot: 'primary', windowLabel: '5h', windowMinutes: 300, usedBefore: 90, usedAfter: 3, announcedResetAt: 2_000, reportedResetAtAfter: 2_000, resetTimeKept: true },
    { provider: 'codex', windowId: 'codex:secondary', slot: 'secondary', windowLabel: null, windowMinutes: 10_080, usedBefore: 60, usedAfter: 0, announcedResetAt: 5, reportedResetAtAfter: null, resetTimeKept: false },
    { provider: 'kimi', windowId: 'kimi:weekly', previousResetsAt: 7, resetsAt: 7, previousUsedPercent: 50, usedPercent: 1 },
    { provider: 'claude', home: '/data/homes/claude-a', windowId: 'claude:five_hour', usedBefore: 90, usedAfter: 0 },
    { provider: 'Bad Name' }, 'x'
  ]), [
    { provider: 'claude', window: 'claude:five_hour', label: '5h', usedBefore: 90, usedAfter: 3, announcedResetAt: 2_000, reportedResetAtAfter: 2_000, resetTimeKept: true },
    { provider: 'codex', window: 'codex:secondary', label: null, usedBefore: 60, usedAfter: 0, announcedResetAt: 5, reportedResetAtAfter: null, resetTimeKept: false },
    { provider: 'kimi', window: 'kimi:weekly', label: null, usedBefore: 50, usedAfter: 1, announcedResetAt: 7, reportedResetAtAfter: 7, resetTimeKept: true }
  ]);
});

test('thresholds match CanvasTTY\'s detector: >5 min before the announced reset, drop ≥ max(5, half) or to ≤5 % by >2 points, same time within 1 min', () => {
  const w = (used, resetsAt) => ({ id: 'claude:five_hour', label: '5h', usedPercent: used, windowMinutes: 300, resetsAt });
  assert.equal(earlyResetOf('claude', 'claude:five_hour', w(80, NOW + 4 * MIN), w(0, null), NOW), null);
  assert.equal(earlyResetOf('claude', 'claude:five_hour', w(80, NOW + 6 * MIN), w(0, null), NOW).usedAfter, 0);
  assert.equal(earlyResetOf('claude', 'claude:five_hour', w(4, NOW + H), w(2, NOW + H), NOW), null);
  assert.equal(earlyResetOf('claude', 'claude:five_hour', w(4, NOW + H), w(1, NOW + H), NOW).usedBefore, 4);
  assert.equal(earlyResetOf('claude', 'claude:five_hour', w(30, NOW + H), w(26, NOW + 2 * H), NOW), null, 'a moved time with a small drop is not a reset');
  assert.equal(earlyResetOf('claude', 'claude:five_hour', w(80, NOW + H), w(0, NOW + H + 50_000), NOW).resetTimeKept, true);
  assert.equal(earlyResetOf('claude', 'claude:five_hour', w(80, NOW + H), w(0, NOW + H + 90_000), NOW).resetTimeKept, false);
});

test('mergeLimits: an older page forward never replaces a newer read of the same provider', () => {
  const newer = parseLimits(snapshot({ at: NOW }), NOW);
  const older = parseLimits(snapshot({ claude: 'claude-oauth-usage-exhausted.json', codex: null, at: NOW - 10 * MIN }), NOW);
  const merged = mergeLimits({ ...newer, source: 'core' }, { ...older, source: 'page' });
  assert.equal(merged.providers.find(p => p.provider === 'claude').windows[0].usedPercent, 41);
  assert.equal(merged.providers.length, 2);
});

test('reset times from limit messages (local time as the CLIs print it; Z.AI zone chosen within a week)', () => {
  const local = (y, m, d, h, mi) => new Date(y, m, d, h, mi).getTime();
  const now = local(2026, 9, 18, 13, 0);
  assert.equal(resetFromText(lines['claude-statusline'], now), local(2026, 9, 18, 15, 0));
  assert.equal(resetFromText(lines['claude-weekly'], now), local(2026, 9, 20, 11, 0));
  assert.equal(resetFromText(lines['claude-epoch'], now), 1792344600 * 1_000);
  assert.equal(resetFromText(lines['codex-today'], now), local(2026, 9, 18, 15, 5));
  assert.equal(resetFromText(lines['codex-dated'], now), local(2026, 9, 22, 15, 5));
  assert.equal(resetFromText(lines['zai-1308'], Date.parse('2026-10-18T12:00:00Z')), Date.parse('2026-10-18T14:30:00Z'));
  assert.equal(resetFromText(lines['no-time'], now), null);
  // A time already past today is tomorrow's.
  assert.equal(resetFromText(['limit reached ∙ resets 9am'], now), local(2026, 9, 19, 9, 0));
});

test('own launches between reads count against the window (an estimate, said so)', () => {
  const claude = parseLimits(snapshot(), NOW).providers[0];
  const fresh = quotaOf(claude, 0, NOW);
  const used = quotaOf(claude, 0, NOW, 3);
  assert.equal(fresh.headroom - used.headroom, 3 * PER_LAUNCH_PERCENT);
  assert.match(used.note, /3 routed launch\(es\) since the read counted as ~6%/u);
});

// ---------------------------------------------------------------------------------------------------------------
// The route service
// ---------------------------------------------------------------------------------------------------------------

function fakeHost(answers = {}) {
  const calls = [], logs = [];
  return {
    calls, logs,
    callHost: async (method, params) => {
      calls.push({ method, params });
      if (method in answers) { const answer = answers[method]; if (answer instanceof Error) throw answer; return typeof answer === 'function' ? answer(params) : answer; }
      if (method === 'storage.set' || method === 'storage.get') return null;
      throw new Error(`Unknown host method: ${method}.`);
    },
    log(level, message) { logs.push({ level, message }); }, emit() {}
  };
}

function service({ dataDir = mkdtempSync(join(base, 'data-')), host = fakeHost(), clock = { now: NOW } } = {}) {
  const route = new RouteService({
    host, dataDir, saved: declared({ plans: declared().plans.filter(plan => plan.id !== 'glm-plan') }), enabled: () => true,
    classify: async () => ({ difficulty: 'normal', strong: false, type: 'research', confidence: 0.2 }),
    catalog: () => ({ catalog: catalog(), index: index() }), preference: () => 'balanced',
    autoExpectation: async () => ({ model: 'z-ai/glm-5.3', identity: 'glm-5-3', effort: 'max', priceIn: 0.6, priceOut: 2.2, trusted: true }),
    cardClass: () => 'D1', dataClassMode: () => 'warn', now: () => clock.now, random: () => 0.5
  });
  return { route, host, dataDir, clock };
}
const orchestrator = { id: 'orch-quota-0001', provider: 'claude', role: 'orchestrator', title: 'Lead', status: 'working', cwd: base, workingDirectory: base };
const lastJson = answer => JSON.parse(answer.content.split('\n').at(-1));
const input = (task, extra = {}) => ({ task, providers: providers(), accountRoutes: accountRows(), ...extra });
const spawnFrom = (route, answer, id) => route.sessionEvent({ type: 'created', session: { id, provider: answer.spawn.provider, role: 'subagent', parentSessionId: orchestrator.id, status: 'starting' } });

test('limit exit → rest until the time its message names → an early reset read ends the rest at once', async () => {
  const { route, host, clock } = service();
  route.receiveLimits(snapshot(), 'core');
  const first = lastJson(await route.tool('route', orchestrator, input('Explain the cache layer')));
  assert.equal(first.route.label, 'Max');
  spawnFrom(route, first, 'child-q-0001');
  clock.now += 20 * MIN;
  const recorded = await route.tool('route_outcome', orchestrator, { decisionId: first.decisionId, status: 'failed', exitLines: lines['claude-epoch'] });
  assert.match(recorded.content, /Max rests until 17:30 UTC/u);
  assert.notEqual(lastJson(await route.tool('route', orchestrator, input('Explain the cache layer'))).route.label, 'Max');
  // The core reads Claude again: the 5 h window was reset early (a bonus reset).
  clock.now += 10 * MIN;
  const answer = route.receiveLimits(snapshot({ claude: 'claude-oauth-usage-early.json', codex: null, at: clock.now }), 'core');
  assert.deepEqual(answer.changes.map(c => [c.provider, c.kind]), [['claude', 'early-reset']]);
  assert.equal(route.state().cooldowns.length, 0);
  assert.equal(lastJson(await route.tool('route', orchestrator, input('Explain the cache layer'))).route.label, 'Max');
  assert.ok(host.logs.some(entry => /quota claude: early reset/u.test(entry.message)));
  assert.deepEqual(route.state().quotaEvents.map(e => e.kind), ['limit-exit', 'early-reset']);
});

test('a task finished on a resting route ends its rest (a refused call that now works); a read barely under 100 % does not', async () => {
  const { route, clock } = service();
  route.receiveLimits(snapshot(), 'core');
  const first = lastJson(await route.tool('route', orchestrator, input('Explain the cache layer')));
  spawnFrom(route, first, 'child-q-0002');
  clock.now += MIN;
  await route.tool('route_outcome', orchestrator, { decisionId: first.decisionId, status: 'failed', exitLines: ['5-hour limit reached ∙ resets 11pm'] });
  assert.equal(route.state().cooldowns.length, 1);
  // A read right after the exit at 97 %: still resting.
  clock.now += MIN;
  const nearly = snapshot({ claude: null, codex: null, at: clock.now });
  nearly.snapshot.providers.push({ provider: 'claude', state: 'available', source: 'claude-usage-api', fetchedAt: clock.now, windows: [{ id: 'claude:five_hour', label: '5h', usedPercent: 97, windowMinutes: 300, resetsAt: NOW + 150 * MIN }] });
  route.receiveLimits(nearly, 'core');
  assert.equal(route.state().cooldowns.length, 1);
  // The orchestrator chose Max anyway (its own choice) and that child finished: the limit is gone.
  const second = { decisionId: null };
  route.records.add({ id: 'manual01', at: clock.now, card: orchestrator.id.slice(0, 8), type: 'research', level: 'medium', typeFrom: 'jev', confidence: 0.2, strategy: 'single-strong', cohort: null, candidates: 1, dropped: 0, explored: false, preferred: false, options: [route.records.get(first.decisionId).options[0]] });
  second.decisionId = 'manual01';
  route.sessionEvent({ type: 'created', session: { id: 'child-q-0003', provider: 'claude', role: 'subagent', parentSessionId: orchestrator.id, status: 'starting' } });
  clock.now += 5 * MIN;
  const done = await route.tool('route_outcome', orchestrator, { decisionId: 'manual01', status: 'done' });
  assert.match(done.content, /Recorded done/u);
  assert.equal(route.state().cooldowns.length, 0);
  assert.equal(route.state().quotaEvents.at(-1).kind, 'recovered');
});

test('limits survive a restart with their read time; after 30 minutes they are unknown, never used up', async () => {
  const dataDir = mkdtempSync(join(base, 'data-'));
  const clock = { now: NOW };
  const { route } = service({ dataDir, clock });
  route.receiveLimits(snapshot({ claude: 'claude-oauth-usage-exhausted.json' }), 'core');
  await route.flush();
  const file = readFileSync(join(dataDir, 'route', 'limits.json'), 'utf8');
  assert.ok(!file.includes('SECRET'));
  clock.now += 5 * MIN;
  const again = service({ dataDir, clock }).route;
  assert.equal(again.limits.source, 'saved');
  const max = again.state().plans.find(plan => plan.id === 'claude-max');
  assert.equal(max.quota.state, 'exhausted');
  assert.equal(max.quota.readAt, NOW);
  clock.now += 30 * MIN;
  const old = again.state().plans.find(plan => plan.id === 'claude-max').quota;
  assert.equal(old.state, 'unknown');
  assert.equal(old.code, 'stale');
  assert.deepEqual(again.state().quotaEvents.map(e => e.kind), [], 'events kept are the ones seen');
});

test('Accounts\' per-route quota: parsed, a used-up account is skipped even when an orchestrator passes it as ready, and its rest ends on a newer read with room', async () => {
  const rows = accountRowsFrom({ routes: [
    { provider: 'opencode', accountId: 'glm-53', account: 'GLM 5.3', model: 'glm-5.3', endpoint: 'api.z.ai', state: 'ready', launchOptions: { 'canvastty-accounts': { account: 'glm-53', effort: 'default', trustFolder: false } },
      quota: { state: 'exhausted', remainingPercent: 0, window: '5h', resetsAt: new Date(NOW + H).toISOString(), source: 'zai-quota-api', observedAt: new Date(NOW - MIN).toISOString(), ageMinutes: 1, confidence: 'exact', launchesSinceRead: 0, note: 'used up; resets 13:00 UTC', extra: 'dropped' } }
  ] });
  assert.deepEqual(rows[0].quota, { state: 'exhausted', remainingPercent: 0, resetsAt: NOW + H, observedAt: NOW - MIN, source: 'zai-quota-api', confidence: 'exact', note: 'used up; resets 13:00 UTC' });
  const { route, clock } = service();
  route.receiveLimits(snapshot({ claude: 'claude-oauth-usage-exhausted.json', codex: 'codex-rate-limits-exhausted.json' }), 'core');
  const withQuota = accountRows().map(row => row.accountId === 'zai-glm' ? { ...row, quota: { state: 'exhausted', remainingPercent: 0, resetsAt: new Date(NOW + H).toISOString(), observedAt: new Date(NOW - MIN).toISOString(), source: 'zai-quota-api', confidence: 'exact', note: 'used up' } } : row);
  const decided = await route.decideFor(orchestrator, { task: 'Explain the cache layer', providers: providers(), accountRoutes: withQuota });
  const all = [decided.decision.top, ...decided.decision.alternatives, ...decided.decision.groups.flat()].filter(Boolean);
  assert.ok(!all.some(c => c.accountId === 'zai-glm'), 'the used-up account is not offered');
  assert.ok(decided.decision.dropped.some(d => /account's quota is used up/u.test(d.reason)), JSON.stringify(decided.decision.dropped));
  // A rest on the account (a limit exit) ends when Accounts shows a newer read with room.
  route.cooldowns.set('account:zai-glm', { until: NOW + 2 * H, at: NOW, reason: 'it hit a usage limit' });
  clock.now += 10 * MIN;
  const fresh = accountRows().map(row => row.accountId === 'zai-glm' ? { ...row, quota: { state: 'ok', remainingPercent: 96, resetsAt: null, observedAt: new Date(clock.now - MIN).toISOString(), source: 'zai-quota-api', confidence: 'exact', note: '' } } : row);
  await route.decideFor(orchestrator, { task: 'Explain the cache layer', providers: providers(), accountRoutes: fresh });
  assert.equal(route.cooldowns.has('account:zai-glm'), false);
  assert.equal(route.state().quotaEvents.at(-1).kind, 'early-reset');
});

test('own routed launches since the read lower the subscription headroom in the page and the engine', async () => {
  const { route, clock } = service();
  route.receiveLimits(snapshot({ codex: null }), 'core');
  const free = route.state().plans.find(plan => plan.id === 'claude-max').quota.headroom;
  for (let i = 0; i < 2; i++) {
    const answer = lastJson(await route.tool('route', orchestrator, input('Explain the cache layer')));
    spawnFrom(route, answer, `child-l-000${i}`);
    route.sessionEvent({ type: 'exited', session: { id: `child-l-000${i}`, provider: 'claude', role: 'subagent', parentSessionId: orchestrator.id, status: 'exited', exitCode: 0 } });
    clock.now += MIN;
  }
  assert.equal(route.launchesSinceRead('claude'), 2);
  assert.equal(route.state().plans.find(plan => plan.id === 'claude-max').quota.headroom, Math.round((free - 2 * PER_LAUNCH_PERCENT) * 1000) / 1000);
  route.receiveLimits(snapshot({ codex: null, at: clock.now }), 'core');
  assert.equal(route.launchesSinceRead('claude'), 0, 'a new read starts the count again');
});

// ---------------------------------------------------------------------------------------------------------------
// The feed: the core's limits.get for services, its push, and the page fallback
// ---------------------------------------------------------------------------------------------------------------

function feedWith(answers, clock = { now: NOW }) {
  const host = fakeHost(answers);
  const { route } = service({ host, clock });
  const timers = [];
  const feed = new LimitsFeed({ host, sink: route, now: () => clock.now, random: () => 0.5, setTimer: (run, ms) => { timers.push({ run, ms }); return timers.length; }, clearTimer: () => undefined });
  return { feed, route, host, timers, clock };
}

const SUB = { 'limits.subscribe': { state: 'loading', snapshot: null } };

test('feed on a newer core: the service subscribes, reads limits itself (no page needed) and schedules the next read', async () => {
  const { feed, route, host, timers } = feedWith({ ...SUB, 'limits.get': snapshot() });
  assert.equal(await feed.start(), 'core');
  assert.deepEqual(host.calls.filter(c => c.method.startsWith('limits.')).map(c => [c.method, c.params]), [['limits.subscribe', {}], ['limits.get', {}]]);
  assert.equal(feed.subscribed, true);
  // Later reads do not subscribe again (until the service restarts).
  await feed.read();
  assert.equal(host.calls.filter(c => c.method === 'limits.subscribe').length, 1);
  assert.equal(route.limits.source, 'core');
  assert.equal(route.state().plans.find(plan => plan.id === 'claude-max').quota.state, 'known');
  // Nothing routed yet: idle interval (15 min ± 15 %) unless a reset is near.
  assert.equal(timers.at(-1).ms, FEED.idleMs);
});

test('feed on an older core ("Unknown host method"): the page path stays, and the core is asked again later', async () => {
  const { feed, route, timers } = feedWith({});
  assert.equal(await feed.start(), 'page-only');
  assert.equal(timers.at(-1).ms, FEED.reprobeMs);
  assert.equal(route.limits, null);
  // The page forwards: routing works as before.
  route.receiveLimits(snapshot(), 'page');
  assert.equal(route.limits.source, 'page');
  // No permission: the same.
  const denied = feedWith({ 'limits.subscribe': new Error('Plugin does not have the limits:read permission.') });
  assert.equal(await denied.feed.start(), 'page-only');
});

test('feed schedule: just after a predicted reset, every 2 min while a route rests, back-off on failures', async () => {
  const near = feedWith({ ...SUB, 'limits.get': () => snapshot({ codex: null }) });
  await near.feed.start();
  near.clock.now = Date.parse('2026-10-18T14:25:00Z');
  assert.equal(near.feed.nextDelay(), 5 * MIN + FEED.afterResetMs + 5_000);
  const resting = feedWith({ ...SUB, 'limits.get': snapshot() });
  await resting.feed.start();
  resting.route.cooldowns.set('cli:claude', { until: NOW + H, at: NOW, reason: 'x' });
  assert.equal(resting.feed.nextDelay(), FEED.restingMs);
  const failing = feedWith({ ...SUB, 'limits.get': new Error('The host did not answer limits.get in time.') });
  await failing.feed.start();
  assert.equal(failing.feed.mode, 'core');
  assert.equal(failing.timers.at(-1).ms, FEED.failureBaseMs);
  await failing.feed.read();
  assert.equal(failing.timers.at(-1).ms, 2 * FEED.failureBaseMs);
  assert.match(failing.feed.lastError, /did not answer/u);
});

test('push: canvastty.limits.changed with a snapshot and the core\'s early-reset flag ends rests at once; without a snapshot it reads now', async () => {
  const { feed, route, host } = feedWith({ 'limits.subscribe': snapshot({ claude: 'claude-oauth-usage-exhausted.json', at: NOW - 2 * MIN }), 'limits.get': snapshot({ claude: 'claude-oauth-usage-exhausted.json' }) });
  await feed.start();
  route.cooldowns.set('plan:claude-max', { until: NOW + 2 * H, at: NOW - MIN, reason: 'it hit a usage limit' });
  // A change of an account home another plugin keeps is not the default login's.
  feed.changed({ state: 'ready', snapshot: snapshot({ claude: 'claude-oauth-usage-early.json', at: NOW + MIN }).snapshot, earlyReset: true, earlyResets: [{ provider: 'claude', windowId: 'claude:five_hour' }], provider: 'claude', home: '/x' });
  assert.equal(route.cooldowns.has('plan:claude-max'), true);
  // The same windows as far as this read shows, but the core saw the early reset (it compares every read it makes).
  feed.changed({ state: 'ready', snapshot: snapshot({ claude: 'claude-oauth-usage-exhausted.json', at: NOW + MIN }).snapshot, earlyReset: true,
    earlyResets: [{ provider: 'claude', windowId: 'claude:five_hour', slot: 'primary', windowLabel: '5h', windowMinutes: 300, usedBefore: 100, usedAfter: 4, announcedResetAt: NOW + 150 * MIN, reportedResetAtAfter: NOW + 150 * MIN, resetTimeKept: true }] });
  assert.equal(route.cooldowns.has('plan:claude-max'), false);
  const event = route.state().quotaEvents.find(e => e.kind === 'early-reset');
  assert.match(event.note, /5h 100% → 4% before 14:30 UTC \(old reset time still shown\) \(CanvasTTY\)/u);
  assert.equal(event.early[0].resetTimeKept, true);
  const before = host.calls.filter(c => c.method === 'limits.get').length;
  feed.changed({ state: 'ready' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.calls.filter(c => c.method === 'limits.get').length, before + 1);
  assert.equal(route.limits.source, 'core');
});

// ---------------------------------------------------------------------------------------------------------------
// Against CanvasTTY's own PluginLimits (when CANVASTTY_REPO is a core with service limits)
// ---------------------------------------------------------------------------------------------------------------

const coreLimitsPath = process.env.CANVASTTY_REPO ? join(process.env.CANVASTTY_REPO, 'src/main/services/PluginLimits.ts') : null;
const coreLimits = coreLimitsPath ? await import(coreLimitsPath).catch(() => null) : null;

test('through CanvasTTY\'s PluginLimits: subscribe, get, and its changed push with earlyResets end a rest (CANVASTTY_REPO with service limits)', { skip: !coreLimits }, async () => {
  const clock = { now: NOW };
  let current = snapshot({ claude: 'claude-oauth-usage-exhausted.json' }).snapshot;
  const listeners = [];
  const source = { get: async () => current, peek: () => current, getHome: async () => { throw new Error('no homes here'); }, onChange: listener => { listeners.push(listener); return () => undefined; } };
  let feed = null;
  const plugin = new coreLimits.PluginLimits({
    limits: source, allowed: (_id, permission) => permission === 'limits:read', debounceMs: 1, now: () => clock.now,
    notify: (_plugin, _service, method, params) => { assert.equal(method, 'canvastty.limits.changed'); feed.changed(params); return true; }
  });
  const host = fakeHost();
  const permissions = ['limits:read'];
  host.callHost = async (method, params) => {
    host.calls.push({ method, params });
    const answer = plugin.handle('canvastty-assistant', 'assistant', method, params, permissions, base);
    if (answer === undefined) throw new Error(`Unknown host method: ${method}.`);
    return answer;
  };
  const { route } = service({ host, clock });
  feed = new LimitsFeed({ host, sink: route, now: () => clock.now, random: () => 0.5, setTimer: () => 1, clearTimer: () => undefined });
  assert.equal(await feed.start(), 'core');
  assert.equal(route.state().plans.find(plan => plan.id === 'claude-max').quota.state, 'exhausted');
  // An account home is not ours to ask about (and needs launch:contribute).
  await assert.rejects(host.callHost('limits.get', { provider: 'claude', home: join(base, 'x') }), /launch:contribute/u);
  route.cooldowns.set('plan:claude-max', { until: NOW + 2 * H, at: NOW, reason: 'it hit a usage limit' });
  clock.now += 20 * MIN;
  current = snapshot({ claude: 'claude-oauth-usage-early.json', at: clock.now }).snapshot;
  for (const listener of listeners) listener({ snapshot: current, earlyResets: [{ provider: 'claude', windowId: 'claude:five_hour', slot: 'primary', windowLabel: '5h', windowMinutes: 300, usedBefore: 100, usedAfter: 0, announcedResetAt: NOW + 150 * MIN, reportedResetAtAfter: null, resetTimeKept: false }] });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(route.cooldowns.has('plan:claude-max'), false);
  assert.ok(route.state().quotaEvents.some(event => event.kind === 'early-reset' && event.provider === 'claude'));
  assert.equal(route.state().plans.find(plan => plan.id === 'claude-max').quota.state, 'known');
  plugin.dispose();
});

test('same verdicts as CanvasTTY\'s own detectEarlyResets on the fixtures (CANVASTTY_REPO with it)', { skip: !core?.detectEarlyResets }, () => {
  const at = NOW + 30 * MIN;
  const cases = [
    ['claude-oauth-usage-exhausted.json', 'claude-oauth-usage-early.json'],
    ['claude-oauth-usage-exhausted.json', 'claude-oauth-usage-early-kept.json'],
    ['claude-oauth-usage.json', 'claude-oauth-usage-noise.json'],
    ['claude-oauth-usage.json', 'claude-oauth-usage.json']
  ];
  for (const [first, second] of cases) {
    const a = snapshot({ claude: first, codex: null }).snapshot;
    const b = snapshot({ claude: second, codex: null, at }).snapshot;
    const theirs = core.detectEarlyResets(a, b, at).map(e => [e.windowId, e.usedBefore, e.usedAfter, e.reportedResetAtAfter, e.resetTimeKept]);
    const ours = (limitChanges(parseLimits({ snapshot: a }, NOW), parseLimits({ snapshot: b }, at), at).find(c => c.kind === 'early-reset')?.early ?? [])
      .map(e => [e.window, e.usedBefore, e.usedAfter, e.reportedResetAtAfter, e.resetTimeKept]);
    assert.deepEqual(ours, theirs, `${first} → ${second}`);
  }
  const codexA = snapshot({ claude: null, codex: 'codex-rate-limits-exhausted.json' }).snapshot;
  const codexB = snapshot({ claude: null, codex: 'codex-rate-limits-banked.json', at }).snapshot;
  assert.deepEqual(
    (limitChanges(parseLimits({ snapshot: codexA }, NOW), parseLimits({ snapshot: codexB }, at), at)[0]?.early ?? []).map(e => [e.window, e.usedAfter, e.resetTimeKept]),
    core.detectEarlyResets(codexA, codexB, at).map(e => [e.windowId, e.usedAfter, e.resetTimeKept]));
});
