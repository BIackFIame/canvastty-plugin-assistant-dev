/**
 * "Where agents run" settings (storage key `routing`, non-secret): the subscriptions and coding plans the person
 * declares, how much of each window they keep in reserve, which routes may be used, trust per account address, pins
 * and boosts per model, the new-model policy and alias overrides. Shared by the service and the page: no Node APIs.
 *
 * Nothing here is a credential. A subscription is reached only by launching its own CLI on its own sign-in; the
 * declaration only tells `route` that it exists and how to weigh it.
 */
import { DATA_CLASSES, type DataClass } from '../shared/settings.ts';
import { AUTO_TIERS, type AutoTier } from '../auto/settings.ts';

export type RouteAllow = 'prefer' | 'allow' | 'never';
export const ROUTE_ALLOWS: readonly RouteAllow[] = ['prefer', 'allow', 'never'];
/** `wait`: a model without a measured score is not used; `provisional`: mapped scores may compete; `explore`: also a small share of easy tasks. */
export type NewModelPolicy = 'wait' | 'provisional' | 'explore';
export const NEW_MODEL_POLICIES: readonly NewModelPolicy[] = ['wait', 'provisional', 'explore'];
export type TrustLevel = DataClass | 'unset';
export type PlanKind = 'subscription' | 'coding-plan';
/** How a plan counts its quota: by tokens (a cheaper model's tokens count less), by prompts, or not known. */
export type QuotaBy = 'tokens' | 'prompts' | 'unknown';
export const QUOTA_BYS: readonly QuotaBy[] = ['tokens', 'prompts', 'unknown'];
/** How much a faster model is worth on a plan, against the quota it uses. */
export type ValueSpeed = 'low' | 'moderate' | 'high';
export const VALUE_SPEEDS: readonly ValueSpeed[] = ['low', 'moderate', 'high'];
export const SPEED_WEIGHT: Readonly<Record<ValueSpeed, number>> = { low: 0.2, moderate: 0.5, high: 1 };

/** CLIs `spawn_agent` can start (CanvasTTY's agent providers); anything else is refused by the host anyway. */
export const ROUTE_CLIS = ['claude', 'codex', 'grok', 'kimi', 'qwen', 'opencode', 'hermes', 'omp', 'pi', 'cursor', 'minimax', 'devin', 'antigravity'] as const;

export interface PlanDecl {
  /** a-z, 0-9 and dashes; unique. */
  id: string;
  /** The CLI it runs in (spawn_agent.provider). */
  cli: string;
  /** A subscription (the CLI's own sign-in, windows read by CanvasTTY) or a coding plan (counted here, no read API). */
  kind: PlanKind;
  /** The person's name for it ("Max", "ChatGPT Pro", "GLM Coding Plan"). */
  label: string;
  /**
   * The models it may run: the CLI's own ids or aliases (`opus`, `gpt-5.5`). For OpenCode, `provider/model` as
   * `opencode models` prints it, or `provider/*` for every listed model of that provider. Empty: the CLI's default.
   */
  models: string[];
  /** Percent of each window kept for the person (not used by routed agents). */
  reserve: number;
  /** At most this many routed children on it at once. */
  maxParallel: number;
  /** Coding plan: launches per window the person allows (no read API exists). */
  allowance?: number;
  /** Coding plan: the window length in hours (default 5). */
  windowHours?: number;
  allow: RouteAllow;
  /** The highest data class the person trusts it with; `unset` until they say. */
  trust: TrustLevel;
  /** How the plan counts quota (default: by tokens). */
  quotaBy?: QuotaBy;
  /** Quota weight per model identity (1 = like the plan's top model); default: its API token price ratio. */
  multipliers?: Record<string, number>;
}

export interface AliasOverride { cli: string; alias: string; identity: string }

