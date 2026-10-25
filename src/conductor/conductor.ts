/**
 * The main agent («Главный агент», conductor-design.md, Phase 0, shape A2): one top-level CLI card this plugin
 * starts in its own small folder, and a project agent (a top-level orchestrator) per project, started by this
 * plugin in that project's folder on the route Jev picks. The main agent reaches projects only through the
 * `projects` tool (one tool with an action: CanvasTTY gives a service at most 16 agent tools), project agents send
 * their results with `report_to_main`, and the Assistant types short status lines into the main agent while it is
 * idle. Caller checks are by full session id until CanvasTTY scopes tools to the cards a plugin started (C4).
 *
 * Safety: folders come only from the list the person keeps (the model names a project by its id, never a path, and
 * the folder is checked again at start); at most `maxProjects` project agents run at once; a project waiting for the
 * person is never answered here; reports are kept as untrusted data and handed to the main agent quoted, never in a
 * status line.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Host } from '../rpc.ts';
import { briefFile, firstMessage, LEAD_BRIEF, quoteReport, reportText, STATUS_PREFIX, BRIEF_MARK } from './brief.ts';
import { checkFolder, gitBranch, MAX_PROJECTS, projectId, projectsFrom, type FolderRefusal, type Project } from './folders.ts';
import { notStartedLine, statusLine, type LeadState, type LineLocale } from './lines.ts';

export const STORAGE_KEY = 'conductor';
/** The CLIs whose agents reach plugin tools (CanvasTTY's agent-tools bridge): the main agent and project agents run there. */
export const TOOL_CLIS = ['claude', 'codex', 'qwen', 'opencode'] as const;
export const DEFAULT_MAX_PROJECTS = 4;
/** CanvasTTY runs at most 16 cards per plugin, the main agent among them. */
export const MAX_PROJECTS_AT_ONCE = 15;
/** Status changes within this window go to the main agent as one message. */
export const BATCH_MS = 10_000;
/**
 * The main agent must have been idle this long before a line is typed in. CanvasTTY tells a plugin nothing about
 * typing in a card, so a quiet idle stretch is the sign the person is not in the middle of a message.
 */
export const QUIET_MS = 30_000;
const MAX_SEND = 15_000;
const SEND_WAIT_MS = 8_000;
const MAX_REPORTS_KEPT = 64;

export type ReportStatus = 'done' | 'blocked' | 'progress';
export interface Report { status: ReportStatus; summary: string; at: number }

/** Where a top-level card runs, as the route decision chose it (no keys, no paths). */
export interface LeadRoute { cli: string; kind: string; label: string; model: string | null; effort: string | null; signIn: string; accountId?: string | null }

export interface Lead {
  projectId: string; sessionId: string; startedAt: number; task: string; route: LeadRoute;
  report: Report | null; stopped: boolean;
  ended: { at: number; exitCode: number | null; status: string } | null;
}

export interface ConductorSettings { projects: Project[]; push: boolean; maxProjects: number }

export type TopStart =
  | { started: true; sessionId: string; route: LeadRoute; planLine: string | null }
  | { started: false; code: 'routingOff' | 'core' | 'consent' | 'noRoute' | 'refused' | 'input'; detail?: string };

export interface Card { id: string; provider?: string; role?: string; parentSessionId?: string; title?: string; status?: string; exitCode?: number | null; startedAt?: number; cwd?: string; workingDirectory?: string }

export interface ConductorDeps {
  host: Host;
  dataDir: string;
  home: string;
  now?: () => number;
  /** A timer (tests pass their own clock). */
  schedule?: (run: () => void, ms: number) => { cancel(): void };
  locale: () => LineLocale;
  session(id: string): Card | undefined;
  treeBelow(id: string): Set<string>;
  /** Routes (Jev) and starts a top-level orchestrator on one of TOOL_CLIS: the main agent, or a project agent. */
  startTop(input: { kind: 'conductor' | 'lead'; task: string; cwd: string; title: string }): Promise<TopStart>;
  /** The account and the quota left of a route, from the route decision and Accounts' quota share. */
  accountOf(route: LeadRoute): { account: string | null; quota: { percent: number | null; resetsAt: number | null } | null };
  /** Folders of the cards open now (newest first). */
  openFolders(): string[];
}

