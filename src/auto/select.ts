import type { Difficulty } from '../harness/router.ts';
import type { Triage } from '../triage/triage.ts';
import type { TaskType } from './catalog/scoring.ts';
import { blendedPrice, type InventoryEntry } from './inventory.ts';
import { AUTO_TIERS, type AutoPreference, type AutoTier } from './settings.ts';

/**
 * How Auto (Jev) picks a model for a turn, from data:
 *
 * 1. The turn: its task type (coding, review, research, writing, chat) and difficulty level (small, medium, large),
 *    from Jev's task triage or, when Jev does not answer, from word rules. "Small" from Jev needs confidence ≥
 *    SMALL_CONFIDENCE (the probability of the two lowest difficulty levels); anything less is medium. Rules are
 *    never "confident".
 * 2. Candidates: the models the person allows (all a configured upstream offers, minus the excluded ones) that are
 *    healthy now (not cooling down, trusted with the card's data class, context large enough, within the caps).
 * 3. A model with a manual tier answers turns of its tier first (the person's explicit choice wins over data).
 * 4. The others by score: the catalog score for the turn's task type, in one comparable cohort. The preference and
 *    the turn's level set how many points of score may be given up for a lower price (QUALITY_WINDOW: balanced 8 /
 *    5 / 3 on small / medium / large, cheap 15 / 10 / 5, best 0). Within the window: the cheaper one, then (not on
 *    large turns) the lower effort, then the higher score. Ties are equal scores: the cheaper one wins.
 * 5. Unknown scores never compete with known ones. When nothing is scored: manual tiers, else the known model of
 *    middle price (the catalog knows the model and its price), never simply the cheapest.
 *
 * Writing has no Artificial Analysis score; when no candidate has a score for the turn's type, the overall ("chat")
 * score is used, and the decision says so.
 */

export type Level = 'small' | 'medium' | 'large';
/**
 * Jev's probability of the two lowest difficulty levels from which a turn is "small". Chosen on the 40 labelled
 * tasks of the live run of 2026-10-18 (tests/fixtures/auto/jev-live-2026-10-18.json): it is the threshold with the
 * best level accuracy (30 of 38 Jev answers, 0.789; 0.9 gave 0.632) among those that make no medium or large task
 * small. The medium tasks reached at most 0.40 and the small ones Jev got right at least 0.57; 0.5 sits between.
 */
export const SMALL_CONFIDENCE = 0.5;
/**
 * Research and review turns (explanations, comparisons, audits) need more: a cheap model's thin answer there looks
 * fine and is wrong. No labelled small task of these types fell between 0.5 and 0.7 in either live run, so the
 * labelled accuracy is unchanged.
 */
export const SMALL_CONFIDENCE_EXPLAINING = 0.7;
const EXPLAINING: ReadonlySet<TaskType> = new Set<TaskType>(['research', 'review']);
/** The p(small) a turn of this type needs. */
export const smallThreshold = (type: TaskType): number => EXPLAINING.has(type) ? SMALL_CONFIDENCE_EXPLAINING : SMALL_CONFIDENCE;
/**
 * Points (0–100) of score the preference may give up for a lower price, by the turn's level: the cheapest model
 * within this many points of the best one for the turn's task type answers. Large turns stay close to the best, and
 * there a lower effort is never chosen for its own sake (quality first). A small turn from the word rules (not Jev)
 * counts as medium here.
 */
export const QUALITY_WINDOW: Readonly<Record<AutoPreference, Readonly<Record<Level, number>>>> = {
  best: { small: 0, medium: 0, large: 0 },
  balanced: { small: 8, medium: 5, large: 3 },
  cheap: { small: 15, medium: 10, large: 5 }
};

/** The points a turn may give up for price. */
export function qualityWindow(view: Pick<TurnView, 'level' | 'confident'>, preference: AutoPreference): number {
  return QUALITY_WINDOW[preference][view.level === 'small' && !view.confident ? 'medium' : view.level];
}

/** Jev's (or the rules') view of one turn. */
export interface TurnDecision {
  difficulty: Difficulty;
  /** Design-level work (the top difficulty level is likely). */
  strong: boolean;
  /** Null: Jev did not say (below its confidence band); the word rules name the type. */
  type?: TaskType | null;
  /** Probability that the turn is in the two lowest difficulty levels (needed for "small"). */
  confidence?: number | null;
}