export interface RouteSettings {
  version: 1;
  plans: PlanDecl[];
  /** A subscription with headroom wins ties within the quality window before the cheapest API route. */
  preferSubscriptions: boolean;
  /** Percent of a window one task is expected to use, by level. */
  expectedShare: { small: number; medium: number; large: number };
  /** Per route group: `cli:<id>` (a CLI not declared as a plan), `host:<address>` (a model account), `auto`. */
  allow: Record<string, RouteAllow>;
  /** Trust per model-account address (`host:<address>`); accounts carry none of their own. */
  trust: Record<string, TrustLevel>;
  /** A manual tier per model identity: that model answers tasks of its tier first. */
  pins: Record<string, AutoTier>;
  /** Points added to a model's score (−20…20), shown in every why-line. */
  boosts: Record<string, number>;
  newModels: NewModelPolicy;
  /** With `explore`: the share of small and medium tasks that try the best new model (0.01–0.2). */
  exploreShare: number;
  /** The person's alias table entries; they win over the bundled table. */
  aliases: AliasOverride[];
  /** Route keys the person marked "not equivalent": their own model with their own outcomes. */
  notEquivalent: string[];
  /**
   * Model accounts on a flat-rate plan (`host:<address>` or `account:<id>`): no price per task, so they cost nothing
   * within the plan's limits. An account whose name says "coding plan" counts as one too.
   */
  flat: string[];
  /** On plans (subscriptions, coding plans, flat-rate accounts): how much a faster model is worth. */
  valueSpeed: ValueSpeed;
  /** Output speed per model identity in tokens/s, as the person knows it (no source gives it yet). */
  speeds: Record<string, number>;
  /** Quota weight per model identity for flat-rate accounts and plans without their own. */
  quotaWeights: Record<string, number>;
}

export const MAX_PLANS = 16;
export const MAX_PLAN_MODELS = 16;
export const MAX_MAP = 64;
export const MAX_PINS = 32;
export const MAX_ALIASES = 64;
export const DEFAULT_RESERVE = 20;
export const DEFAULT_MAX_PARALLEL = 2;
export const MAX_SETTINGS_CHARS = 16_384;

export const DEFAULT_ROUTE_SETTINGS: Readonly<RouteSettings> = Object.freeze({
  version: 1, plans: [], preferSubscriptions: true, expectedShare: { small: 3, medium: 8, large: 15 },
  allow: {}, trust: {}, pins: {}, boosts: {}, newModels: 'wait', exploreShare: 0.05, aliases: [], notEquivalent: [], flat: [], valueSpeed: 'moderate', speeds: {}, quotaWeights: {}
}) as Readonly<RouteSettings>;

class RouteSettingsError extends Error {}
const fail = (message: string): never => { throw new RouteSettingsError(message); };
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/u;
/** A model id, alias or pattern: printable, no spaces, ≤ 200. */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+*-]{0,199}$/u;
const KEY = /^(?:cli:[a-z0-9-]{1,40}|host:[A-Za-z0-9.:[\]-]{1,120}|auto)$/u;
const IDENTITY = /^[a-z0-9][a-z0-9._-]{0,119}$/u;
const plain = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const intIn = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const trustOk = (value: unknown): value is TrustLevel => value === 'unset' || DATA_CLASSES.includes(value as DataClass);
const PROTO = new Set(['__proto__', 'constructor', 'prototype']);

