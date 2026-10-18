import { randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import { mkdir, open, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AA_CATEGORIES, ARTIFICIAL_ANALYSIS_BYTES, ARTIFICIAL_ANALYSIS_URL, normalizeArtificialAnalysis } from './artificialAnalysis.ts';
import { EFFORTS, type ReasoningEffort } from './identity.ts';
import { normalizeOpenRouterModels, OPENROUTER_MODELS_BYTES, OPENROUTER_MODELS_URL, validateOpenRouterSnapshot, type OpenRouterSnapshot } from './openrouter.ts';

/**
 * The public model catalog Auto (Jev) chooses from: models.dev (models, prices, limits, provider addresses),
 * LiveBench and Artificial Analysis (measured benchmark scores per exact model and effort), and OpenRouter's model
 * list. Ported from the earlier experimental catalog. Rules that carry over unchanged:
 *
 * - Sources are fixed HTTPS addresses (an allow-list checked on every download), bounded in size and time, with
 *   redirects refused and no credentials. No task text, key or account detail is ever sent.
 * - A score belongs to one exact benchmark row (model id + effort + thinking setup). It never transfers to another
 *   effort, version or reseller variant; a model without its own row is unknown, and unknown stays unknown.
 * - A failed source keeps its last valid rows with their original download time; the cache is replaced atomically.
 * - Measured scores stay usable offline when old ("historical", shown as such). Reference prices older than seven
 *   days are not used to compare cost.
 * - A small snapshot of measured rows ships with the plugin, so a computer that never went online still has data.
 */
export const MODELS_URL = 'https://models.dev/api.json';
export const LIVEBENCH_INDEX_URL = 'https://api.github.com/repos/LiveBench/livebench.github.io/contents/public';
const RAW_ROOT = 'https://raw.githubusercontent.com/LiveBench/livebench.github.io/main/public/';
const LIVEBENCH_FILE = /^https:\/\/raw\.githubusercontent\.com\/LiveBench\/livebench\.github\.io\/main\/public\/(?:table_\d{4}_\d{2}_\d{2}\.csv|categories_\d{4}_\d{2}_\d{2}\.json)$/u;
export const RATINGS_CACHE_FILE = 'catalog-v2.json';
export const OPENROUTER_CACHE_FILE = 'openrouter-models-v1.json';
export const DEFAULT_REFRESH_HOURS = 168;
export const OPENROUTER_REFRESH_HOURS = 24;
export const MAX_AGE_MS = 7 * 24 * 3_600_000;
const MAX_MODELS = 30_000;
const MODEL_BYTES = 12 * 1024 * 1024;
const OTHER_BYTES = 1024 * 1024;
const CACHE_BYTES = 24 * 1024 * 1024;

export type SourceId = 'models.dev' | 'livebench' | 'artificial-analysis' | 'openrouter';
export const RATING_SOURCES = ['models.dev', 'livebench', 'artificial-analysis'] as const;

export interface CatalogModel {
  key: string;
  providerId: string;
  modelId: string;
  toolCall: boolean | null;
  /** Text output (null: not stated). */
  text: boolean | null;
  context: number | null;
  output: number | null;
  /** USD per million tokens as models.dev reports them; null is unknown. */
  inputPrice: number | null;
  outputPrice: number | null;
}
/** A models.dev provider and the API origin it states (to recognise an OpenAI-compatible upstream). */
export interface CatalogProvider { id: string; origin: string | null }
export interface BenchmarkSource { kind: 'livebench' | 'artificial-analysis'; url: string; releaseDate: string | null; fetchedAt: number; indexVersion?: string; modelUrl?: string }
export interface CatalogBenchmark {
  /** The exact row id; never look a score up by model id alone. */
  id: string;
  modelId: string;
  reasoningEffort: ReasoningEffort | null;
  /** A reasoning setup that is not one exact effort (a token budget, "auto", an unnamed default): never scored. */
  thinking: string | null;
  categories: Record<string, number | null>;
  /** Null unless every category is complete (LiveBench) or the index is measured (Artificial Analysis). */
  overall: number | null;
  source: BenchmarkSource;
}
export interface RatingsSnapshot {
  version: 2;
  /** The newest download that went into this snapshot. */
  fetchedAt: number;
  /** When models.dev was last read (null: never, as in the bundled snapshot). */
  modelsFetchedAt: number | null;
  models: CatalogModel[];
  providers: CatalogProvider[];
  benchmarks: CatalogBenchmark[];
  sourceErrors: Partial<Record<SourceId, string>>;
}
export interface CatalogConfig { autoRefresh: boolean; refreshHours: number; openRouter: boolean }

class CatalogError extends Error {}
function fail(message = 'Invalid catalog data'): never { throw new CatalogError(message); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function boundedText(value: unknown, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail();
  return value;
}
function date(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? value : null;
}
function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) fail();
  return value;
}
const price = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10_000 ? value : null;
const limit = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 100_000_000 ? value : null;
const flag = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
function score(value: unknown): number | null {
  if (typeof value === 'string') value = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}
