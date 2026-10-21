import type { Host } from '../rpc.ts';
import { validBrokerRef } from './settings.ts';

/**
 * Brokered upstreams for Auto (CanvasTTY's `accounts.*`, B6): a model call through an account another plugin keeps
 * (the person's Accounts plan accounts), sent by CanvasTTY itself with that plugin's key. This service never sees
 * the key, the account's address beyond its origin, or any response header but the content type and Retry-After.
 *
 * The router talks to it as to `fetch`: `send` answers a WHATWG Response, so failover, cooldowns, caps and usage work
 * exactly as for a direct upstream. A refusal by CanvasTTY or the owner becomes the status the router already knows
 * (429 for a used-up plan or the local rate limit, 403 for a missing grant, 404 for a model the account does not
 * offer, 503 for an owner that is not running), a lost connection a thrown error.
 *
 * Older cores have no `accounts.*`: the list is then empty and nothing is ever sent (asked again every 30 minutes).
 */

export interface BrokeredAccount {
  /** `<owner plugin id>:<account id>`. */
  ref: string;
  owner: string;
  ownerName: string;
  id: string;
  label: string;
  protocol: 'openai' | 'anthropic';
  origin: string;
  paths: string[];
  models: string[];
  flatRate: boolean;
}

export type BrokerMode = 'unknown' | 'ready' | 'unsupported' | 'failing';

const LIST_FRESH_MS = 15_000;
const UNSUPPORTED_REST_MS = 30 * 60_000;
const FAILING_REST_MS = 60_000;
/** Bodies above this go in parts (`accounts.body`): the request frame stays under CanvasTTY's 1 MB message limit. */
const INLINE_BODY_CHARS = 512 * 1_024;
const PART_CHARS = 512 * 1_024;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** A host error for a method an older CanvasTTY does not have, or a permission this plugin lacks there. */
const unsupportedError = (error: unknown): boolean => (isRecord(error) && (error as { code?: unknown }).code === -32601)
  || /unknown host method|does not have the [a-z:]+ permission/iu.test(error instanceof Error ? error.message : String(error));
/** CanvasTTY's refusal reason (`error.data.reason`), or null. */
const sharedReadReason = (error: unknown): string | null => {
  const data = isRecord(error) ? (error as { data?: unknown }).data : undefined;
  return isRecord(data) && typeof data.reason === 'string' && /^[a-z_]{1,40}$/u.test(data.reason) ? data.reason : null;
};
const clean = (value: unknown, max: number): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, max) : '';


/** One account as `accounts.list` gave it; null when anything is off. */
export function brokeredAccountOf(value: unknown): BrokeredAccount | null {
  if (!isRecord(value) || !validBrokerRef(value.ref)) return null;
  if (value.protocol !== 'openai' && value.protocol !== 'anthropic') return null;
  let origin: string;
  try { origin = new URL(String(value.origin)).origin; } catch { return null; }
  if (origin !== value.origin || !/^https:|^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::\d+)?$/u.test(origin)) return null;
  const strings = (list: unknown, max: number): string[] => Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 200).slice(0, max) : [];
  const models = strings(value.models, 64);
  if (!models.length) return null;
  return {
    ref: value.ref, owner: clean(value.owner, 80), ownerName: clean(value.ownerName, 80) || clean(value.owner, 80), id: clean(value.id, 64),
    label: clean(value.label, 80) || clean(value.id, 64), protocol: value.protocol, origin, paths: strings(value.paths, 8), models, flatRate: value.flatRate === true
  };
}

interface Pending {
  resolve(response: Response): void;
  reject(error: Error): void;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  headed: boolean;
  done: boolean;
}

export class AccountBroker {
  private readonly host: Host;
  private readonly now: () => number;
  private readonly log: (level: 'info' | 'warn', message: string) => void;
  private status: BrokerMode = 'unknown';
  private restUntil = 0;
  private cached: { at: number; accounts: BrokeredAccount[] } | null = null;
  private listing: Promise<BrokeredAccount[]> | null = null;
  private readonly pending = new Map<string, Pending>();
  private next = 1;
  private readonly prefix = `auto-${Math.random().toString(36).slice(2, 10)}`;
  private readonly encoder = new TextEncoder();