function plan(value: unknown): PlanDecl {
  if (!isRecord(value)) fail('Invalid plan.');
  const v = value as Record<string, unknown>;
  const allowed = ['id', 'cli', 'kind', 'label', 'models', 'reserve', 'maxParallel', 'allowance', 'windowHours', 'allow', 'trust', 'quotaBy', 'multipliers'];
  if (Object.keys(v).some(key => !allowed.includes(key))) fail('Invalid plan field.');
  if (typeof v.id !== 'string' || !ID.test(v.id)) fail('Invalid plan id.');
  if (!(ROUTE_CLIS as readonly unknown[]).includes(v.cli)) fail('Invalid plan CLI.');
  if (v.kind !== 'subscription' && v.kind !== 'coding-plan') fail('Invalid plan kind.');
  if (!plain(v.label, 40)) fail('Invalid plan name.');
  if (!Array.isArray(v.models) || v.models.length > MAX_PLAN_MODELS || v.models.some(model => typeof model !== 'string' || !MODEL.test(model))) fail('Invalid plan models.');
  if (!intIn(v.reserve, 0, 90)) fail('Invalid reserve.');
  if (!intIn(v.maxParallel, 1, 8)) fail('Invalid parallel limit.');
  if (v.allowance !== undefined && !intIn(v.allowance, 1, 100_000)) fail('Invalid allowance.');
  if (v.windowHours !== undefined && !intIn(v.windowHours, 1, 24 * 31)) fail('Invalid window.');
  if (!ROUTE_ALLOWS.includes(v.allow as RouteAllow)) fail('Invalid allow.');
  if (!trustOk(v.trust)) fail('Invalid trust.');
  if (v.quotaBy !== undefined && !QUOTA_BYS.includes(v.quotaBy as QuotaBy)) fail('Invalid quota kind.');
  const multipliers = v.multipliers === undefined ? undefined : weights(v.multipliers, 'multipliers');
  return {
    id: v.id as string, cli: v.cli as string, kind: v.kind as PlanKind, label: v.label as string, models: [...new Set(v.models as string[])],
    reserve: v.reserve as number, maxParallel: v.maxParallel as number,
    ...(v.allowance !== undefined ? { allowance: v.allowance as number } : {}), ...(v.windowHours !== undefined ? { windowHours: v.windowHours as number } : {}),
    allow: v.allow as RouteAllow, trust: v.trust as TrustLevel,
    ...(v.quotaBy !== undefined ? { quotaBy: v.quotaBy as QuotaBy } : {}), ...(multipliers && Object.keys(multipliers).length ? { multipliers } : {})
  };
}

const weights = (value: unknown, what: string): Record<string, number> =>
  map<number>(value, MAX_PINS, k => IDENTITY.test(k), (x): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0.01 && x <= 100, what);

function map<T>(value: unknown, max: number, key: (k: string) => boolean, item: (v: unknown) => v is T, what: string): Record<string, T> {
  if (value === undefined) return {};
  if (!isRecord(value)) fail(`Invalid ${what}.`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > max || entries.some(([k, v]) => PROTO.has(k) || !key(k) || !item(v))) fail(`Invalid ${what}.`);
  return Object.fromEntries(entries) as Record<string, T>;
}

