import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { REVIEW_LIMITS, type AcpPermissionDetail, type AcpToolKind, type ReviewReason } from '../shared/commandReview.ts';
import type { AssistantSettings, DataClass } from '../shared/settings.ts';
import { ReviewCircuit } from '../engine/bands.ts';
import type { ShadowLabel } from '../engine/ShadowRecorder.ts';
import { askCommandReview, reviewSummary, type CommandReviewEngine, type CommandReviewVerdict } from './commandReview.ts';
import { sha256, verifyTestRun } from './testChain.ts';
import { plainInspection } from './inspection.ts';
import { computeCommandFacts, defaultGit, factPhrases, isCredentialPath, isProtectedRel, pathContext, realish, SessionWriteTracker, commandFromArgv, type CommandFacts, type GitRunner, type ReviewAction } from './commandFacts.ts';
import { tier1, type TIER1_DENY_RULES } from './commandRules.ts';
import { collectReferencedFiles } from './referencedFiles.ts';

/**
 * Command review as a CanvasTTY decision service (EP-5 `canvastty.decide`, event `pre-tool`), ported from the chain's
 * CommandReviewService and HookReview. CanvasTTY's base protection runs first and its deny is final; this service
 * then answers deny, ask, allow or nothing:
 *
 * - Off (the assistant or `command.review`): nothing, no work at all (R8).
 * - A tier-1 hard deny (elevation, pipe-to-shell, writes outside…): deny, in every mode while review is on (R1).
 * - Learning: nothing; the review runs on its own afterwards, for the log.
 * - Suggest: nothing is enforced (R10); the review runs afterwards and its suggestion shows as a card badge.
 * - Auto: the ladder runs inside the hook's budget — tier 1, the light model, and on VERIFY the smart model, which
 *   reads the scripts or diff the command runs. An enforced allow answers `allow` (CanvasTTY applies it only when
 *   the person let this plugin allow, and only for the calls it saw whole); an enforced deny answers `deny`; everything
 *   else, failures included, answers `ask`: the person decides. Nothing ever falls through to allow (R4).
 * - An agent that cannot put an ask in front of the person (`canAsk: false`: every CLI but Claude Code) gets a deny with
 *   the same reason and what to do instead. Only a review that could not finish in a card whose own profile still asks
 *   the person (normal, plan) answers nothing there, so the CLI's own prompt decides instead of blocking all work.
 *
 * A script the agent wrote in this session (or one not committed) is never allowed by the small model alone: only
 * when the larger second reviewer, which reads its text, agrees (R3-V), or by the person.
 */

/** What CanvasTTY sends (`canvastty.decide`). */
export interface DecideRequest {
  event: 'pre-tool';
  sessionId: string;
  provider: string;
  role: 'agent' | 'orchestrator' | 'subagent';
  cwd: string;
  agentCwd: string | null;
  tool: { name: string; kind: 'shell' | 'edit' | 'other'; command: string | null; paths: string[] };
  input: unknown;
  truncated: boolean;
  /** The card's launch profile (auto, normal, acceptEdits, plan, yolo); null or absent from an older CanvasTTY. */
  profile?: string | null;
  /** The agent can put an "ask" in front of the person (only Claude Code); absent from an older CanvasTTY: it can. */
  canAsk?: boolean;
}

/** Profiles whose CLI still asks the person before it runs a command on its own. */
const ASKING_PROFILES: ReadonlySet<string> = new Set(['normal', 'plan']);

export type DecideAnswer = { verdict: 'deny' | 'ask' | 'allow'; reason: string } | null;

/** One line of the settings page's «Последние проверки»: code-authored, no command text, no path. */
export interface RecentReview {
  at: number; session: string; summary: string; mode: string;
  outcome: CommandReviewVerdict['outcome']; act: 'allow' | 'deny' | 'ask' | null; tier: 'rule' | 'light' | 'smart' | null;
  reason: ReviewReason; model: string | null; auditId: string | null; label: 'right' | 'wrong' | null;
}

export interface ReviewServiceOptions {
  engine: CommandReviewEngine & { label?(auditId: string, label: ShadowLabel): boolean };
  settings(): AssistantSettings;
  /** null: no git at all (tests); default: read-only git with hooks and helpers off. */
  git?: GitRunner | null;
  home?: string;
  /** Suggest mode: shows the suggestion on the card (a badge); never enforced. */
  suggest?(sessionId: string, verdict: CommandReviewVerdict, summary: string): void;
  now?: () => number;
  /** The person's language, for reasons written for them (the others are for the agent, in English). */
  locale?: 'en' | 'ru';
  /** "Trust the orchestrator's task for its subagents' new files" (the person's switch; off unless they turn it on). */
  trustChain?: () => boolean;
}

/** The trust chain allows a subagent's new file only when the light review is at least this sure it serves the task. */
export const TRUST_CHAIN_MIN_SERVES = 0.95;
/**
 * …or this sure when the file's name stands literally in the trusted task (the person's request above, or the task
 * this card was given) and the file lands in this card's folder or a folder that task names, with every other risk
 * answer low. Live run 10: Jev put the module the task named at 0.83, its test file at 0.95.
 */
export const TRUST_CHAIN_NAMED_MIN_SERVES = 0.75;
export const TRUST_CHAIN_LOW_RISK = 0.1;

/** The file's name stands in the text as a word of its own (not inside a longer name). */
export function namesFile(text: string, path: string): boolean {
  const name = path.split(/[\\/]/u).at(-1) ?? '';
  if (name.length < 3) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[^\\w.-])${escaped}(?=$|[^\\w.-]|\\.(?:$|[^\\w-]))`, 'u').test(text);
}

/** Folders a task names (`code/`, `src/lib`), relative to the project. */
function namedFolders(text: string): string[] {
  return [...text.matchAll(/(?:^|[\s(`'"])((?:\.?[\w-]+\/)+)(?=[\s)`'",.;:]|$|[\w.-])/gu)].map(match => match[1]!.replace(/\/+$/u, '')).filter(Boolean).slice(0, 16);
}

/**
 * The absolute paths a call creates, when it only creates files whose whole content is in its input (a whole-file
 * write, the OpenCode bridge's edit shape, or a patch that only adds files) and none of them exists yet (lstat:
 * not even a dangling link). Null for anything else: an overwrite, a partial edit, cut input.
 */
