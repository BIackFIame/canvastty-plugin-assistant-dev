import { createHash } from 'node:crypto';

/**
 * Loop signals from what CanvasTTY already tells the plugin: every shell command and file write a local agent makes
 * reaches `canvastty.decide` before it runs, and session events say when a turn ends (idle) and the next starts
 * (working). A loop is suspected when one command runs `threshold` times in one turn with no file edit seen in between.
 *
 * What counts as an edit: a file-writing tool call, and shell commands that write files (`sed -i`, `perl -i`,
 * redirections and heredocs into a file, `tee`, `cp`/`mv`/`rm`/`touch`, `git apply`/`checkout`/…, package installs
 * and formatters that rewrite files). Commands that only wait or look (`sleep`, `watch`, `ls`, `git status`,
 * `gh pr checks`…) are not counted: polling is not a loop. Commands are compared after small normalization (spacing,
 * numbers, a trailing `| tail -50`-style filter), so `npm test | tail -50` and `npm test | tail -80` are the same.
 *
 * Outcomes (did it fail?) are not visible to plugins on this CanvasTTY, and a provider without the decision hook is
 * not seen at all. Advisory only: nothing is stopped or delayed. Only hashes are kept.
 */
export interface LoopSignal { sessionId: string; count: number; toolName: string; what: 'command' | 'action' }

interface SessionLoops { counts: Map<string, number>; alerted: boolean }

const MAX_SESSIONS = 512;
const MAX_FINGERPRINTS = 64;
const MAX_COMMAND = 4_096;

/** Splits a shell line at `&&`, `||`, `;`, `|` and new lines (quotes are not parsed: a rough cut is enough here). */
const segments = (command: string): string[] => command.split(/&&|\|\||[;\n]|\|/u).map(part => part.trim()).filter(Boolean);
/** Pipeline stages that only trim or page the output of the command before them. */
const FILTER = /^(?:head|tail|wc|sort|uniq|less|more|cat|cut|tr|column|nl)(?:\s|$)/u;
/** Commands that wait or look and change nothing; a loop of them is polling. */
const POLLING = /^(?:sleep|watch|ls|ll|pwd|date|ps|jobs|wait|true|clear|echo|printf|whoami|uptime|git\s+(?:status|log|branch|fetch|remote|rev-parse|show)|gh\s+(?:pr\s+(?:checks|view|status|list)|run\s+(?:list|view|watch)|api)|docker\s+(?:ps|logs)|kubectl\s+(?:get|describe|logs)|tail\s+-[fF])(?:\s|$)/u;
/** Shell commands that write files. */
const WRITERS = /^(?:cp|mv|rm|rmdir|mkdir|touch|ln|install|patch|truncate|dd|unzip|tar\s+-?[a-z]*x|chmod|chown|git\s+(?:apply|am|checkout|restore|reset|commit|stash|merge|rebase|cherry-pick|revert|switch|pull|mv|rm|add)|(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|remove|uninstall|ci|update|run\s+(?:format|fmt|fix|lint:fix|build|generate|codegen))|pip3?\s+install|cargo\s+(?:fmt|fix|add)|go\s+(?:fmt|generate|mod\s+tidy)|gofmt\s+-w|black|isort|rustfmt|prettier\s+.*--write|eslint\s+.*--fix|ruff\s+.*(?:--fix|format))(?:\s|$)/u;

const stripEnv = (segment: string): string => segment.replace(/^(?:(?:sudo|env|time|nice(?:\s+-n\s*-?\d+)?|command|npx|bunx|pnpm\s+(?:dlx|exec)|yarn\s+dlx)\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/u, '');

/** Whether a shell command writes a file: an edit, which starts every count of the turn again. */
export function shellWrites(command: string): boolean {
  const text = command.slice(0, MAX_COMMAND);
  if (/\bsed\b[^|;&\n]*\s(?:-[a-zA-Z]*i|--in-place)/u.test(text) || /\bperl\b[^|;&\n]*\s-[a-zA-Z]*i/u.test(text)) return true;
  if (/(?:^|[|;&\n]\s*|\s)tee\b(?:\s+-[a-z]+)*\s+(?!\/dev\/)[^\s|;&]/u.test(text)) return true;
  // A redirection into a file: `> f`, `>> f`, `&> f`, `2> f`, heredocs (`cat <<EOF > f`). Not `2>&1`, not /dev/*.
  for (const match of text.matchAll(/(?:^|[^<>=-])(?:\d|&)?>>?(?!&|>|=)\s*([^\s;&|<>()]+)/gu)) {
    const target = match[1]!.replace(/^["']|["']$/gu, '');
    if (target && !target.startsWith('/dev/')) return true;
  }
  return segments(text).some(segment => WRITERS.test(stripEnv(segment)));
}

/** Whether every step of a command only waits or looks (`sleep 30 && gh pr checks`). */
export function isPolling(command: string): boolean {
  const steps = command.slice(0, MAX_COMMAND).split(/&&|\|\||[;\n]/u).map(part => part.trim()).filter(Boolean);
  if (!steps.length) return false;
  return steps.every(step => {
    const [first, ...filters] = step.split('|').map(part => stripEnv(part.trim()));
    return !!first && POLLING.test(first) && filters.every(part => FILTER.test(part) || /^grep(?:\s|$)/u.test(part));
  });
}

/** The command as compared: spacing, numbers and trailing output filters do not make it a new one. */
export function normalizeCommand(command: string): string {
  const pipeline = command.slice(0, MAX_COMMAND).replace(/\s+/gu, ' ').replace(/\s*\d?>&\d/gu, '').trim().split(/\s*\|\s*/u);
  while (pipeline.length > 1 && FILTER.test(pipeline.at(-1)!)) pipeline.pop();
  return pipeline.join(' | ').replace(/\d+/gu, '0');
}

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
    const command = tool.command !== null && tool.command !== undefined ? String(tool.command) : null;
    if (tool.kind === 'edit' || (command !== null && shellWrites(command))) {
      // A file edit is progress: every streak of this turn starts again.
      if (state) state.counts.clear();
      return null;
    }
    if (command !== null && isPolling(command)) return null;
    const subject = command !== null ? normalizeCommand(command) : (Array.isArray(tool.paths) ? tool.paths : []).join('\n');
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
