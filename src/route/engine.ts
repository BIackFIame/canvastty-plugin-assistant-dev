/**
 * Agent-level routing (route v2): which CLI, sign-in, model and effort a subagent should start with. One candidate
 * model for every kind of capacity: a subscription on its CLI's own sign-in, a coding plan reached through OpenCode,
 * a model account of the Accounts plugin, Model: Auto (Jev), or a CLI's own default. Pure: no I/O; the service
 * gathers the inputs (what the orchestrator passed, the person's declarations, the limit windows the settings page
 * forwarded, outcomes) and records the decision.
 *
 * 1. Candidates: one per (CLI, sign-in, model, effort). Quality belongs to the model identity and effort, never to
 *    the route: the Auto catalog's score for the task type, in one cohort per decision.
 * 2. Filters: facts first (the CLI is there and takes subagents, the sign-in is ready, gates), then the person's
 *    rules (Never, trust under the data-class mode), then capacity (headroom, parallel children, cooldowns).
 * 3. Tunnels: routes to the same identity and effort are one model. The model is chosen by score within the
 *    preference's quality window, cost in comparable units, and "prefer subscriptions"; then its route by
 *    availability, trust, cost, the person's preference; a route with clearly worse outcomes goes last.
 * 4. Unknown scores never compete with known ones. A specific model without a score is not used unless the person
 *    pins or boosts it, an exploration share picks it, or the orchestrator names it; a CLI's own default is the
 *    last fallback.
 */
import { BenchmarkIndex, bareModelId, chooseCohort, variantScores, type MatchContext, type Score, type TaskType } from '../auto/catalog/scoring.ts';
import type { RoutingCatalog } from '../auto/catalog/catalog.ts';
import { normalizeModelIdentity, type ReasoningEffort } from '../auto/catalog/identity.ts';
import { QUALITY_WINDOW, tierFor, type Level, type TurnView } from '../auto/select.ts';
import type { AutoPreference, AutoTier } from '../auto/settings.ts';
import { classRank, type DataClass, type DataClassMode } from '../shared/settings.ts';
import { resolveModel, type Resolved } from './aliases.ts';
import { modelTrafficForbidden } from '../auto/jevOnlyRule.ts';
import { quotaOf, shadowPrice, type LimitsCache, type MeasuredSpend, type ShadowPrice, type SubscriptionQuota } from './limits.ts';
import type { PoolRoute } from './peers.ts';
import { DEFAULT_MAX_PARALLEL, DEFAULT_RESERVE, SPEED_WEIGHT, trustRank, type PlanDecl, type RouteAllow, type RouteSettings, type TrustLevel } from './settings.ts';

export const ASSISTANT_ID = 'canvastty-assistant';
export const ACCOUNTS_ID = 'canvastty-accounts';

/** CLIs that get CanvasTTY's agent tools themselves when started as an orchestrator. */
const ORCHESTRATOR_CLIS = new Set(['codex', 'claude', 'qwen', 'kimi', 'opencode', 'hermes']);
/** spawn_agent.effort per CLI (CanvasTTY's PROVIDER_REASONING_EFFORTS); used when list_providers gave none. */
const CLI_EFFORTS: Readonly<Record<string, readonly string[]>> = { codex: ['minimal', 'low', 'medium', 'high', 'xhigh'], claude: ['low', 'medium', 'high', 'xhigh', 'max'], grok: ['low', 'medium', 'high', 'xhigh'] };
/** CLIs whose launch takes `--model`. */
const MODEL_CLIS = new Set(['codex', 'claude', 'qwen', 'kimi', 'opencode', 'grok', 'omp', 'pi', 'cursor']);
/** Plugins known to set a launch's model: a spawn always names them, so nothing is inherited by accident (CanvasTTY 1.8.2). */
export const MODEL_SETTING_PLUGINS = [ASSISTANT_ID, ACCOUNTS_ID] as const;

/** Tokens one task of each level takes (whole subagent run, all calls), from the live runs; shown as a range. */
export const TASK_TOKENS: Readonly<Record<Level, { input: number; output: number }>> = { small: { input: 60_000, output: 5_000 }, medium: { input: 250_000, output: 15_000 }, large: { input: 600_000, output: 40_000 } };
const RANGE = [0.5, 2] as const;
export const PROVISIONAL_PENALTY = 5;
export const MIN_ANCHORS = 8;
export const DEMOTE_MIN = 10;
const EFFORT_RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

// ---------------------------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------------------------

/** One list_providers entry, as much as routing reads. */
export interface ProviderInfo {
  id: string;
  installed?: boolean | null;
  available?: boolean;
  signIn?: string;
  signInCheckedAt?: number;
  subagent?: boolean;
  orchestrator?: boolean;
  model?: { supported?: boolean; known?: string[] };
  efforts?: string[];
  /** Plugins whose launch options apply to this CLI (list_providers' launchOptions). */
  launchPlugins?: string[];
}

/** One `canvastty-accounts__list_routes` row, as much as routing keeps. */
export interface AccountRow {
  provider: string;
  accountId: string;
  account?: string;
  model: string;
  endpoint: string;
  state: string;
  reason?: string;
  launchOptions?: Record<string, Record<string, string | boolean>>;
  /** The account's plan quota as Accounts read it (unknown and stale are never used up). */
  quota?: { state: 'ok' | 'low' | 'exhausted' | 'presumed-reset' | 'unknown' | 'stale'; remainingPercent: number | null; resetsAt: number | null; observedAt: number | null; source: string | null; confidence: 'exact' | 'estimated' | 'none'; note: string };
}

/** What Model: Auto (Jev) would pick for this task (its request router still decides per turn). */
export interface AutoExpectation {
  model: string;
  identity: string | null;
  effort: ReasoningEffort | null;
  priceIn: number | null;
  priceOut: number | null;
  /** An enabled upstream is trusted with the card's class (Auto's own rule). */
  trusted: boolean;
}

export interface RouteStats { n: number; fail: number }

export interface RouteContext {
  view: TurnView;
  preference: AutoPreference;
  settings: RouteSettings;
  providers: ProviderInfo[];
  /** The orchestrator passed list_providers: a CLI missing from it is not there. */
  providersGiven: boolean;
  accountRows: AccountRow[];
  callerProvider: string | null;
  cardClass: DataClass;
  mode: DataClassMode;
  limits: LimitsCache | null;
  catalog: RoutingCatalog;
  index: BenchmarkIndex;
  auto: AutoExpectation | null;
  now: number;
  /** Routed children running now per sign-in key. */
  busy(signIn: string): number;
  /** Routed launches on a coding plan in the last `windowMs`. */
  launches(planId: string, windowMs: number): number;
  cooldown(signIn: string): { until: number; reason: string } | null;
  /** Routed launches on a CLI's own sign-in since its limits were read (own usage accounting between reads). */
  launchesSinceRead?(cli: string): number;
  /**
   * Measured use of a CLI's own sign-in by this plugin's cards since its limits were read (CanvasTTY's usage.summary),
   * as a share of the window; when given it replaces the per-launch estimate.
   */
  spentSinceRead?(cli: string): MeasuredSpend | null;
  /** Accounts' pools of the person's own sign-ins (`pool:<agent>`), read through plugins.request. */
  pools?: readonly PoolRoute[];
  /** Outcomes per route key. */
  stats: ReadonlyMap<string, RouteStats>;
  /** Learned tokens per task of a model, as a factor of TASK_TOKENS (null: not enough outcomes with tokens). */
  tokenFactor?(identity: string): number | null;
  /** The orchestrator's explicit choice: a CLI, a model, a plan or account id. */
  prefer: string | null;
  /** The child must orchestrate (needs CanvasTTY's agent tools). */
  orchestrate: boolean;
  /** Exploration: a roll in [0, 1), identities retired by their outcomes, and whether the task is high-risk. */
  explore: { roll: number; retired: ReadonlySet<string>; highRisk: boolean };
}

// ---------------------------------------------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------------------------------------------

export type RouteKind = 'subscription' | 'coding-plan' | 'account' | 'auto' | 'cli-default';
export type AvailabilityState = 'ready' | 'unknown' | 'presumed-reset' | 'cooldown' | 'exhausted' | 'signed_out' | 'not_installed' | 'busy' | 'unusable';