/** Throws with a short reason; the page shows it. */
export function validateRouteSettings(value: unknown): RouteSettings {
  if (!isRecord(value)) fail('Invalid routing settings.');
  const v = value as Record<string, unknown>;
  const allowed = Object.keys(DEFAULT_ROUTE_SETTINGS);
  if (Object.keys(v).some(key => !allowed.includes(key))) fail('Invalid routing settings field.');
  if (v.version !== 1) fail('Invalid routing settings version.');
  if (!Array.isArray(v.plans) || v.plans.length > MAX_PLANS) fail('Invalid plans.');
  const plans = (v.plans as unknown[]).map(plan);
  if (new Set(plans.map(entry => entry.id)).size !== plans.length) fail('Two plans have the same id.');
  if (typeof v.preferSubscriptions !== 'boolean') fail('Invalid prefer subscriptions.');
  const share = v.expectedShare as Record<string, unknown>;
  if (!isRecord(share) || Object.keys(share).sort().join() !== 'large,medium,small' || ![share.small, share.medium, share.large].every(n => intIn(n, 1, 100))) fail('Invalid expected share.');
  const allow = map<RouteAllow>(v.allow, MAX_MAP, k => KEY.test(k), (x): x is RouteAllow => ROUTE_ALLOWS.includes(x as RouteAllow), 'allow list');
  const trust = map<TrustLevel>(v.trust, MAX_MAP, k => /^host:/u.test(k) && KEY.test(k), trustOk, 'trust list');
  const pins = map<AutoTier>(v.pins, MAX_PINS, k => IDENTITY.test(k), (x): x is AutoTier => AUTO_TIERS.includes(x as AutoTier), 'pins');
  const boosts = map<number>(v.boosts, MAX_PINS, k => IDENTITY.test(k), (x): x is number => intIn(x, -20, 20) && x !== 0, 'boosts');
  if (!NEW_MODEL_POLICIES.includes(v.newModels as NewModelPolicy)) fail('Invalid new-model policy.');
  if (typeof v.exploreShare !== 'number' || !Number.isFinite(v.exploreShare) || v.exploreShare < 0.01 || v.exploreShare > 0.2) fail('Invalid exploration share.');
  if (!Array.isArray(v.aliases) || v.aliases.length > MAX_ALIASES) fail('Invalid aliases.');
  const aliases = (v.aliases as unknown[]).map(entry => {
    if (!isRecord(entry) || Object.keys(entry).sort().join() !== 'alias,cli,identity') fail('Invalid alias.');
    const e = entry as Record<string, unknown>;
    if (!(ROUTE_CLIS as readonly unknown[]).includes(e.cli) || typeof e.alias !== 'string' || !MODEL.test(e.alias) || typeof e.identity !== 'string' || !IDENTITY.test(e.identity)) fail('Invalid alias.');
    return { cli: e.cli as string, alias: e.alias as string, identity: e.identity as string };
  });
  // Saved before flat-rate accounts existed: none.
  const flat = v.flat === undefined ? [] : v.flat;
  if (!Array.isArray(flat) || flat.length > MAX_PINS || flat.some(key => typeof key !== 'string' || !/^(?:host:[A-Za-z0-9.:[\]-]{1,120}|account:[A-Za-z0-9._-]{1,64})$/u.test(key))) fail('Invalid flat-rate list.');
  if (!Array.isArray(v.notEquivalent) || v.notEquivalent.length > MAX_PINS || v.notEquivalent.some(key => !plain(key, 300))) fail('Invalid not-equivalent list.');
  const result: RouteSettings = {
    version: 1, plans, preferSubscriptions: v.preferSubscriptions as boolean,
    expectedShare: { small: share.small as number, medium: share.medium as number, large: share.large as number },
    allow, trust, pins, boosts, newModels: v.newModels as NewModelPolicy, exploreShare: v.exploreShare as number, aliases,
    notEquivalent: [...new Set(v.notEquivalent as string[])], flat: [...new Set(flat as string[])],
    valueSpeed: 'moderate', speeds: {}, quotaWeights: {}
  };
  // Saved before plan cost by quota and speed existed: moderate, none.
  if (v.valueSpeed !== undefined && !VALUE_SPEEDS.includes(v.valueSpeed as ValueSpeed)) fail('Invalid speed preference.');
  result.valueSpeed = (v.valueSpeed as ValueSpeed | undefined) ?? 'moderate';
  result.speeds = v.speeds === undefined ? {} : map<number>(v.speeds, MAX_PINS, k => IDENTITY.test(k), (x): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 1 && x <= 10_000, 'speeds');
  result.quotaWeights = v.quotaWeights === undefined ? {} : weights(v.quotaWeights, 'quota weights');
  // Plugin storage holds 64 KB for everything the Assistant keeps: this part stays small.
  if (JSON.stringify(result).length > MAX_SETTINGS_CHARS) fail('The routing settings are too large: remove some plans, models or aliases.');
  return result;
}

/** Saved values made valid: anything that does not validate gives the defaults (nothing half-applied). */
export function normalizeRouteSettings(value: unknown): RouteSettings {
  if (value === null || value === undefined) return structuredClone(DEFAULT_ROUTE_SETTINGS) as RouteSettings;
  try { return validateRouteSettings(value); } catch { return structuredClone(DEFAULT_ROUTE_SETTINGS) as RouteSettings; }
}

/** `D0` < `D1` < `D2` < `D3`; `unset` below all. */
export const trustRank = (value: TrustLevel): number => value === 'unset' ? -1 : DATA_CLASSES.indexOf(value);
