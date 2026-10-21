// Realistic inputs for route v2, with no keys and no person data: the plugin's bundled benchmark rows (real model
// identities), an OpenRouter-like price list, list_providers entries shaped like CanvasTTY 1.8.x returns them,
// Accounts list_routes rows, and limit snapshots shaped like CanvasTTY's `limits.get`.
import { readFileSync } from 'node:fs';
import { BenchmarkIndex } from '../../src/auto/catalog/scoring.ts';
import { turnView } from '../../src/auto/select.ts';
import { DEFAULT_ROUTE_SETTINGS, validateRouteSettings } from '../../src/route/settings.ts';

export const NOW = Date.parse('2026-10-18T12:00:00Z');
const bundled = JSON.parse(readFileSync(new URL('../../src/auto/catalog/bundled.json', import.meta.url), 'utf8'));

/** USD per million tokens, as OpenRouter lists them (live run of 2026-10-18 where known; others plausible). */
export const PRICES = {
  'anthropic/claude-opus-4.8': [5, 25], 'anthropic/claude-sonnet-5': [2, 10], 'openai/gpt-5.5': [2.5, 15], 'openai/gpt-5.4': [2.5, 15],
  'openai/gpt-5.4-mini': [0.75, 4.5], 'z-ai/glm-5.3': [0.6, 2.2], 'minimax/minimax-m3': [0.3, 1.2], 'google/gemini-3.1-pro-preview': [2, 12],
  'deepseek/deepseek-v4-flash': [0.1, 0.4], 'x-ai/grok-4-7': [3, 15], 'moonshotai/kimi-k3': [0.6, 2.5], 'openai/gpt-6.1-sol': [2, 10], 'openai/gpt-6-astra': [5, 30]
};

export function catalog({ now = NOW, prices = PRICES } = {}) {
  return {
    asOf: now,
    benchmarks: bundled.benchmarks.map(row => ({ ...row, historical: false })),
    models: [], providers: [{ id: 'zai', origin: 'https://api.z.ai' }], pricesStale: true,
    openRouter: { version: 1, fetchedAt: now, models: Object.entries(prices).map(([id, [priceIn, priceOut]]) => ({ id, name: id, context: 400_000, maxOutput: 32_000, priceIn, priceOut, tools: true, reasoning: true, text: true })) },
    openRouterPricesStale: false
  };
}

export const index = (cat = catalog()) => new BenchmarkIndex(cat);

