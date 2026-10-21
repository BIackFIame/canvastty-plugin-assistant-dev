/**
 * Route v2 inside the Assistant service: the `route` / `pick_route` and `route_outcome` tools, the "Where agents
 * run" settings (storage key `routing`), the limit windows the settings page forwards, decision records, and the
 * routed children it sees in session events (for "at most N at once" and coding-plan counts).
 *
 * Nothing is started here: the orchestrator passes the answer's spawn values to CanvasTTY's own `spawn_agent`, and
 * CanvasTTY checks every value. A recommendation never grants anything.
 */
import type { TreeRoute } from '../tree/agentTree.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Host } from '../rpc.ts';
import type { RoutingCatalog } from '../auto/catalog/catalog.ts';
import type { BenchmarkIndex } from '../auto/catalog/scoring.ts';
import { turnView, type TurnDecision, type TurnView } from '../auto/select.ts';
import type { AutoPreference } from '../auto/settings.ts';
import { ruleDifficulty } from '../harness/router.ts';
import type { DataClass, DataClassMode } from '../shared/settings.ts';
import { ALIAS_TABLE_AS_OF, BUNDLED_ALIASES, resolveModel } from './aliases.ts';
import { decide, estimateText, modelText, TASK_TOKENS, whyLine, type AccountRow, type AutoExpectation, type Candidate, type ProviderInfo, type RouteDecision } from './engine.ts';
import { earlyNote, limitChanges, mergeLimits, parseLimits, quotaOf, resetFromText, STALE_MS, type EarlyResetDetail, type LimitChange, type LimitsCache, type LimitsSource } from './limits.ts';
import { classifyOutcome, RouteRecords, type OptionRecord, type OutcomeResult, type RouteRecord } from './records.ts';
import { normalizeRouteSettings, validateRouteSettings, type RouteSettings } from './settings.ts';
import type { Spawn } from './engine.ts';

export const ROUTE_STORAGE_KEY = 'routing';
export const ROUTE_TOOLS = ['route', 'pick_route', 'route_outcome'] as const;
const CLASSIFY_DEADLINE_MS = 8_000;
/** A subagent of the routed CLI that appears this soon after the answer is taken as started from it. */
const MATCH_MS = 3 * 60_000;
const QUOTA_COOLDOWN_MS = 300_000;
const MAX_COOLDOWN_MS = 24 * 3_600_000;
const WRITE_DELAY_MS = 150;
/** Quota events kept for the page (memory and the limits file). */
const MAX_QUOTA_EVENTS = 20;
/** A read with at least this much left in every window ends a limit rest before its time. */
const RECOVERED_PERCENT = 20;

export interface QuotaEvent { at: number; provider: string; kind: LimitChange['kind'] | 'limit-exit'; note: string; early?: EarlyResetDetail[] }
/** How long an orchestrator's full provider and account lists are kept for later compact calls. */
const KEEP_MS = 30 * 60_000;

/** A digest an orchestrator can send instead of its lists: available CLIs with their sign-in, @ ready accounts. */
function digestOf(providers: { list: ProviderInfo[] }, rows: AccountRow[]): string {
  const clis = providers.list.filter(entry => entry.available !== false && entry.installed !== false).map(entry => `${entry.id}${entry.signIn && entry.signIn !== 'unknown' ? `:${entry.signIn}` : ''}`);
  const accounts = rows.filter(row => row.state === 'ready').map(row => `@${row.accountId}`);
  return [...new Set([...clis, ...accounts])].join(' ').slice(0, 300);
}

const trimSlash = (path: string): string => path.length > 1 ? path.replace(/[\\/]+$/u, '') : path;

/** "claude:ok codex:signed_out opencode @glm-53": CLIs (with an optional sign-in) and ready account ids. */
export function parseDigest(value: unknown): { clis: Array<{ id: string; signIn: string | null }>; accounts: string[] } | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const clis: Array<{ id: string; signIn: string | null }> = [];
  const accounts: string[] = [];
  for (const token of value.slice(0, 2_000).split(/[\s,;]+/u).filter(Boolean).slice(0, 64)) {
    const account = /^@([A-Za-z0-9._-]{1,64})$/u.exec(token);
    if (account) { accounts.push(account[1]!); continue; }
    const cli = /^([a-z0-9-]{1,40})(?::(ok|signed_out|expired|unknown))?$/u.exec(token);
    if (cli && !clis.some(entry => entry.id === cli[1])) clis.push({ id: cli[1]!, signIn: cli[2] ?? null });
  }
  return clis.length || accounts.length ? { clis, accounts } : null;
}

export interface CallerCard { id: string; provider: string; role: string; parentSessionId?: string; title?: string; status?: string; cwd?: string; workingDirectory?: string }

export interface RouteServiceOptions {
  host: Host;
  dataDir: string;
  saved?: unknown;
  savedUnavailable?: boolean;
  /** The harness's routing switch. */
  enabled(): boolean;
  /** Jev's view of a task (task.route under the card's data class), or null: word rules decide. */
  classify?(task: string, caller: CallerCard, deadlineMs: number): Promise<TurnDecision | null>;
  catalog(): { catalog: RoutingCatalog; index: BenchmarkIndex };
  preference(): AutoPreference;
  autoExpectation?(view: TurnView, cardClass: DataClass): Promise<AutoExpectation | null>;
  cardClass(sessionId: string): DataClass;
  /**
   * A routed child appeared: the task its orchestrator gave `route` for it, as the orchestrator's text (never the
   * person's), for that card's command review. Memory only.
   */
  delegatedTask?(childId: string, text: string, parentId: string): void;
  dataClassMode(): DataClassMode;
  /**
   * Auto (Jev) autopilot: for a caller in an Auto tree, the spawn values with the Assistant's bound decision value
   * (autopilot/binding.ts); null leaves the spawn as it is.
   */
  bindSpawn?(callerId: string, spawn: Spawn, decisionId: string, orchestrate: boolean): Spawn | null;
  now?: () => number;
  random?: () => number;
}