export interface Spawn {
  provider: string;
  model?: string;
  effort?: string;
  launchOptions: Record<string, Record<string, string | boolean>>;
  /** A plugin environment (one of the person's servers) as list_providers lists it; absent: this computer. */
  environment?: { pluginId: string; kind: string; options: Record<string, string | boolean> };
}

export interface CandidateScore {
  value: number;
  /** Before the boost and the provisional penalty. */
  raw: number;
  label: string;
  source: 'measured' | 'provisional';
  historical: boolean;
  /** For a provisional score: the mapping it came through. */
  mapped?: { from: string; anchors: number; r2: number };
}

export type Estimate =
  | { kind: 'usd'; low: number; high: number }
  | { kind: 'window'; share: number; window: string | null; usedPercent: number | null }
  | { kind: 'launches'; used: number; allowance: number; windowHours: number }
  | { kind: 'flat' }
  | { kind: 'unknown'; note: string };

export interface Candidate {
  key: string;
  cli: string;
  kind: RouteKind;
  /** The plan, account or upstream group it uses (for busy, cooldowns and outcomes). */
  signIn: string;
  label: string;
  planId?: string;
  accountId?: string;
  endpoint?: string;
  model: string | null;
  identity: string | null;
  resolvedFrom: Resolved['from'] | 'auto' | 'account';
  effort: string | null;
  /** Its overall ("chat") score in the decision's chat cohort, for "good enough" on small tasks; null: none. */
  overall: number | null;
  /** Chosen because a plan is good enough for a small task: the window it was within. */
  planPreferred: number | null;
  /** The effort its score describes (a vendor's documented default when none is sent): tunnels group on it. */
  scoredEffort: string | null;
  score: CandidateScore | null;
  pin: AutoTier | null;
  boost: number;
  /** USD-comparable cost of the task (subscriptions: scarcity price), or null when unknown. */
  cost: number | null;
  costBasis: 'api' | 'local' | ShadowPrice['basis'] | 'plan' | 'flat' | 'unpriced';
  estimate: Estimate;
  quota: SubscriptionQuota | null;
  availability: { state: AvailabilityState; reason: string };
  trust: { level: TrustLevel | 'auto'; warn: boolean };
  allow: RouteAllow;
  demoted: string | null;
  /**
   * On a plan (a subscription, a coding plan, a flat-rate account): what one task takes of the plan against the
   * plan's top model — its quota share (expected tokens × quota weight) and, when speeds are known, its time —
   * folded into `cost` (lower is better) with the person's "value speed". Null off a plan.
   */
  planCost: { cost: number; quota: number; time: number | null; faster: number | null; speedFrom: 'person' | 'measured' | 'mixed' | null; against: string | null; tokens: number } | null;
  spawn: Spawn;
  /** Specific model without a score of its own (unscored or provisional). */
  newModel: boolean;
}

const lower = (value: string): string => value.toLowerCase();
const isLocalHost = (endpoint: string): boolean => /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/iu.test(endpoint);

function effortsOf(cli: string, entry: ProviderInfo | undefined): readonly string[] {
  return entry?.efforts?.length ? entry.efforts : CLI_EFFORTS[cli] ?? [];
}

/** The catalog efforts measured for an identity that this CLI takes, plus its default (null). */
function effortVariants(index: BenchmarkIndex, identity: string | null, takes: readonly string[]): Array<string | null> {
  if (!identity || !takes.length) return [null];
  const measured = index.measuredEfforts(identity).filter(effort => takes.includes(effort));
  return [null, ...measured.sort((a, b) => EFFORT_RANK.indexOf(a) - EFFORT_RANK.indexOf(b))];
}

/** Every plugin that sets a model, named explicitly, so a subagent never inherits one by accident. */
export function launchOptionsFor(cli: string, plugins: ReadonlySet<string>, route: { kind: RouteKind; account?: Record<string, string | boolean> | null }): Record<string, Record<string, string | boolean>> {
  const options: Record<string, Record<string, string | boolean>> = {};
  // An account or a pool names its own value; otherwise Accounts is named with the agent's own sign-in.
  if (plugins.has(ACCOUNTS_ID) || route.account) options[ACCOUNTS_ID] = route.account ? { ...route.account } : { account: 'none' };
  if (plugins.has(ASSISTANT_ID) || route.kind === 'auto') options[ASSISTANT_ID] = { model: route.kind === 'auto' ? 'auto' : 'off' };
  void cli;
  return options;
}

/** Which model-setting plugins apply to a CLI: what list_providers said, else what is known without it. */
function pluginsFor(cli: string, ctx: RouteContext): Set<string> {
  const entry = ctx.providers.find(provider => provider.id === cli);
  if (entry?.launchPlugins) return new Set(entry.launchPlugins.filter(id => (MODEL_SETTING_PLUGINS as readonly string[]).includes(id)));
  // Not said: this service is running, so its launch options exist; Accounts' only when its rows name this CLI.
  const set = new Set<string>([ASSISTANT_ID]);
  if (ctx.accountRows.some(row => row.provider === cli)) set.add(ACCOUNTS_ID);
  return set;
}

export function apiPrice(catalog: RoutingCatalog, identity: string | null): { priceIn: number | null; priceOut: number | null } | null {
  if (!identity) return null;
  const blend = (i: number | null, o: number | null): number => (i ?? 0) + (o ?? 0) * 3;
  let best: { priceIn: number | null; priceOut: number | null } | null = null;
  if (catalog.openRouter && !catalog.openRouterPricesStale) {
    for (const model of catalog.openRouter.models) {
      const bare = bareModelId(model.id);
      if (!bare || normalizeModelIdentity(bare) !== identity || (model.priceIn === null && model.priceOut === null) || model.id.endsWith(':free')) continue;
      if (!best || blend(model.priceIn, model.priceOut) < blend(best.priceIn, best.priceOut)) best = { priceIn: model.priceIn, priceOut: model.priceOut };
    }
  }
  if (best || catalog.pricesStale) return best;
  for (const model of catalog.models) {
    if (normalizeModelIdentity(model.modelId) !== identity || (model.inputPrice === null && model.outputPrice === null)) continue;
    if (!best || blend(model.inputPrice, model.outputPrice) < blend(best.priceIn, best.priceOut)) best = { priceIn: model.inputPrice, priceOut: model.outputPrice };
  }
  return best;
}

export function taskUsd(level: Level, price: { priceIn: number | null; priceOut: number | null } | null): number | null {
  if (!price || (price.priceIn === null && price.priceOut === null)) return null;
  const tokens = TASK_TOKENS[level];
  return Math.round(((tokens.input * (price.priceIn ?? 0) + tokens.output * (price.priceOut ?? 0)) / 1_000_000) * 100_000) / 100_000;
}
const usdEstimate = (usd: number): Estimate => ({ kind: 'usd', low: Math.round(usd * RANGE[0] * 10_000) / 10_000, high: Math.round(usd * RANGE[1] * 10_000) / 10_000 });

interface Raw {
  cli: string; kind: RouteKind; signIn: string; label: string; planId?: string; accountId?: string; endpoint?: string;
  model: string | null; resolved: { identity: string | null; from: Candidate['resolvedFrom'] }; effort: string | null;
  context: MatchContext; plan?: PlanDecl; row?: AccountRow; pool?: PoolRoute; trust: TrustLevel | 'auto'; allow: RouteAllow;
  /** Effort goes to Accounts' launch option, not to spawn_agent.effort. */
  effortVia: 'spawn' | 'accounts' | 'none';
}

const OPENROUTER_CONTEXT: MatchContext = { openRouter: true, origin: null };
/** OpenCode providers whose API is a vendor's own (so its documented default effort applies to a model without one). */
const OPENCODE_ORIGINS: Readonly<Record<string, string>> = { 'zai-coding-plan': 'https://api.z.ai', zai: 'https://api.z.ai', 'zhipuai-coding-plan': 'https://open.bigmodel.cn', zhipuai: 'https://open.bigmodel.cn' };
const openCodeContext = (model: string | null): MatchContext => {
  const origin = model && model.includes('/') ? OPENCODE_ORIGINS[model.split('/')[0]!] : undefined;
  return origin ? { openRouter: false, origin } : OPENROUTER_CONTEXT;
};