const ASSISTANT = { pluginId: 'canvastty-assistant', plugin: 'CanvasTTY Assistant', fields: [{ key: 'task', kind: 'text' }, { key: 'dataClass', kind: 'select', choices: ['default', 'D0', 'D1', 'D2', 'D3'] }, { key: 'model', kind: 'select', choices: ['off', 'auto'] }] };
const ACCOUNTS = { pluginId: 'canvastty-accounts', plugin: 'CanvasTTY Accounts', fields: [{ key: 'account', kind: 'select' }, { key: 'effort', kind: 'select', choices: ['default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }, { key: 'trustFolder', kind: 'boolean' }] };
const ACCOUNTS_CLIS = new Set(['claude', 'codex', 'opencode', 'qwen', 'kimi', 'grok']);
const EFFORTS = { codex: ['minimal', 'low', 'medium', 'high', 'xhigh'], claude: ['low', 'medium', 'high', 'xhigh', 'max'], grok: ['low', 'medium', 'high', 'xhigh'] };
const ORCH = new Set(['codex', 'claude', 'qwen', 'kimi', 'opencode', 'hermes']);
const MODEL = new Set(['codex', 'claude', 'qwen', 'kimi', 'opencode', 'grok', 'omp', 'pi', 'cursor']);

/** A list_providers().providers array in 1.8.x's shape. `signIn` per CLI; `installed` lists the CLIs found. */
export function providers({ installed = ['claude', 'codex', 'opencode', 'grok', 'qwen', 'kimi', 'hermes'], signIn = {}, accounts = true, known = { opencode: ['opencode/big-pickle', 'zai-coding-plan/glm-5.3', 'zai-coding-plan/glm-5.3-flash', 'openrouter/z-ai/glm-5.3'] } } = {}) {
  return ['codex', 'claude', 'qwen', 'kimi', 'opencode', 'hermes', 'grok', 'omp', 'pi', 'cursor', 'minimax', 'devin', 'antigravity'].map(id => ({
    id, name: id, installed: installed.includes(id), available: installed.includes(id), signIn: signIn[id] ?? (installed.includes(id) ? 'ok' : 'unknown'),
    ...(signIn[id] !== 'unknown' && installed.includes(id) ? { signInCheckedAt: NOW - 120_000 } : {}),
    subagent: true, orchestrator: ORCH.has(id),
    model: { supported: MODEL.has(id), format: 'x', ...(known[id] ? { known: known[id], knownAt: NOW - 60_000 } : {}) },
    ...(EFFORTS[id] ? { efforts: EFFORTS[id] } : {}),
    profiles: ['normal', 'plan'],
    launchOptions: [ASSISTANT, ...(accounts && ACCOUNTS_CLIS.has(id) ? [ACCOUNTS] : [])]
  }));
}

/** Accounts list_routes rows (no keys: an address host only). */
export function accountRows() {
  return [
    { provider: 'opencode', agent: 'OpenCode', accountId: 'zai-glm', account: 'Z.AI GLM', kind: 'api-key', model: 'glm-5.3', endpoint: 'api.z.ai', state: 'ready', launchOptions: { 'canvastty-accounts': { account: 'zai-glm', effort: 'default', trustFolder: false } } },
    { provider: 'claude', agent: 'Claude Code', accountId: 'zai-glm', account: 'Z.AI GLM', kind: 'api-key', model: 'glm-5.3', endpoint: 'api.z.ai', state: 'ready', launchOptions: { 'canvastty-accounts': { account: 'zai-glm', effort: 'default', trustFolder: false } } },
    { provider: 'claude', agent: 'Claude Code', accountId: 'or-opus', account: 'Anthropic Opus', kind: 'api-key', model: 'anthropic/claude-opus-4.8', endpoint: 'api.anthropic.com', state: 'ready', launchOptions: { 'canvastty-accounts': { account: 'or-opus', effort: 'default', trustFolder: false } } },
    { provider: 'claude', agent: 'Claude Code', accountId: 'local-qwen', account: 'Qwen local', kind: 'ollama', model: 'qwen3.5:9b', endpoint: '127.0.0.1:11434', state: 'ollama-down', reason: 'Ollama is not running on this computer' },
    { provider: 'codex', agent: 'Codex', accountId: 'mm', account: 'MiniMax', kind: 'api-key', model: 'minimax-m3', endpoint: 'api.minimax.io', state: 'no-key', reason: 'no key is saved for it (Accounts settings)' }
  ];
}

/** CanvasTTY's `limits.get` answer for a surface. */
export function limitsAnswer({ now = NOW, claude = 41, claudeWeekly = 18, codex = 72, codexElapsed = 0.5, fetchedAt = now - 3 * 60_000 } = {}) {
  const win = (id, slot, used, minutes, resetsIn, label) => ({ id, bucketId: id, slot, isDefaultBucket: true, label, usedPercent: used, used: null, limit: null, windowMinutes: minutes, resetsAt: now + resetsIn });
  return { state: 'ready', snapshot: { fetchedAt, providers: [
    { provider: 'claude', state: 'available', source: 'claude-usage-api', fetchedAt, windows: [win('5h', 'primary', claude, 300, 150 * 60_000, '5 h'), win('7d', 'secondary', claudeWeekly, 10_080, 5 * 86_400_000, 'weekly')] },
    { provider: 'codex', state: 'available', source: 'codex-app-server', fetchedAt, windows: [win('p', 'primary', codex, 300, Math.round((1 - codexElapsed) * 300) * 60_000, 'primary')] },
    { provider: 'qwen', state: 'unavailable', source: 'qwen-cli', checkedAt: fetchedAt, reason: 'unsupported-protocol' },
    { provider: 'grok', state: 'unavailable', source: 'grok-billing-api', checkedAt: fetchedAt, reason: 'not-authenticated' }
  ] } };
}

/** The person's declarations: Claude Max (opus, sonnet), ChatGPT Pro in Codex (gpt-5.5), a GLM coding plan in OpenCode. */
export function declared(extra = {}) {
  return validateRouteSettings({
    ...structuredClone(DEFAULT_ROUTE_SETTINGS),
    plans: [
      { id: 'claude-max', cli: 'claude', kind: 'subscription', label: 'Max', models: ['opus', 'sonnet'], reserve: 20, maxParallel: 2, allow: 'allow', trust: 'D2' },
      { id: 'codex-pro', cli: 'codex', kind: 'subscription', label: 'Pro', models: ['gpt-5.5'], reserve: 20, maxParallel: 2, allow: 'allow', trust: 'D2' },
      { id: 'glm-plan', cli: 'opencode', kind: 'coding-plan', label: 'GLM Coding Plan', models: ['zai-coding-plan/*'], reserve: 20, maxParallel: 2, allowance: 100, windowHours: 5, allow: 'allow', trust: 'D1' }
    ],
    ...extra
  });
}

export const view = (type, level, { confidence = level === 'small' ? 0.9 : 0.2, strong = false } = {}) =>
  turnView({ difficulty: level === 'small' ? 'simple' : level === 'large' ? 'hard' : 'normal', strong, type, confidence }, 'jev', '', { role: 'subagent' });