export interface TurnView {
  type: TaskType;
  typeFrom: 'jev' | 'rules';
  level: Level;
  /** Jev's "small" (at ≥ SMALL_CONFIDENCE), not the rules'. */
  confident: boolean;
  confidence: number | null;
  difficulty: Difficulty;
  strong: boolean;
}

const KIND_TYPE: Readonly<Record<string, TaskType>> = {
  code_change: 'coding', debug: 'coding', operations: 'coding', review: 'review', research: 'research', writing: 'writing', other: 'chat', unclear: 'chat'
};

/** Jev's task triage answers → the turn decision (type only inside its confidence band). */
export function decisionFromTriage(triage: Pick<Triage, 'kind' | 'kindBand' | 'difficulty' | 'p3'> & { difficultyProbabilities?: number[] | null }, strongAt: number): TurnDecision {
  const probabilities = triage.difficultyProbabilities ?? null;
  const confidence = probabilities && probabilities.length >= 2 ? Math.round(((probabilities[0] ?? 0) + (probabilities[1] ?? 0)) * 1_000) / 1_000 : null;
  return {
    difficulty: triage.difficulty, strong: triage.p3 >= strongAt,
    type: triage.kind !== null && triage.kindBand === 'auto' ? KIND_TYPE[triage.kind] ?? 'chat' : null,
    confidence
  };
}

const REVIEW = /\b(?:review|audit|look over|code review)\b|ревью|аудит|проверь (?:код|изменения|дифф|pr)/iu;
const WRITING = /\b(?:readme|changelog|release notes|documentation|docs|blog post|article|e-?mail|letter|commit message|pr description)\b|документаци|ченджлог|статью|письмо|описание (?:pr|пулл?-?реквеста)|текст для/iu;
const CODING = /\b(?:fix|implement|refactor|rename|bug|tests?|function|class|method|compile|build|endpoint|migrat\w*|deadlock|race|crash|stack trace|typescript|python|code)\b|исправ|реализ|рефактор|переименуй|функци|класс|баг|ошибк|тест|код|сборк|падает/iu;
const RESEARCH = /\b(?:explain|why|how does|what is|research|investigate|compare|find out|look up|summari[sz]e)\b|объясни|почему|как работает|что такое|исследуй|сравни|разберись|выясни/iu;

/** Word rules for the task type (used when Jev does not answer, or is not sure of the type). */
export function ruleTaskType(text: string): TaskType {
  const sample = text.slice(0, 4_000);
  if (REVIEW.test(sample)) return 'review';
  if (WRITING.test(sample)) return 'writing';
  if (CODING.test(sample)) return 'coding';
  if (RESEARCH.test(sample)) return 'research';
  return 'chat';
}

const confidenceOf = (decision: TurnDecision, from: 'jev' | 'rules'): number | null =>
  from === 'jev' && typeof decision.confidence === 'number' && Number.isFinite(decision.confidence) ? Math.max(0, Math.min(1, decision.confidence)) : null;

/**
 * The turn's level. Large: design-level work or a hard difficulty. Small: from Jev, its probability of the two lowest
 * levels at `smallAt` or above (its own three-way difficulty is not needed: on the live set it called most small
 * tasks "normal" at p 0.57–0.90); from the rules, their "simple". Else medium.
 */
export function levelOf(decision: TurnDecision, from: 'jev' | 'rules', smallAt = SMALL_CONFIDENCE): Level {
  if (decision.strong || decision.difficulty === 'hard') return 'large';
  if (from === 'rules') return decision.difficulty === 'simple' ? 'small' : 'medium';
  return (confidenceOf(decision, from) ?? 0) >= smallAt ? 'small' : 'medium';
}

/**
 * The turn as routing sees it. An orchestrator card (it plans and delegates; its turn is the whole job) is never
 * below medium: live, an orchestrator's turn at p(small) 0.73 went to a small model.
 */
