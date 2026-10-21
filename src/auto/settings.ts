/**
 * "Model: Auto (Jev)" settings (storage key `autoRouting`, non-secret). The upstream keys live in the plugin's
 * secrets (`auto-upstream-<id>`, `{ origin, value }` JSON written by the decision models page), bound to the
 * upstream's origin and read by the service only at call time. Shared by the service and the page: no Node APIs.
 */
import { validUrl, type DataClass } from '../shared/settings.ts';
import { isEffort, type ReasoningEffort } from './catalog/identity.ts';
import { modelTrafficForbidden } from './jevOnlyRule.ts';

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
  /**
   * A manual tier (optional): the model then answers turns of that tier first, whatever the catalog says. Without
   * one, Auto chooses it by its catalog score for the turn's task type.
   */
  tier?: AutoTier;
  /**
   * The effort this model runs at. On OpenRouter Auto sends it (`reasoning.effort`); on another upstream it only says
   * which benchmark row describes the model (the upstream's own setting), and nothing extra is sent.
   */
  effort?: ReasoningEffort;
  /** USD per million tokens, input and output (the person's own figures win over the catalog's). */
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
  /** Models listed by the person: the whole allow-list of an OpenAI-compatible upstream; overrides and additions on OpenRouter. */
  models: AutoModel[];
  /** OpenRouter: also offer every suitable model from OpenRouter's own list (with its context and prices). */
  allModels: boolean;
  /** Model ids Auto never uses (the person's exclude toggles). */
  excluded: string[];
  enabled: boolean;
}

export interface AutoCatalogSettings {
  /** Refresh the public catalog in the background while Auto has an upstream. */
  autoRefresh: boolean;
  /** Ratings and models.dev; OpenRouter's list is refreshed daily. */
  refreshHours: number;
}

/**
 * Several models on one hard turn (request level, text turns only; see consensus.ts). `consensus`: off; auto (only when
 * its expected value beats the single strong model); always (every eligible hard turn the caps allow). `bestOfN`:
 * compare and keep the best draft instead of merging — only when the person turns it on. `k` models at most (≤ 3),
 * and the whole fan-out of one turn (drafts + judge) within `turnUsdCap` and the daily and per-card caps.
 */
export type ConsensusMode = 'off' | 'auto' | 'always';
export const CONSENSUS_MODES: readonly ConsensusMode[] = ['off', 'auto', 'always'];
export interface AutoStrategySettings { consensus: ConsensusMode; k: number; bestOfN: boolean; turnUsdCap: number }
export const MAX_CONSENSUS_K = 3;

export interface AutoRoutingSettings {
  upstreams: AutoUpstream[];
  preference: AutoPreference;
  /** A tier with no usable model may fall back to a cheaper one (a stronger one is always tried first). */
  cheaperFallback: boolean;
  decider: AutoDecider;
  /** USD; 0 means no Auto calls at all. */
  dailyUsdCap: number;
  perCardUsdCap: number;
  catalog: AutoCatalogSettings;
  strategy: AutoStrategySettings;
}

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const MAX_AUTO_UPSTREAMS = 8;
export const MAX_AUTO_MODELS = 64;
export const MAX_EXCLUDED = 256;
export const DEFAULT_CONTEXT = 128_000;
export const DEFAULT_OUTPUT = 8_192;

export const DEFAULT_AUTO_SETTINGS: AutoRoutingSettings = {
  upstreams: [], preference: 'balanced', cheaperFallback: false, decider: 'jev', dailyUsdCap: 1, perCardUsdCap: 0.4,
  catalog: { autoRefresh: true, refreshHours: 168 },
  strategy: { consensus: 'auto', k: 3, bestOfN: false, turnUsdCap: 1 }
};
/** Fields older saved settings may lack: filled with these. */
const OPTIONAL_KEYS = ['catalog', 'strategy'];

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
  only(value, ['id', 'preset', 'baseUrl', 'trust', 'key', 'models', 'allModels', 'excluded', 'enabled'], 'Upstream');
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
    only(raw, ['id', 'tier', 'effort', 'priceIn', 'priceOut', 'context', 'output'], 'Model');
    if (typeof raw.id !== 'string' || !MODEL_ID.test(raw.id)) fail('Invalid model id.');
    if (seen.has(raw.id)) fail(`Model ${raw.id} is listed twice.`);
    seen.add(raw.id);
    if (raw.tier !== undefined && !AUTO_TIERS.includes(raw.tier as AutoTier)) fail('Invalid model tier.');
    if (raw.effort !== undefined && !isEffort(raw.effort)) fail('Invalid model effort.');
    if (!price(raw.priceIn) || !price(raw.priceOut)) fail('Invalid model price.');
    if (!tokens(raw.context) || !tokens(raw.output)) fail('Invalid model limits.');
    const model: AutoModel = { id: raw.id };
    for (const key of ['tier', 'effort', 'priceIn', 'priceOut', 'context', 'output'] as const) if (raw[key] !== undefined) (model as unknown as Record<string, unknown>)[key] = raw[key];
    models.push(model);
  }
  const allModels = value.allModels ?? value.preset === 'openrouter';
  if (typeof allModels !== 'boolean') fail('Invalid upstream.');
  if (allModels && value.preset !== 'openrouter') fail('Only OpenRouter publishes a model list Auto can use on its own.');
  const excluded = value.excluded ?? [];
  if (!Array.isArray(excluded) || excluded.length > MAX_EXCLUDED || excluded.some(id => typeof id !== 'string' || !MODEL_ID.test(id))) fail(`At most ${MAX_EXCLUDED} excluded models, by their ids.`);
  // OpenRouter carries only Jev's own decisions: an upstream there (or saved from before this rule) stays off.
  if (value.enabled && (value.preset === 'openrouter' || modelTrafficForbidden(baseUrl))) fail(JEV_ONLY_MESSAGE);
  return { id: value.id, preset: value.preset, baseUrl: baseUrl.replace(/\/+$/u, ''), trust: value.trust as DataClass, key, models, allModels, excluded: [...new Set(excluded as string[])], enabled: value.enabled };
}

