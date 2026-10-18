// Route v2 through the Assistant service: the tools (route, pick_route, route_outcome), decision records without
// task text, the limit windows the page forwards, routed children counted from session events (at most N at once,
// coding-plan launches), cooldowns after a usage-limit exit, the person's ✓/✗, and the page's state and save.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Assistant } from '../src/service/assistant.ts';
import { RouteService } from '../src/route/service.ts';
import { DEFAULT_ROUTE_SETTINGS, MAX_SETTINGS_CHARS, validateRouteSettings } from '../src/route/settings.ts';
import { accountRows, catalog, declared, index, limitsAnswer, NOW, providers } from './helpers/route-fixtures.mjs';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'canvastty-route-service-')));
process.on('exit', () => rmSync(base, { recursive: true, force: true }));
const MARKER = 'PRIVATE-TASK-MARKER-7f3a';

function fakeHost() {
  const calls = [], events = [], storage = {};
  return {
    calls, events, storage,
    callHost: async (method, params) => { calls.push({ method, params }); if (method === 'storage.set') { storage[params.key] = params.value; return null; } if (method === 'storage.get') return storage[params.key] ?? null; return null; },
    log() {}, emit(event, data) { events.push({ event, data }); }
  };
}

function service(extra = {}) {
  let now = NOW;
  const host = fakeHost();
  const dataDir = mkdtempSync(join(base, 'data-'));
  const views = new Map();
  const route = new RouteService({
    host, dataDir, saved: declared({ plans: declared().plans.filter(plan => plan.id !== 'glm-plan') }), enabled: () => true,
    classify: async task => views.get(task) ?? { difficulty: 'normal', strong: false, type: 'research', confidence: 0.2 },
    catalog: () => ({ catalog: catalog(), index: index() }), preference: () => 'balanced',
    autoExpectation: async () => ({ model: 'z-ai/glm-5.3', identity: 'glm-5-3', effort: 'max', priceIn: 0.6, priceOut: 2.2, trusted: true }),
    cardClass: () => 'D1', dataClassMode: () => 'warn', now: () => now, random: () => 0.5, ...extra
  });
  route.receiveLimits(limitsAnswer());
  return { route, host, dataDir, views, tick: ms => { now += ms; } };
}
const orchestrator = { id: 'orch-1234-abcd', provider: 'claude', role: 'orchestrator', title: 'Lead', status: 'working', cwd: base, workingDirectory: base };
const lastJson = answer => JSON.parse(answer.content.split('\n').at(-1));
const input = (task, extra = {}) => ({ task, providers: providers(), accountRoutes: accountRows(), ...extra });

test('route and pick_route: the choice, two alternatives, why-lines and estimates; the record keeps no task text', async () => {
  const { route, dataDir } = service();
  const answer = await route.tool('route', orchestrator, input(`Explain the cache layer ${MARKER}`));
  assert.notEqual(answer.isError, true);
  assert.match(answer.content, /^Suggested: claude · opus@max \(= claude-opus-4-8, alias table\) on Max · score [\d.]+ for research/u);
  assert.match(answer.content, /Estimate: ≈ 8% of the 5 h \(now 41% used\)\./u);
  assert.match(answer.content, /Pass these to spawn_agent .*\{"provider":"claude","launchOptions":\{"canvastty-accounts":\{"account":"none"\},"canvastty-assistant":\{"model":"off"\}\},"model":"opus","effort":"max"\}/u);
  assert.match(answer.content, /Alternative 1: .*\nAlternative 2: /u);
  assert.match(answer.content, /strategy single-strong/u);
  const json = lastJson(answer);
  assert.equal(json.alternatives.length, 2);
  assert.equal(json.route.kind, 'subscription');
  assert.ok(!answer.content.includes(MARKER), 'the answer does not repeat the task');
  const same = await route.tool('pick_route', orchestrator, input(`Explain the cache layer ${MARKER}`));
  assert.deepEqual(lastJson(same).spawn, json.spawn, 'pick_route is route under the name list_providers points to');
  await route.flush();
  const file = readFileSync(join(dataDir, 'route', 'decisions.json'), 'utf8');
  assert.ok(!file.includes(MARKER), 'no task text in the decision file');
  const record = JSON.parse(file)[0];
  assert.deepEqual([record.card, record.type, record.level, record.strategy, record.options.length], ['orch-123', 'research', 'medium', 'single-strong', 3]);
  assert.match(record.options[0].why, /subscription: free/u);
});

