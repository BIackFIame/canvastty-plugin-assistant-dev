import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { DataClassMode } from '../shared/settings.ts';
import { callSeconds, type TaskType } from './catalog/scoring.ts';
import { chooseStrategy, DRAFT_TOKENS, judgeBody, mentionsToolCall, parseAnswer, type ParsedAnswer, type RouteOutcome, type StrategyDecision, type StrategyKind } from './consensus.ts';
import { latestUserText, requestKeys, requestKind, rulesDifficulty, upstreamAllowed, type RequestKind } from './classify.ts';
import type { Inventory, InventoryEntry } from './inventory.ts';
import { plan, turnView, type Level, type SelectionReason, type TurnDecision, type TurnView } from './select.ts';
import { DEFAULT_OUTPUT, type AutoRoutingSettings, type AutoTier, type AutoUpstream } from './settings.ts';
import { hashToken, TokenStore, type LaunchGrant } from './tokens.ts';
import { JevOnlyHosts, modelTrafficForbidden } from './jevOnly.ts';

/**
 * The Auto (Jev) router: an OpenAI Chat Completions endpoint on 127.0.0.1 for agent CLIs started with "Model: Auto
 * (Jev)". It checks the card's per-launch key, decides once per new user turn which allowed model answers (Jev's task
 * triage within 2.5 s gives the task type and difficulty, else word rules; select.ts turns that and the catalog's
 * scores and prices into an ordered list; tool-call continuations keep the turn's choice; small-model calls skip Jev),
 * swaps `model` in the body (and, for an OpenRouter effort variant, adds `reasoning.effort` when the CLI sent none)
 * and passes the request and its stream through unchanged. Before the first byte
 * reaches the CLI it moves to the next candidate on 404/408/409/425/429/5xx, a connect error or a timeout, and cools
 * that model or upstream down; after it, an upstream failure ends the stream with an error and nothing is replayed.
 * Per-card and per-day caps are reserved before a call. The log keeps keyed hashes, models and numbers — never text.
 *
 * Hard text turns may fan out (consensus.ts decides): K drafts buffered in parallel, then a judge's answer streamed to
 * the CLI. A tool call in any draft makes the turn agentic: the single choice's own answer is passed through as it
 * came, the other drafts are stopped, and that conversation is not fanned out again. A failed or late draft is
 * dropped (one left: it is the answer; none: the single path); a failed judge leaves the best draft as the answer.
 * The whole fan-out is reserved against the caps before it starts.
 */

export type DecisionSource = 'jev' | 'rules' | 'lease' | 'small';

export type { TurnDecision } from './select.ts';

export interface RouterDeps {
  /** `<plugin data>/auto`. */
  directory: string | null;
  settings(): AutoRoutingSettings;
  /** Every model Auto may choose from, with prices, limits and scores (cached by the service). */
  inventory(): Inventory;
  dataClassMode(): DataClassMode;
  /** The upstream's key, bound to its origin; null when none is saved (or it is bound elsewhere). */
  key(upstream: AutoUpstream): Promise<string | null>;
  /** Jev's view of a turn (the latest user text only), or null to use the rules; `signal` aborts at the budget. */
  decide?(text: string, grant: LaunchGrant, signal: AbortSignal): Promise<TurnDecision | null>;
  /** A new user turn of the card's first conversation (its latest user text), seen before the decision. */
  turn?(text: string, grant: LaunchGrant): void;
  /** The card's model badge changed (only on a change). */
  badge?(sessionId: string, model: { model: string; tier: Level; source: DecisionSource } | null): void;
  /** OpenRouter is for Jev only: the request-time check of every model call's host (tests pass their own lookup). */
  jevOnly?: JevOnlyHosts;
  /** The person-facing text when no allowed provider is left (localized by the service). */
  noProviderMessage?(): string;
  /** At most this many calls at once on a subscription-like (flat-rate) upstream; null: no such cap. */
  parallelCap?(upstream: AutoUpstream): number | null;
  log?(level: 'info' | 'warn', message: string): void;
  /**
   * An `account` upstream (another extension's account): the call goes through CanvasTTY's broker, which adds the
   * key itself; the answer is a Response like fetch's. `ready` says whether CanvasTTY lists the account now.
   */
  broker?: { send(upstream: AutoUpstream, path: string, init: RequestInit): Promise<Response>; ready(upstream: AutoUpstream): boolean; refresh(): Promise<void> };
  transport?: typeof fetch;
  now?: () => number;
  timeouts?: Partial<RouterTimeouts>;
}

/** `memberMs`: the whole time one buffered draft of a fan-out may take; a later one is dropped from the merge. */
/**
 * `turnMs` / `turnXhighMs`: the whole time one streamed answer may take once it started (xhigh and above reason long).
 * Keep-alive data (SSE comments, blank lines) does not count as progress for `idleMs`.
 */
export interface RouterTimeouts { jevMs: number; headersMs: number; firstChunkMs: number; idleMs: number; totalMs: number; memberMs: number; turnMs: number; turnXhighMs: number }
export const ROUTER_TIMEOUTS: RouterTimeouts = { jevMs: 2_500, headersMs: 60_000, firstChunkMs: 60_000, idleMs: 90_000, totalMs: 15 * 60_000, memberMs: 180_000, turnMs: 120_000, turnXhighMs: 240_000 };
const LONG_EFFORTS = new Set(['xhigh', 'max', 'ultra']);
/** A stream chunk with real data (not only SSE comments such as OpenRouter's keep-alive, or blank lines). */
export const meaningful = (text: string): boolean => text.split('\n').some(line => line.trim() !== '' && !line.startsWith(':'));
export const ROUTER_LIMITS = Object.freeze({ bodyBytes: 32 * 1_048_576, perCard: 16, total: 64, attempts: 6, conversations: 1_024, leaseMs: 30 * 60_000, recent: 50, logBytes: 512 * 1_024, outcomes: 512 });
/** One draft of a fan-out, as recorded (no text). */
export interface DraftRecord { upstream: string; model: string; effort: string | null; status: 'text' | 'tool_calls' | 'failed' | 'timeout' | 'stopped' | 'capped'; http: number | null; ms: number; costUsd: number | null }
export type FanOutOutcome = 'merged' | 'picked' | 'tool_calls' | 'one_draft' | 'no_draft' | 'judge_failed';
export interface FanOutRecord {
  kind: Exclude<StrategyKind, 'single'>;
  estimateUsd: number;
  drafts: DraftRecord[];
  judge: { upstream: string; model: string } | null;
  outcome: FanOutOutcome | null;
}

const NO_PROVIDER = 'Auto (Jev): no model provider is allowed for this card. OpenRouter is used only for Jev\'s own decisions. Add another provider on the Decision models page, or start this card on its agent\'s own model.';

const COOLDOWN_MS = Object.freeze({ transient: 30_000, quota: 300_000, missing: 900_000, auth: 900_000, maxRetryAfter: 24 * 3_600_000 });

export interface DecisionRecord {
  at: number;
  /** The first 8 characters of the card's session id. */
  session: string;
  conversation: string;
  turn: string;
  kind: RequestKind;
  source: DecisionSource;
  /** The turn's level (small, medium, large), or the chosen model's manual tier. */
  tier: AutoTier | null;
  /** The turn's task type and difficulty level, and Jev's confidence in "small" (null: rules, or not asked). */
  taskType: TaskType | null;
  difficulty: Level | null;
  confidence: number | null;
  /** Why this model: a code-authored reason (see select.ts). */
  why: SelectionReason | null;
  /**
   * The trade-off: the points the preference let this turn give up for price, and the best-scored model for the
   * type it was measured against (null: no scores were compared).
   */
  tradeoff: { window: number; bestModel: string; bestEffort: string | null; bestScore: number; bestPriceIn: number | null; bestPriceOut: number | null } | null;
  upstream: string | null;
  model: string | null;
  effort: string | null;
  /** The chosen model's score for the type compared, and where it comes from (null: unknown). */
  score: number | null;
  scoreSource: string | null;
  /** USD per million tokens of the chosen model (null: unknown). */
  priceIn: number | null;
  priceOut: number | null;
  attempts: number;
  failovers: Array<{ upstream: string; model: string; status: number | 'error' | 'timeout' }>;
  status: number;
  /** A code-authored reason (no upstream text). */
  reason: string;
  ttfbMs: number | null;
  totalMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  /** The upstream reported no usage: `costUsd` is estimated from the request and the streamed answer. */
  costEstimated?: boolean;
  /** single / consensus / best-of-n, why (consensus.ts reasons), and the expected-value terms when computed. */
  strategy?: StrategyKind;
  strategyWhy?: string | null;
  ev?: StrategyDecision['ev'];
  /** The fan-out's drafts, judge and outcome (null: none). */
  fanOut?: FanOutRecord | null;
}

