import { createHmac } from 'node:crypto';
import { ruleDifficulty, type Difficulty } from '../harness/router.ts';
import { classRank, type DataClass, type DataClassMode } from '../shared/settings.ts';
import type { InventoryEntry } from './inventory.ts';
import { manualOrder } from './select.ts';
import type { AutoModel, AutoRoutingSettings, AutoTier, AutoUpstream } from './settings.ts';

/**
 * What one Chat Completions request is, and which models may answer it. Pure: no I/O.
 *
 * - `small`: OpenCode's small_model calls (titles, summaries): the cheapest allowed model, no Jev.
 * - `turn`: the last message is the person's (or the orchestrator's) new text: decide once.
 * - `continuation`: the last message is a tool result or the assistant's own: the turn's decision stays.
 */
export type RequestKind = 'small' | 'turn' | 'continuation';

interface ChatMessage { role?: unknown; content?: unknown; tool_calls?: unknown }

/** Text of a message's content (a string, or text parts). */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '').filter(Boolean).join('\n');
}

const messagesOf = (body: Record<string, unknown>): ChatMessage[] => Array.isArray(body.messages) ? body.messages.filter((m): m is ChatMessage => !!m && typeof m === 'object') : [];

export function requestKind(body: Record<string, unknown>, smallModel: boolean): RequestKind {
  if (smallModel) return 'small';
  const last = messagesOf(body).at(-1);
  return last?.role === 'user' ? 'turn' : 'continuation';
}

/**
 * The latest user text, without the envelopes CLIs wrap around it (system reminders, environment blocks), for the
 * decision only. The engine bounds and redacts it again before anything leaves.
 */
export function latestUserText(body: Record<string, unknown>): string {
  const user = [...messagesOf(body)].reverse().find(message => message.role === 'user');
  return contentText(user?.content)
    .replace(/<(system-reminder|environment_details|env|context)\b[^>]*>[\s\S]*?<\/\1>/giu, ' ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/gu, ' ')
    .trim();
}

/** Keyed hashes (HMAC with the install's salt): stable within this install, meaningless outside it. */
export function keyed(salt: Buffer, ...parts: string[]): string {
  const mac = createHmac('sha256', salt);
  for (const part of parts) mac.update(part, 'utf8').update('\u0000');
  return mac.digest('hex').slice(0, 24);
}

export interface RequestKeys { conversation: string; turn: string; contract: string }

/**
 * conversation = the card's key, the system prompt and the first user message; turn = how many user messages and
 * the last one; contract = tools, tool_choice and system text (a change ends the turn's decision).
 */
export function requestKeys(salt: Buffer, tokenHash: string, body: Record<string, unknown>): RequestKeys {
  const messages = messagesOf(body);
  const system = messages.filter(message => message.role === 'system' || message.role === 'developer').map(message => contentText(message.content)).join('\n');
  const users = messages.filter(message => message.role === 'user');
  return {
    conversation: keyed(salt, tokenHash, system, contentText(users[0]?.content)),
    turn: keyed(salt, String(users.length), contentText(users.at(-1)?.content)),
    contract: keyed(salt, JSON.stringify(body.tools ?? null), JSON.stringify(body.tool_choice ?? null), system)
  };
}

export { tierFor } from './select.ts';

/** Word rules plus size: a long turn or a large tool set is not "simple". */
export function rulesDifficulty(text: string, toolCount: number): Difficulty {
  const words = ruleDifficulty(text);
  if (words === 'simple' && (text.length > 1_500 || toolCount > 24)) return 'normal';
  return words;
}

export interface Candidate { upstream: AutoUpstream; model: AutoModel; tier: AutoTier }

/** Whether an upstream may receive a card's text under the person's data-class mode. */
export function upstreamAllowed(upstream: AutoUpstream, cardClass: DataClass, mode: DataClassMode): boolean {
  if (mode === 'off') return true;
  // D3 stays on this computer in Strict and Warn; below that, Strict needs the person's trust ≥ the card's class.
  if (cardClass === 'D3') return upstream.trust === 'D3';
  return mode === 'warn' || classRank(upstream.trust) >= classRank(cardClass);
}

/**
 * Manually tiered models to try, in order: the tier's models (ordered by preference), then stronger tiers, then —
 * only when the person allows it — cheaper ones. Upstreams that are off, cooling down or not trusted with the card's
 * class are left out. (The router itself plans over the whole inventory: see select.ts.)
 */
export function candidates(settings: AutoRoutingSettings, tier: AutoTier, options: { cardClass: DataClass; mode: DataClassMode; coolingDown: (upstreamId: string, modelId: string) => boolean; cheapest?: boolean }): Candidate[] {
  const entries: InventoryEntry[] = [];
  for (const upstream of settings.upstreams) {
    if (!upstream.enabled || !upstreamAllowed(upstream, options.cardClass, options.mode)) continue;
    for (const model of upstream.models) {
      if (!model.tier || options.coolingDown(upstream.id, model.id)) continue;
      entries.push({ key: `${upstream.id}|${model.id}|`, upstream, model: model.id, effort: null, sendEffort: false, tier: model.tier, listed: true, fromList: false, excluded: false,
        priceIn: model.priceIn ?? null, priceOut: model.priceOut ?? null, priceSource: 'person', context: model.context ?? null, output: model.output ?? null, known: false, measuredEfforts: [], scores: {} });
    }
  }
  return manualOrder(entries, tier, { preference: settings.preference, cheaperFallback: settings.cheaperFallback, ...(options.cheapest ? { cheapest: true } : {}) })
    .map(entry => ({ upstream: entry.upstream, model: entry.upstream.models.find(model => model.id === entry.model)!, tier: entry.tier! }));
}

/** The smallest context and output across the allowed models: what the CLI is told it may send and ask for. */
export function limitsOf(settings: AutoRoutingSettings, fallback: { context: number; output: number }): { context: number; output: number } {
  const models = settings.upstreams.filter(upstream => upstream.enabled).flatMap(upstream => upstream.models);
  const contexts = models.map(model => model.context).filter((value): value is number => typeof value === 'number');
  const outputs = models.map(model => model.output).filter((value): value is number => typeof value === 'number');
  return { context: contexts.length ? Math.min(...contexts) : fallback.context, output: outputs.length ? Math.min(...outputs) : fallback.output };
}