export function newFileTargets(toolName: string, toolInput: unknown, truncated: boolean, cwd: string): string[] | null {
  const raw = record(toolInput);
  if (truncated || !raw || !wholeContentWrite(toolName, toolInput, truncated, cwd)) return null;
  const abs = (path: string): string => isAbsolute(path) ? path : join(cwd, path);
  let paths: string[];
  if (toolName === 'apply_patch' || toolName === 'patch') {
    const patch = [raw.command, raw.patch, raw.patchText, raw.input].find((value): value is string => typeof value === 'string') ?? '';
    paths = patchPaths(patch);
  } else {
    const path = [raw.file_path, raw.filePath, raw.path].find((value): value is string => typeof value === 'string' && value.length > 0);
    paths = path ? [path] : [];
  }
  if (!paths.length) return null;
  const targets = paths.map(abs);
  return targets.every(nothingAt) ? targets : null;
}

interface SessionState {
  suspect: boolean;
  /** The card's task from the launcher's Assistant field (typed by the person, or chosen by an orchestrator). */
  launchTask: string | null;
  /** The card's user turns as the Auto router saw them: the first one, then the latest few (oldest first). */
  turns: string[];
  /** A subagent's own texts are its orchestrator's, not the person's. */
  subagent: boolean;
  parent: string | null;
  dataClass: DataClass | null;
  /** From the launch triage (§3.1a step 7); `pending` while it runs, which counts as strict. */
  strict: boolean | 'pending';
  /** Whole contents this card's review allowed (real path → sha256), for the trust chain's test commands. */
  reviewed: Map<string, string>;
}

const MAX_SESSIONS = 512;

/**
 * `a ; b && c` → its plain commands, or null when there is anything but `;` and `&&` between them: a pipe, a
 * redirect, a single `&`, a subshell or grouping, expansion, a backslash, a newline, or quoting that expands. At most
 * 8 parts, none empty.
 */
export function splitCompound(command: string): string[] | null {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && /[$`\\!]/u.test(c)) return null;
      current += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; current += c; continue; }
    if (c === ';') { parts.push(current); current = ''; continue; }
    if (c === '&') { if (command[i + 1] !== '&') return null; i++; parts.push(current); current = ''; continue; }
    if (/[|<>`$()\\\n\r{}]/u.test(c)) return null;
    current += c;
  }
  if (quote) return null;
  parts.push(current);
  const trimmed = parts.map(part => part.trim());
  return trimmed.length <= 8 && trimmed.every(Boolean) ? trimmed : null;
}

/** The real absolute path a single-file write or edit names. */
function targetOf(request: DecideRequest, action: ReviewAction): string | null {
  const raw = record(request.input);
  const path = raw ? [raw.file_path, raw.filePath, raw.path].find((value): value is string => typeof value === 'string' && value.length > 0) : undefined;
  return path ? realish(resolve(isAbsolute(path) ? path : join(action.commandCwd ?? request.agentCwd ?? request.cwd, path))) : null;
}

interface OwnFile { abs: string; content: string }

/**
 * A write or edit of a file this card wrote whole earlier (its last reviewed content hash) whose current content is
 * still exactly that (nobody changed it since): the file's whole resulting content. Whole-file writes (Write, write,
 * write_file, create_file) give it directly; Claude's Edit (old_string/new_string, replace_all) and MultiEdit are
 * applied to the current content (each old string must occur exactly once unless replace_all). OpenCode's bridge
 * shape (`edit` with only file_path and content) on an existing file may be a partial edit whose old text is gone:
 * never. Null otherwise.
 */
function ownFileResult(request: DecideRequest, state: SessionState, action: ReviewAction): OwnFile | null {
  if (request.truncated || action.inputTruncated) return null;
  const raw = record(request.input);
  const abs = raw ? targetOf(request, action) : null;
  if (!raw || !abs) return null;
  const last = state.reviewed.get(abs);
  if (!last) return null;
  let current: string;
  try { current = readFileSync(abs, 'utf8'); } catch { return null; }
  if (sha256(current) !== last) return null;
  const name = request.tool.name;
  if (WHOLE_FILE_WRITES.has(name)) return typeof raw.content === 'string' ? { abs, content: raw.content } : null;
  const apply = (text: string, edit: Record<string, unknown>): string | null => {
    const from = edit.old_string ?? edit.oldString, to = edit.new_string ?? edit.newString;
    if (typeof from !== 'string' || typeof to !== 'string' || !from.length) return null;
    const parts = text.split(from);
    if (parts.length < 2) return null;
    if (edit.replace_all === true || edit.replaceAll === true) return parts.join(to);
    if (edit.replace_all !== undefined && typeof edit.replace_all !== 'boolean' || edit.replaceAll !== undefined && typeof edit.replaceAll !== 'boolean') return null;
    return parts.length === 2 ? parts.join(to) : null;
  };
  // Claude's Edit, and OpenCode's edit with its own field names (run 15: {filePath, oldString, newString, replaceAll})
  // when the host passes them on; the bridge shape with only `content` has no old text and never gets here.
  const hasOld = typeof (raw.old_string ?? raw.oldString) === 'string' && typeof (raw.new_string ?? raw.newString) === 'string';
  if (name === 'Edit' || name === 'edit' && hasOld) return ((): OwnFile | null => { const result = apply(current, raw); return result === null ? null : { abs, content: result }; })();
  if (name === 'MultiEdit' && Array.isArray(raw.edits) && raw.edits.length && raw.edits.length <= 32) {
    let text: string | null = current;
    for (const edit of raw.edits) { text = text === null ? null : apply(text, record(edit) ?? {}); }
    return text === null ? null : { abs, content: text };
  }
  return null;
}
/** Whole contents remembered per card for test commands. */
const MAX_REVIEWED = 256;
/** Per card: the first user turn and the latest few; each text at most this long (the engine bounds it again). */
const MAX_TURNS = 5;
const MAX_REQUEST_CHARS = 16_384;
/** A subagent's task counts as the person's only when the person typed it word for word (at least this long). */
const MIN_QUOTED_CHARS = 24;
const MAX_ANCESTORS = 4;

const squash = (value: string): string => value.replace(/\s+/gu, ' ').trim().toLowerCase();
/** Distinct texts, in order. */
const distinct = (texts: Array<string | null>): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) { if (!text) continue; const key = squash(text); if (key && !seen.has(key)) { seen.add(key); out.push(text); } }
  return out;
};
const MAX_RECENT = 40;
/** Room kept for the hook's own round trip: the answer must reach CanvasTTY before its deadline. */
const MARGIN_MS = 1_500;

