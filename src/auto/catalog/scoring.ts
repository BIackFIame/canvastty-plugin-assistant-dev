import { normalizeModelIdentity, type ReasoningEffort } from './identity.ts';
import type { CatalogBenchmark, CatalogModel, RoutingCatalog } from './catalog.ts';

/**
 * Scores per task type, and matching an upstream's model id to catalog rows. Ported from the experimental catalog's
 * scoring with the same weights; "general" is now "chat".
 *
 * The weights are a routing policy, not a calibrated chance of success. A missing constituent score makes the whole
 * score unknown. LiveBench and Artificial Analysis points are on different scales: one decision compares models
 * inside one source and version only (the cohort), never across them.
 */
export type TaskType = 'coding' | 'review' | 'research' | 'writing' | 'chat';
export const TASK_TYPES: readonly TaskType[] = ['coding', 'review', 'research', 'writing', 'chat'];

export const LIVEBENCH_WEIGHTS: Readonly<Record<TaskType, Readonly<Record<string, number>>>> = {
  coding: { 'Agentic Coding': .6, Coding: .25, Reasoning: .15 },
  review: { Reasoning: .5, 'Agentic Coding': .3, Coding: .2 },
  research: { Reasoning: .5, 'Data Analysis': .3, Language: .2 },
  writing: { Language: .5, IF: .5 },
  chat: {} // the source's equally weighted category average
};
export const AA_WEIGHTS: Readonly<Record<TaskType, Readonly<Record<string, number>> | null>> = {
  coding: { 'Terminal-Bench 4.0': .75, SciCode: .25 },
  review: { 'Intelligence Index': .5, 'Terminal-Bench 4.0': .3, SciCode: .2 },
  research: { 'Intelligence Index': 1 },
  writing: null, // Artificial Analysis measures no writing
  chat: { 'Intelligence Index': 1 }
};

export function benchmarkScore(row: CatalogBenchmark, type: TaskType): number | null {
  const weights = row.source.kind === 'artificial-analysis' ? AA_WEIGHTS[type] : LIVEBENCH_WEIGHTS[type];
  if (!weights) return null;
  if (!Object.keys(weights).length) return row.overall;
  let total = 0;
  for (const [name, weight] of Object.entries(weights)) {
    const value = row.categories[name];
    if (value === null || value === undefined) return null;
    total += value * weight;
  }
  return Math.round(total * 10_000) / 10_000;
}