test('busy: children that appear after an answer count against the subscription; at 2 it is skipped until one ends', async () => {
  const { route } = service();
  const spawnOn = async (id) => {
    const answer = lastJson(await route.tool('route', orchestrator, input('Explain the cache layer')));
    route.sessionEvent({ type: 'created', session: { id, provider: answer.spawn.provider, role: 'subagent', parentSessionId: orchestrator.id, status: 'starting' } });
    return answer;
  };
  assert.equal((await spawnOn('child-0001-a')).spawn.provider, 'claude');
  assert.equal(route.busy('plan:claude-max'), 1);
  assert.equal((await spawnOn('child-0002-b')).spawn.provider, 'claude');
  assert.equal(route.busy('plan:claude-max'), 2);
  const third = await route.tool('route', orchestrator, input('Explain the cache layer'));
  assert.notEqual(lastJson(third).spawn.model, 'opus');
  assert.ok(![lastJson(third), ...lastJson(third).alternatives].some(option => option.route.label === 'Max'), 'Max is at its limit of 2');
  route.sessionEvent({ type: 'exited', session: { id: 'child-0001-a', provider: 'claude', role: 'subagent', parentSessionId: orchestrator.id, status: 'exited', exitCode: 0 } });
  assert.equal(route.busy('plan:claude-max'), 1);
  assert.equal(lastJson(await route.tool('route', orchestrator, input('Explain the cache layer'))).spawn.model, 'opus');
  // A subagent of another orchestrator, or long after the answer, is not counted.
  route.sessionEvent({ type: 'created', session: { id: 'other-0001', provider: 'claude', role: 'subagent', parentSessionId: 'someone-else', status: 'starting' } });
  assert.equal(route.busy('plan:claude-max'), 1);
});

test('route_outcome: a usage-limit exit rests the route (its window\'s reset, or 5 min); failures feed outcomes; only the caller\'s own decisions', async () => {
  const { route, tick } = service();
  const answer = lastJson(await route.tool('route', orchestrator, input('Explain the cache layer')));
  route.sessionEvent({ type: 'created', session: { id: 'child-9', provider: 'claude', role: 'subagent', parentSessionId: orchestrator.id, status: 'starting' } });
  assert.equal((await route.tool('route_outcome', { ...orchestrator, id: 'another-orch' }, { decisionId: answer.decisionId, status: 'failed' })).isError, true);
  assert.equal((await route.tool('route_outcome', orchestrator, { decisionId: answer.decisionId, status: 'weird' })).isError, true);
  const recorded = await route.tool('route_outcome', orchestrator, { sessionId: 'child-9', status: 'failed', tokens: 123_456, exitLines: ['Claude usage limit reached. Your limit will reset at 5pm.'] });
  assert.equal(route.records.get(answer.decisionId).outcome.tokens, 123_456, 'tokens are kept for the plan cost');
  assert.match(recorded.content, /Recorded limit: Max rests for a while/u);
  const record = route.records.get(answer.decisionId);
  assert.deepEqual([record.outcome.result, record.outcome.ok, record.outcome.by], ['limit', false, 'orchestrator']);
  assert.ok(!JSON.stringify(route.records.all()).includes('usage limit reached'), 'exit lines are not kept');
  const next = lastJson(await route.tool('route', orchestrator, input('Explain the cache layer')));
  assert.notEqual(next.route.label, 'Max', 'resting until the 5 h window resets');
  assert.ok(route.state().cooldowns.some(c => c.signIn === 'plan:claude-max'));
  // The person's ✗/✓ wins over the orchestrator's report.
  route.feedback(answer.decisionId, true);
  await route.tool('route_outcome', orchestrator, { decisionId: answer.decisionId, status: 'failed' });
  assert.deepEqual([record.outcome.ok, record.outcome.by], [true, 'person']);
  tick(151 * 60_000);
  route.receiveLimits(limitsAnswer({ now: NOW + 151 * 60_000 }));
  assert.equal(lastJson(await route.tool('route', orchestrator, input('Explain the cache layer'))).route.label, 'Max', 'back after the reset');
});