  constructor(host: Host, options: { now?: () => number; log?: (level: 'info' | 'warn', message: string) => void } = {}) {
    this.host = host;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((level, message) => host.log(level, message));
  }

  get mode(): BrokerMode { return this.status; }

  /** The granted, offered accounts (cached for 15 s); empty on a core without brokered requests. */
  list(): Promise<BrokeredAccount[]> {
    const now = this.now();
    if (this.cached && now - this.cached.at < LIST_FRESH_MS) return Promise.resolve(this.cached.accounts);
    if (now < this.restUntil) return Promise.resolve(this.cached?.accounts ?? []);
    this.listing ??= this.host.callHost('accounts.list', {}).then(answer => {
      const raw = isRecord(answer) && Array.isArray(answer.accounts) ? answer.accounts : [];
      const accounts = raw.map(brokeredAccountOf).filter((entry): entry is BrokeredAccount => entry !== null);
      this.status = 'ready';
      this.cached = { at: this.now(), accounts };
      return accounts;
    }, (error: unknown) => {
      const reason = sharedReadReason(error);
      // A core without accounts.* (or this plugin without the permission): nothing to broker, asked again later.
      if (!reason && unsupportedError(error)) { this.status = 'unsupported'; this.restUntil = this.now() + UNSUPPORTED_REST_MS; }
      else { this.status = 'failing'; this.restUntil = this.now() + FAILING_REST_MS; }
      this.cached = { at: this.now(), accounts: [] };
      return [];
    }).finally(() => { this.listing = null; });
    return this.listing;
  }

  /** The last list without waiting (for synchronous checks such as which upstreams are usable now). */
  known(ref: string): BrokeredAccount | null {
    return this.cached?.accounts.find(account => account.ref === ref) ?? null;
  }

  /** The list changed (a grant, an owner change): the next call asks again. */
  invalidate(): void { this.cached = null; this.restUntil = 0; }

