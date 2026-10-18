/**
 * Limit windows and the subscription cost model. In phase 1 the windows reach the service only through the settings
 * page: it calls CanvasTTY's `limits.get` (permission `limits:read`) when it opens and every 60 s while it is open,
 * and forwards the sanitized snapshot here. With the page closed they go stale: anything older than STALE_MS is
 * `unknown`, never `exhausted` (a misread or old window must not pull every pick onto the wrong route).
 *
 * Cost for a subscription is a scarcity price, never money: free while every window keeps more headroom than the
 * person's reserve plus the task's expected share and does not burn faster than the window itself; priced at the
 * model's API price, scaled by how much faster it burns, when it does; unavailable when the headroom is gone.
 */

export const STALE_MS = 30 * 60_000;
export const MAX_LIMIT_PROVIDERS = 16;
const MAX_WINDOWS = 8;

export interface WindowView {
  label: string | null;
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
}

export interface ProviderLimits {
  provider: string;
  /** `available`: read now; `stale`: an earlier read, the latest failed; `unavailable`: never read (with the reason). */
  state: 'available' | 'stale' | 'unavailable';
  reason: string | null;
  fetchedAt: number | null;
  windows: WindowView[];
}

export interface LimitsCache {
  /** When the page forwarded it. */
  receivedAt: number;
  providers: ProviderLimits[];
}

const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const short = (value: unknown, max: number): string | null => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;

/**
 * The snapshot as `limits.get` answers (`{ state: 'ready', snapshot }` or the snapshot itself), rebuilt with only the
 * fields routing reads. Anything else (an account scope, if a host ever sent one) is dropped.
 */
export function parseLimits(value: unknown, receivedAt: number): LimitsCache | null {
  const outer = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const snapshot = outer && 'snapshot' in outer ? outer.snapshot : outer;
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray((snapshot as { providers?: unknown }).providers)) return null;
  const providers: ProviderLimits[] = [];
  for (const raw of ((snapshot as { providers: unknown[] }).providers).slice(0, MAX_LIMIT_PROVIDERS)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const provider = short(entry.provider, 40);
    const state = entry.state === 'available' || entry.state === 'stale' || entry.state === 'unavailable' ? entry.state : null;
    if (!provider || !state) continue;
    const windows: WindowView[] = [];
    if (Array.isArray(entry.windows)) for (const w of entry.windows.slice(0, MAX_WINDOWS)) {
      if (!w || typeof w !== 'object') continue;
      const window = w as Record<string, unknown>;
      const used = num(window.usedPercent);
      if (used === null) continue;
      windows.push({ label: short(window.label, 60), usedPercent: Math.max(0, Math.min(100, used)), windowMinutes: num(window.windowMinutes), resetsAt: num(window.resetsAt) });
    }
    providers.push({ provider, state, reason: short(entry.reason, 40), fetchedAt: num(entry.fetchedAt) ?? (state === 'unavailable' ? num(entry.checkedAt) : null), windows });
  }
  return { receivedAt, providers };
}

export type QuotaState = 'known' | 'unknown' | 'presumed-reset' | 'exhausted';

export interface SubscriptionQuota {
  state: QuotaState;
  /** Percent left above the reserve, over the tightest window (null: unknown). */
  headroom: number | null;
  /** Used share ÷ elapsed share of the tightest-paced window; above 1 burns faster than the window (null: unknown). */
  pace: number | null;
  /** The window that limits it, for the why-line ("5 h: 41%"). */
  window: { label: string | null; usedPercent: number; minutes: number | null } | null;
  /** When the windows were read (ms), or null. */
  readAt: number | null;
  /** Why it is unknown or exhausted (English, for the orchestrator); `code` says the same for a page. */
  note: string;
  code: 'unread' | 'unreadable' | 'stale' | 'no-windows' | 'reset' | 'no-headroom' | '';
}

/** Reads one provider's windows under the reserve; stale or never read is `unknown`. */
export function quotaOf(limits: ProviderLimits | undefined, reserve: number, now: number): SubscriptionQuota {
  const unknown = (note: string, code: SubscriptionQuota['code'], readAt: number | null = null): SubscriptionQuota => ({ state: 'unknown', headroom: null, pace: null, window: null, readAt, note, code });
  if (!limits) return unknown('not read yet', 'unread');
  if (limits.state === 'unavailable') return unknown(limits.reason ? `not readable (${limits.reason})` : 'not readable', 'unreadable');
  if (limits.fetchedAt === null || now - limits.fetchedAt > STALE_MS) return unknown('read more than 30 min ago', 'stale', limits.fetchedAt);
  if (!limits.windows.length) return unknown('no windows', 'no-windows', limits.fetchedAt);
  let headroom = Infinity, pace = 0, tight: WindowView | null = null, paced = false, presumed = false;
  for (const window of limits.windows) {
    // A window whose reset passed since the read: it has probably reset, but nobody read it again.
    if (window.resetsAt !== null && window.resetsAt <= now) { presumed = true; continue; }
    const left = 100 - window.usedPercent - reserve;
    if (left < headroom) { headroom = left; tight = window; }
    if (window.windowMinutes && window.resetsAt !== null) {
      const total = window.windowMinutes * 60_000;
      const elapsed = Math.max(0, Math.min(1, 1 - (window.resetsAt - now) / total));
      // Too early in a window to judge its pace: a few percent in the first minutes says nothing.
      if (elapsed >= 0.05) { pace = Math.max(pace, (window.usedPercent / 100) / elapsed); paced = true; }
    }
  }
  if (!tight) return { state: 'presumed-reset', headroom: null, pace: null, window: null, readAt: limits.fetchedAt, note: 'its windows have probably reset since the last read', code: 'reset' };
  const view = { label: tight.label, usedPercent: tight.usedPercent, minutes: tight.windowMinutes };
  if (headroom <= 0) return { state: 'exhausted', headroom: 0, pace: paced ? round(pace) : null, window: view, readAt: limits.fetchedAt, note: 'no headroom above the reserve', code: 'no-headroom' };
  return { state: presumed ? 'presumed-reset' : 'known', headroom: round(headroom), pace: paced ? round(pace) : null, window: view, readAt: limits.fetchedAt, note: presumed ? 'one window has probably reset since the last read' : '', code: presumed ? 'reset' : '' };
}

const round = (value: number): number => Math.round(value * 1_000) / 1_000;

export interface ShadowPrice {
  /** USD-comparable cost (0: free within the window), or null: unavailable now. */
  usd: number | null;
  /** Free, priced because it burns or runs low, unknown windows, or unavailable. */
  basis: 'free' | 'burning' | 'low' | 'unknown' | 'unavailable';
}

/**
 * The marginal cost of one task on a subscription. `share` is the expected percent of the window for this task;
 * `ref` the same task's cost on the model's API route (null when no price is known: then "burning" counts as low).
 */
export function shadowPrice(quota: SubscriptionQuota, share: number, ref: number | null): ShadowPrice {
  if (quota.state === 'exhausted') return { usd: null, basis: 'unavailable' };
  if (quota.state !== 'known' || quota.headroom === null) return { usd: 0, basis: 'unknown' };
  const burning = quota.pace !== null && quota.pace > 1;
  if (quota.headroom >= share && !burning) return { usd: 0, basis: 'free' };
  const base = ref ?? 0;
  if (quota.headroom < share) return { usd: round(base * Math.max(1, burning ? quota.pace! - 1 : 1)), basis: 'low' };
  return { usd: round(base * (quota.pace! - 1)), basis: 'burning' };
}
