/**
 * Limit windows and the subscription cost model. The windows come from CanvasTTY's `limits.get` (permission
 * `limits:read`): read by the service itself where the core lets a service read them (limitsFeed.ts, with the core's
 * `canvastty.limits.changed` push), else forwarded by the settings page while it is open; they are kept on disk with
 * their read time across restarts. Anything older than STALE_MS is `unknown`, never `exhausted` (a misread or old
 * window must not pull every pick onto the wrong route).
 *
 * Cost for a subscription is a scarcity price, never money: free while every window keeps more headroom than the
 * person's reserve plus the task's expected share and does not burn faster than the window itself; priced at the
 * model's API price, scaled by how much faster it burns, when it does; unavailable when the headroom is gone.
 */

export const STALE_MS = 30 * 60_000;
export const MAX_LIMIT_PROVIDERS = 16;
const MAX_WINDOWS = 8;

export interface WindowView {
  /** The core's window id ("claude:five_hour", "codex:primary"), to compare reads (null from an older host). */
  id?: string | null;
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

export type LimitsSource = 'core' | 'core-push' | 'page' | 'saved';

export interface LimitsCache {
  /** When it reached this service (from the core, its push, the page, or the file at start). */
  receivedAt: number;
  source?: LimitsSource;
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
      windows.push({ id: short(window.id, 80), label: short(window.label, 60), usedPercent: Math.max(0, Math.min(100, used)), windowMinutes: num(window.windowMinutes), resetsAt: num(window.resetsAt) });
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

/** Percent of the tightest window one routed launch is assumed to use between two reads (an estimate). */
export const PER_LAUNCH_PERCENT = 2;

/**
 * This plugin's cards' measured use of a CLI's own sign-in since its windows were read (CanvasTTY's usage.summary):
 * the tokens and the share of the window they stand for (tokens × the person's expected share per task ÷ a task's
 * tokens). Replaces the per-launch estimate where the core measures usage.
 */
export interface MeasuredSpend { percent: number; tokens: number }

/**
 * Reads one provider's windows under the reserve; stale or never read is `unknown`. `launchesSinceRead`: routed
 * launches on it since the read, each assumed to use PER_LAUNCH_PERCENT of the tightest window until the next read.
 */
export function quotaOf(limits: ProviderLimits | undefined, reserve: number, now: number, launchesSinceRead = 0, measured: MeasuredSpend | null = null): SubscriptionQuota {
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
  // Measured tokens since the read where the core says (usage:read), else ~2 % per routed launch.
  const spent = measured ? Math.max(0, Math.min(measured.percent, 100)) : Math.max(0, Math.min(launchesSinceRead, 100)) * PER_LAUNCH_PERCENT;
  if (spent > 0 && headroom > 0) headroom = Math.max(0.001, headroom - spent);
  const estimated = spent <= 0 ? '' : measured
    ? `; ${Math.round(measured.tokens).toLocaleString('en-US')} tokens measured since the read counted as ~${Math.round(spent * 10) / 10}%`
    : `; ${launchesSinceRead} routed launch(es) since the read counted as ~${spent}%`;
  const view = { label: tight.label, usedPercent: tight.usedPercent, minutes: tight.windowMinutes };
  if (headroom <= 0) return { state: 'exhausted', headroom: 0, pace: paced ? round(pace) : null, window: view, readAt: limits.fetchedAt, note: 'no headroom above the reserve', code: 'no-headroom' };
  return { state: presumed ? 'presumed-reset' : 'known', headroom: round(headroom), pace: paced ? round(pace) : null, window: view, readAt: limits.fetchedAt, note: `${presumed ? 'one window has probably reset since the last read' : ''}${estimated}`.replace(/^; /u, ''), code: presumed ? 'reset' : '' };
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

// ---------------------------------------------------------------------------------------------------------------
// Resets: what changed between two reads, and reset times in limit messages
// ---------------------------------------------------------------------------------------------------------------

/** Clock skew and reporting jitter tolerated around a reset time. */
export const RESET_TOLERANCE_MS = 2 * 60_000;
/** The early-reset thresholds CanvasTTY's core uses (LimitsService.detectEarlyResets). */
export const EARLY_RESET_MIN_DROP = 5;
export const EARLY_RESET_NEAR_ZERO = 5;
export const EARLY_RESET_NOISE = 2;
export const EARLY_RESET_GRACE_MS = 5 * 60_000;
export const SAME_RESET_TIME_MS = 60_000;

/** One window that reset before its announced time (same fields as CanvasTTY's own `earlyResets` entries). */
export interface EarlyResetDetail {
  provider: string;
  /** The window id, for example `claude:five_hour`, `codex:secondary` (CanvasTTY's `windowId`). */
  window: string;
  /** CanvasTTY's `windowLabel` ("5h", "7d"), when known. */
  label?: string | null;
  usedBefore: number | null;
  usedAfter: number | null;
  announcedResetAt: number | null;
  reportedResetAtAfter: number | null;
  /** The provider still shows the old reset time after the reset. */
  resetTimeKept: boolean;
}

export interface LimitChange {
  provider: string;
  /**
   * `early-reset`: the used share dropped clearly before the announced reset; `reset`: it dropped at the announced
   * time; `recovered`: a used-up window shows a little room again (usable, not a reset); `exhausted`: a window at 100 %.
   */
  kind: 'early-reset' | 'reset' | 'recovered' | 'exhausted';
  note: string;
  early?: EarlyResetDetail[];
}

const windowKey = (window: WindowView, index: number): string => window.id ?? `${window.label ?? '?'}#${window.windowMinutes ?? index}`;
const hhmm = (at: number): string => new Date(at).toISOString().slice(11, 16);

/**
 * The owner's rule for an early reset: the used share dropped by at least max(5 points, half of what was used), or to
 * 5 % or less by more than 2 points, while the reset time the previous read announced was more than 5 minutes ahead — whatever the provider reports as
 * the next reset afterwards (a fresh window, or still the old time). A reset time that moves without a drop is not a
 * reset; a small dip is not one either. Per provider and per window kind.
 */
export function earlyResetOf(provider: string, key: string, previous: WindowView, next: WindowView, now: number): EarlyResetDetail | null {
  // Same thresholds as CanvasTTY's own detector (LimitsService.detectEarlyResets).
  if (previous.resetsAt === null || now >= previous.resetsAt - EARLY_RESET_GRACE_MS) return null;
  const drop = previous.usedPercent - next.usedPercent;
  if (!(drop >= Math.max(EARLY_RESET_MIN_DROP, previous.usedPercent / 2) || (next.usedPercent <= EARLY_RESET_NEAR_ZERO && drop > EARLY_RESET_NOISE))) return null;
  return {
    provider, window: key, label: next.label ?? null, usedBefore: previous.usedPercent, usedAfter: next.usedPercent, announcedResetAt: previous.resetsAt,
    reportedResetAtAfter: next.resetsAt, resetTimeKept: next.resetsAt !== null && Math.abs(next.resetsAt - previous.resetsAt) <= SAME_RESET_TIME_MS
  };
}

export const earlyNote = (detail: EarlyResetDetail, label?: string | null): string =>
  `${label ?? detail.label ?? detail.window} ${detail.usedBefore === null ? '?' : Math.round(detail.usedBefore)}% → ${detail.usedAfter === null ? '?' : Math.round(detail.usedAfter)}%${detail.announcedResetAt !== null ? ` before ${hhmm(detail.announcedResetAt)} UTC` : ''}${detail.resetTimeKept ? ' (old reset time still shown)' : ''}`;

/** Compares a provider's new read with the previous one, window kind by window kind. */
export function limitChanges(previous: LimitsCache | null, next: LimitsCache, now: number): LimitChange[] {
  if (!previous) return [];
  const changes: LimitChange[] = [];
  for (const provider of next.providers) {
    const before = previous.providers.find(entry => entry.provider === provider.provider);
    if (!before || provider.state !== 'available' || !provider.fetchedAt || (before.fetchedAt !== null && provider.fetchedAt <= before.fetchedAt)) continue;
    const old = new Map(before.windows.map((window, i) => [windowKey(window, i), window]));
    const early: EarlyResetDetail[] = [];
    const notes: string[] = [];
    let reset: string | null = null, full: string | null = null, recovered: string | null = null;
    provider.windows.forEach((window, i) => {
      const key = windowKey(window, i);
      const prior = old.get(key);
      if (window.usedPercent >= 100 && (!prior || prior.usedPercent < 100)) full = window.label ?? 'a window';
      if (!prior || prior.resetsAt === null) return;
      const detail = earlyResetOf(provider.provider, key, prior, window, now);
      if (detail) { early.push(detail); notes.push(earlyNote(detail, window.label)); return; }
      const drop = prior.usedPercent - window.usedPercent;
      if (now >= prior.resetsAt - RESET_TOLERANCE_MS && drop >= 5) reset = `${window.label ?? 'window'} reset at ${hhmm(prior.resetsAt)} UTC`;
      else if (prior.usedPercent >= 100 && window.usedPercent < 100) recovered = `${window.label ?? 'window'} has ${Math.round(100 - window.usedPercent)}% room again`;
    });
    if (early.length) changes.push({ provider: provider.provider, kind: 'early-reset', note: notes.join('; '), early });
    else if (reset) changes.push({ provider: provider.provider, kind: 'reset', note: reset });
    else if (recovered) changes.push({ provider: provider.provider, kind: 'recovered', note: recovered });
    if (full) changes.push({ provider: provider.provider, kind: 'exhausted', note: `${full} at 100%` });
  }
  return changes;
}

/**
 * CanvasTTY's `earlyResets` entries (`{provider, home?, windowId, slot, windowLabel, windowMinutes, usedBefore,
 * usedAfter, announcedResetAt, reportedResetAtAfter, resetTimeKept}`); the first build's names (`previousUsedPercent`,
 * `usedPercent`, `previousResetsAt`, `resetsAt`) are still read. Account-home entries are another login's and left out.
 */
export function coreEarlyResets(value: unknown): EarlyResetDetail[] {
  if (!Array.isArray(value)) return [];
  const number = (raw: unknown): number | null => typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  const out: EarlyResetDetail[] = [];
  for (const entry of value.slice(0, 32)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e.home !== undefined && e.home !== null) continue;
    const provider = short(e.provider, 40);
    if (!provider || !/^[a-z0-9-]{1,40}$/u.test(provider)) continue;
    const announced = number(e.announcedResetAt) ?? number(e.previousResetsAt);
    const reported = 'reportedResetAtAfter' in e ? number(e.reportedResetAtAfter) : number(e.resetsAt);
    out.push({
      provider, window: short(e.windowId, 80) ?? short(e.window, 80) ?? 'window', label: short(e.windowLabel, 40),
      usedBefore: number(e.usedBefore) ?? number(e.previousUsedPercent), usedAfter: number(e.usedAfter) ?? number(e.usedPercent),
      announcedResetAt: announced, reportedResetAtAfter: reported,
      resetTimeKept: typeof e.resetTimeKept === 'boolean' ? e.resetTimeKept : announced !== null && reported !== null && Math.abs(announced - reported) <= SAME_RESET_TIME_MS
    });
  }
  return out;
}

/**
 * Merges a new read into the cache: per provider the newer read wins, so a page forward and the service's own read
 * (both from the same core) never move the data backwards.
 */
export function mergeLimits(current: LimitsCache | null, incoming: LimitsCache): LimitsCache {
  if (!current) return incoming;
  const providers = [...current.providers];
  for (const entry of incoming.providers) {
    const at = providers.findIndex(old => old.provider === entry.provider);
    if (at < 0) { if (providers.length < MAX_LIMIT_PROVIDERS) providers.push(entry); continue; }
    const old = providers[at]!;
    if (entry.fetchedAt === null || old.fetchedAt === null || entry.fetchedAt >= old.fetchedAt || entry.state === 'available' && old.state !== 'available' && entry.fetchedAt >= old.fetchedAt) providers[at] = entry;
  }
  return { receivedAt: incoming.receivedAt, ...(incoming.source ? { source: incoming.source } : {}), providers };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "3pm", "3:05 PM", "15:05", "11am" → hours and minutes, or null. */
function clockOf(text: string): { h: number; m: number } | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/iu.exec(text.trim());
  if (!match) return null;
  let h = Number(match[1]); const m = Number(match[2] ?? 0);
  const half = match[3]?.toLowerCase().replace(/\./gu, '');
  if (half) { if (h < 1 || h > 12) return null; h = h % 12 + (half === 'pm' ? 12 : 0); } else if (!match[2]) return null;
  return h <= 23 && m <= 59 ? { h, m } : null;
}

/** The next local time `clock` on or after `now` (or on the given month/day). */
function localAt(now: number, clock: { h: number; m: number }, day?: { month: number; day: number; year?: number }): number {
  const base = new Date(now);
  const at = new Date(day?.year ?? base.getFullYear(), day ? day.month : base.getMonth(), day ? day.day : base.getDate(), clock.h, clock.m, 0, 0);
  if (!day && at.getTime() < now - 60_000) at.setDate(at.getDate() + 1);
  if (day && !day.year && at.getTime() < now - 86_400_000) at.setFullYear(at.getFullYear() + 1);
  return at.getTime();
}

/**
 * When a limit message says the limit resets, from an agent's exit lines (the CLIs print in this computer's local
 * time): Claude Code ("limit reached ∙ resets 3pm", "resets Oct 7, 11am", "usage limit reached|<epoch>"), Codex ("try
 * again at 3:05 PM", "try again at Oct 22nd, 2026 3:05 PM"), Z.AI ("will reset at 2026-10-21 14:00:00", UTC+8 or UTC
 * when no zone is given, the earlier one within a week). null when no time is stated.
 */
export function resetFromText(lines: readonly string[], now: number): number | null {
  const text = lines.join('\n').slice(-8_000);
  const epoch = /usage limit reached\|(\d{10,13})/iu.exec(text);
  if (epoch) { const value = Number(epoch[1]); return value < 1e12 ? value * 1_000 : value; }
  const iso = /(?:reset at|resets at|reset on)\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})?/iu.exec(text);
  if (iso) {
    const [, y, mo, d, h, mi, sec, zone] = iso;
    const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec ?? 0));
    if (zone) return utc - (zone === 'Z' ? 0 : (zone.startsWith('-') ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2))) * 60_000);
    const fits = [utc - 8 * 3_600_000, utc].filter(at => at > now - 60_000 && at <= now + 7 * 86_400_000).sort((a, b) => a - b);
    return fits[0] ?? null;
  }
  const dated = /(?:resets|try again at|reset at)\s+([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:(\d{4})\s+)?(?:at\s+)?(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?|\d{1,2}:\d{2})/iu.exec(text);
  if (dated) {
    const month = MONTHS.indexOf(dated[1]!.toLowerCase());
    const clock = clockOf(dated[4]!);
    if (month >= 0 && clock) return localAt(now, clock, { month, day: Number(dated[2]), ...(dated[3] ? { year: Number(dated[3]) } : {}) });
  }
  const timed = /(?:resets|try again at|reset at|available again at)\s+(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?|\d{1,2}:\d{2})/iu.exec(text);
  if (timed) { const clock = clockOf(timed[1]!); if (clock) return localAt(now, clock); }
  return null;
}