export interface RouterStats {
  requests: number; turns: number; continuations: number; small: number;
  jevAsked: number; jevAnswered: number; rules: number; leaseReuses: number; failovers: number;
  /** Fan-outs started, and how they ended. */
  fanOuts: number; merged: number; fanOutToolCalls: number; fanOutDegraded: number; judgeFailed: number;
  /** Hosts the router sent a request to (no paths). */
  hosts: string[];
}

interface Lease { sessionId: string; turn: string; contract: string; view: TurnView; model: string | null; source: DecisionSource; decidedAt: number }

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

const RETRYABLE = new Set([404, 408, 409, 425, 429, 500, 502, 503, 504]);
/** A 400 whose message says the model id itself is unknown (OpenRouter: "… is not a valid model ID"). */
const UNKNOWN_MODEL = /\bis not a valid model id\b|\bmodel\b.{0,80}\b(?:does not exist|not found)\b|\bno endpoints found\b/iu;
const clean = (value: string, max: number): string => value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max);

/** Seconds or an HTTP date, bounded to 24 h; null when absent or not understood. */
export function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(header) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, COOLDOWN_MS.maxRetryAfter) : null;
}

/** Cap reservations: output tokens held before a card has shown its own (OpenCode asks for up to 128k each call). */
export const COLD_OUTPUT_TOKENS = 4_096;
const OUTPUT_SAMPLES_MIN = 3;
const OUTPUT_SAMPLES_MAX = 50;
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

/** Spend per local day and per card, with reservations held while a call runs (no overshoot by parallel calls). */
class Spend {
  private day = '';
  private total = 0;
  /** Paid calls today (kept with the spend, so "today" survives a restart). */
  private calls = 0;
  private held = 0;
  private readonly cards = new Map<string, { spent: number; held: number }>();
  private readonly file: string | null;
  private readonly now: () => number;

  constructor(directory: string | null, now: () => number) {
    this.now = now;
    this.file = directory ? join(directory, 'spend.json') : null;
    try {
      const saved = JSON.parse(readFileSync(this.file!, 'utf8')) as { day?: unknown; total?: unknown; cards?: unknown; calls?: unknown };
      if (saved.day === this.dayKey() && typeof saved.total === 'number' && saved.total >= 0) {
        this.day = saved.day; this.total = saved.total;
        if (Number.isInteger(saved.calls) && (saved.calls as number) >= 0) this.calls = saved.calls as number;
        if (saved.cards && typeof saved.cards === 'object') for (const [id, usd] of Object.entries(saved.cards)) if (typeof usd === 'number' && usd >= 0) this.cards.set(id, { spent: usd, held: 0 });
      }
    } catch { /* nothing saved today */ }
  }

  private dayKey(): string { const d = new Date(this.now()); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
  private roll(): void { const key = this.dayKey(); if (key !== this.day) { this.day = key; this.total = 0; this.calls = 0; this.held = 0; for (const card of this.cards.values()) { card.spent = 0; } } }
  private card(id: string): { spent: number; held: number } { let card = this.cards.get(id); if (!card) { card = { spent: 0, held: 0 }; this.cards.set(id, card); } return card; }

  today(): number { this.roll(); return this.total; }
  callsToday(): number { this.roll(); return this.calls; }
  ofCard(id: string): number { this.roll(); return this.cards.get(id)?.spent ?? 0; }

  /**
   * Holds `estimate` against both caps; throws 402 when either is spent, saying how much is left and what the call
   * needs. The estimate is realistic (see AutoRouter.estimate), and `commit` replaces it with the cost the upstream
   * reported: a call can pass a cap by at most its own error, never by the sum of parallel calls.
   */
  reserve(sessionId: string, estimate: number, caps: { daily: number; perCard: number }): { commit(cost: number | null): void; release(): void } {
    this.roll();
    const card = this.card(sessionId);
    const usd = (value: number): string => `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
    const dayLeft = Math.max(0, caps.daily - this.total - this.held), cardLeft = Math.max(0, caps.perCard - card.spent - card.held);
    if (dayLeft <= 0 || estimate > dayLeft) throw new HttpError(402, 'daily_cap', `Auto (Jev): the daily cap is reached: ${usd(dayLeft)} of ${usd(caps.daily)} left, this call needs about ${usd(estimate)}. Change it on the Decision models page.`);
    if (cardLeft <= 0 || estimate > cardLeft) throw new HttpError(402, 'card_cap', `Auto (Jev): this card's cap is reached: ${usd(cardLeft)} of ${usd(caps.perCard)} left, this call needs about ${usd(estimate)}. Change it on the Decision models page.`);
    this.held += estimate; card.held += estimate;
    let done = false;
    const free = (): void => { if (done) return; done = true; this.held = Math.max(0, this.held - estimate); card.held = Math.max(0, card.held - estimate); };
    return {
      commit: cost => { free(); const usd = cost ?? estimate; this.total += usd; this.calls++; card.spent += usd; this.save(); },
      release: free
    };
  }

  forget(sessionId: string): void { const card = this.cards.get(sessionId); if (card && card.held === 0) this.cards.delete(sessionId); }

  private save(): void {
    if (!this.file) return;
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ day: this.day, total: this.total, calls: this.calls, cards: Object.fromEntries([...this.cards].map(([id, card]) => [id, card.spent])) }), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch { /* kept in memory */ }
  }
}

/** Reads `usage` (and OpenRouter's `cost`) from an SSE stream as it passes, without holding it. */
class UsageReader {
  private rest = '';
  usage: { in: number | null; out: number | null; cost: number | null } = { in: null, out: null, cost: null };
  /** Characters of answer text, reasoning and tool arguments streamed (for an estimate when usage never comes). */
  streamedChars = 0;
  push(text: string): void {
    const lines = (this.rest + text).split('\n');
    this.rest = lines.pop() ?? '';
    if (this.rest.length > 1_048_576) this.rest = '';
    for (const line of lines) this.line(line);
  }
  end(): void { if (this.rest) this.line(this.rest); this.rest = ''; }
  json(value: unknown): void {
    const usage = value && typeof value === 'object' ? (value as { usage?: unknown }).usage : null;
    if (!usage || typeof usage !== 'object') return;
    const u = usage as Record<string, unknown>;
    if (typeof u.prompt_tokens === 'number') this.usage.in = u.prompt_tokens;
    if (typeof u.completion_tokens === 'number') this.usage.out = u.completion_tokens;
    if (typeof u.cost === 'number' && Number.isFinite(u.cost) && u.cost >= 0) this.usage.cost = u.cost;
  }
  private line(line: string): void {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let value: unknown;
    try { value = JSON.parse(data); } catch { return; }
    for (const choice of Array.isArray((value as { choices?: unknown })?.choices) ? (value as { choices: Array<{ delta?: Record<string, unknown> }> }).choices : []) {
      const delta = choice?.delta ?? {};
      for (const key of ['content', 'reasoning', 'reasoning_content']) if (typeof delta[key] === 'string') this.streamedChars += (delta[key] as string).length;
      if (Array.isArray(delta.tool_calls)) for (const call of delta.tool_calls as Array<{ function?: { arguments?: unknown } }>) if (typeof call?.function?.arguments === 'string') this.streamedChars += call.function.arguments.length;
    }
    if (data.includes('"usage"')) this.json(value);
  }
}

