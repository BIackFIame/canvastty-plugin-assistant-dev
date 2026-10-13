// The harness on the host APIs CanvasTTY has today: routing as a tool, loop alerts from the plugin's own decision
// calls and session events, flows previewed before they start, task boards fed by tools, card actions and the
// four-control settings. No model, no network, no command is run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness } from '../src/harness/harness.ts';
import { BadgeBoard } from '../src/harness/badges.ts';
import { LoopWatch } from '../src/harness/loops.ts';
import { FlowFileError, parseFlowYaml, validateFlow } from '../src/harness/flowFile.ts';
import { builtInFlows, projectFlows } from '../src/harness/flows.ts';
import { ruleDifficulty, suggestRoute, modelRank } from '../src/harness/router.ts';
import { commandReviewLevel, normalizeHarnessSettings, validateHarnessSettings, withCommandReview } from '../src/harness/settings.ts';
import { TURN_GAP_MS } from '../src/harness/harness.ts';
import { DEFAULT_ASSISTANT_SETTINGS } from '../src/shared/settings.ts';
import { Assistant } from '../src/service/assistant.ts';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'canvastty-harness-')));
process.on('exit', () => rmSync(base, { recursive: true, force: true }));
const project = join(base, 'project');
mkdirSync(join(project, '.canvastty', 'flows'), { recursive: true });

function fakeHost() {
  const calls = [], events = [], storage = {};
  return {
    calls, events, storage,
    badges: sessionId => calls.filter(call => call.method === 'cards.setBadge' && call.params.sessionId === sessionId).map(call => call.params.badge),
    callHost: async (method, params) => {
      calls.push({ method, params });
      if (method === 'storage.set') { storage[params.key] = params.value; return null; }
      if (method === 'storage.get') return storage[params.key] ?? null;
      return null;
    },
    log() {},
    emit(event, data) { events.push({ event, data }); }
  };
}

function harness(options = {}) {
  const host = options.host ?? fakeHost();
  let now = options.now ?? 1_000_000;
  const instance = new Harness({
    host, dataDir: options.dataDir ?? mkdtempSync(join(base, 'data-')), locale: options.locale ?? 'en', now: () => now,
    publishBadge: (sessionId, badge) => host.callHost('cards.setBadge', { sessionId, badge }).then(() => undefined),
    ...(options.modelDifficulty ? { modelDifficulty: options.modelDifficulty } : {})
  });
  return { host, harness: instance, tick: ms => { now += ms; } };
}

const orchestrator = { id: 'orch-0001', provider: 'claude', role: 'orchestrator', title: 'Refactor', status: 'idle', cwd: project, workingDirectory: project, startedAt: 1_000_000 };
const sub = (id, extra = {}) => ({ id, provider: 'codex', role: 'subagent', parentSessionId: orchestrator.id, title: `sub ${id}`, status: 'working', cwd: project, workingDirectory: project, ...extra });
const providers = [
  { id: 'claude', available: true, signIn: 'ok', subagent: true, model: { supported: true, known: ['claude-haiku-4', 'claude-sonnet-4', 'claude-opus-4'] }, efforts: ['low', 'medium', 'high'] },
  { id: 'codex', available: true, signIn: 'signed_out', subagent: true, model: { supported: true, known: ['gpt-5-mini', 'gpt-5'] } },
  { id: 'kimi', available: false, subagent: true }
];
const flush = () => new Promise(resolve => setImmediate(resolve));
const problemCode = code => error => error instanceof FlowFileError && error.problem.code === code;

