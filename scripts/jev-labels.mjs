// Scores Jev's per-turn classification against the labelled set (tests/fixtures/auto/jev-labelled-tasks.json).
// Offline: it reads answers recorded by a live run (a JSON file `{ "<task id>": { "level": "...", "type": "..." } }`)
// and prints level and type accuracy, under- and over-routing and the confusion table. It calls no model.
//   node scripts/jev-labels.mjs <answers.json>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ORDER = ['small', 'medium', 'large'];

/** Accuracy of level and type; under-routing (a harder task given a smaller level) is counted apart from over-routing. */
export function scoreLabelled(fixture, answers) {
  const rows = fixture.tasks.map(task => ({ task, answer: answers[task.id] ?? null }));
  const answered = rows.filter(row => row.answer);
  const confusion = Object.fromEntries(ORDER.map(level => [level, Object.fromEntries([...ORDER, 'none'].map(other => [other, 0]))]));
  let level = 0, type = 0, under = 0, over = 0;
  for (const { task, answer } of rows) {
    const got = answer && ORDER.includes(answer.level) ? answer.level : 'none';
    confusion[task.level][got]++;
    if (!answer) continue;
    if (answer.level === task.level) level++;
    else if (ORDER.indexOf(answer.level) < ORDER.indexOf(task.level)) under++;
    else over++;
    if (answer.type === task.type) type++;
  }
  const share = value => answered.length ? Math.round(value / answered.length * 1000) / 1000 : null;
  return { tasks: rows.length, answered: answered.length, levelAccuracy: share(level), typeAccuracy: share(type), underRouted: under, overRouted: over, confusion };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = JSON.parse(readFileSync(new URL('../tests/fixtures/auto/jev-labelled-tasks.json', import.meta.url), 'utf8'));
  if (!process.argv[2]) { console.error('usage: node scripts/jev-labels.mjs <answers.json>'); process.exit(2); }
  console.log(JSON.stringify(scoreLabelled(fixture, JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2));
}