type ToolAnswer = { content: unknown; isError?: boolean };

const clean = (value: unknown, max: number): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, max) : '';
const oneLine = (value: string): string => value.replace(/\s*\n\s*/gu, ' ');
const ENDED = new Set(['done', 'failed', 'stopped']);

export function settingsFrom(value: unknown): ConductorSettings {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const max = typeof record.maxProjects === 'number' && Number.isInteger(record.maxProjects) ? Math.max(1, Math.min(MAX_PROJECTS_AT_ONCE, record.maxProjects)) : DEFAULT_MAX_PROJECTS;
  return { projects: projectsFrom(record.projects), push: record.push !== false, maxProjects: max };
}

export class Conductor {
  settings: ConductorSettings;
  /** False while the saved list could not be read: nothing is saved over it. */
  private readable: boolean;
  conductorId: string | null = null;
  private readonly leads: Lead[] = [];
  private readonly deps: ConductorDeps;
  private readonly now: () => number;
  private readonly schedule: (run: () => void, ms: number) => { cancel(): void };
  private reserving = 0;
  private starting: Promise<unknown> | null = null;
  /** Push: projects whose line changed, the batch timer, the quiet timer and when the main agent went idle. */
  private readonly pending = new Set<string>();
  private batchTimer: { cancel(): void } | null = null;
  private quietTimer: { cancel(): void } | null = null;
  private idleSince: number | null = null;
  private sending = false;
  /** The last state each lead was pushed with (a repeat of the same state is not pushed again). */
  private readonly pushed = new Map<string, string>();
  /** Lines typed into the main agent (tests read them). */
  readonly sent: string[] = [];

