/**
 * Route decisions and their outcomes, kept in the plugin's data folder (`route/decisions.json`, not the 64 KB
 * storage). A record never holds the task text: only its type and level, the options with their why-lines (built
 * from model ids, plan names and numbers), and what came of it. Outcomes come from the orchestrator (`route_outcome`
 * with what wait_for_agent / get_agent_result said) or from the person (✓/✗ on the settings page); exit lines are
 * classified on arrival and never stored.
 */
import type { Level } from '../auto/select.ts';
import type { TaskType } from '../auto/catalog/scoring.ts';
import type { Estimate, RouteKind } from './engine.ts';
import type { RouteStats } from './engine.ts';

export const MAX_RECORDS = 400;
/** Explored models are judged after this many outcomes. */
export const EXPLORE_JUDGE_AT = 20;

export interface OptionRecord {
  key: string;
  cli: string;
  kind: RouteKind;
  signIn: string;
  label: string;
  model: string | null;
  identity: string | null;
  effort: string | null;
  score: number | null;
  scoreSource: 'measured' | 'provisional' | null;
  cost: number | null;
  costBasis: string;
  estimate: string;
  /** The same estimate as data, for the page in the person's language. */
  estimateData?: Estimate;
  scoreLabel?: string | null;
  /** Points below the best score of the decision (null: none known). */
  below?: number | null;
  why: string;
}

export type OutcomeResult = 'done' | 'failed' | 'limit' | 'cancelled';

export interface RouteRecord {
  id: string;
  at: number;
  /** The orchestrator card, first 8 characters. */
  card: string;
  type: TaskType;
  level: Level;
  typeFrom: 'jev' | 'rules';
  confidence: number | null;
  strategy: 'single-cheap' | 'single-strong';
  cohort: string | null;
  candidates: number;
  dropped: number;
  explored: boolean;
  preferred: boolean;
  options: OptionRecord[];
  /** Which option the orchestrator started, when a subagent of that CLI appeared shortly after. */
  spawned?: { session: string; option: number; at: number; endedAt?: number };
  outcome?: { result: OutcomeResult; ok: boolean; by: 'orchestrator' | 'person'; at: number; tokens?: number };
}

/** Classifies what the orchestrator reports (status words and exit lines); the text itself is not kept. */
export function classifyOutcome(status: string, lines: readonly string[]): OutcomeResult {
  const text = lines.join('\n').slice(0, 8_000);
  if (/\b(?:usage limit|rate limit|rate-limited|quota|too many requests|429|limit reached|hit your limit|hit a usage limit|out of credits|insufficient credits)\b/iu.test(text)) return 'limit';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (status === 'failed' || status === 'error') return 'failed';
  return 'done';
}

export class RouteRecords {
  private list: RouteRecord[];
  private readonly save: (records: RouteRecord[]) => void;
  constructor(saved: unknown, save: (records: RouteRecord[]) => void) {
    this.save = save;
    this.list = Array.isArray(saved) ? saved.filter(isRecord).slice(-MAX_RECORDS) : [];
  }

  add(record: RouteRecord): void {
    this.list.push(record);
    if (this.list.length > MAX_RECORDS) this.list.splice(0, this.list.length - MAX_RECORDS);
    this.save(this.list);
  }

  get(id: string): RouteRecord | undefined { return this.list.find(record => record.id === id); }
  recent(limit = 30): RouteRecord[] { return this.list.slice(-limit).reverse(); }
  all(): readonly RouteRecord[] { return this.list; }
  changed(): void { this.save(this.list); }

  bySession(session: string): RouteRecord | undefined { return [...this.list].reverse().find(record => record.spawned?.session === session.slice(0, 8)); }

