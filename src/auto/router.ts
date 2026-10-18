import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Difficulty } from '../harness/router.ts';
import type { DataClassMode } from '../shared/settings.ts';
import { candidates, latestUserText, requestKeys, requestKind, rulesDifficulty, tierFor, type Candidate, type RequestKind } from './classify.ts';
import { DEFAULT_OUTPUT, type AutoRoutingSettings, type AutoTier, type AutoUpstream } from './settings.ts';
import { hashToken, TokenStore, type LaunchGrant } from './tokens.ts';

/**
 * The Auto (Jev) router: an OpenAI Chat Completions endpoint on 127.0.0.1 for agent CLIs started with "Model: Auto
 * (Jev)". It checks the card's per-launch key, decides once per new user turn which allowed model answers (Jev's task
 * triage within 2.5 s, else word rules; tool-call continuations keep the turn's choice; small-model calls skip Jev),
 * swaps only `model` in the body and passes the request and its stream through unchanged. Before the first byte
 * reaches the CLI it moves to the next candidate on 404/408/409/425/429/5xx, a connect error or a timeout, and cools
 * that model or upstream down; after it, an upstream failure ends the stream with an error and nothing is replayed.
 * Per-card and per-day caps are reserved before a call. The log keeps keyed hashes, models and numbers — never text.
 */

export type DecisionSource = 'jev' | 'rules' | 'lease' | 'small';

export interface TurnDecision { difficulty: Difficulty; strong: boolean }

export interface RouterDeps {
  /** `<plugin data>/auto`. */
  directory: string | null;
  settings(): AutoRoutingSettings;
  dataClassMode(): DataClassMode;
  /** The upstream's key, bound to its origin; null when none is saved (or it is bound elsewhere). */
  key(upstream: AutoUpstream): Promise<string | null>;
  /** Jev's view of a turn (the latest user text only), or null to use the rules; `signal` aborts at the budget. */
  decide?(text: string, grant: LaunchGrant, signal: AbortSignal): Promise<TurnDecision | null>;
  /** The card's model badge changed (only on a change). */
  badge?(sessionId: string, model: { model: string; tier: AutoTier; source: DecisionSource } | null): void;
  log?(level: 'info' | 'warn', message: string): void;
  transport?: typeof fetch;
  now?: () => number;
  timeouts?: Partial<RouterTimeouts>;
}

export interface RouterTimeouts { jevMs: number; headersMs: number; firstChunkMs: number; idleMs: number; totalMs: number }
export const ROUTER_TIMEOUTS: RouterTimeouts = { jevMs: 2_500, headersMs: 60_000, firstChunkMs: 60_000, idleMs: 90_000, totalMs: 15 * 60_000 };
export const ROUTER_LIMITS = Object.freeze({ bodyBytes: 32 * 1_048_576, perCard: 16, total: 64, attempts: 6, conversations: 1_024, leaseMs: 30 * 60_000, recent: 50, logBytes: 512 * 1_024 });
const COOLDOWN_MS = Object.freeze({ transient: 30_000, quota: 300_000, missing: 900_000, auth: 900_000, maxRetryAfter: 24 * 3_600_000 });

export interface DecisionRecord {
  at: number;
  /** The first 8 characters of the card's session id. */
  session: string;
  conversation: string;
  turn: string;
  kind: RequestKind;
  source: DecisionSource;
  tier: AutoTier | null;
  upstream: string | null;
  model: string | null;
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
}

export interface RouterStats {
  requests: number; turns: number; continuations: number; small: number;
  jevAsked: number; jevAnswered: number; rules: number; leaseReuses: number; failovers: number;
  /** Hosts the router sent a request to (no paths). */
  hosts: string[];
}

interface Lease { sessionId: string; turn: string; contract: string; tier: AutoTier; model: string | null; upstream: string | null; source: DecisionSource; decidedAt: number }

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

const RETRYABLE = new Set([404, 408, 409, 425, 429, 500, 502, 503, 504]);
const clean = (value: string, max: number): string => value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max);

/** Seconds or an HTTP date, bounded to 24 h; null when absent or not understood. */
export function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(header) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, COOLDOWN_MS.maxRetryAfter) : null;
}

/** Spend per local day and per card, with reservations held while a call runs (no overshoot by parallel calls). */
class Spend {
  private day = '';
  private total = 0;
  private held = 0;
  private readonly cards = new Map<string, { spent: number; held: number }>();
  private readonly file: string | null;
  private readonly now: () => number;

