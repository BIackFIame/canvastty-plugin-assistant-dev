/**
 * What the Assistant reads from CanvasTTY and the Accounts plugin itself, where the core lets a service read it; every
 * piece is feature-detected and an older core keeps the old path (rows and lists an orchestrator passes):
 *
 * - `plugins.request` → Accounts' shared reads `accounts.routes` (model accounts, pool accounts and pools, each with
 *   its quota; no keys) and `accounts.quota` (per account and per pool, cheaper: no key or Ollama checks). Only after
 *   the person approved the pair in Settings → Extension native code; until then CanvasTTY refuses with a reason
 *   (`not_approved`, `not_declared`, `not_shared`, `provider_unavailable`) that the page shows.
 * - `providers.list` (`providers:read`): which CLIs are installed and signed in, their models and efforts, the
 *   plugins whose launch options apply, and the environments (servers) subagents may use, by name only.
 *
 * Reads are bounded by a deadline: routing never waits longer than that, and a late answer is kept for next time.
 */
import type { Host } from '../rpc.ts';
import { accountQuotaFrom, accountRowsFrom, providersFrom } from './service.ts';
import type { AccountRow, ProviderInfo } from './engine.ts';

export const ACCOUNTS_PLUGIN = 'canvastty-accounts';
export const SHARED_METHODS = Object.freeze({ routes: 'accounts.routes', quota: 'accounts.quota' });

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const clean = (value: unknown, max: number): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, max) : '';

/** A host error the core sends for a method it does not have (an older CanvasTTY), or a permission it lacks. */
export function unsupportedError(error: unknown): boolean {
  const code = isRecord(error) ? (error as { code?: unknown }).code : undefined;
  return code === -32601 || /unknown host method|does not have the [a-z:]+ permission|not allowed|permission/iu.test(errorText(error));
}

/** The refusal reason of a shared read (`error.data.reason`, else the message's `reason:` prefix), or null. */
export function sharedReadReason(error: unknown): string | null {
  const data = isRecord(error) ? (error as { data?: unknown }).data : undefined;
  if (isRecord(data) && typeof data.reason === 'string' && /^[a-z_]{1,40}$/u.test(data.reason)) return data.reason;
  const prefix = /^([a-z_]{3,40}):/u.exec(errorText(error));
  return prefix ? prefix[1]! : null;
}

/** A pool of the person's own sign-ins for one CLI, as Accounts shares it (`pool:<agent>` picks the member at launch). */
export interface PoolRoute {
  cli: string;
  label: string;
  members: number;
  /** Members free now (signed in, room, no card on them). */
  ready: number;
  /** The best free member's quota: percent left (null: unknown), its state and window, and when it resets. */
  quota: AccountRow['quota'] | null;
  window: string | null;
  /** The lowest data level the person trusts a free member with (`unset` when one is not set). */
  trust: string;
  launchOptions: Record<string, Record<string, string | boolean>>;
}

/** Accounts' `pools` entries, only well-typed fields; the launch value is always `pool:<cli>`. */
export function poolRoutesFrom(value: unknown): PoolRoute[] {
  const raw = isRecord(value) && Array.isArray(value.pools) ? value.pools : Array.isArray(value) ? value : [];
  const pools: PoolRoute[] = [];
  for (const entry of raw.slice(0, 16)) {
    if (!isRecord(entry) || typeof entry.agent !== 'string' || !/^[a-z0-9-]{1,40}$/u.test(entry.agent)) continue;
    const count = (n: unknown): number => typeof n === 'number' && Number.isInteger(n) && n >= 0 ? Math.min(n, 10_000) : 0;
    const best = isRecord(entry.best) ? entry.best : null;
    const quota = best ? accountQuotaFrom(best) ?? null : null;
    const trust = typeof entry.trust === 'string' && /^(D[0-3]|unset)$/u.test(entry.trust) ? entry.trust : 'unset';
    if (pools.some(pool => pool.cli === entry.agent)) continue;
    pools.push({
      cli: entry.agent, label: clean(entry.label, 60) || `${entry.agent} pool`, members: count(entry.members), ready: count(entry.ready), quota,
      window: best ? clean(best.window, 40) || null : null, trust,
      launchOptions: { [ACCOUNTS_PLUGIN]: { account: `pool:${entry.agent}`, effort: 'default', trustFolder: false } }
    });
  }
  return pools;
}

export type PeerMode = 'probing' | 'ready' | 'refused' | 'unsupported' | 'failing';

interface Cached<T> { at: number; value: T }

/**
 * Accounts' shared reads. `routes()` answers within the deadline from a fresh read, else from the last one; the page
 * sees `mode` and the refusal reason (for example "not_approved": allow it in Settings → Extension native code).
 */