  /** The newest record of this orchestrator, not yet matched to a child, that offered this CLI, within `withinMs`. */
  unmatched(card: string, cli: string, now: number, withinMs: number, accept: (record: RouteRecord) => boolean = () => true): { record: RouteRecord; option: number } | null {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const record = this.list[i]!;
      if (now - record.at > withinMs) break;
      if (record.card !== card.slice(0, 8) || record.spawned || !accept(record)) continue;
      const option = record.options.findIndex(entry => entry.cli === cli);
      if (option >= 0) return { record, option };
    }
    return null;
  }

  setOutcome(record: RouteRecord, result: OutcomeResult, by: 'orchestrator' | 'person', at: number, ok?: boolean, tokens?: number): void {
    // The person's word wins over the orchestrator's report; a later report from the orchestrator does not undo it.
    if (record.outcome?.by === 'person' && by === 'orchestrator') return;
    const kept = tokens ?? record.outcome?.tokens;
    record.outcome = { result, ok: ok ?? result === 'done', by, at, ...(kept !== undefined ? { tokens: kept } : {}) };
    this.save(this.list);
  }

  /**
   * Tokens a model really took per task, as a factor of the level's default (median of at least 5 outcomes that
   * reported tokens), or null.
   */
  tokenFactor(identity: string, base: (level: Level) => number): number | null {
    const ratios: number[] = [];
    for (const record of this.list) {
      const option = record.options[record.spawned?.option ?? 0];
      if (option?.identity !== identity || typeof record.outcome?.tokens !== 'number') continue;
      ratios.push(record.outcome.tokens / base(record.level));
    }
    if (ratios.length < 5) return null;
    ratios.sort((a, b) => a - b);
    return Math.round(ratios[Math.floor(ratios.length / 2)]! * 1_000) / 1_000;
  }

  /** Outcomes per route key (the option that ran). */
  routeStats(): Map<string, RouteStats> {
    const stats = new Map<string, RouteStats>();
    for (const record of this.list) {
      if (!record.outcome || record.outcome.result === 'cancelled') continue;
      const option = record.options[record.spawned?.option ?? 0];
      if (!option) continue;
      const s = stats.get(option.key) ?? { n: 0, fail: 0 };
      s.n++; if (!record.outcome.ok) s.fail++;
      stats.set(option.key, s);
    }
    return stats;
  }

  /**
   * Explored models: success against the measured choices of the same type and level. After EXPLORE_JUDGE_AT
   * outcomes, `use` when within 5 points of the incumbent, `retire` when clearly worse (15 points or more).
   */
  exploration(): Array<{ identity: string; n: number; ok: number; incumbent: number | null; verdict: 'pending' | 'use' | 'retire' }> {
    const by = new Map<string, { n: number; ok: number; keys: Set<string> }>();
    const base = new Map<string, { n: number; ok: number }>();
    for (const record of this.list) {
      if (!record.outcome || record.outcome.result === 'cancelled') continue;
      const option = record.options[record.spawned?.option ?? 0];
      if (!option) continue;
      const cell = `${record.type}|${record.level}`;
      if (record.explored && (record.spawned?.option ?? 0) === 0 && option.identity) {
        const e = by.get(option.identity) ?? { n: 0, ok: 0, keys: new Set<string>() };
        e.n++; if (record.outcome.ok) e.ok++; e.keys.add(cell);
        by.set(option.identity, e);
      } else if (!record.explored) {
        const b = base.get(cell) ?? { n: 0, ok: 0 };
        b.n++; if (record.outcome.ok) b.ok++;
        base.set(cell, b);
      }
    }
    return [...by].map(([identity, e]) => {
      let n = 0, ok = 0;
      for (const cell of e.keys) { const b = base.get(cell); if (b) { n += b.n; ok += b.ok; } }
      const incumbent = n ? ok / n : null;
      const rate = e.ok / e.n;
      const verdict = e.n < EXPLORE_JUDGE_AT || incumbent === null ? 'pending' : rate >= incumbent - 0.05 ? 'use' : rate <= incumbent - 0.15 ? 'retire' : 'pending';
      return { identity, n: e.n, ok: e.ok, incumbent: incumbent === null ? null : Math.round(incumbent * 1_000) / 1_000, verdict };
    });
  }
}

function isRecord(value: unknown): value is RouteRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<RouteRecord>;
  return typeof r.id === 'string' && typeof r.at === 'number' && typeof r.card === 'string' && Array.isArray(r.options);
}
