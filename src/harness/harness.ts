import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Host } from '../rpc.ts';
import { BadgeBoard, type Badge, type BadgeKind } from './badges.ts';
import { approvedInstructions, builtInFlows, planFlow, PlanStore, projectFlows, type FlowPlan } from './flows.ts';
import type { FlowDefinition } from './flowFile.ts';
import { STRINGS, type Locale, type ServiceStrings } from './i18n.ts';
import { LoopWatch } from './loops.ts';
import { Journals, reportText } from './report.ts';
import { routeAnswer, ruleDifficulty, suggestRoute, type Difficulty, type ProviderEntry } from './router.ts';
import { DEFAULT_HARNESS_SETTINGS, normalizeHarnessSettings, validateHarnessSettings, type HarnessSettings } from './settings.ts';
import { boardText, TaskBoards, type Board } from './tasks.ts';

/**
 * The harness: routing, flows, task boards, loop alerts and session reports, on the host APIs CanvasTTY has today
 * (agent tools, session events, the plugin's own decision calls, card badges and actions, plugin storage and the
 * plugin's own canvas cards). It never starts, stops or types into a card; the orchestrator does that with
 * CanvasTTY's own orchestration tools.
 */

/** A card as CanvasTTY's session events describe it (metadata only). */
export interface CardSummary {
  id: string; provider: string; role: 'agent' | 'orchestrator' | 'subagent'; parentSessionId?: string;
  title: string; status: string; exitCode?: number | null; startedAt?: number; cwd: string; workingDirectory: string;
  environment?: { pluginId: string; kind: string; label: string };
}

export type ToolAnswer = { content: unknown; isError?: boolean };

export const HARNESS_TOOLS = ['route', 'flows_list', 'flow_plan', 'flow_status', 'task_add', 'task_update', 'task_list'] as const;
export const HARNESS_ACTIONS = ['flow-preview', 'task-board', 'report'] as const;
const SETTINGS_KEY = 'harness';
const ROUTE_DEADLINE_MS = 9_000;
/** flow_status may wait for the person this long; CanvasTTY gives a tool 15 s. */
const STATUS_WAIT_MAX_MS = 10_000;

const text = (value: unknown, max: number): string => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/gu, ' ').trim().slice(0, max) : '';

export interface HarnessOptions {
  host: Host;
  dataDir: string;
  locale: Locale;
  /** Difficulty from the Assistant's decision model (`task.route`), or null to use the word rules. */
  modelDifficulty?: (task: string, caller: CardSummary, deadlineMs: number) => Promise<Difficulty | null>;
  /** Publishes the plugin's one badge on a card. */
  publishBadge: (sessionId: string, badge: Badge | null) => Promise<void>;
  now?: () => number;
}

export class Harness {
  settings: HarnessSettings = { ...DEFAULT_HARNESS_SETTINGS };
  readonly badges: BadgeBoard;
  readonly loops = new LoopWatch();
  readonly journals: Journals;
  readonly plans: PlanStore;
  readonly boards: TaskBoards;
  private readonly host: Host;
  private readonly dir: string;
  private readonly locale: Locale;
  private readonly now: () => number;
  private readonly modelDifficulty: HarnessOptions['modelDifficulty'];
  private readonly sessions = new Map<string, CardSummary>();
  /** What the person last opened from a card menu: the board and the preview cards follow it. */
  private focus: { board: string | null; flows: string | null } = { board: null, flows: null };

  constructor(options: HarnessOptions) {
    this.host = options.host;
    this.locale = options.locale;
    this.now = options.now ?? Date.now;
    this.modelDifficulty = options.modelDifficulty;
    this.dir = join(options.dataDir, 'harness');
    this.badges = new BadgeBoard(options.publishBadge);
    this.journals = new Journals(this.now);
    this.plans = new PlanStore(this.read('plans.json'), plans => this.write('plans.json', plans));
    this.boards = new TaskBoards(this.read('boards.json'), {
      save: boards => this.write('boards.json', boards),
      changed: board => this.boardChanged(board)
    });
  }

  get strings(): ServiceStrings { return STRINGS[this.locale]; }

  loadSettings(saved: unknown): void { this.settings = normalizeHarnessSettings(saved); }

