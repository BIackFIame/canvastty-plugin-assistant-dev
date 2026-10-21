/**
 * Measured token usage of this plugin's own cards (CanvasTTY's `usage.summary` / `usage.session`, permission
 * `usage:read`): the cards the Assistant started or set launch options for, so every routed child. Counts only: no
 * text, no paths, no ids. Feature-detected: an older core answers "Unknown host method" and the per-launch estimate
 * stays.
 *
 * - Between two limit reads, what routed children used on a CLI's own sign-in is a share of its window: effective
 *   tokens (cache reads at a tenth, as plans and APIs count them) × the person's expected share per task ÷ a task's
 *   tokens (TASK_TOKENS). That replaces "~2 % per launch".
 * - The agent tree shows each card's measured tokens, priced from the catalog for paid routes, as a plan share for
 *   subscriptions, and OpenCode's own estimate (`providerCostEstimate`) labelled as the agent's estimate.
 *
 * Bounded: CanvasTTY allows 30 calls a minute per plugin; this keeps to 24, caches answers (summaries 30 s, a card
 * 60 s, a finished card for good) and never waits longer than its deadline.
 */
import type { Host } from '../rpc.ts';
import { unsupportedError, within, type PeerMode } from './peers.ts';

export interface UsageCounts { input: number; output: number; cached: number; events: number; providerCostEstimate?: number }
export interface CardUsage { measured: true; totals: UsageCounts; models: Array<UsageCounts & { model: string | null }>; at: number }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

export function countsFrom(value: unknown): UsageCounts | null {
  if (!isRecord(value)) return null;
  const cost = typeof value.providerCostEstimate === 'number' && Number.isFinite(value.providerCostEstimate) && value.providerCostEstimate > 0 && value.providerCostEstimate < 1_000 ? value.providerCostEstimate : undefined;
  return { input: count(value.input), output: count(value.output), cached: Math.min(count(value.cached), count(value.input)), events: count(value.events), ...(cost !== undefined ? { providerCostEstimate: cost } : {}) };
}

/** Tokens as a plan or an API counts them: cache reads at a tenth. */
export const effectiveTokens = (counts: UsageCounts): number => counts.input - counts.cached + counts.cached * 0.1 + counts.output;

/** USD for measured tokens at a catalog price (per million tokens), cache reads at a tenth of the input price. */
export function measuredUsd(counts: UsageCounts, price: { priceIn: number | null; priceOut: number | null } | null): number | null {
  if (!price || (price.priceIn === null && price.priceOut === null)) return null;
  const input = (counts.input - counts.cached + counts.cached * 0.1) * (price.priceIn ?? 0);
  return Math.round(((input + counts.output * (price.priceOut ?? 0)) / 1_000_000) * 10_000) / 10_000;
}

const MAX_CALLS_PER_MINUTE = 24;

export class UsageMeter {
  mode: PeerMode = 'probing';
  private readonly host: Host;
  private readonly now: () => number;
  private readonly calls: number[] = [];
  private readonly summaries = new Map<string, { at: number; rows: Map<string, UsageCounts> }>();
  private readonly cards = new Map<string, CardUsage | { measured: false; at: number }>();
  private readonly finished = new Set<string>();
  private pending = new Map<string, Promise<unknown>>();
  private refusedAt = 0;

  constructor(host: Host, now: () => number = Date.now) { this.host = host; this.now = now; }

  private allowed(): boolean {
    const now = this.now();
    if (this.mode === 'unsupported' && now - this.refusedAt < 30 * 60_000) return false;
    while (this.calls.length && now - this.calls[0]! > 60_000) this.calls.shift();
    if (this.calls.length >= MAX_CALLS_PER_MINUTE) return false;
    this.calls.push(now);
    return true;
  }

