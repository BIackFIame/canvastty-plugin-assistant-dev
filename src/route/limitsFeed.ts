/**
 * Limit windows without the settings page: where the core lets a service read limits (`limits.subscribe` and
 * `limits.get`, the same redacted LimitsSnapshot pages get, gated by `limits:read`) the service subscribes at start,
 * reads them itself on its own schedule, and takes the core's `canvastty.limits.changed` push (with `earlyResets`) at
 * once. On an older core the subscribe fails ("Unknown host method", -32601) and the page keeps forwarding them while
 * it is open; the feed asks the core again now and then (the permission granted later). The default login only: the
 * Assistant keeps no account homes (`limits.get {provider, home}` is for the plugin that owns them).
 *
 * Schedule: soon after a predicted reset, every 2 min while a route rests after a limit, every 5 min while routing is
 * used, every 15 min when idle; ±15 % jitter; never more often than every 30 s; failures back off up to 30 min. The
 * core caches its own reads (60 s), so this adds no provider requests beyond the core's.
 */
import type { Host } from '../rpc.ts';
import { coreEarlyResets, type EarlyResetDetail, type LimitChange, type LimitsSource } from './limits.ts';

export interface LimitsSink {
  receiveLimits(value: unknown, source: LimitsSource, hint?: { earlyReset?: EarlyResetDetail[] }): { ok: boolean; providers: number; changes: LimitChange[] };
  limitsDueIn(now?: number): { resetSoon: number | null; resting: boolean; presumed: boolean };
  /** When routing was last asked (null: never since start). */
  lastRouteAt(): number | null;
}

export interface LimitsFeedOptions {
  host: Host;
  sink: LimitsSink;
  now?: () => number;
  random?: () => number;
  /** Timers (tests drive them). */
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const FEED = Object.freeze({
  minMs: 30_000,
  activeMs: 5 * 60_000,
  idleMs: 15 * 60_000,
  restingMs: 2 * 60_000,
  presumedMs: 30_000,
  afterResetMs: 20_000,
  nearResetMs: 15 * 60_000,
  activeWindowMs: 30 * 60_000,
  failureBaseMs: 60_000,
  failureMaxMs: 30 * 60_000,
  /** How often an older core is asked again whether services may read limits. */
  reprobeMs: 30 * 60_000,
  jitter: 0.15
});

export type FeedMode = 'probing' | 'core' | 'page-only';

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export class LimitsFeed {
  mode: FeedMode = 'probing';
  /** When the service's own read last succeeded, and the last failure (for the page). */
  lastReadAt: number | null = null;
  lastError: string | null = null;
  /** `limits.subscribe` succeeded since this service started (the core forgets it on every restart). */
  subscribed = false;
  private failures = 0;
  private timer: unknown = null;
  private reading: Promise<boolean> | null = null;
  private stopped = false;
  private readonly options: LimitsFeedOptions;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(options: LimitsFeedOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? ((run, ms) => { const handle = setTimeout(run, ms); handle.unref?.(); return handle; });
    this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Asks the core once; from then on reads on the schedule (or re-asks later on an older core). */
  async start(): Promise<FeedMode> {
    await this.read();
    return this.mode;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
  }

  /** One read through the core now (shared while one runs); true when it brought windows. */
  read(): Promise<boolean> {
    this.reading ??= this.readOnce().finally(() => { this.reading = null; this.schedule(); });
    return this.reading;
  }

  /** An older core (no such host method for services) or no permission: the page path stays the only one. */
  private unsupported(error: unknown): boolean {
    if (!/unknown host method|not allowed|does not have the limits:read|permission/iu.test(errorText(error))) return false;
    if (this.mode !== 'page-only') this.options.host.log('info', 'limits: this CanvasTTY does not let services read limits; the settings page forwards them while it is open');
    this.mode = 'page-only';
    this.subscribed = false;
    this.lastError = null;
    return true;
  }

  private async readOnce(): Promise<boolean> {
    if (!this.subscribed) {
      let last: unknown;
      try {
        last = await this.options.host.callHost('limits.subscribe', {});
      } catch (error) {
        if (this.unsupported(error)) return false;
        this.failures++;
        this.lastError = errorText(error).slice(0, 160);
        return false;
      }
      this.subscribed = true;
      this.mode = 'core';
      // The last snapshot the core has (it starts no read); `loading` before the first one.
      if (isRecord(last) && last.state === 'ready' && last.snapshot) this.options.sink.receiveLimits(last, 'core');
    }
    let answer: unknown;
    try {
      answer = await this.options.host.callHost('limits.get', {});
    } catch (error) {
      if (this.unsupported(error)) return false;
      this.failures++;
      this.lastError = errorText(error).slice(0, 160);
      return false;
    }
    const outer = isRecord(answer) ? answer : null;
    if (outer && outer.state !== undefined && outer.state !== 'ready' && !('snapshot' in outer)) {
      // Readable later (the core is still starting its readers): not a failure of the method.
      this.mode = 'core';
      this.failures++;
      this.lastError = `limits not ready (${String(outer.state).slice(0, 30)})`;
      return false;
    }
    const result = this.options.sink.receiveLimits(answer, 'core');
    this.mode = 'core';
    if (!result.ok) { this.failures++; this.lastError = 'the core answered limits in an unknown shape'; return false; }
    this.failures = 0;
    this.lastError = null;
    this.lastReadAt = this.now();
    return true;
  }

  /**
   * `canvastty.limits.changed`: `{ state, snapshot, earlyReset, earlyResets: [{ provider, windowId, … }], provider?,
   * home? }`. A snapshot is taken at once (the providers with an early reset end their rests); without one, the
   * windows are read now. A change of an account home is not the default login's and is left alone.
   */
  changed(params: unknown): void {
    if (this.stopped) return;
    const value = isRecord(params) ? params : {};
    if (value.home !== undefined) return;
    this.mode = 'core';
    this.subscribed = true;
    // The core's own entries (older or newer fields); home entries are not the default login's.
    const early = coreEarlyResets(value.earlyResets);
    if (value.snapshot !== undefined) {
      const result = this.options.sink.receiveLimits(value.snapshot, 'core-push', early.length ? { earlyReset: early } : {});
      if (result.ok) { this.failures = 0; this.lastReadAt = this.now(); this.schedule(); return; }
    }
    void this.read();
  }

  /** The delay before the next read, from what is known now. */
  nextDelay(): number {
    const now = this.now();
    const jitter = (ms: number): number => Math.round(ms * (1 + FEED.jitter * (this.random() * 2 - 1)));
    if (this.mode === 'page-only') return jitter(FEED.reprobeMs);
    if (this.failures > 0) return jitter(Math.min(FEED.failureMaxMs, FEED.failureBaseMs * 2 ** Math.min(this.failures - 1, 10)));
    const due = this.options.sink.limitsDueIn(now);
    const last = this.options.sink.lastRouteAt();
    let delay = due.presumed ? FEED.presumedMs
      : due.resting ? FEED.restingMs
        : last !== null && now - last <= FEED.activeWindowMs ? FEED.activeMs : FEED.idleMs;
    delay = jitter(delay);
    if (due.resetSoon !== null && due.resetSoon - now <= FEED.nearResetMs) delay = Math.min(delay, due.resetSoon - now + FEED.afterResetMs + Math.round(this.random() * 10_000));
    return Math.max(FEED.minMs, delay);
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { this.timer = null; void this.read(); }, this.nextDelay());
  }
}