function mean(values: (number | null)[]): number | null {
  return values.length && values.every((v): v is number => v !== null) ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}
function originOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512) return null;
  try { const url = new URL(value); return url.protocol === 'https:' ? url.origin : null; } catch { return null; }
}
function rawUrls(release: string): { table: string; categories: string } {
  if (!date(release)) fail();
  const stem = release.replaceAll('-', '_');
  return { table: `${RAW_ROOT}table_${stem}.csv`, categories: `${RAW_ROOT}categories_${stem}.json` };
}

// ---------------------------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------------------------

/** A conservative suffix parser: an unknown configuration stays part of the exact model id. */
export function parseBenchmarkVariant(value: string): { id: string; modelId: string; reasoningEffort: ReasoningEffort | null; thinking: string | null } {
  const id = boundedText(value);
  let modelId = id;
  let reasoningEffort: ReasoningEffort | null = null;
  let thinking: string | null = null;
  const effort = /-(none|minimal|low|medium|high|xhigh|max|ultra)(?:-effort)?$/.exec(modelId);
  if (effort) { reasoningEffort = effort[1] as ReasoningEffort; modelId = modelId.slice(0, effort.index); }
  const budget = /-thinking-(auto|\d+(?:k|m)?)$/.exec(modelId);
  if (budget) { thinking = budget[1]!; modelId = modelId.slice(0, budget.index); }
  if (!modelId) return { id, modelId: id, reasoningEffort: null, thinking: null };
  return { id, modelId, reasoningEffort, thinking };
}

/** models.dev `api.json`: providers with their models, prices and limits. */
export function normalizeModels(input: unknown): { models: CatalogModel[]; providers: CatalogProvider[] } {
  const models: CatalogModel[] = [];
  const providers: CatalogProvider[] = [];
  const seen = new Set<string>();
  for (const [providerId, rawProvider] of Object.entries(record(input))) {
    boundedText(providerId, 128);
    const provider = record(rawProvider);
    providers.push({ id: providerId, origin: originOf(provider.api) });
    for (const [entryId, value] of Object.entries(record(provider.models))) {
      const model = record(value);
      const modelId = boundedText(model.id ?? entryId);
      const key = `${providerId}/${modelId}`;
      if (seen.has(key) || models.length >= MAX_MODELS) fail();
      seen.add(key);
      const costs = model.cost == null ? {} : record(model.cost);
      const limits = model.limit == null ? {} : record(model.limit);
      const outputs = model.modalities && typeof model.modalities === 'object' && Array.isArray((model.modalities as { output?: unknown }).output) ? (model.modalities as { output: unknown[] }).output : null;
      models.push({ key, providerId, modelId, toolCall: flag(model.tool_call), text: outputs ? outputs.includes('text') : null,
        context: limit(limits.context), output: limit(limits.output), inputPrice: price(costs.input), outputPrice: price(costs.output) });
    }
  }
  if (!models.length) fail('Empty model catalog');
  return { models: models.sort((a, b) => a.key.localeCompare(b.key)), providers: providers.sort((a, b) => a.id.localeCompare(b.id)) };
}

export function selectLiveBenchRelease(input: unknown, now: number): string {
  timestamp(now);
  if (!Array.isArray(input) || input.length > 10_000) fail('Invalid benchmark listing');
  const names = new Set(input.map(value => record(value).name).filter((name): name is string => typeof name === 'string'));
  const today = new Date(now).toISOString().slice(0, 10);
  const releases = [...names].flatMap(name => {
    const match = /^table_(\d{4}_\d{2}_\d{2})\.csv$/.exec(name);
    const release = match ? date(match[1]!.replaceAll('_', '-')) : null;
    return release && release <= today && names.has(`categories_${match![1]}.json`) ? [release] : [];
  }).sort();
  return releases.at(-1) ?? fail('No valid benchmark release');
}