/** OpenCode `provider/model` ids a declared pattern allows (exact ids, or `provider/*`). */
function openCodeModels(patterns: readonly string[], known: readonly string[]): string[] {
  const out = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) { const prefix = pattern.slice(0, -1); for (const id of known) if (id.startsWith(prefix) && id.length > prefix.length) out.add(id); }
    else if (pattern.includes('/') && (!known.length || known.includes(pattern))) out.add(pattern);
  }
  return [...out].slice(0, 32);
}

function rawCandidates(ctx: RouteContext): Raw[] {
  const raws: Raw[] = [];
  const known = (identity: string): boolean => ctx.index.rows(identity).length > 0;
  const declared = new Set<string>();
  const resolve = (cli: string, model: string): Raw['resolved'] => { const r = resolveModel(cli, model, ctx.settings.aliases, known); return { identity: r.identity, from: r.from }; };
  for (const plan of ctx.settings.plans) {
    declared.add(plan.cli);
    const entry = ctx.providers.find(provider => provider.id === plan.cli);
    const base = { cli: plan.cli, kind: plan.kind, signIn: `plan:${plan.id}`, label: plan.label, planId: plan.id, plan, trust: plan.trust, allow: plan.allow, context: OPENROUTER_CONTEXT } as const;
    let models: Array<string | null>;
    if (plan.cli === 'opencode') models = openCodeModels(plan.models, entry?.model?.known ?? []);
    else models = plan.models.length ? plan.models : [null];
    if (!MODEL_CLIS.has(plan.cli)) models = [null];
    for (const model of models) {
      const resolved = model ? resolve(plan.cli, model) : { identity: null, from: 'none' as const };
      const takes = effortsOf(plan.cli, entry);
      for (const effort of effortVariants(ctx.index, resolved.identity, takes)) {
        raws.push({ ...base, model, resolved, effort, effortVia: takes.length ? 'spawn' : 'none', ...(plan.cli === 'opencode' ? { context: openCodeContext(model) } : {}) });
      }
    }
  }
  for (const row of ctx.accountRows) {
    const host = row.endpoint;
    const resolved = resolve(row.provider, row.model);
    const takes = CLI_EFFORTS[row.provider] ?? [];
    const rowEffort = typeof row.launchOptions?.[ACCOUNTS_ID]?.effort === 'string' && row.launchOptions[ACCOUNTS_ID]!.effort !== 'default' ? row.launchOptions[ACCOUNTS_ID]!.effort as string : null;
    const efforts = rowEffort ? [rowEffort] : effortVariants(ctx.index, resolved.identity, takes);
    for (const effort of efforts) {
      raws.push({
        cli: row.provider, kind: 'account', signIn: `account:${row.accountId}`, label: `${row.account ?? row.accountId} · ${host}`, accountId: row.accountId, endpoint: host,
        model: row.model, resolved: { identity: resolved.identity, from: resolved.from === 'none' ? 'none' : 'account' }, effort, row,
        context: { openRouter: false, origin: `https://${host}` },
        trust: ctx.settings.trust[`host:${host}`] ?? (isLocalHost(host) ? 'D3' : 'unset'), allow: ctx.settings.allow[`host:${host}`] ?? 'allow',
        effortVia: takes.length ? 'accounts' : 'none'
      });
    }
  }
  // Accounts' pools: the person's own sign-ins of a CLI, Accounts picks the member with the most room at launch. The
  // models are the CLI's own: a declared subscription plan of that CLI names them, else its default model.
  for (const pool of ctx.pools ?? []) {
    const entry = ctx.providers.find(provider => provider.id === pool.cli);
    const plan = ctx.settings.plans.find(p => p.cli === pool.cli && p.kind === 'subscription');
    const models: Array<string | null> = plan && MODEL_CLIS.has(pool.cli) && plan.models.length && pool.cli !== 'opencode' ? plan.models : [null];
    const takes = effortsOf(pool.cli, entry);
    for (const model of models) {
      const resolved = model ? resolve(pool.cli, model) : { identity: null, from: 'none' as const };
      for (const effort of effortVariants(ctx.index, resolved.identity, takes)) {
        raws.push({
          cli: pool.cli, kind: 'subscription', signIn: `pool:${pool.cli}`, label: `${pool.label} (${pool.ready}/${pool.members} free)`, model, resolved, effort, pool,
          context: OPENROUTER_CONTEXT, trust: (pool.trust === 'unset' ? 'unset' : pool.trust) as TrustLevel, allow: ctx.settings.allow[`pool:${pool.cli}`] ?? 'allow',
          effortVia: takes.length ? 'spawn' : 'none'
        });
      }
    }
  }
  if (ctx.auto) {
    raws.push({
      cli: 'opencode', kind: 'auto', signIn: 'auto', label: 'Model: Auto (Jev)', model: null, resolved: { identity: ctx.auto.identity, from: 'auto' }, effort: ctx.auto.effort,
      context: OPENROUTER_CONTEXT, trust: 'auto', allow: ctx.settings.allow.auto ?? 'allow', effortVia: 'none'
    });
  }
  // A CLI not declared as a plan: its own default model on its own sign-in, the last fallback.
  const listed = ctx.providersGiven ? ctx.providers.map(provider => provider.id) : ctx.callerProvider ? [ctx.callerProvider] : [];
  for (const cli of listed) {
    // OpenCode's own default is a third-party service (OpenCode Zen): only what the person declared runs there.
    if (declared.has(cli) || cli === 'opencode') continue;
    raws.push({ cli, kind: 'cli-default', signIn: `cli:${cli}`, label: 'its own sign-in', model: null, resolved: { identity: null, from: 'none' }, effort: null, context: OPENROUTER_CONTEXT,
      trust: 'unset', allow: ctx.settings.allow[`cli:${cli}`] ?? 'allow', effortVia: 'none' });
  }
  return raws;
}

// ---------------------------------------------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------------------------------------------

type ScoreMaps = Map<string, Map<TaskType, Map<string, Score>>>;
const variantKey = (identity: string, effort: string | null, context: MatchContext): string => `${identity}|${effort ?? ''}|${context.origin ?? ''}`;

function scoreMaps(raws: Raw[], index: BenchmarkIndex, types: readonly TaskType[]): ScoreMaps {
  const maps: ScoreMaps = new Map();
  for (const raw of raws) {
    if (!raw.resolved.identity) continue;
    const key = variantKey(raw.resolved.identity, raw.effort, raw.context);
    if (maps.has(key)) continue;
    const byType = new Map<TaskType, Map<string, Score>>();
    for (const type of types) byType.set(type, variantScores(index, raw.resolved.identity, raw.effort as ReasoningEffort | null, raw.context, type));
    maps.set(key, byType);
  }
  return maps;
}