  constructor(deps: ConductorDeps, saved: unknown, savedUnavailable = false) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.schedule = deps.schedule ?? ((run, ms) => { const timer = setTimeout(run, ms); (timer as { unref?: () => void }).unref?.(); return { cancel: () => clearTimeout(timer) }; });
    this.readable = !savedUnavailable;
    this.settings = settingsFrom(this.readable ? saved : null);
    this.loadRuntime();
  }

  get folder(): string { return join(this.deps.home, 'CanvasTTY', 'main-agent'); }
  isConductor(id: unknown): boolean { return typeof id === 'string' && !!this.conductorId && id === this.conductorId; }
  leadBySession(id: unknown): Lead | undefined { return typeof id === 'string' ? this.leads.find(lead => lead.sessionId === id) : undefined; }
  taskOf(id: string): string | null { return this.leadBySession(id)?.task ?? null; }
  routeOf(id: string): LeadRoute | null { return this.leadBySession(id)?.route ?? null; }

  loaded(value: unknown): void { this.settings = settingsFrom(value); this.readable = true; }

  // ---- runtime (the main agent's id, the project agents and their reports): the plugin's data folder ----

  private get runtimeFile(): string { return join(this.deps.dataDir, 'conductor.json'); }
  private loadRuntime(): void {
    try {
      const raw = JSON.parse(readFileSync(this.runtimeFile, 'utf8')) as { conductorId?: unknown; leads?: unknown };
      this.conductorId = typeof raw.conductorId === 'string' && raw.conductorId.length <= 80 ? raw.conductorId : null;
      if (Array.isArray(raw.leads)) for (const entry of raw.leads.slice(0, MAX_REPORTS_KEPT)) {
        const lead = leadFrom(entry);
        if (lead) this.leads.push(lead);
      }
    } catch { /* nothing kept yet */ }
  }
  private saveRuntime(): void {
    try {
      mkdirSync(this.deps.dataDir, { recursive: true });
      while (this.leads.length > MAX_REPORTS_KEPT) this.leads.splice(this.leads.findIndex(lead => lead.ended) >= 0 ? this.leads.findIndex(lead => lead.ended) : 0, 1);
      writeFileSync(this.runtimeFile, JSON.stringify({ conductorId: this.conductorId, leads: this.leads }), { mode: 0o600 });
    } catch (error) { this.deps.host.log('warn', `conductor: could not save (${error instanceof Error ? error.message.slice(0, 120) : 'error'})`); }
  }

  private async saveSettings(): Promise<void> {
    if (!this.readable) throw new Error('The saved project list could not be read yet; nothing is saved until it is.');
    await this.deps.host.callHost('storage.set', { key: STORAGE_KEY, value: this.settings });
    this.notify();
  }

  // ---- the person's project list (the Assistant page) ----

  async addProject(path: unknown): Promise<{ project: Project } | { refused: FolderRefusal | 'full' | 'listed' }> {
    if (this.settings.projects.length >= MAX_PROJECTS) return { refused: 'full' };
    const checked = checkFolder(path, { home: this.deps.home, dataDir: this.deps.dataDir, conductorFolder: this.folder });
    if ('refused' in checked) return checked;
    if (this.settings.projects.some(project => project.path === checked.path)) return { refused: 'listed' };
    const id = projectId(checked.path, new Set(this.settings.projects.map(project => project.id)));
    const name = checked.path.split(/[\\/]/u).filter(Boolean).at(-1)!.slice(0, 80);
    const project: Project = { id, name, path: checked.path, addedAt: this.now() };
    this.settings = { ...this.settings, projects: [...this.settings.projects, project] };
    await this.saveSettings();
    return { project };
  }

  async removeProject(id: unknown): Promise<boolean> {
    const before = this.settings.projects.length;
    this.settings = { ...this.settings, projects: this.settings.projects.filter(project => project.id !== id) };
    if (this.settings.projects.length === before) return false;
    await this.saveSettings();
    return true;
  }

  async saveOptions(value: unknown): Promise<ConductorSettings> {
    const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    this.settings = settingsFrom({ ...this.settings, ...(typeof record.push === 'boolean' ? { push: record.push } : {}), ...(record.maxProjects !== undefined ? { maxProjects: record.maxProjects } : {}) });
    if (!this.settings.push) this.dropPending();
    await this.saveSettings();
    return this.settings;
  }

  /** Folders of open cards that pass the folder check and are not listed yet («Добавить?»). */
  suggestions(): string[] {
    const listed = new Set(this.settings.projects.map(project => project.path));
    const out: string[] = [];
    for (const folder of this.deps.openFolders()) {
      const checked = checkFolder(folder, { home: this.deps.home, dataDir: this.deps.dataDir, conductorFolder: this.folder });
      if ('path' in checked && !listed.has(checked.path) && !out.includes(checked.path)) out.push(checked.path);
      if (out.length >= 6) break;
    }
    return out;
  }

  // ---- the main agent's card ----

  /** The main agent's card when it is open now. */
  conductorCard(): Card | null {
    if (!this.conductorId) return null;
    const card = this.deps.session(this.conductorId);
    return card && card.status !== 'exited' && (card.exitCode === null || card.exitCode === undefined) ? card : null;
  }

  /** «Запустить» on the widget or the page: opens the existing main agent, or starts one. */
  async start(): Promise<{ started: true; sessionId: string; route: LeadRoute } | { open: string } | { started: false; code: string; detail?: string }> {
    const open = this.conductorCard();
    if (open) return { open: open.id };
    if (this.starting) return { started: false, code: 'busy' };
    const work = (async () => {
      try { this.writeBrief(); } catch (error) { return { started: false as const, code: 'folder', detail: error instanceof Error ? error.message.slice(0, 200) : 'error' }; }
      const answer = await this.deps.startTop({ kind: 'conductor', task: 'Route the person\'s requests to their project folders, follow the projects and compare their results.', cwd: this.folder, title: this.deps.locale() === 'ru' ? 'Главный агент' : 'Main agent' });
      if (!answer.started) return answer;
      this.conductorId = answer.sessionId;
      this.idleSince = null;
      this.saveRuntime();
      this.notify();
      void this.deps.host.callHost('sessions.send', { sessionId: answer.sessionId, text: firstMessage(this.settings.maxProjects, this.settings.projects) }).catch(() => undefined);
      return { started: true as const, sessionId: answer.sessionId, route: answer.route };
    })();
    this.starting = work;
    try { return await work; } finally { this.starting = null; }
  }

  /** The folder and its brief files (rewritten only while they still carry this plugin's mark). */
  private writeBrief(): void {
    mkdirSync(this.folder, { recursive: true });
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const file = join(this.folder, name);
      if (existsSync(file) && !readFileSync(file, 'utf8').startsWith(BRIEF_MARK)) continue;
      writeFileSync(file, briefFile(this.settings.maxProjects));
    }
  }

  // ---- project agents ----

  private project(value: unknown): Project | undefined {
    const wanted = clean(value, 120);
    if (!wanted) return undefined;
    return this.settings.projects.find(project => project.id === wanted) ?? this.settings.projects.find(project => project.name.toLowerCase() === wanted.toLowerCase());
  }

  private latest(projectId: string): Lead | undefined { return [...this.leads].reverse().find(lead => lead.projectId === projectId); }
  private open(lead: Lead | undefined): boolean { return !!lead && !lead.ended; }

  /** What a project agent is doing now, and which card waits for the person (its own or one of its agents'). */
  stateOf(lead: Lead): { state: LeadState; waitingCard: string | null } {
    if (lead.ended) {
      if (lead.stopped) return { state: 'stopped', waitingCard: null };
      if (lead.ended.exitCode === null && lead.ended.status === 'closed' && lead.report?.status !== 'done') return { state: 'stopped', waitingCard: null };
      const ok = lead.ended.exitCode === 0 || lead.ended.status === 'done' || (lead.ended.exitCode === null && lead.ended.status !== 'failed');
      return { state: ok ? lead.report?.status === 'blocked' ? 'blocked' : 'done' : 'failed', waitingCard: null };
    }
    const card = this.deps.session(lead.sessionId);
    if (!card) return { state: this.now() - lead.startedAt < 120_000 ? 'starting' : 'unavailable', waitingCard: null };
    for (const id of this.deps.treeBelow(lead.sessionId)) {
      const below = this.deps.session(id);
      if (below?.status === 'needs_approval') return { state: 'approval', waitingCard: clean(below.title, 60) || id.slice(0, 8) };
    }
    switch (card.status) {
      case 'working': return { state: 'running', waitingCard: null };
      case 'done': return { state: 'done', waitingCard: null };
      case 'failed': return { state: 'failed', waitingCard: null };
      case 'unavailable': return { state: 'unavailable', waitingCard: null };
      default: return { state: lead.report?.status === 'done' ? 'done' : lead.report?.status === 'blocked' ? 'blocked' : 'waiting', waitingCard: null };
    }
  }

  /** Project agents that count against the person's limit: open and not finished. */
  active(): number { return this.leads.filter(lead => !lead.ended && !ENDED.has(this.stateOf(lead).state)).length; }

  line(project: Project, lead: Lead | undefined = this.latest(project.id)): string {
    const locale = this.deps.locale();
    if (!lead) return notStartedLine(locale, project.name);
    const { state, waitingCard } = this.stateOf(lead);
    const { account, quota } = this.deps.accountOf(lead.route);
    const agents = Math.max(0, this.deps.treeBelow(lead.sessionId).size - 1);
    return statusLine(locale, {
      name: project.name, state, minutes: state === 'running' ? (this.now() - lead.startedAt) / 60_000 : null, cli: lead.route.cli, account, model: lead.route.model,
      effort: lead.route.effort, agents, quota, waitingCard, reported: !!lead.report
    });
  }

  // ---- the agent tools ----

  async tool(name: string, caller: Card | undefined, input: Record<string, unknown>): Promise<ToolAnswer> {
    if (name === 'report_to_main') return this.reportToMain(caller, input);
    // Until CanvasTTY scopes tools to a plugin's own cards (C4): only the main agent's card, by its full id.
    if (!caller || !this.isConductor(caller.id)) return { content: 'This tool is only for the main agent.', isError: true };
    // A folder is never taken from the model: projects are named by the id the list gave.
    for (const key of ['path', 'cwd', 'folder', 'directory']) if (key in input) return { content: 'Projects are named by projectId from action "list"; a path is never accepted. The person adds folders on the Assistant page.', isError: true };
    switch (input.action) {
      case 'list': return this.list();
      case 'start': return this.startProject(input);
      case 'status': return this.status(input);
      case 'message': return this.message(input);
      case 'stop': return this.stop(input);
      case 'result': return this.result(input);
      default: return { content: 'Give `action`: list, start, status, message, stop or result.', isError: true };
    }
  }

  private unknown(value: unknown): ToolAnswer {
    const ids = this.settings.projects.map(project => project.id);
    return { content: `No project "${clean(value, 60)}" in the person's list. Listed: ${ids.length ? ids.join(', ') : 'none'}. Tell the person; they add folders on the Assistant page.`, isError: true };
  }

  private list(): ToolAnswer {
    const projects = this.settings.projects.map(project => {
      const lead = this.latest(project.id);
      return { id: project.id, name: project.name, path: project.path, branch: gitBranch(project.path), lead: lead ? { state: this.stateOf(lead).state, startedAt: new Date(lead.startedAt).toISOString(), route: lead.route.label, reported: !!lead.report } : null };
    });
    const lines = projects.length ? this.settings.projects.map(project => this.line(project)) : ['No projects yet: the person adds folders on the Assistant page.'];
    return { content: `${lines.join('\n')}\n${JSON.stringify({ projects, running: this.active(), maxProjects: this.settings.maxProjects })}` };
  }

  private async startProject(input: Record<string, unknown>): Promise<ToolAnswer> {
    const project = this.project(input.projectId);
    if (!project) return this.unknown(input.projectId);
    const task = typeof input.task === 'string' ? input.task.replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/gu, ' ').trim().slice(0, 4_000) : '';
    if (!task) return { content: 'Give the task for that project in `task`.', isError: true };
    const current = this.latest(project.id);
    if (this.open(current)) return { content: `${project.name} has a project agent already (${this.stateOf(current!).state}): send it the task with action "message", or stop it first.`, isError: true };
    if (this.active() + this.reserving >= this.settings.maxProjects) {
      return { content: `${this.settings.maxProjects} projects run now, the person's limit: wait for one to finish, or ask the person to stop one or raise the limit on the Assistant page.`, isError: true };
    }
    // The listed folder is checked again: it may have been removed, replaced or linked elsewhere since it was added.
    const checked = checkFolder(project.path, { home: this.deps.home, dataDir: this.deps.dataDir, conductorFolder: this.folder });
    if (!('path' in checked) || checked.path !== project.path) return { content: `${project.name}'s folder cannot be used now (${'refused' in checked ? checked.refused : 'moved'}): the person checks it on the Assistant page.`, isError: true };
    this.reserving++;
    let answer: TopStart;
    try { answer = await this.deps.startTop({ kind: 'lead', task, cwd: checked.path, title: project.name.slice(0, 80) }); } finally { this.reserving--; }
    if (!answer.started) return { content: `${project.name} was not started (${answer.code}${answer.detail ? `: ${answer.detail}` : ''}).`, isError: true };
    const lead: Lead = { projectId: project.id, sessionId: answer.sessionId, startedAt: this.now(), task: task.slice(0, 1_000), route: answer.route, report: null, stopped: false, ended: null };
    this.leads.push(lead);
    this.saveRuntime();
    this.notify();
    void this.deps.host.callHost('sessions.send', { sessionId: answer.sessionId, text: `${oneLine(task)} — ${LEAD_BRIEF}${answer.planLine ? ` ${answer.planLine}` : ''}`.slice(0, MAX_SEND) }).catch(() => undefined);
    return { content: `Started ${project.name}: ${answer.route.label}.\n${JSON.stringify({ projectId: project.id, leadId: answer.sessionId, route: answer.route.label })}` };
  }

  private status(input: Record<string, unknown>): ToolAnswer {
    if (input.projectId !== undefined && input.projectId !== '') {
      const project = this.project(input.projectId);
      if (!project) return this.unknown(input.projectId);
      return { content: this.line(project) };
    }
    if (!this.settings.projects.length) return { content: 'No projects yet: the person adds folders on the Assistant page.' };
    return { content: this.settings.projects.map(project => this.line(project)).join('\n') };
  }

  private async message(input: Record<string, unknown>): Promise<ToolAnswer> {
    const project = this.project(input.projectId);
    if (!project) return this.unknown(input.projectId);
    const lead = this.latest(project.id);
    if (!lead || !this.open(lead)) return { content: `${project.name} has no project agent running: start one with action "start".`, isError: true };
    const { state, waitingCard } = this.stateOf(lead);
    if (state === 'approval') return { content: `${project.name} waits for the person's decision${waitingCard ? ` on the card "${waitingCard}"` : ''}: the person decides there, not you.`, isError: true };
    const text = typeof input.text === 'string' ? oneLine(input.text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/gu, ' ')).trim().slice(0, MAX_SEND - 40) : '';
    if (!text) return { content: 'Give the message in `text`.', isError: true };
    try {
      const sent = await withinMs(this.deps.host.callHost('sessions.send', { sessionId: lead.sessionId, text: `From the main agent: ${text}` }), SEND_WAIT_MS);
      return { content: sent === null ? `Typed into ${project.name}'s card; it was still starting, so it may arrive a little later.` : `Sent to ${project.name}.` };
    } catch (error) {
      return { content: `CanvasTTY did not send it: ${error instanceof Error ? error.message.slice(0, 160) : 'error'}.`, isError: true };
    }
  }

  private async stop(input: Record<string, unknown>): Promise<ToolAnswer> {
    const project = this.project(input.projectId);
    if (!project) return this.unknown(input.projectId);
    const lead = this.latest(project.id);
    if (!lead || !this.open(lead)) return { content: `${project.name} has no project agent running.` };
    try { await this.deps.host.callHost('sessions.stop', { sessionId: lead.sessionId }); } catch (error) {
      return { content: `CanvasTTY did not stop it: ${error instanceof Error ? error.message.slice(0, 160) : 'error'}.`, isError: true };
    }
    lead.stopped = true;
    lead.ended = { at: this.now(), exitCode: null, status: 'stopped' };
    this.saveRuntime();
    this.notify();
    return { content: `Stopped ${project.name} (its agents are closed with it).` };
  }

  private result(input: Record<string, unknown>): ToolAnswer {
    const project = this.project(input.projectId);
    if (!project) return this.unknown(input.projectId);
    const lead = this.latest(project.id);
    if (!lead) return { content: `${project.name} has not been started.` };
    const { state } = this.stateOf(lead);
    const meta = { projectId: project.id, state, exitCode: lead.ended?.exitCode ?? this.deps.session(lead.sessionId)?.exitCode ?? null, agents: Math.max(0, this.deps.treeBelow(lead.sessionId).size - 1), untrusted: !!lead.report };
    if (!lead.report) return { content: `${this.line(project, lead)}\nNo report filed yet (the project agent sends one with report_to_main).\n${JSON.stringify(meta)}` };
    return { content: `${quoteReport(project.name, lead.report)}\n${JSON.stringify({ ...meta, reportStatus: lead.report.status, reportAt: new Date(lead.report.at).toISOString() })}` };
  }

  /** A project agent's result: kept (untrusted) and announced to the main agent by a status line. */
  private reportToMain(caller: Card | undefined, input: Record<string, unknown>): ToolAnswer {
    const lead = caller ? this.leadBySession(caller.id) : undefined;
    if (!caller || !lead || lead.ended) return { content: 'This tool is only for project agents the main agent started.', isError: true };
    const status = input.status === 'done' || input.status === 'blocked' || input.status === 'progress' ? input.status : null;
    if (!status) return { content: 'Give `status`: done, blocked or progress.', isError: true };
    const summary = reportText(input.summary);
    if (!summary) return { content: 'Give a short plain `summary` (at most 4000 characters).', isError: true };
    lead.report = { status, summary, at: this.now() };
    this.saveRuntime();
    this.queue(lead);
    this.notify();
    return { content: 'Sent to the main agent.' };
  }

  // ---- session events ----

  sessionsKnown(ids: ReadonlySet<string>): void {
    if (this.conductorId && !ids.has(this.conductorId)) this.conductorId = null;
    for (const lead of this.leads) if (!lead.ended && !ids.has(lead.sessionId)) lead.ended = { at: this.now(), exitCode: null, status: 'closed' };
    const conductor = this.conductorCard();
    this.idleSince = conductor?.status === 'idle' ? this.now() : null;
    this.saveRuntime();
  }

  sessionEvent(type: unknown, session: Card): void {
    if (this.isConductor(session.id)) {
      if (type === 'closed' || type === 'exited' || session.status === 'exited') {
        this.conductorId = null; this.idleSince = null; this.cancelTimers(); this.saveRuntime(); this.notify();
        return;
      }
      if (session.status === 'idle') {
        if (this.idleSince === null) this.idleSince = this.now();
        if (this.pending.size) this.waitQuiet();
      } else { this.idleSince = null; this.quietTimer?.cancel(); this.quietTimer = null; }
      return;
    }
    const lead = this.leadOf(session);
    if (!lead) return;
    if (lead.sessionId === session.id && (type === 'closed' || type === 'exited' || (typeof session.exitCode === 'number'))) {
      if (!lead.ended) {
        lead.ended = { at: this.now(), exitCode: typeof session.exitCode === 'number' ? session.exitCode : null, status: String(session.status ?? type).slice(0, 20) };
        this.saveRuntime();
      }
    }
    // A new state worth telling the main agent: needs the person, done, failed, ended (not a stop it asked for).
    const { state } = this.stateOf(lead);
    if (state === 'approval' || state === 'done' || state === 'failed' || state === 'blocked') { if (this.pushed.get(lead.sessionId) !== state) this.queue(lead); }
    // Back at work: the next "waits for you" or "done" is news again.
    else this.pushed.delete(lead.sessionId);
    this.notify();
  }

  /** The project agent a card belongs to: the agent itself, or the top of its chain of parents (bounded). */
  private leadOf(session: Card): Lead | undefined {
    let id: string | undefined = session.id;
    let parent: string | undefined = session.parentSessionId;
    for (let depth = 0; id && depth < 16; depth++) {
      const lead = this.leadBySession(id);
      if (lead) return lead;
      id = parent;
      parent = id ? this.deps.session(id)?.parentSessionId : undefined;
    }
    return undefined;
  }

  // ---- pushing status lines into the main agent (only while it is idle and quiet; batched; behind a switch) ----

  private queue(lead: Lead): void {
    if (!this.settings.push || !this.conductorId) return;
    this.pending.add(lead.sessionId);
    this.batchTimer ??= this.schedule(() => { this.batchTimer = null; this.tryFlush(); }, BATCH_MS);
  }

  private waitQuiet(): void {
    if (this.quietTimer || this.idleSince === null) return;
    const left = Math.max(0, QUIET_MS - (this.now() - this.idleSince));
    this.quietTimer = this.schedule(() => { this.quietTimer = null; this.tryFlush(); }, left);
  }

  /** Types the waiting lines in when the main agent is idle and has been quiet long enough; else waits for that. */
  tryFlush(): void {
    if (!this.pending.size || this.batchTimer || this.sending) return;
    if (!this.settings.push) { this.dropPending(); return; }
    const conductor = this.conductorCard();
    if (!conductor) { this.dropPending(); return; }
    if (conductor.status !== 'idle' || this.idleSince === null) return;
    if (this.now() - this.idleSince < QUIET_MS) { this.waitQuiet(); return; }
    const lines: string[] = [];
    for (const sessionId of this.pending) {
      const lead = this.leadBySession(sessionId);
      const project = lead ? this.settings.projects.find(entry => entry.id === lead.projectId) ?? { id: lead.projectId, name: lead.projectId, path: '', addedAt: 0 } : null;
      if (!lead || !project) continue;
      const state = this.stateOf(lead).state;
      this.pushed.set(sessionId, state);
      lines.push(this.line(project, lead));
    }
    this.pending.clear();
    if (!lines.length) return;
    const text = `${STATUS_PREFIX} ${lines.join(' ')}`.slice(0, MAX_SEND);
    this.sending = true;
    this.sent.push(text);
    // The card goes busy with it: the next lines wait for the next quiet idle stretch.
    this.idleSince = null;
    void this.deps.host.callHost('sessions.send', { sessionId: conductor.id, text }).catch(() => undefined).finally(() => { this.sending = false; });
  }

  /** Tells the page and the widget (at most once a second). */
  private notifyTimer: { cancel(): void } | null = null;
  private notify(): void {
    this.notifyTimer ??= this.schedule(() => { this.notifyTimer = null; this.deps.host.emit('conductor', null); }, 1_000);
  }

  private dropPending(): void { this.pending.clear(); this.cancelTimers(); }
  private cancelTimers(): void { this.batchTimer?.cancel(); this.batchTimer = null; this.quietTimer?.cancel(); this.quietTimer = null; }

  // ---- the page and the HOME widget ----

  view(): { conductor: { id: string; status: string | null } | null; lines: Array<{ projectId: string; name: string; text: string; state: LeadState | 'none'; sessionId: string | null; focus: string | null }>; running: number } {
    const card = this.conductorCard();
    const lines = this.settings.projects.map(project => {
      const lead = this.latest(project.id);
      if (!lead) return { projectId: project.id, name: project.name, text: this.line(project), state: 'none' as const, sessionId: null, focus: null };
      const { state } = this.stateOf(lead);
      // A click shows the card that waits for the person, else the project agent (when it is open).
      let focus: string | null = lead.ended ? null : lead.sessionId;
      if (state === 'approval') for (const id of this.deps.treeBelow(lead.sessionId)) if (this.deps.session(id)?.status === 'needs_approval') { focus = id; break; }
      return { projectId: project.id, name: project.name, text: this.line(project, lead), state, sessionId: lead.ended ? null : lead.sessionId, focus };
    });
    return { conductor: card ? { id: card.id, status: card.status ?? null } : null, lines, running: this.active() };
  }
}