export class AccountsFeed {
  mode: PeerMode = 'probing';
  reason: string | null = null;
  private routesCache: Cached<{ rows: AccountRow[]; pools: PoolRoute[] }> | null = null;
  private quotaCache: Cached<unknown> | null = null;
  private inflight = new Map<string, Promise<unknown>>();
  private refusedAt = 0;
  private readonly host: Host;
  private readonly now: () => number;

  constructor(host: Host, now: () => number = Date.now) { this.host = host; this.now = now; }

  /** Refused or not offered: asked again only now and then (the person may approve it, or update CanvasTTY). */
  private resting(): boolean {
    if (this.mode === 'unsupported') return this.now() - this.refusedAt < 30 * 60_000;
    if (this.mode === 'refused') return this.now() - this.refusedAt < 60_000;
    return false;
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const key = `${method}:${JSON.stringify(params)}`;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.host.callHost('plugins.request', { plugin: ACCOUNTS_PLUGIN, method, params }).then(answer => {
        this.mode = 'ready'; this.reason = null;
        return isRecord(answer) && 'data' in answer ? answer.data : answer;
      }, (error: unknown) => {
        const reason = sharedReadReason(error);
        if (reason && reason !== 'timeout' && reason !== 'busy' && reason !== 'rate_limited' && reason !== 'provider_error') { this.mode = 'refused'; this.reason = reason; this.refusedAt = this.now(); }
        else if (unsupportedError(error)) { this.mode = 'unsupported'; this.reason = null; this.refusedAt = this.now(); }
        else { this.mode = this.mode === 'ready' ? 'ready' : 'failing'; this.reason = reason ?? clean(errorText(error), 120); }
        throw error;
      }).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  /** Model account rows and pools, at most `maxAgeMs` old when a read answers within `deadlineMs`; else the last ones. */
  async routes(maxAgeMs = 120_000, deadlineMs = 1_500): Promise<{ rows: AccountRow[]; pools: PoolRoute[]; at: number } | null> {
    const now = this.now();
    if (this.routesCache && now - this.routesCache.at <= maxAgeMs) return { ...this.routesCache.value, at: this.routesCache.at };
    if (this.resting()) return this.routesCache ? { ...this.routesCache.value, at: this.routesCache.at } : null;
    const read = this.request(SHARED_METHODS.routes, {}).then(data => {
      // Only Accounts' own answer shape counts: anything else is not "no accounts".
      if (!isRecord(data) || !Array.isArray(data.routes)) { this.mode = 'failing'; this.reason = 'unexpected answer'; throw new Error('Accounts answered accounts.routes in an unknown shape.'); }
      const value = { rows: accountRowsFrom(data), pools: poolRoutesFrom(data) };
      this.routesCache = { at: this.now(), value };
      return value;
    });
    read.catch(() => undefined);
    const answer = await within(read, deadlineMs);
    if (answer) return { ...answer, at: this.routesCache!.at };
    return this.routesCache ? { ...this.routesCache.value, at: this.routesCache.at } : null;
  }

  /** Accounts' `accounts.quota` (per account and per pool), for the page and the e2e check; null when not readable. */
  async quota(maxAgeMs = 60_000, deadlineMs = 1_500, force = false): Promise<unknown> {
    const now = this.now();
    if (!force && this.quotaCache && now - this.quotaCache.at <= maxAgeMs) return this.quotaCache.value;
    // `force`: the person asked on the page (for example right after allowing the pair).
    if (!force && this.resting()) return this.quotaCache?.value ?? null;
    const read = this.request(SHARED_METHODS.quota, {}).then(data => { this.quotaCache = { at: this.now(), value: data }; return data; });
    read.catch(() => undefined);
    return (await within(read, deadlineMs)) ?? this.quotaCache?.value ?? null;
  }

  /**
   * The first reads of a service run (at its start, and when the person first opens the settings page), so neither
   * waits for the first routing decision: the routes (on that read Accounts reads its accounts' quota) and the quota.
   * Accounts answers the routes before its own quota read ends, so while a model account's quota says it was not
   * read yet both are read once more `retryMs` later. Bounded: two rounds at most, each within its deadline.
   */
  async warm(retryMs = 2_500, wait: (ms: number) => Promise<void> = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); (timer as { unref?: () => void }).unref?.(); })): Promise<{ routes: boolean; quota: boolean; unread: number }> {
    const round = async (): Promise<{ routes: boolean; quota: boolean; unread: number }> => {
      // A fresh read each round (-1: no cached answer is new enough), within the deadline.
      const routes = await this.routes(-1, 3_000);
      const quota = await this.quota(0, 3_000, true);
      return { routes: routes !== null, quota: quota !== null, unread: unreadQuota(quota) };
    };
    const first = await round();
    if (!first.unread || this.mode !== 'ready') return first;
    await wait(retryMs);
    return round();
  }

  /** The last answers without reading (the agent tree and the main agent's status lines). */
  peekQuota(): unknown { return this.quotaCache?.value ?? null; }
  peekRoutes(): { rows: AccountRow[]; pools: PoolRoute[] } | null { return this.routesCache?.value ?? null; }

  state(): { mode: PeerMode; reason: string | null; routesAt: number | null; quotaAt: number | null } {
    return { mode: this.mode, reason: this.reason, routesAt: this.routesCache?.at ?? null, quotaAt: this.quotaCache?.at ?? null };
  }
}