test('settings: four controls; command review maps onto the Assistant modes; defaults are Off', () => {
  assert.equal(commandReviewLevel(DEFAULT_ASSISTANT_SETTINGS), 'off', 'nothing saved: off');
  const basic = withCommandReview(DEFAULT_ASSISTANT_SETTINGS, 'basic');
  assert.deepEqual([basic.enabled, basic.modes['command.review'], basic.reviewStrictness, commandReviewLevel(basic)], [true, 'suggest', 'triage', 'basic']);
  const strict = withCommandReview(basic, 'strict');
  assert.deepEqual([strict.modes['command.review'], strict.reviewStrictness, commandReviewLevel(strict)], ['auto', 'strict', 'strict']);
  const off = withCommandReview(strict, 'off');
  assert.deepEqual([off.modes['command.review'], off.enabled, commandReviewLevel(off)], ['off', true, 'off'], 'task triage keeps the Assistant on');
  assert.equal(withCommandReview({ ...off, modes: { ...off.modes, 'task.route': 'off' } }, 'off').enabled, false);
  assert.deepEqual(normalizeHarnessSettings({ routing: false, junk: 1 }), { routing: false, loopAlerts: true, flows: true });
  assert.throws(() => validateHarnessSettings({ routing: true, loopAlerts: true }), /Invalid/u);
  assert.throws(() => validateHarnessSettings({ routing: true, loopAlerts: true, flows: true, extra: false }), /Invalid/u);
});

test('routing: word rules or the decision model set the difficulty; the model list comes from list_providers', () => {
  assert.equal(ruleDifficulty('Fix a typo in the README'), 'simple');
  assert.equal(ruleDifficulty('Design the migration of the storage schema'), 'hard');
  assert.equal(ruleDifficulty('Add a button that exports the table'), 'normal');
  assert.equal(ruleDifficulty('Найди причину гонки в планировщике'), 'hard');
  assert.ok(modelRank('claude-haiku-4') < modelRank('claude-sonnet-4') && modelRank('claude-sonnet-4') < modelRank('claude-opus-4'));
  const hard = suggestRoute({ difficulty: 'hard', source: 'rules', callerProvider: 'codex', providers });
  // codex is signed out, kimi unavailable: claude, its strongest model, high effort.
  assert.deepEqual([hard.provider, hard.model, hard.effort], ['claude', 'claude-opus-4', 'high']);
  const simple = suggestRoute({ difficulty: 'simple', source: 'model', callerProvider: 'claude', providers, launchOptionTools: ['canvastty-accounts__pick_account'] });
  assert.deepEqual([simple.provider, simple.model, simple.effort, simple.accountTool], ['claude', 'claude-haiku-4', 'low', 'canvastty-accounts__pick_account']);
  const normal = suggestRoute({ difficulty: 'normal', source: 'rules', callerProvider: 'claude', providers });
  assert.equal(normal.model, undefined, 'ordinary work keeps the provider default');
  assert.equal(suggestRoute({ difficulty: 'hard', source: 'rules', callerProvider: 'claude', providers: [] }).provider, 'claude', 'no list: the caller\'s own provider');
  assert.equal(suggestRoute({ difficulty: 'hard', source: 'rules', callerProvider: 'claude', providers: [{ id: 'codex', available: false }] }), null);
});

test('loop alerts: the same command N times with no file write in between, once per turn; a write or a new turn resets', () => {
  const loops = new LoopWatch();
  const shell = command => ({ name: 'Bash', kind: 'shell', command, paths: [] });
  for (let i = 0; i < 4; i++) assert.equal(loops.action('s1', shell('npm test')), null);
  assert.equal(loops.action('s1', { name: 'Edit', kind: 'edit', command: null, paths: ['a.ts'] }), null);
  for (let i = 0; i < 4; i++) assert.equal(loops.action('s1', shell('npm   test')), null, 'whitespace does not make a new command');
  // Interleaving another command does not hide the loop.
  assert.equal(loops.action('s1', shell('make lint')), null);
  const signal = loops.action('s1', shell('npm test'));
  assert.deepEqual(signal, { sessionId: 's1', count: 5, toolName: 'Bash', what: 'command' });
  assert.equal(loops.action('s1', shell('npm test')), null, 'once per streak');
  assert.equal(loops.turnStarted('s1'), true);
  assert.equal(loops.flagged('s1'), false);
});

