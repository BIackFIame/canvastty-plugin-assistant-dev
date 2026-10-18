// The labelled set for Jev's per-turn classification (difficulty level and task type, RU/EN), kept for a later live
// run, and the offline scorer. Here only the word rules (the fallback) are scored on it: no model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rulesDifficulty } from '../src/auto/classify.ts';
import { turnView } from '../src/auto/select.ts';
import { scoreLabelled } from '../scripts/jev-labels.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/auto/jev-labelled-tasks.json', import.meta.url), 'utf8'));

test('the labelled set: at least 30 tasks, Russian and English, every level and type, unique ids, no private data', () => {
  assert.ok(fixture.tasks.length >= 30);
  assert.equal(new Set(fixture.tasks.map(task => task.id)).size, fixture.tasks.length);
  for (const task of fixture.tasks) {
    assert.ok(fixture.levels.includes(task.level), task.id);
    assert.ok(fixture.types.includes(task.type), task.id);
    assert.ok(['en', 'ru'].includes(task.lang), task.id);
    assert.equal(task.lang === 'ru', /[а-яё]/iu.test(task.text), `${task.id}: language matches the text`);
    assert.doesNotMatch(task.text, /\/Users\/|@[a-z0-9-]+\.[a-z]{2,}|sk-[A-Za-z0-9]/u, task.id);
  }
  for (const lang of ['en', 'ru']) assert.ok(fixture.tasks.filter(task => task.lang === lang).length >= 10, lang);
  for (const level of fixture.levels) assert.ok(fixture.tasks.filter(task => task.level === level).length >= 10, level);
  for (const type of fixture.types) assert.ok(fixture.tasks.some(task => task.type === type), type);
});

test('the scorer separates under-routing from over-routing; the word-rule baseline (no model) for comparison', () => {
  const perfect = Object.fromEntries(fixture.tasks.map(task => [task.id, { level: task.level, type: task.type }]));
  assert.deepEqual([scoreLabelled(fixture, perfect).levelAccuracy, scoreLabelled(fixture, perfect).typeAccuracy], [1, 1]);
  const allSmall = Object.fromEntries(fixture.tasks.map(task => [task.id, { level: 'small', type: 'chat' }]));
  const lowered = scoreLabelled(fixture, allSmall);
  assert.equal(lowered.overRouted, 0);
  assert.equal(lowered.underRouted, fixture.tasks.filter(task => task.level !== 'small').length);
  assert.equal(scoreLabelled(fixture, {}).answered, 0);
  // The fallback's own numbers on this set (word rules; see the harness notes for the live Jev run).
  const rules = Object.fromEntries(fixture.tasks.map(task => {
    const view = turnView({ difficulty: rulesDifficulty(task.text, 0), strong: false }, 'rules', task.text);
    return [task.id, { level: view.level, type: view.type }];
  }));
  const baseline = scoreLabelled(fixture, rules);
  assert.equal(baseline.answered, fixture.tasks.length);
  assert.ok(baseline.levelAccuracy > 0.3 && baseline.typeAccuracy > 0.4, JSON.stringify(baseline));
  console.log(`word-rule baseline on ${baseline.tasks} labelled tasks: level ${baseline.levelAccuracy}, type ${baseline.typeAccuracy}, under-routed ${baseline.underRouted}, over-routed ${baseline.overRouted}`);
});