function leadFrom(value: unknown): Lead | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const route = entry.route as Record<string, unknown> | undefined;
  if (typeof entry.projectId !== 'string' || typeof entry.sessionId !== 'string' || !route || typeof route.cli !== 'string') return null;
  const str = (v: unknown, max: number): string | null => typeof v === 'string' ? v.slice(0, max) : null;
  const report = entry.report as Record<string, unknown> | null | undefined;
  const ended = entry.ended as Record<string, unknown> | null | undefined;
  return {
    projectId: entry.projectId.slice(0, 48), sessionId: entry.sessionId.slice(0, 80), startedAt: typeof entry.startedAt === 'number' ? entry.startedAt : 0, task: str(entry.task, 1_000) ?? '',
    route: { cli: route.cli.slice(0, 40), kind: str(route.kind, 20) ?? 'cli-default', label: str(route.label, 160) ?? route.cli, model: str(route.model, 120), effort: str(route.effort, 20), signIn: str(route.signIn, 120) ?? `cli:${route.cli}`, accountId: str(route.accountId, 120) },
    report: report && (report.status === 'done' || report.status === 'blocked' || report.status === 'progress') && typeof report.summary === 'string' ? { status: report.status, summary: reportText(report.summary), at: typeof report.at === 'number' ? report.at : 0 } : null,
    stopped: entry.stopped === true,
    ended: ended && typeof ended === 'object' ? { at: typeof ended.at === 'number' ? ended.at : 0, exitCode: typeof ended.exitCode === 'number' ? ended.exitCode : null, status: str(ended.status, 20) ?? 'closed' } : null
  };
}

/** The work's answer within `ms`, else null (the work goes on). */
function withinMs<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