/** A least-squares line from one cohort to another over anchor models measured in both (null: too few, or flat). */
export function anchorFit(index: BenchmarkIndex, type: TaskType, from: string, to: string): { a: number; b: number; r2: number; anchors: number } | null {
  const seen = new Set<string>();
  const pairs: Array<[number, number]> = [];
  for (const row of index.catalog.benchmarks) {
    if (row.thinking !== null) continue;
    const id = normalizeModelIdentity(row.modelId);
    const key = `${id}|${row.reasoningEffort ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const scores = variantScores(index, id, row.reasoningEffort, OPENROUTER_CONTEXT, type);
    const x = scores.get(from)?.value, y = scores.get(to)?.value;
    if (x !== undefined && y !== undefined) pairs.push([x, y]);
  }
  if (pairs.length < MIN_ANCHORS) return null;
  const n = pairs.length;
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n, my = pairs.reduce((s, [, y]) => s + y, 0) / n;
  const sxx = pairs.reduce((s, [x]) => s + (x - mx) ** 2, 0), sxy = pairs.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0), syy = pairs.reduce((s, [, y]) => s + (y - my) ** 2, 0);
  if (sxx === 0 || syy === 0) return null;
  const a = sxy / sxx, b = my - a * mx;
  const r2 = (sxy * sxy) / (sxx * syy);
  return { a, b, r2: Math.round(r2 * 1_000) / 1_000, anchors: n };
}

// ---------------------------------------------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------------------------------------------

export interface Dropped { key: string; cli: string; label: string; model: string | null; reason: string }

export interface RouteDecision {
  view: TurnView;
  strategy: 'single-cheap' | 'single-strong';
  /** The task type whose scores were compared (the task's, or chat when nothing had one for it). */
  scoredAs: TaskType | null;
  cohort: string | null;
  best: number | null;
  window: number;
  /** Usable candidates, best first, grouped by model (tunnels): each group's routes in route order. */
  groups: Candidate[][];
  top: Candidate | null;
  alternatives: Candidate[];
  dropped: Dropped[];
  explored: boolean;
  preferred: boolean;
}

function trustOf(level: TrustLevel | 'auto', ctx: RouteContext, autoTrusted: boolean): { ok: boolean; warn: boolean } {
  if (ctx.mode === 'off') return { ok: true, warn: false };
  if (level === 'auto') return { ok: autoTrusted || (ctx.mode === 'warn' && ctx.cardClass !== 'D3'), warn: !autoTrusted };
  // D3 stays on this computer in Strict and Warn (as Auto's own upstream rule).
  if (ctx.cardClass === 'D3') return { ok: level === 'D3', warn: false };
  const enough = trustRank(level) >= classRank(ctx.cardClass);
  return { ok: enough || ctx.mode === 'warn', warn: !enough };
}

const AVAILABILITY_RANK: Partial<Record<AvailabilityState, number>> = { ready: 0, 'presumed-reset': 1, unknown: 2 };
const SUBSCRIPTION_KINDS = new Set<RouteKind>(['subscription', 'coding-plan', 'cli-default']);

export function decide(ctx: RouteContext): RouteDecision {
  const view = ctx.view;
  const raws = rawCandidates(ctx);
  const dropped: Dropped[] = [];
  const types: TaskType[] = view.type === 'chat' ? ['chat'] : [view.type, 'chat'];
  const maps = scoreMaps(raws, ctx.index, types);
  const mapOf = (raw: Raw, type: TaskType): Map<string, Score> | undefined => raw.resolved.identity ? maps.get(variantKey(raw.resolved.identity, raw.effort, raw.context))?.get(type) : undefined;
  const policy = ctx.settings.newModels;
  const fits = new Map<string, ReturnType<typeof anchorFit>>();
  const level: Level = view.level;
  const tier = tierFor(view.difficulty, view.strong, ctx.preference);
  const share = ctx.settings.expectedShare[level];

  const candidates: Candidate[] = [];
  const usable: Array<{ raw: Raw; candidate: Candidate }> = [];
  for (const raw of raws) {
    const entry = ctx.providers.find(provider => provider.id === raw.cli);
    const key = `${raw.cli}|${raw.signIn}|${raw.model ?? ''}|${raw.effort ?? ''}`;
    const drop = (reason: string): void => { dropped.push({ key, cli: raw.cli, label: raw.label, model: raw.model, reason }); };
    // OpenRouter serves only Jev's own decisions: no route whose model calls would go there.
    if (raw.endpoint && modelTrafficForbidden(raw.endpoint.includes('://') ? raw.endpoint : `https://${raw.endpoint}`) || raw.model && /^openrouter\//iu.test(raw.model)) { drop('OpenRouter serves only Jev\'s decisions, never model calls'); continue; }
    // Facts about the CLI.
    if (ctx.providersGiven && !entry) { drop('not offered by list_providers'); continue; }
    if (entry && (entry.available === false || entry.installed === false)) { drop('its CLI is not installed or not available'); continue; }
    if (entry && entry.subagent === false) { drop('it cannot run as a subagent'); continue; }
    if (raw.kind !== 'account' && raw.kind !== 'auto' && !raw.pool && (entry?.signIn === 'signed_out' || entry?.signIn === 'expired')) { drop(`its sign-in is ${entry.signIn === 'expired' ? 'expired' : 'signed out'}`); continue; }
    if (ctx.orchestrate && !(entry?.orchestrator ?? ORCHESTRATOR_CLIS.has(raw.cli))) { drop('it cannot orchestrate'); continue; }
    if (raw.row && raw.row.state !== 'ready') { drop(`account ${raw.row.state}${raw.row.reason ? `: ${raw.row.reason}` : ''}`); continue; }
    const plugins = pluginsFor(raw.cli, ctx);
    if (raw.kind === 'account' && !plugins.has(ACCOUNTS_ID) && ctx.providersGiven) { drop('the Accounts plugin does not apply to this CLI here'); continue; }
    if (raw.pool && !plugins.has(ACCOUNTS_ID) && ctx.providersGiven) { drop('the Accounts plugin does not apply to this CLI here'); continue; }
    if (raw.kind === 'auto' && !plugins.has(ASSISTANT_ID) && ctx.providersGiven) { drop('the Assistant\'s launch options do not apply to OpenCode here'); continue; }
    // 1.8.2: a subagent of another CLI is refused while a plugin the spawn cannot name set the orchestrator's model.
    if (ctx.callerProvider && raw.cli !== ctx.callerProvider) {
      const callerPlugins = pluginsFor(ctx.callerProvider, ctx);
      const unnameable = [...callerPlugins].filter(id => !plugins.has(id) && !(id === ACCOUNTS_ID && raw.kind === 'account'));
      if (unnameable.length) { drop(`another CLI than yours, and ${unnameable.join(', ')} cannot be named for it (your model may come from it)`); continue; }
    }
    // The person's rules.
    if (raw.allow === 'never') { drop('set to Never on the settings page'); continue; }
    const trust = trustOf(raw.trust, ctx, ctx.auto?.trusted ?? false);
    if (!trust.ok) { drop(raw.trust === 'auto' ? `no Auto upstream is trusted with ${ctx.cardClass}` : `trust ${raw.trust} is below this card's ${ctx.cardClass} (${ctx.mode === 'strict' ? 'Strict' : 'D3 stays on this computer'})`); continue; }

    const boost = raw.resolved.identity ? ctx.settings.boosts[raw.resolved.identity] ?? 0 : 0;
    const pin = raw.resolved.identity ? ctx.settings.pins[raw.resolved.identity] ?? null : null;

    // Cost and capacity.
    const ref = taskUsd(level, raw.kind === 'auto' ? { priceIn: ctx.auto!.priceIn, priceOut: ctx.auto!.priceOut } : apiPrice(ctx.catalog, raw.resolved.identity));
    let cost: number | null = null;
    let costBasis: Candidate['costBasis'] = 'unpriced';
    let estimate: Estimate = { kind: 'unknown', note: 'no price known' };
    let quota: SubscriptionQuota | null = null;
    let availability: Candidate['availability'] = { state: 'ready', reason: entry?.signIn === 'ok' ? 'signed in' : 'not checked' };
    if (raw.pool) {
      // A pool: its best free member's quota as Accounts read it (per account home), never the default login's.
      const q = raw.pool.quota;
      const reserve = raw.plan?.reserve ?? DEFAULT_RESERVE;
      const left = q && q.remainingPercent !== null && q.state !== 'unknown' && q.state !== 'stale' ? q.remainingPercent - reserve : null;
      quota = raw.pool.ready <= 0
        ? { state: 'exhausted', headroom: 0, pace: null, window: null, readAt: q?.observedAt ?? null, note: 'no free account in the pool', code: 'no-headroom' }
        : left === null ? { state: 'unknown', headroom: null, pace: null, window: null, readAt: q?.observedAt ?? null, note: q?.note || 'pool quota not read yet', code: 'unread' }
          : left <= 0 ? { state: 'exhausted', headroom: 0, pace: null, window: null, readAt: q!.observedAt, note: 'no headroom above the reserve in any free account', code: 'no-headroom' }
            : { state: 'known', headroom: Math.round(left * 1_000) / 1_000, pace: null, window: { label: raw.pool.window, usedPercent: 100 - q!.remainingPercent!, minutes: null }, readAt: q!.observedAt, note: '', code: '' };
      const price = shadowPrice(quota, share, ref);
      cost = price.usd; costBasis = price.basis;
      if (price.basis === 'unavailable') availability = { state: 'exhausted', reason: `pool: ${quota.note}` };
      else if (quota.state === 'unknown') availability = { state: 'unknown', reason: `pool quota unknown: ${quota.note}` };
      estimate = quota.state === 'known' ? { kind: 'window', share, window: raw.pool.window, usedPercent: quota.window?.usedPercent ?? null } : { kind: 'unknown', note: `pool quota unknown (${quota.note})` };
    } else if (raw.kind === 'subscription' || raw.kind === 'cli-default') {
      const limits = ctx.limits?.providers.find(provider => provider.provider === raw.cli);
      quota = quotaOf(limits, raw.plan?.reserve ?? DEFAULT_RESERVE, ctx.now, ctx.launchesSinceRead?.(raw.cli) ?? 0, ctx.spentSinceRead?.(raw.cli) ?? null);
      const price = shadowPrice(quota, share, ref);
      cost = price.usd; costBasis = price.basis;
      if (price.basis === 'unavailable') availability = { state: 'exhausted', reason: quota.note };
      else if (quota.state === 'unknown') availability = { state: 'unknown', reason: `quota unknown: ${quota.note}` };
      else if (quota.state === 'presumed-reset') availability = { state: 'presumed-reset', reason: quota.note };
      estimate = quota.state === 'known' || quota.state === 'presumed-reset' ? { kind: 'window', share, window: quota.window?.label ?? null, usedPercent: quota.window?.usedPercent ?? null } : { kind: 'unknown', note: `quota unknown (${quota.note})` };
    } else if (raw.kind === 'coding-plan') {
      const plan = raw.plan!;
      const hours = plan.windowHours ?? 5;
      const used = ctx.launches(plan.id, hours * 3_600_000);
      cost = 0; costBasis = 'plan';
      if (plan.allowance === undefined) { availability = { state: 'unknown', reason: `quota unknown (no allowance set; ${used} launches counted in ${hours} h)` }; estimate = { kind: 'unknown', note: `quota unknown, ${used} launches counted in ${hours} h` }; }
      else if (used >= plan.allowance) { availability = { state: 'exhausted', reason: `${used} of ${plan.allowance} launches used in this ${hours} h window` }; cost = null; }
      else estimate = { kind: 'launches', used, allowance: plan.allowance, windowHours: hours };
    } else if (raw.kind === 'account' && raw.row?.quota?.state === 'exhausted' && (raw.row.quota.resetsAt === null || raw.row.quota.resetsAt > ctx.now)) {
      // Accounts read the plan's quota: used up until its reset (a fresh read that shows room clears it there).
      availability = { state: 'exhausted', reason: `the account's quota is used up${raw.row.quota.note ? ` (${raw.row.quota.note})` : ''}` };
    } else if (raw.kind === 'account' && raw.endpoint && isLocalHost(raw.endpoint)) {
      cost = 0; costBasis = 'local'; estimate = { kind: 'usd', low: 0, high: 0 };
    } else {
      const own = raw.kind === 'account' ? (raw.resolved.identity ? accountPrice(ctx, raw) : null) : ref;
      if (own !== null) { cost = own; costBasis = 'api'; estimate = usdEstimate(own); }
      // A coding-plan account has no price per call: free within the plan's limits (a limit exit rests it).
      else if (raw.kind === 'account' && flatRate(raw, ctx.settings)) { cost = 0; costBasis = 'flat'; estimate = { kind: 'flat' }; }
    }
    if (raw.kind === 'account' && availability.state === 'ready' && raw.row?.quota?.state === 'presumed-reset') availability = { state: 'presumed-reset', reason: raw.row.quota.note || 'its quota has probably reset' };
    const cooling = ctx.cooldown(raw.signIn);
    if (cooling && cooling.until > ctx.now) availability = { state: 'cooldown', reason: cooling.reason };
    const maxParallel = raw.plan?.maxParallel ?? (raw.kind === 'cli-default' ? DEFAULT_MAX_PARALLEL : Infinity);
    const running = ctx.busy(raw.signIn);
    if (running >= maxParallel) availability = { state: 'busy', reason: `${running} routed children already run on it (at most ${maxParallel})` };
    if (availability.state === 'exhausted' || availability.state === 'cooldown' || availability.state === 'busy') { drop(availability.reason); continue; }

    // What spawn_agent gets.
    const spawn: Spawn = { provider: raw.cli, launchOptions: {} };
    let accountOptions: Record<string, string | boolean> | null = raw.pool ? { ...raw.pool.launchOptions[ACCOUNTS_ID]! } : null;
    if (raw.kind === 'account') {
      accountOptions = { ...(raw.row?.launchOptions?.[ACCOUNTS_ID] ?? { account: raw.accountId!, trustFolder: false }) };
      accountOptions.effort = raw.effort && raw.effortVia === 'accounts' ? raw.effort : (typeof accountOptions.effort === 'string' ? accountOptions.effort : 'default');
    }
    spawn.launchOptions = launchOptionsFor(raw.cli, plugins, { kind: raw.kind, account: accountOptions });
    if ((raw.kind === 'subscription' || raw.kind === 'coding-plan') && raw.model) spawn.model = raw.model;
    if (raw.effort && raw.effortVia === 'spawn' && raw.kind !== 'auto') spawn.effort = raw.effort;

    const candidate: Candidate = {
      key, cli: raw.cli, kind: raw.kind, signIn: raw.signIn, label: raw.label,
      ...(raw.planId ? { planId: raw.planId } : {}), ...(raw.accountId ? { accountId: raw.accountId } : {}), ...(raw.endpoint ? { endpoint: raw.endpoint } : {}),
      model: raw.kind === 'auto' ? ctx.auto!.model : raw.model, identity: raw.resolved.identity, resolvedFrom: raw.resolved.from, effort: raw.effort,
      scoredEffort: raw.effort, overall: null, planPreferred: null,
      score: null, pin, boost, cost, costBasis, estimate, quota, availability, trust: { level: raw.trust, warn: trust.warn }, allow: raw.allow, demoted: null, planCost: null, spawn,
      newModel: false
    };
    candidates.push(candidate);
    usable.push({ raw, candidate });
  }

  // Scores, in one cohort chosen among the routes still usable: a route that was just dropped (no key, its CLI not
  // installed, used up, Never) must not pick the task type or the benchmark the usable ones are compared in. Otherwise
  // a writing task whose only writing scores belong to a key-less account finds every ready account unscored.
  const usableRaws = usable.map(entry => entry.raw);
  const scoredAs: TaskType = usableRaws.some(raw => (mapOf(raw, view.type)?.size ?? 0) > 0) ? view.type : 'chat';
  const cohort = chooseCohort(usableRaws.filter(raw => raw.resolved.identity).map(raw => ({ model: raw.resolved.identity!, scores: mapOf(raw, scoredAs) ?? new Map() })));
  const chatCohort = chooseCohort(usableRaws.filter(raw => raw.resolved.identity).map(raw => ({ model: raw.resolved.identity!, scores: mapOf(raw, 'chat') ?? new Map() })));
  for (const { raw, candidate } of usable) {
    const scores = mapOf(raw, scoredAs);
    const boost = candidate.boost;
    let score: CandidateScore | null = null;
    const measured = cohort ? scores?.get(cohort) : undefined;
    if (measured) score = { value: measured.value + boost, raw: measured.value, label: measured.label, source: 'measured', historical: measured.historical };
    else if (cohort && scores?.size && policy !== 'wait') {
      for (const [other, value] of scores) {
        const fitKey = `${scoredAs}|${other}`;
        if (!fits.has(fitKey)) fits.set(fitKey, anchorFit(ctx.index, scoredAs, other, cohort));
        const fit = fits.get(fitKey);
        if (!fit) continue;
        const mappedValue = Math.round((fit.a * value.value + fit.b) * 100) / 100;
        score = { value: mappedValue - PROVISIONAL_PENALTY + boost, raw: mappedValue, label: `${value.label} → mapped`, source: 'provisional', historical: value.historical, mapped: { from: value.label, anchors: fit.anchors, r2: fit.r2 } };
        break;
      }
    }
    candidate.score = score;
    candidate.scoredEffort = measured?.effort ?? raw.effort;
    candidate.overall = chatCohort ? (mapOf(raw, 'chat')?.get(chatCohort)?.value ?? null) : null;
    candidate.newModel = !!raw.model && raw.kind !== 'auto' && (score === null || score.source === 'provisional');
  }

  planCosts(candidates, ctx, raws);

  // A new model is one the cohort measures at no effort at all: a known model's other effort is not new.
  const measuredIdentities = new Set(candidates.filter(c => c.score?.source === 'measured' && c.identity).map(c => c.identity!));
  for (const c of candidates) if (c.newModel && c.identity && measuredIdentities.has(c.identity)) c.newModel = false;

  // Tunnels: one model per identity and effort; a route the person marked "not equivalent" is its own model.
  const groupKey = (c: Candidate): string => !c.identity || ctx.settings.notEquivalent.includes(c.key) ? `route:${c.key}` : `${c.identity}|${c.scoredEffort ?? ''}`;
  const groupsByKey = new Map<string, Candidate[]>();
  for (const candidate of candidates) { const k = groupKey(candidate); groupsByKey.set(k, [...groupsByKey.get(k) ?? [], candidate]); }
  for (const group of groupsByKey.values()) demote(group, ctx.stats);
  const routeOrder = (a: Candidate, b: Candidate): number =>
    Number(a.demoted !== null) - Number(b.demoted !== null)
    || (AVAILABILITY_RANK[a.availability.state] ?? 9) - (AVAILABILITY_RANK[b.availability.state] ?? 9)
    || Number(a.trust.warn) - Number(b.trust.warn)
    || compareCost(a, b)
    || allowRank(a.allow) - allowRank(b.allow)
    || Number(ctx.settings.preferSubscriptions && !SUBSCRIPTION_KINDS.has(a.kind)) - Number(ctx.settings.preferSubscriptions && !SUBSCRIPTION_KINDS.has(b.kind))
    || a.key.localeCompare(b.key);
  const groups = [...groupsByKey.values()].map(group => group.sort(routeOrder));

  // The model: pinned first, then by score within the quality window, then the rest; unscored last.
  const window = QUALITY_WINDOW[ctx.preference][view.level === 'small' && !view.confident ? 'medium' : view.level];
  const rep = (group: Candidate[]): Candidate => group[0]!;
  const pinned = groups.filter(group => rep(group).pin === tier).sort((a, b) => compareCost(rep(a), rep(b)) || rep(a).key.localeCompare(rep(b).key));
  const rest = groups.filter(group => !pinned.includes(group));
  const scored = rest.filter(group => rep(group).score);
  const measuredValues = scored.filter(group => rep(group).score!.source === 'measured').map(group => rep(group).score!.value);
  const best = measuredValues.length ? Math.max(...measuredValues) : scored.length ? Math.max(...scored.map(group => rep(group).score!.value)) : null;
  const headroomOk = (c: Candidate): boolean => SUBSCRIPTION_KINDS.has(c.kind) && (c.costBasis === 'free' || c.costBasis === 'burning' || (c.kind === 'coding-plan' && c.estimate.kind === 'launches'));
  const quotaKnown = (c: Candidate): boolean => c.availability.state === 'ready' && !(SUBSCRIPTION_KINDS.has(c.kind) && c.costBasis === 'unknown');
  const lowerEffort = view.level !== 'large';
  // Large or risky tasks stay quality-first: a plan's cheaper, faster model wins only small and medium ones.
  const qualityFirst = view.level === 'large' || view.strong || ctx.explore.highRisk;
  let eligible = best === null ? [] : scored.filter(group => rep(group).score!.value >= best - window - 1e-9).sort((ga, gb) => {
    const a = rep(ga), b = rep(gb);
    return (ctx.settings.preferSubscriptions ? Number(headroomOk(b)) - Number(headroomOk(a)) : 0)
      || compareCost(a, b)
      || (qualityFirst ? 0 : comparePlan(a, b))
      || (a.allow === 'prefer' || b.allow === 'prefer' ? allowRank(a.allow) - allowRank(b.allow) : Number(quotaKnown(b)) - Number(quotaKnown(a)))
      || (lowerEffort ? effortRank(a.effort) - effortRank(b.effort) : 0)
      || b.score!.value - a.score!.value
      || a.key.localeCompare(b.key);
  });
  // A provisional score never displaces a measured model of the same price band on large tasks.
  if (view.level === 'large') eligible = keepMeasuredFirst(eligible, rep);
  const others = scored.filter(group => !eligible.includes(group)).sort((a, b) => rep(b).score!.value - rep(a).score!.value || compareCost(rep(a), rep(b)) || rep(a).key.localeCompare(rep(b).key));
  const unscored = rest.filter(group => !rep(group).score);
  const boosted = unscored.filter(group => rep(group).boost !== 0);
  const defaults = unscored.filter(group => !rep(group).model || rep(group).kind === 'auto').sort((a, b) =>
    Number(rep(b).cli === ctx.callerProvider) - Number(rep(a).cli === ctx.callerProvider) || Number(quotaKnown(rep(b))) - Number(quotaKnown(rep(a))) || compareCost(rep(a), rep(b)) || rep(a).key.localeCompare(rep(b).key));
  const unused = unscored.filter(group => !boosted.includes(group) && !defaults.includes(group));
  let ordered = [...pinned, ...eligible, ...others, ...boosted, ...defaults];

  // Plans first on confidently small tasks: a plan or subscription within the person's wider window of the best (by
  // the task type's score, or by the overall score when the plan has none for the type) wins over paid routes.
  if (ctx.settings.preferPlansSmall && view.level === 'small' && view.confident && !view.strong && !ctx.explore.highRisk && !ctx.orchestrate) {
    const W = ctx.settings.planWindowSmall;
    const isPlan = (c: Candidate): boolean => c.kind === 'subscription' || c.kind === 'coding-plan' || c.costBasis === 'flat' || c.costBasis === 'local';
    const bestOverall = Math.max(-Infinity, ...[...scored, ...unused, ...defaults].map(group => rep(group).overall ?? -Infinity));
    const good = (c: Candidate): boolean => c.score ? best !== null && c.score.value >= best - W - 1e-9 : c.overall !== null && c.overall >= bestOverall - W - 1e-9;
    const plansOk = [...scored, ...unused].filter(group => isPlan(rep(group)) && good(rep(group)));
    if (plansOk.length && !isPlan(rep(ordered[0] ?? plansOk[0]!))) {
      const sorted = [...plansOk].sort((a, b) => comparePlan(rep(a), rep(b)) || (rep(b).score?.value ?? rep(b).overall ?? 0) - (rep(a).score?.value ?? rep(a).overall ?? 0) || rep(a).key.localeCompare(rep(b).key));
      for (const group of sorted) rep(group).planPreferred = W;
      ordered = [...sorted, ...ordered.filter(group => !sorted.includes(group))];
    }
  }

  // The orchestrator's explicit choice (a model the person named, a CLI, a plan or account) wins over data.
  let preferred = false;
  if (ctx.prefer) {
    const p = lower(ctx.prefer);
    const pid = normalizeModelIdentity(ctx.prefer);
    const matches = (c: Candidate): boolean => c.cli === p || lower(c.model ?? '') === p || c.identity === pid || c.planId === p || lower(c.accountId ?? '') === p || (p === 'auto' && c.kind === 'auto');
    const chosen = [...ordered, ...unused].filter(group => group.some(matches)).map(group => [...group.filter(matches), ...group.filter(c => !matches(c))]);
    if (chosen.length) { preferred = true; ordered = [...chosen, ...ordered.filter(group => !chosen.some(other => other[0]!.key === group[0]!.key || group.some(c => other.includes(c))))]; }
  }

  // Exploration: a small share of easy, low-risk tasks tries the best new model, and its outcomes are counted.
  let explored = false;
  if (!preferred && policy === 'explore' && view.level !== 'large' && !view.strong && !ctx.explore.highRisk && !ctx.orchestrate && ctx.explore.roll < ctx.settings.exploreShare) {
    const pool = [...scored, ...unused].filter(group => rep(group).newModel && rep(group).identity && !ctx.explore.retired.has(rep(group).identity!))
      .sort((a, b) => Number(!rep(a).score) - Number(!rep(b).score) || compareCost(rep(a), rep(b)) || rep(a).key.localeCompare(rep(b).key));
    if (pool[0] && ordered[0] !== pool[0]) { explored = true; ordered = [pool[0], ...ordered.filter(group => group !== pool[0])]; }
  }
  for (const group of unused) if (!ordered.some(other => other.some(c => group.includes(c)))) for (const c of group) dropped.push({ key: c.key, cli: c.cli, label: c.label, model: c.model, reason: 'no measured score for this model (pin or boost it, or turn on new models)' });

  const top = ordered[0]?.[0] ?? null;
  const alternatives = ordered.slice(1).map(group => group[0]!).slice(0, 2);
  if (alternatives.length < 2 && ordered[0]) alternatives.push(...ordered[0].slice(1, 1 + 2 - alternatives.length));
  return {
    view, strategy: view.level === 'small' ? 'single-cheap' : 'single-strong', scoredAs: cohort ? scoredAs : null, cohort, best, window,
    groups: ordered, top, alternatives, dropped, explored, preferred
  };
}