export function turnView(decision: TurnDecision, from: 'jev' | 'rules', text: string, card: { role?: string } = {}): TurnView {
  const confidence = confidenceOf(decision, from);
  const type = from === 'jev' && decision.type ? decision.type : ruleTaskType(text);
  let level = levelOf(decision, from, smallThreshold(type));
  if (level === 'small' && card.role === 'orchestrator') level = 'medium';
  return {
    type, typeFrom: from === 'jev' && decision.type ? 'jev' : 'rules', level,
    confident: from === 'jev' && level === 'small' && (confidence ?? 0) >= smallThreshold(type),
    confidence, difficulty: level === 'small' ? 'simple' : level === 'large' ? 'hard' : 'normal', strong: decision.strong
  };
}

/** A level (and design-level work) → a manual tier, shifted by the preference (cheap −1, best +1), clamped. */
export function tierFor(difficulty: Difficulty, strong: boolean, preference: AutoPreference): AutoTier {
  const base: Record<Difficulty, AutoTier> = { simple: 'small', normal: 'medium', hard: 'large' };
  let index = AUTO_TIERS.indexOf(strong ? 'large' : base[difficulty]);
  if (preference === 'cheap') index -= 1;
  if (preference === 'best') index += 1;
  return AUTO_TIERS[Math.max(0, Math.min(AUTO_TIERS.length - 1, index))]!;
}

const comparePrice = (a: InventoryEntry, b: InventoryEntry): number => {
  const x = blendedPrice(a), y = blendedPrice(b);
  if (x === null || y === null) return (x === null ? 1 : 0) - (y === null ? 1 : 0);
  return x - y;
};
const EFFORT_RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const effortRank = (entry: InventoryEntry): number => entry.effort ? EFFORT_RANK.indexOf(entry.effort) : -1;

/**
 * Manually tiered models, as the tier rules always ordered them: the tier's own models (cheap: lowest price first;
 * best: highest first; balanced: the person's order), then stronger tiers, then — only when the person allows it —
 * cheaper ones.
 */
export function manualOrder(entries: readonly InventoryEntry[], tier: AutoTier, options: { preference: AutoPreference; cheaperFallback: boolean; cheapest?: boolean }): InventoryEntry[] {
  const ofTier = (wanted: AutoTier): InventoryEntry[] => {
    const list = entries.filter(entry => entry.tier === wanted);
    const order = options.cheapest ? 'cheap' : options.preference;
    if (order === 'balanced') return list;
    return list.map((entry, index) => ({ entry, index }))
      .sort((a, b) => {
        const x = blendedPrice(a.entry), y = blendedPrice(b.entry);
        return (x === null ? 1 : 0) - (y === null ? 1 : 0) || (x === null || y === null ? 0 : order === 'cheap' ? x - y : y - x) || a.index - b.index;
      })
      .map(item => item.entry);
  };
  const at = AUTO_TIERS.indexOf(tier);
  const order: AutoTier[] = [tier, ...AUTO_TIERS.slice(at + 1), ...(options.cheaperFallback || options.cheapest ? AUTO_TIERS.slice(0, at).reverse() : [])];
  return order.flatMap(ofTier);
}

export type SelectionReason = 'small_model' | 'manual_tier' | 'best_score' | 'cheaper_tie' | 'cheaper_within_loss' | 'lower_effort_within_loss' | 'kept_turn_model' | 'manual_tier_fallback' | 'unknown_scores' | 'no_model';

export interface Plan {
  list: InventoryEntry[];
  why: SelectionReason;
  /** The task type whose scores were compared (the turn's, or "chat" when nothing had one for it). */
  scoredAs: TaskType | null;
  best: number | null;
  /** Points of score the turn could give up for price. */
  loss: number;
  /** The best-scored model (the cheaper one on a tie): what the choice is measured against. */
  bestEntry: InventoryEntry | null;
}

/** The known-good model of middle price first: the catalog knows it and its price; then the rest by price. */
function conservative(entries: readonly InventoryEntry[]): InventoryEntry[] {
  const good = entries.filter(entry => entry.known && blendedPrice(entry) !== null);
  const prices = good.map(entry => blendedPrice(entry)!).sort((a, b) => a - b);
  const middle = prices.length ? prices[Math.floor((prices.length - 1) / 2)]! : null;
  const ordered = middle === null ? [] : [...good].sort((a, b) => Math.abs(blendedPrice(a)! - middle) - Math.abs(blendedPrice(b)! - middle) || comparePrice(b, a) || a.key.localeCompare(b.key));
  return [...ordered, ...entries.filter(entry => !ordered.includes(entry)).sort((a, b) => comparePrice(a, b) || a.key.localeCompare(b.key))];
}