/** Tier-1 hard denies, told to the model as what to do instead (the reason reaches the model). */
const DENY_MESSAGES: Readonly<Record<typeof TIER1_DENY_RULES[number], string>> = {
  elevation: 'it asks for administrator rights (sudo, doas, runas). Do the work without elevation; if the task truly needs it, stop and ask the person to run that step',
  'pipe-to-shell': 'it pipes downloaded or generated text straight into a shell or interpreter. Download the file first, show what it contains, and ask the person before running it',
  'download-exec': 'it downloads code and runs it in one step. Download the file first, show what it contains, and ask the person before running it',
  'delete-outside': 'it deletes files outside the project folder (or the folder itself). Delete only inside the project; if something elsewhere must go, ask the person',
  'write-outside': 'it writes outside the project folder. Keep changes inside the project; if a file elsewhere must change, ask the person',
  disk: 'it erases, formats or writes a disk directly. Do not do this; ask the person if disk changes are really needed',
  'fork-bomb': 'it would exhaust the computer\'s processes. Do not run it'
};
const TEMP_WRITE_MESSAGE = 'it writes to the temporary folder (/tmp or $TMPDIR), which is outside the project folder. Make a scratch folder inside the project instead (for example ./tmp, added to .gitignore if needed); if a file elsewhere must change, ask the person';
const MODEL_DENY_MESSAGE = 'command review declined it: it looks like a risky action the task did not ask for. If it is needed, stop and ask the person';

/** Why the person is asked, in the words the CLI shows next to its prompt. */
const ASK_MESSAGES: Readonly<Partial<Record<ReviewReason, string>>> = {
  'rule-ask': 'a force push, history rewrite, unresolved recursive delete, power or kill-all command needs the person',
  'person-only': 'this kind of action (publishing, pushing, deleting, system or credential changes) is the person\'s to allow',
  unseeable: 'what it runs cannot be seen in the command itself',
  risk: 'the review found a risk signal',
  'not-requested': 'the task given to this card does not ask for it',
  external: 'it has an effect on another computer or is hard to read',
  suspect: 'the command talks to the reviewer; nothing is allowed without the person for the rest of this card',
  circuit: 'several commands of this card were declined; the person decides from now on',
  disagree: 'the two reviews do not agree',
  'needs-second': 'a second review is needed',
  'no-verifier': 'it needs a second review, and no second reviewer is set up (Assistant → Decision models)',
  unavailable: 'the Assistant could not review it in time',
  'no-kind': 'this tool cannot be reviewed',
  'model-deny': 'the review recommends not running it',
  'smart-deny': 'the second review recommends not running it',
  'auto-band': 'the review would allow it, but that outcome has not qualified yet',
  'both-agree': 'both reviews would allow it, but that outcome has not qualified yet',
  'rule-allow': 'a read-only command'
};

/** The no-second-reviewer reason, which the person acts on (set one up, or allow it), in their language. */
const NO_VERIFIER: Readonly<Record<'en' | 'ru', { ask: string; deny: string }>> = {
  en: {
    ask: 'CanvasTTY Assistant: it needs a second review, and no second reviewer is set up (Assistant → Decision models)',
    deny: 'CanvasTTY Assistant: it needs a second review, and no second reviewer is set up (Assistant → Decision models). This agent cannot ask the person from here, so it was not run: tell the person what you want to run and why, and let them decide'
  },
  ru: {
    ask: 'Ассистент CanvasTTY: нужна вторая проверка, а второй проверяющий не настроен (Ассистент → Модели решений)',
    deny: 'Ассистент CanvasTTY: нужна вторая проверка, а второй проверяющий не настроен (Ассистент → Модели решений). Этот агент не может спросить человека отсюда, поэтому действие не выполнено: скажите человеку, что и зачем вы хотите выполнить, и пусть он решит'
  }
};

/** Write tools whose input is the file's whole new content. */
const WHOLE_FILE_WRITES: ReadonlySet<string> = new Set(['Write', 'write', 'write_file', 'create_file']);

/** Nothing at all is at this path yet (not even a dangling link); any other answer is "something may be there". */
function nothingAt(path: string): boolean {
  try { lstatSync(path); return false; } catch (error) { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
}

/**
 * The call writes files whose whole new content is in its input: a whole-file Write, a patch that only adds files,
 * or — the shape CanvasTTY's OpenCode bridge sends for write, edit and multiedit alike (`edit` with only `file_path`
 * and `content`) — a call whose target does not exist yet, so `content` is all the new file holds. Then the review sees
 * exactly what it does (ReviewFacts.contentVisible). Cut input never counts; an existing target under the bridge
 * shape is a partial edit as far as anyone can tell, and is not exempt.
 */
export function wholeContentWrite(toolName: string, toolInput: unknown, truncated: boolean, cwd: string | null = null): boolean {
  const raw = record(toolInput);
  if (truncated || !raw) return false;
  if (WHOLE_FILE_WRITES.has(toolName)) return typeof raw.content === 'string' && [raw.file_path, raw.filePath, raw.path].some(value => typeof value === 'string' && value.length > 0);
  if (toolName === 'edit' && Object.keys(raw).every(key => key === 'file_path' || key === 'content') && typeof raw.content === 'string' && typeof raw.file_path === 'string' && raw.file_path.length > 0) {
    const path = isAbsolute(raw.file_path) ? raw.file_path : cwd ? join(cwd, raw.file_path) : null;
    return path !== null && nothingAt(path);
  }
  if (toolName === 'apply_patch' || toolName === 'patch') {
    const patch = typeof raw.command === 'string' ? raw.command : typeof raw.patch === 'string' ? raw.patch : typeof raw.patchText === 'string' ? raw.patchText : typeof raw.input === 'string' ? raw.input : '';
    const operations = [...patch.matchAll(/^\*\*\* (Add|Update|Delete) File: |^\*\*\* Move to: /gmu)].map(match => match[1] ?? 'Move');
    return operations.length > 0 && operations.every(operation => operation === 'Add');
  }
  return false;
}

/** Tool names of the CLIs' hooks, as the tool kinds the rules know. Anything else goes to the person. */
const HOOK_TOOL_KINDS: Readonly<Record<string, AcpToolKind>> = {
  Bash: 'execute', bash: 'execute', run_shell_command: 'execute', shell: 'execute', local_shell: 'execute', exec_command: 'execute',
  Write: 'edit', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', write_file: 'edit', edit: 'edit', write: 'edit', replace: 'edit', apply_patch: 'edit', patch: 'edit',
  Read: 'read', read_file: 'read', read_many_files: 'read', NotebookRead: 'read', LS: 'read', list_directory: 'read', read: 'read', list: 'read',
  Glob: 'search', Grep: 'search', glob: 'search', grep: 'search', search_file_content: 'search',
  WebFetch: 'fetch', web_fetch: 'fetch', webfetch: 'fetch'
};

function record(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
const text = (value: unknown, max = 65_536): string | null => typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;

/** The files an `apply_patch` envelope touches. */
export function patchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gmu)) {
    const path = (match[1] ?? match[2] ?? '').trim();
    if (path && path.length <= REVIEW_LIMITS.pathChars) paths.push(path);
    if (paths.length >= REVIEW_LIMITS.locations) break;
  }
  return paths;
}