test('page: state shows plans with alias resolution, quota and its age; saving validates and stores under "routing"; limits are window fields only', async () => {
  const host = fakeHost();
  const assistant = new Assistant({ host, dataDir: mkdtempSync(join(base, 'data-')), git: null, routing: declared(), now: () => NOW });
  const answer = limitsAnswer();
  answer.snapshot.providers[0].accountScope = 'scope-SECRET';
  assert.deepEqual(assistant.routing.receiveLimits(answer), { ok: true, providers: 4 });
  assert.deepEqual(assistant.routing.receiveLimits({ nope: true }), { ok: false, providers: 0 });
  const state = assistant.routing.state();
  assert.ok(!JSON.stringify(state).includes('SECRET'));
  const max = state.plans.find(plan => plan.id === 'claude-max');
  assert.deepEqual(max.models.map(m => [m.model, m.identity, m.from]), [['opus', 'claude-opus-4-8', 'bundled'], ['sonnet', 'claude-sonnet-5', 'bundled']]);
  assert.equal(max.quota.state, 'known');
  assert.equal(state.plans.find(plan => plan.id === 'glm-plan').launches, 0);
  assert.equal(state.aliases.asOf, '2026-10-15');
  const next = { ...declared(), preferSubscriptions: false };
  await assistant.routing.save(next, 'en');
  assert.equal(host.storage.routing.preferSubscriptions, false);
  assert.ok(host.events.some(event => event.event === 'settings'));
  await assert.rejects(assistant.routing.save({ ...next, newModels: 'yolo' }, 'en'), /new-model policy/u);
  const huge = { ...structuredClone(DEFAULT_ROUTE_SETTINGS), aliases: Array.from({ length: 64 }, (_, i) => ({ cli: 'claude', alias: `alias-${i}-${'x'.repeat(150)}`, identity: `model-${i}-${'y'.repeat(100)}` })) };
  assert.throws(() => validateRouteSettings(huge), /too large/u, `kept under ${MAX_SETTINGS_CHARS} characters of the 64 KB storage`);
  // Unreadable stored settings: nothing is saved over them.
  const unread = new Assistant({ host: fakeHost(), dataDir: mkdtempSync(join(base, 'data-')), git: null, routingUnavailable: true });
  await assert.rejects(unread.routing.save(next, 'ru'), /не прочитаны/u);
  unread.storageRecovered({ routing: next });
  assert.equal(unread.routing.settings.preferSubscriptions, false);
});

test('through the Assistant: the tools are routed to the route service; off in settings says so; Jev\'s budget and the caller\'s class are used', async () => {
  const host = fakeHost();
  const assistant = new Assistant({ host, dataDir: mkdtempSync(join(base, 'data-')), git: null, settings: { enabled: true, modes: { 'task.route': 'suggest', 'command.review': 'off' } } });
  const seen = [];
  assistant.engine.ask = async (request, context) => { seen.push({ requester: context.requester, session: context.sessionId, dataClass: request.dataClass ?? request.context?.dataClass ?? null }); return { branch: 'off', mode: 'off', fallbackReason: 'off', backend: null }; };
  const answer = await assistant.tool('route', orchestrator, { task: 'Fix the typo in README', providers: providers({ installed: ['claude'] }) });
  assert.match(answer.content, /Suggested: claude · its default model on its own sign-in/u);
  assert.equal(seen[0].requester, 'orchestrator', 'the orchestrator wrote the task');
  assert.equal(seen[0].session, orchestrator.id, 'counted against the caller\'s own per-card Jev budget');
  assert.equal((await assistant.tool('route_outcome', orchestrator, { decisionId: 'nope', status: 'done' })).isError, true);
  assert.equal((await assistant.tool('route', undefined, { task: 'x' })).isError, true);
  assistant.harness.settings.routing = false;
  assert.match((await assistant.tool('pick_route', orchestrator, { task: 'x' })).content, /routing is off/u);
});