test('badges: one plugin badge per card, the most important signal shown, the next one back when it clears', async () => {
  const shown = [];
  const board = new BadgeBoard(async (sessionId, badge) => { shown.push(badge?.text ?? null); });
  await board.set('c', 'tasks', { text: 'tasks 1/3', tone: 'info' });
  await board.set('c', 'loop', { text: 'loop?', tone: 'warn' });
  await board.set('c', 'tasks', { text: 'tasks 2/3', tone: 'info' });
  await board.set('c', 'loop', null);
  await board.set('c', 'tasks', null);
  assert.deepEqual(shown, ['tasks 1/3', 'loop?', 'tasks 2/3', null]);
});

test('project flows: JSON and a YAML subset, shown as written; bad files are named, not loaded', async () => {
  const yaml = [
    '# a project flow',
    'name: "Docs pass"',
    'description: Writer drafts, editor checks',
    'roles:',
    '- id: writer',
    '  title: Writer',
    '  provider: claude',
    '  task: |',
    '    Write docs for {goal}.',
    '    Keep it short.',
    '- id: editor',
    '  difficulty: hard',
    "  task: 'Check the docs for {goal}'"
  ].join('\n');
  const parsed = parseFlowYaml(yaml);
  const flow = validateFlow(parsed, 'docs');
  assert.equal(flow.id, 'docs');
  assert.equal(flow.roles[0].task, 'Write docs for {goal}.\nKeep it short.');
  assert.deepEqual(flow.roles.map(role => [role.id, role.difficulty, role.provider ?? null]), [['writer', 'normal', 'claude'], ['editor', 'hard', null]]);
  assert.throws(() => parseFlowYaml('name: x\nroles: [a, b]'), problemCode('yamlUnsupported'));
  assert.throws(() => validateFlow({ name: 'x', roles: [{ id: 'a', task: 't', provider: 'rm -rf' }] }, 'x'), problemCode('field'));
  assert.throws(() => validateFlow({ name: 'x', roles: [], extra: 1 }, 'x'), problemCode('unknownKey'));

  const dir = join(project, '.canvastty', 'flows');
  writeFileSync(join(dir, 'docs.yaml'), yaml);
  writeFileSync(join(dir, 'pair.json'), JSON.stringify({ name: 'Pair', roles: [{ id: 'a', task: 'Do {goal}' }] }));
  writeFileSync(join(dir, 'broken.yml'), 'name: x\nroles:\n  - id: Bad Id\n    task: t\n');
  // A link to a file elsewhere is not followed.
  writeFileSync(join(base, 'outside.json'), JSON.stringify({ name: 'Outside', roles: [{ id: 'a', task: 't' }] }));
  symlinkSync(join(base, 'outside.json'), join(dir, 'outside.json'));
  const { flows, problems } = await projectFlows(project);
  assert.deepEqual(flows.map(item => [item.id, item.source]), [['docs', 'project'], ['pair', 'project']]);
  assert.deepEqual(problems.map(problem => [problem.file, problem.problem.code]), [['broken.yml', 'field'], ['outside.json', 'link']]);
  rmSync(join(dir, 'outside.json'));
  assert.equal((await projectFlows(join(base, 'nowhere'))).flows.length, 0);
  // Built-in flows are localized.
  assert.equal(builtInFlows('ru')[0].name, 'Исполнитель и проверяющий');
  assert.equal(builtInFlows('en')[0].name, 'Executor and reviewer');
});