/**
 * A CLI hook's tool call as the private detail the review reads. The input is normalized per tool so that only a
 * shell tool can ever carry a command: an unknown or MCP tool has no kind and no input, and goes to the person.
 * Cut input keeps no parsed value (never allowed, R3).
 */
export function detailFromHook(toolName: string, toolInput: unknown, truncated: boolean): AcpPermissionDetail {
  const kind = Object.hasOwn(HOOK_TOOL_KINDS, toolName) ? HOOK_TOOL_KINDS[toolName]! : null;
  const raw = record(toolInput);
  let rawInput: unknown = null;
  let locations: string[] = [];
  if (!truncated && raw && kind) {
    const pathOf = (): string | null => text(raw.file_path, REVIEW_LIMITS.pathChars) ?? text(raw.filePath, REVIEW_LIMITS.pathChars) ?? text(raw.path, REVIEW_LIMITS.pathChars) ?? text(raw.notebook_path, REVIEW_LIMITS.pathChars) ?? text(raw.absolute_path, REVIEW_LIMITS.pathChars);
    if (kind === 'execute') {
      rawInput = { command: raw.command, ...(raw.cwd !== undefined ? { cwd: raw.cwd } : raw.workdir !== undefined ? { workdir: raw.workdir } : raw.directory !== undefined ? { cwd: raw.directory } : {}) };
    } else if (toolName === 'apply_patch' || toolName === 'patch') {
      const patch = typeof raw.command === 'string' ? raw.command : typeof raw.patch === 'string' ? raw.patch : typeof raw.patchText === 'string' ? raw.patchText : typeof raw.input === 'string' ? raw.input : '';
      locations = patchPaths(patch);
      rawInput = { patch };
    } else if (kind === 'edit') {
      const pieces: string[] = [];
      for (const key of ['content', 'new_string', 'newString', 'new_source', 'newText']) if (typeof raw[key] === 'string') pieces.push(raw[key] as string);
      if (Array.isArray(raw.edits)) for (const edit of raw.edits.slice(0, 64)) { const value = record(edit)?.new_string; if (typeof value === 'string') pieces.push(value); }
      const path = pathOf();
      rawInput = { ...(path ? { file_path: path } : {}), ...(pieces.length ? { content: pieces.join('\n') } : {}) };
    } else if (kind === 'fetch') {
      rawInput = { url: raw.url };
    } else {
      const path = pathOf();
      rawInput = path ? { path } : {};
    }
  }
  return { toolCallId: null, kind, title: null, rawInput, rawInputText: null, rawInputTruncated: truncated, locations, diffs: [], contentTruncated: false };
}

/** What a tool call asks for, read from the private detail. */
export function actionFromDetail(detail: AcpPermissionDetail): ReviewAction {
  const raw = record(detail.rawInput);
  let command: string | null = null;
  let truncated = detail.rawInputTruncated || detail.contentTruncated;
  const candidate = raw ? raw.command ?? raw.cmd ?? raw.commandLine ?? raw.command_line ?? raw.script : typeof detail.rawInput === 'string' ? detail.rawInput : undefined;
  if (typeof candidate === 'string') command = candidate;
  else if (Array.isArray(candidate) && candidate.length && candidate.every(item => typeof item === 'string')) command = commandFromArgv(candidate as string[]);
  const execute = detail.kind === 'execute' || detail.kind === null && command !== null;
  if (execute && detail.rawInputTruncated) { command = null; truncated = true; }
  const paths = new Set<string>(detail.locations);
  for (const key of ['file_path', 'filePath', 'path', 'abs_path', 'absolute_path', 'target_file', 'notebook_path', 'source', 'destination', 'old_path', 'new_path', 'from', 'to']) {
    const value = text(raw?.[key], REVIEW_LIMITS.pathChars);
    if (value) paths.add(value);
  }
  const contents = detail.diffs.map(diff => diff.newText);
  for (const key of ['content', 'new_string', 'newText', 'new_str', 'contents', 'text', 'patch', 'diff']) {
    const value = raw?.[key];
    if (typeof value === 'string') contents.push(value);
  }
  const content = contents.length ? contents.join('\n').slice(0, REVIEW_LIMITS.contentChars) : null;
  if (contents.join('\n').length > REVIEW_LIMITS.contentChars) truncated = true;
  const cwdValue = text(raw?.cwd, REVIEW_LIMITS.pathChars) ?? text(raw?.workdir, REVIEW_LIMITS.pathChars) ?? text(raw?.working_directory, REVIEW_LIMITS.pathChars);
  return {
    kind: detail.kind, command: execute ? command : null, commandCwd: cwdValue, paths: [...paths].slice(0, REVIEW_LIMITS.locations),
    content: execute ? null : content, inputTruncated: truncated, url: text(raw?.url, 4_096)
  };
}

/** The temporary folders of this computer, resolved (macOS: /tmp is /private/tmp; $TMPDIR is under /var/folders). */
function temporaryRoots(): string[] {
  const roots = new Set<string>();
  for (const path of ['/tmp', '/var/tmp', tmpdir(), process.env.TEMP ?? '', process.env.TMP ?? '']) {
    if (!path) continue;
    roots.add(path);
    try { roots.add(realish(path)); } catch { /* keep the plain path */ }
  }
  return [...roots];
}

const within = (path: string, root: string): boolean => { const rel = relative(root, path); return rel === '' || !rel.startsWith('..') && !isAbsolute(rel); };

/** Every target the command writes outside the project is inside a temporary folder. */
function writesOnlyToTemp(facts: CommandFacts, cwd: string): boolean {
  if (facts.deletesOutside) return false;
  let rootReal: string;
  try { rootReal = pathContext(cwd).rootReal; } catch { return false; }
  const outside = facts.writeTargets.filter(path => !within(path, rootReal));
  if (!outside.length) return false;
  const roots = temporaryRoots();
  return outside.every(path => roots.some(root => within(path, root)));
}

function tierOf(verdict: CommandReviewVerdict): RecentReview['tier'] {
  if (verdict.by === 'rule' || verdict.path === 'tier1') return 'rule';
  if (verdict.smart.asked) return 'smart';
  return verdict.model ? 'light' : null;
}