const PLAN_NAME = /coding[\s_-]*plan|\bplan\b|план|подписк/iu;
function flatRate(raw: Raw, settings: RouteSettings): boolean {
  if (settings.flat.includes(`account:${raw.accountId}`) || settings.flat.includes(`host:${raw.endpoint}`)) return true;
  return PLAN_NAME.test(`${raw.row?.account ?? ''} ${raw.accountId ?? ''}`);
}

function accountPrice(ctx: RouteContext, raw: Raw): number | null {
  const own = raw.resolved.identity ? ctx.index.catalogModel(raw.model ?? '', raw.context) : null;
  if (own && !ctx.catalog.pricesStale && (own.inputPrice !== null || own.outputPrice !== null)) return taskUsd(ctx.view.level, { priceIn: own.inputPrice, priceOut: own.outputPrice });
  return null;
}

/** Expected tokens of one task for a model: learned from outcomes, else the level's default (×1.2 for a small model). */
export const SMALL_MODEL_TOKENS = 1.2;
const SMALL_MODEL = /(?:^|[-_])(?:flash|mini|lite|nano|small|haiku|fast|instant|air)(?:$|[-_\d])/u;
function expectedTokens(identity: string | null, level: Level, ctx: RouteContext): number {
  const base = TASK_TOKENS[level].input + TASK_TOKENS[level].output;
  const learned = identity ? ctx.tokenFactor?.(identity) ?? null : null;
  return Math.round(base * (learned ?? (identity && SMALL_MODEL.test(identity) ? SMALL_MODEL_TOKENS : 1)));
}