type ToolAnswer = { content: unknown; isError?: boolean };

const clean = (value: unknown, max: number): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, max) : '';
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown, max: number, length = 200): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= length).slice(0, max) : [];

/** list_providers entries as the orchestrator passed them, rebuilt with only well-typed fields. */
export function providersFrom(input: unknown): { list: ProviderInfo[]; given: boolean } {
  const raw = Array.isArray(input) ? input : isRecord(input) && Array.isArray(input.providers) ? input.providers : null;
  if (!raw) return { list: [], given: false };
  const list: ProviderInfo[] = [];
  for (const candidate of raw.slice(0, 16)) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || !/^[a-z0-9-]{1,40}$/u.test(candidate.id)) continue;
    const model = isRecord(candidate.model) ? candidate.model : null;
    const plugins = Array.isArray(candidate.launchOptions)
      ? candidate.launchOptions.filter(isRecord).map(entry => entry.pluginId).filter((id): id is string => typeof id === 'string' && id.length <= 80).slice(0, 16)
      : undefined;
    list.push({
      id: candidate.id,
      ...(typeof candidate.installed === 'boolean' || candidate.installed === null ? { installed: candidate.installed as boolean | null } : {}),
      ...(typeof candidate.available === 'boolean' ? { available: candidate.available } : {}),
      ...(typeof candidate.signIn === 'string' ? { signIn: candidate.signIn.slice(0, 20) } : {}),
      ...(typeof candidate.signInCheckedAt === 'number' && Number.isFinite(candidate.signInCheckedAt) ? { signInCheckedAt: candidate.signInCheckedAt } : {}),
      ...(typeof candidate.subagent === 'boolean' ? { subagent: candidate.subagent } : {}),
      ...(typeof candidate.orchestrator === 'boolean' ? { orchestrator: candidate.orchestrator } : {}),
      ...(model ? { model: { ...(typeof model.supported === 'boolean' ? { supported: model.supported } : {}), known: strings(model.known, 400) } } : {}),
      efforts: strings(candidate.efforts, 8, 20),
      ...(plugins ? { launchPlugins: plugins } : {})
    });
  }
  return { list, given: raw.length > 0 && list.length > 0 };
}

/** `canvastty-accounts__list_routes` rows (its `routes` array or the rows themselves), only the fields routing keeps. */
export function accountRowsFrom(input: unknown): AccountRow[] {
  const raw = Array.isArray(input) ? input : isRecord(input) && Array.isArray(input.routes) ? input.routes : [];
  const rows: AccountRow[] = [];
  for (const candidate of raw.slice(0, 48)) {
    if (!isRecord(candidate)) continue;
    const { provider, accountId, model, endpoint, state } = candidate;
    if (typeof provider !== 'string' || !/^[a-z0-9-]{1,40}$/u.test(provider) || typeof accountId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/u.test(accountId)) continue;
    if (typeof model !== 'string' || !model || model.length > 200 || typeof endpoint !== 'string' || !/^[A-Za-z0-9.:[\]-]{1,120}$/u.test(endpoint) || typeof state !== 'string' || state.length > 40) continue;
    const options = isRecord(candidate.launchOptions) && isRecord(candidate.launchOptions['canvastty-accounts']) ? candidate.launchOptions['canvastty-accounts'] as Record<string, unknown> : null;
    // Only the Accounts plugin's own fields, and only for this row's account: nothing else reaches spawn_agent from here.
    const launch = options && options.account === accountId
      ? { 'canvastty-accounts': { account: accountId, effort: typeof options.effort === 'string' && /^[a-z]{1,12}$/u.test(options.effort) ? options.effort : 'default', trustFolder: false } }
      : undefined;
    const quota = accountQuotaFrom(candidate.quota);
    rows.push({
      provider, accountId, model, endpoint, state,
      ...(quota ? { quota } : {}),
      ...(typeof candidate.account === 'string' ? { account: clean(candidate.account, 60) } : {}),
      ...(typeof candidate.reason === 'string' ? { reason: clean(candidate.reason, 160) } : {}),
      ...(launch ? { launchOptions: launch } : {})
    });
  }
  return rows;
}

/** Accounts' per-route `quota` (canvastty-accounts ≥ the quota reader), only well-typed fields. */
export function accountQuotaFrom(value: unknown): AccountRow['quota'] | undefined {
  if (!isRecord(value)) return undefined;
  const states = ['ok', 'low', 'exhausted', 'presumed-reset', 'unknown', 'stale'] as const;
  const state = states.find(entry => entry === value.state);
  if (!state) return undefined;
  const time = (raw: unknown): number | null => typeof raw === 'string' && raw.length <= 40 && Number.isFinite(Date.parse(raw)) ? Date.parse(raw) : null;
  const percent = typeof value.remainingPercent === 'number' && Number.isFinite(value.remainingPercent) ? Math.max(0, Math.min(100, value.remainingPercent)) : null;
  return {
    state, remainingPercent: percent, resetsAt: time(value.resetsAt), observedAt: time(value.observedAt),
    source: clean(value.source, 40) || null, confidence: value.confidence === 'exact' || value.confidence === 'estimated' ? value.confidence : 'none',
    note: clean(value.note, 160)
  };
}

const optionRecord = (c: Candidate, decision: RouteDecision, now: number): OptionRecord => ({
  key: c.key, cli: c.cli, kind: c.kind, signIn: c.signIn, label: c.label, model: c.model, identity: c.identity, effort: c.effort,
  score: c.score ? Math.round(c.score.value * 10) / 10 : null, scoreSource: c.score?.source ?? null,
  cost: c.cost, costBasis: c.costBasis, estimate: estimateText(c.estimate), estimateData: c.estimate, scoreLabel: c.score?.label ?? null,
  below: decision.best !== null && c.score ? Math.max(0, Math.round((decision.best - c.score.value) * 10) / 10) : null,
  why: whyLine(c, decision, now).slice(0, 600)
});

