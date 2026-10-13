/**
 * CanvasTTY gives a plugin one badge per card (`cards.setBadge` replaces the plugin's badge). Several signals can
 * want it (a suspected loop, a flow waiting for the person, a review suggestion, task progress, launch triage), so the
 * card shows the most important one; when it goes, the next one comes back. Nothing is shown without a signal.
 */
export type BadgeKind = 'loop' | 'flow' | 'review' | 'tasks' | 'triage';
export interface Badge { text: string; tone: 'neutral' | 'info' | 'warn' | 'error'; tooltip?: string }

const PRIORITY: Readonly<Record<BadgeKind, number>> = { loop: 0, flow: 1, review: 2, tasks: 3, triage: 4 };
const MAX_CARDS = 1_024;

export class BadgeBoard {
  private readonly cards = new Map<string, Map<BadgeKind, Badge>>();
  private readonly shown = new Map<string, string>();
  private readonly publish: (sessionId: string, badge: Badge | null) => Promise<void>;

  constructor(publish: (sessionId: string, badge: Badge | null) => Promise<void>) { this.publish = publish; }

  set(sessionId: string, kind: BadgeKind, badge: Badge | null): Promise<void> {
    let entries = this.cards.get(sessionId);
    if (!badge) {
      if (!entries?.delete(kind)) return Promise.resolve();
    } else {
      if (!entries) {
        entries = new Map();
        this.cards.set(sessionId, entries);
        while (this.cards.size > MAX_CARDS) { const oldest = this.cards.keys().next().value!; this.cards.delete(oldest); this.shown.delete(oldest); }
      }
      entries.set(kind, { text: badge.text.slice(0, 24), tone: badge.tone, ...(badge.tooltip ? { tooltip: badge.tooltip.slice(0, 200) } : {}) });
    }
    return this.refresh(sessionId);
  }

  get(sessionId: string, kind: BadgeKind): Badge | null { return this.cards.get(sessionId)?.get(kind) ?? null; }

  /** The card is gone: its badges went with it. */
  forget(sessionId: string): void { this.cards.delete(sessionId); this.shown.delete(sessionId); }

  private refresh(sessionId: string): Promise<void> {
    const entries = this.cards.get(sessionId);
    const top = entries && [...entries.entries()].sort(([a], [b]) => PRIORITY[a] - PRIORITY[b])[0]?.[1] || null;
    if (entries && !entries.size) this.cards.delete(sessionId);
    const key = top ? JSON.stringify(top) : '';
    if ((this.shown.get(sessionId) ?? '') === key) return Promise.resolve();
    if (key) this.shown.set(sessionId, key); else this.shown.delete(sessionId);
    return this.publish(sessionId, top);
  }
}