  private call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const key = `${method}:${JSON.stringify(params)}`;
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.host.callHost(method, params).then(answer => {
        // Only CanvasTTY's answer shapes count (a summary's rows, a session's `measured`): anything else is not "nothing used".
        if (!isRecord(answer) || (method === 'usage.summary' ? !Array.isArray(answer.rows) : typeof answer.measured !== 'boolean')) { this.mode = 'failing'; throw new Error(`${method}: unknown answer`); }
        this.mode = 'ready';
        return answer;
      }, (error: unknown) => {
        if (unsupportedError(error)) { this.mode = 'unsupported'; this.refusedAt = this.now(); }
        throw error;
      }).finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    return pending;
  }

  /** Per-provider counts of this plugin's cards since `since` (ms); cached 30 s; null when not measured here. */
  async byProviderSince(since: number, deadlineMs = 800): Promise<Map<string, UsageCounts> | null> {
    const key = String(Math.floor(since / 1_000));
    const cached = this.summaries.get(key);
    const now = this.now();
    if (cached && now - cached.at <= 30_000) return cached.rows;
    if (since >= now || now - since > 30 * 24 * 3_600_000) return null;
    if (!this.pending.has(`usage.summary:${JSON.stringify({ since, groupBy: ['provider'] })}`) && !this.allowed()) return cached?.rows ?? null;
    const read = this.call('usage.summary', { since, groupBy: ['provider'] }).then(answer => {
      const rows = new Map<string, UsageCounts>();
      if (isRecord(answer) && Array.isArray(answer.rows)) for (const row of answer.rows.slice(0, 64)) {
        if (!isRecord(row) || typeof row.provider !== 'string') continue;
        const counts = countsFrom(row);
        if (counts) rows.set(row.provider, counts);
      }
      this.summaries.set(key, { at: this.now(), rows });
      while (this.summaries.size > 16) this.summaries.delete(this.summaries.keys().next().value!);
      return rows;
    });
    read.catch(() => undefined);
    return (await within(read, deadlineMs)) ?? cached?.rows ?? null;
  }

  /** The cached answer for a card (no read), or null. */
  peekCard(cardId: string): CardUsage | null {
    const entry = this.cards.get(cardId);
    return entry && entry.measured ? entry : null;
  }

  /** The card ended: its last read after this stays (until the card closes). */
  ended(cardId: string): void { this.finished.add(cardId); while (this.finished.size > 2_048) this.finished.delete(this.finished.values().next().value!); }
  closed(cardId: string): void { this.cards.delete(cardId); this.finished.delete(cardId); }

  /** Reads the cards whose answers are old (60 s; a finished card once more), within the call budget and deadline. */
  async refreshCards(ids: readonly string[], deadlineMs = 1_200): Promise<void> {
    const now = this.now();
    const due = ids.filter(id => {
      const entry = this.cards.get(id);
      if (!entry) return true;
      if (this.finished.has(id)) return entry.at < (now - 60_000) && !('done' in entry);
      return now - entry.at > 60_000;
    }).slice(0, 8);
    const reads = due.map(id => {
      if (!this.allowed()) return Promise.resolve();
      return this.call('usage.session', { cardId: id }).then(answer => {
        const value = isRecord(answer) ? answer : {};
        const totals = value.measured === true ? countsFrom(value.totals) : null;
        if (!totals) { this.cards.set(id, { measured: false, at: this.now() }); return; }
        const models = Array.isArray(value.models) ? value.models.slice(0, 16).map(entry => {
          const counts = countsFrom(entry);
          const model = isRecord(entry) && typeof entry.model === 'string' && entry.model.length <= 120 ? entry.model : null;
          return counts ? { ...counts, model } : null;
        }).filter((entry): entry is UsageCounts & { model: string | null } => entry !== null) : [];
        const usage: CardUsage & { done?: true } = { measured: true, totals, models, at: this.now(), ...(this.finished.has(id) ? { done: true as const } : {}) };
        this.cards.set(id, usage);
        while (this.cards.size > 1_024) this.cards.delete(this.cards.keys().next().value!);
      }, () => undefined);
    });
    await within(Promise.all(reads), deadlineMs);
  }
}
