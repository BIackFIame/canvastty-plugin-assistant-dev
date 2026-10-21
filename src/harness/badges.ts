/**
 * CanvasTTY gives a plugin one badge per card (`cards.setBadge` replaces the plugin's badge). Several signals can
 * want it (a suspected loop, a flow waiting for the person, a review suggestion, task progress, launch triage, the
 * model Auto (Jev) chose), so the
 * card shows the most important one; when it goes, the next one comes back. Nothing is shown without a signal.
 */
export type BadgeKind = 'loop' | 'flow' | 'review' | 'tasks' | 'triage' | 'model';
export interface Badge { text: string; tone: 'neutral' | 'info' | 'warn' | 'error'; tooltip?: string }

/** `model` (Auto (Jev)'s current model) is the least important: any other signal wins the card's one badge. */
const PRIORITY: Readonly<Record<BadgeKind, number>> = { loop: 0, flow: 1, review: 2, tasks: 3, triage: 4, model: 5 };
const MAX_CARDS = 1_024;

/** A badge, or how to write it: a function is called again when the language changes (`relocalize`). */
export type BadgeSource = Badge | (() => Badge | null) | null;

export class BadgeBoard {
  private readonly cards = new Map<string, Map<BadgeKind, Badge>>();
  private readonly shown = new Map<string, string>();
  /** Badges given as functions, by card and kind, so they can be written again in another language. */
  private readonly renders = new Map<string, Map<BadgeKind, () => Badge | null>>();
  private readonly publish: (sessionId: string, badge: Badge | null) => Promise<void>;

  constructor(publish: (sessionId: string, badge: Badge | null) => Promise<void>) { this.publish = publish; }

  set(sessionId: string, kind: BadgeKind, source: BadgeSource): Promise<void> {
    let badge: Badge | null;
    if (typeof source === 'function') {
      let render = this.renders.get(sessionId);
      if (!render) { render = new Map(); this.renders.set(sessionId, render); while (this.renders.size > MAX_CARDS) this.renders.delete(this.renders.keys().next().value!); }
      render.set(kind, source);
      try { badge = source(); } catch { badge = null; }
    } else {
      badge = source;
      this.renders.get(sessionId)?.delete(kind);
    }
    if (!badge) this.renders.get(sessionId)?.delete(kind);
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
  forget(sessionId: string): void { this.cards.delete(sessionId); this.shown.delete(sessionId); this.renders.delete(sessionId); }

  /** The language changed: every badge given as a function is written again (only changed ones reach CanvasTTY). */
  relocalize(): Promise<void> {
    const work: Promise<void>[] = [];
    for (const [sessionId, render] of [...this.renders]) for (const [kind, source] of [...render]) work.push(this.set(sessionId, kind, source));
    return Promise.all(work).then(() => undefined);
  }

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