export class AutoRouter {
  readonly tokens: TokenStore;
  private readonly deps: RouterDeps;
  private readonly now: () => number;
  private readonly timeouts: RouterTimeouts;
  private readonly transport: typeof fetch;
  private readonly salt: Buffer;
  private readonly spend: Spend;
  private server: Server | null = null;
  private starting: Promise<number> | null = null;
  private port: number | null = null;
  private readonly leases = new Map<string, Lease>();
  private readonly cooldowns = new Map<string, number>();
  /** Output tokens of each card's last calls (memory only), for realistic cap reservations. */
  private readonly outputs = new Map<string, number[]>();
  private readonly active = new Map<string, Set<AbortController>>();
  private activeTotal = 0;
  private readonly shownModel = new Map<string, string>();
  /** Each card's first conversation (keyed hash): the one its new user turns are reported from. */
  private readonly mainConversation = new Map<string, string>();
  private readonly recentRecords: DecisionRecord[] = [];
  private readonly hosts = new Set<string>();
  /** Conversations (keyed hashes) where a fan-out met a tool call: their turns stay single. */
  private readonly agentic = new Set<string>();
  /** Calls running now per upstream (for subscription-like upstreams' parallel cap). */
  private readonly upstreamActive = new Map<string, number>();
  private readonly jevOnly: JevOnlyHosts;
  /** Per-route fan-out outcomes (route key → counts), kept in `fanout-outcomes.json`. */
  private readonly outcomes = new Map<string, RouteOutcome>();
  readonly stats: Omit<RouterStats, 'hosts'> = { requests: 0, turns: 0, continuations: 0, small: 0, jevAsked: 0, jevAnswered: 0, rules: 0, leaseReuses: 0, failovers: 0, fanOuts: 0, merged: 0, fanOutToolCalls: 0, fanOutDegraded: 0, judgeFailed: 0 };

  constructor(deps: RouterDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.timeouts = { ...ROUTER_TIMEOUTS, ...deps.timeouts };
    this.transport = deps.transport ?? fetch;
    if (deps.directory) { try { mkdirSync(deps.directory, { recursive: true, mode: 0o700 }); } catch { /* reads fail below */ } }
    this.tokens = new TokenStore(deps.directory, this.now);
    this.salt = this.loadSalt();
    this.spend = new Spend(deps.directory, this.now);
    this.jevOnly = deps.jevOnly ?? new JevOnlyHosts();
    this.loadOutcomes();
    this.loadRecent();
  }

  /** The last decisions from the log (no text in it), so the page shows them after a restart too. */
  private loadRecent(): void {
    if (!this.deps.directory) return;
    try {
      const lines = readFileSync(join(this.deps.directory, 'decisions.jsonl'), 'utf8').trim().split('\n').slice(-ROUTER_LIMITS.recent);
      for (const line of lines.reverse()) {
        try {
          const record = JSON.parse(line) as DecisionRecord;
          if (record && typeof record.at === 'number' && typeof record.kind === 'string') this.recentRecords.push(record);
        } catch { /* a cut line */ }
      }
    } catch { /* none yet */ }
  }

