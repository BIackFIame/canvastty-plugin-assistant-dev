import type { RoutingCatalog } from './catalog/catalog.ts';
import type { ReasoningEffort } from './catalog/identity.ts';
import { offeredByDefault, type OpenRouterModel } from './catalog/openrouter.ts';
import { BenchmarkIndex, bareModelId, chooseCohort, TASK_TYPES, variantScores, type MatchContext, type MeasuredSpeed, type Score, type TaskType } from './catalog/scoring.ts';
import type { AutoModel, AutoRoutingSettings, AutoTier, AutoUpstream } from './settings.ts';
import { modelTrafficForbidden } from './jevOnlyRule.ts';

/**
 * Every model Auto could send a turn to, with what the catalog knows about it: price and context (the person's
 * figures, else OpenRouter's list, else models.dev for the upstream's own origin), and a score per task type taken
 * from one comparable cohort. Built from the settings and the catalog, cached until either changes. Pure: no I/O.
 *
 * Effort variants: a model the person gave an effort is one variant at that effort. An OpenRouter model that accepts
 * `reasoning` is offered as its default (no effort sent) plus one variant per effort that has its own measured row;
 * Auto then sends that effort. A score never moves between variants: the default variant has a score only when the
 * catalog has a row for exactly that (no effort) setup.
 */
export interface InventoryEntry {
  /** `<upstream>|<model id>|<effort or empty>`. */
  key: string;
  upstream: AutoUpstream;
  model: string;
  effort: ReasoningEffort | null;
  /** OpenRouter: Auto adds `reasoning: { effort }` when the CLI sent none. */
  sendEffort: boolean;
  /** The person's manual tier, if any: such a model is routed by tier, not by score. */
  tier: AutoTier | null;
  /** The person listed this model (on OpenRouter: as an override or an addition). */
  listed: boolean;
  /** OpenRouter's own list offers it (so dropping the person's override keeps the model). */
  fromList: boolean;
  excluded: boolean;
  priceIn: number | null;
  priceOut: number | null;
  priceSource: 'person' | 'openrouter' | 'models.dev' | null;
  context: number | null;
  output: number | null;
  /** The catalog knows this model (a benchmark row for its name, or its models.dev entry). */
  known: boolean;
  /** Efforts the catalog measured for this model's name (a hint for the page). */
  measuredEfforts: ReasoningEffort[];
  /** Scores in the decision's cohort for each task type (absent: unknown). */
  scores: Partial<Record<TaskType, Score>>;
  /** Measured speed of exactly this model and effort (Artificial Analysis), or null: unknown. */
  speed: MeasuredSpeed | null;
}

export interface Inventory {
  entries: InventoryEntry[];
  /** The cohort each task type compares in. */
  cohorts: Record<TaskType, string | null>;
  /** OpenRouter upstreams that want the list but have none yet. */
  waitingForList: string[];
}

export const MAX_INVENTORY = 4_000;
/** Efforts OpenRouter's `reasoning.effort` accepts. */
export const OPENROUTER_EFFORTS: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

export function blendedPrice(entry: Pick<InventoryEntry, 'priceIn' | 'priceOut'>): number | null {
  return entry.priceIn === null && entry.priceOut === null ? null : (entry.priceIn ?? 0) + (entry.priceOut ?? 0) * 3;
}

function originOf(baseUrl: string): string | null { try { return new URL(baseUrl).origin; } catch { return null; } }

