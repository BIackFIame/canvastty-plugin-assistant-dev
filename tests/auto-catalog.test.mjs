// Auto (Jev)'s public catalog, offline: parsing of the four sources from fixture snapshots, the bundled snapshot,
// the fixed-address allow-list (no task text, no key, no redirects), a source that fails alone keeping its rows and
// their age, the atomic cache across a restart, staleness (old scores stay, old prices go), and the refresh schedule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bundled from '../src/auto/catalog/bundled.json' with { type: 'json' };
import { normalizeArtificialAnalysis } from '../src/auto/catalog/artificialAnalysis.ts';
import {
  CatalogStore, MAX_AGE_MS, MODELS_URL, LIVEBENCH_INDEX_URL, RATINGS_CACHE_FILE, OPENROUTER_CACHE_FILE, PARTIAL_REFRESH_SHARE, mergePartialRefresh,
  normalizeBenchmarks, normalizeModels, parseBenchmarkVariant, selectLiveBenchRelease, validateRatings
} from '../src/auto/catalog/catalog.ts';
import { normalizeOpenRouterModels, offeredByDefault, perMillion, OPENROUTER_MODELS_URL } from '../src/auto/catalog/openrouter.ts';
import { ARTIFICIAL_ANALYSIS_URL } from '../src/auto/catalog/artificialAnalysis.ts';
import { BenchmarkIndex, benchmarkScore, callSeconds } from '../src/auto/catalog/scoring.ts';
import { aaHtml, aaRows, catalogTransport, DAY, livebenchCategories, livebenchCsv, livebenchListing, modelsDev, openRouterList } from './helpers/catalog-fixtures.mjs';

const epoch = Date.parse('2026-10-18T10:00:00Z');