  constructor(directory: string | null, now: () => number) {
    this.now = now;
    this.file = directory ? join(directory, 'spend.json') : null;
    try {
      const saved = JSON.parse(readFileSync(this.file!, 'utf8')) as { day?: unknown; total?: unknown; cards?: unknown };
      if (saved.day === this.dayKey() && typeof saved.total === 'number' && saved.total >= 0) {
        this.day = saved.day; this.total = saved.total;
        if (saved.cards && typeof saved.cards === 'object') for (const [id, usd] of Object.entries(saved.cards)) if (typeof usd === 'number' && usd >= 0) this.cards.set(id, { spent: usd, held: 0 });
      }
    } catch { /* nothing saved today */ }
  }

  private dayKey(): string { const d = new Date(this.now()); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
  private roll(): void { const key = this.dayKey(); if (key !== this.day) { this.day = key; this.total = 0; this.held = 0; for (const card of this.cards.values()) { card.spent = 0; } } }
  private card(id: string): { spent: number; held: number } { let card = this.cards.get(id); if (!card) { card = { spent: 0, held: 0 }; this.cards.set(id, card); } return card; }

  today(): number { this.roll(); return this.total; }
  ofCard(id: string): number { this.roll(); return this.cards.get(id)?.spent ?? 0; }

  /** Holds `estimate` against both caps; throws 402 when either is spent. */
  reserve(sessionId: string, estimate: number, caps: { daily: number; perCard: number }): { commit(cost: number | null): void; release(): void } {
    this.roll();
    const card = this.card(sessionId);
    if (this.total + this.held >= caps.daily || this.total + this.held + estimate > caps.daily) throw new HttpError(402, 'daily_cap', 'Auto (Jev): the daily cap is reached; change it on the Decision models page.');
    if (card.spent + card.held >= caps.perCard || card.spent + card.held + estimate > caps.perCard) throw new HttpError(402, 'card_cap', 'Auto (Jev): this card\'s cap is reached; change it on the Decision models page.');
    this.held += estimate; card.held += estimate;
    let done = false;
    const free = (): void => { if (done) return; done = true; this.held = Math.max(0, this.held - estimate); card.held = Math.max(0, card.held - estimate); };
    return {
      commit: cost => { free(); const usd = cost ?? estimate; this.total += usd; card.spent += usd; this.save(); },
      release: free
    };
  }

  forget(sessionId: string): void { const card = this.cards.get(sessionId); if (card && card.held === 0) this.cards.delete(sessionId); }

  private save(): void {
    if (!this.file) return;
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ day: this.day, total: this.total, cards: Object.fromEntries([...this.cards].map(([id, card]) => [id, card.spent])) }), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch { /* kept in memory */ }
  }
}

/** Reads `usage` (and OpenRouter's `cost`) from an SSE stream as it passes, without holding it. */
class UsageReader {
  private rest = '';
  usage: { in: number | null; out: number | null; cost: number | null } = { in: null, out: null, cost: null };
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
    if (!line.startsWith('data:') || !line.includes('"usage"')) return;
    try { this.json(JSON.parse(line.slice(5).trim())); } catch { /* not JSON */ }
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
  private readonly active = new Map<string, Set<AbortController>>();
  private activeTotal = 0;
  private readonly shownModel = new Map<string, string>();
  private readonly recentRecords: DecisionRecord[] = [];
  private readonly hosts = new Set<string>();
  readonly stats: Omit<RouterStats, 'hosts'> = { requests: 0, turns: 0, continuations: 0, small: 0, jevAsked: 0, jevAnswered: 0, rules: 0, leaseReuses: 0, failovers: 0 };