  async saveSettings(value: unknown): Promise<HarnessSettings> {
    const next = validateHarnessSettings(value);
    await this.host.callHost('storage.set', { key: SETTINGS_KEY, value: next });
    this.settings = next;
    if (!next.loopAlerts) for (const id of this.sessions.keys()) { this.loops.forget(id); void this.badges.set(id, 'loop', null); }
    return next;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Files in the plugin's data folder
  // ---------------------------------------------------------------------------------------------------------------

  private read(name: string): unknown {
    try { return JSON.parse(readFileSync(join(this.dir, name), 'utf8')); } catch { return null; }
  }

  private write(name: string, value: unknown): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const path = join(this.dir, name);
      writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    } catch (error) {
      this.host.log('warn', `harness: could not save ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Session events and decision calls
  // ---------------------------------------------------------------------------------------------------------------

  sessionsKnown(list: unknown): void {
    if (!Array.isArray(list)) return;
    for (const session of list) this.sessionEvent({ type: 'restored', session });
  }

  sessionEvent(event: { type?: unknown; session?: unknown }): void {
    const session = event.session as CardSummary | undefined;
    if (!session || typeof session.id !== 'string') return;
    if (event.type === 'closed') {
      this.sessions.delete(session.id);
      this.loops.forget(session.id);
      this.badges.forget(session.id);
      this.journals.forget(session.id);
      if (session.role === 'orchestrator') { this.boards.forget(session.id); this.plans.forgetOrchestrator(session.id); }
      this.surfacesChanged();
      return;
    }
    const before = this.sessions.get(session.id);
    this.sessions.set(session.id, session);
    const { turnStarted } = this.journals.observe(session);
    // A new turn: the person (or the orchestrator) gave new input, so the last turn's loop evidence and badge go.
    if (turnStarted && this.loops.turnStarted(session.id)) void this.badges.set(session.id, 'loop', null);
    if (event.type === 'exited') { this.loops.forget(session.id); void this.badges.set(session.id, 'loop', null); }
    if (session.role === 'orchestrator' && before?.title !== session.title) this.boards.rename(session.id, session.title);
    if (!before || before.title !== session.title || before.status !== session.status) this.surfacesChanged();
  }

  /** Every pre-tool call CanvasTTY asked the plugin about, with the answer it got. */
  observeDecision(request: { sessionId?: unknown; tool?: unknown }, verdict: string | null): void {
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : '';
    const tool = request.tool as { name?: unknown; kind?: unknown; command?: unknown; paths?: unknown } | undefined;
    if (!sessionId || !tool || typeof tool.name !== 'string') return;
    this.journals.command(sessionId, verdict);
    if (!this.settings.loopAlerts) return;
    const signal = this.loops.action(sessionId, {
      name: tool.name, kind: typeof tool.kind === 'string' ? tool.kind : 'other',
      command: typeof tool.command === 'string' ? tool.command : null,
      paths: Array.isArray(tool.paths) ? tool.paths.filter((path): path is string => typeof path === 'string').slice(0, 16) : []
    });
    if (!signal) return;
    this.journals.loop(sessionId);
    void this.badges.set(sessionId, 'loop', { text: this.strings.loopBadge, tone: 'warn', tooltip: this.strings.loopTip(signal.count, signal.what) });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Agent tools
  // ---------------------------------------------------------------------------------------------------------------

  handles(name: string): boolean { return (HARNESS_TOOLS as readonly string[]).includes(name); }

  async tool(name: string, caller: CardSummary | undefined, input: Record<string, unknown>): Promise<ToolAnswer> {
    if (!caller || typeof caller.id !== 'string') return { content: 'CanvasTTY did not say which card is calling.', isError: true };
    if (!this.sessions.has(caller.id)) this.sessions.set(caller.id, caller);
    switch (name) {
      case 'route': return this.route(caller, input);
      case 'flows_list': return this.flowsList(caller);
      case 'flow_plan': return this.flowPlan(caller, input);
      case 'flow_status': return this.flowStatus(caller, input);
      case 'task_add': return this.taskAdd(caller, input);
      case 'task_update': return this.taskUpdate(caller, input);
      case 'task_list': return this.taskList(caller);
      default: return { content: `Unknown tool ${name.slice(0, 40)}.`, isError: true };
    }
  }

  private providersOf(input: Record<string, unknown>): ProviderEntry[] {
    const raw = Array.isArray(input.providers) ? input.providers
      : input.providers && typeof input.providers === 'object' && Array.isArray((input.providers as { providers?: unknown }).providers) ? (input.providers as { providers: unknown[] }).providers : [];
    return raw.filter((entry): entry is ProviderEntry => !!entry && typeof entry === 'object' && typeof (entry as ProviderEntry).id === 'string').slice(0, 16);
  }

  private async route(caller: CardSummary, input: Record<string, unknown>): Promise<ToolAnswer> {
    const task = text(input.task, 4_000);
    if (!task) return { content: 'Give the subagent\'s task in `task`.', isError: true };
    if (!this.settings.routing) return { content: 'Automatic routing is off in the Assistant settings: choose the provider and model yourself.' };
    let difficulty: Difficulty | null = null;
    try { difficulty = await this.modelDifficulty?.(task, caller, ROUTE_DEADLINE_MS) ?? null; } catch { difficulty = null; }
    const source = difficulty ? 'model' : 'rules';
    const suggestion = suggestRoute({
      difficulty: difficulty ?? ruleDifficulty(task), source, callerProvider: caller.provider ?? null, providers: this.providersOf(input),
      prefer: text(input.prefer, 40) || null,
      launchOptionTools: Array.isArray(input.launchOptionTools) ? input.launchOptionTools.filter((name): name is string => typeof name === 'string').slice(0, 8) : []
    });
    if (!suggestion) return { content: 'No listed provider is available for a subagent. Call list_providers and pick one yourself.' };
    return { content: routeAnswer(suggestion) };
  }

  /** Built-in and project flows for this card's project (project flows are read from its own folder only). */
  flowsFor(session: CardSummary | null): { flows: FlowDefinition[]; problems: Array<{ file: string; problem: string }> } {
    const project = projectFlows(session ? session.workingDirectory || session.cwd || null : null);
    return { flows: [...builtInFlows(this.locale), ...project.flows], problems: project.problems };
  }

  private flowsList(caller: CardSummary): ToolAnswer {
    if (!this.settings.flows) return { content: 'Flows are off in the Assistant settings.' };
    const { flows, problems } = this.flowsFor(caller);
    return {
      content: [
        'Flows (call flow_plan with an id and the goal; the person approves the plan before anything starts):',
        ...flows.map(flow => `- ${flow.id} (${flow.source === 'project' ? 'from this project' : 'built in'}): ${flow.name}. ${flow.description} Roles: ${flow.roles.map(role => role.id).join(', ')}.`),
        ...problems.map(problem => `- not loaded: .canvastty/flows/${problem.file}: ${problem.problem}`)
      ].join('\n')
    };
  }

  private flowPlan(caller: CardSummary, input: Record<string, unknown>): ToolAnswer {
    if (!this.settings.flows) return { content: 'Flows are off in the Assistant settings.' };
    const goal = text(input.goal, 1_000);
    const flowId = text(input.flow, 40);
    if (!goal || !flowId) return { content: 'Give `flow` (an id from flows_list) and `goal`.', isError: true };
    const flow = this.flowsFor(caller).flows.find(item => item.id === flowId);
    if (!flow) return { content: `No flow "${flowId}"; call flows_list.`, isError: true };
    const plan = planFlow(flow, {
      goal, orchestratorId: caller.id, orchestratorTitle: caller.title || caller.id.slice(0, 8), callerProvider: caller.provider ?? null,
      providers: this.providersOf(input), requestedBy: 'orchestrator', now: this.now(), routing: this.settings.routing
    });
    this.plans.add(plan);
    this.focus.flows = caller.id;
    void this.badges.set(caller.id, 'flow', { text: this.strings.flowBadge, tone: 'info', tooltip: this.strings.flowTip });
    this.surfacesChanged();
    return {
      content: `Plan ${plan.id} waits for the person: they see it in the Flow preview card and press Start or Cancel. Do not start these subagents yet. Call flow_status with planId "${plan.id}" (it waits up to 10 s per call) until it says approved or cancelled. Tell the person briefly that a plan is waiting for them.\n${JSON.stringify({ planId: plan.id, roles: plan.roles })}`
    };
  }

  private async flowStatus(caller: CardSummary, input: Record<string, unknown>): Promise<ToolAnswer> {
    if (!this.settings.flows) return { content: 'Flows are off in the Assistant settings.' };
    const planId = text(input.planId, 40) || undefined;
    const waitMs = Math.max(0, Math.min(STATUS_WAIT_MAX_MS, Number.isFinite(input.waitSeconds) ? Number(input.waitSeconds) * 1_000 : STATUS_WAIT_MAX_MS));
    const deadline = this.now() + waitMs;
    let plan = this.plans.current(caller.id, planId);
    while (plan && plan.status === 'pending' && this.now() < deadline) {
      await this.plans.waitForChange(Math.max(1, deadline - this.now()));
      plan = this.plans.current(caller.id, planId);
    }
    if (!plan) return { content: planId ? `No plan "${planId}" for this card.` : 'No plan waits for you. Call flow_plan, or ask the person to choose a flow in the Flow preview card.' };
    if (plan.status === 'pending') return { content: `Plan ${plan.id} still waits for the person. Call flow_status again, or go on with other work and check later.` };
    if (plan.status === 'cancelled') return { content: `The person cancelled plan ${plan.id}. Do not start its subagents; ask the person how to go on.` };
    this.plans.delivered(plan.id);
    return { content: approvedInstructions(plan) };
  }

  /** The orchestrator a caller's board belongs to: its own card, or a subagent's parent. */
  private boardOwner(caller: CardSummary): { orchestratorId: string; isOrchestrator: boolean } | null {
    if (caller.role === 'orchestrator') return { orchestratorId: caller.id, isOrchestrator: true };
    if (caller.role === 'subagent' && caller.parentSessionId) return { orchestratorId: caller.parentSessionId, isOrchestrator: false };
    return null;
  }

  private taskAdd(caller: CardSummary, input: Record<string, unknown>): ToolAnswer {
    if (caller.role !== 'orchestrator') return { content: 'Only an orchestrator adds tasks.', isError: true };
    const assignee = text(input.assignee, 80) || null;
    if (assignee && this.sessions.get(assignee)?.parentSessionId !== caller.id) return { content: 'assignee must be the session id of one of your subagents.', isError: true };
    try {
      const task = this.boards.add(caller.id, caller.title, { title: input.title, detail: input.detail, assignee }, this.now());
      return { content: `Added ${task.id}. Subagents see the board with task_list and update their tasks with task_update.\n${JSON.stringify(task)}` };
    } catch (error) { return { content: error instanceof Error ? error.message : String(error), isError: true }; }
  }

  private taskUpdate(caller: CardSummary, input: Record<string, unknown>): ToolAnswer {
    const owner = this.boardOwner(caller);
    if (!owner) return { content: 'Only an orchestrator and its subagents have a task board.', isError: true };
    if (input.assignee !== undefined && owner.isOrchestrator && input.assignee !== '' && this.sessions.get(String(input.assignee))?.parentSessionId !== caller.id) {
      return { content: 'assignee must be the session id of one of your subagents (or "" to clear it).', isError: true };
    }
    try {
      const task = this.boards.update(owner.orchestratorId, { sessionId: caller.id, isOrchestrator: owner.isOrchestrator }, { ...input, id: input.id }, this.now());
      return { content: `Updated ${task.id}: ${task.status}.\n${JSON.stringify(task)}` };
    } catch (error) { return { content: error instanceof Error ? error.message : String(error), isError: true }; }
  }

  private taskList(caller: CardSummary): ToolAnswer {
    const owner = this.boardOwner(caller);
    if (!owner) return { content: 'Only an orchestrator and its subagents have a task board.', isError: true };
    return { content: boardText(this.boards.get(owner.orchestratorId)) };
  }

  private boardChanged(board: Board): void {
    const { done, total } = this.boards.progress(board.orchestratorId);
    void this.badges.set(board.orchestratorId, 'tasks', total ? { text: this.strings.tasksBadge(done, total), tone: 'info', tooltip: this.strings.tasksTip } : null);
    this.host.emit('board', { orchestratorId: board.orchestratorId });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Card actions
  // ---------------------------------------------------------------------------------------------------------------

  cardAction(actionId: string, sessionId: string, session: CardSummary | undefined): { message: string; tone: 'info' | 'warn' | 'error' } {
    const card = (session && typeof session.id === 'string' ? session : null) ?? this.sessions.get(sessionId) ?? null;
    if (card) { this.sessions.set(card.id, card); this.journals.observe(card); }
    const title = card?.title || this.journals.titleOf(sessionId);
    if (actionId === 'task-board') {
      this.focus.board = sessionId;
      this.host.emit('focus', { ...this.focus });
      const { done, total } = this.boards.progress(sessionId);
      return { message: this.strings.boardToast(title, done, total), tone: 'info' };
    }
    if (actionId === 'flow-preview') {
      if (!this.settings.flows) return { message: this.strings.flowsOff, tone: 'warn' };
      this.focus.flows = sessionId;
      this.host.emit('focus', { ...this.focus });
      return { message: this.strings.flowToast(title), tone: 'info' };
    }
    if (actionId === 'report') {
      const journal = this.journals.get(sessionId);
      if (!journal) return { message: this.strings.report.title(title), tone: 'info' };
      const childTitles = journal.children.map(id => this.journals.titleOf(id));
      const tasks = journal.role === 'orchestrator' ? this.boards.progress(sessionId) : null;
      return { message: reportText(journal, this.strings, { tasks, childTitles, now: this.now() }), tone: 'info' };
    }
    return { message: `Unknown action ${actionId.slice(0, 40)}.`, tone: 'error' };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The plugin's own cards (Flow preview, Task board) and settings page. No folder paths reach a page.
  // ---------------------------------------------------------------------------------------------------------------

  private orchestrators(): Array<{ id: string; title: string; status: string }> {
    return [...this.sessions.values()].filter(session => session.role === 'orchestrator')
      .map(session => ({ id: session.id, title: session.title || session.id.slice(0, 8), status: session.status }));
  }

  view(): unknown {
    return {
      settings: this.settings, locale: this.locale, focus: { ...this.focus }, orchestrators: this.orchestrators(),
      titles: Object.fromEntries([...this.sessions.values()].map(session => [session.id, session.title || session.id.slice(0, 8)])),
      plans: this.plans.list().filter(plan => plan.status === 'pending' || this.now() - plan.createdAt < 86_400_000).reverse(),
      boards: this.boards.list()
    };
  }

  /** Flows the preview card offers for an orchestrator: names, descriptions and role titles, no paths. */
  flowChoices(orchestratorId: string): unknown {
    if (!this.settings.flows) return { flows: [], problems: [], off: true };
    const { flows, problems } = this.flowsFor(this.sessions.get(orchestratorId) ?? null);
    return { flows, problems, off: false };
  }

  createPlan(orchestratorId: string, flowId: string, goalText: string): FlowPlan {
    if (!this.settings.flows) throw new Error(this.strings.flowsOff);
    const orchestrator = this.sessions.get(orchestratorId);
    if (!orchestrator || orchestrator.role !== 'orchestrator') throw new Error('Choose an open orchestrator card.');
    const goal = text(goalText, 1_000);
    if (!goal) throw new Error('Write the goal first.');
    const flow = this.flowsFor(orchestrator).flows.find(item => item.id === flowId);
    if (!flow) throw new Error('Unknown flow.');
    const plan = planFlow(flow, {
      goal, orchestratorId, orchestratorTitle: orchestrator.title, callerProvider: orchestrator.provider, providers: [],
      requestedBy: 'person', now: this.now(), routing: this.settings.routing
    });
    this.plans.add(plan);
    this.surfacesChanged();
    return plan;
  }

  decidePlan(planId: string, decision: unknown): FlowPlan {
    if (decision !== 'approved' && decision !== 'cancelled') throw new Error('Start or Cancel.');
    const plan = this.plans.decide(planId, decision, this.now());
    void this.badges.set(plan.orchestratorId, 'flow', null);
    if (decision === 'approved') {
      for (const role of plan.roles) {
        try { this.boards.add(plan.orchestratorId, plan.orchestratorTitle, { title: `${role.title}: ${plan.goal}`.slice(0, 200), detail: role.task, addedBy: 'flow' }, this.now()); } catch { break; }
      }
    }
    this.surfacesChanged();
    return plan;
  }

  private surfacesChanged(): void { this.host.emit('changed', null); }

  setBadge(sessionId: string, kind: BadgeKind, badge: Badge | null): Promise<void> { return this.badges.set(sessionId, kind, badge); }
}