export class RouteService {
  settings: RouteSettings;
  readable: boolean;
  readonly records: RouteRecords;
  limits: LimitsCache | null = null;
  /** The last list_routes rows an orchestrator passed (for the page), without keys or paths. */
  accountsSeen: { at: number; rows: AccountRow[] } | null = null;
  private readonly options: RouteServiceOptions;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly cooldowns = new Map<string, { until: number; reason: string; at?: number }>();
  /** Exhaustions, resets (early ones too) and recoveries seen in reads and outcomes (for the page and the log). */
  readonly quotaEvents: QuotaEvent[] = [];
  private limitsTimer: ReturnType<typeof setTimeout> | null = null;
  /** Routed children running now, by sign-in key; and each child's sign-in. */
  private readonly live = new Map<string, Set<string>>();
  private readonly childSignIn = new Map<string, string>();
  private readonly seen = new Set<string>();
  /** Each orchestrator's last full list_providers and list_routes (memory only, KEEP_MS). */
  /** The task text of each recent decision until its child appears (memory only, never in the decision file). */
  private readonly tasks = new Map<string, { text: string; cwd: string | null; at: number }>();
  private readonly kept = new Map<string, { at: number; providers: ProviderInfo[] | null; rows: AccountRow[] | null }>();
  private readonly dir: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: RouteRecord[] | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(options: RouteServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.readable = options.savedUnavailable !== true;
    this.settings = normalizeRouteSettings(this.readable ? options.saved : null);
    this.dir = join(options.dataDir, 'route');
    let saved: unknown = null;
    try { saved = JSON.parse(readFileSync(join(this.dir, 'decisions.json'), 'utf8')); } catch { saved = null; }
    this.records = new RouteRecords(saved, list => this.write(list));
    // The last limit windows, with their read times: after a restart they are as old as they are (STALE_MS applies).
    try {
      const kept = JSON.parse(readFileSync(join(this.dir, 'limits.json'), 'utf8')) as { receivedAt?: unknown; snapshot?: unknown; events?: unknown };
      const parsed = typeof kept.receivedAt === 'number' ? parseLimits(kept.snapshot, kept.receivedAt) : null;
      if (parsed) this.limits = { ...parsed, source: 'saved' };
      if (Array.isArray(kept.events)) for (const event of kept.events.slice(-MAX_QUOTA_EVENTS)) {
        if (isRecord(event) && typeof event.at === 'number' && typeof event.provider === 'string' && typeof event.kind === 'string' && typeof event.note === 'string'
          && ['early-reset', 'reset', 'exhausted', 'recovered', 'limit-exit'].includes(event.kind)) this.quotaEvents.push({ at: event.at, provider: clean(event.provider, 40), kind: event.kind as QuotaEvent['kind'], note: clean(event.note, 400) });
      }
    } catch { /* nothing kept */ }
  }

  loaded(saved: unknown): void { this.settings = normalizeRouteSettings(saved); this.readable = true; }

  handles(name: string): boolean { return (ROUTE_TOOLS as readonly string[]).includes(name); }

  // -------------------------------------------------------------------------------------------------------------
  // Session events: which routed children run where
  // -------------------------------------------------------------------------------------------------------------

  sessionEvent(event: { type?: unknown; session?: unknown }): void {
    const session = event.session as CallerCard & { exitCode?: number | null } | undefined;
    if (!session || typeof session.id !== 'string') return;
    const ended = event.type === 'closed' || event.type === 'exited' || session.status === 'exited' || (typeof session.exitCode === 'number');
    if (ended) { this.childEnded(session.id); if (event.type === 'closed') { this.seen.delete(session.id); this.kept.delete(session.id); } return; }
    if (this.seen.has(session.id) || session.role !== 'subagent' || typeof session.parentSessionId !== 'string') { this.seen.add(session.id); return; }
    this.seen.add(session.id);
    while (this.seen.size > 4_096) this.seen.delete(this.seen.values().next().value!);
    const where = [session.cwd, session.workingDirectory].filter((path): path is string => typeof path === 'string').map(trimSlash);
    // A decision for which the orchestrator said where the child works matches only a child there.
    const match = this.records.unmatched(session.parentSessionId, session.provider, this.now(), MATCH_MS, record => {
      const cwd = this.tasks.get(record.id)?.cwd;
      return !cwd || !where.length || where.includes(cwd);
    });
    if (!match) return;
    const task = this.tasks.get(match.record.id);
    this.tasks.delete(match.record.id);
    if (task) this.options.delegatedTask?.(session.id, task.text, session.parentSessionId);
    match.record.spawned = { session: session.id.slice(0, 8), option: match.option, at: this.now() };
    const signIn = match.record.options[match.option]!.signIn;
    this.childSignIn.set(session.id, signIn);
    this.live.set(signIn, new Set([...this.live.get(signIn) ?? [], session.id]));
    this.records.changed();
  }

  private childEnded(sessionId: string): void {
    const signIn = this.childSignIn.get(sessionId);
    if (!signIn) return;
    this.childSignIn.delete(sessionId);
    this.live.get(signIn)?.delete(sessionId);
    const record = this.records.bySession(sessionId);
    if (record?.spawned && !record.spawned.endedAt) { record.spawned.endedAt = this.now(); this.records.changed(); }
  }

  busy(signIn: string): number { return this.live.get(signIn)?.size ?? 0; }

  /** When a route was last decided (for the limits feed: read more often while routing is used). */
  lastRouteAt(): number | null { return this.records.all().at(-1)?.at ?? null; }

  /** Routed launches on `cli`'s own sign-in (subscription or default) since its limit windows were read. */
  launchesSinceRead(cli: string): number {
    const read = this.limits?.providers.find(entry => entry.provider === cli)?.fetchedAt;
    if (!read) return 0;
    return this.records.all().filter(record => {
      const option = record.spawned ? record.options[record.spawned.option] : undefined;
      return !!option && record.spawned!.at >= read && option.cli === cli && (option.kind === 'subscription' || option.kind === 'cli-default');
    }).length;
  }