  /**
   * A fetch-like call through the broker. `path` is the account's path (`/chat/completions`, `/models`); the body is
   * the JSON the router would send. Resolves with the provider's answer as a Response.
   */
  async send(ref: string, path: string, init: { method?: string; body?: Uint8Array | string | null; signal?: AbortSignal | null; headers?: unknown }): Promise<Response> {
    if (this.status === 'unsupported') return this.refusal(503, 'This CanvasTTY cannot send requests through other extensions\' accounts.');
    const requestId = `${this.prefix}-${this.next++}`;
    const text = init.body === undefined || init.body === null ? null : typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString('utf8');
    let body: Record<string, unknown> | undefined;
    if (text !== null && text.length <= INLINE_BODY_CHARS) {
      try { const parsed: unknown = JSON.parse(text); if (isRecord(parsed)) body = parsed; } catch { /* sent as text below */ }
    }
    const stream = body ? body.stream === true : text !== null && /"stream"\s*:\s*true/u.test(text.slice(0, 4_096));
    const signal = init.signal ?? null;
    if (signal?.aborted) throw abortError();
    return new Promise<Response>((resolve, reject) => {
      const entry: Pending = { resolve, reject, controller: null, headed: false, done: false };
      this.pending.set(requestId, entry);
      const onAbort = (): void => {
        if (entry.done) return;
        void this.host.callHost('accounts.cancel', { requestId }).catch(() => undefined);
        this.finish(requestId, abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const start = async (): Promise<void> => {
        if (text !== null && !body) {
          for (let at = 0; at < text.length; at += PART_CHARS) {
            await this.host.callHost('accounts.body', { requestId, data: text.slice(at, at + PART_CHARS) });
          }
        }
        await this.host.callHost('accounts.request', { requestId, ref, path, ...(body ? { body } : {}), stream });
      };
      start().catch((error: unknown) => {
        signal?.removeEventListener('abort', onAbort);
        if (entry.done) return;
        const reason = sharedReadReason(error);
        if (!reason && unsupportedError(error)) { this.status = 'unsupported'; this.restUntil = this.now() + UNSUPPORTED_REST_MS; }
        // Answered with the status the router already maps to its failover and cooldowns.
        this.pending.delete(requestId);
        entry.done = true;
        const message = clean(error instanceof Error ? error.message : String(error), 300);
        resolve(this.refusalFor(reason, message));
      });
    });
  }

  /** `canvastty.accounts.head|chunk|end` from CanvasTTY. */
  notification(kind: 'head' | 'chunk' | 'end', params: Record<string, unknown>): void {
    const requestId = typeof params.requestId === 'string' ? params.requestId : '';
    const entry = this.pending.get(requestId);
    if (!entry || entry.done) return;
    if (kind === 'head') {
      if (entry.headed) return;
      entry.headed = true;
      const headers = new Headers();
      const contentType = clean(params.contentType, 120);
      if (contentType) headers.set('content-type', contentType);
      if (typeof params.retryAfter === 'number') headers.set('retry-after', String(params.retryAfter));
      const status = typeof params.status === 'number' && params.status >= 200 && params.status < 600 ? params.status : 200;
      const body = new ReadableStream<Uint8Array>({ start: controller => { entry.controller = controller; } });
      entry.resolve(new Response(body, { status, headers }));
      return;
    }
    if (kind === 'chunk') {
      if (entry.headed && entry.controller && typeof params.data === 'string') {
        try { entry.controller.enqueue(this.encoder.encode(params.data)); } catch { /* the reader went away */ }
      }
      return;
    }
    const error = isRecord(params.error) ? params.error : null;
    if (!entry.headed) {
      this.pending.delete(requestId);
      entry.done = true;
      if (!error) { entry.resolve(new Response('', { status: typeof params.status === 'number' && params.status >= 200 && params.status < 600 ? params.status : 200 })); return; }
      const reason = typeof error.reason === 'string' ? error.reason : 'network';
      if (reason === 'upstream' && typeof error.status === 'number' && error.status >= 400 && error.status < 600) {
        const headers = new Headers({ 'content-type': 'application/json' });
        if (typeof error.retryAfter === 'number') headers.set('retry-after', String(error.retryAfter));
        entry.resolve(new Response(JSON.stringify({ error: { message: clean(error.message, 300) } }), { status: error.status, headers }));
        return;
      }
      if (reason === 'network' || reason === 'timeout' || reason === 'cancelled') { entry.reject(new Error(`brokered request: ${reason}`)); return; }
      entry.resolve(this.refusalFor(reason, clean(error.message, 300)));
      return;
    }
    if (error) this.finish(requestId, new Error(`brokered request ended: ${clean(error.reason, 40)}`));
    else this.finish(requestId, null);
  }

  /** Every open request ends (the service stops). */
  close(): void {
    for (const requestId of [...this.pending.keys()]) this.finish(requestId, new Error('The service stopped.'));
  }

  private finish(requestId: string, error: Error | null): void {
    const entry = this.pending.get(requestId);
    if (!entry || entry.done) return;
    entry.done = true;
    this.pending.delete(requestId);
    if (!entry.headed) { entry.reject(error ?? new Error('brokered request ended')); return; }
    try {
      if (error) entry.controller?.error(error);
      else entry.controller?.close();
    } catch { /* already closed */ }
  }

  private refusalFor(reason: string | null, message: string): Response {
    switch (reason) {
      // A plan used up (the owner said so) or the local per-account rate: the router's quota cooldown.
      case 'budget_refused': return this.refusal(429, message || 'The account\'s plan is used up.');
      case 'rate_limited': return this.refusal(429, message, 60);
      case 'model_refused': case 'path_refused': return this.refusal(404, message);
      case 'owner_unavailable': return this.refusal(503, message);
      case 'too_large': return this.refusal(413, message);
      case 'not_granted': case 'grant_changed': case 'caller_unavailable': case 'account_unknown':
        this.invalidate();
        return this.refusal(403, message);
      default: return this.refusal(503, message || 'The brokered request failed.');
    }
  }

  private refusal(status: number, message: string, retryAfter?: number): Response {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (retryAfter !== undefined) headers.set('retry-after', String(retryAfter));
    return new Response(JSON.stringify({ error: { message } }), { status, headers });
  }
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}