/** Model calls one task of each level makes (the live runs: 5–30 per turn), for the latency part of its time. */
export const TASK_CALLS: Readonly<Record<Level, number>> = { small: 5, medium: 15, large: 30 };

/** A model's output speed for plan time: the person's figure (tokens/s) first, else Artificial Analysis's measurement. */
export interface SpeedView { outputTps: number; latencyS: number | null; source: 'person' | 'measured'; label: string | null }
export function speedFor(c: Pick<Candidate, 'identity' | 'scoredEffort'>, ctx: Pick<RouteContext, 'settings' | 'index'>): SpeedView | null {
  if (!c.identity) return null;
  const person = ctx.settings.speeds[c.identity];
  if (person !== undefined) return { outputTps: person, latencyS: null, source: 'person', label: null };
  const effort = c.scoredEffort && (EFFORT_RANK as readonly string[]).includes(c.scoredEffort) ? c.scoredEffort as ReasoningEffort : null;
  const measured = ctx.index.speed(c.identity, effort, { openRouter: true, origin: null });
  return measured ? { outputTps: measured.outputTps, latencyS: measured.latencyS, source: 'measured', label: measured.label } : null;
}

/**
 * Plan cost: within one plan (a plan's sign-in, or a flat-rate account address), each model's quota share against
 * the plan's top model (the one with the highest API price): expected tokens × quota weight, where the weight is the
 * person's multiplier, else the API price ratio when the plan counts tokens (1 when it counts prompts or nobody knows).
 * Time: the task's expected output at the model's speed (the person's figure, else Artificial Analysis's measured
 * output tokens/s) plus, when both are measured, its calls × time to first chunk — relative to the top model's, and
 * weighted by "value speed". An unknown speed (on either side) is neutral: time 1, as long as the top model's.
 */
