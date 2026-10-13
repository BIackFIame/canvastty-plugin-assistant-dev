import type { ServiceStrings } from './i18n.ts';

/**
 * A small journal per card from what the plugin already sees: session events (start, status changes, exit, parent)
 * and its own decision calls (commands seen, what command review answered, loop alerts). The card action "Report"
 * reads it. Nothing from the screen and no command text is kept. Token use and cost are not exposed to plugins.
 */
export interface Journal {
  id: string; title: string; provider: string; role: string; parentSessionId: string | null;
  startedAt: number | null; status: string; exitCode: number | null;
  turns: number; workingMs: number; workingSince: number | null;
  children: string[];
  commands: number; denied: number; asked: number; loops: number;
}

const MAX_JOURNALS = 512;

export class Journals {
  private readonly journals = new Map<string, Journal>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) { this.now = now; }

  private entry(id: string): Journal {
    let journal = this.journals.get(id);
    if (!journal) {
      journal = { id, title: '', provider: '', role: 'agent', parentSessionId: null, startedAt: null, status: 'unavailable', exitCode: null,
        turns: 0, workingMs: 0, workingSince: null, children: [], commands: 0, denied: 0, asked: 0, loops: 0 };
      this.journals.set(id, journal);
      while (this.journals.size > MAX_JOURNALS) this.journals.delete(this.journals.keys().next().value!);
    }
    return journal;
  }

  /** A session event's summary. Returns true when a new turn started (working after idle or unavailable). */
  observe(summary: { id: string; title?: string; provider?: string; role?: string; parentSessionId?: string; startedAt?: number; status?: string; exitCode?: number | null }): { turnStarted: boolean } {
    const journal = this.entry(summary.id);
    if (typeof summary.title === 'string') journal.title = summary.title.slice(0, 120);
    if (typeof summary.provider === 'string') journal.provider = summary.provider;
    if (typeof summary.role === 'string') journal.role = summary.role;
    if (typeof summary.parentSessionId === 'string' && summary.parentSessionId) {
      journal.parentSessionId = summary.parentSessionId;
      const parent = this.entry(summary.parentSessionId);
      if (!parent.children.includes(summary.id) && parent.children.length < 64) parent.children.push(summary.id);
    }
    if (typeof summary.startedAt === 'number' && journal.startedAt === null) journal.startedAt = summary.startedAt;
    if (summary.exitCode !== undefined) journal.exitCode = summary.exitCode;
    const now = this.now();
    let turnStarted = false;
    if (typeof summary.status === 'string' && summary.status !== journal.status) {
      if (summary.status === 'working') {
        journal.workingSince = now;
        if (journal.status !== 'needs_approval') { journal.turns++; turnStarted = true; }
      } else if (journal.workingSince !== null && summary.status !== 'needs_approval') {
        journal.workingMs += Math.max(0, now - journal.workingSince);
        journal.workingSince = null;
      }
      journal.status = summary.status;
    }
    return { turnStarted };
  }

  command(sessionId: string, verdict: string | null): void {
    const journal = this.entry(sessionId);
    journal.commands++;
    if (verdict === 'deny') journal.denied++;
    if (verdict === 'ask') journal.asked++;
  }

  loop(sessionId: string): void { this.entry(sessionId).loops++; }
  get(sessionId: string): Journal | null { const journal = this.journals.get(sessionId); return journal ? { ...journal, children: [...journal.children] } : null; }
  forget(sessionId: string): void { this.journals.delete(sessionId); }
  titleOf(sessionId: string): string { return this.journals.get(sessionId)?.title || sessionId.slice(0, 8); }
}

/** The report text for a card-action toast (plain text, under 2000 characters). */
export function reportText(journal: Journal, strings: ServiceStrings, extra: { tasks: { done: number; total: number } | null; childTitles: string[]; now: number }): string {
  const r = strings.report;
  const working = journal.workingMs + (journal.workingSince !== null ? Math.max(0, extra.now - journal.workingSince) : 0);
  const time = (at: number): string => new Date(at).toISOString().slice(11, 16) + ' UTC';
  const lines = [
    `${r.title(journal.title || journal.id.slice(0, 8))} (${journal.provider || '?'}, ${r.role[journal.role] ?? journal.role})`,
    journal.startedAt !== null ? `${r.started}: ${time(journal.startedAt)}` : '',
    `${r.ran}: ${r.minutes(working / 60_000)} · ${r.turns}: ${journal.turns}`,
    `${r.status}: ${journal.status}${journal.exitCode !== null ? ` · ${r.exit}: ${journal.exitCode}` : ''}`,
    `${r.commands}: ${journal.commands} (${r.reviewed(journal.denied, journal.asked)})`,
    `${r.loops}: ${journal.loops || r.none}`,
    extra.childTitles.length ? `${r.children}: ${extra.childTitles.slice(0, 12).join(', ')}${extra.childTitles.length > 12 ? '…' : ''}` : '',
    extra.tasks && extra.tasks.total ? `${r.tasks}: ${extra.tasks.done}/${extra.tasks.total}` : '',
    r.cost
  ].filter(Boolean);
  return lines.join('\n').slice(0, 1_900);
}