  constructor(deps: RouterDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.timeouts = { ...ROUTER_TIMEOUTS, ...deps.timeouts };
    this.transport = deps.transport ?? fetch;
    if (deps.directory) { try { mkdirSync(deps.directory, { recursive: true, mode: 0o700 }); } catch { /* reads fail below */ } }
    this.tokens = new TokenStore(deps.directory, this.now);
    this.salt = this.loadSalt();
    this.spend = new Spend(deps.directory, this.now);
  }

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
    this.spend.forget(sessionId);
  }

  /** Cards CanvasTTY no longer lists lose their keys (after a restart of the service). */
  retainSessions(known: ReadonlySet<string>): void { this.tokens.retain(known); this.idle(); }

  /** Starts the listener again at service start when running cards still hold keys. */
  async resume(): Promise<void> { if (this.tokens.size > 0) await this.start().catch(error => this.deps.log?.('warn', `Auto (Jev): the router could not listen: ${String(error).slice(0, 120)}`)); }

  recent(): DecisionRecord[] { return [...this.recentRecords]; }
  statsView(): RouterStats & { spentToday: number; listening: boolean; cards: number } {
    return { ...this.stats, hosts: [...this.hosts], spentToday: Math.round(this.spend.today() * 1e6) / 1e6, listening: !!this.server, cards: this.tokens.size };
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
  private async decideTurn(text: string, grant: LaunchGrant, toolCount: number): Promise<{ decision: TurnDecision; source: 'jev' | 'rules'; reason: string }> {
    const settings = this.deps.settings();
    if (settings.decider === 'jev' && this.deps.decide && text) {
      this.stats.jevAsked++;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const answer = await Promise.race([
          this.deps.decide(text, grant, controller.signal),
          new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, this.timeouts.jevMs); })
        ]);
        if (answer) { this.stats.jevAnswered++; return { decision: answer, source: 'jev', reason: 'jev' }; }
        return { decision: { difficulty: rulesDifficulty(text, toolCount), strong: false }, source: 'rules', reason: controller.signal.aborted ? 'jev_slow' : 'jev_unavailable' };
      } catch {
        return { decision: { difficulty: rulesDifficulty(text, toolCount), strong: false }, source: 'rules', reason: 'jev_error' };
      } finally { if (timer) clearTimeout(timer); }
    }
    return { decision: { difficulty: rulesDifficulty(text, toolCount), strong: false }, source: 'rules', reason: settings.decider === 'rules' ? 'rules_only' : 'no_text' };
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
      upstream: null, model: null, attempts: 0, failovers: [], status: 0, reason: '', ttfbMs: null, totalMs: 0, tokensIn: null, tokensOut: null, costUsd: null
    };
    try {
      // The decision: small calls the cheapest model; a continuation keeps its turn's choice; a new turn asks once.
      let tier: AutoTier;
      let preferred: string | null = null;
      if (kind === 'small') {
        tier = 'small'; record.reason = 'small_model';
      } else {
        const lease = this.leases.get(keys.conversation);
        const fresh = lease && lease.contract === keys.contract && this.now() - lease.decidedAt < ROUTER_LIMITS.leaseMs;
        if (lease && fresh && (kind === 'continuation' || lease.turn === keys.turn)) {
          tier = lease.tier; preferred = lease.model; record.source = 'lease'; record.reason = 'same_turn'; this.stats.leaseReuses++;
        } else {
          const decided = await this.decideTurn(latestUserText(body), grant, Array.isArray(body.tools) ? body.tools.length : 0);
          if (controller.signal.aborted) throw new HttpError(499, 'aborted', 'The call was cancelled.');
          if (decided.source === 'rules') this.stats.rules++;
          tier = tierFor(decided.decision.difficulty, decided.decision.strong, settings.preference);
          // Staying on the conversation's model when the tier did not change keeps the upstream's prompt cache warm.
          preferred = lease && lease.tier === tier ? lease.model : null;
          record.source = decided.source; record.reason = decided.reason;
        }
        this.leases.delete(keys.conversation);
        this.leases.set(keys.conversation, { sessionId: grant.sessionId, turn: keys.turn, contract: keys.contract, tier, model: preferred, upstream: null, source: record.source, decidedAt: record.source === 'lease' && lease ? lease.decidedAt : this.now() });
        while (this.leases.size > ROUTER_LIMITS.conversations) this.leases.delete(this.leases.keys().next().value!);
      }
      record.tier = tier;
      let list = candidates(settings, tier, { cardClass: grant.dataClass, mode: this.deps.dataClassMode(), coolingDown: this.coolingDown, cheapest: kind === 'small' });
      if (preferred) list = [...list.filter(c => c.model.id === preferred), ...list.filter(c => c.model.id !== preferred)];
      if (!list.length) throw new HttpError(503, 'no_model', 'Auto (Jev): no allowed model is available now (all are off, cooling down or not allowed for this card\'s data class).');
      await this.forward(list.slice(0, ROUTER_LIMITS.attempts), body, grant, response, controller, record, kind, keys.conversation);
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

  private estimate(candidate: Candidate, bodyBytes: number, maxTokens: unknown): number {
    const output = typeof maxTokens === 'number' && maxTokens > 0 ? Math.min(maxTokens, 32_768) : candidate.model.output ?? DEFAULT_OUTPUT;
    return ((bodyBytes / 4) * (candidate.model.priceIn ?? 0) + output * (candidate.model.priceOut ?? 0)) / 1e6;
  }

  private costOf(candidate: Candidate, usage: UsageReader['usage']): number | null {
    if (usage.cost !== null) return usage.cost;
    if (usage.in === null && usage.out === null) return null;
    if (candidate.model.priceIn === undefined && candidate.model.priceOut === undefined) return null;
    return ((usage.in ?? 0) * (candidate.model.priceIn ?? 0) + (usage.out ?? 0) * (candidate.model.priceOut ?? 0)) / 1e6;
  }

  private async forward(list: Candidate[], body: Record<string, unknown>, grant: LaunchGrant, response: ServerResponse, controller: AbortController, record: DecisionRecord, kind: RequestKind, conversation: string): Promise<void> {
    const settings = this.deps.settings();
    const stream = body.stream === true;
    let lastStatus = 503;
    let lastCode = 'no_upstream';
    for (const candidate of list) {
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
      const key = candidate.upstream.key === 'none' ? null : await this.deps.key(candidate.upstream).catch(() => null);
      if (candidate.upstream.key !== 'none' && !key) { failover('error', candidate.upstream.id, COOLDOWN_MS.auth, 'no_key'); continue; }
      const payload = Buffer.from(JSON.stringify({ ...body, model: candidate.model.id }), 'utf8');
      const reservation = this.spend.reserve(grant.sessionId, this.estimate(candidate, payload.length, body.max_tokens), { daily: settings.dailyUsdCap, perCard: settings.perCardUsdCap });
      const attempt = new AbortController();
      const relay = (): void => attempt.abort();
      controller.signal.addEventListener('abort', relay, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => attempt.abort(), stream ? this.timeouts.headersMs : this.timeouts.totalMs);
      let sent = false;
      const usage = new UsageReader();
      try {
        const url = `${candidate.upstream.baseUrl}/chat/completions`;
        this.hosts.add(new URL(url).host);
        let upstream: Response;
        try {
          upstream = await this.transport(url, {
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
        record.upstream = candidate.upstream.id; record.model = candidate.model.id; record.tier = candidate.tier;
        record.ttfbMs = this.now() - record.at;
        if (kind !== 'small') {
          const lease = this.leases.get(conversation);
          if (lease) { lease.model = candidate.model.id; lease.upstream = candidate.upstream.id; }
          this.showModel(grant.sessionId, candidate, record.source);
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
        for (;;) {
          clearTimeout(timer);
          timer = setTimeout(() => attempt.abort(), stream ? this.timeouts.idleMs : this.timeouts.totalMs);
          let next: ReadableStreamReadResult<Uint8Array>;
          try { next = await reader.read(); } catch { failed = true; break; }
          if (next.done) break;
          take(next.value);
          if (!response.write(next.value)) await new Promise<void>(resolve => { response.once('drain', resolve); response.once('close', resolve); });
          if (response.destroyed) { failed = true; break; }
        }
        if (stream) usage.end(); else { try { usage.json(JSON.parse(chunks.join(''))); } catch { /* no usage */ } }
        record.tokensIn = usage.usage.in; record.tokensOut = usage.usage.out;
        const cost = this.costOf(candidate, usage.usage);
        record.costUsd = cost;
        reservation.commit(cost);
        if (failed && !controller.signal.aborted && !response.destroyed) {
          // Never replayed: the CLI got part of an answer; it sees an error and decides itself.
          response.write(stream ? `data: ${JSON.stringify({ error: { message: 'Auto (Jev): the upstream stopped in the middle of the answer.', type: 'canvastty_auto', code: 'upstream_interrupted' } })}\n\n` : '');
          record.status = 502; record.reason ||= 'interrupted';
        } else record.status = controller.signal.aborted ? 499 : 200;
        response.end();
        return;
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', relay);
        if (!sent) attempt.abort();
      }
    }
    throw new HttpError(lastStatus === 429 ? 429 : 503, lastCode, `Auto (Jev): no allowed model answered (last: ${lastCode}). It tries again on the next call.`);
  }

  private showModel(sessionId: string, candidate: Candidate, source: DecisionSource): void {
    if (this.shownModel.get(sessionId) === candidate.model.id) return;
    this.shownModel.set(sessionId, candidate.model.id);
    this.deps.badge?.(sessionId, { model: candidate.model.id, tier: candidate.tier, source });
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
