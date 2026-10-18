/**
 * OpenRouter's public model list (`GET https://openrouter.ai/api/v1/models`, no key): which models an OpenRouter
 * upstream offers, their context, output limit and prices. Read only from that fixed address; nothing about a task
 * is sent. Prices are USD per million tokens (OpenRouter publishes USD per token as strings).
 */
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_MODELS_BYTES = 16 * 1024 * 1024;
const MAX_MODELS = 5_000;
const ID = /^~?[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

export interface OpenRouterModel {
  id: string;
  name: string;
  context: number | null;
  maxOutput: number | null;
  /** USD per million tokens; null when OpenRouter does not publish a fixed price (for example a meta-router). */
  priceIn: number | null;
  priceOut: number | null;
  /** `supported_parameters` has `tools`: OpenCode sends tools on every turn. */
  tools: boolean;
  /** `supported_parameters` has `reasoning`: Auto may send `reasoning.effort`. */
  reasoning: boolean;
  /** Text in and text out. */
  text: boolean;
}

export interface OpenRouterSnapshot { version: 1; fetchedAt: number; models: OpenRouterModel[] }

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const label = (value: unknown, fallback: string): string => typeof value === 'string' && value.trim() && value.length <= 200 ? value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim() : fallback;
const tokens = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 100_000_000 ? value : null;

/** USD per token (a decimal string or a number) → USD per million tokens, or null (absent, negative = variable, absurd). */
export function perMillion(value: unknown): number | null {
  const number = typeof value === 'string' && /^\d+(?:\.\d+)?(?:e-?\d+)?$/iu.test(value.trim()) ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(number) || number < 0 || number > 0.01) return null;
  return Math.round(number * 1e6 * 1e6) / 1e6;
}

export function normalizeOpenRouterModels(input: unknown): OpenRouterModel[] {
  const data = record(input)?.data;
  if (!Array.isArray(data) || !data.length || data.length > MAX_MODELS) throw new Error('Invalid OpenRouter model list');
  const seen = new Set<string>();
  const models: OpenRouterModel[] = [];
  for (const raw of data) {
    const entry = record(raw);
    if (!entry || typeof entry.id !== 'string' || !ID.test(entry.id) || entry.id.length > 160 || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const pricing = record(entry.pricing) ?? {};
    const architecture = record(entry.architecture) ?? {};
    const top = record(entry.top_provider) ?? {};
    const parameters = Array.isArray(entry.supported_parameters) ? entry.supported_parameters.filter((p): p is string => typeof p === 'string') : [];
    const inputs = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : null;
    const outputs = Array.isArray(architecture.output_modalities) ? architecture.output_modalities : null;
    const modality = typeof architecture.modality === 'string' ? architecture.modality : '';
    const text = inputs && outputs ? inputs.includes('text') && outputs.includes('text') : /^(?:[a-z+]*\btext\b[a-z+]*)->(?:[a-z+]*\btext\b[a-z+]*)$/u.test(modality);
    models.push({
      id: entry.id, name: label(entry.name, entry.id),
      context: tokens(top.context_length) ?? tokens(entry.context_length),
      maxOutput: tokens(top.max_completion_tokens),
      priceIn: perMillion(pricing.prompt), priceOut: perMillion(pricing.completion),
      tools: parameters.includes('tools'), reasoning: parameters.includes('reasoning'), text
    });
  }
  if (!models.length) throw new Error('Empty OpenRouter model list');
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

/** The cached list, checked as strictly as a download before routing reads it. */
export function validateOpenRouterSnapshot(input: unknown, now: number): OpenRouterSnapshot {
  const data = record(input);
  if (!data || data.version !== 1 || typeof data.fetchedAt !== 'number' || !Number.isSafeInteger(data.fetchedAt) || data.fetchedAt > now || !Array.isArray(data.models) || !data.models.length || data.models.length > MAX_MODELS) throw new Error('Invalid OpenRouter cache');
  const seen = new Set<string>();
  const models = data.models.map(raw => {
    const m = record(raw);
    if (!m || typeof m.id !== 'string' || !ID.test(m.id) || seen.has(m.id) || typeof m.name !== 'string' || m.name.length > 200) throw new Error('Invalid OpenRouter cache');
    seen.add(m.id);
    for (const key of ['context', 'maxOutput']) if (m[key] !== null && tokens(m[key]) !== m[key]) throw new Error('Invalid OpenRouter cache');
    for (const key of ['priceIn', 'priceOut']) if (m[key] !== null && !(typeof m[key] === 'number' && Number.isFinite(m[key]) && (m[key] as number) >= 0 && (m[key] as number) <= 10_000)) throw new Error('Invalid OpenRouter cache');
    for (const key of ['tools', 'reasoning', 'text']) if (typeof m[key] !== 'boolean') throw new Error('Invalid OpenRouter cache');
    return { id: m.id, name: m.name, context: m.context as number | null, maxOutput: m.maxOutput as number | null, priceIn: m.priceIn as number | null, priceOut: m.priceOut as number | null, tools: m.tools as boolean, reasoning: m.reasoning as boolean, text: m.text as boolean };
  });
  return { version: 1, fetchedAt: data.fetchedAt, models };
}

/**
 * Whether Auto offers an OpenRouter model on its own (the person can still list any model by hand): text in and
 * out, tool calls, a fixed price, not OpenRouter's own meta-router, not a `~` alias that moves to another model, and
 * not a `:free` variant (free endpoints may keep or train on prompts, and their rate limits are tight).
 */
export function offeredByDefault(model: OpenRouterModel): boolean {
  return model.text && model.tools && model.priceIn !== null && model.priceOut !== null
    && !model.id.startsWith('openrouter/') && !model.id.startsWith('~') && !model.id.endsWith(':free');
}
