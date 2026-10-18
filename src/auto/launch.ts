import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { classRank, type DataClass, type DataClassMode } from '../shared/settings.ts';
import { upstreamAllowed } from './classify.ts';
import type { AutoRefusal } from './i18n.ts';
import { median, type Inventory } from './inventory.ts';
import { DEFAULT_CONTEXT, DEFAULT_OUTPUT, type AutoRoutingSettings } from './settings.ts';

/**
 * The launch side of "Model: Auto (Jev)": whether this launch may use it, and the OpenCode configuration that points
 * the CLI at the router. OpenCode reads `OPENCODE_CONFIG` (a file in the run's own launch folder), then the
 * project's own config, which wins; so a project config that picks models or providers refuses Auto instead of
 * silently sending prompts elsewhere. `enabled_providers` keeps OpenCode Zen and every other configured provider
 * out, `small_model` keeps titles and summaries on the router too.
 */

/** Environments whose cards run on this computer (they reach 127.0.0.1). */
export const LOCAL_ENVIRONMENT_KINDS: readonly string[] = ['worktree'];

/** Keys of a project OpenCode config that choose models or providers. */
const MODEL_KEYS = ['model', 'small_model', 'enabled_providers', 'disabled_providers'];
const CONFIG_NAMES = ['opencode.json', 'opencode.jsonc', join('.opencode', 'opencode.json'), join('.opencode', 'opencode.jsonc')];
const MAX_CONFIG_BYTES = 1_048_576;

/** JSON with comments and trailing commas (OpenCode's own format), or undefined when it is not that. */
export function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1); i = j; continue;
    }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 1; out += ' '; continue; }
    out += c;
  }
  try { return JSON.parse(out.replace(/,(\s*[}\]])/gu, '$1')); } catch { return undefined; }
}

/** What in a project config chooses models or providers (key names only), or null. */
export function modelChoiceIn(config: unknown): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const record = config as Record<string, unknown>;
  for (const key of MODEL_KEYS) if (record[key] !== undefined) return key;
  const provider = record.provider;
  if (provider && typeof provider === 'object' && Object.keys(provider).some(id => /^ctty-jev/iu.test(id))) return 'provider';
  for (const group of ['agent', 'mode']) {
    const agents = record[group];
    if (!agents || typeof agents !== 'object') continue;
    for (const [name, agent] of Object.entries(agents as Record<string, unknown>)) {
      if (agent && typeof agent === 'object' && (agent as Record<string, unknown>).model !== undefined) return `${group}.${name}.model`;
    }
  }
  return null;
}

/**
 * The project configs OpenCode would load for `cwd`: from cwd up to the git root (or the file system root without
 * one). `found` names the first one that chooses a model; `unreadable` one that cannot be parsed.
 */