test('route tool: a suggestion to pass to spawn_agent; off in settings says so; a decision model\'s difficulty wins', async () => {
  const { harness: h } = harness({ modelDifficulty: async () => 'simple' });
  const answer = await h.tool('route', orchestrator, { task: 'Design a new protocol', providers: { providers } });
  assert.match(answer.content, /Pass these to spawn_agent: \{"provider":"claude","model":"claude-haiku-4","effort":"low"\}/u);
  assert.match(answer.content, /decision model/u);
  const rules = harness();
  assert.match((await rules.harness.tool('route', orchestrator, { task: 'Design a new protocol', providers })).content, /claude-opus-4/u);
  assert.equal((await rules.harness.tool('route', orchestrator, {})).isError, true);
  rules.harness.settings.routing = false;
  assert.match((await rules.harness.tool('route', orchestrator, { task: 'x' })).content, /routing is off/u);
});

test('flows: plan → preview (badge, pending) → Start → flow_status hands spawn values; the roles land on the board', async () => {
  const { harness: h, host } = harness();
  h.sessionEvent({ type: 'created', session: orchestrator });
  const list = (await h.tool('flows_list', orchestrator, {})).content;
  assert.match(list, /executor-reviewer \(built in\)/u);
  assert.match(list, /docs \(from this project\): name "Docs pass"/u);
  assert.match(list, /not loaded: "\.canvastty\/flows\/broken\.yml"/u);
  const planned = await h.tool('flow_plan', orchestrator, { flow: 'executor-reviewer', goal: 'add CSV export', providers });
  const planned$ = JSON.parse(planned.content.split('\n').at(-1));
  const planId = planned$.planId;
  assert.match(planned.content, /waits for the person/u);
  // Before Start the orchestrator gets the role names only: nothing to pass to spawn_agent yet.
  assert.deepEqual(planned$.roles, [{ id: 'executor', title: 'Executor' }, { id: 'reviewer', title: 'Reviewer' }]);
  assert.doesNotMatch(planned.content, /claude-opus-4|"provider"|Implement: add CSV export/u);
  await flush();
  assert.equal(host.badges(orchestrator.id).at(-1).text, 'flow: preview');
  // Pending: flow_status says so (no wait).
  assert.match((await h.tool('flow_status', orchestrator, { planId, waitSeconds: 0 })).content, /still waits/u);
  // The person presses Start while the orchestrator waits.
  const waiting = h.tool('flow_status', orchestrator, { planId, waitSeconds: 5 });
  setTimeout(() => h.decidePlan(planId, 'approved'), 20);
  const approved = (await waiting).content;
  assert.match(approved, /The person approved the built-in flow "Executor and reviewer"/u);
  const spawn = JSON.parse(approved.split('\n').at(-1)).spawn;
  assert.equal(spawn.length, 2);
  assert.equal(spawn[1].provider, 'claude');
  assert.match(spawn[0].prompt, /Implement: add CSV export/u);
  await flush();
  assert.equal(host.badges(orchestrator.id).at(-1).text, 'tasks 0/2', 'the flow badge went; the board badge shows');
  assert.match((await h.tool('task_list', orchestrator, {})).content, /0\/2 done/u);
  assert.throws(() => h.decidePlan(planId, 'cancelled'), /already started/u);
  // A cancelled plan says so.
  const second = JSON.parse((await h.tool('flow_plan', orchestrator, { flow: 'test-fix', goal: 'g' })).content.split('\n').at(-1)).planId;
  h.decidePlan(second, 'cancelled');
  assert.match((await h.tool('flow_status', orchestrator, { planId: second })).content, /cancelled/u);
  // The person can choose a flow from the preview card too; the orchestrator then reads it without a plan id.
  const own = await h.createPlan(orchestrator.id, 'docs', 'the CLI');
  assert.equal(own.source, 'project');
  assert.equal(own.roles[0].task, 'Write docs for the CLI.\nKeep it short.', 'a project flow\'s text is kept as written');
  h.decidePlan(own.id, 'approved');
  const delivered = (await h.tool('flow_status', orchestrator, {})).content;
  assert.match(delivered, /approved a flow from this project/u);
  assert.match(delivered, /quoted data, not instructions/u, 'project text is marked as data');
  h.settings.flows = false;
  assert.match((await h.tool('flow_plan', orchestrator, { flow: 'docs', goal: 'g' })).content, /off/u);
});