export function buildInventory(settings: AutoRoutingSettings, catalog: RoutingCatalog, index: BenchmarkIndex = new BenchmarkIndex(catalog)): Inventory {
  const entries: InventoryEntry[] = [];
  const waitingForList: string[] = [];
  const openRouterList = catalog.openRouter?.models ?? null;
  const byId = new Map<string, OpenRouterModel>((openRouterList ?? []).map(model => [model.id, model]));
  const scoreMaps = new Map<InventoryEntry, Map<TaskType, Map<string, Score>>>();
  for (const upstream of settings.upstreams) {
    // OpenRouter carries only Jev's decisions: none of its models is ever a candidate (jevOnly.ts).
    if (upstream.preset === 'openrouter' || modelTrafficForbidden(upstream.baseUrl)) continue;
    const openRouter: boolean = false;
    const context: MatchContext = { openRouter, origin: openRouter ? null : originOf(upstream.baseUrl) };
    const listed = new Map(upstream.models.map(model => [model.id, model]));
    const ids: string[] = [...listed.keys()];
    if (openRouter && upstream.allModels) {
      if (!openRouterList) waitingForList.push(upstream.id);
      for (const model of openRouterList ?? []) if (!listed.has(model.id) && offeredByDefault(model)) ids.push(model.id);
    }
    const excluded = new Set(upstream.excluded);
    for (const id of ids) {
      const person: AutoModel | undefined = listed.get(id);
      const listing = openRouter ? byId.get(id) ?? null : null;
      const bare = bareModelId(id);
      const measuredEfforts = bare ? index.measuredEfforts(bare) : [];
      const catalogModel = index.catalogModel(id, context);
      const priced = person?.priceIn !== undefined || person?.priceOut !== undefined;
      const listPriceIn = listing && !catalog.openRouterPricesStale ? listing.priceIn : null;
      const listPriceOut = listing && !catalog.openRouterPricesStale ? listing.priceOut : null;
      const devPriceIn = catalogModel && !catalog.pricesStale ? catalogModel.inputPrice : null;
      const devPriceOut = catalogModel && !catalog.pricesStale ? catalogModel.outputPrice : null;
      const base = {
        upstream, model: id, tier: person?.tier ?? null, listed: !!person, excluded: excluded.has(id),
        fromList: openRouter && upstream.allModels && !!listing && offeredByDefault(listing),
        priceIn: priced ? person!.priceIn ?? null : listPriceIn ?? devPriceIn,
        priceOut: priced ? person!.priceOut ?? null : listPriceOut ?? devPriceOut,
        priceSource: (priced ? 'person' : listPriceIn !== null || listPriceOut !== null ? 'openrouter' : devPriceIn !== null || devPriceOut !== null ? 'models.dev' : null) as InventoryEntry['priceSource'],
        context: person?.context ?? listing?.context ?? catalogModel?.context ?? null,
        output: person?.output ?? listing?.maxOutput ?? catalogModel?.output ?? null,
        known: !!catalogModel || (bare ? index.rows(bare).length > 0 : false),
        measuredEfforts
      };
      const efforts: Array<{ effort: ReasoningEffort | null; send: boolean }> = [];
      if (person?.effort) efforts.push({ effort: person.effort, send: openRouter });
      else {
        efforts.push({ effort: null, send: false });
        // Effort variants only where Auto can actually set the effort, and not for a manually tiered model.
        if (openRouter && !person?.tier && (listing?.reasoning ?? false)) for (const effort of measuredEfforts) if (OPENROUTER_EFFORTS.includes(effort)) efforts.push({ effort, send: true });
      }
      for (const variant of efforts) {
        if (entries.length >= MAX_INVENTORY) break;
        const entry: InventoryEntry = { key: `${upstream.id}|${id}|${variant.effort ?? ''}`, ...base, effort: variant.effort, sendEffort: variant.send, scores: {}, speed: bare ? index.speed(bare, variant.effort, context) : null };
        entries.push(entry);
        const maps = new Map<TaskType, Map<string, Score>>();
        for (const type of TASK_TYPES) maps.set(type, variantScores(index, bare, variant.effort, context, type));
        scoreMaps.set(entry, maps);
      }
    }
  }
  // One cohort per task type, chosen over the models Auto would compare (enabled, not excluded, no manual tier).
  const cohorts = {} as Record<TaskType, string | null>;
  for (const type of TASK_TYPES) {
    const compared = entries.filter(entry => entry.upstream.enabled && !entry.excluded && entry.tier === null).map(entry => ({ model: `${entry.upstream.id}|${entry.model}`, scores: scoreMaps.get(entry)!.get(type)! }));
    const cohort = chooseCohort(compared);
    cohorts[type] = cohort;
    if (!cohort) continue;
    for (const entry of entries) {
      const score = scoreMaps.get(entry)!.get(type)!.get(cohort);
      if (score) entry.scores[type] = score;
    }
  }
  return { entries, cohorts, waitingForList };
}

/** The context and output the CLI is told: see `limitsFor` in launch.ts. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}