function planCosts(candidates: Candidate[], ctx: RouteContext, raws: Raw[]): void {
  const groupOf = (c: Candidate): string | null => c.kind === 'subscription' || c.kind === 'coding-plan' || c.kind === 'cli-default' ? c.signIn : c.costBasis === 'flat' ? `flat:${c.endpoint}` : null;
  const plans = new Map(ctx.settings.plans.map(plan => [`plan:${plan.id}`, plan]));
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) { const g = groupOf(c); if (g) groups.set(g, [...groups.get(g) ?? [], c]); }
  void raws;
  const blend = (identity: string | null): number | null => { const p = apiPrice(ctx.catalog, identity); return p ? (p.priceIn ?? 0) + (p.priceOut ?? 0) * 3 : null; };
  const weightK = SPEED_WEIGHT[ctx.settings.valueSpeed];
  const base = TASK_TOKENS[ctx.view.level].input + TASK_TOKENS[ctx.view.level].output;
  for (const [key, members] of groups) {
    const plan = plans.get(key);
    const quotaBy = plan?.quotaBy ?? 'tokens';
    const top = [...members].sort((a, b) => (blend(b.identity) ?? -1) - (blend(a.identity) ?? -1))[0]!;
    const topPrice = blend(top.identity);
    const tokensOf = (c: Candidate): number => expectedTokens(c.identity, ctx.view.level, ctx);
    const weightOf = (c: Candidate): number => {
      const person = c.identity ? plan?.multipliers?.[c.identity] ?? ctx.settings.quotaWeights[c.identity] : undefined;
      if (person !== undefined) return person;
      const price = blend(c.identity);
      return quotaBy === 'tokens' && price !== null && topPrice ? price / topPrice : 1;
    };
    const topSpeed = speedFor(top, ctx);
    const outputOf = (c: Candidate): number => TASK_TOKENS[ctx.view.level].output * (tokensOf(c) / base);
    const secondsOf = (speed: SpeedView, c: Candidate, latency: boolean): number => (latency ? TASK_CALLS[ctx.view.level] * (speed.latencyS ?? 0) : 0) + outputOf(c) / speed.outputTps;
    const topQuota = quotaBy === 'prompts' ? 1 : tokensOf(top) * weightOf(top);
    for (const c of members) {
      const quota = quotaBy === 'prompts' ? 1 : (tokensOf(c) * weightOf(c)) / topQuota;
      const speed = c === top ? topSpeed : speedFor(c, ctx);
      const latency = !!speed && !!topSpeed && speed.latencyS !== null && topSpeed.latencyS !== null;
      const time = speed && topSpeed ? Math.round((secondsOf(speed, c, latency) / secondsOf(topSpeed, top, latency)) * 1_000) / 1_000 : null;
      c.planCost = { cost: Math.round((quota + weightK * (time ?? 1)) * 1_000) / 1_000, quota: Math.round(quota * 1_000) / 1_000, time,
        faster: time ? Math.round((1 / time) * 10) / 10 : null, speedFrom: time === null ? null : speed!.source === 'person' && topSpeed!.source === 'person' ? 'person' : speed!.source === 'measured' && topSpeed!.source === 'measured' ? 'measured' : 'mixed',
        against: c === top ? null : top.identity ?? top.model, tokens: tokensOf(c) };
    }
  }
}