/** Model accounts in an `accounts.quota` answer whose quota Accounts has not read yet (no observation, no error). */
export function unreadQuota(answer: unknown): number {
  const accounts = isRecord(answer) && Array.isArray(answer.accounts) ? answer.accounts : [];
  return accounts.filter(entry => isRecord(entry) && isRecord(entry.quota) && entry.quota.observedAt == null && entry.quota.state === 'unknown' && !/not readable/iu.test(String(entry.quota.note ?? ''))).length;
}

/** One environment kind subagents may use (list_providers' `environments`), by name only. */
export interface EnvironmentOffer {
  pluginId: string;
  kind: string;
  name: string;
  providers: string[] | null;
  capBy: string | null;
  maxParallel: number;
  servers: Array<{ name: string; running: number }>;
  localProtection: boolean;
}

/** list_providers' `environments`, only ids, names, caps and running counts (labels only: no hosts or folders). */
export function environmentsFrom(value: unknown): EnvironmentOffer[] {
  const raw = isRecord(value) && Array.isArray(value.environments) ? value.environments : [];
  const out: EnvironmentOffer[] = [];
  const id = (v: unknown, max: number): string | null => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(v) && v.length <= max ? v : null;
  for (const entry of raw.slice(0, 16)) {
    if (!isRecord(entry)) continue;
    const pluginId = id(entry.pluginId, 80), kind = id(entry.kind, 40);
    if (!pluginId || !kind) continue;
    const maxParallel = typeof entry.maxParallel === 'number' && Number.isInteger(entry.maxParallel) && entry.maxParallel > 0 ? Math.min(entry.maxParallel, 64) : 1;
    const servers = Array.isArray(entry.servers) ? entry.servers.filter(isRecord).map(server => ({ name: id(server.name, 64), running: typeof server.running === 'number' && server.running >= 0 ? Math.floor(server.running) : 0 }))
      .filter((server): server is { name: string; running: number } => server.name !== null).slice(0, 64) : [];
    out.push({
      pluginId, kind, name: clean(entry.name, 60) || kind,
      providers: Array.isArray(entry.providers) ? entry.providers.filter((p): p is string => typeof p === 'string' && /^[a-z0-9-]{1,40}$/u.test(p)).slice(0, 16) : null,
      capBy: id(entry.capBy, 40), maxParallel, servers, localProtection: entry.localProtection === true
    });
  }
  return out;
}

/** `providers.list` (permission `providers:read`): CanvasTTY's own list_providers answer for this service. */
export class ProvidersFeed {
  mode: PeerMode = 'probing';
  private cache: Cached<{ providers: ProviderInfo[]; environments: EnvironmentOffer[] }> | null = null;
  private pending: Promise<{ providers: ProviderInfo[]; environments: EnvironmentOffer[] } | null> | null = null;
  private refusedAt = 0;
  private readonly host: Host;
  private readonly now: () => number;

  constructor(host: Host, now: () => number = Date.now) { this.host = host; this.now = now; }

  /** The list, at most `maxAgeMs` old (it reads only the core's caches, so a read is cheap); null: not offered. */
  async list(maxAgeMs = 60_000, deadlineMs = 1_000): Promise<{ providers: ProviderInfo[]; environments: EnvironmentOffer[]; at: number } | null> {
    const now = this.now();
    if (this.cache && now - this.cache.at <= maxAgeMs) return { ...this.cache.value, at: this.cache.at };
    if (this.mode === 'unsupported' && now - this.refusedAt < 30 * 60_000) return null;
    this.pending ??= this.host.callHost('providers.list', {}).then(answer => {
      const parsed = providersFrom(answer);
      if (!parsed.given) { this.mode = 'failing'; return null; }
      const value = { providers: parsed.list, environments: environmentsFrom(answer) };
      this.cache = { at: this.now(), value };
      this.mode = 'ready';
      return value;
    }, (error: unknown) => {
      if (unsupportedError(error)) { this.mode = 'unsupported'; this.refusedAt = this.now(); } else this.mode = 'failing';
      return null;
    }).finally(() => { this.pending = null; });
    const answer = await within(this.pending, deadlineMs);
    if (answer) return { ...answer, at: this.cache!.at };
    return this.cache ? { ...this.cache.value, at: this.cache.at } : null;
  }
}

/** The work's answer when it comes within `ms`, else null (the work goes on and fills the cache). */
export function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(null); });
  });
}
