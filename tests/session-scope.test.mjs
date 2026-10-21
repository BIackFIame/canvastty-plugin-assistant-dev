// Cross-session scope of what the Assistant's tools answer: an orchestrator sees only its own tree (its card and every
// card below it), matched by full session id. Two cards whose ids share their first 8 characters never see each
// other's review decisions, route decisions, outcomes, delegated task text or task boards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Assistant } from '../src/service/assistant.ts';
import { NOW, providers } from './helpers/route-fixtures.mjs';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'canvastty-scope-')));
process.on('exit', () => rmSync(base, { recursive: true, force: true }));

function fakeHost() {
  const storage = {};
  return {
    callHost: async (method, params) => { if (method === 'storage.set') { storage[params.key] = params.value; return null; } if (method === 'storage.get') return storage[params.key] ?? null; return null; },
    log() {}, emit() {}
  };
}

// Same 8-character prefix on purpose.
const A = { id: 'deadbeef-0000-4000-8000-00000000000a', provider: 'claude', role: 'orchestrator', title: 'A', status: 'working', cwd: base, workingDirectory: base };
const B = { id: 'deadbeef-0000-4000-8000-00000000000b', provider: 'claude', role: 'orchestrator', title: 'B', status: 'working', cwd: base, workingDirectory: base };
const card = (id, parent, provider = 'claude') => ({ id, provider, role: 'subagent', parentSessionId: parent, title: id, status: 'working', cwd: base, workingDirectory: base });
const lastJson = answer => JSON.parse(answer.content.split('\n').at(-1));

function assistant() {
  const a = new Assistant({ host: fakeHost(), dataDir: mkdtempSync(join(base, 'data-')), git: null, now: () => NOW });
  for (const session of [A, B]) a.sessionEvent({ type: 'created', session });
  return a;
}

test('review_status: the caller\'s own card and every card below it, by full id; a card sharing the prefix sees none of it', async () => {
  const a = assistant();
  const childA = card('deadbeef-0000-4000-8000-0000000000c1', A.id);
  const grandA = card('deadbeef-0000-4000-8000-0000000000c2', childA.id, 'codex');
  const childB = card('deadbeef-0000-4000-8000-0000000000d1', B.id);
  for (const session of [childA, grandA, childB]) a.sessionEvent({ type: 'created', session });
  const remember = (id, summary) => a.review['remember'](id, summary, 'auto', { outcome: 'allow', act: 'allowed', tier: 'rule', reason: 'r', model: null, auditId: `audit-${summary}` });
  remember(A.id, 'on-A'); remember(grandA.id, 'on-grandchild-A'); remember(B.id, 'on-B'); remember(childB.id, 'on-child-B');
  const seenA = JSON.parse((await a.tool('review_status', A, {})).content).recent.map(entry => entry.summary).sort();
  assert.deepEqual(seenA, ['on-A', 'on-grandchild-A']);
  const seenB = JSON.parse((await a.tool('review_status', B, {})).content).recent.map(entry => entry.summary).sort();
  assert.deepEqual(seenB, ['on-B', 'on-child-B']);
  const seenChild = JSON.parse((await a.tool('review_status', childA, {})).content).recent.map(entry => entry.summary).sort();
  assert.deepEqual(seenChild, ['on-grandchild-A'], 'a subagent sees its own subtree, not its orchestrator\'s');
  // The page (the person's) still sees everything, with prefixes only.
  assert.equal(a.review.recent().length, 4);
  assert.ok(a.review.recent().every(entry => entry.session.length === 8));
});

test('routes: a decision belongs to the card that asked (full id): no match, outcome, task text or tree route for a card sharing its prefix', async () => {
  const a = assistant();
  const delegated = [];
  a.review.noteTurn = (childId, text) => { delegated.push({ childId, text }); };
  const answer = await a.tool('pick_route', A, { task: 'A-SECRET-TASK write the parser', providers: providers(), cwd: base });
  const { decisionId, spawn } = lastJson(answer);
  // B's child on the same CLI, right after: not A's decision's child.
  const childB = card('deadbeef-0000-4000-8000-0000000000d1', B.id, spawn.provider);
  a.sessionEvent({ type: 'created', session: childB });
  assert.equal(delegated.some(entry => entry.text.includes('A-SECRET-TASK')), false, 'A\'s task never reaches B\'s child');
  assert.equal(a.routing.routeOf(childB.id), null);
  // B cannot report A's decision, by id or by session.
  assert.equal((await a.tool('route_outcome', B, { decisionId, status: 'done' })).isError, true);
  // A's own child matches, and only A reports it.
  const childA = card('deadbeef-0000-4000-8000-0000000000c1', A.id, spawn.provider);
  a.sessionEvent({ type: 'created', session: childA });
  assert.ok(delegated.some(entry => entry.childId === childA.id && entry.text.includes('A-SECRET-TASK')));
  assert.ok(a.routing.routeOf(childA.id));
  assert.equal(a.routing.routeOf(childB.id), null);
  assert.equal((await a.tool('route_outcome', B, { sessionId: childA.id, status: 'done' })).isError, true);
  assert.notEqual((await a.tool('route_outcome', A, { sessionId: childA.id, status: 'done' })).isError, true);
});

test('task boards: each orchestrator\'s board and its subagents only, by full id', async () => {
  const a = assistant();
  await a.tool('task_add', A, { title: 'A-ONLY task' });
  const childB = card('deadbeef-0000-4000-8000-0000000000d1', B.id);
  a.sessionEvent({ type: 'created', session: childB });
  assert.doesNotMatch(String((await a.tool('task_list', B, {})).content), /A-ONLY/u);
  assert.doesNotMatch(String((await a.tool('task_list', childB, {})).content), /A-ONLY/u);
  assert.equal((await a.tool('task_add', A, { title: 'x', assignee: childB.id })).isError, true, 'B\'s subagent cannot be given A\'s task');
  assert.match(String((await a.tool('task_list', card('deadbeef-0000-4000-8000-0000000000c1', A.id), {})).content), /A-ONLY/u);
});
