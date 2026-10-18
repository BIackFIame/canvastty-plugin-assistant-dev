/**
 * "Model: Auto (Jev)" settings (storage key `autoRouting`, non-secret). The upstream keys live in the plugin's
 * secrets (`auto-upstream-<id>`, `{ origin, value }` JSON written by the decision models page), bound to the
 * upstream's origin and read by the service only at call time. Shared by the service and the page: no Node APIs.
 */
import { validUrl, type DataClass } from '../shared/settings.ts';

export type AutoTier = 'small' | 'medium' | 'large';
export const AUTO_TIERS: readonly AutoTier[] = ['small', 'medium', 'large'];
export type AutoPreference = 'cheap' | 'balanced' | 'best';
export const AUTO_PREFERENCES: readonly AutoPreference[] = ['cheap', 'balanced', 'best'];
export type AutoUpstreamPreset = 'openrouter' | 'openai-compatible';
/** Who decides how hard a turn is: Jev (the Assistant's task triage, word rules when it does not answer) or rules only. */
export type AutoDecider = 'jev' | 'rules';

export interface AutoModel {
  /** The upstream's exact model id, for example `qwen/qwen3-coder`. */
  id: string;
  tier: AutoTier;
  /** USD per million tokens, input and output: orders cheap/best and estimates cost when the upstream reports none. */
  priceIn?: number;
  priceOut?: number;
  /** Tokens; the smallest across the allow-list goes into the CLI's limits. */
  context?: number;
  output?: number;
}

export interface AutoUpstream {
  id: string;
  preset: AutoUpstreamPreset;
  /** OpenAI-compatible base URL (…/v1); fixed for OpenRouter. */
  baseUrl: string;
  /** The highest data class this upstream may receive (the person's own trust). D3 only for a server on this computer. */
  trust: DataClass;
  /** `own`: the key saved for this upstream; `jev`: the Jev · OpenRouter key (same origin, OpenRouter only). */
  key: 'own' | 'jev' | 'none';
  models: AutoModel[];
  enabled: boolean;
}

export interface AutoRoutingSettings {
  upstreams: AutoUpstream[];
  preference: AutoPreference;
  /** A tier with no usable model may fall back to a cheaper one (a stronger one is always tried first). */
  cheaperFallback: boolean;
  decider: AutoDecider;
  /** USD; 0 means no Auto calls at all. */
  dailyUsdCap: number;
  perCardUsdCap: number;
}

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const MAX_AUTO_UPSTREAMS = 8;
export const MAX_AUTO_MODELS = 16;
export const DEFAULT_CONTEXT = 128_000;
export const DEFAULT_OUTPUT = 8_192;

export const DEFAULT_AUTO_SETTINGS: AutoRoutingSettings = {
  upstreams: [], preference: 'balanced', cheaperFallback: false, decider: 'jev', dailyUsdCap: 1, perCardUsdCap: 0.4
};

const ID = /^[a-z0-9][a-z0-9-]{0,23}$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,159}$/u;
const CLASSES: readonly DataClass[] = ['D0', 'D1', 'D2', 'D3'];

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function fail(message: string): never { throw new Error(message); }
function only(value: Record<string, unknown>, keys: readonly string[], what: string): void {
  const extra = Object.keys(value).find(key => !keys.includes(key));
  if (extra) fail(`${what}: unknown field ${extra.slice(0, 40)}.`);
}
const price = (value: unknown): boolean => value === undefined || typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000;
const tokens = (value: unknown): boolean => value === undefined || Number.isInteger(value) && (value as number) >= 1_024 && (value as number) <= 10_000_000;
const usd = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

export function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === '127.0.0.1' || host === '[::1]' || host === 'localhost';
  } catch { return false; }
}

/** The origin a key is bound to. */
export function originOf(baseUrl: string): string { return new URL(baseUrl).origin; }