export function projectModelConfig(cwd: string): { found: string | null; unreadable: string | null } {
  let current = resolve(cwd);
  for (let depth = 0; depth < 64; depth++) {
    for (const name of CONFIG_NAMES) {
      const path = join(current, name);
      let size: number;
      try { size = statSync(path).size; } catch { continue; }
      if (size > MAX_CONFIG_BYTES) return { found: null, unreadable: path };
      let parsed: unknown;
      try { parsed = parseJsonc(readFileSync(path, 'utf8')); } catch { return { found: null, unreadable: path }; }
      if (parsed === undefined) return { found: null, unreadable: path };
      const key = modelChoiceIn(parsed);
      if (key) return { found: `${path} (${key})`, unreadable: null };
    }
    if (existsSync(join(current, '.git'))) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { found: null, unreadable: null };
}

export interface AutoLaunchInput {
  provider: string;
  role: string;
  cwd: string;
  environment: { pluginId: string; kind: string } | null | undefined;
  /** The card's effective class (after the subagent clamp). */
  dataClass: DataClass;
  settings: AutoRoutingSettings;
  mode: DataClassMode;
  /** What Auto may choose from now (see inventory.ts). */
  inventory: Inventory;
}

/** Why this launch cannot use Auto, or null. Never waits on the network. */
export function autoRefusal(input: AutoLaunchInput): AutoRefusal | null {
  if (input.provider !== 'opencode') return 'provider';
  if (input.environment && !LOCAL_ENVIRONMENT_KINDS.includes(input.environment.kind)) return 'environment';
  const offered = input.inventory.entries.filter(entry => entry.upstream.enabled && !entry.excluded);
  const waiting = input.inventory.waitingForList.some(id => input.settings.upstreams.find(upstream => upstream.id === id)?.enabled);
  if (input.settings.dailyUsdCap <= 0 || input.settings.perCardUsdCap <= 0) return 'noUpstream';
  if (!offered.length) return waiting ? 'listLoading' : 'noUpstream';
  if (!offered.some(entry => upstreamAllowed(entry.upstream, input.dataClass, input.mode))) return 'dataClass';
  const project = projectModelConfig(input.cwd);
  if (project.unreadable) return 'projectUnreadable';
  if (project.found) return 'project';
  return null;
}

/** A subagent's class is at least its parent's: an orchestrator cannot lower it for its children. */
export function clampClass(requested: DataClass, parent: DataClass | null): DataClass {
  return parent && classRank(parent) > classRank(requested) ? parent : requested;
}

export const ROUTER_KEY_ENV = 'CTTY_JEV_ROUTER_KEY';

/** The contribution for an OpenCode launch: its config file, the per-launch key and the model argument. */
/**
 * The context and output the CLI is told it may use. A person's own short list: the smallest across it (every model
 * must take every turn). With OpenRouter's whole list: the median context of the models Auto prefers (scored or
 * manually tiered), since the router sends a long turn only to models whose context holds it; output stays at the
 * default (a model with a known smaller output limit is skipped for larger requests).
 */
export function limitsFor(inventory: Inventory): { context: number; output: number } {
  const offered = inventory.entries.filter(entry => entry.upstream.enabled && !entry.excluded);
  const contexts = (list: typeof offered): number[] => list.map(entry => entry.context).filter((value): value is number => typeof value === 'number');
  const outputs = offered.map(entry => entry.output).filter((value): value is number => typeof value === 'number');
  if (offered.every(entry => entry.listed)) {
    const known = contexts(offered);
    return { context: known.length ? Math.min(...known) : DEFAULT_CONTEXT, output: outputs.length ? Math.min(...outputs) : DEFAULT_OUTPUT };
  }
  // One context per model (its effort variants share it).
  const seen = new Set<string>();
  const preferred = offered.filter(entry => (entry.tier !== null || Object.keys(entry.scores).length > 0) && !seen.has(`${entry.upstream.id}|${entry.model}`) && !!seen.add(`${entry.upstream.id}|${entry.model}`));
  const context = median(contexts(preferred.length ? preferred : offered)) ?? DEFAULT_CONTEXT;
  return { context: Math.max(16_384, Math.min(context, 1_000_000)), output: DEFAULT_OUTPUT };
}

export function openCodeContribution(input: { port: number; token: string; limit: { context: number; output: number }; providerId?: string }): { env: Record<string, string>; args: string[]; files: Array<{ relPath: string; content: string }>; thirdPartyModel: true } {
  // A random provider id per launch: a project's config cannot target it.
  const id = input.providerId ?? `ctty-jev-${randomBytes(3).toString('hex')}`;
  const limit = input.limit;
  const keyReference = `{env:${ROUTER_KEY_ENV}}`;
  const config = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      [id]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Auto (Jev)',
        // OpenCode substitutes the per-launch key from the environment: the file never holds it.
        options: { baseURL: `http://127.0.0.1:${input.port}/v1`, apiKey: keyReference },
        models: {
          auto: { name: 'Auto (Jev)', tool_call: true, limit },
          'auto-small': { name: 'Auto (Jev) small', tool_call: true, limit }
        }
      }
    },
    model: `${id}/auto`,
    small_model: `${id}/auto-small`,
    enabled_providers: [id]
  };
  return {
    env: { OPENCODE_CONFIG: '{launchFiles}/opencode.json', [ROUTER_KEY_ENV]: input.token },
    args: ['--model', `${id}/auto`],
    files: [{ relPath: 'opencode.json', content: `${JSON.stringify(config, null, 2)}\n` }],
    thirdPartyModel: true
  };
}
