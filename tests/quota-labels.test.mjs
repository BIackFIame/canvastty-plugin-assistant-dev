// Limit windows on the decision models page and in route answers: CanvasTTY's windows carry the used share (a Codex
// app-server answer with usedPercent 9 is 9 % spent), so every line says both what is used and what is left.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { usedLeft } from '../src/ui/quotaText.ts';
import { quotaOf } from '../src/route/limits.ts';
import { estimateText } from '../src/route/engine.ts';

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const MIN = 60_000;
// Codex app-server `account/rateLimits/read` → CanvasTTY's window (the core's normalizer keeps usedPercent as is).
const codexAnswer = { rateLimits: { limitId: 'codex', primary: { usedPercent: 9, windowDurationMins: 300, resetsAt: Math.floor((NOW + 120 * MIN) / 1_000) }, secondary: null } };
const codexLimits = {
  provider: 'codex', state: 'available', fetchedAt: NOW - MIN, reason: null,
  windows: [{ id: 'codex:primary', label: '5h', usedPercent: codexAnswer.rateLimits.primary.usedPercent, windowMinutes: 300, resetsAt: codexAnswer.rateLimits.primary.resetsAt * 1_000 }]
};

test('usedLeft says both, in both languages', () => {
  assert.equal(usedLeft('en', 9), '9% used · 91% left');
  assert.equal(usedLeft('ru', 9), 'использовано 9% · осталось 91%');
  assert.equal(usedLeft('en', 140), '100% used · 0% left');
});

test('the routing page: a Codex window with usedPercent 9 reads "9 % used · 91 % left", never "9 % left"', async () => {
  globalThis.window ??= { CanvasTTYPlugin: {} }; // the strings module sits next to the page helpers
  const { ROUTE_PAGE_STRINGS } = await import('../src/ui/routing.ts');
  const quota = quotaOf(codexLimits, 10, NOW);
  assert.equal(quota.window.usedPercent, 9);
  const ago = () => '1 min ago';
  const en = ROUTE_PAGE_STRINGS.en.quota(quota, ago);
  const ru = ROUTE_PAGE_STRINGS.ru.quota(quota, ago);
  assert.match(en, /5h 9% used · 91% left · headroom above the reserve 81%/u, en);
  assert.match(ru, /5h: использовано 9% · осталось 91% · запас выше резерва 81%/u, ru);
  assert.doesNotMatch(en, /\b9% left/u);
  assert.doesNotMatch(ru, /осталось 9%/u);
  const full = quotaOf({ ...codexLimits, windows: [{ ...codexLimits.windows[0], usedPercent: 100 }] }, 10, NOW);
  assert.match(ROUTE_PAGE_STRINGS.en.quota(full, ago), /\(5h 100% used · 0% left\)/u);
  assert.match(ROUTE_PAGE_STRINGS.ru.quota(full, ago), /\(5h: использовано 100% · осталось 0%\)/u);
  // Pools and account rows come with the percent left (Accounts' remainingPercent).
  assert.equal(ROUTE_PAGE_STRINGS.en.poolLeft(91), ' · 9% used · 91% left');
  assert.equal(ROUTE_PAGE_STRINGS.ru.poolLeft(91), ' · использовано 9% · осталось 91%');
});

test('route answers for the orchestrator say used and left too', () => {
  assert.equal(estimateText({ kind: 'window', share: 2, window: '5h', usedPercent: 9 }), '≈ 2% of the 5h (now 9% used, 91% left)');
});

test('the built page has no bare left-only pool line', () => {
  const page = readFileSync(new URL('../settings/assistant.js', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /poolLeft: \(percent\) => ` \\xB7 \$\{percent\}% left`/u);
});