/** One comparable scale: the source, its version (and the download, for Artificial Analysis), and the task type. */
export function cohortOf(row: CatalogBenchmark, type: TaskType): string {
  return row.source.kind === 'artificial-analysis' ? `artificial-analysis:${row.source.indexVersion}:${row.source.fetchedAt}:${type}` : `livebench:${row.source.releaseDate}:${type}`;
}
export function sourceLabel(row: CatalogBenchmark): string {
  return row.source.kind === 'artificial-analysis' ? `Artificial Analysis v${row.source.indexVersion}` : `LiveBench ${row.source.releaseDate}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------------------------

/** OpenRouter routing suffixes that pick a provider or a price, not another model. Others (`:thinking`, `:online`) stay. */
const SAME_MODEL_SUFFIX = /:(?:free|nitro|floor|beta)$/u;

/**
 * The bare model name an upstream id stands for: OpenRouter's `vendor/model` loses the vendor and a routing suffix;
 * a person's `org/model` loses the org. Nothing else is removed: no dates, versions or size suffixes, so
 * `claude-opus-4-5` never matches `claude-opus-4-5-20251101`, and `glm-5.3` never matches `glm-5.3-flash`. A `~`
 * alias (`~vendor/model-latest`) moves between models, so it never matches.
 */
export function bareModelId(upstreamModelId: string): string | null {
  if (!upstreamModelId || upstreamModelId.startsWith('~')) return null;
  const name = upstreamModelId.replace(SAME_MODEL_SUFFIX, '').split('/').at(-1) ?? '';
  return name ? name : null;
}

export interface MatchContext {
  /** The upstream is OpenRouter (a reseller: no vendor's documented default effort applies). */
  openRouter: boolean;
  /** An OpenAI-compatible upstream's origin (to apply a vendor's documented default effort, and to find its prices). */
  origin: string | null;
}

/**
 * Documented defaults: the vendor's own documentation says which effort a model runs at when none is sent. Only for
 * the vendor's own API (a reseller may configure it differently), and only when Auto sends no effort itself.
 *   https://docs.z.ai/guides/llm/glm-5.3 · https://huggingface.co/zai-org/GLM-5.3-Flash/blob/main/README.md
 */
const DOCUMENTED_DEFAULTS: ReadonlyArray<{ origins: readonly string[]; models: readonly string[]; effort: ReasoningEffort }> = [
  { origins: ['https://api.z.ai', 'https://open.bigmodel.cn'], models: ['glm-5-3', 'glm-5-3-flash'], effort: 'max' }
];

export function effectiveEffort(bare: string, effort: ReasoningEffort | null, context: MatchContext): { effort: ReasoningEffort | null; documentedDefault: boolean } {
  if (effort) return { effort, documentedDefault: false };
  if (!context.openRouter && context.origin) {
    const id = normalizeModelIdentity(bare);
    const rule = DOCUMENTED_DEFAULTS.find(entry => entry.origins.includes(context.origin!) && entry.models.includes(id));
    if (rule) return { effort: rule.effort, documentedDefault: true };
  }
  return { effort: null, documentedDefault: false };
}

/** Benchmark rows indexed by normalized model id (built once per catalog version). */
export class BenchmarkIndex {
  private readonly byModel = new Map<string, Array<CatalogBenchmark & { historical: boolean }>>();
  readonly catalog: RoutingCatalog;
  constructor(catalog: RoutingCatalog) {
    this.catalog = catalog;
    for (const row of catalog.benchmarks) {
      const key = normalizeModelIdentity(row.modelId);
      const list = this.byModel.get(key) ?? [];
      list.push(row);
      this.byModel.set(key, list);
    }
  }
  rows(bare: string): ReadonlyArray<CatalogBenchmark & { historical: boolean }> { return this.byModel.get(normalizeModelIdentity(bare)) ?? []; }

  /** Efforts with a measured row of their own (no thinking setup): the variants Auto can choose between. */
  measuredEfforts(bare: string): ReasoningEffort[] {
    const efforts = new Set<ReasoningEffort>();
    for (const row of this.rows(bare)) if (row.thinking === null && row.reasoningEffort && Object.values(row.categories).some(value => value !== null)) efforts.add(row.reasoningEffort);
    return [...efforts];
  }

  /**
   * The rows for exactly this model and effort, one per cohort. Two matching rows in one cohort are ambiguous: that
   * cohort gives no score. A row with a thinking setup never matches.
   */
  exact(bare: string, effort: ReasoningEffort | null): Map<string, CatalogBenchmark & { historical: boolean }> {
    const byCohort = new Map<string, Array<CatalogBenchmark & { historical: boolean }>>();
    for (const row of this.rows(bare)) {
      if (row.thinking !== null || row.reasoningEffort !== effort) continue;
      const cohort = cohortOf(row, 'chat');
      byCohort.set(cohort, [...byCohort.get(cohort) ?? [], row]);
    }
    const result = new Map<string, CatalogBenchmark & { historical: boolean }>();
    for (const [cohort, rows] of byCohort) if (rows.length === 1) result.set(cohort.replace(/:chat$/u, ''), rows[0]!);
    return result;
  }

  /**
   * The measured speed of exactly this model and effort (the same exact-row rule as scores: a speed never moves to
   * another effort or version): the newest Artificial Analysis row for it that states one. Null: unknown.
   */
  speed(bare: string, effort: ReasoningEffort | null, context: MatchContext): MeasuredSpeed | null {
    const resolved = effectiveEffort(bare, effort, context);
    let found: MeasuredSpeed | null = null;
    for (const row of this.rows(bare)) {
      if (row.thinking !== null || row.reasoningEffort !== resolved.effort || !row.speed) continue;
      if (!found || row.source.fetchedAt > found.fetchedAt) found = { ...row.speed, fetchedAt: row.source.fetchedAt, effort: resolved.effort, label: sourceLabel(row) };
    }
    return found;
  }

  /** models.dev's entry for an OpenAI-compatible upstream: the provider whose stated API origin is the upstream's. */
  catalogModel(upstreamModelId: string, context: MatchContext): CatalogModel | null {
    if (context.openRouter || !context.origin) return null;
    const providers = new Set(this.catalog.providers.filter(provider => provider.origin === context.origin).map(provider => provider.id));
    if (!providers.size) return null;
    const lower = upstreamModelId.toLowerCase();
    const found = this.catalog.models.filter(model => providers.has(model.providerId) && model.modelId.toLowerCase() === lower);
    return found.length === 1 ? found[0]! : null;
  }
}

/** A row's stated speed, with the effort and source it belongs to. */
export interface MeasuredSpeed { outputTps: number; latencyS: number | null; fetchedAt: number; effort: ReasoningEffort | null; label: string }

/**
 * Seconds one model call takes: time to its first chunk plus its output at the measured speed (latency counts only
 * when known). Null when the speed is unknown: callers treat that as neutral, never as fast or slow.
 */
export function callSeconds(speed: Pick<MeasuredSpeed, 'outputTps' | 'latencyS'> | null, outputTokens: number, withLatency = true): number | null {
  if (!speed) return null;
  return (withLatency ? speed.latencyS ?? 0 : 0) + outputTokens / speed.outputTps;
}

export interface Score {
  value: number;
  cohort: string;
  label: string;
  rowId: string;
  /** Downloaded more than seven days ago: still a measurement, shown as old. */
  historical: boolean;
  /** The effort the row was measured at. */
  effort: ReasoningEffort | null;
  documentedDefault: boolean;
}

/** Every cohort's score for one model variant and task type (cohort id without the type suffix → score). */
export function variantScores(index: BenchmarkIndex, bare: string | null, effort: ReasoningEffort | null, context: MatchContext, type: TaskType): Map<string, Score> {
  const scores = new Map<string, Score>();
  if (!bare) return scores;
  const resolved = effectiveEffort(bare, effort, context);
  for (const [cohort, row] of index.exact(bare, resolved.effort)) {
    const value = benchmarkScore(row, type);
    if (value === null) continue;
    scores.set(cohort, { value, cohort, label: sourceLabel(row), rowId: row.id, historical: row.historical, effort: resolved.effort, documentedDefault: resolved.documentedDefault });
  }
  return scores;
}

/**
 * The one cohort a decision compares in: the one that scores the most distinct models among those offered, then the
 * most variants, then fresh over historical, then Artificial Analysis (its rows name their efforts), then by name.
 */
export function chooseCohort(entries: ReadonlyArray<{ model: string; scores: ReadonlyMap<string, Score> }>): string | null {
  const groups = new Map<string, { models: Set<string>; variants: number; historical: boolean }>();
  for (const entry of entries) for (const [cohort, score] of entry.scores) {
    const group = groups.get(cohort) ?? { models: new Set<string>(), variants: 0, historical: false };
    group.models.add(entry.model); group.variants++; group.historical ||= score.historical;
    groups.set(cohort, group);
  }
  const ranked = [...groups].sort(([a, x], [b, y]) => y.models.size - x.models.size || y.variants - x.variants || Number(x.historical) - Number(y.historical)
    || Number(b.startsWith('artificial-analysis:')) - Number(a.startsWith('artificial-analysis:')) || a.localeCompare(b));
  return ranked[0]?.[0] ?? null;
}