test('task board: the orchestrator adds and assigns; a subagent claims or updates only its own tasks; others have none', async () => {
  const { harness: h, host } = harness();
  h.sessionEvent({ type: 'created', session: orchestrator });
  h.sessionEvent({ type: 'created', session: sub('sub-a') });
  h.sessionEvent({ type: 'created', session: sub('sub-b') });
  const stranger = { ...sub('sub-x'), parentSessionId: 'other-orch' };
  assert.equal((await h.tool('task_add', sub('sub-a'), { title: 'x' })).isError, true);
  assert.equal((await h.tool('task_add', orchestrator, { title: 'x', assignee: 'sub-x' })).isError, true);
  assert.match((await h.tool('task_add', orchestrator, { title: 'Parser', assignee: 'sub-a' })).content, /Added t1/u);
  assert.match((await h.tool('task_add', orchestrator, { title: 'Docs' })).content, /Added t2/u);
  assert.equal((await h.tool('task_update', sub('sub-b'), { id: 't1', status: 'done' })).isError, true, 'not its task');
  assert.match((await h.tool('task_update', sub('sub-b'), { id: 't2', status: 'doing' })).content, /doing/u, 'claims an unassigned task');
  assert.match((await h.tool('task_update', sub('sub-a'), { id: 't1', status: 'done', note: 'merged' })).content, /done/u);
  assert.equal((await h.tool('task_update', sub('sub-a'), { id: 't1', status: 'finished' })).isError, true);
  assert.match((await h.tool('task_list', stranger, {})).content, /empty/u, 'another orchestrator\'s board');
  assert.equal((await h.tool('task_list', { ...orchestrator, id: 'a1', role: 'agent' }, {})).isError, true);
  const board = h.boards.get(orchestrator.id);
  assert.deepEqual(board.tasks.map(task => [task.id, task.status, task.assignee]), [['t1', 'done', 'sub-a'], ['t2', 'doing', 'sub-b']]);
  await flush();
  assert.equal(host.badges(orchestrator.id).at(-1).text, 'tasks 1/2');
  assert.ok(host.events.some(event => event.event === 'board'));
  // The card action points the Task board card at this orchestrator.
  const toast = h.cardAction('task-board', orchestrator.id, orchestrator);
  assert.match(toast.message, /Task board now shows "Refactor" \(1\/2 done\)/u);
  assert.deepEqual(host.events.at(-1), { event: 'focus', data: { board: orchestrator.id, flows: null } });
  // Closing the orchestrator drops its board.
  h.sessionEvent({ type: 'closed', session: orchestrator });
  assert.equal(h.boards.get(orchestrator.id), null);
});

test('loop badge from decision calls; it clears when the next turn starts; off in settings means no badge', async () => {
  const { harness: h, host, tick } = harness({ locale: 'ru' });
  const card = { ...orchestrator, id: 'agent-1', role: 'agent', status: 'working' };
  h.sessionEvent({ type: 'created', session: card });
  const call = command => ({ sessionId: card.id, tool: { name: 'Bash', kind: 'shell', command, paths: [] } });
  for (let i = 0; i < 5; i++) h.observeDecision(call('pytest -x'), null);
  await flush();
  assert.deepEqual(host.badges(card.id).at(-1).text, 'цикл?');
  h.sessionEvent({ type: 'status', session: { ...card, status: 'idle' } });
  await flush();
  assert.equal(host.badges(card.id).at(-1).text, 'цикл?', 'the badge stays while the person looks');
  tick(TURN_GAP_MS);
  h.sessionEvent({ type: 'status', session: { ...card, status: 'working' } });
  await flush();
  assert.equal(host.badges(card.id).at(-1), null);
  h.settings.loopAlerts = false;
  const before = host.badges(card.id).length;
  for (let i = 0; i < 6; i++) h.observeDecision(call('pytest -x'), null);
  await flush();
  assert.equal(host.badges(card.id).length, before);
});