  /** The route a subagent was started on (model, plan or price, estimate), for the agent tree; null if not routed. */
  routeOf(sessionId: string): TreeRoute | null {
    const record = this.records.bySession(sessionId);
    const option = record?.spawned ? record.options[record.spawned.option] : undefined;
    if (!record || !option || record.spawned!.session !== sessionId.slice(0, 8)) return null;
    return { model: option.model, kind: option.kind, label: option.label, costBasis: option.costBasis, estimate: option.estimateData ?? null };
  }

  private launches(planId: string, windowMs: number): number {
    const since = this.now() - windowMs;
    return this.records.all().filter(record => record.spawned && record.spawned.at >= since && record.options[record.spawned.option]?.signIn === `plan:${planId}`).length;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------------------------------------------

  async tool(name: string, caller: CallerCard, input: Record<string, unknown>): Promise<ToolAnswer> {
    if (name === 'route_outcome') return this.outcome(caller, input);
    return this.route(caller, input, name);
  }

  /** The decision for a task, without recording it (tests and the offline replay use it too). */
  async decideFor(caller: CallerCard, input: Record<string, unknown>): Promise<{ decision: RouteDecision; view: TurnView; source: 'jev' | 'rules'; providers: { list: ProviderInfo[]; given: boolean }; accountRows: AccountRow[] } | { error: string }> {
    const task = clean(input.task, 4_000);
    if (!task) return { error: 'Give the subagent\'s task in `task`.' };
    let decision: TurnDecision | null = null;
    try { decision = await this.options.classify?.(task.slice(0, 2_000), caller, CLASSIFY_DEADLINE_MS) ?? null; } catch { decision = null; }
    const source = decision ? 'jev' : 'rules';
    // The task is a subagent's: the caller being an orchestrator does not make it medium.
    const view = turnView(decision ?? { difficulty: ruleDifficulty(task), strong: false }, source, task, { role: 'subagent' });
    const { providers, accountRows } = this.inputsFor(caller.id, input);
    this.accountQuotaSeen(accountRows);
    if (accountRows.length) this.accountsSeen = { at: this.now(), rows: accountRows.map(({ launchOptions: _drop, ...row }) => row) };
    const cardClass = this.options.cardClass(caller.id);
    const { catalog, index } = this.options.catalog();
    let auto: AutoExpectation | null = null;
    try { auto = await this.options.autoExpectation?.(view, cardClass) ?? null; } catch { auto = null; }
    const now = this.now();
    const stats = this.records.routeStats();
    const retired = new Set(this.records.exploration().filter(entry => entry.verdict === 'retire').map(entry => entry.identity));
    const result = decide({
      view, preference: this.options.preference(), settings: this.settings, providers: providers.list, providersGiven: providers.given, accountRows,
      callerProvider: typeof caller.provider === 'string' ? caller.provider : null, cardClass, mode: this.options.dataClassMode(), limits: this.limits,
      catalog, index, auto, now, busy: key => this.busy(key), launches: (id, ms) => this.launches(id, ms),
      cooldown: key => { const c = this.cooldowns.get(key); return c && c.until > now ? c : null; }, stats, launchesSinceRead: cli => this.launchesSinceRead(cli),
      tokenFactor: identity => this.records.tokenFactor(identity, level => TASK_TOKENS[level].input + TASK_TOKENS[level].output),
      prefer: clean(input.prefer, 200) || null, orchestrate: input.orchestrate === true,
      explore: { roll: this.random(), retired, highRisk: ruleDifficulty(task) === 'hard' }
    });
    return { decision: result, view, source, providers, accountRows };
  }

  /**
   * Auto (Jev) on a card's own sign-in (autopilot D2): the model and effort for `cli` on its declared subscription,
   * by the same engine as `route`, among that CLI's own sign-in routes only (never a paid route). A declared plan
   * with no room left gives `exhausted` with the reason; no declared plan gives the CLI's own default model.
   */
  topLevelChoice(cli: string, view: TurnView, cardClass: DataClass, orchestrate: boolean): { model: string | null; effort: string | null; why: string; label?: string } | { exhausted: string } {
    const { catalog, index } = this.options.catalog();
    const now = this.now();
    const result = decide({
      view, preference: this.options.preference(), settings: this.settings,
      providers: [{ id: cli, installed: true, available: true, subagent: true, orchestrator: true }], providersGiven: true, accountRows: [],
      callerProvider: cli, cardClass, mode: this.options.dataClassMode(), limits: this.limits, catalog, index, auto: null, now,
      busy: () => 0, launches: (id, ms) => this.launches(id, ms), cooldown: key => { const c = this.cooldowns.get(key); return c && c.until > now ? c : null; },
      launchesSinceRead: id => this.launchesSinceRead(id), stats: this.records.routeStats(), prefer: cli, orchestrate, explore: { roll: 1, retired: new Set(), highRisk: false }
    });
    const own = [result.top, ...result.groups.flat()].filter((c): c is NonNullable<typeof c> => !!c && c.cli === cli && (c.kind === 'subscription' || c.kind === 'cli-default'));
    const best = own.find(c => c.kind === 'subscription') ?? own[0];
    if (!best || best.kind === 'cli-default' && this.settings.plans.some(plan => plan.cli === cli)) {
      const why = result.dropped.find(entry => entry.cli === cli && /exhausted|reserve|cooldown|limit|busy/iu.test(entry.reason))?.reason;
      if (why) return { exhausted: why };
    }
    if (!best) return { model: null, effort: null, why: 'no declared plan: the CLI\'s own default model' };
    return { model: best.spawn.model ?? null, effort: best.spawn.effort ?? null, ...(best.kind === 'subscription' ? { label: best.label } : {}), why: best.kind === 'subscription' ? `${best.label}: ${best.model ?? 'default'}${best.effort ? `@${best.effort}` : ''}` : 'the CLI\'s own default model' };
  }

  /**
   * "Start with Auto (Jev)" (core B8): where a top-level orchestrator runs. The same engine as `route`, for a task
   * that must orchestrate, among the routes the person declared (subscriptions and coding plans, by their CLI) and the
   * model accounts an orchestrator's list_routes showed in the last day (Accounts' state as it was then; Accounts
   * still checks the account at launch). `clis`: only these CLIs; `ownSignIn`: only a CLI's own sign-in (a server
   * gets nothing from this computer). Best first, never an OpenRouter route (the engine drops those).
   */
  orchestratorRoutes(view: TurnView, cardClass: DataClass, limit: { clis?: readonly string[]; ownSignIn?: boolean } = {}): { candidates: Candidate[]; dropped: string[] } {
    const now = this.now();
    const allowed = (cli: string): boolean => !limit.clis || limit.clis.includes(cli);
    const rows: AccountRow[] = limit.ownSignIn || !this.accountsSeen || now - this.accountsSeen.at > 24 * 3_600_000 ? []
      : this.accountsSeen.rows.filter(row => allowed(row.provider)).map(row => ({ ...row, launchOptions: { 'canvastty-accounts': { account: row.accountId, effort: 'default', trustFolder: false } } }));
    const clis = [...new Set([...this.settings.plans.filter(plan => plan.allow !== 'never').map(plan => plan.cli), ...rows.map(row => row.provider), ...(limit.clis ?? [])])].filter(allowed);
    if (!clis.length) return { candidates: [], dropped: [] };
    const { catalog, index } = this.options.catalog();
    const decision = decide({
      view, preference: this.options.preference(), settings: this.settings,
      providers: clis.map(id => ({ id, installed: true, available: true, subagent: true, orchestrator: true })), providersGiven: true, accountRows: rows,
      callerProvider: null, cardClass, mode: this.options.dataClassMode(), limits: this.limits, catalog, index, auto: null, now,
      busy: key => this.busy(key), launches: (id, ms) => this.launches(id, ms), cooldown: key => { const c = this.cooldowns.get(key); return c && c.until > now ? c : null; },
      launchesSinceRead: id => this.launchesSinceRead(id), stats: this.records.routeStats(), prefer: null, orchestrate: true,
      explore: { roll: 1, retired: new Set(), highRisk: true }
    });
    const seen = new Set<string>();
    const candidates = [decision.top, ...decision.alternatives, ...decision.groups.flat()]
      .filter((c): c is Candidate => !!c && !seen.has(c.key) && !!seen.add(c.key))
      .filter(c => !limit.ownSignIn || c.kind === 'subscription' || c.kind === 'cli-default');
    const dropped = [...new Set(decision.dropped.map(entry => `${entry.cli}${entry.model ? ` ${entry.model}` : ''}: ${entry.reason}`))].slice(0, 4);
    return { candidates, dropped };
  }

  /**
   * What the orchestrator passed, or what it passed earlier: the full list_providers and list_routes are large, so a
   * card's last full lists are kept (memory, 30 min) and a later call may send only the task, or a `digest` such as
   * "claude:ok codex:signed_out opencode @glm-53" (CLIs with their sign-in, `@` a ready account id from list_routes).
   */
  private inputsFor(callerId: string, input: Record<string, unknown>): { providers: { list: ProviderInfo[]; given: boolean }; accountRows: AccountRow[] } {
    const now = this.now();
    for (const [id, kept] of this.kept) if (now - kept.at > KEEP_MS) this.kept.delete(id);
    const full = providersFrom(input.providers);
    const rows = accountRowsFrom(input.accountRoutes);
    const kept = this.kept.get(callerId) ?? { at: now, providers: null, rows: null };
    if (full.given) kept.providers = full.list;
    if (Array.isArray(input.accountRoutes) && rows.length) kept.rows = rows;
    if (full.given || rows.length) { kept.at = now; this.kept.set(callerId, kept); }
    let providers = full.given ? full : kept.providers ? { list: kept.providers, given: true } : { list: [], given: false };
    let accountRows = rows.length ? rows : kept.rows ?? [];
    const digest = parseDigest(input.digest);
    if (digest) {
      if (digest.clis.length) {
        const known = new Map(providers.list.map(entry => [entry.id, entry]));
        // A CLI in the digest: the kept entry with its new sign-in, or a bare entry (its plugins are then assumed).
        providers = { list: digest.clis.map(({ id, signIn }) => ({ ...(known.get(id) ?? { id, installed: true, available: true, subagent: true }), ...(signIn ? { signIn } : {}) })), given: true };
      }
      if (digest.accounts.length) {
        const pool = [...accountRows, ...(this.accountsSeen && now - this.accountsSeen.at <= KEEP_MS ? this.accountsSeen.rows : [])];
        accountRows = pool.filter((row, i) => digest.accounts.includes(row.accountId) && pool.findIndex(other => other.accountId === row.accountId && other.provider === row.provider) === i)
          .map(row => ({ ...row, state: 'ready', launchOptions: row.launchOptions ?? { 'canvastty-accounts': { account: row.accountId, effort: 'default', trustFolder: false } } }));
      }
    }
    if (accountRows.length) this.accountsSeen = { at: now, rows: accountRows.map(({ launchOptions: _drop, ...row }) => row) };
    return { providers, accountRows };
  }

  private async route(caller: CallerCard, input: Record<string, unknown>, name = 'route'): Promise<ToolAnswer> {
    if (!clean(input.task, 4_000)) return { content: 'Give the subagent\'s task in `task`.', isError: true };
    if (!this.options.enabled()) return { content: 'Automatic routing is off in the Assistant settings: choose the provider and model yourself.' };
    const decided = await this.decideFor(caller, input);
    if ('error' in decided) return { content: decided.error, isError: true };
    const { decision, view, source, providers, accountRows } = decided;
    const now = this.now();
    if (!decision.top) {
      const reasons = [...new Set(decision.dropped.map(entry => `${entry.cli}${entry.model ? ` ${entry.model}` : ''}: ${entry.reason}`))].slice(0, 6);
      return { content: `No route is usable now${reasons.length ? `: ${reasons.join('; ')}` : ''}. Call list_providers and choose a provider yourself, or ask the person.` };
    }
    const options = [decision.top, ...decision.alternatives];
    const record: RouteRecord = {
      id: randomUUID().slice(0, 8), at: now, card: caller.id.slice(0, 8), type: view.type, level: view.level, typeFrom: view.typeFrom, confidence: view.confidence,
      strategy: decision.strategy, cohort: decision.cohort, candidates: decision.groups.flat().length, dropped: decision.dropped.length,
      explored: decision.explored, preferred: decision.preferred, options: options.map(option => optionRecord(option, decision, now))
    };
    this.records.add(record);
    // An Auto (Jev) tree: every option's spawn carries a single-use value bound to this decision.
    if (this.options.bindSpawn) {
      for (const option of options) {
        const bound = this.options.bindSpawn(caller.id, option.spawn, record.id, input.orchestrate === true);
        if (bound) option.spawn = bound;
      }
    }
    const now2 = this.now();
    for (const [id, kept] of this.tasks) if (now2 - kept.at > MATCH_MS) this.tasks.delete(id);
    const cwd = clean(input.cwd, 4_096);
    this.tasks.set(record.id, { text: clean(input.task, 2_000), cwd: cwd ? trimSlash(cwd) : null, at: now2 });
    while (this.tasks.size > 64) this.tasks.delete(this.tasks.keys().next().value!);
    const compact = input.compact === true || (input.compact !== false && name === 'pick_route');
    if (compact) {
      const short = (c: Candidate, i: number): string => `${modelText(c)}; ${record.options[i]!.score === null ? 'no score' : `score ${record.options[i]!.score}`}; ${record.options[i]!.estimate}`;
      return {
        content: [
          `${short(decision.top, 0)}${decision.explored ? ' (exploring a new model)' : ''}.`,
          ...decision.alternatives.map((c, i) => `Or ${i + 1}: ${short(c, i + 1)}.`),
          `Pass spawn to spawn_agent unchanged (add title, cwd, prompt). Then route_outcome {decisionId:"${record.id}"}.`,
          ...(Array.isArray(input.providers) || Array.isArray(input.accountRoutes) ? [`Next time send only task: your lists are kept for 30 min (or send digest "${digestOf(providers, accountRows)}").`] : []),
          JSON.stringify({ decisionId: record.id, spawn: decision.top.spawn, kind: decision.top.kind, alternatives: decision.alternatives.map(c => ({ spawn: c.spawn, kind: c.kind })) })
        ].join('\n')
      };
    }
    const answer = (c: Candidate, i: number) => ({ spawn: c.spawn, why: record.options[i]!.why, estimate: record.options[i]!.estimate, route: { kind: c.kind, label: c.label }, kind: c.kind, score: record.options[i]!.score });
    const top = answer(decision.top, 0);
    const lines = [
      `Suggested: ${record.options[0]!.why}.`,
      `Estimate: ${top.estimate}.${decision.explored ? ' (A new model, tried on a small share of easy tasks; its outcome is counted.)' : ''}`,
      `Pass these to spawn_agent (with your own title, cwd and prompt; do not add a model or other launch options): ${JSON.stringify(decision.top.spawn)}.`,
      ...decision.alternatives.map((c, i) => `Alternative ${i + 1}: ${record.options[i + 1]!.why}; spawn_agent ${JSON.stringify(c.spawn)}.`),
      `Task read as ${view.type}, ${view.level} (${source === 'jev' ? 'by the decision model' : 'by word rules'}); strategy ${decision.strategy}.`,
      `When the subagent has ended, call route_outcome with decisionId "${record.id}" and what wait_for_agent or get_agent_result said (status and exitLines).`
    ];
    return {
      content: `${lines.join('\n')}\n${JSON.stringify({
        decisionId: record.id, type: view.type, level: view.level, strategy: decision.strategy, spawn: top.spawn, why: top.why, estimate: top.estimate, route: top.route,
        alternatives: decision.alternatives.map((c, i) => answer(c, i + 1)), dropped: decision.dropped.length
      })}`
    };
  }

  private outcome(caller: CallerCard, input: Record<string, unknown>): ToolAnswer {
    const id = clean(input.decisionId, 40);
    const session = clean(input.sessionId, 80);
    const record = (id ? this.records.get(id) : undefined) ?? (session ? this.records.bySession(session) : undefined);
    if (!record || record.card !== caller.id.slice(0, 8)) return { content: 'No route decision of yours with that decisionId (or sessionId).', isError: true };
    const status = clean(input.status, 20).toLowerCase();
    if (!['done', 'failed', 'error', 'cancelled', 'canceled', 'timeout', 'idle', 'exited'].includes(status)) return { content: 'status must be done, failed, cancelled or timeout (from wait_for_agent / get_agent_result).', isError: true };
    // Exit lines are only classified here, never stored.
    const result: OutcomeResult = classifyOutcome(status === 'timeout' ? 'failed' : status, strings(input.exitLines, 40, 400));
    const ok = typeof input.ok === 'boolean' ? input.ok && result === 'done' : undefined;
    const tokens = typeof input.tokens === 'number' && Number.isInteger(input.tokens) && input.tokens > 0 && input.tokens <= 100_000_000 ? input.tokens : undefined;
    const now = this.now();
    this.records.setOutcome(record, result, 'orchestrator', now, ok, tokens);
    const option = record.options[record.spawned?.option ?? 0];
    if (result === 'limit' && option) this.cool(option, resetFromText(strings(input.exitLines, 40, 400), now));
    // A route resting after a limit that just finished a task: its limit reset (perhaps early). Only a child that
    // started after the rest began proves it.
    const resting = option ? this.cooldowns.get(option.signIn) : undefined;
    if (result === 'done' && option && resting && resting.until > now && record.spawned && record.spawned.at >= (resting.at ?? 0)) {
      this.cooldowns.delete(option.signIn);
      this.event({ at: now, provider: option.cli, kind: 'recovered', note: `${option.label} finished a task while resting after a limit (until ${new Date(resting.until).toISOString().slice(11, 16)} UTC): early reset` });
    }
    return { content: `Recorded ${result}${result === 'limit' ? `: ${option?.label ?? 'that route'} rests ${this.cooldowns.get(option?.signIn ?? '')?.reason.replace(/^it hit a usage limit; resting /u, '') ?? 'for a while'} and route picks another one` : ''}.` };
  }

  /**
   * A quota exit: the route rests until the reset its exit message names, else its window's reset (when known), else
   * 5 min; at most 24 h. A read showing room, or a task finished on it, ends the rest early.
   */
  private cool(option: OptionRecord, stated: number | null = null): void {
    const now = this.now();
    const quota = option.kind === 'subscription' || option.kind === 'cli-default' ? this.limits?.providers.find(entry => entry.provider === option.cli) : undefined;
    const windowReset = quota?.windows.map(window => window.resetsAt).filter((at): at is number => at !== null && at > now).sort((a, b) => a - b)[0];
    const reset = stated !== null && stated > now ? stated : windowReset;
    const until = reset !== undefined && reset - now <= MAX_COOLDOWN_MS ? reset : now + QUOTA_COOLDOWN_MS;
    this.cooldowns.set(option.signIn, { until, at: now, reason: `it hit a usage limit; resting until ${new Date(until).toISOString().slice(11, 16)} UTC` });
    this.event({ at: now, provider: option.cli, kind: 'limit-exit', note: `${option.label}: a child stopped at a usage limit; resting until ${new Date(until).toISOString().slice(11, 16)} UTC${stated !== null ? ' (time from its message)' : ''}` });
  }

  /** Ends the rests of a CLI's own sign-in routes (its subscription plans and its default) after a reset. */
  private endRests(cli: string, why: string): void {
    const now = this.now();
    const keys = new Set([`cli:${cli}`, ...this.settings.plans.filter(plan => plan.cli === cli && plan.kind === 'subscription').map(plan => `plan:${plan.id}`)]);
    for (const [key, value] of this.cooldowns) {
      if (!keys.has(key) || value.until <= now) continue;
      this.cooldowns.delete(key);
      this.options.host.log('info', `route: ${key} rests no more (${why})`);
    }
  }

  /** Accounts' quota on list_routes rows: a rested account that Accounts read with room since the rest began is free. */
  private accountQuotaSeen(rows: readonly AccountRow[]): void {
    const now = this.now();
    for (const row of rows) {
      const rest = this.cooldowns.get(`account:${row.accountId}`);
      if (!rest || rest.until <= now || !row.quota || row.quota.observedAt === null || row.quota.observedAt <= (rest.at ?? now)) continue;
      if (row.quota.state !== 'ok' && row.quota.state !== 'low') continue;
      this.cooldowns.delete(`account:${row.accountId}`);
      this.event({ at: now, provider: row.provider, kind: 'early-reset', note: `account ${row.accountId}: Accounts read room again before ${new Date(rest.until).toISOString().slice(11, 16)} UTC` });
    }
  }

  private event(event: QuotaEvent): void {
    this.quotaEvents.push(event);
    if (this.quotaEvents.length > MAX_QUOTA_EVENTS) this.quotaEvents.splice(0, this.quotaEvents.length - MAX_QUOTA_EVENTS);
    this.options.host.log(event.kind === 'exhausted' || event.kind === 'limit-exit' ? 'warn' : 'info', `quota ${event.provider}: ${event.kind === 'early-reset' ? 'early reset' : event.kind} (${event.note})`);
    this.saveLimits();
  }

  // -------------------------------------------------------------------------------------------------------------
  // The settings page
  // -------------------------------------------------------------------------------------------------------------

  /**
   * CanvasTTY's `limits.get` answer, read by this service (`core`), pushed by the core (`core-push`, with its own
   * early-reset flag for some providers), or forwarded by the page (`page`); only the window fields are kept, the newer
   * read per provider wins, and what changed (an early reset, a reset, an exhaustion) is acted on at once.
   */
  receiveLimits(value: unknown, source: LimitsSource = 'page', hint: { earlyReset?: EarlyResetDetail[] } = {}): { ok: boolean; providers: number; changes: LimitChange[] } {
    const now = this.now();
    const parsed = parseLimits(value, now);
    if (!parsed) return { ok: false, providers: 0, changes: [] };
    const previous = this.limits;
    this.limits = mergeLimits(previous, { ...parsed, source });
    // Computed here for every read (older cores, the page); CanvasTTY's own entries are taken as well (it compares
    // reads this service never saw), one event per provider with every window's detail.
    const changes = limitChanges(previous, this.limits, now);
    for (const detail of hint.earlyReset ?? []) {
      let change = changes.find(entry => entry.provider === detail.provider && entry.kind === 'early-reset');
      if (!change) {
        const index = changes.findIndex(entry => entry.provider === detail.provider && (entry.kind === 'reset' || entry.kind === 'recovered'));
        if (index >= 0) changes.splice(index, 1);
        change = { provider: detail.provider, kind: 'early-reset', note: '', early: [] };
        changes.push(change);
      }
      if (!change.early!.some(entry => entry.window === detail.window)) {
        change.early!.push(detail);
        change.note = [change.note, `${earlyNote(detail)} (CanvasTTY)`].filter(Boolean).join('; ');
      }
    }
    for (const change of changes) {
      // An early reset or a reset: the route has its quota back; rests from limit exits end and it is planned again.
      if (change.kind === 'early-reset' || change.kind === 'reset') this.endRests(change.provider, change.kind === 'early-reset' ? `early reset: ${change.note}` : change.note);
      this.event({ at: now, provider: change.provider, kind: change.kind, note: change.note, ...(change.early?.length ? { early: change.early } : {}) });
    }
    // A rest from a limit exit ends too when a fresh read of that CLI shows room before the rest ends.
    for (const entry of parsed.providers) {
      if (entry.state !== 'available' || !entry.fetchedAt) continue;
      const quota = quotaOf(entry, 0, now);
      // Clear room only: a window just under 100 % right after a limit exit is not a reset.
      if (quota.state !== 'known' || (quota.headroom ?? 0) < RECOVERED_PERCENT) continue;
      const rested = [...this.cooldowns].filter(([key, rest]) => rest.until > now && (rest.at ?? now) < entry.fetchedAt! && (key === `cli:${entry.provider}` || this.settings.plans.some(plan => plan.cli === entry.provider && `plan:${plan.id}` === key)));
      if (rested.length) {
        for (const [key] of rested) this.cooldowns.delete(key);
        this.event({ at: now, provider: entry.provider, kind: 'recovered', note: `a read shows ${Math.round(quota.headroom!)}% left before the rest ended (${rested.map(([key]) => key).join(', ')}): early reset` });
      }
    }
    this.saveLimits();
    return { ok: true, providers: parsed.providers.length, changes };
  }

  /** The next time the service's own reader should read: soon after a predicted reset or while a route rests. */
  limitsDueIn(now = this.now()): { resetSoon: number | null; resting: boolean; presumed: boolean } {
    const resets = (this.limits?.providers ?? []).flatMap(entry => entry.windows.map(window => window.resetsAt)).filter((at): at is number => at !== null && at > now);
    const presumed = (this.limits?.providers ?? []).some(entry => entry.windows.some(window => window.resetsAt !== null && window.resetsAt <= now && entry.fetchedAt !== null && entry.fetchedAt < window.resetsAt));
    return { resetSoon: resets.length ? Math.min(...resets) : null, resting: [...this.cooldowns.values()].some(rest => rest.until > now), presumed };
  }

  private saveLimits(): void {
    this.limitsTimer ??= setTimeout(() => { this.limitsTimer = null; void this.flushLimits(); }, WRITE_DELAY_MS);
    this.limitsTimer.unref?.();
  }

  private flushLimits(): Promise<void> {
    if (this.limitsTimer) { clearTimeout(this.limitsTimer); this.limitsTimer = null; }
    const limits = this.limits;
    const json = JSON.stringify({ receivedAt: limits?.receivedAt ?? this.now(), snapshot: { providers: limits?.providers ?? [] }, events: this.quotaEvents });
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        const path = join(this.dir, 'limits.json');
        await writeFile(`${path}.tmp`, json, { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      } catch (error) {
        this.options.host.log('warn', `route: could not save limits (${error instanceof Error ? error.message.slice(0, 120) : 'error'})`);
      }
    });
    return this.writing;
  }