async function store(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ctty-auto-catalog-'));
  const catalog = new CatalogStore({ directory, now: () => epoch, startDelayMs: 0, ...options });
  catalog.configure({ autoRefresh: false, refreshHours: 168, openRouter: true });
  t.after(async () => { catalog.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { directory, catalog };
}

test('models.dev: prices, limits and tool calls as given, unknown stays unknown; provider origins only over https', () => {
  const { models, providers } = normalizeModels(modelsDev());
  const beta = models.find(m => m.key === 'direct/beta-2');
  assert.deepEqual([beta.inputPrice, beta.outputPrice, beta.context, beta.output, beta.toolCall, beta.text], [0.3, 1, 128_000, 16_000, true, true]);
  const alpha = models.find(m => m.key === 'other/alpha-1');
  assert.deepEqual([alpha.inputPrice, alpha.outputPrice, alpha.context, alpha.text], [null, null, null, null]);
  assert.deepEqual(providers, [{ id: 'direct', origin: 'https://api.direct.example' }, { id: 'other', origin: null }]);
  assert.equal(normalizeModels({ p: { api: 'http://plain.example', models: { a: { cost: { input: -1 } } } } }).providers[0].origin, null);
  assert.equal(normalizeModels({ p: { models: { a: { cost: { input: -1 } } } } }).models[0].inputPrice, null);
  assert.throws(() => normalizeModels({}), /Empty/u);
});

test('LiveBench: the newest dated pair, exact variants, incomplete categories stay unknown', () => {
  assert.equal(selectLiveBenchRelease(livebenchListing(), epoch), '2026-10-01', 'a table without its categories is skipped');
  assert.equal(selectLiveBenchRelease([...livebenchListing(), { name: 'table_2099_01_01.csv' }, { name: 'categories_2099_01_01.json' }], epoch), '2026-10-01', 'no future release');
  const rows = normalizeBenchmarks(livebenchCsv(), livebenchCategories(), '2026-10-01', epoch);
  assert.deepEqual(rows.map(r => [r.modelId, r.reasoningEffort, r.thinking]), [['alpha-1', 'high', null], ['beta-2', null, null], ['epsilon-5', 'high', '64k']]);
  assert.equal(benchmarkScore(rows[0], 'coding'), 0.6 * 60 + 0.25 * 70 + 0.15 * 80);
  assert.equal(benchmarkScore(rows[1], 'writing'), 82.5);
  const incomplete = normalizeBenchmarks('model,r,c,a,l,i,d\nx,50,,1,1,1,1\n', livebenchCategories(), '2026-10-01', epoch);
  assert.equal(incomplete[0].categories.Coding, null);
  assert.equal(incomplete[0].overall, null, 'an incomplete row has no overall');
  assert.equal(benchmarkScore(incomplete[0], 'coding'), null);
  for (const [id, model, effort, thinking] of [['gpt-5.5-xhigh', 'gpt-5.5', 'xhigh', null], ['claude-opus-4-7-xhigh-effort', 'claude-opus-4-7', 'xhigh', null], ['claude-opus-4-5-20251101-thinking-64k-high-effort', 'claude-opus-4-5-20251101', 'high', '64k'], ['qwen3.6-27b', 'qwen3.6-27b', null, null]]) {
    assert.deepEqual(Object.values(parseBenchmarkVariant(id)).slice(1), [model, effort, thinking], id);
  }
});

test('Artificial Analysis: measured values only, exact efforts, nothing executed', () => {
  const rows = normalizeArtificialAnalysis(aaHtml(), epoch);
  const byId = Object.fromEntries(rows.map(row => [row.id, row]));
  assert.equal(byId['aa:a1h'].reasoningEffort, 'high');
  assert.equal(byId['aa:a1h'].source.indexVersion, '4.3.2');
  assert.equal(benchmarkScore(byId['aa:a1h'], 'coding'), 57.5);
  assert.equal(benchmarkScore(byId['aa:a1h'], 'writing'), null, 'no writing score from Artificial Analysis');
  assert.equal(byId['aa:b2'].reasoningEffort, null);
  assert.equal(byId['aa:b2'].thinking, null);
  assert.equal(byId['aa:g3'].thinking, 'Reasoning configuration unspecified', 'an unnamed reasoning setup is kept apart');
  assert.equal(byId['aa:est'].overall, null, 'an estimated index is not a measurement');
  assert.equal(byId['aa:est'].categories['Terminal-Bench 4.0'], null);
  globalThis.__aaRan = false;
  assert.throws(() => normalizeArtificialAnalysis('<p>Intelligence Index v4.3</p><script>globalThis.__aaRan=true</script>', epoch));
  assert.equal(globalThis.__aaRan, false); delete globalThis.__aaRan;
  assert.throws(() => normalizeArtificialAnalysis(aaHtml([...aaRows(), { ...aaRows()[0], intelligenceIndex: 1 }]), epoch), /duplicate/iu);
});

test('OpenRouter list: per-million prices, limits, tools and reasoning; Auto offers only suitable models by default', () => {
  assert.equal(perMillion('0.000001'), 1);
  assert.equal(perMillion('0.0000005'), 0.5);
  assert.equal(perMillion('-1'), null, 'a variable price is unknown');
  assert.equal(perMillion('abc'), null);
  const models = normalizeOpenRouterModels(openRouterList());
  assert.ok(!models.some(m => m.id === 'not a valid id'));
  const alpha = models.find(m => m.id === 'vendor/alpha-1');
  assert.deepEqual([alpha.priceIn, alpha.priceOut, alpha.context, alpha.maxOutput, alpha.tools, alpha.reasoning, alpha.text], [1, 4, 400_000, 16_384, true, true, true]);
  assert.deepEqual(models.filter(offeredByDefault).map(m => m.id), ['vendor/alpha-1', 'vendor/beta-2', 'vendor/delta-4', 'vendor/gamma-3'],
    'no :free variant, no meta-router, no image model, no model without tools');
  assert.throws(() => normalizeOpenRouterModels({ data: [] }), /Invalid/u);
});

test('the bundled snapshot passes the cache checks and has measured rows of both sources', () => {
  const snapshot = validateRatings(bundled, epoch);
  assert.ok(snapshot.benchmarks.length > 200);
  assert.ok(snapshot.benchmarks.some(row => row.source.kind === 'livebench') && snapshot.benchmarks.some(row => row.source.kind === 'artificial-analysis'));
  assert.equal(snapshot.modelsFetchedAt, null, 'no prices ship with the plugin');
  assert.ok(epoch - snapshot.fetchedAt > MAX_AGE_MS, 'the bundled scores are old by now: shown as old, still used');
});

test('refresh: only the fixed public addresses, GET with no key, no body, no redirects; the cache is written 0600 and read back after a restart', async t => {
  const transport = catalogTransport();
  const { catalog, directory } = await store(t, { transport, bundled });
  await catalog.load();
  assert.equal(catalog.status().bundled, true);
  await catalog.refresh({ force: true });
  const urls = transport.calls.map(call => call.url).sort();
  assert.deepEqual(urls, [ARTIFICIAL_ANALYSIS_URL, LIVEBENCH_INDEX_URL, MODELS_URL, OPENROUTER_MODELS_URL,
    'https://raw.githubusercontent.com/LiveBench/livebench.github.io/main/public/categories_2026_10_01.json',
    'https://raw.githubusercontent.com/LiveBench/livebench.github.io/main/public/table_2026_10_01.csv'].sort());
  for (const call of transport.calls) {
    assert.equal(call.method, 'GET'); assert.equal(call.body, null); assert.equal(call.redirect, 'error'); assert.equal(call.credentials, 'omit');
    assert.deepEqual(Object.keys(call.headers), ['accept'], 'no authorization, no cookies, nothing about a task');
  }
  const status = catalog.status();
  assert.equal(status.bundled, false);
  // The fixture page has 7 rows against the bundled 221: a partial refresh, which keeps the bundled ones (below).
  assert.deepEqual(status.sources.map(s => [s.id, s.fetchedAt, s.id === 'artificial-analysis' ? /^Artificial Analysis returned 7 rows/u.test(s.error) : s.error]), [['models.dev', epoch, null], ['artificial-analysis', epoch, true], ['livebench', epoch, null], ['openrouter', epoch, null]]);
  const { mode } = await import('node:fs').then(fs => fs.statSync(join(directory, RATINGS_CACHE_FILE)));
  assert.equal(mode & 0o777, 0o600);
  const routing = catalog.routing();
  assert.equal(routing.pricesStale, false);
  assert.equal(routing.openRouterPricesStale, false);
  assert.ok(routing.benchmarks.every(row => row.historical === (row.source.fetchedAt !== epoch)), 'fresh rows are current; the kept bundled ones are old');
  // A restart reads the cache (not the bundled snapshot).
  const again = new CatalogStore({ directory, now: () => epoch + DAY, bundled });
  t.after(() => again.dispose());
  await again.load();
  assert.equal(again.status().bundled, false);
  assert.equal(again.ratings().fetchedAt, epoch);
  assert.equal(again.openRouter().models.length, catalog.openRouter().models.length);
  // A broken cache file is not used: the bundled snapshot stays.
  await writeFile(join(directory, RATINGS_CACHE_FILE), '{"version":2,"fetchedAt":1,"models":[{"key":"x"}]}');
  const broken = new CatalogStore({ directory, now: () => epoch, bundled });
  t.after(() => broken.dispose());
  await broken.load();
  assert.equal(broken.status().bundled, true);
  assert.equal(broken.status().lastError, 'Catalog cache unavailable');
});

test('a source fails alone: its earlier rows keep their original age; old scores stay usable, old prices do not', async t => {
  let now = epoch;
  const failing = new Set();
  const { catalog } = await store(t, { transport: catalogTransport({ fail: failing }), now: () => now });
  await catalog.load();
  await catalog.refresh({ force: true });
  now = epoch + 8 * DAY;
  failing.add('artificial-analysis'); failing.add('models.dev');
  await catalog.refresh({ force: true });
  const ratings = catalog.ratings();
  assert.equal(ratings.fetchedAt, now);
  assert.ok(ratings.benchmarks.filter(r => r.source.kind === 'artificial-analysis').every(r => r.source.fetchedAt === epoch), 'kept with their first download time');
  assert.ok(ratings.benchmarks.filter(r => r.source.kind === 'livebench').every(r => r.source.fetchedAt === now));
  assert.match(ratings.sourceErrors['artificial-analysis'], /unavailable/u);
  assert.ok(!JSON.stringify(ratings).includes('PRIVATE-TRANSPORT-DETAIL'), 'no transport detail is kept');
  const routing = catalog.routing();
  assert.ok(routing.benchmarks.filter(r => r.source.kind === 'artificial-analysis').every(r => r.historical), 'old AA scores are marked old');
  assert.ok(routing.benchmarks.some(r => r.source.kind === 'artificial-analysis'), '… and still there');
  assert.equal(routing.pricesStale, true, 'models.dev prices are 8 days old: not compared');
  assert.equal(routing.openRouterPricesStale, false, 'the OpenRouter list was refreshed');
  // Everything fails: the earlier snapshot stays, and the refresh reports it.
  failing.add('livebench'); failing.add('openrouter');
  await assert.rejects(catalog.refresh({ force: true }), /unavailable/u);
  assert.equal(catalog.ratings().fetchedAt, now);
  assert.match(catalog.status().lastError, /unavailable/u);
});

test('a partial refresh never drops known scores: Artificial Analysis\'s page now carries full rows only for its default chart', async t => {
  // The page as served on 2026-10-18: full rows (with effort and release) for the chart's models under
  // `initialModels`, and a slim list of every release (name, date, index; no effort, no sub-scores) that is not a score.
  const slim = Array.from({ length: 193 }, (_, i) => ({ slug: `release-${i}`, name: `Release ${i}`, releaseDate: '2026-09-01', intelligenceIndex: 30 + i % 20, modelCount: 2, creator: { slug: 'c', name: 'C', logo: '/x.png' } }));
  const page = `<html><p>Artificial Analysis Intelligence Index v4.3.2</p><script>self.__next_f.push(${JSON.stringify([1, `5:${JSON.stringify({ children: [{ initialModels: aaRows() }, { releases: slim }] })}\n`])})</script></html>`;
  assert.equal(normalizeArtificialAnalysis(page, epoch).length, aaRows().length, 'the slim release list adds no rows (it has no effort)');
  const bundledAA = bundled.benchmarks.filter(row => row.source.kind === 'artificial-analysis');
  assert.equal(bundledAA.length, 221);
  const transport = catalogTransport({ overrides: { [ARTIFICIAL_ANALYSIS_URL]: () => new Response(page) } });
  const { catalog } = await store(t, { transport, bundled });
  await catalog.load();
  await catalog.refresh({ force: true });
  const rows = catalog.ratings().benchmarks.filter(row => row.source.kind === 'artificial-analysis');
  // GLM-5.3 at max is in both: the fresh row replaces the bundled one; the other 220 stay.
  const covered = bundledAA.filter(row => row.modelId === 'glm-5-3' && row.reasoningEffort === 'max' && row.thinking === null);
  assert.equal(covered.length, 1);
  assert.equal(rows.length, aaRows().length + bundledAA.length - 1, 'the fresh rows and every bundled one they do not cover');
  assert.equal(rows.filter(row => row.source.fetchedAt === epoch).length, aaRows().length);
  assert.ok(bundledAA.filter(row => row !== covered[0]).every(row => rows.some(kept => kept.id === row.id && kept.source.fetchedAt === row.source.fetchedAt)), 'kept unchanged, with their own age');
  const status = catalog.status().sources.find(source => source.id === 'artificial-analysis');
  assert.equal(status.rows, rows.length);
  assert.match(status.error, /^Artificial Analysis returned 7 rows \(227 known\); the other 220 earlier scores are kept with their age\.$/u);
  // The next partial refresh keeps them again; LiveBench (whole tables per release) is replaced as usual.
  await catalog.refresh({ force: true });
  assert.equal(catalog.ratings().benchmarks.filter(row => row.source.kind === 'artificial-analysis').length, 227);
  assert.equal(catalog.ratings().sourceErrors.livebench, undefined);
});

test('a cache that already lost rows to a partial page gets the bundled snapshot\'s rows back on the next refresh, with the snapshot\'s age', async t => {
  const transport = catalogTransport();
  // Before the merge rule: the cache was written from the partial page alone (7 Artificial Analysis rows).
  const { catalog, directory } = await store(t, { transport });
  await catalog.load();
  await catalog.refresh({ force: true });
  assert.equal(catalog.ratings().benchmarks.filter(row => row.source.kind === 'artificial-analysis').length, 7);
  const later = new CatalogStore({ directory, now: () => epoch + DAY, startDelayMs: 0, transport, bundled });
  later.configure({ autoRefresh: false, refreshHours: 168, openRouter: true });
  t.after(() => later.dispose());
  await later.load();
  assert.equal(later.status().bundled, false, 'the cache is in use');
  await later.refresh({ force: true });
  const rows = later.ratings().benchmarks.filter(row => row.source.kind === 'artificial-analysis');
  const bundledAA = bundled.benchmarks.filter(row => row.source.kind === 'artificial-analysis');
  assert.equal(rows.length, 7 + bundledAA.length - 1, 'the fresh 7 and the bundled rows they do not cover (GLM-5.3 @max is in both)');
  const snapshotAge = new Set(bundledAA.map(row => row.source.fetchedAt));
  assert.equal(rows.filter(row => snapshotAge.has(row.source.fetchedAt)).length, bundledAA.length - 1, 'restored with the snapshot\'s own age');
  assert.match(later.status().sources.find(source => source.id === 'artificial-analysis').error, /returned 7 rows \(227 known\)/u);
  assert.ok(later.routing().benchmarks.filter(row => snapshotAge.has(row.source.fetchedAt)).every(row => row.historical), 'shown as old');
});

test('partial refresh rule: under half of the known rows keeps the uncovered earlier ones; a normal-sized refresh replaces', () => {
  assert.equal(PARTIAL_REFRESH_SHARE, 0.5);
  const earlier = normalizeArtificialAnalysis(aaHtml(), epoch - DAY);
  const fresh = normalizeArtificialAnalysis(aaHtml(aaRows().slice(0, 2)), epoch);
  const partial = mergePartialRefresh(fresh, earlier);
  assert.equal(partial.kept, earlier.length - 2, 'the same rows (by id) are not kept twice');
  assert.deepEqual(partial.rows.slice(0, 2), fresh);
  const enough = normalizeArtificialAnalysis(aaHtml(aaRows().slice(0, 4)), epoch);
  assert.deepEqual(mergePartialRefresh(enough, earlier), { rows: enough, kept: 0 }, '4 of 7: a normal refresh (models may leave the list)');
  assert.deepEqual(mergePartialRefresh(fresh, []), { rows: fresh, kept: 0 });
  // The same variant under a new row id: the fresh one wins, the earlier one goes.
  const renamed = fresh.map(row => ({ ...row, id: `${row.id}-new` }));
  assert.equal(mergePartialRefresh(renamed, earlier).kept, earlier.length - 2);
});

test('only fixed addresses: a listing that points elsewhere is not followed; an oversized answer is refused', async t => {
  const evilListing = () => Response.json([{ name: 'table_2026_10_01.csv', download_url: 'https://evil.example/x.csv' }, { name: 'categories_2026_10_01.json' }]);
  const transport = catalogTransport({ overrides: { [LIVEBENCH_INDEX_URL]: evilListing, [MODELS_URL]: () => new Response('x'.repeat(10), { headers: { 'content-length': String(64 * 1024 * 1024) } }) } });
  const { catalog } = await store(t, { transport });
  await catalog.load();
  await catalog.refresh({ force: true });
  assert.ok(transport.calls.every(call => /^https:\/\/(?:models\.dev|api\.github\.com|raw\.githubusercontent\.com|artificialanalysis\.ai|openrouter\.ai)\//u.test(call.url)));
  assert.match(catalog.ratings().sourceErrors['models.dev'], /unavailable/u, 'too large: models.dev failed alone');
});

test('schedule: nothing before load or while off; due after the interval; failures back off', async t => {
  let now = epoch;
  const transport = catalogTransport();
  const { catalog } = await store(t, { transport, now: () => now, startDelayMs: 20_000 });
  assert.equal(catalog.status().nextRefreshAt, null, 'not before load');
  await catalog.load();
  assert.equal(catalog.status().nextRefreshAt, null, 'background refresh off');
  catalog.configure({ autoRefresh: true, refreshHours: 24, openRouter: false });
  assert.equal(catalog.status().nextRefreshAt, epoch + 20_000, 'nothing cached: soon, but not at start');
  await catalog.refresh();
  assert.equal(catalog.status().nextRefreshAt, epoch + 24 * 3_600_000);
  assert.ok(!transport.calls.some(call => call.url === OPENROUTER_MODELS_URL), 'no OpenRouter list without an OpenRouter upstream');
  catalog.configure({ autoRefresh: true, refreshHours: 24, openRouter: true });
  assert.equal(catalog.status().nextRefreshAt, epoch + 20_000, 'the OpenRouter list is due now');
  const failing = new CatalogStore({ directory: null, transport: async () => { throw new Error('down'); }, now: () => now, startDelayMs: 0 });
  t.after(() => failing.dispose());
  failing.configure({ autoRefresh: true, refreshHours: 24, openRouter: false });
  await failing.load();
  await assert.rejects(failing.refresh());
  assert.equal(failing.status().nextRefreshAt, now + 60_000, 'one minute after the first failure');
  await assert.rejects(failing.refresh());
  assert.equal(failing.status().nextRefreshAt, now + 120_000);
});

test('the OpenRouter cache is validated before use', async t => {
  const { catalog, directory } = await store(t, { transport: catalogTransport() });
  await catalog.load();
  await catalog.refresh({ force: true });
  const saved = JSON.parse(await readFile(join(directory, OPENROUTER_CACHE_FILE), 'utf8'));
  saved.models[0].priceIn = 'free';
  await writeFile(join(directory, OPENROUTER_CACHE_FILE), JSON.stringify(saved));
  const again = new CatalogStore({ directory, now: () => epoch });
  t.after(() => again.dispose());
  await again.load();
  assert.equal(again.openRouter(), null);
  assert.match(again.status().sources.find(s => s.id === 'openrouter').error, /unavailable/u);
});

test('speed: Artificial Analysis rows keep the medium-prompt output speed and first-chunk time when stated; nothing is estimated', async t => {
  const perf = (tps, ttfc) => ({ performanceByPromptType: { medium: { medianOutputSpeed: tps, medianTimeToFirstChunk: ttfc, medianTimeToFirstAnswerToken: 99 }, long: { medianOutputSpeed: 1 } } });
  const rows = aaRows();
  rows[0] = { ...rows[0], ...perf(120.123456, 0.8) };
  rows[1] = { ...rows[1], ...perf(-3, 1) };
  rows[2] = { ...rows[2], ...perf(55, null) };
  const parsed = Object.fromEntries(normalizeArtificialAnalysis(aaHtml(rows), epoch).map(row => [row.id, row]));
  assert.deepEqual(parsed['aa:a1h'].speed, { outputTps: 120.12, latencyS: 0.8 }, 'the medium prompt only, rounded');
  assert.equal(parsed['aa:a1l'].speed, undefined, 'an implausible value is no speed');
  assert.deepEqual(parsed['aa:b2'].speed, { outputTps: 55, latencyS: null }, 'speed without a latency');
  assert.equal(parsed['aa:d4h'].speed, undefined, 'not stated: unknown');
  // The cache checks: only Artificial Analysis rows carry one, bounded, no extra fields.
  const snapshot = { version: 2, fetchedAt: epoch, modelsFetchedAt: null, models: [], providers: [], benchmarks: Object.values(parsed), sourceErrors: {} };
  assert.deepEqual(validateRatings(snapshot, epoch).benchmarks.find(row => row.id === 'aa:a1h').speed, { outputTps: 120.12, latencyS: 0.8 });
  const bad = speed => ({ ...snapshot, benchmarks: snapshot.benchmarks.map(row => row.id === 'aa:a1h' ? { ...row, speed } : row) });
  assert.throws(() => validateRatings(bad({ outputTps: 0, latencyS: 1 }), epoch));
  assert.throws(() => validateRatings(bad({ outputTps: 10, latencyS: 99_999 }), epoch));
  assert.throws(() => validateRatings(bad({ outputTps: 10, latencyS: 1, guess: true }), epoch));
  const livebench = validateRatings(bundled, epoch).benchmarks.find(row => row.source.kind === 'livebench');
  assert.throws(() => validateRatings({ ...bundled, benchmarks: [{ ...livebench, speed: { outputTps: 10, latencyS: 1 } }] }, epoch), 'LiveBench measures no speed');
  // The bundled snapshot ships the speeds the page stated for its rows; the rest have none.
  const withSpeed = validateRatings(bundled, epoch).benchmarks.filter(row => row.speed);
  assert.ok(withSpeed.length >= 15 && withSpeed.every(row => row.source.kind === 'artificial-analysis'));
  // The index: exact model and effort only, like scores.
  const index = new BenchmarkIndex({ asOf: epoch, benchmarks: validateRatings(snapshot, epoch).benchmarks.map(row => ({ ...row, historical: false })), models: [], providers: [], pricesStale: true, openRouter: null, openRouterPricesStale: true });
  assert.equal(index.speed('alpha-1', 'high', { openRouter: true, origin: null }).outputTps, 120.12);
  assert.equal(index.speed('alpha-1', 'low', { openRouter: true, origin: null }), null, 'another effort has its own speed or none');
  assert.equal(index.speed('alpha-1', null, { openRouter: true, origin: null }), null);
  assert.equal(callSeconds({ outputTps: 100, latencyS: 2 }, 500), 7);
  assert.equal(callSeconds(null, 500), null, 'unknown stays unknown');
  // A partial refresh keeps the earlier rows with their speeds; a fresh row says what the page says now.
  const transport = catalogTransport({ overrides: { [ARTIFICIAL_ANALYSIS_URL]: () => new Response(aaHtml(rows)) } });
  const { catalog } = await store(t, { transport, bundled });
  await catalog.load();
  await catalog.refresh({ force: true });
  const after = catalog.ratings().benchmarks;
  assert.equal(after.find(row => row.id === 'aa:a1h').speed.outputTps, 120.12);
  // GLM-5.3 at max is on the fresh page (without a speed there): the fresh row replaces it; the others keep theirs.
  for (const row of withSpeed.filter(row => !(row.modelId === 'glm-5-3' && row.reasoningEffort === 'max'))) assert.deepEqual(after.find(kept => kept.id === row.id)?.speed, row.speed, `${row.modelId} keeps its speed`);
  assert.equal(after.find(row => row.id === 'aa:glm').speed, undefined, 'the page now states none for it: none');
});