test('report card action: built from session events and decision calls; no cost (not exposed to plugins)', () => {
  const { harness: h, tick } = harness();
  h.sessionEvent({ type: 'created', session: { ...orchestrator, status: 'unavailable' } });
  h.sessionEvent({ type: 'status', session: { ...orchestrator, status: 'working' } });
  tick(3 * 60_000);
  h.sessionEvent({ type: 'status', session: { ...orchestrator, status: 'idle' } });
  h.sessionEvent({ type: 'created', session: sub('sub-a') });
  h.observeDecision({ sessionId: orchestrator.id, tool: { name: 'Bash', kind: 'shell', command: 'ls', paths: [] } }, null);
  h.observeDecision({ sessionId: orchestrator.id, tool: { name: 'Bash', kind: 'shell', command: 'sudo ls', paths: [] } }, 'deny');
  const report = h.cardAction('report', orchestrator.id, { ...orchestrator, status: 'idle' }).message;
  assert.match(report, /Report: Refactor \(claude, orchestrator\)/u);
  assert.match(report, /Ran: 3 min · Turns: 1/u);
  assert.match(report, /Commands seen: 2 \(declined 1, sent to you 0\)/u);
  assert.match(report, /Subagents: sub sub-a/u);
  assert.match(report, /not available to plugins/u);
  assert.ok(report.length < 2_000);
});

test('boards and plans survive a service restart (the plugin\'s data folder)', async () => {
  const dataDir = mkdtempSync(join(base, 'data-'));
  const first = harness({ dataDir }).harness;
  first.sessionEvent({ type: 'created', session: orchestrator });
  await first.tool('task_add', orchestrator, { title: 'Keep me' });
  await first.tool('flow_plan', orchestrator, { flow: 'test-fix', goal: 'g' });
  await first.flushWrites();
  const second = harness({ dataDir }).harness;
  assert.equal(second.boards.get(orchestrator.id).tasks[0].title, 'Keep me');
  assert.equal(second.plans.list().filter(plan => plan.status === 'pending').length, 1);
});

test('the Assistant wires it: decide feeds loops and the journal whatever review answers; tools route by name; settings save', async () => {
  const host = fakeHost();
  const assistant = new Assistant({ host, dataDir: mkdtempSync(join(base, 'data-')), git: null, locale: 'en' });
  const card = { ...orchestrator, id: 'card-9', role: 'agent' };
  assistant.sessionEvent({ type: 'created', session: card });
  const decide = command => ({ event: 'pre-tool', sessionId: card.id, provider: 'claude', role: 'agent', cwd: project, agentCwd: project, tool: { name: 'Bash', kind: 'shell', command, paths: [] }, input: { command }, truncated: false, budgetMs: 5_000 });
  for (let i = 0; i < 5; i++) await assistant.decide(decide('make check'));
  await flush();
  assert.equal(host.badges(card.id).at(-1).text, 'loop?');
  assert.match((await assistant.tool('task_list', orchestrator, {})).content, /empty/u);
  assert.deepEqual(assistant.harnessState(), { commandReview: 'off', custom: null, settingsUnavailable: false, routing: true, loopAlerts: true, flows: true, models: 0 });
  await assistant.saveHarness({ commandReview: 'strict', routing: false, loopAlerts: true, flows: true });
  assert.deepEqual(host.storage.harness, { routing: false, loopAlerts: true, flows: true });
  assert.equal(host.storage.settings.modes['command.review'], 'auto');
  await assert.rejects(assistant.saveHarness({ commandReview: 'paranoid', routing: true, loopAlerts: true, flows: true }), /Strict, Basic rules or Off/u);
});
