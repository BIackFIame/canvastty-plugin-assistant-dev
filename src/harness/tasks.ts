import { visibleText } from './flowFile.ts';

/**
 * Task boards, one per orchestrator card, fed by agent tools: the orchestrator adds tasks, its subagents claim and
 * update them, and an approved flow adds one task per role. The Task board canvas card only reads them. Kept in the
 * plugin's data folder; a board goes when its orchestrator card is closed.
 */
export type TaskStatus = 'todo' | 'doing' | 'done' | 'blocked';
export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'done', 'blocked'];

export interface Task {
  id: string;
  title: string;
  detail: string;
  status: TaskStatus;
  /** The subagent card working on it, when one claimed it or was given it. */
  assignee: string | null;
  note: string;
  addedBy: 'orchestrator' | 'flow';
  createdAt: number;
  updatedAt: number;
}

export interface Board { orchestratorId: string; title: string; tasks: Task[]; nextId: number }

export const TASK_LIMITS = Object.freeze({ boards: 32, tasks: 100, title: 200, detail: 2_000, note: 500 });

const clean = (value: unknown, max: number): string => typeof value === 'string' ? visibleText(value, true).trim().slice(0, max) : '';

export class TaskBoards {
  private boards = new Map<string, Board>();
  private readonly save: (boards: Board[]) => void;
  private readonly onChange: (board: Board) => void;

  constructor(initial: unknown, deps: { save(boards: Board[]): void; changed(board: Board): void }) {
    this.save = deps.save;
    this.onChange = deps.changed;
    // The file is the plugin's own, but anything on this computer could have written it: only valid boards load.
    if (Array.isArray(initial)) {
      for (const candidate of initial.slice(-TASK_LIMITS.boards)) {
        const board = loadBoard(candidate);
        if (board) this.boards.set(board.orchestratorId, board);
      }
    }
  }

  /** Boards of orchestrators that are gone (closed while the service was not running) go too. */
  retainOrchestrators(known: ReadonlySet<string>): string[] {
    const gone = [...this.boards.keys()].filter(id => !known.has(id));
    for (const id of gone) this.forget(id);
    return gone;
  }

  list(): Board[] { return structuredClone([...this.boards.values()]); }
  get(orchestratorId: string): Board | null { const board = this.boards.get(orchestratorId); return board ? structuredClone(board) : null; }

  progress(orchestratorId: string): { done: number; total: number } {
    const tasks = this.boards.get(orchestratorId)?.tasks ?? [];
    return { done: tasks.filter(task => task.status === 'done').length, total: tasks.length };
  }

  add(orchestratorId: string, title: string, input: { title: unknown; detail?: unknown; assignee?: string | null; addedBy?: Task['addedBy'] }, now: number): Task {
    const text = clean(input.title, TASK_LIMITS.title);
    if (!text) throw new Error('A task needs a title.');
    let board = this.boards.get(orchestratorId);
    if (!board) {
      if (this.boards.size >= TASK_LIMITS.boards) {
        // The board touched longest ago goes first.
        const oldest = [...this.boards.values()].sort((a, b) => latest(a) - latest(b))[0]!;
        this.boards.delete(oldest.orchestratorId);
      }
      board = { orchestratorId, title: clean(title, 120) || orchestratorId.slice(0, 8), tasks: [], nextId: 1 };
      this.boards.set(orchestratorId, board);
    } else if (title) board.title = clean(title, 120) || board.title;
    if (board.tasks.length >= TASK_LIMITS.tasks) throw new Error(`A board holds at most ${TASK_LIMITS.tasks} tasks; mark finished ones done and keep the list short.`);
    const task: Task = {
      id: `t${board.nextId++}`, title: text, detail: clean(input.detail, TASK_LIMITS.detail), status: 'todo',
      assignee: input.assignee ?? null, note: '', addedBy: input.addedBy ?? 'orchestrator', createdAt: now, updatedAt: now
    };
    board.tasks.push(task);
    this.changed(board);
    return structuredClone(task);
  }