/**
 * The models to try for a request, best first (the router tries them in order until one answers). `usable` holds
 * only candidates that may take this request now (enabled, not excluded, trusted, not cooling down, large enough).
 */
export function plan(usable: readonly InventoryEntry[], request: { kind: 'small' } | { kind: 'turn' | 'continuation'; view: TurnView; preferred: string | null }, options: { preference: AutoPreference; cheaperFallback: boolean }): Plan {
  if (!usable.length) return { list: [], why: 'no_model', scoredAs: null, best: null, loss: 0, bestEntry: null };
  if (request.kind === 'small') {
    // Titles and summaries: the cheapest priced model at its default (or lowest) effort, no Jev.
    const list = [...usable].sort((a, b) => comparePrice(a, b) || effortRank(a) - effortRank(b) || a.key.localeCompare(b.key));
    return { list, why: 'small_model', scoredAs: null, best: null, loss: 0, bestEntry: null };
  }
  const { view } = request;
  const manual = usable.filter(entry => entry.tier !== null);
  const auto = usable.filter(entry => entry.tier === null);
  const tier = tierFor(view.difficulty, view.strong, options.preference);
  const manualList = manualOrder(manual, tier, { preference: options.preference, cheaperFallback: options.cheaperFallback });
  const manualFirst = manualList.filter(entry => entry.tier === tier);
  const manualRest = manualList.filter(entry => entry.tier !== tier);
  const scoredAs: TaskType = auto.some(entry => entry.scores[view.type]) ? view.type : 'chat';
  const scored = auto.filter(entry => entry.scores[scoredAs]);
  const value = (entry: InventoryEntry): number => entry.scores[scoredAs]!.value;
  const best = scored.length ? Math.max(...scored.map(value)) : null;
  const loss = qualityWindow(view, options.preference);
  // Large turns: among equal prices the higher score, never a lower effort for its own sake.
  const lowerEffort = view.level !== 'large';
  const eligible = best === null ? [] : scored.filter(entry => value(entry) >= best - loss - 1e-9)
    .sort((a, b) => comparePrice(a, b) || (lowerEffort ? effortRank(a) - effortRank(b) : 0) || value(b) - value(a) || effortRank(a) - effortRank(b) || a.key.localeCompare(b.key));
  const bestEntry = best === null ? null : scored.filter(entry => value(entry) >= best - 1e-9)
    .sort((a, b) => comparePrice(a, b) || effortRank(a) - effortRank(b) || a.key.localeCompare(b.key))[0] ?? null;
  const others = scored.filter(entry => !eligible.includes(entry)).sort((a, b) => value(b) - value(a) || comparePrice(a, b) || a.key.localeCompare(b.key));
  const unknown = conservative(auto.filter(entry => !entry.scores[scoredAs]));
  let list = [...manualFirst, ...eligible, ...others, ...manualRest, ...unknown];
  let why: SelectionReason = manualFirst.length ? 'manual_tier'
    : eligible.length ? (value(eligible[0]!) >= best! - 1e-9 ? (eligible.filter(entry => value(entry) >= best! - 1e-9).length > 1 ? 'cheaper_tie' : 'best_score')
      : bestEntry && comparePrice(eligible[0]!, bestEntry) === 0 && effortRank(eligible[0]!) < effortRank(bestEntry) ? 'lower_effort_within_loss' : 'cheaper_within_loss')
      : manualRest.length ? 'manual_tier_fallback' : 'unknown_scores';
  // The turn's model stays for its tool steps (and a new turn of the same kind keeps the upstream's prompt cache warm
  // when that model is among the first choices anyway).
  if (request.preferred) {
    const kept = list.find(entry => entry.key === request.preferred);
    const firstGroup = manualFirst.length ? manualFirst : eligible.length ? eligible : list;
    if (kept && (request.kind === 'continuation' || firstGroup.includes(kept))) {
      if (kept !== list[0]) why = request.kind === 'continuation' ? 'kept_turn_model' : why;
      list = [kept, ...list.filter(entry => entry !== kept)];
    }
  }
  return { list, why, scoredAs: scored.length ? scoredAs : null, best, loss, bestEntry };
}
