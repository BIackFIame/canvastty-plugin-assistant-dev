import type { TaskType } from './catalog/scoring.ts';
import { normalizeModelIdentity } from './catalog/identity.ts';
import { bareModelId } from './catalog/scoring.ts';
import type { InventoryEntry } from './inventory.ts';
import type { Plan, TurnView } from './select.ts';
import type { AutoPreference, AutoStrategySettings, AutoUpstream } from './settings.ts';

/**
 * Request-level strategies for one new user turn of an Auto (Jev) card (agent-level-routing-design §G.1/G.2). Pure:
 * no I/O. The router runs what this decides.
 *
 * - single: the turn goes to the ordered list select.ts made (the default for everything but hard text turns).
 * - consensus: K (≤ 3) slightly weaker, diverse models (different vendors, different upstreams where possible) answer
 *   the same request, buffered; a strong judge merges the drafts into the one answer the CLI receives.
 * - best-of-N: the same fan-out, but the judge keeps the best draft (only when the person turned it on).
 *
 * Eligible turns: a new user turn (never a tool step or a title), level large, and design-level (`strong`) or of a
 * type whose answer is text (research, review, writing); never on an orchestrator card (its turns call tools), never
 * in a conversation where a fan-out already met a tool call.
 *
 * The expected-value heuristic (mode Auto, consensus only; Always skips it, best-of-N is the person's explicit choice):
 *
 *   gain   = GAIN_PER_FAMILY × (distinct vendors among the drafts − 1), at most MAX_GAIN points
 *   EV(consensus) − EV(single) = (judge score + gain − single score)
 *                                − COST_WEIGHT[preference] × log2(fan-out cost / single cost)
 *                                − TIME_WEIGHT × log2(fan-out time / single time)   (0 when a speed is unknown)
 *
 * Consensus runs only when that difference is above 0. The gain is a routing assumption, not a measurement: aggregating
 * diverse drafts with a strong aggregator was reported to beat the aggregator alone by a few points (Mixture-of-Agents,
 * Wang et al. 2024); 1.5 points per extra vendor, at most 3, keeps it below the windows select.ts already trades for
 * price. Its outcomes are recorded per route (router.ts) so the person can see whether it pays off. Cheap: cost
 * weighs 3 per doubling (consensus practically never); Balanced 1; Best 0 (quality and time only).
 */
export type StrategyKind = 'single' | 'consensus' | 'best-of-n';

export const GAIN_PER_FAMILY = 1.5;
export const MAX_GAIN = 3;
export const COST_WEIGHT: Readonly<Record<AutoPreference, number>> = { cheap: 3, balanced: 1, best: 0 };
export const TIME_WEIGHT = 0.5;
/** A draft model may be at most this many points below the best score for the type ("slightly weaker"). */
export const MEMBER_WINDOW = 8;
/** The judge is a strong model: within this many points of the best. */
export const JUDGE_WINDOW = 3;
/** Judges tried in order (failover) before the fan-out falls back to the best draft. */
export const MAX_JUDGES = 3;
/** Output tokens a draft is expected to have when nothing better is known (for the judge's input estimate). */
export const DRAFT_TOKENS = 4_096;
/** Per-route outcomes: a route that failed or timed out in at least half of ≥ 10 fan-outs is not asked again. */
export const OUTCOME_MIN = 10;
const TEXT_TYPES: ReadonlySet<TaskType> = new Set<TaskType>(['research', 'review', 'writing']);

export interface RouteOutcome { n: number; text: number; toolCalls: number; failed: number; timeout: number }

export interface StrategyInput {
  plan: Plan;
  view: TurnView;
  /** The card's role: an orchestrator's turns call tools. */
  role: string;
  /** This conversation met a tool call in an earlier fan-out. */
  agentic: boolean;
  settings: AutoStrategySettings;
  preference: AutoPreference;
  /** USD this entry's call is expected to cost (the router's realistic reservation). */
  estimate(entry: InventoryEntry): number;
  /** Seconds one call is expected to take at its measured speed, or null when unknown. */
  seconds(entry: InventoryEntry): number | null;
  /** Calls running now on an upstream, and the parallel cap of a subscription-like (flat-rate) upstream (null: none). */
  busy(upstream: AutoUpstream): number;
  parallelCap(upstream: AutoUpstream): number | null;
  outcome(key: string): RouteOutcome | undefined;
}

export interface StrategyDecision {
  kind: StrategyKind;
  /** A code-authored reason (shown on the page, kept in the decision record). */
  reason: string;
  /** Draft models, the single choice first (it is the answer when the turn turns out to call tools). */
  members: InventoryEntry[];
  /** Judges in failover order. */
  judges: InventoryEntry[];
  /** USD held for the whole fan-out (drafts + judge). */
  estimateUsd: number;
  /** The expected-value terms (null: not computed). */
  ev: { gain: number; quality: number; cost: number; time: number; total: number } | null;
}