export class ReviewService {
  readonly tracker = new SessionWriteTracker(MAX_SESSIONS);
  private readonly options: ReviewServiceOptions;
  private readonly circuit = new ReviewCircuit(MAX_SESSIONS);
  private readonly sessions = new Map<string, SessionState>();
  private readonly recentReviews: RecentReview[] = [];
  private readonly now: () => number;

  constructor(options: ReviewServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  private state(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { suspect: false, launchTask: null, turns: [], subagent: false, parent: null, dataClass: null, strict: false, reviewed: new Map() };
      this.sessions.set(sessionId, state);
      // The oldest session goes from every per-session map, not only this one.
      while (this.sessions.size > MAX_SESSIONS) this.forget(this.sessions.keys().next().value!);
    }
    return state;
  }

  /**
   * What the launcher set for this card: its task and data class, and whether it is a subagent (whose task its
   * orchestrator wrote) of which card.
   */
  noteLaunch(sessionId: string, launch: { task: string | null; dataClass: DataClass | null; triage: boolean; role?: string; parentSessionId?: string | null }): void {
    const state = this.state(sessionId);
    state.launchTask = launch.task ? launch.task.slice(0, MAX_REQUEST_CHARS) : null;
    state.dataClass = launch.dataClass;
    state.strict = launch.triage ? 'pending' : false;
    if (launch.role !== undefined) { state.subagent = launch.role === 'subagent'; state.parent = state.subagent ? launch.parentSessionId ?? null : null; }
  }

  /**
   * A new user turn of a card on Auto (Jev), as its router read it (the latest user text, envelopes stripped). Kept
   * in memory only, for this card's reviews, until the card closes: it is the task the card works on, so the
   * review can tell the writes it asks for from the ones it does not. It goes out only inside `person_request`,
   * under the card's data class, like the launcher's task.
   */
  noteTurn(sessionId: string, text: string, card: { role: string; parentSessionId: string | null }): void {
    const value = text.trim().slice(0, MAX_REQUEST_CHARS);
    if (!value) return;
    const state = this.state(sessionId);
    state.subagent = card.role === 'subagent';
    state.parent = state.subagent ? card.parentSessionId : null;
    if (state.turns.length && squash(state.turns.at(-1)!) === squash(value)) return;
    state.turns.push(value);
    if (state.turns.length > MAX_TURNS) state.turns.splice(1, 1);
  }

  /** A card's own texts, most recent first: its latest turn, its earlier turns, then the launcher's task. */
  private ownTexts(state: SessionState): string[] { return distinct([...[...state.turns].reverse(), state.launchTask]); }

  /** The texts the person typed for this card or, for a subagent, for the nearest card above it that is not one. */
  private personTexts(state: SessionState): string[] {
    let current: SessionState | undefined = state;
    for (let depth = 0; current && depth <= MAX_ANCESTORS; depth++) {
      if (!current.subagent) return this.ownTexts(current);
      current = current.parent ? this.sessions.get(current.parent) : undefined;
    }
    return [];
  }