export function validateAutoSettings(value: unknown): AutoRoutingSettings {
  if (!isRecord(value)) fail('Invalid Auto (Jev) settings.');
  only(value, Object.keys(DEFAULT_AUTO_SETTINGS), 'Auto (Jev) settings');
  for (const key of Object.keys(DEFAULT_AUTO_SETTINGS)) if (!OPTIONAL_KEYS.includes(key) && !Object.hasOwn(value, key)) fail(`Auto (Jev) settings: ${key} is missing.`);
  if (!Array.isArray(value.upstreams) || value.upstreams.length > MAX_AUTO_UPSTREAMS) fail(`At most ${MAX_AUTO_UPSTREAMS} upstreams.`);
  const upstreams = value.upstreams.map(validateAutoUpstream);
  if (new Set(upstreams.map(entry => entry.id)).size !== upstreams.length) fail('Two upstreams have the same id.');
  if (!AUTO_PREFERENCES.includes(value.preference as AutoPreference)) fail('Invalid preference.');
  if (typeof value.cheaperFallback !== 'boolean') fail('Invalid fallback choice.');
  if (value.decider !== 'jev' && value.decider !== 'rules') fail('Invalid decider.');
  if (!usd(value.dailyUsdCap) || !usd(value.perCardUsdCap)) fail('Caps are USD from 0 to 100.');
  const catalog = value.catalog ?? DEFAULT_AUTO_SETTINGS.catalog;
  if (!isRecord(catalog)) fail('Invalid catalog settings.');
  only(catalog, ['autoRefresh', 'refreshHours'], 'Catalog settings');
  if (typeof catalog.autoRefresh !== 'boolean' || !Number.isInteger(catalog.refreshHours) || (catalog.refreshHours as number) < 1 || (catalog.refreshHours as number) > 720) fail('Catalog refresh: every 1 to 720 hours.');
  const strategy = value.strategy ?? DEFAULT_AUTO_SETTINGS.strategy;
  if (!isRecord(strategy)) fail('Invalid strategy settings.');
  only(strategy, ['consensus', 'k', 'bestOfN', 'turnUsdCap'], 'Strategy settings');
  if (!CONSENSUS_MODES.includes(strategy.consensus as ConsensusMode)) fail('Invalid consensus choice.');
  if (!Number.isInteger(strategy.k) || (strategy.k as number) < 2 || (strategy.k as number) > MAX_CONSENSUS_K) fail(`Consensus: 2 to ${MAX_CONSENSUS_K} models.`);
  if (typeof strategy.bestOfN !== 'boolean') fail('Invalid best-of-N choice.');
  if (!usd(strategy.turnUsdCap)) fail('Caps are USD from 0 to 100.');
  return { upstreams, preference: value.preference as AutoPreference, cheaperFallback: value.cheaperFallback, decider: value.decider, dailyUsdCap: value.dailyUsdCap as number, perCardUsdCap: value.perCardUsdCap as number, catalog: { autoRefresh: catalog.autoRefresh, refreshHours: catalog.refreshHours as number },
    strategy: { consensus: strategy.consensus as ConsensusMode, k: strategy.k as number, bestOfN: strategy.bestOfN, turnUsdCap: strategy.turnUsdCap as number } };
}

/** As saved, made valid: a bad upstream disables only itself; other fields fall back to their defaults alone. */
export function normalizeAutoSettings(value: unknown): AutoRoutingSettings {
  const source = isRecord(value) ? value : {};
  const upstreams: AutoUpstream[] = [];
  for (const raw of Array.isArray(source.upstreams) ? source.upstreams.slice(0, MAX_AUTO_UPSTREAMS) : []) {
    try {
      const entry = validateAutoUpstream(jevOnlyOff(raw));
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

export const JEV_ONLY_MESSAGE = 'OpenRouter is used only for Jev\'s own decisions: Auto cannot send model calls there. Use another provider.';

/** An upstream on OpenRouter saved before the Jev-only rule: kept, switched off. */
export function isJevOnlyUpstream(upstream: Pick<AutoUpstream, 'preset' | 'baseUrl'>): boolean {
  return upstream.preset === 'openrouter' || modelTrafficForbidden(upstream.baseUrl ?? OPENROUTER_BASE_URL);
}
function jevOnlyOff(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const preset = raw.preset, baseUrl = preset === 'openrouter' ? OPENROUTER_BASE_URL : raw.baseUrl;
  return preset === 'openrouter' || typeof baseUrl === 'string' && modelTrafficForbidden(baseUrl) ? { ...raw, enabled: false } : raw;
}

/** The secret an upstream's own key is saved under. */
export const upstreamSecret = (id: string): string => `auto-upstream-${id}`;
/** The Jev · OpenRouter backend's key (shared when an OpenRouter upstream says `key: "jev"`). */
export const JEV_OPENROUTER_SECRET = 'assistant-openrouter';