const single = (reason: string): StrategyDecision => ({ kind: 'single', reason, members: [], judges: [], estimateUsd: 0, ev: null });

/** The vendor a model comes from: OpenRouter's `vendor/` prefix, else the first word of its name. */
export function familyOf(entry: Pick<InventoryEntry, 'model'>): string {
  const [vendor, rest] = entry.model.includes('/') ? [entry.model.split('/')[0]!, entry.model.split('/').at(-1)!] : [null, entry.model];
  if (vendor) return vendor.replace(/^~/u, '').toLowerCase();
  const bare = bareModelId(rest) ?? rest;
  return normalizeModelIdentity(bare).split('-')[0] ?? bare;
}

/** Whether a turn may fan out at all (before scores, prices and caps). */
export function eligible(input: Pick<StrategyInput, 'view' | 'role' | 'agentic' | 'settings'>): string | null {
  const { view, settings } = input;
  if (settings.consensus === 'off' && !settings.bestOfN) return 'strategy_off';
  if (view.level !== 'large') return 'not_hard';
  if (!view.strong && !TEXT_TYPES.has(view.type) && !(settings.bestOfN && view.type === 'coding')) return 'not_text_type';
  if (input.role === 'orchestrator') return 'orchestrator';
  if (input.agentic) return 'agentic_conversation';
  return null;
}

/** Judge input: the request plus K drafts. */
function judgeEstimate(judge: InventoryEntry, members: readonly InventoryEntry[], estimate: (entry: InventoryEntry) => number): number {
  return estimate(judge) + (members.length * DRAFT_TOKENS * (judge.priceIn ?? 0)) / 1e6;
}

export function chooseStrategy(input: StrategyInput): StrategyDecision {
  const notEligible = eligible(input);
  if (notEligible) return single(notEligible);
  const { plan, settings } = input;
  const kind: StrategyKind = settings.bestOfN && (input.view.type === 'coding' || settings.consensus === 'off') ? 'best-of-n' : settings.consensus === 'off' ? 'single' : 'consensus';
  if (kind === 'single') return single('strategy_off');
  const type = plan.scoredAs;
  const primary = plan.list[0];
  if (!primary || !type || plan.best === null) return single('unscored');
  const scoreOf = (entry: InventoryEntry): number | null => entry.scores[type]?.value ?? null;
  if (scoreOf(primary) === null) return single('primary_unscored');
  const best = plan.best;
  const healthy = (entry: InventoryEntry): boolean => {
    const outcome = input.outcome(entry.key);
    return !outcome || outcome.n < OUTCOME_MIN || (outcome.failed + outcome.timeout) / outcome.n < 0.5;
  };
  // Drafts: the single choice, then by score (cheaper first on ties), one per model and vendor, preferring upstreams
  // not used yet; subscription-like upstreams keep their parallel cap.
  const k = Math.min(settings.k, 3);
  const pool = plan.list.filter(entry => entry !== primary && scoreOf(entry) !== null && scoreOf(entry)! >= best - MEMBER_WINDOW - 1e-9 && healthy(entry))
    .sort((a, b) => scoreOf(b)! - scoreOf(a)! || input.estimate(a) - input.estimate(b) || a.key.localeCompare(b.key));
  const members: InventoryEntry[] = [primary];
  const load = new Map<string, number>([[primary.upstream.id, 1]]);
  const fits = (entry: InventoryEntry): boolean => {
    const cap = input.parallelCap(entry.upstream);
    return cap === null || input.busy(entry.upstream) + (load.get(entry.upstream.id) ?? 0) < cap;
  };
  for (const pass of ['new-upstream', 'any'] as const) {
    for (const entry of pool) {
      if (members.length >= k) break;
      if (members.some(member => member.model === entry.model || familyOf(member) === familyOf(entry))) continue;
      if (pass === 'new-upstream' && load.has(entry.upstream.id)) continue;
      if (!fits(entry)) continue;
      members.push(entry); load.set(entry.upstream.id, (load.get(entry.upstream.id) ?? 0) + 1);
    }
  }
  if (members.length < 2) return single('no_diverse_models');
  // Judges: strong (within JUDGE_WINDOW of the best), highest score first; the best-scored model leads.
  const judges = [...plan.list].filter(entry => scoreOf(entry) !== null && scoreOf(entry)! >= best - JUDGE_WINDOW - 1e-9 && healthy(entry))
    .sort((a, b) => scoreOf(b)! - scoreOf(a)! || input.estimate(a) - input.estimate(b) || a.key.localeCompare(b.key)).slice(0, MAX_JUDGES);
  if (!judges.length) return single('no_strong_judge');
  // The caps: drop the dearest extra draft until the fan-out fits the turn's cap; two drafts at least.
  const total = (): number => members.reduce((sum, entry) => sum + input.estimate(entry), 0) + judgeEstimate(judges[0]!, members, input.estimate);
  while (total() > settings.turnUsdCap + 1e-12 && members.length > 2) {
    const dearest = members.slice(1).sort((a, b) => input.estimate(b) - input.estimate(a))[0]!;
    members.splice(members.indexOf(dearest), 1);
  }
  if (total() > settings.turnUsdCap + 1e-12) return single('over_turn_cap');
  const estimateUsd = total();
  const families = new Set(members.map(familyOf)).size;
  const gain = Math.min(MAX_GAIN, GAIN_PER_FAMILY * (families - 1));
  const singleCost = input.estimate(primary);
  const quality = scoreOf(judges[0]!)! + gain - scoreOf(primary)!;
  const cost = singleCost > 0 && estimateUsd > 0 ? COST_WEIGHT[input.preference] * Math.log2(estimateUsd / singleCost) : 0;
  const drafts = members.map(input.seconds);
  const judgeTime = input.seconds(judges[0]!);
  const singleTime = input.seconds(primary);
  const time = drafts.every(value => value !== null) && judgeTime !== null && singleTime ? TIME_WEIGHT * Math.log2((Math.max(...(drafts as number[])) + judgeTime) / singleTime) : 0;
  const round = (value: number): number => Math.round(value * 1_000) / 1_000;
  const ev = { gain: round(gain), quality: round(quality), cost: round(cost), time: round(time), total: round(quality - cost - time) };
  if (kind === 'consensus' && settings.consensus === 'auto' && ev.total <= 0) return { ...single('single_better'), ev };
  return { kind, reason: kind === 'best-of-n' ? 'best_of_n_on' : settings.consensus === 'always' ? 'consensus_always' : 'consensus_pays', members, judges, estimateUsd: round(estimateUsd * 1_000) / 1_000, ev };
}