  /**
   * `actor` is the orchestrator itself or one of its subagents. A subagent may change only a task given to it, or
   * claim an unassigned one (it becomes the assignee).
   */
  update(orchestratorId: string, actor: { sessionId: string; isOrchestrator: boolean }, input: { id: unknown; status?: unknown; note?: unknown; assignee?: unknown }, now: number): Task {
    const board = this.boards.get(orchestratorId);
    const task = board?.tasks.find(item => item.id === input.id);
    if (!board || !task) throw new Error('No such task on this board; call task_list.');
    if (input.status !== undefined && !TASK_STATUSES.includes(input.status as TaskStatus)) throw new Error(`status is one of ${TASK_STATUSES.join(', ')}.`);
    if (!actor.isOrchestrator) {
      if (task.assignee && task.assignee !== actor.sessionId) throw new Error('This task belongs to another subagent.');
      if (input.assignee !== undefined) throw new Error('Only the orchestrator assigns tasks.');
      task.assignee = actor.sessionId;
    } else if (input.assignee !== undefined) {
      task.assignee = typeof input.assignee === 'string' && input.assignee ? input.assignee : null;
    }
    if (input.status !== undefined) task.status = input.status as TaskStatus;
    if (input.note !== undefined) task.note = clean(input.note, TASK_LIMITS.note);
    task.updatedAt = now;
    this.changed(board);
    return structuredClone(task);
  }

  rename(orchestratorId: string, title: string): void {
    const board = this.boards.get(orchestratorId);
    const text = clean(title, 120);
    if (board && text && board.title !== text) { board.title = text; this.changed(board); }
  }

  forget(orchestratorId: string): boolean {
    const board = this.boards.get(orchestratorId);
    if (!board) return false;
    this.boards.delete(orchestratorId);
    this.save([...this.boards.values()]);
    this.onChange({ ...board, tasks: [] });
    return true;
  }

  private changed(board: Board): void {
    this.save([...this.boards.values()]);
    this.onChange(structuredClone(board));
  }
}

const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function loadTask(value: unknown): Task | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const task = value as Record<string, unknown>;
  if (!isText(task.id, 12) || !/^t\d{1,9}$/u.test(task.id) || !isText(task.title, TASK_LIMITS.title) || !task.title || !TASK_STATUSES.includes(task.status as TaskStatus)) return null;
  if (task.addedBy !== 'orchestrator' && task.addedBy !== 'flow') return null;
  if (!isTime(task.createdAt) || !isTime(task.updatedAt)) return null;
  return {
    id: task.id, title: clean(task.title, TASK_LIMITS.title), detail: clean(task.detail, TASK_LIMITS.detail), status: task.status as TaskStatus,
    assignee: isText(task.assignee, 200) && task.assignee ? task.assignee : null, note: clean(task.note, TASK_LIMITS.note),
    addedBy: task.addedBy, createdAt: task.createdAt, updatedAt: task.updatedAt
  };
}

function loadBoard(value: unknown): Board | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const board = value as Record<string, unknown>;
  if (!isText(board.orchestratorId, 200) || !board.orchestratorId || !Array.isArray(board.tasks)) return null;
  const tasks: Task[] = [];
  for (const candidate of board.tasks.slice(0, TASK_LIMITS.tasks)) {
    const task = loadTask(candidate);
    if (task && !tasks.some(other => other.id === task.id)) tasks.push(task);
  }
  // The next id is past every id in use, whatever the file says.
  const used = Math.max(0, ...tasks.map(task => Number(task.id.slice(1))));
  const saved = Number.isSafeInteger(board.nextId) && (board.nextId as number) <= 1e9 ? board.nextId as number : 0;
  return { orchestratorId: board.orchestratorId, title: clean(board.title, 120) || board.orchestratorId.slice(0, 8), tasks, nextId: Math.max(used + 1, saved, 1) };
}

const latest = (board: Board): number => Math.max(0, ...board.tasks.map(task => task.updatedAt));

/** The board as an agent reads it. */
export function boardText(board: Board | null): string {
  if (!board || !board.tasks.length) return 'The board is empty. The orchestrator adds tasks with task_add.';
  const lines = board.tasks.map(task => `${task.id} [${task.status}] ${task.title}${task.assignee ? ` (assignee ${task.assignee.slice(0, 8)})` : ''}${task.note ? ` — ${task.note}` : ''}`);
  const done = board.tasks.filter(task => task.status === 'done').length;
  return `${done}/${board.tasks.length} done\n${lines.join('\n')}\n${JSON.stringify(board.tasks.map(({ id, title, status, assignee, note, detail }) => ({ id, title, status, assignee, note, detail })))}`;
}
