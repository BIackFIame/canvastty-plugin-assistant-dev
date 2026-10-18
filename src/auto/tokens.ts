import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DataClass } from '../shared/settings.ts';

/**
 * Per-launch router keys. Each Auto launch gets a fresh random `sk-ctty-…` key that lives only in that card's
 * environment; the router keeps its SHA-256 and what the launch was (card, role, class), in memory and in a 0600
 * file so a restarted service still knows running cards. A card's key dies when the card closes or starts again
 * (prepare mints a new one). The plain key is never stored or logged here.
 */
export interface LaunchGrant {
  sessionId: string;
  provider: string;
  role: string;
  parentSessionId: string | null;
  /** The card's effective data class (a subagent's is at least its parent's). */
  dataClass: DataClass;
  createdAt: number;
}

const PREFIX = 'sk-ctty-';
const SHAPE = /^sk-ctty-[A-Za-z0-9_-]{43}$/u;
const MAX_GRANTS = 1_024;

export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

export class TokenStore {
  private readonly file: string | null;
  private readonly grants = new Map<string, LaunchGrant>();
  private readonly now: () => number;

  constructor(directory: string | null, now: () => number = Date.now) {
    this.now = now;
    this.file = directory ? join(directory, 'tokens.json') : null;
    if (!this.file) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (Array.isArray(saved)) {
        for (const entry of saved.slice(0, MAX_GRANTS)) {
          if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !/^[0-9a-f]{64}$/u.test(entry[0])) continue;
          const grant = entry[1] as LaunchGrant;
          if (grant && typeof grant.sessionId === 'string' && typeof grant.dataClass === 'string') this.grants.set(entry[0], grant);
        }
      }
    } catch { /* nothing saved */ }
  }

  get size(): number { return this.grants.size; }

  /** A new key for this launch; any earlier key of the same card stops working. */
  mint(grant: Omit<LaunchGrant, 'createdAt'>): string {
    this.revoke(grant.sessionId, false);
    const token = `${PREFIX}${randomBytes(32).toString('base64url')}`;
    this.grants.set(hashToken(token), { ...grant, createdAt: this.now() });
    while (this.grants.size > MAX_GRANTS) this.grants.delete(this.grants.keys().next().value!);
    this.save();
    return token;
  }

  /** What a key was minted for, or null. A map lookup by hash: no comparison of secrets. */
  lookup(token: string | null): LaunchGrant | null {
    if (!token || !SHAPE.test(token)) return null;
    return this.grants.get(hashToken(token)) ?? null;
  }

  /** The newest grant of a card (for subagent clamps and the route tool). */
  forSession(sessionId: string): LaunchGrant | null {
    let found: LaunchGrant | null = null;
    for (const grant of this.grants.values()) if (grant.sessionId === sessionId) found = grant;
    return found;
  }

  revoke(sessionId: string, persist = true): boolean {
    let removed = false;
    for (const [hash, grant] of this.grants) if (grant.sessionId === sessionId) { this.grants.delete(hash); removed = true; }
    if (removed && persist) this.save();
    return removed;
  }

  /** Keeps only the cards CanvasTTY still knows (after sessions.subscribe). */
  retain(known: ReadonlySet<string>): void {
    let removed = false;
    for (const [hash, grant] of this.grants) if (!known.has(grant.sessionId)) { this.grants.delete(hash); removed = true; }
    if (removed) this.save();
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(join(this.file, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(`${this.file}.tmp`, JSON.stringify([...this.grants]), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch { /* in memory still works; a restart would lose running cards' keys */ }
  }
}