// ---------------------------------------------------------------------------------------------------------------
// Drafts and the judge's request
// ---------------------------------------------------------------------------------------------------------------

/** What one buffered answer said: its text, whether it called a tool, its usage (SSE or JSON). */
export interface ParsedAnswer { text: string; toolCalls: boolean; usage: { in: number | null; out: number | null; cost: number | null } }

export function parseAnswer(raw: string): ParsedAnswer {
  const result: ParsedAnswer = { text: '', toolCalls: false, usage: { in: null, out: null, cost: null } };
  const take = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const v = value as { choices?: unknown; usage?: unknown };
    for (const choice of Array.isArray(v.choices) ? v.choices : []) {
      const c = choice as { delta?: { content?: unknown; tool_calls?: unknown }; message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown };
      const part = c.delta ?? c.message;
      if (typeof part?.content === 'string') result.text += part.content;
      if (Array.isArray(part?.tool_calls) && part.tool_calls.length) result.toolCalls = true;
      if (c.finish_reason === 'tool_calls') result.toolCalls = true;
    }
    const u = v.usage as Record<string, unknown> | undefined;
    if (u && typeof u === 'object') {
      if (typeof u.prompt_tokens === 'number') result.usage.in = u.prompt_tokens;
      if (typeof u.completion_tokens === 'number') result.usage.out = u.completion_tokens;
      if (typeof u.cost === 'number' && Number.isFinite(u.cost) && u.cost >= 0) result.usage.cost = u.cost;
    }
  };
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('{')) { try { take(JSON.parse(trimmed)); } catch { /* not JSON */ } return result; }
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try { take(JSON.parse(data)); } catch { /* not JSON */ }
  }
  return result;
}

/** A tool call has started in this part of a stream (to stop the other drafts early). */
export const mentionsToolCall = (chunk: string): boolean => /"tool_calls"\s*:\s*\[\s*\{/u.test(chunk);

export const DRAFT_CHARS = 24_000;
const MERGE = 'Below are draft answers from different models to the last user message above. Write the single best final answer to that message: keep what the drafts agree on, settle disagreements by reasoning it through, correct mistakes, and leave out anything unsupported. Answer the user directly, in the language of their message; do not mention the drafts, the models or this instruction.';
const PICK = 'Below are draft answers from different models to the last user message above. Choose the best one and reply with it in full; you may correct clear mistakes in it, but do not merge drafts. Answer the user directly; do not mention the drafts, the models or this instruction.';

/** The judge's request: the CLI's own request (same system text and history, tools kept but not callable) plus the drafts. */
export function judgeBody(body: Record<string, unknown>, drafts: readonly string[], kind: Exclude<StrategyKind, 'single'>): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const text = [kind === 'best-of-n' ? PICK : MERGE, ...drafts.map((draft, index) => `--- Draft ${index + 1} ---\n${draft.length > DRAFT_CHARS ? `${draft.slice(0, DRAFT_CHARS)}\n[…]` : draft}`)].join('\n\n');
  const next: Record<string, unknown> = { ...body, messages: [...messages, { role: 'user', content: text }] };
  if (Array.isArray(body.tools) && body.tools.length) next.tool_choice = 'none';
  else delete next.tool_choice;
  return next;
}