/** Minimal RFC 4180 parser (quoted commas and newlines, escaped quotes). */
function csvRows(csv: string): string[][] {
  if (Buffer.byteLength(csv) > OTHER_BYTES) fail('Catalog response too large');
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false; let closed = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i]!;
    if (quoted) {
      if (char === '"') { if (csv[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += char;
    } else if (char === ',' || char === '\n' || char === '\r') {
      row.push(cell); cell = ''; closed = false;
      if (char !== ',') {
        if (char === '\r' && csv[i + 1] === '\n') i++;
        if (row.some(v => v !== '')) rows.push(row);
        row = [];
      }
    } else if (char === '"' && !cell && !closed) quoted = true;
    else { if (closed || char === '"') fail('Invalid benchmark CSV'); cell += char; }
    if (cell.length > 1024 || row.length > 512 || rows.length > MAX_MODELS) fail('Invalid benchmark CSV');
  }
  if (quoted) fail('Invalid benchmark CSV');
  row.push(cell); if (row.some(v => v !== '')) rows.push(row);
  return rows;
}

export function normalizeBenchmarks(csv: string, inputCategories: unknown, releaseDate: string, fetchedAt: number): CatalogBenchmark[] {
  timestamp(fetchedAt);
  const urls = rawUrls(releaseDate);
  const rows = csvRows(csv.replace(/^﻿/, ''));
  const header = rows.shift();
  if (!header || header[0] !== 'model' || new Set(header).size !== header.length || !rows.length) fail('Invalid benchmark CSV');
  const entries = Object.entries(record(inputCategories));
  if (!entries.length || entries.length > 64) fail('Invalid benchmark categories');
  const categories = entries.map(([name, tasks]) => {
    boundedText(name, 128);
    if (!Array.isArray(tasks) || !tasks.length || tasks.length > 512 || new Set(tasks).size !== tasks.length) fail('Invalid benchmark categories');
    const columns = tasks.map(task => { boundedText(task, 128); const index = header.indexOf(task as string); if (index < 1) fail('Incomplete benchmark columns'); return index; });
    return { name, columns };
  });
  const seen = new Set<string>();
  return rows.map(row => {
    if (row.length !== header.length) fail('Incomplete benchmark row');
    const variant = parseBenchmarkVariant(row[0]!);
    if (seen.has(variant.id)) fail('Duplicate benchmark row');
    seen.add(variant.id);
    const scores = Object.fromEntries(categories.map(({ name, columns }) => [name, mean(columns.map(index => score(row[index])))]));
    return { ...variant, categories: scores, overall: mean(Object.values(scores)), source: { kind: 'livebench' as const, url: urls.table, releaseDate, fetchedAt } };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Cache validation: the cache and the bundled snapshot pass the same checks as a download before routing reads them
// ---------------------------------------------------------------------------------------------------------------

export function validateRatings(input: unknown, now: number): RatingsSnapshot {
  const data = record(input);
  if (data.version !== 2 || timestamp(data.fetchedAt) > now || !Array.isArray(data.models) || data.models.length > MAX_MODELS
    || !Array.isArray(data.providers) || data.providers.length > 2_000 || !Array.isArray(data.benchmarks) || !data.benchmarks.length || data.benchmarks.length > MAX_MODELS) fail();
  const fetchedAt = data.fetchedAt as number;
  const modelsFetchedAt = data.modelsFetchedAt === null ? null : timestamp(data.modelsFetchedAt);
  if (modelsFetchedAt !== null && modelsFetchedAt > fetchedAt) fail();
  const keys = new Set<string>();
  const models = data.models.map(value => {
    const m = record(value);
    const providerId = boundedText(m.providerId, 128), modelId = boundedText(m.modelId);
    if (m.key !== `${providerId}/${modelId}` || keys.has(m.key)) fail();
    keys.add(m.key);
    for (const key of ['toolCall', 'text']) if (m[key] !== null && typeof m[key] !== 'boolean') fail();
    for (const key of ['inputPrice', 'outputPrice']) if (m[key] !== null && price(m[key]) !== m[key]) fail();
    for (const key of ['context', 'output']) if (m[key] !== null && limit(m[key]) !== m[key]) fail();
    return { key: m.key as string, providerId, modelId, toolCall: m.toolCall as boolean | null, text: m.text as boolean | null, context: m.context as number | null, output: m.output as number | null, inputPrice: m.inputPrice as number | null, outputPrice: m.outputPrice as number | null };
  });
  if (models.length && modelsFetchedAt === null) fail();
  const providers = data.providers.map(value => {
    const p = record(value);
    const id = boundedText(p.id, 128);
    if (p.origin !== null && originOf(p.origin) !== p.origin) fail();
    return { id, origin: p.origin as string | null };
  });
  const variants = new Set<string>();
  const benchmarks = data.benchmarks.map(value => {
    const b = record(value), s = record(b.source);
    const aa = s.kind === 'artificial-analysis';
    if (!aa && s.kind !== 'livebench') fail();
    const variant = aa
      ? { id: boundedText(b.id), modelId: boundedText(b.modelId), reasoningEffort: b.reasoningEffort as ReasoningEffort | null, thinking: b.thinking as string | null }
      : parseBenchmarkVariant(boundedText(b.id));
    if (variants.has(variant.id) || b.modelId !== variant.modelId || b.reasoningEffort !== variant.reasoningEffort || b.thinking !== variant.thinking) fail();
    variants.add(variant.id);
    if (timestamp(s.fetchedAt) > fetchedAt) fail();
    let source: BenchmarkSource;
    if (aa) {
      if (!variant.id.startsWith('aa:') || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(variant.modelId) || variant.reasoningEffort !== null && !EFFORTS.includes(variant.reasoningEffort)) fail();
      if (variant.thinking !== null) boundedText(variant.thinking, 128);
      if (s.url !== ARTIFICIAL_ANALYSIS_URL || s.releaseDate !== null || typeof s.indexVersion !== 'string' || !/^\d+(?:\.\d+){1,2}$/.test(s.indexVersion)
        || typeof s.modelUrl !== 'string' || !/^https:\/\/artificialanalysis\.ai\/models\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s.modelUrl)) fail();
      source = { kind: 'artificial-analysis', url: s.url, releaseDate: null, fetchedAt: s.fetchedAt as number, indexVersion: s.indexVersion, modelUrl: s.modelUrl };
    } else {
      const releaseDate = date(s.releaseDate);
      if (!releaseDate || releaseDate > new Date(s.fetchedAt as number).toISOString().slice(0, 10)) fail();
      if (s.url !== rawUrls(releaseDate).table) fail();
      source = { kind: 'livebench', url: s.url, releaseDate, fetchedAt: s.fetchedAt as number };
    }
    const entries = Object.entries(record(b.categories));
    if (!entries.length || entries.length > 64 || aa && entries.map(([key]) => key).sort().join('|') !== [...AA_CATEGORIES].sort().join('|')) fail();
    const categories = Object.fromEntries(entries.map(([key, v]) => { boundedText(key, 128); if (v !== null && score(v) !== v) fail(); return [key, v as number | null]; }));
    const overall = aa ? categories['Intelligence Index']! : mean(Object.values(categories));
    if (b.overall !== overall) fail();
    return { ...variant, categories, overall, source };
  });
  if (!benchmarks.some(b => Object.values(b.categories).some(v => v !== null))) fail();
  const sourceErrors: RatingsSnapshot['sourceErrors'] = {};
  for (const [key, value] of Object.entries(data.sourceErrors == null ? {} : record(data.sourceErrors))) {
    if (!(RATING_SOURCES as readonly string[]).includes(key)) fail();
    sourceErrors[key as SourceId] = boundedText(value, 160);
  }
  return { version: 2, fetchedAt, modelsFetchedAt, models, providers, benchmarks, sourceErrors };
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// The store: caches, background refresh, the routing view
// ---------------------------------------------------------------------------------------------------------------

export interface SourceStatus { id: SourceId; fetchedAt: number | null; version: string | null; rows: number; measured: number; stale: boolean; error: string | null }
export interface CatalogStatus {
  now: number;
  autoRefresh: boolean;
  refreshHours: number;
  refreshing: boolean;
  bundled: boolean;
  lastError: string | null;
  lastAttemptAt: number | null;
  nextRefreshAt: number | null;
  sources: SourceStatus[];
}

/** What routing reads: measured rows (with an "old" mark), and prices only while they are fresh. */
export interface RoutingCatalog {
  asOf: number;
  benchmarks: ReadonlyArray<CatalogBenchmark & { historical: boolean }>;
  models: readonly CatalogModel[];
  providers: readonly CatalogProvider[];
  /** models.dev prices are older than seven days (or were never read): not used to compare cost. */
  pricesStale: boolean;
  openRouter: OpenRouterSnapshot | null;
  openRouterPricesStale: boolean;
}

export interface CatalogStoreOptions {
  directory: string | null;
  transport?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
  /** The bundled snapshot (validated like a cache). */
  bundled?: unknown;
  /** The first background refresh waits at least this long after start (default 20 s). */
  startDelayMs?: number;
  onChange?: () => void;
}

/** A refresh with fewer than this share of a source's known rows is partial: the earlier rows it lacks are kept. */
export const PARTIAL_REFRESH_SHARE = 0.5;

const variantOf = (row: CatalogBenchmark): string => JSON.stringify([row.modelId, row.reasoningEffort, row.thinking, row.source.indexVersion ?? row.source.releaseDate]);

/**
 * A source's fresh rows, plus — when they are suspiciously few (under PARTIAL_REFRESH_SHARE of the known ones) — the
 * earlier rows they do not cover (same row id, or the same model, effort, setup and index version or release),
 * unchanged, so they keep their own download time. A normal-sized refresh replaces the source's rows.
 */
export function mergePartialRefresh(fresh: readonly CatalogBenchmark[], earlier: readonly CatalogBenchmark[]): { rows: CatalogBenchmark[]; kept: number } {
  if (!earlier.length || fresh.length >= earlier.length * PARTIAL_REFRESH_SHARE) return { rows: [...fresh], kept: 0 };
  const ids = new Set(fresh.map(row => row.id));
  const variants = new Set(fresh.map(variantOf));
  const keep = earlier.filter(row => !ids.has(row.id) && !variants.has(variantOf(row)));
  return { rows: [...fresh, ...keep], kept: keep.length };
}

export class CatalogStore {
  private readonly directory: string | null;
  private readonly transport: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly startDelayMs: number;
  private readonly onChange: (() => void) | undefined;
  private config: CatalogConfig = { autoRefresh: true, refreshHours: DEFAULT_REFRESH_HOURS, openRouter: false };
  private ratingsSnapshot: RatingsSnapshot | null = null;
  private bundledSnapshot: RatingsSnapshot | null = null;
  private openRouterSnapshot: OpenRouterSnapshot | null = null;
  private inflight: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loadedAt: number | null = null;
  private disposed = false;
  private failures = 0;
  private lastError: string | null = null;
  private lastAttemptAt: number | null = null;
  private nextRefreshAt: number | null = null;
  private openRouterError: string | null = null;
  /** Grows on every change of the data (routing caches its inventory on it). */
  version = 0;

  constructor(options: CatalogStoreOptions) {
    this.directory = options.directory;
    this.transport = options.transport ?? fetch;
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange;
    this.timeoutMs = Number.isFinite(options.requestTimeoutMs) ? Math.max(1, Math.min(60_000, options.requestTimeoutMs!)) : 30_000;
    this.startDelayMs = Math.max(0, options.startDelayMs ?? 20_000);
    if (options.bundled != null) {
      try { this.bundledSnapshot = freeze(validateRatings(options.bundled, this.now())); }
      catch { this.lastError = 'Bundled catalog unavailable'; }
    }
  }

  configure(config: CatalogConfig): void {
    const hours = Number.isFinite(config.refreshHours) ? Math.max(1, Math.min(720, Math.round(config.refreshHours))) : DEFAULT_REFRESH_HOURS;
    const next = { autoRefresh: config.autoRefresh === true, refreshHours: hours, openRouter: config.openRouter === true };
    if (JSON.stringify(next) === JSON.stringify(this.config)) return;
    this.config = next;
    this.schedule(); this.notify();
  }

  /** Reads both caches (a bad or missing file leaves the bundled snapshot in use). */
  async load(): Promise<void> {
    if (this.directory) {
      const ratings = await this.readCache(RATINGS_CACHE_FILE).catch(() => undefined);
      if (ratings !== undefined) {
        try { this.ratingsSnapshot = freeze(validateRatings(ratings, this.now())); } catch { this.lastError = 'Catalog cache unavailable'; }
      }
      const openRouter = await this.readCache(OPENROUTER_CACHE_FILE).catch(() => undefined);
      if (openRouter !== undefined) {
        try { this.openRouterSnapshot = freeze(validateOpenRouterSnapshot(openRouter, this.now())); } catch { this.openRouterError = 'OpenRouter list cache unavailable'; }
      }
    }
    this.loadedAt = this.now();
    this.version++;
    this.schedule(); this.notify();
  }

  private async readCache(name: string): Promise<unknown> {
    const handle = await open(join(this.directory!, name), 'r');
    try {
      const size = (await handle.stat()).size;
      if (size > CACHE_BYTES) fail('Catalog cache too large');
      const bytes = Buffer.alloc(size + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > size) fail('Catalog cache too large');
      return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    } finally { await handle.close(); }
  }

  /** The downloaded ratings, else the bundled ones. */
  ratings(): RatingsSnapshot | null { return this.ratingsSnapshot ?? this.bundledSnapshot; }
  openRouter(): OpenRouterSnapshot | null { return this.openRouterSnapshot; }

  routing(): RoutingCatalog {
    const now = this.now();
    const ratings = this.ratings();
    const fresh = (at: number | null): boolean => at !== null && now - at >= 0 && now - at <= MAX_AGE_MS;
    return {
      asOf: now,
      benchmarks: (ratings?.benchmarks ?? []).map(row => ({ ...row, historical: !fresh(row.source.fetchedAt) })),
      models: ratings?.models ?? [],
      providers: ratings?.providers ?? [],
      pricesStale: !fresh(ratings?.modelsFetchedAt ?? null),
      openRouter: this.openRouterSnapshot,
      openRouterPricesStale: !fresh(this.openRouterSnapshot?.fetchedAt ?? null)
    };
  }

  status(): CatalogStatus {
    const now = this.now();
    const ratings = this.ratings();
    const stale = (at: number | null): boolean => at === null || now - at > MAX_AGE_MS || now < at;
    const benchmarkSource = (id: 'livebench' | 'artificial-analysis'): SourceStatus => {
      const rows = ratings?.benchmarks.filter(row => row.source.kind === id) ?? [];
      const first = rows[0];
      const fetchedAt = first ? Math.max(...rows.map(row => row.source.fetchedAt)) : null;
      return { id, fetchedAt, version: first ? first.source.indexVersion ?? first.source.releaseDate : null, rows: rows.length,
        measured: rows.filter(row => Object.values(row.categories).some(value => value !== null)).length, stale: stale(fetchedAt), error: ratings?.sourceErrors[id] ?? null };
    };
    return {
      now, autoRefresh: this.config.autoRefresh, refreshHours: this.config.refreshHours, refreshing: this.inflight !== null,
      bundled: !this.ratingsSnapshot && !!this.bundledSnapshot, lastError: this.lastError, lastAttemptAt: this.lastAttemptAt, nextRefreshAt: this.nextRefreshAt,
      sources: [
        { id: 'models.dev', fetchedAt: ratings?.modelsFetchedAt ?? null, version: null, rows: ratings?.models.length ?? 0, measured: 0, stale: stale(ratings?.modelsFetchedAt ?? null), error: ratings?.sourceErrors['models.dev'] ?? null },
        benchmarkSource('artificial-analysis'),
        benchmarkSource('livebench'),
        { id: 'openrouter', fetchedAt: this.openRouterSnapshot?.fetchedAt ?? null, version: null, rows: this.openRouterSnapshot?.models.length ?? 0, measured: 0, stale: stale(this.openRouterSnapshot?.fetchedAt ?? null), error: this.openRouterError }
      ]
    };
  }

  /**
   * Downloads what is due (`force`: everything). Ratings and the OpenRouter list fail separately; within the ratings
   * each source fails alone and keeps its previous rows with their original age.
   */
  refresh(options: { force?: boolean } = {}): Promise<void> {
    if (this.disposed) return Promise.reject(new CatalogError('Catalog stopped'));
    if (this.inflight) return this.inflight;
    this.clearTimer();
    const controller = new AbortController();
    this.controller = controller;
    this.lastAttemptAt = this.now();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    timeout.unref?.();
    const force = options.force === true;
    const run = (async () => {
      const due = this.due();
      const jobs: Array<Promise<void>> = [];
      if (force || due.ratings) jobs.push(this.updateRatings(controller.signal));
      if (this.config.openRouter && (force || due.openRouter)) jobs.push(this.updateOpenRouter(controller.signal));
      const results = await Promise.allSettled(jobs);
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) throw failure.reason;
    })().then(() => { this.failures = 0; this.lastError = null; }, error => {
      this.failures++;
      this.lastError = timedOut ? 'Catalog update timed out' : controller.signal.aborted ? 'Catalog update cancelled' : error instanceof CatalogError ? error.message : 'Catalog update failed';
      throw new CatalogError(this.lastError);
    }).finally(() => {
      clearTimeout(timeout); this.inflight = null; this.controller = null; this.version++; this.schedule(); this.notify();
    });
    this.inflight = run;
    this.notify();
    return run;
  }

  dispose(): void { this.disposed = true; this.controller?.abort(); this.clearTimer(); }

  private due(): { ratings: boolean; openRouter: boolean; at: number } {
    const now = this.now();
    const ratingsAt = (this.ratingsSnapshot?.fetchedAt ?? -Infinity) + this.config.refreshHours * 3_600_000;
    const openRouterAt = this.config.openRouter ? (this.openRouterSnapshot?.fetchedAt ?? -Infinity) + OPENROUTER_REFRESH_HOURS * 3_600_000 : Infinity;
    return { ratings: ratingsAt <= now, openRouter: openRouterAt <= now, at: Math.min(ratingsAt, openRouterAt) };
  }

  private notify(): void { try { this.onChange?.(); } catch { /* an observer cannot break a refresh */ } }
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; this.nextRefreshAt = null; }

  private schedule(): void {
    this.clearTimer();
    if (this.loadedAt === null || this.disposed || !this.config.autoRefresh || this.inflight) return;
    const now = this.now();
    const interval = this.config.refreshHours * 3_600_000;
    let at: number;
    if (this.failures) at = now + (this.failures <= 3 ? 60_000 * 2 ** (this.failures - 1) : interval);
    else at = Math.max(this.due().at, this.loadedAt + this.startDelayMs, now);
    if (!Number.isFinite(at)) return;
    this.nextRefreshAt = at;
    this.timer = setTimeout(() => { void this.refresh().catch(() => undefined); }, Math.min(at - now, 2 ** 31 - 1));
    this.timer.unref?.();
  }

  private check(signal: AbortSignal): void { if (signal.aborted || this.disposed) fail('Catalog update cancelled'); }

  private async updateRatings(signal: AbortSignal): Promise<void> {
    const fetchedAt = timestamp(this.now());
    const previous = this.ratings();
    const sourceSignal = (): { signal: AbortSignal; done(): void } => {
      const own = new AbortController();
      const timer = setTimeout(() => own.abort(), Math.min(20_000, this.timeoutMs));
      timer.unref?.();
      return { signal: AbortSignal.any([signal, own.signal]), done: () => clearTimeout(timer) };
    };
    const models = (async () => {
      const s = sourceSignal();
      try { return normalizeModels(JSON.parse(await this.download(MODELS_URL, MODEL_BYTES, s.signal))); } finally { s.done(); }
    })();
    const livebench = (async () => {
      const s = sourceSignal();
      try {
        const release = selectLiveBenchRelease(JSON.parse(await this.download(LIVEBENCH_INDEX_URL, OTHER_BYTES, s.signal)), fetchedAt);
        const urls = rawUrls(release);
        const [csv, categories] = await Promise.all([this.download(urls.table, OTHER_BYTES, s.signal), this.download(urls.categories, OTHER_BYTES, s.signal)]);
        const rows = normalizeBenchmarks(csv, JSON.parse(categories), release, fetchedAt);
        if (!rows.some(row => row.overall !== null)) fail('Empty benchmark scores');
        return rows;
      } finally { s.done(); }
    })();
    const artificialAnalysis = (async () => {
      const s = sourceSignal();
      try { return normalizeArtificialAnalysis(await this.download(ARTIFICIAL_ANALYSIS_URL, ARTIFICIAL_ANALYSIS_BYTES, s.signal), fetchedAt); } finally { s.done(); }
    })();
    const [m, lb, aa] = await Promise.allSettled([models, livebench, artificialAnalysis]);
    this.check(signal);
    if (m.status === 'rejected' && lb.status === 'rejected' && aa.status === 'rejected') {
      const reason = [m, lb, aa].map(result => (result as PromiseRejectedResult).reason).find(error => error instanceof CatalogError);
      fail(reason instanceof CatalogError ? reason.message : 'Catalog sources unavailable');
    }
    const sourceErrors: RatingsSnapshot['sourceErrors'] = {};
    const kept = (kind: 'livebench' | 'artificial-analysis'): CatalogBenchmark[] => previous?.benchmarks.filter(row => row.source.kind === kind) ?? [];
    if (m.status === 'rejected') sourceErrors['models.dev'] = 'models.dev unavailable; the earlier list keeps its age.';
    if (lb.status === 'rejected') sourceErrors.livebench = 'LiveBench unavailable; earlier scores keep their age.';
    if (aa.status === 'rejected') sourceErrors['artificial-analysis'] = 'Artificial Analysis unavailable; earlier scores keep their age.';
    // A refresh that returns far fewer rows than are known (Artificial Analysis's model page, since about 2026-10,
    // carries full rows only for the ~27 models of its default chart; the rest load in the browser) adds its rows and
    // keeps the earlier ones it lacks, with their original age: a known score is never dropped for a partial page.
    // (LiveBench publishes whole tables per release; a new release replaces the old one.)
    const mergedAA = (fresh: CatalogBenchmark[]): CatalogBenchmark[] => {
      const { rows, kept: keptRows } = mergePartialRefresh(fresh, kept('artificial-analysis'));
      if (keptRows) sourceErrors['artificial-analysis'] = `Artificial Analysis returned ${fresh.length} rows (${fresh.length + keptRows} known); the other ${keptRows} earlier scores are kept with their age.`;
      return rows;
    };
    const benchmarks = [...(aa.status === 'fulfilled' ? mergedAA(aa.value) : kept('artificial-analysis')), ...(lb.status === 'fulfilled' ? lb.value : kept('livebench'))];
    if (!benchmarks.length) fail('No benchmark scores');
    const snapshot: RatingsSnapshot = freeze({
      version: 2, fetchedAt,
      modelsFetchedAt: m.status === 'fulfilled' ? fetchedAt : previous?.modelsFetchedAt ?? null,
      models: m.status === 'fulfilled' ? m.value.models : previous?.models ?? [],
      providers: m.status === 'fulfilled' ? m.value.providers : previous?.providers ?? [],
      benchmarks, sourceErrors
    });
    await this.write(RATINGS_CACHE_FILE, snapshot, signal);
    this.ratingsSnapshot = snapshot;
  }

  private async updateOpenRouter(signal: AbortSignal): Promise<void> {
    try {
      const fetchedAt = timestamp(this.now());
      const snapshot: OpenRouterSnapshot = freeze({ version: 1, fetchedAt, models: normalizeOpenRouterModels(JSON.parse(await this.download(OPENROUTER_MODELS_URL, OPENROUTER_MODELS_BYTES, signal))) });
      this.check(signal);
      await this.write(OPENROUTER_CACHE_FILE, snapshot, signal);
      this.openRouterSnapshot = snapshot;
      this.openRouterError = null;
    } catch (error) {
      this.openRouterError = 'OpenRouter list unavailable; the earlier list keeps its age.';
      throw error instanceof CatalogError ? error : new CatalogError('OpenRouter list unavailable');
    }
  }

  private async write(name: string, value: unknown, signal: AbortSignal): Promise<void> {
    if (!this.directory) return;
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > CACHE_BYTES) fail('Catalog cache too large');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.${name}.${randomUUID()}.tmp`);
    try {
      this.check(signal);
      await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      this.check(signal);
      renameSync(temporary, join(this.directory, name));
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  private async download(url: string, max: number, signal: AbortSignal): Promise<string> {
    if (url !== MODELS_URL && url !== LIVEBENCH_INDEX_URL && url !== ARTIFICIAL_ANALYSIS_URL && url !== OPENROUTER_MODELS_URL && !LIVEBENCH_FILE.test(url)) fail('Catalog source not allowed');
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(new CatalogError('Catalog update cancelled')); signal.addEventListener('abort', onAbort, { once: true }); });
    aborted.catch(() => undefined);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (signal.aborted) fail('Catalog update cancelled');
      const response = await Promise.race([this.transport(url, { method: 'GET', signal, redirect: 'error', credentials: 'omit', headers: { accept: 'application/json, text/csv, text/plain, text/html' } }), aborted]);
      if (!response.ok) { void response.body?.cancel().catch(() => undefined); fail('Catalog source unavailable'); }
      const length = response.headers.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length) > max)) { void response.body?.cancel().catch(() => undefined); fail('Catalog response too large'); }
      if (!response.body) fail('Empty catalog response');
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const chunk = await Promise.race([reader.read(), aborted]);
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > max) fail('Catalog response too large');
        chunks.push(chunk.value);
      }
      if (!size) fail('Empty catalog response');
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
    } catch (error) {
      throw error instanceof CatalogError ? error : new CatalogError('Catalog source unavailable');
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (reader) void reader.cancel().catch(() => undefined);
    }
  }
}