test('pick_route is compact: short lines and spawn values; later calls send only the task or a digest', async () => {
  const { route } = service();
  const full = await route.tool('route', orchestrator, input('Explain the cache layer'));
  const first = await route.tool('pick_route', orchestrator, input('Explain the cache layer'));
  assert.ok(first.content.length < full.content.length / 2, `${first.content.length} vs ${full.content.length} characters`);
  assert.doesNotMatch(first.content, /Suggested:|read 3 min ago|Task read as/u, 'no why-lines');
  const json = lastJson(first);
  assert.deepEqual(Object.keys(json), ['decisionId', 'spawn', 'kind', 'alternatives']);
  assert.equal(json.alternatives.length, 2);
  assert.match(first.content, /Next time send only task: your lists are kept for 30 min \(or send digest "codex:ok claude:ok qwen:ok kimi:ok opencode:ok hermes:ok grok:ok @zai-glm @or-opus"\)/u);
  // Only the task: the lists this orchestrator passed are kept.
  const againAnswer = await route.tool('pick_route', orchestrator, { task: 'Explain the cache layer' });
  assert.doesNotMatch(againAnswer.content, /Next time/u, 'said once, when the lists were sent');
  const again = lastJson(againAnswer);
  assert.deepEqual(again.spawn, json.spawn);
  // Another orchestrator has no kept lists: the declared plans only — no account rows of someone else's.
  const other = lastJson(await route.tool('pick_route', { ...orchestrator, id: 'other-orch-0001' }, { task: 'Explain the cache layer' }));
  assert.ok([other, ...other.alternatives].every(option => option.kind === 'subscription' || option.kind === 'auto'));
  // A digest: the kept entries with the new sign-in; @ names a ready account from the rows seen.
  const out = lastJson(await route.tool('pick_route', orchestrator, { task: 'Explain the cache layer', digest: 'claude:signed_out codex:ok' }));
  assert.ok([out, ...out.alternatives].every(option => !(option.spawn.provider === 'claude' && option.kind === 'subscription')), 'Claude signed out: no Claude subscription (its model accounts do not use that sign-in)');
  assert.ok([out, ...out.alternatives].every(option => ['claude', 'codex'].includes(option.spawn.provider)), 'only the CLIs in the digest');
  const fresh = { ...orchestrator, id: 'digest-orch-01' };
  await route.tool('pick_route', fresh, { task: 'x', accountRoutes: accountRows() });
  const viaDigest = lastJson(await route.tool('pick_route', fresh, { task: 'Explain the cache layer', digest: 'claude:ok @or-opus', prefer: 'or-opus' }));
  assert.equal(viaDigest.spawn.launchOptions['canvastty-accounts'].account, 'or-opus');
  assert.equal(lastJson(await route.tool('route', orchestrator, { task: 'x', compact: true })).decisionId.length, 8);
});

test('coding-plan accounts without a price are flat-rate: free within the plan, flagged, and compared with priced routes', async () => {
  const { decide, whyLine } = await import('../src/route/engine.ts');
  const { parseLimits } = await import('../src/route/limits.ts');
  const { accountRowsFrom, providersFrom } = await import('../src/route/service.ts');
  const { view } = await import('./helpers/route-fixtures.mjs');
  // Run 8's shape: two Z.AI coding-plan accounts on OpenCode, no plan declared, Auto with an API price.
  const rows = accountRowsFrom([
    { provider: 'opencode', accountId: 'glm-53', account: 'GLM 5.3 · Z.AI Coding Plan', model: 'glm-5.3', endpoint: 'api.z.ai', state: 'ready', launchOptions: { 'canvastty-accounts': { account: 'glm-53', effort: 'default', trustFolder: false } } },
    { provider: 'opencode', accountId: 'glm-flash', account: 'GLM flash', model: 'glm-5.3-flash', endpoint: 'api.z.ai', state: 'ready', launchOptions: { 'canvastty-accounts': { account: 'glm-flash', effort: 'default', trustFolder: false } } },
    { provider: 'opencode', accountId: 'paygo', account: 'Pay as you go', model: 'glm-5.3', endpoint: 'api.example.com', state: 'ready', launchOptions: { 'canvastty-accounts': { account: 'paygo', effort: 'default', trustFolder: false } } }
  ]);
  const p = providersFrom(providers({ installed: ['opencode'] }));
  const ctx = settings => ({ view: view('coding', 'medium'), preference: 'cheap', settings, providers: p.list, providersGiven: true, accountRows: rows, callerProvider: 'opencode', cardClass: 'D1', mode: 'warn',
    limits: parseLimits(limitsAnswer(), NOW), catalog: catalog(), index: index(), auto: { model: 'z-ai/glm-5.3', identity: 'glm-5-3', effort: 'max', priceIn: 0.6, priceOut: 2.2, trusted: true },
    now: NOW, busy: () => 0, launches: () => 0, cooldown: () => null, stats: new Map(), prefer: null, orchestrate: false, explore: { roll: 0.9, retired: new Set(), highRisk: false } });
  // The person trusts the address with D2 (an account has no trust of its own; trust ranks before cost in a tunnel).
  const decision = decide(ctx({ ...structuredClone(DEFAULT_ROUTE_SETTINGS), trust: { 'host:api.z.ai': 'D2' } }));
  const all = decision.groups.flat();
  const plan = all.find(c => c.accountId === 'glm-53');
  assert.deepEqual([plan.cost, plan.costBasis, plan.estimate.kind], [0, 'flat', 'flat']);
  assert.match(whyLine(plan, decision, NOW), /flat-rate plan, unpriced: no cost per task/u);
  assert.equal(all.find(c => c.accountId === 'glm-flash').costBasis, 'unpriced', 'its name does not say it is a plan');
  assert.ok(!all.some(c => c.accountId === 'paygo' && c.costBasis === 'flat'), 'a pay-as-you-go account is never taken for a plan');
  assert.equal(decision.top.accountId, 'glm-53', 'the flat plan beats the same model through Auto\'s API price');
  // The person marks the flash account's address flat: both plans cost nothing, so within the window score decides,
  // and an unpriced pay-as-you-go account no longer outranks a priced route.
  const marked = decide(ctx({ ...structuredClone(DEFAULT_ROUTE_SETTINGS), trust: { 'host:api.z.ai': 'D2' }, flat: ['account:glm-flash'] }));
  assert.equal(marked.groups.flat().find(c => c.accountId === 'glm-flash').costBasis, 'flat');
  assert.throws(() => validateRouteSettings({ ...structuredClone(DEFAULT_ROUTE_SETTINGS), flat: ['nope'] }), /flat-rate/u);
  assert.deepEqual(validateRouteSettings({ ...declared(), flat: undefined }).flat, [], 'saved before flat-rate accounts existed');
});