export function validateAutoUpstream(value: unknown): AutoUpstream {
  if (!isRecord(value)) fail('Invalid upstream.');
  only(value, ['id', 'preset', 'baseUrl', 'trust', 'key', 'models', 'enabled'], 'Upstream');
  if (typeof value.id !== 'string' || !ID.test(value.id)) fail('Upstream id: lowercase letters, digits and dashes, at most 24.');
  if (value.preset !== 'openrouter' && value.preset !== 'openai-compatible') fail('Unknown upstream kind.');
  if (typeof value.enabled !== 'boolean') fail('Invalid upstream.');
  const baseUrl = value.preset === 'openrouter' ? OPENROUTER_BASE_URL : value.baseUrl;
  if (value.preset === 'openrouter' && value.baseUrl !== undefined && value.baseUrl !== OPENROUTER_BASE_URL) fail('OpenRouter has a fixed address.');
  if (typeof baseUrl !== 'string' || !validUrl(baseUrl.replace(/\/+$/u, '')) || !/^https?:\/\/[^/]+(?:\/[A-Za-z0-9._~-]+)*\/?$/u.test(baseUrl)) fail('Invalid upstream address (https, or http on this computer only).');
  if (!CLASSES.includes(value.trust as DataClass)) fail('Invalid upstream trust.');
  if (value.trust === 'D3' && !isLoopbackUrl(baseUrl)) fail('D3 stays on this computer: only a server on 127.0.0.1 can take it.');
  const key = value.key ?? 'own';
  if (key !== 'own' && key !== 'jev' && key !== 'none') fail('Invalid upstream key choice.');
  if (key === 'jev' && value.preset !== 'openrouter') fail('Only an OpenRouter upstream can use the Jev · OpenRouter key.');
  if (key === 'none' && !isLoopbackUrl(baseUrl)) fail('Only a server on this computer can work without a key.');
  if (!Array.isArray(value.models) || value.models.length > MAX_AUTO_MODELS) fail(`At most ${MAX_AUTO_MODELS} models per upstream.`);
  const models: AutoModel[] = [];
  const seen = new Set<string>();
  for (const raw of value.models) {
    if (!isRecord(raw)) fail('Invalid model.');
    only(raw, ['id', 'tier', 'priceIn', 'priceOut', 'context', 'output'], 'Model');
    if (typeof raw.id !== 'string' || !MODEL_ID.test(raw.id)) fail('Invalid model id.');
    if (seen.has(raw.id)) fail(`Model ${raw.id} is listed twice.`);
    seen.add(raw.id);
    if (!AUTO_TIERS.includes(raw.tier as AutoTier)) fail('Invalid model tier.');
    if (!price(raw.priceIn) || !price(raw.priceOut)) fail('Invalid model price.');
    if (!tokens(raw.context) || !tokens(raw.output)) fail('Invalid model limits.');
    models.push(structuredClone(raw) as unknown as AutoModel);
  }
  return { id: value.id, preset: value.preset, baseUrl: baseUrl.replace(/\/+$/u, ''), trust: value.trust as DataClass, key, models, enabled: value.enabled };
}

export function validateAutoSettings(value: unknown): AutoRoutingSettings {
  if (!isRecord(value)) fail('Invalid Auto (Jev) settings.');
  only(value, Object.keys(DEFAULT_AUTO_SETTINGS), 'Auto (Jev) settings');
  if (!Array.isArray(value.upstreams) || value.upstreams.length > MAX_AUTO_UPSTREAMS) fail(`At most ${MAX_AUTO_UPSTREAMS} upstreams.`);
  const upstreams = value.upstreams.map(validateAutoUpstream);
  if (new Set(upstreams.map(entry => entry.id)).size !== upstreams.length) fail('Two upstreams have the same id.');
  if (!AUTO_PREFERENCES.includes(value.preference as AutoPreference)) fail('Invalid preference.');
  if (typeof value.cheaperFallback !== 'boolean') fail('Invalid fallback choice.');
  if (value.decider !== 'jev' && value.decider !== 'rules') fail('Invalid decider.');
  if (!usd(value.dailyUsdCap) || !usd(value.perCardUsdCap)) fail('Caps are USD from 0 to 100.');
  return { upstreams, preference: value.preference as AutoPreference, cheaperFallback: value.cheaperFallback, decider: value.decider, dailyUsdCap: value.dailyUsdCap as number, perCardUsdCap: value.perCardUsdCap as number };
}

/** As saved, made valid: a bad upstream disables only itself; other fields fall back to their defaults alone. */
export function normalizeAutoSettings(value: unknown): AutoRoutingSettings {
  const source = isRecord(value) ? value : {};
  const upstreams: AutoUpstream[] = [];
  for (const raw of Array.isArray(source.upstreams) ? source.upstreams.slice(0, MAX_AUTO_UPSTREAMS) : []) {
    try {
      const entry = validateAutoUpstream(raw);
      if (!upstreams.some(other => other.id === entry.id)) upstreams.push(entry);
    } catch { /* this one alone is dropped */ }
  }
  const candidate: Record<string, unknown> = { ...structuredClone(DEFAULT_AUTO_SETTINGS), upstreams };
  for (const key of Object.keys(DEFAULT_AUTO_SETTINGS)) {
    if (key === 'upstreams' || !Object.hasOwn(source, key)) continue;
    try { validateAutoSettings({ ...candidate, [key]: source[key] }); candidate[key] = source[key]; } catch { /* default */ }
  }
  return validateAutoSettings(candidate);
}

/** The secret an upstream's own key is saved under. */
export const upstreamSecret = (id: string): string => `auto-upstream-${id}`;
/** The Jev · OpenRouter backend's key (shared when an OpenRouter upstream says `key: "jev"`). */
export const JEV_OPENROUTER_SECRET = 'assistant-openrouter';