  private outcomesFile(): string | null { return this.deps.directory ? join(this.deps.directory, 'fanout-outcomes.json') : null; }
  private loadOutcomes(): void {
    try {
      const saved = JSON.parse(readFileSync(this.outcomesFile()!, 'utf8')) as Record<string, unknown>;
      const count = (value: unknown): number => Number.isInteger(value) && (value as number) >= 0 ? value as number : 0;
      for (const [key, raw] of Object.entries(saved).slice(0, ROUTER_LIMITS.outcomes)) {
        if (!raw || typeof raw !== 'object' || key.length > 300) continue;
        const r = raw as Record<string, unknown>;
        this.outcomes.set(key, { n: count(r.n), text: count(r.text), toolCalls: count(r.toolCalls), failed: count(r.failed), timeout: count(r.timeout) });
      }
    } catch { /* none yet */ }
  }
  private noteOutcome(key: string, status: DraftRecord['status']): void {
    if (status === 'stopped' || status === 'capped') return;
    const o = this.outcomes.get(key) ?? { n: 0, text: 0, toolCalls: 0, failed: 0, timeout: 0 };
    o.n++;
    if (status === 'text') o.text++; else if (status === 'tool_calls') o.toolCalls++; else if (status === 'timeout') o.timeout++; else o.failed++;
    this.outcomes.delete(key); this.outcomes.set(key, o);
    while (this.outcomes.size > ROUTER_LIMITS.outcomes) this.outcomes.delete(this.outcomes.keys().next().value!);
    const file = this.outcomesFile();
    if (!file) return;
    try { writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(this.outcomes)), { mode: 0o600 }); renameSync(`${file}.tmp`, file); } catch { /* memory only */ }
  }
  /** Fan-out outcomes per route (route key → counts). */
  routeOutcomes(): Record<string, RouteOutcome> { return Object.fromEntries([...this.outcomes].map(([key, value]) => [key, { ...value }])); }

  private loadSalt(): Buffer {
    const file = this.deps.directory ? join(this.deps.directory, 'salt') : null;
    if (file) {
      try { const saved = readFileSync(file); if (saved.length === 32) return saved; } catch { /* new */ }
    }
    const salt = randomBytes(32);
    if (file) { try { writeFileSync(file, salt, { mode: 0o600 }); } catch { /* in memory */ } }
    return salt;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Listener
  // ---------------------------------------------------------------------------------------------------------------

  get listening(): number | null { return this.server ? this.port : null; }

  private portFile(): string | null { return this.deps.directory ? join(this.deps.directory, 'port') : null; }

  /** Starts the listener (once), on the port used before when it is free. Resolves to the port. */
  start(): Promise<number> {
    if (this.server && this.port) return Promise.resolve(this.port);
    if (this.starting) return this.starting;
    let stored = 0;
    try { const value = Number(readFileSync(this.portFile()!, 'utf8')); if (Number.isInteger(value) && value > 1_023 && value < 65_536) stored = value; } catch { /* none */ }
    const listen = (port: number): Promise<Server> => new Promise((resolve, reject) => {
      const server = createServer((request, response) => { void this.handle(request, response); });
      server.headersTimeout = 30_000;
      server.requestTimeout = 0;
      server.keepAliveTimeout = 5_000;
      server.once('error', reject);
      server.listen({ port, host: '127.0.0.1', exclusive: true }, () => { server.off('error', reject); resolve(server); });
    });
    this.starting = (async () => {
      let server: Server;
      try { server = await listen(stored); } catch { server = await listen(0); }
      this.server = server;
      this.port = (server.address() as AddressInfo).port;
      server.unref();
      if (this.port !== stored) { try { writeFileSync(this.portFile()!, String(this.port), { mode: 0o600 }); } catch { /* next start picks another */ } }
      return this.port;
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  /** Stops listening and aborts every call in flight (service shutdown). */
  async stop(): Promise<void> {
    for (const set of this.active.values()) for (const controller of set) controller.abort();
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  /** Nothing uses the router any more: the port closes (it is reused next time). */
  private idle(): void {
    if (this.tokens.size === 0 && this.activeTotal === 0 && this.server) void this.stop();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Cards
  // ---------------------------------------------------------------------------------------------------------------

  /** A key for one launch (the listener is running before the CLI starts). */
  async grant(grant: Omit<LaunchGrant, 'createdAt'>): Promise<{ token: string; port: number }> {
    const port = await this.start();
    this.dropSession(grant.sessionId, false);
    return { token: this.tokens.mint(grant), port };
  }

  /** The card closed: its key stops working, its calls are aborted, its decisions are forgotten. */
  closeSession(sessionId: string): void {
    this.dropSession(sessionId, true);
    this.idle();
  }

  private dropSession(sessionId: string, revoke: boolean): void {
    if (revoke) this.tokens.revoke(sessionId);
    for (const controller of this.active.get(sessionId) ?? []) controller.abort();
    for (const [key, lease] of this.leases) if (lease.sessionId === sessionId) this.leases.delete(key);
    if (this.shownModel.delete(sessionId)) this.deps.badge?.(sessionId, null);
    this.mainConversation.delete(sessionId);
    this.spend.forget(sessionId);
    this.outputs.delete(sessionId);
  }

  /** Cards CanvasTTY no longer lists lose their keys (after a restart of the service). */
  retainSessions(known: ReadonlySet<string>): void { this.tokens.retain(known); this.idle(); }

  /** Starts the listener again at service start when running cards still hold keys. */
  async resume(): Promise<void> { if (this.tokens.size > 0) await this.start().catch(error => this.deps.log?.('warn', `Auto (Jev): the router could not listen: ${String(error).slice(0, 120)}`)); }

  recent(): DecisionRecord[] { return [...this.recentRecords]; }
  statsView(): RouterStats & { spentToday: number; callsToday: number; listening: boolean; cards: number } {
    return { ...this.stats, hosts: [...this.hosts], spentToday: Math.round(this.spend.today() * 1e6) / 1e6, callsToday: this.spend.callsToday(), listening: !!this.server, cards: this.tokens.size };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Requests
  // ---------------------------------------------------------------------------------------------------------------

  private refuse(response: ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}): void {
    if (response.headersSent) { response.end(); return; }
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    response.end(JSON.stringify({ error: { message, type: 'canvastty_auto', code } }));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      // A browser page (the embedded browser may open localhost) or a rebinding name never gets in: no CORS at all.
      if (request.headers.origin !== undefined) return this.refuse(response, 403, 'origin', 'Requests from web pages are not accepted.');
      const host = String(request.headers.host ?? '').toLowerCase();
      if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return this.refuse(response, 403, 'host', 'Wrong host.');
      const auth = String(request.headers.authorization ?? '');
      const token = /^Bearer (\S+)$/u.exec(auth)?.[1] ?? null;
      const grant = this.tokens.lookup(token);
      if (!grant) { request.resume(); return this.refuse(response, 401, 'invalid_api_key', 'This key is not valid (the card closed or restarted).'); }
      const path = (request.url ?? '').split('?')[0];
      if (request.method === 'GET' && path === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'auto', object: 'model', owned_by: 'canvastty' }, { id: 'auto-small', object: 'model', owned_by: 'canvastty' }] }));
        return;
      }
      if (request.method !== 'POST' || path !== '/v1/chat/completions') { request.resume(); return this.refuse(response, 404, 'not_found', 'Not found.'); }
      await this.complete(request, response, grant, hashToken(token!));
    } catch (error) {
      if (error instanceof HttpError) return this.refuse(response, error.status, error.code, error.message);
      this.deps.log?.('warn', `Auto (Jev): request failed (${error instanceof Error ? error.name : 'error'})`);
      this.refuse(response, 500, 'internal', 'Auto (Jev): the router failed.');
    }
  }

  private readBody(request: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > ROUTER_LIMITS.bodyBytes) { reject(new HttpError(413, 'too_large', 'The request is larger than 32 MB.')); request.destroy(); return; }
        chunks.push(chunk);
      });
      request.on('end', () => resolve(Buffer.concat(chunks)));
      request.on('error', reject);
    });
  }

  private coolingDown = (upstreamId: string, modelId: string): boolean => {
    const now = this.now();
    for (const key of [upstreamId, `${upstreamId}|${modelId}`]) {
      const until = this.cooldowns.get(key);
      if (until !== undefined) { if (until > now) return true; this.cooldowns.delete(key); }
    }
    return false;
  };

  private cool(key: string, ms: number): void { this.cooldowns.set(key, this.now() + ms); }

  /** Jev within its budget, else rules; never fails the request. */
  private async decideTurn(text: string, grant: LaunchGrant, toolCount: number): Promise<{ view: TurnView; source: 'jev' | 'rules'; reason: string }> {
    const settings = this.deps.settings();
    const rules = (reason: string): { view: TurnView; source: 'rules'; reason: string } => ({ view: turnView({ difficulty: rulesDifficulty(text, toolCount), strong: false }, 'rules', text, { role: grant.role }), source: 'rules', reason });
    if (settings.decider === 'jev' && this.deps.decide && text) {
      this.stats.jevAsked++;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const answer = await Promise.race([
          this.deps.decide(text, grant, controller.signal),
          new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, this.timeouts.jevMs); })
        ]);
        if (answer) { this.stats.jevAnswered++; return { view: turnView(answer, 'jev', text, { role: grant.role }), source: 'jev', reason: 'jev' }; }
        return rules(controller.signal.aborted ? 'jev_slow' : 'jev_unavailable');
      } catch {
        return rules('jev_error');
      } finally { if (timer) clearTimeout(timer); }
    }
    return rules(settings.decider === 'rules' ? 'rules_only' : 'no_text');
  }

  /** An account upstream only while CanvasTTY's broker lists it (granted and offered); every other one always. */
  private reachable(upstream: AutoUpstream): boolean {
    return upstream.preset !== 'account' || (this.deps.broker?.ready(upstream) ?? false);
  }

  /** The model call: fetch for a direct upstream, CanvasTTY's broker for another extension's account. */
  private send(upstream: AutoUpstream, url: string, init: RequestInit): Promise<Response> {
    if (upstream.preset !== 'account') return this.transport(url, init);
    if (!this.deps.broker) return Promise.reject(new Error('No broker for account upstreams.'));
    return this.deps.broker.send(upstream, '/chat/completions', init);
  }

  /** Who may take this request now: enabled, allowed, trusted with the card's class, not cooling down, large enough. */
  private usable(grant: LaunchGrant, promptTokens: number, maxTokens: unknown): InventoryEntry[] {
    const mode = this.deps.dataClassMode();
    const healthy = this.deps.inventory().entries.filter(entry => entry.upstream.enabled && !entry.excluded && !modelTrafficForbidden(entry.upstream.baseUrl)
      && this.reachable(entry.upstream) && upstreamAllowed(entry.upstream, grant.dataClass, mode) && !this.coolingDown(entry.upstream.id, entry.model));
    // A model whose known context or output is too small for this request is left out, unless none would remain.
    const wanted = typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 0;
    const fits = healthy.filter(entry => (entry.context === null || entry.context >= promptTokens + Math.min(wanted, 4_096)) && (entry.output === null || !wanted || entry.output >= Math.min(wanted, 32_768)));
    return fits.length ? fits : healthy;
  }

  private async complete(request: IncomingMessage, response: ServerResponse, grant: LaunchGrant, tokenHash: string): Promise<void> {
    const started = this.now();
    const raw = await this.readBody(request);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>; } catch { throw new HttpError(400, 'invalid_json', 'The request body is not JSON.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_json', 'The request body is not a JSON object.');
    if (body.model !== 'auto' && body.model !== 'auto-small') throw new HttpError(400, 'model_not_found', 'Auto (Jev) answers the models "auto" and "auto-small" only.');
    const sessionSet = this.active.get(grant.sessionId) ?? new Set<AbortController>();
    if (sessionSet.size >= ROUTER_LIMITS.perCard || this.activeTotal >= ROUTER_LIMITS.total) throw new HttpError(429, 'busy', 'Auto (Jev): too many calls at once; try again.');
    const controller = new AbortController();
    sessionSet.add(controller); this.active.set(grant.sessionId, sessionSet); this.activeTotal++;
    const total = setTimeout(() => controller.abort(), this.timeouts.totalMs);
    response.on('close', () => { if (!response.writableFinished) controller.abort(); });
    this.stats.requests++;
    const settings = this.deps.settings();
    const kind = requestKind(body, body.model === 'auto-small');
    this.stats[kind === 'small' ? 'small' : kind === 'turn' ? 'turns' : 'continuations']++;
    const keys = requestKeys(this.salt, tokenHash, body);
    const record: DecisionRecord = {
      at: started, session: grant.sessionId.slice(0, 8), conversation: keys.conversation, turn: keys.turn, kind, source: 'small', tier: null,
      taskType: null, difficulty: null, confidence: null, why: null, tradeoff: null, upstream: null, model: null, effort: null, score: null, scoreSource: null, priceIn: null, priceOut: null,
      attempts: 0, failovers: [], status: 0, reason: '', ttfbMs: null, totalMs: 0, tokensIn: null, tokensOut: null, costUsd: null,
      strategy: 'single', strategyWhy: null, ev: null, fanOut: null
    };
    try {
      // The decision: small calls the cheapest model; a continuation keeps its turn's choice; a new turn asks once.
      let request: Parameters<typeof plan>[1];
      if (kind === 'small') {
        request = { kind: 'small' }; record.reason = 'small_model';
      } else {
        const lease = this.leases.get(keys.conversation);
        const fresh = lease && lease.contract === keys.contract && this.now() - lease.decidedAt < ROUTER_LIMITS.leaseMs;
        let view: TurnView;
        let preferred: string | null;
        if (lease && fresh && (kind === 'continuation' || lease.turn === keys.turn)) {
          view = lease.view; preferred = lease.model; record.source = 'lease'; record.reason = 'same_turn'; this.stats.leaseReuses++;
        } else {
          const text = latestUserText(body);
          // Only the card's first conversation is the one the card was given: a later one (a CLI's own helper agent,
          // whose "user" text the agent wrote) never counts as the card's task.
          const main = this.mainConversation.get(grant.sessionId) ?? keys.conversation;
          this.mainConversation.set(grant.sessionId, main);
          while (this.mainConversation.size > ROUTER_LIMITS.conversations) this.mainConversation.delete(this.mainConversation.keys().next().value!);
          try { if (text && main === keys.conversation) this.deps.turn?.(text, grant); } catch { /* advisory only */ }
          const decided = await this.decideTurn(text, grant, Array.isArray(body.tools) ? body.tools.length : 0);
          if (controller.signal.aborted) throw new HttpError(499, 'aborted', 'The call was cancelled.');
          if (decided.source === 'rules') this.stats.rules++;
          view = decided.view;
          // Staying on the conversation's model for a turn of the same kind keeps the upstream's prompt cache warm.
          preferred = lease && lease.view.level === view.level && lease.view.type === view.type ? lease.model : null;
          record.source = decided.source; record.reason = decided.reason;
        }
        record.taskType = view.type; record.difficulty = view.level; record.confidence = view.confidence;
        request = { kind: record.source === 'lease' ? 'continuation' : 'turn', view, preferred };
        this.leases.delete(keys.conversation);
        this.leases.set(keys.conversation, { sessionId: grant.sessionId, turn: keys.turn, contract: keys.contract, view, model: preferred, source: record.source, decidedAt: record.source === 'lease' && lease ? lease.decidedAt : this.now() });
        while (this.leases.size > ROUTER_LIMITS.conversations) this.leases.delete(this.leases.keys().next().value!);
      }
      // Which accounts CanvasTTY brokers for this plugin now (cached for seconds; nothing on an older core).
      if (settings.upstreams.some(upstream => upstream.enabled && upstream.preset === 'account')) await this.deps.broker?.refresh().catch(() => undefined);
      const chosen = plan(this.usable(grant, Math.ceil(raw.length / 4), body.max_tokens), request, { preference: settings.preference, cheaperFallback: settings.cheaperFallback });
      record.why = chosen.why;
      if (chosen.bestEntry && chosen.best !== null) {
        const top = chosen.bestEntry;
        record.tradeoff = { window: chosen.loss, bestModel: top.model, bestEffort: top.effort, bestScore: Math.round(chosen.best * 1_000) / 1_000, bestPriceIn: top.priceIn, bestPriceOut: top.priceOut };
      }
      record.tier = request.kind === 'small' ? 'small' : request.view.level;
      const list = chosen.list;
      if (!list.length) throw new HttpError(503, 'no_model', this.deps.inventory().entries.some(entry => entry.upstream.enabled && !entry.excluded && !modelTrafficForbidden(entry.upstream.baseUrl))
        ? 'Auto (Jev): no allowed model is available now (all are off, excluded, cooling down or not allowed for this card\'s data class).'
        : this.deps.noProviderMessage?.() ?? NO_PROVIDER);
      if (request.kind === 'turn' && kind === 'turn') {
        const typical = this.typicalOutput(grant.sessionId, body.max_tokens);
        const decision = chooseStrategy({
          plan: chosen, view: request.view, role: grant.role, agentic: this.agentic.has(keys.conversation), settings: settings.strategy, preference: settings.preference,
          estimate: entry => this.estimate(entry, raw.length, body.max_tokens, grant.sessionId),
          seconds: entry => callSeconds(entry.speed, typical),
          busy: upstream => this.upstreamActive.get(upstream.id) ?? 0,
          parallelCap: upstream => this.deps.parallelCap?.(upstream) ?? null,
          outcome: key => this.outcomes.get(key)
        });
        record.strategyWhy = decision.reason; record.ev = decision.ev;
        if (decision.kind !== 'single') {
          await this.fanOut(decision, list, body, raw.length, grant, response, controller, record, keys.conversation, chosen.scoredAs);
          return;
        }
      }
      await this.forward(list.slice(0, ROUTER_LIMITS.attempts), body, grant, response, controller, record, kind, keys.conversation, chosen.scoredAs);
    } catch (error) {
      if (error instanceof HttpError) {
        record.status = error.status; record.reason ||= error.code;
        if (error.status !== 499) this.refuse(response, error.status, error.code, error.message);
        else response.destroy();
      } else {
        record.status = 500; record.reason = 'internal';
        this.refuse(response, 500, 'internal', 'Auto (Jev): the router failed.');
      }
    } finally {
      clearTimeout(total);
      sessionSet.delete(controller); this.activeTotal--;
      if (!sessionSet.size) this.active.delete(grant.sessionId);
      record.totalMs = this.now() - started;
      this.remember(record);
      this.idle();
    }
  }

  /**
   * The reservation for one call: its input at the input price, plus the output this card's calls really produce
   * (the 90th percentile of its last outputs; 4k tokens until 3 were seen), never more than the call's own
   * max_tokens. Holding the full max_tokens (128k on OpenCode) made a card stop at a cap long before it was spent.
   */
  estimate(entry: InventoryEntry, bodyBytes: number, maxTokens: unknown, sessionId?: string): number {
    const limit = typeof maxTokens === 'number' && maxTokens > 0 ? Math.min(maxTokens, 32_768) : entry.output ?? DEFAULT_OUTPUT;
    const output = Math.min(limit, Math.max(1, this.typicalOutput(sessionId, undefined)));
    return ((bodyBytes / 4) * (entry.priceIn ?? 0) + output * (entry.priceOut ?? 0)) / 1e6;
  }

  /** The card's p90 output tokens (4k until 3 calls were seen), bounded by max_tokens when given. */
  private typicalOutput(sessionId: string | undefined, maxTokens: unknown): number {
    const seen = sessionId ? this.outputs.get(sessionId) ?? [] : [];
    const typical = seen.length >= OUTPUT_SAMPLES_MIN ? percentile(seen, 0.9) : COLD_OUTPUT_TOKENS;
    return typeof maxTokens === 'number' && maxTokens > 0 ? Math.min(typical, maxTokens) : typical;
  }

  /** The output tokens a finished call reported, for this card's next reservations. */
  private sawOutput(sessionId: string, tokens: number | null): void {
    if (tokens === null || !Number.isFinite(tokens) || tokens < 0) return;
    const list = this.outputs.get(sessionId) ?? [];
    list.push(tokens);
    if (list.length > OUTPUT_SAMPLES_MAX) list.splice(0, list.length - OUTPUT_SAMPLES_MAX);
    this.outputs.set(sessionId, list);
  }

  private costOf(entry: InventoryEntry, usage: UsageReader['usage']): number | null {
    if (usage.cost !== null) return usage.cost;
    if (usage.in === null && usage.out === null) return null;
    if (entry.priceIn === null && entry.priceOut === null) return null;
    return ((usage.in ?? 0) * (entry.priceIn ?? 0) + (usage.out ?? 0) * (entry.priceOut ?? 0)) / 1e6;
  }

  private async forward(list: InventoryEntry[], body: Record<string, unknown>, grant: LaunchGrant, response: ServerResponse, controller: AbortController, record: DecisionRecord, kind: RequestKind, conversation: string, scoredAs: TaskType | null): Promise<void> {
    const settings = this.deps.settings();
    const stream = body.stream === true;
    let lastStatus = 503;
    let lastCode = 'no_upstream';
    let capped: HttpError | null = null;
    let jevOnlySkipped = false;
    for (const entry of list) {
      const candidate = { upstream: entry.upstream, model: { id: entry.model } };
      if (controller.signal.aborted) throw new HttpError(499, 'aborted', 'The call was cancelled.');
      if (this.coolingDown(candidate.upstream.id, candidate.model.id)) continue;
      record.attempts++;
      const failover = (status: number | 'error' | 'timeout', cooldownKey: string, ms: number, code: string): void => {
        this.cool(cooldownKey, ms);
        record.failovers.push({ upstream: candidate.upstream.id, model: candidate.model.id, status });
        this.stats.failovers++;
        lastStatus = typeof status === 'number' ? status : 504;
        lastCode = code;
      };
      // OpenRouter carries only Jev's decisions: never a model call there, whatever the settings or inventory say.
      if (await this.jevOnly.forbidden(`${candidate.upstream.baseUrl}/chat/completions`)) { record.attempts--; jevOnlySkipped = true; continue; }
      const key = candidate.upstream.key === 'none' ? null : await this.deps.key(candidate.upstream).catch(() => null);
      if (candidate.upstream.key !== 'none' && !key) { failover('error', candidate.upstream.id, COOLDOWN_MS.auth, 'no_key'); continue; }
      // An OpenRouter effort variant: the effort it was scored at is sent, unless the CLI chose one itself.
      const effort = entry.sendEffort && entry.effort && body.reasoning === undefined && body.reasoning_effort === undefined ? { reasoning: { effort: entry.effort } } : {};
      const payload = Buffer.from(JSON.stringify({ ...body, model: candidate.model.id, ...effort }), 'utf8');
      let reservation: ReturnType<Spend['reserve']>;
      try {
        reservation = this.spend.reserve(grant.sessionId, this.estimate(entry, payload.length, body.max_tokens, grant.sessionId), { daily: settings.dailyUsdCap, perCard: settings.perCardUsdCap });
      } catch (error) {
        // Over a cap with this model's estimate: a cheaper model further down may still fit.
        if (error instanceof HttpError && error.status === 402) { capped ??= error; record.attempts--; continue; }
        throw error;
      }
      const attempt = new AbortController();
      const relay = (): void => attempt.abort();
      controller.signal.addEventListener('abort', relay, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => attempt.abort(), stream ? this.timeouts.headersMs : this.timeouts.totalMs);
      let sent = false;
      const usage = new UsageReader();
      this.busyUpstream(candidate.upstream.id, 1);
      try {
        const url = `${candidate.upstream.baseUrl}/chat/completions`;
        this.hosts.add(new URL(url).host);
        let upstream: Response;
        try {
          upstream = await this.send(candidate.upstream, url, {
            method: 'POST', body: payload, signal: attempt.signal, redirect: 'error',
            headers: { 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }
          });
        } catch {
          reservation.release();
          if (controller.signal.aborted) throw new HttpError(499, 'aborted', 'The call was cancelled.');
          // No answer in time: that model; no connection at all: the whole upstream.
          const timedOut = attempt.signal.aborted;
          failover(timedOut ? 'timeout' : 'error', timedOut ? `${candidate.upstream.id}|${candidate.model.id}` : candidate.upstream.id, COOLDOWN_MS.transient, timedOut ? 'timeout' : 'connect');
          continue;
        }
        if (!upstream.ok) {
          const status = upstream.status;
          const detail = await upstream.text().then(text => upstreamMessage(text), () => '');
          reservation.release();
          if (status === 401 || status === 403) { failover(status, candidate.upstream.id, COOLDOWN_MS.auth, 'auth'); continue; }
          // OpenRouter answers an unknown model id with 400 ("<id> is not a valid model ID"), not 404: that is this
          // model missing, not a bad payload, so the next candidate is tried and this one cools down like a 404.
          if (status === 400 && UNKNOWN_MODEL.test(detail)) { failover(status, `${candidate.upstream.id}|${candidate.model.id}`, COOLDOWN_MS.missing, 'model_not_found'); continue; }
          if (RETRYABLE.has(status)) {
            const ms = status === 429 ? retryAfterMs(upstream.headers.get('retry-after'), this.now()) ?? COOLDOWN_MS.quota : status === 404 ? COOLDOWN_MS.missing : COOLDOWN_MS.transient;
            failover(status, `${candidate.upstream.id}|${candidate.model.id}`, ms, status === 429 ? 'rate_limited' : status === 404 ? 'model_not_found' : 'upstream_error');
            continue;
          }
          // A bad payload stops here: the next model would refuse it too.
          record.upstream = candidate.upstream.id; record.model = candidate.model.id;
          throw new HttpError(status, 'upstream_rejected', `Auto (Jev): ${candidate.model.id} refused the request (${status})${detail ? `: ${detail}` : ''}.`);
        }
        const reader = upstream.body?.getReader();
        if (!reader) { reservation.release(); failover('error', `${candidate.upstream.id}|${candidate.model.id}`, COOLDOWN_MS.transient, 'empty'); continue; }
        // Nothing reaches the CLI before the first chunk: until then another model can still answer.
        clearTimeout(timer);
        timer = setTimeout(() => attempt.abort(), stream ? this.timeouts.firstChunkMs : this.timeouts.totalMs);
        let first: ReadableStreamReadResult<Uint8Array>;
        try { first = await reader.read(); } catch {
          reservation.release();
          if (controller.signal.aborted) throw new HttpError(499, 'aborted', 'The call was cancelled.');
          failover(attempt.signal.aborted ? 'timeout' : 'error', `${candidate.upstream.id}|${candidate.model.id}`, COOLDOWN_MS.transient, attempt.signal.aborted ? 'timeout' : 'stream_error');
          continue;
        }
        if (first.done || !first.value?.length) { reservation.release(); failover('error', `${candidate.upstream.id}|${candidate.model.id}`, COOLDOWN_MS.transient, 'empty'); continue; }
        record.upstream = candidate.upstream.id; record.model = candidate.model.id; record.effort = entry.effort;
        if (entry.tier) record.tier = entry.tier;
        record.priceIn = entry.priceIn; record.priceOut = entry.priceOut;
        const score = scoredAs ? entry.scores[scoredAs] : undefined;
        record.score = score?.value ?? null; record.scoreSource = score ? `${score.label}${scoredAs !== record.taskType ? ` (${scoredAs})` : ''}${score.historical ? ', old' : ''}` : null;
        record.ttfbMs = this.now() - record.at;
        if (kind !== 'small') {
          const lease = this.leases.get(conversation);
          if (lease) lease.model = entry.key;
          this.showModel(grant.sessionId, entry.model, (record.difficulty ?? 'medium'), record.source);
        }
        sent = true;
        response.writeHead(200, { 'content-type': upstream.headers.get('content-type') ?? (stream ? 'text/event-stream' : 'application/json'), 'cache-control': 'no-cache' });
        const decoder = new TextDecoder();
        const chunks: string[] = [];
        const take = (bytes: Uint8Array): void => {
          if (stream) usage.push(decoder.decode(bytes, { stream: true }));
          else chunks.push(decoder.decode(bytes, { stream: true }));
        };
        take(first.value);
        response.write(first.value);
        let failed = false;
        let stalled: 'idle' | 'deadline' | null = null;
        // Progress is real data only: keep-alive comments do not hold the idle timer off. The whole answer has its
        // own deadline from the first byte (longer for the long-reasoning efforts).
        const idle = (): void => { clearTimeout(timer); timer = setTimeout(() => { stalled ??= 'idle'; attempt.abort(); }, stream ? this.timeouts.idleMs : this.timeouts.totalMs); };
        idle();
        const turnLimit = entry.effort && LONG_EFFORTS.has(entry.effort) ? this.timeouts.turnXhighMs : this.timeouts.turnMs;
        const deadline = setTimeout(() => { stalled ??= 'deadline'; attempt.abort(); }, stream ? turnLimit : this.timeouts.totalMs);
        try {
          for (;;) {
            let next: ReadableStreamReadResult<Uint8Array>;
            try { next = await reader.read(); } catch { failed = true; break; }
            if (next.done) break;
            if (stalled) { failed = true; break; }
            take(next.value);
            if (!stream || meaningful(Buffer.from(next.value).toString('utf8'))) idle();
            if (!response.write(next.value)) await new Promise<void>(resolve => { response.once('drain', resolve); response.once('close', resolve); });
            if (response.destroyed) { failed = true; break; }
          }
        } finally { clearTimeout(deadline); }
        if (stream) usage.end(); else { try { usage.json(JSON.parse(chunks.join(''))); } catch { /* no usage */ } }
        record.tokensIn = usage.usage.in; record.tokensOut = usage.usage.out;
        this.sawOutput(grant.sessionId, usage.usage.out);
        let cost = this.costOf(entry, usage.usage);
        if (cost === null && (entry.priceIn !== null || entry.priceOut !== null)) {
          // No usage came (a cut or stalled stream): the input at its price and what streamed at the output price, so
          // the day's spend is not counted low; marked as an estimate.
          cost = ((payload.length / 4) * (entry.priceIn ?? 0) + (usage.streamedChars / 4) * (entry.priceOut ?? 0)) / 1e6;
          record.costEstimated = true;
          record.tokensOut ??= Math.ceil(usage.streamedChars / 4);
        }
        record.costUsd = cost;
        reservation.commit(cost);
        if (failed && !controller.signal.aborted && !response.destroyed) {
          // Never replayed: the CLI got part of an answer; it sees an error and decides itself.
          const message = stalled === 'deadline' ? 'Auto (Jev): the answer took longer than this turn may take; it was ended.' : stalled === 'idle' ? 'Auto (Jev): the upstream sent nothing new for too long; the answer was ended.' : 'Auto (Jev): the upstream stopped in the middle of the answer.';
          response.write(stream ? `data: ${JSON.stringify({ error: { message, type: 'canvastty_auto', code: stalled === 'deadline' ? 'turn_deadline' : stalled === 'idle' ? 'upstream_idle' : 'upstream_interrupted' } })}\n\ndata: [DONE]\n\n` : '');
          record.status = stalled === 'deadline' ? 504 : 502; if (stalled) record.reason = stalled === 'deadline' ? 'turn_deadline' : 'upstream_idle'; else record.reason ||= 'interrupted';
        } else record.status = controller.signal.aborted ? 499 : 200;
        response.end();
        return;
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', relay);
        if (!sent) attempt.abort();
        this.busyUpstream(candidate.upstream.id, -1);
      }
    }
    if (capped && record.attempts === 0) throw capped;
    if (jevOnlySkipped && record.attempts === 0) throw new HttpError(503, 'no_provider', this.deps.noProviderMessage?.() ?? NO_PROVIDER);
    throw new HttpError(lastStatus === 429 ? 429 : 503, lastCode, `Auto (Jev): no allowed model answered (last: ${lastCode}). It tries again on the next call.`);
  }

  private busyUpstream(id: string, delta: number): void {
    const next = (this.upstreamActive.get(id) ?? 0) + delta;
    if (next > 0) this.upstreamActive.set(id, next); else this.upstreamActive.delete(id);
  }

  /** The cooldown an upstream answer earns (the same classes as `forward`). */
  private coolFor(entry: InventoryEntry, status: number, retryAfter: string | null, detail: string): void {
    const model = `${entry.upstream.id}|${entry.model}`;
    if (status === 401 || status === 403) this.cool(entry.upstream.id, COOLDOWN_MS.auth);
    else if (status === 400 && UNKNOWN_MODEL.test(detail)) this.cool(model, COOLDOWN_MS.missing);
    else if (status === 429) this.cool(model, retryAfterMs(retryAfter, this.now()) ?? COOLDOWN_MS.quota);
    else if (status === 404) this.cool(model, COOLDOWN_MS.missing);
    else if (RETRYABLE.has(status)) this.cool(model, COOLDOWN_MS.transient);
  }

  /**
   * One draft of a fan-out: the CLI's own request to one model, buffered whole (nothing reaches the CLI). `stop`
   * aborts it on purpose (another draft called a tool); the deadline (`memberMs`) and the usual header, first-chunk
   * and idle timeouts drop a late one. `onToolCall` fires once when its stream starts a tool call.
   */
  private async draft(entry: InventoryEntry, body: Record<string, unknown>, stop: AbortSignal, onToolCall: () => void): Promise<{ record: DraftRecord; bytes: Buffer | null; contentType: string | null; parsed: ParsedAnswer | null }> {
    const started = this.now();
    const record: DraftRecord = { upstream: entry.upstream.id, model: entry.model, effort: entry.effort, status: 'failed', http: null, ms: 0, costUsd: null };
    const done = (status: DraftRecord['status'], extra: { bytes?: Buffer | null; contentType?: string | null; parsed?: ParsedAnswer | null } = {}) => {
      record.status = status; record.ms = this.now() - started;
      return { record, bytes: extra.bytes ?? null, contentType: extra.contentType ?? null, parsed: extra.parsed ?? null };
    };
    if (await this.jevOnly.forbidden(`${entry.upstream.baseUrl}/chat/completions`)) return done('failed');
    const key = entry.upstream.key === 'none' ? null : await this.deps.key(entry.upstream).catch(() => null);
    if (entry.upstream.key !== 'none' && !key) { this.cool(entry.upstream.id, COOLDOWN_MS.auth); return done('failed'); }
    const effort = entry.sendEffort && entry.effort && body.reasoning === undefined && body.reasoning_effort === undefined ? { reasoning: { effort: entry.effort } } : {};
    const stream = body.stream === true;
    const attempt = new AbortController();
    const relay = (): void => attempt.abort();
    stop.addEventListener('abort', relay, { once: true });
    let late = false;
    const deadline = setTimeout(() => { late = true; attempt.abort(); }, this.timeouts.memberMs);
    let step: ReturnType<typeof setTimeout> | undefined = setTimeout(() => { late = true; attempt.abort(); }, stream ? this.timeouts.headersMs : this.timeouts.memberMs);
    const url = `${entry.upstream.baseUrl}/chat/completions`;
    this.hosts.add(new URL(url).host);
    this.busyUpstream(entry.upstream.id, 1);
    const chunks: Buffer[] = [];
    try {
      let upstream: Response;
      try {
        upstream = await this.send(entry.upstream, url, { method: 'POST', body: Buffer.from(JSON.stringify({ ...body, model: entry.model, ...effort }), 'utf8'), signal: attempt.signal, redirect: 'error',
          headers: { 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) } });
      } catch {
        if (stop.aborted && !late) return done('stopped');
        this.cool(late ? `${entry.upstream.id}|${entry.model}` : entry.upstream.id, COOLDOWN_MS.transient);
        return done(late ? 'timeout' : 'failed');
      }
      record.http = upstream.status;
      if (!upstream.ok) {
        const detail = await upstream.text().then(text => upstreamMessage(text), () => '');
        this.coolFor(entry, upstream.status, upstream.headers.get('retry-after'), detail);
        return done('failed');
      }
      const reader = upstream.body?.getReader();
      if (!reader) return done('failed');
      const decoder = new TextDecoder();
      let tail = '';
      let first = true;
      let called = false;
      for (;;) {
        clearTimeout(step);
        step = setTimeout(() => { late = true; attempt.abort(); }, stream ? (first ? this.timeouts.firstChunkMs : this.timeouts.idleMs) : this.timeouts.memberMs);
        let next: ReadableStreamReadResult<Uint8Array>;
        try { next = await reader.read(); } catch {
          if (stop.aborted && !late) return done('stopped');
          if (late) this.cool(`${entry.upstream.id}|${entry.model}`, COOLDOWN_MS.transient);
          return done(late ? 'timeout' : 'failed');
        }
        if (next.done) break;
        first = false;
        chunks.push(Buffer.from(next.value));
        // A tool call may be split across chunks: look at the last bit of the previous one too.
        const text = decoder.decode(next.value, { stream: true });
        if (!called && mentionsToolCall(tail + text)) { called = true; onToolCall(); }
        tail = text.slice(-64);
      }
      const bytes = Buffer.concat(chunks);
      const parsed = parseAnswer(bytes.toString('utf8'));
      record.costUsd = this.costOf(entry, parsed.usage);
      const status = parsed.toolCalls ? 'tool_calls' : parsed.text.trim() ? 'text' : 'failed';
      return done(status, { bytes, contentType: upstream.headers.get('content-type'), parsed });
    } finally {
      clearTimeout(deadline); clearTimeout(step);
      stop.removeEventListener('abort', relay);
      attempt.abort();
      this.busyUpstream(entry.upstream.id, -1);
    }
  }

  /** A buffered draft becomes the answer, byte for byte. */
  private replay(entry: InventoryEntry, answer: { bytes: Buffer | null; contentType: string | null; parsed: ParsedAnswer | null }, body: Record<string, unknown>, response: ServerResponse, grant: LaunchGrant, record: DecisionRecord, conversation: string, scoredAs: TaskType | null): void {
    record.upstream = entry.upstream.id; record.model = entry.model; record.effort = entry.effort;
    record.priceIn = entry.priceIn; record.priceOut = entry.priceOut;
    const score = scoredAs ? entry.scores[scoredAs] : undefined;
    record.score = score?.value ?? null; record.scoreSource = score ? `${score.label}${scoredAs !== record.taskType ? ` (${scoredAs})` : ''}${score.historical ? ', old' : ''}` : null;
    record.tokensIn = answer.parsed?.usage.in ?? null; record.tokensOut = answer.parsed?.usage.out ?? null;
    record.ttfbMs = this.now() - record.at;
    const lease = this.leases.get(conversation);
    if (lease) lease.model = entry.key;
    this.showModel(grant.sessionId, entry.model, record.difficulty ?? 'large', record.source);
    response.writeHead(200, { 'content-type': answer.contentType ?? (body.stream === true ? 'text/event-stream' : 'application/json'), 'cache-control': 'no-cache' });
    response.end(answer.bytes ?? Buffer.alloc(0));
    record.status = 200;
  }

  /**
   * A fan-out: every draft and the judge are reserved against the caps first (a draft that does not fit is left out;
   * the single choice not fitting, or the judge, ends the fan-out before anything is sent). The drafts run in
   * parallel, buffered. Then: a tool call anywhere → the single choice's answer as it came (the others are stopped);
   * no draft → the single path; one → it; two or more → the judge's answer, streamed (a failed judge → the best draft).
   */
  private async fanOut(decision: StrategyDecision, list: InventoryEntry[], body: Record<string, unknown>, bodyBytes: number, grant: LaunchGrant, response: ServerResponse, controller: AbortController, record: DecisionRecord, conversation: string, scoredAs: TaskType | null): Promise<void> {
    const settings = this.deps.settings();
    const caps = { daily: settings.dailyUsdCap, perCard: settings.perCardUsdCap };
    const kind = decision.kind as FanOutRecord['kind'];
    const fan: FanOutRecord = { kind, estimateUsd: decision.estimateUsd, drafts: [], judge: null, outcome: null };
    record.fanOut = fan; record.strategy = kind;
    const single = (why: string): Promise<void> => {
      record.strategy = 'single'; record.strategyWhy = why; record.fanOut = null;
      return this.forward(list.slice(0, ROUTER_LIMITS.attempts), body, grant, response, controller, record, 'turn', conversation, scoredAs);
    };
    // Reserve: the judge first (it must fit, or there is no merge), then the drafts, the single choice first.
    const judgeHold = (() => {
      const judge = decision.judges[0]!;
      const usd = this.estimate(judge, bodyBytes, body.max_tokens, grant.sessionId) + (decision.members.length * DRAFT_TOKENS * (judge.priceIn ?? 0)) / 1e6;
      try { return this.spend.reserve(grant.sessionId, usd, caps); } catch { return null; }
    })();
    if (!judgeHold) return single('judge_over_cap');
    const members: Array<{ entry: InventoryEntry; hold: ReturnType<Spend['reserve']> }> = [];
    for (const entry of decision.members) {
      try { members.push({ entry, hold: this.spend.reserve(grant.sessionId, this.estimate(entry, bodyBytes, body.max_tokens, grant.sessionId), caps) }); }
      catch {
        if (entry === decision.members[0]) { judgeHold.release(); for (const m of members) m.hold.release(); return single('primary_over_cap'); }
        fan.drafts.push({ upstream: entry.upstream.id, model: entry.model, effort: entry.effort, status: 'capped', http: null, ms: 0, costUsd: null });
      }
    }
    if (members.length < 2) { judgeHold.release(); for (const m of members) m.hold.release(); return single('drafts_over_cap'); }
    this.stats.fanOuts++;
    // A tool call in one draft stops the other drafts, never the single choice (its answer is the one passed through)
    // nor the draft that called the tool. The CLI going away stops them all.
    const stops = members.map(() => new AbortController());
    const relay = (): void => { for (const stop of stops) stop.abort(); };
    controller.signal.addEventListener('abort', relay, { once: true });
    let results: Awaited<ReturnType<AutoRouter['draft']>>[];
    try {
      results = await Promise.all(members.map(({ entry }, index) => this.draft(entry, body, stops[index]!.signal, () => { stops.forEach((stop, other) => { if (other !== 0 && other !== index) stop.abort(); }); })));
    } finally {
      controller.signal.removeEventListener('abort', relay);
    }
    let draftCost = 0;
    results.forEach((result, index) => {
      const { entry, hold } = members[index]!;
      // A draft that produced an answer (or was stopped mid-answer) is paid; one refused before answering is not.
      if (result.bytes || result.record.status === 'stopped' || result.record.status === 'timeout') { hold.commit(result.record.costUsd); draftCost += result.record.costUsd ?? 0; }
      else hold.release();
      if (result.parsed) this.sawOutput(grant.sessionId, result.parsed.usage.out);
      fan.drafts.push(result.record);
      this.noteOutcome(entry.key, result.record.status);
    });
    const finish = (): void => { record.costUsd = (record.costUsd ?? 0) + draftCost; };
    if (controller.signal.aborted) { judgeHold.release(); finish(); throw new HttpError(499, 'aborted', 'The call was cancelled.'); }
    const answered = results.map((result, index) => ({ result, entry: members[index]!.entry }));
    // Agentic after all: the single choice's own answer, unchanged (else the first draft that called a tool).
    if (answered.some(({ result }) => result.record.status === 'tool_calls')) {
      judgeHold.release();
      this.agentic.add(conversation);
      while (this.agentic.size > ROUTER_LIMITS.conversations) this.agentic.delete(this.agentic.keys().next().value!);
      this.stats.fanOutToolCalls++;
      fan.outcome = 'tool_calls';
      const primary = answered[0]!;
      const chosen = primary.result.bytes && (primary.result.record.status === 'text' || primary.result.record.status === 'tool_calls') ? primary : answered.find(({ result }) => result.record.status === 'tool_calls')!;
      this.replay(chosen.entry, chosen.result, body, response, grant, record, conversation, scoredAs);
      record.costUsd = draftCost;
      return;
    }
    const texts = answered.filter(({ result }) => result.record.status === 'text');
    if (!texts.length) {
      judgeHold.release();
      this.stats.fanOutDegraded++;
      fan.outcome = 'no_draft';
      // The single path, without the drafts that just failed (they cool down too).
      const failed = new Set(members.map(m => m.entry));
      try { await this.forward(list.filter(entry => !failed.has(entry)).slice(0, ROUTER_LIMITS.attempts), body, grant, response, controller, record, 'turn', conversation, scoredAs); }
      finally { finish(); }
      return;
    }
    if (texts.length === 1) {
      judgeHold.release();
      this.stats.fanOutDegraded++;
      fan.outcome = 'one_draft';
      this.replay(texts[0]!.entry, texts[0]!.result, body, response, grant, record, conversation, scoredAs);
      record.costUsd = draftCost;
      return;
    }
    // The judge: the CLI's request plus the drafts, streamed to the CLI with the usual failover between judges.
    judgeHold.release();
    const judged = judgeBody(body, texts.map(({ result }) => result.parsed!.text), kind);
    try {
      await this.forward(decision.judges.slice(0, ROUTER_LIMITS.attempts), judged, grant, response, controller, record, 'turn', conversation, scoredAs);
      fan.judge = record.upstream && record.model ? { upstream: record.upstream, model: record.model } : null;
      fan.outcome = kind === 'best-of-n' ? 'picked' : 'merged';
      this.stats.merged++;
      finish();
    } catch (error) {
      if (error instanceof HttpError && error.status === 499) { finish(); throw error; }
      if (response.headersSent) { finish(); throw error; }
      // No judge answered (or none fits the cap now): the best-scored draft that answered, as it came.
      this.stats.judgeFailed++;
      fan.outcome = 'judge_failed';
      record.reason = 'judge_failed';
      const value = (entry: InventoryEntry): number => scoredAs ? entry.scores[scoredAs]?.value ?? -1 : -1;
      const best = [...texts].sort((a, b) => value(b.entry) - value(a.entry))[0]!;
      record.costUsd = draftCost;
      this.replay(best.entry, best.result, body, response, grant, record, conversation, scoredAs);
    }
  }

  private showModel(sessionId: string, model: string, level: Level, source: DecisionSource): void {
    if (this.shownModel.get(sessionId) === model) return;
    this.shownModel.set(sessionId, model);
    this.deps.badge?.(sessionId, { model, tier: level, source });
  }

  private remember(record: DecisionRecord): void {
    this.recentRecords.unshift(record);
    if (this.recentRecords.length > ROUTER_LIMITS.recent) this.recentRecords.length = ROUTER_LIMITS.recent;
    const file = this.deps.directory ? join(this.deps.directory, 'decisions.jsonl') : null;
    if (!file) return;
    try {
      try { if (statSync(file).size > ROUTER_LIMITS.logBytes) renameSync(file, `${file}.1`); } catch { /* none yet */ }
      appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch { /* memory only */ }
  }
}

/** An upstream's own error message, short and on one line (it never reaches a log). */
function upstreamMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof parsed.error === 'string' ? parsed.error : typeof parsed.error?.message === 'string' ? parsed.error.message : typeof parsed.message === 'string' ? parsed.message : '';
    return clean(message, 240);
  } catch { return ''; }
}