test('run 8: a routed child on an account route gets its orchestrator\'s task for command review (as the orchestrator\'s, not the person\'s)', async () => {
  const host = fakeHost();
  const assistant = new Assistant({ host, dataDir: mkdtempSync(join(base, 'data-')), git: null, now: () => NOW });
  const project = mkdtempSync(join(base, 'project-'));
  const orch = { id: 'orch-run8-0001', provider: 'opencode', role: 'orchestrator', title: 'Lead', status: 'working', cwd: project, workingDirectory: project };
  assistant.sessionEvent({ type: 'created', session: orch });
  const rows = [{ provider: 'opencode', accountId: 'glm-53', account: 'GLM 5.3 · Z.AI Coding Plan', model: 'glm-5.3', endpoint: 'api.z.ai', state: 'ready', launchOptions: { 'canvastty-accounts': { account: 'glm-53', effort: 'default', trustFolder: false } } }];
  const task = 'Create code/textstats.mjs with countWords, topWords and readingMinutes, and code/textstats.test.mjs with node:test tests. Write only these two files.';
  const answer = lastJson(await assistant.tool('pick_route', orch, { task, cwd: `${project}/`, providers: providers({ installed: ['opencode'] }), accountRoutes: rows }));
  assert.equal(answer.spawn.launchOptions['canvastty-accounts'].account, 'glm-53');
  assert.equal(assistant.review.requestFor('child-in-other-dir'), null);
  // A subagent of another folder is not this decision's child.
  assistant.sessionEvent({ type: 'created', session: { id: 'child-elsewhere', provider: 'opencode', role: 'subagent', parentSessionId: orch.id, status: 'starting', cwd: base, workingDirectory: base } });
  assert.equal(assistant.review.requestFor('child-elsewhere'), null);
  assistant.sessionEvent({ type: 'created', session: { id: 'child-run8-c', provider: 'opencode', role: 'subagent', parentSessionId: orch.id, status: 'starting', cwd: project, workingDirectory: project } });
  assert.deepEqual(assistant.review.requestFor('child-run8-c'), { text: task, byPerson: false }, 'the orchestrator\'s text: R3 still never auto-allows edits for it');
  // The launch that follows (no launcher task on an account route) keeps it.
  await assistant.launch({ sessionId: 'child-run8-c', provider: 'opencode', profile: 'normal', role: 'subagent', cwd: project, restoring: false, resume: false, parentSessionId: orch.id, options: { model: 'off' } });
  assert.equal(assistant.review.requestFor('child-run8-c').text, task);
  // When the person typed it to the orchestrator word for word, it counts as theirs (the existing rule).
  assistant.review.noteLaunch(orch.id, { task: `Please: ${task}`, dataClass: null, triage: false, role: 'orchestrator' });
  assert.equal(assistant.review.requestFor('child-run8-c').byPerson, true);
  await assistant.routing.flush();
  assert.ok(!readFileSync(join(assistant.routing['dir'], 'decisions.json'), 'utf8').includes('textstats'), 'the task stays in memory only');
});
