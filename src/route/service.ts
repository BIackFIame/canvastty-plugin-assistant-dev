/**
 * Route v2 inside the Assistant service: the `route` / `pick_route` and `route_outcome` tools, the "Where agents
 * run" settings (storage key `routing`), the limit windows the settings page forwards, decision records, and the
 * routed children it sees in session events (for "at most N at once" and coding-plan counts).
 *
 * Nothing is started here: the orchestrator passes the answer's spawn values to CanvasTTY's own `spawn_agent`, and
 * CanvasTTY checks every value. A recommendation never grants anything.
 */
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
import { parseLimits, quotaOf, STALE_MS, type LimitsCache } from './limits.ts';
import { classifyOutcome, RouteRecords, type OptionRecord, type OutcomeResult, type RouteRecord } from './records.ts';
import { normalizeRouteSettings, validateRouteSettings, type RouteSettings } from './settings.ts';

export const ROUTE_STORAGE_KEY = 'routing';
export const ROUTE_TOOLS = ['route', 'pick_route', 'route_outcome'] as const;
const CLASSIFY_DEADLINE_MS = 8_000;
/** A subagent of the routed CLI that appears this soon after the answer is taken as started from it. */
const MATCH_MS = 3 * 60_000;
const QUOTA_COOLDOWN_MS = 300_000;
const MAX_COOLDOWN_MS = 24 * 3_600_000;
const WRITE_DELAY_MS = 150;
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
    rows.push({
      provider, accountId, model, endpoint, state,
      ...(typeof candidate.account === 'string' ? { account: clean(candidate.account, 60) } : {}),
      ...(typeof candidate.reason === 'string' ? { reason: clean(candidate.reason, 160) } : {}),
      ...(launch ? { launchOptions: launch } : {})
    });
  }
  return rows;
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
  private readonly cooldowns = new Map<string, { until: number; reason: string }>();
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
      cooldown: key => { const c = this.cooldowns.get(key); return c && c.until > now ? c : null; }, stats,
      tokenFactor: identity => this.records.tokenFactor(identity, level => TASK_TOKENS[level].input + TASK_TOKENS[level].output),
      prefer: clean(input.prefer, 200) || null, orchestrate: input.orchestrate === true,
      explore: { roll: this.random(), retired, highRisk: ruleDifficulty(task) === 'hard' }
    });
    return { decision: result, view, source, providers, accountRows };
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
    this.records.setOutcome(record, result, 'orchestrator', this.now(), ok, tokens);
    const option = record.options[record.spawned?.option ?? 0];
    if (result === 'limit' && option) this.cool(option);
    return { content: `Recorded ${result}${result === 'limit' ? `: ${option?.label ?? 'that route'} rests for a while and route picks another one` : ''}.` };
  }

  /** A quota exit: the route rests until its window resets (when known, ≤ 24 h) or for 5 min. */
  private cool(option: OptionRecord): void {
    const now = this.now();
    const quota = option.kind === 'subscription' || option.kind === 'cli-default' ? this.limits?.providers.find(entry => entry.provider === option.cli) : undefined;
    const reset = quota?.windows.map(window => window.resetsAt).filter((at): at is number => at !== null && at > now).sort((a, b) => a - b)[0];
    const until = reset !== undefined && reset - now <= MAX_COOLDOWN_MS ? reset : now + QUOTA_COOLDOWN_MS;
    this.cooldowns.set(option.signIn, { until, reason: `it hit a usage limit; resting until ${new Date(until).toISOString().slice(11, 16)} UTC` });
  }

  // -------------------------------------------------------------------------------------------------------------
  // The settings page
  // -------------------------------------------------------------------------------------------------------------

  /** The page forwards CanvasTTY's `limits.get` answer; only the window fields are kept. */
  receiveLimits(value: unknown): { ok: boolean; providers: number } {
    const parsed = parseLimits(value, this.now());
    if (!parsed) return { ok: false, providers: 0 };
    this.limits = parsed;
    return { ok: true, providers: parsed.providers.length };
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
        quota: plan.kind === 'subscription' ? quotaOf(this.limits?.providers.find(entry => entry.provider === plan.cli), plan.reserve, now) : null,
        running: this.busy(`plan:${plan.id}`),
        launches: plan.kind === 'coding-plan' ? this.launches(plan.id, (plan.windowHours ?? 5) * 3_600_000) : null
      })),
      limits: this.limits ? { receivedAt: this.limits.receivedAt, providers: this.limits.providers } : null,
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