  /**
   * The request this card's actions are reviewed against (`person_request`), and whether the person typed it.
   *
   * - A card started by the person: its own task and turns, typed by the person.
   * - A subagent: its own task when the person typed it word for word (an orchestrator passing on the person's
   *   prompt); else the person's request to the card above it, which an orchestrator cannot change. Only when no
   *   text of the person's is known: its own task, as the orchestrator's (never "typed by the person").
   */
  requestFor(sessionId: string): { text: string; byPerson: boolean } | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    const own = this.ownTexts(state);
    if (!state.subagent) return own.length ? { text: own.join('\n\n'), byPerson: true } : null;
    const above = state.parent ? this.sessions.get(state.parent) : undefined;
    const person = above ? this.personTexts(above) : [];
    const said = person.map(squash);
    if (own.length && person.length && own.every(text => { const quoted = squash(text); return quoted.length >= MIN_QUOTED_CHARS && said.some(typed => typed.includes(quoted)); })) {
      return { text: own.join('\n\n'), byPerson: true };
    }
    if (person.length) return { text: person.join('\n\n'), byPerson: true };
    return own.length ? { text: own.join('\n\n'), byPerson: false } : null;
  }

  /** The launch triage finished: its strictness (a failed triage is not strict; the global setting still applies). */
  noteTriage(sessionId: string, strict: boolean): void { this.state(sessionId).strict = strict; }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.tracker.forget(sessionId);
    this.circuit.forget(sessionId);
  }

  recent(): RecentReview[] { return structuredClone(this.recentReviews); }
  setLocale(locale: 'en' | 'ru'): void { this.options.locale = locale; }

  /** «верно / неверно» on the settings page: the person's own label (R11), once per review. */
  feedback(auditId: string, verdict: 'right' | 'wrong'): boolean {
    const entry = this.recentReviews.find(item => item.auditId === auditId);
    if (!entry || entry.label || entry.tier === 'rule' || (verdict !== 'right' && verdict !== 'wrong')) return false;
    const label = verdict === 'right' ? entry.outcome : entry.outcome === 'allow' ? 'deny' : 'allow';
    let stored = false;
    try { stored = this.options.engine.label?.(auditId, { label, source: 'person', agrees: verdict === 'right' }) === true; } catch { stored = false; }
    if (stored) entry.label = verdict;
    return stored;
  }

  private strict(state: SessionState): boolean {
    try { if (this.options.settings().reviewStrictness === 'strict') return true; } catch { return true; }
    return state.strict !== false;
  }

  /** Never rejects. `budgetMs` is what CanvasTTY waits for this answer. */
  async decide(request: DecideRequest, budgetMs: number): Promise<DecideAnswer> {
    let mode: string;
    try {
      if (!this.options.settings().enabled) return null;
      mode = this.options.engine.mode('command.review');
    } catch { return null; }
    if (mode === 'off' || request.event !== 'pre-tool') return null;
    const deadline = this.now() + Math.max(0, budgetMs - MARGIN_MS);
    const signal = AbortSignal.timeout(Math.max(1, deadline - this.now()));
    const ask = (reason: ReviewReason): DecideAnswer => {
      if (reason === 'no-verifier') return { verdict: request.canAsk !== false ? 'ask' : 'deny', reason: NO_VERIFIER[this.options.locale ?? 'en'][request.canAsk !== false ? 'ask' : 'deny'] };
      const why = ASK_MESSAGES[reason] ?? ASK_MESSAGES.unavailable!;
      if (request.canAsk !== false) return { verdict: 'ask', reason: `CanvasTTY Assistant: ${why}` };
      // The agent cannot ask the person from here: CanvasTTY would turn an ask into a deny anyway. Say what to do.
      if (reason === 'unavailable' && typeof request.profile === 'string' && ASKING_PROFILES.has(request.profile)) return null;
      return { verdict: 'deny', reason: `CanvasTTY Assistant: ${why}. This agent cannot ask the person from here, so it was not run: tell the person what you want to run and why, and let them decide` };
    };
    const act = (answer: DecideAnswer): RecentReview['act'] => answer?.verdict ?? null;
    try {
      const state = this.state(request.sessionId);
      const personRequest = this.requestFor(request.sessionId);
      const action = actionFromDetail(detailFromHook(request.tool.name, request.input, request.truncated));
      if (!action.commandCwd && request.agentCwd) action.commandCwd = request.agentCwd;
      const git = this.options.git === null ? null : this.options.git ?? defaultGit;
      const home = this.options.home ?? homedir();
      // Before the facts: a whole-content write is read whole (FIELD_BOUNDS.wholeContent), so it can count as seen.
      let visible = wholeContentWrite(request.tool.name, request.input, request.truncated, action.commandCwd ?? request.cwd) && !action.inputTruncated;
      // Under the trust chain, an edit of a file this card wrote whole (unchanged since) is reviewed as the whole file
      // it results in, so the review sees exactly what the file will hold.
      const own = this.options.trustChain?.() === true ? ownFileResult(request, state, action) : null;
      if (own && !visible) { action.content = own.content; visible = true; }
      const facts = await computeCommandFacts({
        action, root: request.cwd, sessionId: request.sessionId, requestTypedByPerson: personRequest?.byPerson === true, wholeContent: visible,
        tracker: this.tracker, git, home, agentRoots: [join(home, '.claude')],
        signal: AbortSignal.any([signal, AbortSignal.timeout(REVIEW_LIMITS.factsMs)])
      });
      const rules = tier1(facts, { cwd: action.commandCwd ?? request.agentCwd ?? request.cwd });
      const summary = facts.kind === null ? `${request.tool.name.replace(/[^\w.:-]/gu, '').slice(0, 40)} (${facts.actionClass})` : reviewSummary(facts);
      // What the call writes counts as written by the session, whatever the answer (the safe side).
      if (facts.writeTargets.length) this.tracker.note(request.sessionId, facts.writeTargets.filter(path => !facts.downloadTargets.includes(path)), 'write');
      if (facts.downloadTargets.length) this.tracker.note(request.sessionId, facts.downloadTargets, 'download');
      if (action.kind === 'edit') this.tracker.note(request.sessionId, action.paths.map(path => isAbsolute(path) ? path : join(action.commandCwd ?? request.cwd, path)), 'edit');

      if (rules.verdict === 'deny') {
        const reason = rules.rule === 'write-outside' && writesOnlyToTemp(facts, request.cwd) ? TEMP_WRITE_MESSAGE
          : DENY_MESSAGES[rules.rule as typeof TIER1_DENY_RULES[number]] ?? DENY_MESSAGES.elevation;
        this.remember(request.sessionId, summary, mode, { outcome: 'deny', act: 'deny', tier: 'rule', reason: 'rule-deny', model: null, auditId: null });
        return { verdict: 'deny', reason };
      }
      const run = (): Promise<CommandReviewVerdict> => this.ladder(request, state, personRequest?.text ?? null, facts, rules, action.content, signal, visible);
      if (mode === 'shadow' || mode === 'suggest') {
        // Nothing is enforced (R10); the agent is not held. The review runs on its own, for the log and the badge.
        void run().then(verdict => {
          this.rememberVerdict(request.sessionId, summary, mode, verdict, null);
          if (mode === 'suggest' && verdict.show) this.options.suggest?.(request.sessionId, verdict, summary);
        }, () => undefined);
        return null;
      }
      const verdict = await run();
      const chained = !verdict.act && !signal.aborted ? this.trustChain(request, state, rules, facts, verdict, own) : false;
      if (chained) {
        this.noteReviewed(state, request, action, visible, own?.abs);
        this.rememberVerdict(request.sessionId, summary, mode, { ...verdict, act: 'allow', outcome: 'allow', by: 'assistant', reason: chained === 'own' ? 'trust-chain-own-file' : 'trust-chain' }, 'allow');
        return { verdict: 'allow', reason: chained === 'own'
          ? 'CanvasTTY Assistant: allowed by the trust chain: the person asked its orchestrator for this task, and this rewrites a file this card wrote earlier (unchanged since), reviewed whole'
          : 'CanvasTTY Assistant: allowed by the trust chain: the person asked its orchestrator for this task, and this writes a new file inside the project that the review is sure serves it' };
      }
      const inspected = !verdict.act && !signal.aborted ? await this.inspectionChain(request, state, rules, facts, verdict, action) : false;
      if (inspected) {
        this.rememberVerdict(request.sessionId, summary, mode, { ...verdict, act: 'allow', outcome: 'allow', by: 'assistant', reason: 'trust-chain-inspect' }, 'allow');
        return { verdict: 'allow', reason: 'CanvasTTY Assistant: allowed by the trust chain: the person asked its orchestrator for this task, and this only looks at files inside the project' };
      }
      const compound = !verdict.act && !signal.aborted ? await this.compoundChain(request, state, verdict, action, signal) : null;
      if (compound) {
        this.rememberVerdict(request.sessionId, summary, mode, { ...verdict, act: 'allow', outcome: 'allow', by: 'assistant', reason: 'trust-chain-compound' }, 'allow');
        return { verdict: 'allow', reason: `CanvasTTY Assistant: allowed by the trust chain: the person asked its orchestrator for this task, and each of its ${compound} commands is allowed on its own (read-only, inspection or its tests)` };
      }
      const tested = !verdict.act && !signal.aborted ? await this.testChain(request, state, rules, facts, verdict, action, signal) : null;
      if (tested) {
        this.rememberVerdict(request.sessionId, summary, mode, { ...verdict, act: 'allow', outcome: 'allow', by: 'assistant', reason: 'trust-chain-test' }, 'allow');
        return { verdict: 'allow', reason: `CanvasTTY Assistant: allowed by the trust chain: the person asked its orchestrator for this task, and this runs the tests with ${tested.runner === 'node' ? 'node --test' : 'pytest'} on files the review saw whole in this card or that are committed and unchanged (${tested.files.length} file${tested.files.length === 1 ? '' : 's'})` };
      }
      if (signal.aborted && !verdict.act) {
        const answer = ask('unavailable');
        this.rememberVerdict(request.sessionId, summary, mode, { ...verdict, reason: 'unavailable' }, act(answer));
        return answer;
      }
      if (verdict.act === 'allow') {
        this.noteReviewed(state, request, action, visible, own?.abs);
        this.rememberVerdict(request.sessionId, summary, mode, verdict, 'allow');
        return { verdict: 'allow', reason: verdict.by === 'rule' ? 'CanvasTTY Assistant: a read-only command' : 'CanvasTTY Assistant: both reviews agree it serves the task' };
      }
      if (verdict.act === 'deny') {
        this.rememberVerdict(request.sessionId, summary, mode, verdict, 'deny');
        return { verdict: 'deny', reason: MODEL_DENY_MESSAGE };
      }
      const answer = ask(verdict.reason);
      this.rememberVerdict(request.sessionId, summary, mode, verdict, act(answer));
      return answer;
    } catch {
      // R4: never an allow. In Auto the person decides (or, for an agent that cannot ask, a deny); Learning and Suggest
      // enforce nothing.
      return mode === 'auto' ? ask('unavailable') : null;
    }
  }

  /**
   * The person's trust chain (their own switch, off by default): a subagent may create new files in the project
   * without asking when the task it serves came from the person through its orchestrator. All of these must hold:
   * the switch is on; the card is a subagent whose orchestrator's own request is the person's (typed by them: the
   * launcher's task or a turn its Auto router saw, never only the orchestrator's text); the call only creates files
   * (no overwrite, no partial edit, no shell), whole content visible and not cut, at most the review's content size;
   * every target is inside the project, not protected, not a credential path; no tier-1 rule spoke; the light review
   * is at least TRUST_CHAIN_MIN_SERVES sure it serves the request and did not say block; the session is not suspect.
   */
  private trustChain(request: DecideRequest, state: SessionState, rules: ReturnType<typeof tier1>, facts: CommandFacts, verdict: CommandReviewVerdict, own: OwnFile | null = null): 'new' | 'own' | false {
    if (this.options.trustChain?.() !== true) return false;
    if (!state.subagent || !state.parent || state.suspect || this.circuit.personOnly(request.sessionId)) return false;
    const above = this.sessions.get(state.parent);
    if (!above || above.subagent || !this.ownTexts(above).length) return false;
    if (rules.verdict || facts.actionClass !== 'edit_in_project' || facts.kind !== 'edit' || facts.writesOutside || facts.credentialAccess || facts.protectedWrite || facts.truncated) return false;
    if (verdict.outcome === 'deny' || verdict.modelDenied || typeof verdict.probability !== 'number' || verdict.probability < TRUST_CHAIN_NAMED_MIN_SERVES) return false;
    const action = actionFromDetail(detailFromHook(request.tool.name, request.input, request.truncated));
    if (action.inputTruncated || (own ? own.content.length : action.content?.length ?? 0) > REVIEW_LIMITS.contentChars) return false;
    const cwd = action.commandCwd ?? request.agentCwd ?? request.cwd;
    // A new file, or a whole rewrite of a file this card wrote whole earlier and nobody changed since (ownFileResult).
    const created = newFileTargets(request.tool.name, request.input, request.truncated, cwd);
    const kind: 'new' | 'own' = created ? 'new' : 'own';
    const targets = created ?? (own ? [own.abs] : null);
    if (!targets) return false;
    const root = realish(resolve(request.cwd));
    const inside = (dir: string, abs: string): boolean => abs.startsWith(`${dir}${sep}`);
    if (!targets.every(path => { const abs = realish(resolve(path)); return inside(root, abs) && !isCredentialPath(abs) && !isProtectedRel(relative(root, abs).split(sep).join('/')); })) return false;
    const risks = Object.entries(verdict.risks ?? {}).filter(([id]) => id !== 'effect_hidden');
    const low = risks.length > 0 && risks.every(([, p]) => typeof p === 'number' && p <= TRUST_CHAIN_LOW_RISK);
    // A rewrite also needs every other risk low, at either bar.
    if (kind === 'own' && !low) return false;
    if (verdict.probability >= TRUST_CHAIN_MIN_SERVES) return kind;
    // Below 0.95: only a file the trusted task names, in this card's folder or one the task names, with low risks.
    if (!low) return false;
    const texts = [...this.ownTexts(above), ...this.ownTexts(state)];
    const folders = [realish(resolve(request.agentCwd ?? request.cwd)), ...texts.flatMap(namedFolders).map(folder => realish(resolve(root, folder)))].filter(dir => dir === root || inside(root, dir));
    return targets.every(path => {
      const abs = realish(resolve(path));
      return texts.some(text => namesFile(text, abs)) && folders.some(dir => inside(dir, abs));
    }) ? kind : false;
  }

  /**
   * Plain read-only inspection under the trust chain: `ls`, `cat`/`head`/`tail`/`wc` of files, `pwd`, `git
   * status`/`diff`/`log` (inspection.ts decides what is plain), only inside the project and never a protected or
   * private path, with every risk but effect_hidden low. The task need not name it: looking is how work starts.
   */
  private async inspectionChain(request: DecideRequest, state: SessionState, rules: ReturnType<typeof tier1>, facts: CommandFacts, verdict: CommandReviewVerdict, action: ReviewAction): Promise<boolean> {
    if (this.options.trustChain?.() !== true) return false;
    if (!state.subagent || !state.parent || state.suspect || this.circuit.personOnly(request.sessionId)) return false;
    const above = this.sessions.get(state.parent);
    if (!above || above.subagent || !this.ownTexts(above).length) return false;
    if (rules.verdict || facts.kind !== 'execute' || facts.actionClass !== 'read_only' || facts.network !== 'none' || facts.truncated || action.inputTruncated || facts.credentialAccess || facts.protectedWrite || facts.writesOutside) return false;
    if (verdict.outcome === 'deny' || verdict.modelDenied) return false;
    const risks = Object.entries(verdict.risks ?? {}).filter(([id]) => id !== 'effect_hidden');
    if (!risks.length || risks.some(([, p]) => typeof p !== 'number' || p > TRUST_CHAIN_LOW_RISK)) return false;
    if (!action.command) return false;
    return plainInspection(action.command, action.commandCwd ?? request.agentCwd ?? request.cwd, request.cwd);
  }

  /**
   * An allowed write whose whole content the review saw: its content hash, for a later test command or rewrite of
   * this card. An edit the review saw as its resulting whole file (`ownAbs`) records that result.
   */
  private noteReviewed(state: SessionState, request: DecideRequest, action: ReviewAction, visible: boolean, ownAbs?: string): void {
    if (!visible || action.inputTruncated || typeof action.content !== 'string') return;
    const abs = ownAbs ?? targetOf(request, action);
    if (!abs || request.tool.name === 'apply_patch' || request.tool.name === 'patch') return;
    state.reviewed.delete(abs);
    state.reviewed.set(abs, sha256(action.content));
    while (state.reviewed.size > MAX_REVIEWED) state.reviewed.delete(state.reviewed.keys().next().value!);
  }

  /**
   * The trust chain for a test command (the same switch and the same chain from the person as for new files): a
   * plain known test runner, every file it runs seen whole by this card's review with the same content now, or
   * tracked in git and unchanged (testChain.ts), the review at least TRUST_CHAIN_NAMED_MIN_SERVES sure it serves the
   * request, and every risk but effect_hidden at most TRUST_CHAIN_LOW_RISK. Nothing it cannot determine.
   */
  private async testChain(request: DecideRequest, state: SessionState, rules: ReturnType<typeof tier1>, facts: CommandFacts, verdict: CommandReviewVerdict, action: ReviewAction, signal: AbortSignal): Promise<{ runner: string; files: string[] } | null> {
    if (this.options.trustChain?.() !== true) return null;
    if (!state.subagent || !state.parent || state.suspect || this.circuit.personOnly(request.sessionId)) return null;
    const above = this.sessions.get(state.parent);
    if (!above || above.subagent || !this.ownTexts(above).length) return null;
    if (rules.verdict || facts.kind !== 'execute' || facts.actionClass !== 'build_test' || facts.network !== 'none' || facts.truncated || action.inputTruncated
      || facts.writesOutside || facts.credentialAccess || facts.protectedWrite || facts.pipeToShell || facts.subshell || facts.background || facts.inlineCode || facts.encoded || facts.unresolvedVariables) return null;
    if (verdict.outcome === 'deny' || verdict.modelDenied || typeof verdict.probability !== 'number' || verdict.probability < TRUST_CHAIN_NAMED_MIN_SERVES) return null;
    const risks = Object.entries(verdict.risks ?? {}).filter(([id]) => id !== 'effect_hidden');
    if (!risks.length || risks.some(([, p]) => typeof p !== 'number' || p > TRUST_CHAIN_LOW_RISK)) return null;
    if (!action.command) return null;
    const git = this.options.git === null ? null : this.options.git ?? defaultGit;
    const checked = await verifyTestRun({ command: action.command, cwd: action.commandCwd ?? request.agentCwd ?? request.cwd, root: request.cwd, reviewed: state.reviewed, git, signal });
    return checked.ok ? checked : null;
  }

  /**
   * A compound command under the trust chain: only `;` and `&&` between plain commands (splitCompound refuses pipes,
   * redirects, subshells, expansion and backgrounding). Allowed only when every part is allowed on its own: by
   * tier 1's read-only list, by the inspection rule, or by the test rule, each part's facts computed alone and the
   * review's answers for the whole command applied to each. A `cd` is never a part that passes, so no part runs
   * somewhere else. Returns the number of parts.
   */
  private async compoundChain(request: DecideRequest, state: SessionState, verdict: CommandReviewVerdict, action: ReviewAction, signal: AbortSignal): Promise<number | null> {
    if (this.options.trustChain?.() !== true || action.kind !== 'execute' || !action.command || action.inputTruncated) return null;
    if (!state.subagent || !state.parent || state.suspect || this.circuit.personOnly(request.sessionId)) return null;
    const above = this.sessions.get(state.parent);
    if (!above || above.subagent || !this.ownTexts(above).length) return null;
    if (verdict.outcome === 'deny' || verdict.modelDenied) return null;
    const parts = splitCompound(action.command);
    if (!parts || parts.length < 2) return null;
    const git = this.options.git === null ? null : this.options.git ?? defaultGit;
    const home = this.options.home ?? homedir();
    const cwd = action.commandCwd ?? request.agentCwd ?? request.cwd;
    for (const part of parts) {
      const partAction: ReviewAction = { ...action, command: part, commandCwd: cwd };
      const facts = await computeCommandFacts({
        action: partAction, root: request.cwd, sessionId: request.sessionId, requestTypedByPerson: false,
        tracker: this.tracker, git, home, agentRoots: [join(home, '.claude')], signal: AbortSignal.any([signal, AbortSignal.timeout(REVIEW_LIMITS.factsMs)])
      });
      const rules = tier1(facts, { cwd });
      if (rules.verdict === 'allow') continue;
      if (rules.verdict) return null;
      if (await this.inspectionChain(request, state, rules, facts, verdict, partAction)) continue;
      if (await this.testChain(request, state, rules, facts, verdict, partAction, signal)) continue;
      return null;
    }
    return parts.length;
  }

  private async ladder(request: DecideRequest, state: SessionState, personRequest: string | null, facts: CommandFacts, rules: ReturnType<typeof tier1>, content: string | null, signal: AbortSignal, contentVisible = false): Promise<CommandReviewVerdict> {
    const settings = this.options.settings();
    const git = this.options.git === null ? null : this.options.git ?? defaultGit;
    const cacheScope = createHash('sha256').update(JSON.stringify([request.sessionId, request.cwd, facts.actionClass, factPhrases(facts), facts.shape])).digest('hex');
    const verdict = await askCommandReview(this.options.engine, {
      facts, tier1: rules, personRequest, content, dataClass: state.dataClass ?? settings.defaultDataClass,
      session: { suspect: state.suspect, strict: this.strict(state), personOnly: this.circuit.personOnly(request.sessionId) },
      cacheScope, contentVisible,
      referencedFiles: include => collectReferencedFiles({ root: request.cwd, facts, git, signal, include })
    }, {
      signal, sessionId: request.sessionId, requester: request.role === 'agent' ? 'agent' : 'orchestrator',
      assertCurrent: () => { if (signal.aborted) throw new Error('This review is past its deadline.'); }
    });
    if (verdict.markSuspect) state.suspect = true;
    if (verdict.modelOutcome) this.circuit.record(request.sessionId, verdict.modelOutcome, verdict.modelDenied);
    return verdict;
  }

  private rememberVerdict(sessionId: string, summary: string, mode: string, verdict: CommandReviewVerdict, act: RecentReview['act']): void {
    this.remember(sessionId, summary, mode, { outcome: verdict.outcome, act, tier: tierOf(verdict), reason: verdict.reason, model: verdict.model ?? null, auditId: verdict.auditId });
  }

  private remember(sessionId: string, summary: string, mode: string, entry: Pick<RecentReview, 'outcome' | 'act' | 'tier' | 'reason' | 'model' | 'auditId'>): void {
    this.recentReviews.unshift({ at: this.now(), session: sessionId.slice(0, 8), summary, mode, ...entry, label: null });
    this.recentReviews.splice(MAX_RECENT);
  }
}