function comparePlan(a: Candidate, b: Candidate): number {
  if (!a.planCost || !b.planCost) return 0;
  return a.planCost.cost - b.planCost.cost;
}

const allowRank = (allow: RouteAllow): number => allow === 'prefer' ? 0 : 1;
const effortRank = (effort: string | null): number => effort ? EFFORT_RANK.indexOf(effort) : -1;
function compareCost(a: Candidate, b: Candidate): number {
  if (a.cost === null || b.cost === null) return (a.cost === null ? 1 : 0) - (b.cost === null ? 1 : 0);
  return a.cost - b.cost;
}

function keepMeasuredFirst(groups: Candidate[][], rep: (group: Candidate[]) => Candidate): Candidate[][] {
  const out = [...groups];
  for (let i = 0; i < out.length; i++) {
    const p = rep(out[i]!);
    if (p.score?.source !== 'provisional') continue;
    // The last measured model after it whose cost is within 2× of its own.
    let target = -1;
    for (let j = i + 1; j < out.length; j++) {
      const m = rep(out[j]!);
      if (m.score?.source !== 'measured') continue;
      const band = p.cost === null || m.cost === null ? p.cost === m.cost : m.cost <= Math.max(p.cost * 2, 1e-9) && p.cost <= Math.max(m.cost * 2, 1e-9);
      if (band) target = j;
    }
    if (target > i) { const [moved] = out.splice(i, 1); out.splice(target, 0, moved!); i--; }
  }
  return out;
}

/** A route whose failures are clearly worse than the other routes to the same model goes last, with the reason. */
function demote(group: Candidate[], stats: ReadonlyMap<string, RouteStats>): void {
  if (group.length < 2) return;
  for (const candidate of group) {
    const own = stats.get(candidate.key);
    if (!own || own.n < DEMOTE_MIN) continue;
    let n = 0, fail = 0;
    for (const other of group) if (other !== candidate) { const s = stats.get(other.key); if (s) { n += s.n; fail += s.fail; } }
    if (n < DEMOTE_MIN) continue;
    const rate = own.fail / own.n, others = fail / n;
    if (rate >= Math.max(2 * others, others + 0.1)) candidate.demoted = `${Math.round(rate * 100)}% of ${own.n} runs failed on this route, ${Math.round(others * 100)}% on the other routes to this model`;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Explaining
// ---------------------------------------------------------------------------------------------------------------

const ago = (at: number | null | undefined, now: number): string => {
  if (!at) return 'never read';
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes < 1 ? 'just now' : minutes < 120 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
};
const windowName = (minutes: number | null, label: string | null): string => label ?? (minutes === null ? 'window' : minutes % 1_440 === 0 ? `${minutes / 1_440} d window` : minutes % 60 === 0 ? `${minutes / 60} h window` : `${minutes} min window`);

export function modelText(c: Candidate): string {
  if (c.kind === 'auto') return `Model: Auto (Jev), expected ${c.model}${c.effort ? `@${c.effort}` : ''}`;
  const model = c.model ?? 'its default model';
  const identity = c.identity && c.model && normalizeModelIdentity(c.model.split('/').at(-1)!) !== c.identity ? ` (= ${c.identity}${c.resolvedFrom === 'bundled' ? ', alias table' : c.resolvedFrom === 'person' ? ', your alias' : ''})` : '';
  const via = c.kind === 'account' ? ` on account ${c.label}` : c.kind === 'subscription' || c.kind === 'coding-plan' ? ` on ${c.label}` : c.kind === 'cli-default' ? ' on its own sign-in' : '';
  return `${c.cli} · ${model}${c.effort ? `@${c.effort}` : ''}${identity}${via}`;
}

export function costText(c: Candidate, now: number): string {
  const base = costBase(c, now);
  const p = c.planCost;
  if (!p || !p.against) return base;
  const from = p.speedFrom === 'measured' ? ' (Artificial Analysis speeds)' : p.speedFrom === 'mixed' ? ' (your and measured speeds)' : '';
  return `${base}; ~${Math.round(p.quota * 100)}% of the plan quota ${p.against} would use${p.faster && p.faster !== 1 ? `, ~${p.faster}× ${p.faster > 1 ? 'faster' : 'as fast'}${from}` : ''}`;
}

function costBase(c: Candidate, now: number): string {
  const read = c.quota ? `, read ${ago(c.quota.readAt, now)}` : '';
  const used = c.quota?.window ? `${windowName(c.quota.window.minutes, c.quota.window.label)} ${Math.round(c.quota.window.usedPercent)}% used` : '';
  switch (c.costBasis) {
    case 'free': return `subscription: free (${used}, headroom ${c.quota?.headroom}% above the reserve${read})`;
    case 'burning': return `subscription burning faster than its window (pace ${c.quota?.pace}): priced like its API route${read}`;
    case 'low': return `subscription close to its reserve (${used}${read}): priced like its API route`;
    case 'unknown': return `subscription: quota unknown (${c.quota?.note ?? 'not read'})`;
    case 'plan': return c.estimate.kind === 'launches' ? `coding plan: ${c.estimate.used} of ${c.estimate.allowance} launches in this ${c.estimate.windowHours} h window` : 'coding plan: quota unknown';
    case 'local': return 'on this computer: no API cost';
    case 'flat': return 'flat-rate plan, unpriced: no cost per task within the plan\'s limits';
    case 'api': return c.estimate.kind === 'usd' ? `API ≈ $${c.estimate.low}–${c.estimate.high} per task` : 'API';
    default: return 'no price known';
  }
}

export function scoreText(c: Candidate, scoredAs: TaskType | null): string {
  const pin = c.pin ? `your pin: ${c.pin}; ` : '';
  if (!c.score) return `${pin}${c.kind === 'cli-default' ? 'the CLI\'s own default model: no score' : 'no measured score'}`;
  const boost = c.boost ? `, your boost ${c.boost > 0 ? '+' : ''}${c.boost}` : '';
  const mapped = c.score.mapped ? `, provisional: mapped from ${c.score.mapped.from} through ${c.score.mapped.anchors} anchor models (R² ${c.score.mapped.r2}), −${PROVISIONAL_PENALTY}` : '';
  return `${pin}score ${c.score.value.toFixed(1)} for ${scoredAs ?? 'chat'} (${c.score.label}${c.score.historical ? ', old' : ''}${boost}${mapped})`;
}

/** One line: model · score · cost or window share · availability and its source. */
export function whyLine(c: Candidate, decision: Pick<RouteDecision, 'scoredAs' | 'best' | 'window'>, now: number): string {
  const parts = [modelText(c), scoreText(c, decision.scoredAs), costText(c, now)];
  if (decision.best !== null && c.score && c.score.source === 'measured' && decision.best - c.score.value > 0.05) parts.push(`${(decision.best - c.score.value).toFixed(1)} points below the best, allowed ${decision.window}`);
  parts.push(c.availability.state === 'ready' ? `ready (${c.availability.reason})` : c.availability.reason);
  if (c.trust.warn) parts.push(`trust ${c.trust.level === 'auto' ? 'of its upstreams' : c.trust.level} is below this card's class (Warn)`);
  if (c.demoted) parts.push(`demoted: ${c.demoted}`);
  if (c.planPreferred !== null) parts.push(`a plan is good enough for a small task: within ${c.planPreferred} points of the best${c.score ? '' : ` (overall score ${c.overall?.toFixed(1)})`}, so it goes before paid routes (your setting)`);
  return parts.join(' · ');
}

export function estimateText(estimate: Estimate): string {
  switch (estimate.kind) {
    case 'usd': return estimate.high === 0 ? '$0' : `$${estimate.low}–${estimate.high}`;
    case 'window': return `≈ ${estimate.share}% of the ${estimate.window ?? 'window'}${estimate.usedPercent !== null ? ` (now ${Math.round(estimate.usedPercent)}% used)` : ''}`;
    case 'launches': return `1 launch (${estimate.used} of ${estimate.allowance} used in ${estimate.windowHours} h)`;
    case 'flat': return 'flat-rate, unpriced';
    default: return estimate.note;
  }
}