  feedback(id: string, ok: boolean): { ok: true } {
    const record = this.records.get(id);
    if (!record) throw new Error('Unknown route decision.');
    this.records.setOutcome(record, ok ? 'done' : 'failed', 'person', this.now(), ok);
    return { ok: true };
  }

  async save(value: unknown, locale: 'en' | 'ru'): Promise<RouteSettings> {
    if (!this.readable) throw new Error(locale === 'ru' ? 'Сохранённые настройки ещё не прочитаны, поэтому ничего не изменено.' : 'The saved settings could not be read yet, so nothing is changed.');
    const next = validateRouteSettings(value);
    await this.options.host.callHost('storage.set', { key: ROUTE_STORAGE_KEY, value: next });
    this.settings = next;
    this.options.host.emit('settings', null);
    return next;
  }

  state(): unknown {
    const now = this.now();
    let index: BenchmarkIndex | null = null;
    try { index = this.options.catalog().index; } catch { index = null; }
    const known = (identity: string): boolean => !!index && index.rows(identity).length > 0;
    return {
      settings: this.settings, readable: this.readable, now, staleAfterMs: STALE_MS,
      aliases: { asOf: ALIAS_TABLE_AS_OF, bundled: BUNDLED_ALIASES },
      plans: this.settings.plans.map(plan => ({
        id: plan.id,
        models: plan.models.map(model => ({ model, ...resolveModel(plan.cli, model, this.settings.aliases, known) })),
        quota: plan.kind === 'subscription' ? quotaOf(this.limits?.providers.find(entry => entry.provider === plan.cli), plan.reserve, now, this.launchesSinceRead(plan.cli)) : null,
        running: this.busy(`plan:${plan.id}`),
        launches: plan.kind === 'coding-plan' ? this.launches(plan.id, (plan.windowHours ?? 5) * 3_600_000) : null
      })),
      limits: this.limits ? { receivedAt: this.limits.receivedAt, source: this.limits.source ?? 'page', providers: this.limits.providers } : null,
      quotaEvents: this.quotaEvents.slice(-10),
      accounts: this.accountsSeen,
      cooldowns: [...this.cooldowns].filter(([, value]) => value.until > now).map(([signIn, value]) => ({ signIn, ...value })),
      recent: this.records.recent(30),
      exploration: this.records.exploration()
    };
  }

  // -------------------------------------------------------------------------------------------------------------
  // The decision file
  // -------------------------------------------------------------------------------------------------------------

  private write(list: RouteRecord[]): void {
    this.pending = list;
    this.writeTimer ??= setTimeout(() => { void this.flush(); }, WRITE_DELAY_MS);
    this.writeTimer.unref?.();
  }

  flush(): Promise<void> {
    if (this.limitsTimer) void this.flushLimits();
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    const list = this.pending;
    this.pending = null;
    if (!list) return this.writing;
    const json = JSON.stringify(list);
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        const path = join(this.dir, 'decisions.json');
        await writeFile(`${path}.tmp`, json, { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      } catch (error) {
        this.options.host.log('warn', `route: could not save decisions (${error instanceof Error ? error.message.slice(0, 120) : 'error'})`);
      }
    });
    return this.writing;
  }
}

export type { OutcomeResult };
