import { createHash } from 'node:crypto';

/**
 * Loop signals from what CanvasTTY already tells the plugin: every shell command and file write a local agent makes
 * reaches `canvastty.decide` before it runs, and session events say when a turn ends (idle) and the next starts
 * (working). A loop is suspected when one command runs `threshold` times in one turn with no file write in between
 * (a write is progress and starts the count again). Outcomes (did it fail?) are not visible to plugins on this
 * CanvasTTY, so "the same failing command" cannot be told from "the same passing command"; repeating either without
 * changing anything is still worth a look. Advisory only: nothing is stopped or delayed. Only hashes are kept.
 */
export interface LoopSignal { sessionId: string; count: number; toolName: string; what: 'command' | 'action' }

interface SessionLoops { counts: Map<string, number>; alerted: boolean }

const MAX_SESSIONS = 512;
const MAX_FINGERPRINTS = 64;

const normalize = (text: string): string => text.replace(/\s+/gu, ' ').trim().slice(0, 4_096);

export class LoopWatch {
  private readonly sessions = new Map<string, SessionLoops>();
  readonly threshold: number;

  constructor(options: { threshold?: number } = {}) {
    this.threshold = Number.isInteger(options.threshold) ? Math.max(2, Math.min(20, options.threshold!)) : 5;
  }

  /** One tool call seen before it ran. Returns a signal once per streak, when it reaches the threshold. */
  action(sessionId: string, tool: { name: string; kind: string; command: string | null; paths: string[] }): LoopSignal | null {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    let state = this.sessions.get(sessionId);
    if (tool.kind === 'edit') {
      // A file write is progress: every streak of this turn starts again.
      if (state) state.counts.clear();
      return null;
    }
    const subject = tool.command !== null && tool.command !== undefined ? normalize(String(tool.command)) : (tool.paths ?? []).join('\n');
    if (!subject) return null;
    const fingerprint = createHash('sha256').update(`${String(tool.name).slice(0, 80)}\u0000${subject}`).digest('hex');
    if (!state) {
      state = { counts: new Map(), alerted: false };
      this.sessions.set(sessionId, state);
      while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
    }
    const count = (state.counts.get(fingerprint) ?? 0) + 1;
    state.counts.delete(fingerprint);
    state.counts.set(fingerprint, count);
    while (state.counts.size > MAX_FINGERPRINTS) state.counts.delete(state.counts.keys().next().value!);
    if (count < this.threshold || state.alerted) return null;
    state.alerted = true;
    return { sessionId, count, toolName: String(tool.name).slice(0, 40), what: tool.kind === 'shell' ? 'command' : 'action' };
  }

  /** Whether a loop is flagged on this card in its current turn. */
  flagged(sessionId: string): boolean { return this.sessions.get(sessionId)?.alerted === true; }

  /** A new turn started (the person or the orchestrator gave new input): the evidence of the last one is dropped. */
  turnStarted(sessionId: string): boolean {
    const had = this.flagged(sessionId);
    this.sessions.delete(sessionId);
    return had;
  }

  forget(sessionId: string): void { this.sessions.delete(sessionId); }
}
