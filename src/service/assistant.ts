import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Host } from '../rpc.ts';
import { AssistantEngine } from '../engine/AssistantEngine.ts';
import type { DecisionSecretsLike } from '../engine/AssistantSecrets.ts';
import { ReviewService, type DecideRequest, type DecideAnswer } from '../review/reviewService.ts';
import type { CommandReviewVerdict } from '../review/commandReview.ts';
import { advise, type Advice } from '../triage/triage.ts';
import { askTaskRoute, isGitRepository, mentionedExistingPaths } from '../triage/taskRoute.ts';
import {
  DATA_CLASSES, normalizeAssistantSettings, validateAssistantSettings,
  type AssistantCheckResult, type AssistantSettings, type DataClass
} from '../shared/settings.ts';
import { Harness, type CardSummary } from '../harness/harness.ts';
import { HarnessError, localeOf, type Locale, type ServiceStrings } from '../harness/i18n.ts';
import { commandReviewLevel, withCommandReview, COMMAND_REVIEW_LEVELS, type CommandReviewLevel, type CommandReviewState } from '../harness/settings.ts';
import { ROUTE_TAUS } from '../shared/catalog.ts';
import { AutoService, type AutoPrepareAnswer } from '../auto/service.ts';
import { AUTO_STRINGS } from '../auto/i18n.ts';
import { clampClass } from '../auto/launch.ts';
import type { RouterDeps } from '../auto/router.ts';
import { decisionFromTriage, type TurnDecision } from '../auto/select.ts';
import { RouteService } from '../route/service.ts';
import { LimitsFeed } from '../route/limitsFeed.ts';
import { AccountsFeed, ProvidersFeed } from '../route/peers.ts';
import { UsageMeter, measuredUsd, effectiveTokens } from '../route/usage.ts';
import { apiPrice, TASK_TOKENS } from '../route/engine.ts';
import { ACCOUNTS_ID, ASSISTANT_ID, type Spawn } from '../route/engine.ts';
import { Bindings, expectedOf, isBoundValue, isTopValue, launchAsk, ownChoice, ownTarget, targetOf, type ChildTarget, type TopTarget } from '../autopilot/binding.ts';
import { isOwnSignInCli, openCodePlanContribution, ownSignInArgs } from '../autopilot/topLevel.ts';
import { askTaskShape, planFor, planText, ruleShape, type AutopilotPlan, type ShapeView } from '../autopilot/shape.ts';
import { AUTOPILOT_STRINGS } from '../autopilot/i18n.ts';
import { ruleDifficulty } from '../harness/router.ts';
import { turnView, type TurnView } from '../auto/select.ts';
import { DEFAULT_MAX_PARALLEL } from '../route/settings.ts';
import { buildTree, type TreeAccount, type TreeRoute, type TreeView } from '../tree/agentTree.ts';
import { homedir } from 'node:os';
import { Conductor, TOOL_CLIS, type LeadRoute, type TopStart } from '../conductor/conductor.ts';
import { accountQuotaFrom } from '../route/service.ts';
import type { Candidate } from '../route/engine.ts';

/**
 * The Assistant service: one process that answers CanvasTTY's decision hook (command review), its launch pipeline
 * (triage of the task the person typed), the orchestrator tools, and the plugin's own settings page. Everything it
 * keeps lives in the plugin's data folder (`assistant/`: the decision log and backend capabilities) and storage
 * (`settings`); backend keys are read from the plugin's secrets only at call time and never leave this process.
 */

/** What CanvasTTY waits for a decision when it does not say (the manifest's `decide.timeoutMs`). */
export const DECIDE_BUDGET_MS = 45_000;
/** The launch triage runs after the launch answered, so it never holds the card. */
const TRIAGE_DEADLINE_MS = 20_000;
const TOOL_ADVICE_DEADLINE_MS = 12_000;
const SETTINGS_KEY = 'settings';

/** A card as CanvasTTY's session events describe it (metadata only). */
export type SessionSummary = CardSummary;

/** `canvastty.launch.prepare`, with the policy fields CanvasTTY ≥ core2/8 adds. */
export interface LaunchContext {
  sessionId: string; provider: string; profile: string; role: string; cwd: string; restoring: boolean; resume: boolean;
  options: Record<string, unknown> | null;
  /** false: a policy check for a launch where the person did not choose this plugin's options. */
  chosen?: boolean;
  /** Where the card runs: the chosen or saved environment; null on this computer. */
  environment?: { pluginId: string; kind: string } | null;
  parentSessionId?: string;
  /** CanvasTTY with B7: the model and effort the CLI is started with and the selected plugin ids. */
  requested?: { model?: string; effort?: string; plugins: string[] };
  /** CanvasTTY with B7: other selected plugins' fields they share with this plugin (`visibleTo`). */
  peerOptions?: Record<string, Record<string, string | boolean>>;
}

/** What prepare answers: the Auto proxy, own-sign-in args, an OpenCode plan pin, or a refusal. */
export type LaunchAnswer = AutoPrepareAnswer | { args: string[]; env?: Record<string, string>; files?: Array<{ relPath: string; content: string }> };

/** What "Start with Auto (Jev)" answers the page. */
export type StartAnswer =
  | { started: true; sessionId: string; provider: string; route: string; kind: string; server: string | null; plan: { mode: string; children: number } }
  | { started: false; code: 'input' | 'routingOff' | 'core' | 'consent' | 'noRoute' | 'noServer' | 'refused'; detail?: string };

/** Before the plan in the first prompt of an orchestrator "Start with Auto (Jev)" started (agents read English). */
const AUTOPILOT_PROMPT = 'You were started by Auto (Jev): every subagent you start must be routed with canvastty-assistant__pick_route.';

/** A whole task as the person or an orchestrator wrote it: lines kept (a list of parts is part of its shape). */
const planTask = (value: unknown): string => typeof value === 'string' ? value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/gu, ' ').trim().slice(0, 2_000) : '';

/**
 * How a top-level orchestrator gets a route's model (sessions.create takes no model): the CLI's own sign-in with the
 * Assistant's arguments (Claude Code, Codex), an OpenCode plan pin or the Auto proxy, or a model account (Accounts
 * sets the model). On a server only a CLI's own sign-in (nothing from this computer reaches it). Null: not startable.
 */
function topTargetOf(spawn: Spawn, onServer: boolean): TopTarget | null {
  const account = spawn.launchOptions[ACCOUNTS_ID]?.account;
  // An Accounts pool is the CLI's own sign-in in another home: the model and effort go as for the CLI's own sign-in.
  if (typeof account === 'string' && account.startsWith('pool:')) return onServer ? null : isOwnSignInCli(spawn.provider) ? ownTarget(spawn.model ?? null, spawn.effort ?? null) : !spawn.model && !spawn.effort ? 'off' : null;
  if (typeof account === 'string' && account !== 'none') return onServer ? null : 'off';
  if (spawn.launchOptions[ASSISTANT_ID]?.model === 'auto') return onServer ? null : 'auto';
  if (spawn.provider === 'opencode' && spawn.model && spawn.model.includes('/')) return onServer ? null : `plan:${spawn.model}`;
  if (isOwnSignInCli(spawn.provider)) return ownTarget(spawn.model ?? null, spawn.effort ?? null);
  return !spawn.model && !spawn.effort ? 'off' : null;
}

const text = (value: unknown, max: number): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, max) : '';

export class Assistant {
  settings: AssistantSettings;
  readonly engine: AssistantEngine;
  readonly review: ReviewService;
  private readonly host: Host;
  private readonly sessions = new Map<string, SessionSummary>();
  private readonly generations = new Map<string, number>();
  private readonly checks = new Map<string, AssistantCheckResult | { running: true } | { error: string }>();
  private readonly registered = new Set<string>();
  private locale: Locale;
  /**
   * False while the saved settings could not be read (a storage error, not "nothing saved"): command review is Off
   * meanwhile, and nothing is saved over what is stored until a read succeeds (`storageRecovered`).
   */
  settingsReadable: boolean;
  /** The same for the harness switches (routing, loop alerts, flows): their defaults apply, nothing is saved over. */
  private harnessReadable: boolean;
  readonly harness: Harness;
  /** Model: Auto (Jev): the router, its settings and the launch contribution. */
  readonly auto: AutoService;
  /** Route v2: where a subagent runs (subscriptions, coding plans, model accounts, Auto). */
  readonly routing: RouteService;
  /** Limit windows read by this service where the core allows it (else the page forwards them). */
  readonly limitsFeed: LimitsFeed;
  /** Accounts' shared reads (routes, pools, quota) through plugins.request, after the person approved the pair. */
  readonly accounts: AccountsFeed;
  /** CanvasTTY's providers.list (providers:read). */
  readonly providers: ProvidersFeed;
  /** CanvasTTY's measured usage of this plugin's cards (usage:read). */
  readonly usage: UsageMeter;
  /** Each card's effective data class, so a subagent's can be clamped to its parent's. */
  private readonly classes = new Map<string, DataClass>();
  /** Each card's triage advice, so its badge can be written again in another language. */
  private readonly triaged = new Map<string, Advice>();
  /** Auto (Jev) autopilot: Auto cards and the single-use route values their subagents launch with. */
  readonly bindings: Bindings;
  /** Auto cards on their CLI's own sign-in: the model chosen at launch and the plan it runs on (agent tree). */
  private readonly autoTop = new Map<string, { model: string | null; label: string }>();
  /** Leaf cards this service started on servers: the orchestrator that asked, the server, the CLI. */
  private readonly leaves = new Map<string, { parent: string; server: string; provider: string }>();
  /** Orchestrators "Start with Auto (Jev)" started: where they run. */
  private readonly started = new Map<string, { server: string | null; provider: string; route?: TreeRoute }>();
  /** Launches this service refused (they never started), by full session id, for the agent tree's counts. */
  private readonly refused = new Set<string>();
  /** Whether this CanvasTTY lets a plugin start an orchestrator (B8): null until asked. */
  private b8: boolean | null = null;
  /** The main agent («Главный агент») and its project agents. */
  readonly conductor: Conductor;

  constructor(options: { host: Host; dataDir: string; settings?: unknown; settingsUnavailable?: boolean; harness?: unknown; harnessUnavailable?: boolean; autoRouting?: unknown; autoRoutingUnavailable?: boolean; routing?: unknown; routingUnavailable?: boolean; conductor?: unknown; conductorUnavailable?: boolean; home?: string; conductorClock?: { now: () => number; schedule: (run: () => void, ms: number) => { cancel(): void } }; locale?: unknown; transport?: typeof fetch; catalogTransport?: typeof fetch; git?: null; now?: () => number; autoTimeouts?: RouterDeps['timeouts'] }) {
    this.host = options.host;
    // Nothing saved (a fresh install, or an update from a version that saved nothing) or nothing readable: the
    // defaults, with command review Off. The person turns it on; the plugin never decides trust for them.
    this.settingsReadable = options.settingsUnavailable !== true;
    this.harnessReadable = options.harnessUnavailable !== true;
    this.settings = normalizeAssistantSettings(this.settingsReadable ? options.settings : null);
    const locale: Locale = localeOf(options.locale);
    this.locale = locale;
    this.harness = new Harness({
      host: options.host, dataDir: options.dataDir, locale, ...(options.now ? { now: options.now } : {}),
      reviewOn: () => commandReviewLevel(this.settings) !== 'off',
      publishBadge: (sessionId, badge) => this.host.callHost('cards.setBadge', { sessionId, badge }).then(() => undefined, () => undefined)
    });
    this.harness.loadSettings(options.harness);
    const secrets: DecisionSecretsLike = {
      statusFor: async owner => {
        const stored = await this.readKey(owner);
        return { configured: stored !== null, origin: stored?.origin ?? null };
      },
      getBound: async (owner, origin) => {
        const stored = await this.readKey(owner);
        if (!stored) return null;
        // A key saved for another address is never sent anywhere else (§5.9).
        if (stored.origin !== origin) throw new Error('This key is bound to another address.');
        return { value: stored.value, origin };
      },
      generationFor: owner => this.generations.get(owner) ?? 0
    };
    this.engine = new AssistantEngine({
      settings: () => this.settings, directory: join(options.dataDir, 'assistant'), secrets,
      ...(options.transport ? { transport: options.transport } : {})
    });
    this.auto = new AutoService({
      host: options.host, dataDir: options.dataDir, locale, saved: options.autoRouting, savedUnavailable: options.autoRoutingUnavailable === true,
      readKey: owner => this.readKey(owner),
      dataClassMode: () => this.settings.dataClassMode,
      decide: (text, grant, signal) => this.turnDifficulty(text, grant.dataClass, grant.sessionId, grant.role, signal),
      // Each new user turn is the task command review checks this card's actions against (memory only).
      turn: (text, grant) => this.review.noteTurn(grant.sessionId, text, { role: grant.role, parentSessionId: grant.parentSessionId }),
      publishBadge: (sessionId, badge) => { void this.harness.setBadge(sessionId, 'model', badge); },
      // A fan-out keeps a subscription-like upstream (an address the person marked flat-rate) at its parallel cap.
      parallelCap: upstream => {
        try { return this.routing.settings.flat.includes(`host:${new URL(upstream.baseUrl).host}`) ? DEFAULT_MAX_PARALLEL : null; } catch { return null; }
      },
      ...(options.transport ? { transport: options.transport } : {}),
      ...(options.catalogTransport ? { catalogTransport: options.catalogTransport } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.autoTimeouts ? { timeouts: options.autoTimeouts } : {})
    });
    this.bindings = new Bindings(options.now);
    this.accounts = new AccountsFeed(options.host, options.now);
    this.providers = new ProvidersFeed(options.host, options.now);
    this.usage = new UsageMeter(options.host, options.now);
    this.routing = new RouteService({
      accounts: this.accounts, providersFeed: this.providers, usage: this.usage,
      serverLoad: label => [...this.leaves.values(), ...this.started.values()].filter(entry => entry.server === label).length,
      bindSpawn: (callerId, spawn, decisionId, orchestrate) => this.bindSpawn(callerId, spawn, decisionId, orchestrate),
      host: options.host, dataDir: options.dataDir, saved: options.routing, savedUnavailable: options.routingUnavailable === true,
      enabled: () => this.harness.settings.routing,
      // Jev reads the subagent's task under the caller's data class, within the caller's own per-card budget.
      classify: async (task, caller, deadlineMs) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), deadlineMs);
        try { return await this.turnDifficulty(task, this.classOf(caller.id), caller.id, caller.role === 'orchestrator' ? 'subagent' : caller.role, controller.signal); }
        finally { clearTimeout(timer); }
      },
      catalog: () => this.auto.routingIndex(),
      preference: () => this.auto.settings.preference,
      autoExpectation: (view, cardClass) => this.auto.expectation(view, cardClass),
      cardClass: sessionId => this.classOf(sessionId),
      // The orchestrator's task for a routed child is that child's own text for review: counted as the orchestrator's,
      // as person-typed only when it quotes the person word for word (ReviewService.requestFor's rules).
      delegatedTask: (childId, text, parentId) => this.review.noteTurn(childId, text, { role: 'subagent', parentSessionId: parentId }),
      dataClassMode: () => this.settings.dataClassMode,
      ...(options.now ? { now: options.now } : {})
    });
    this.limitsFeed = new LimitsFeed({ host: options.host, sink: this.routing, ...(options.now ? { now: options.now } : {}) });
    this.review = new ReviewService({
      engine: this.engine, settings: () => this.settings, locale, trustChain: () => this.harness.settings.trustChain,
      ...(options.git === null ? { git: null } : {}),
      suggest: (sessionId, verdict, summary) => { void this.harness.setBadge(sessionId, 'review', () => suggestionBadge(verdict, summary, this.harness.strings)); }
    });
    this.conductor = new Conductor({
      host: options.host, dataDir: options.dataDir, home: options.home ?? homedir(), locale: () => this.locale,
      ...(options.conductorClock ? options.conductorClock : options.now ? { now: options.now } : {}),
      session: id => this.sessions.get(id), treeBelow: id => this.treeBelow(id),
      startTop: input => this.startTop(input), accountOf: route => this.accountOf(route),
      openFolders: () => this.autopilotEntry().folders
    }, options.conductor, options.conductorUnavailable === true);
  }

  get pageLocale(): Locale { return this.locale; }

  private warming: Promise<void> | null = null;
  private pageWarmed = false;

  /**
   * The first reads of this service run, so the settings page and the first decisions see Accounts' routes and quota
   * and the limit windows at once, not "not read yet" until something routes: limits.get (the feed's read, shared
   * when one runs), Accounts' accounts.routes and accounts.quota (plugins.request, where the person allowed it), and
   * what the routing view keeps of them. At service start and when the person first opens the settings page.
   */
  warmReads(): Promise<void> {
    this.warming ??= (async () => {
      await Promise.allSettled([this.limitsFeed.read(), this.accounts.warm()]);
      await this.routing.refreshPeers().catch(() => undefined);
    })().finally(() => { this.warming = null; });
    return this.warming;
  }

  /** The settings page asked for its state the first time this run: the same reads, then it is told to reload. */
  pageOpened(): void {
    if (this.pageWarmed) return;
    this.pageWarmed = true;
    void this.warmReads().then(() => this.host.emit('settings', null), () => undefined);
  }

  /**
   * `canvastty.activity`: `limit.exhausted` (CanvasTTY saw the default login's window of a CLI used up, provider-wide)
   * rests that CLI's own sign-in routes until the reset; other activity is ignored.
   */
  activity(params: unknown): void {
    if (this.routing.limitExhausted(params)) void this.limitsFeed.read();
  }

  /** A card action: the toast in the language the person used when choosing it (CanvasTTY with the locale in invoke). */
  cardAction(actionId: string, sessionId: string, session: SessionSummary | undefined, locale?: unknown): { message: string; tone: 'info' | 'warn' | 'error' } {
    if (locale === 'en' || locale === 'ru') this.setLocale(locale);
    return this.harness.cardAction(actionId, sessionId, session);
  }

  /**
   * The language the person's pages report (CanvasTTY tells a service its locale only at start; a page's context
   * follows the app's language). Everything the service writes for the person follows from now on.
   */
  setLocale(value: unknown): Locale {
    const locale = localeOf(value);
    if (locale === this.locale) return locale;
    this.locale = locale;
    this.harness.setLocale(locale);
    this.auto.setLocale(locale);
    this.review.setLocale(locale);
    // Badges already on cards are written again in the new language (each kept as how to write it).
    void this.harness.relocalize();
    return locale;
  }

  /** A card and every card below it (CanvasTTY's parent links, full ids; bounded, a circle stops where it closes). */
  treeBelow(sessionId: string): Set<string> {
    const tree = new Set<string>([sessionId]);
    const children = new Map<string, string[]>();
    for (const session of this.sessions.values()) {
      if (typeof session.parentSessionId !== 'string' || session.parentSessionId === session.id) continue;
      children.set(session.parentSessionId, [...children.get(session.parentSessionId) ?? [], session.id]);
    }
    const queue = [sessionId];
    while (queue.length && tree.size < 4_096) {
      for (const child of children.get(queue.shift()!) ?? []) if (!tree.has(child)) { tree.add(child); queue.push(child); }
    }
    return tree;
  }

  /** A card's effective data class (its launch's, else the default). */
  classOf(sessionId: string): DataClass { return this.classes.get(sessionId) ?? this.settings.defaultDataClass; }

  /** A key the settings page wrote: `{ origin, value }` as JSON under the backend's secret name. */
  async readKey(owner: string): Promise<{ origin: string; value: string } | null> {
    let raw: unknown;
    try { raw = await this.host.callHost('secrets.get', { key: owner }); } catch { throw new Error('The plugin secrets are unavailable.'); }
    if (typeof raw !== 'string' || !raw) return null;
    try {
      const parsed = JSON.parse(raw) as { origin?: unknown; value?: unknown };
      if (typeof parsed.origin === 'string' && typeof parsed.value === 'string' && parsed.value.trim()) {
        const value = parsed.value.trim();
        // CanvasTTY masks what a service reads with secrets.get, but that is this JSON; the key inside is registered here.
        if (!this.registered.has(value)) {
          this.registered.add(value);
          await this.host.callHost('redaction.register', { values: [value] }).catch(() => this.registered.delete(value));
        }
        return { origin: parsed.origin, value };
      }
    } catch { /* not ours */ }
    return null;
  }

  // -------------------------------------------------------------------------
  // Sessions (sessions:events)
  // -------------------------------------------------------------------------

  sessionsKnown(list: unknown): void {
    if (!Array.isArray(list)) return;
    this.harness.sessionsKnown(list);
    for (const session of list) if (session && typeof session === 'object' && typeof (session as SessionSummary).id === 'string') this.sessions.set((session as SessionSummary).id, session as SessionSummary);
    // Keys of cards CanvasTTY no longer has (they closed while the service was down) stop working now.
    this.auto.sessionsKnown(new Set(this.sessions.keys()));
    // The main agent and its project agents after a restart: still open, re-bound (the main agent starts nobody).
    this.conductor.sessionsKnown(new Set(this.sessions.keys()));
    if (this.conductor.conductorId) { this.bindings.markAuto(this.conductor.conductorId); this.bindings.setPlan(this.conductor.conductorId, 0); }
  }

  sessionEvent(event: { type?: unknown; session?: unknown }): void {
    const session = event.session as SessionSummary | undefined;
    if (!session || typeof session.id !== 'string') return;
    this.harness.sessionEvent(event);
    this.routing.sessionEvent(event);
    const ended = event.type === 'closed' || event.type === 'exited' || session.status === 'exited';
    if (ended) { this.bindings.ended(session.id); this.usage.ended(session.id); }
    if (event.type === 'closed') { this.conductor.sessionEvent(event.type, session); this.usage.closed(session.id); this.autoTop.delete(session.id); this.leaves.delete(session.id); this.started.delete(session.id); this.refused.delete(session.id); this.sessions.delete(session.id); this.review.forget(session.id); this.classes.delete(session.id); this.triaged.delete(session.id); this.auto.sessionClosed(session.id); return; }
    this.sessions.set(session.id, session);
    this.conductor.sessionEvent(event.type, session);
  }

  // -------------------------------------------------------------------------
  // EP-5: the decision hook
  // -------------------------------------------------------------------------

  async decide(params: Record<string, unknown>): Promise<DecideAnswer> {
    // The main agent's own project tool (its first call would otherwise ask the person in Claude Code): allowed
    // here, for that card only, by its full session id. Counts only where the person let the Assistant allow.
    const tool = params.tool as { name?: unknown; kind?: unknown } | undefined;
    if (this.conductor.isConductor(params.sessionId) && tool?.kind === 'other' && typeof tool.name === 'string' && /(?:^|__)canvastty-assistant__projects$/u.test(tool.name)) {
      return { verdict: 'allow', reason: 'The main agent\'s own project tool.' };
    }
    const budget = typeof params.budgetMs === 'number' && Number.isFinite(params.budgetMs) ? params.budgetMs : 3_000;
    const answer = await this.review.decide(params as unknown as DecideRequest, Math.min(budget, DECIDE_BUDGET_MS));
    // Loop alerts and the session report see every call, whatever command review answered (or if it is off).
    try { this.harness.observeDecision(params, answer?.verdict ?? null); } catch { /* advisory only */ }
    return answer;
  }

  // -------------------------------------------------------------------------
  // EP-2: launch triage
  // -------------------------------------------------------------------------

  /**
   * Never refuses. YOLO is CanvasTTY's own rule now (the person's acknowledgement per CLI, never for subagents), and
   * every non-manual agent runs inside CanvasTTY's isolation layer or its environment's own boundary; the card's
   * `isolation.state` says which. A worktree is not an isolated environment, so the old "YOLO only isolated" option
   * (which counted it as one) is gone and a saved value of it is ignored.
   */
  async launch(context: LaunchContext): Promise<LaunchAnswer | null> {
    const answer = await this.launchAnswer(context);
    // A refused launch never started: the agent tree leaves it out of its counts and shows it as refused.
    if (answer && 'refuse' in answer && answer.refuse) {
      this.refused.add(context.sessionId);
      while (this.refused.size > 1_024) this.refused.delete(this.refused.keys().next().value!);
    } else this.refused.delete(context.sessionId);
    return answer;
  }

  private async launchAnswer(context: LaunchContext): Promise<LaunchAnswer | null> {
    // What the launch asks for (model, effort, plugins, shared peer fields): only on a core that says (B7).
    const ask = launchAsk(context);
    if (context.chosen === false) return ask ? this.policy(context) : null;
    const options = context.options ?? {};
    const task = text(options.task, 2_000) || null;
    const requested = DATA_CLASSES.includes(options.dataClass as DataClass) ? options.dataClass as DataClass : null;
    // An orchestrator may choose these options for its subagents (delegable), but never a lower class than its own.
    const parentClass = context.role === 'subagent' && context.parentSessionId ? this.classes.get(context.parentSessionId) ?? null : null;
    const dataClass = requested ? clampClass(requested, parentClass) : parentClass;
    this.classes.set(context.sessionId, dataClass ?? this.settings.defaultDataClass);
    while (this.classes.size > 4_096) this.classes.delete(this.classes.keys().next().value!);
    const model = options.model ?? 'off';
    const strings = AUTOPILOT_STRINGS[this.locale];
    // Auto (Jev) autopilot: a subagent of an Auto card launches only with a route value pick_route gave out.
    const parent = context.role === 'subagent' ? context.parentSessionId ?? null : null;
    let bound: ChildTarget | null = null;
    let top: TopTarget | null = null;
    if (parent && this.bindings.isAuto(parent)) {
      const check = this.bindings.check({ value: model, parent, provider: context.provider, sessionId: context.sessionId, ask });
      if (!check.ok) return { refuse: { reason: strings[check.reason] } };
      bound = check.target as ChildTarget;
    } else if (parent && ask && this.bindings.isLeaf(parent) && !context.restoring) {
      // A leaf of an Auto tree does not split (the plan's depth); seen only where the core shows every launch (B7).
      return { refuse: { reason: strings.leaf } };
    } else if (isTopValue(model)) {
      // "Start with Auto (Jev)": the top-level orchestrator this plugin started, bound to Jev's decision.
      if (context.role === 'subagent') return { refuse: { reason: strings.unrouted } };
      const check = this.bindings.checkTop({ value: model, provider: context.provider, ask });
      if (!check.ok) return { refuse: { reason: strings[check.reason] } };
      top = check.target;
    } else if (isBoundValue(model)) {
      // A route value outside an Auto tree: what it names, without the binding checks (nothing to enforce there).
      bound = targetOf(model) as ChildTarget;
    } else if (model !== 'off' && model !== 'auto') { const refusal = AUTO_STRINGS[this.locale].unknownValue; return { refuse: { reason: refusal } }; }
    const mode = this.engine.mode('task.route');
    const triage = !!task && (mode === 'suggest' || mode === 'auto' || mode === 'shadow');
    this.review.noteLaunch(context.sessionId, { task, dataClass, triage: triage && mode !== 'shadow', role: context.role, parentSessionId: context.parentSessionId ?? null });
    if (triage) void this.triage(context.sessionId, task!, dataClass, context.cwd);
    if (top) {
      // Its subagents are routed like any Auto card's; the route itself is what Jev chose when it was started.
      this.bindings.markAuto(context.sessionId);
      // The main agent starts no subagents (also after a restart).
      if (this.conductor.isConductor(context.sessionId)) this.bindings.setPlan(context.sessionId, 0);
      const own = ownChoice(top);
      if (own) return isOwnSignInCli(context.provider) ? { args: ownSignInArgs(context.provider, own) } : null;
      bound = top as ChildTarget;
    }
    if (bound) {
      if (bound === 'off') return null;
      if (bound.startsWith('plan:')) {
        const pinned = context.provider === 'opencode' ? openCodePlanContribution(bound.slice(5)) : null;
        return pinned ?? { refuse: { reason: strings.planUnusable } };
      }
      return this.auto.prepare({
        sessionId: context.sessionId, provider: context.provider, role: context.role, cwd: context.cwd, parentSessionId: context.parentSessionId ?? null,
        environment: context.environment, dataClass: dataClass ?? this.settings.defaultDataClass
      });
    }
    if (model !== 'auto') return null;
    // An Auto card: its subagents are routed (above). On Claude Code and Codex it runs on the CLI's own sign-in
    // with the model and effort Jev chose; on OpenCode, the Auto proxy.
    if (isOwnSignInCli(context.provider)) {
      const choice = await this.topLevelChoice(context.provider, task, dataClass ?? this.settings.defaultDataClass, context.sessionId, context.role);
      if ('exhausted' in choice) return { refuse: { reason: strings.exhausted.replace('{why}', choice.exhausted) } };
      this.bindings.markAuto(context.sessionId);
      // The agent tree shows the model chosen here and that the card runs on the person's own sign-in.
      this.autoTop.set(context.sessionId, { model: choice.model, label: choice.label ?? context.provider });
      while (this.autoTop.size > 1_024) this.autoTop.delete(this.autoTop.keys().next().value!);
      return { args: ownSignInArgs(context.provider, choice) };
    }
    if (context.provider !== 'opencode') return { refuse: { reason: strings.provider } };
    this.bindings.markAuto(context.sessionId);
    return this.auto.prepare({
      sessionId: context.sessionId, provider: context.provider, role: context.role, cwd: context.cwd, parentSessionId: context.parentSessionId ?? null,
      environment: context.environment, dataClass: dataClass ?? this.settings.defaultDataClass
    });
  }

  /**
   * The launch policy (`"policy": true`): a launch where the person did not choose the Assistant. Only on a core
   * that shows what a launch asks for (B7); older cores get no answer from it but null, as before. A subagent of an
   * Auto card that does not carry its route (another CLI that did not name the Assistant, a grandchild on another
   * CLI) is refused with what to do; a leaf's subagent too. Everything else, and every restore, passes. Answers from
   * memory only, never waits on a model.
   */
  private policy(context: LaunchContext): LaunchAnswer | null {
    if (context.role !== 'subagent' || !context.parentSessionId || context.restoring) return null;
    const strings = AUTOPILOT_STRINGS[this.locale];
    if (this.bindings.isAuto(context.parentSessionId)) return { refuse: { reason: strings.unrouted } };
    if (this.bindings.isLeaf(context.parentSessionId)) return { refuse: { reason: strings.leaf } };
    return null;
  }

  /**
   * D2: the model and effort for an Auto card on its CLI's own sign-in. Jev reads the launcher's Task (at most 2.5 s,
   * then word rules); an orchestrator without a task counts as large, never small.
   */
  private async topLevelChoice(cli: string, task: string | null, dataClass: DataClass, sessionId: string, role: string): Promise<{ model: string | null; effort: string | null; label?: string } | { exhausted: string }> {
    let decision: TurnDecision | null = null;
    if (task) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_500);
      try { decision = await Promise.race([this.turnDifficulty(task, dataClass, sessionId, role, controller.signal), new Promise<null>(resolve => controller.signal.addEventListener('abort', () => resolve(null)))]); }
      catch { decision = null; } finally { clearTimeout(timer); }
    }
    const view = decision ? turnView(decision, 'jev', task ?? '', { role }) : task ? turnView({ difficulty: ruleDifficulty(task), strong: false }, 'rules', task, { role })
      : turnView({ difficulty: role === 'orchestrator' ? 'hard' : 'normal', strong: role === 'orchestrator' }, 'rules', '', { role });
    return this.routing.topLevelChoice(cli, view, dataClass, role === 'orchestrator');
  }

  /**
   * autopilot_plan (D3, D5, D9): how the orchestrator's task splits. Jev answers task.route and task.shape on the
   * task (2.5 s, then word rules); code turns that into solo / orchestrate N / deep, the strategy and the budget.
   * For an Auto card the child count is enforced at each subagent's launch; calling again replaces the plan.
   */
  private async autopilotPlan(caller: SessionSummary | undefined, input: Record<string, unknown>): Promise<{ content: unknown; isError?: boolean }> {
    if (!caller || typeof caller.id !== 'string') return { content: 'CanvasTTY did not say which card is calling.', isError: true };
    if (this.conductor.isConductor(caller.id)) return { content: 'The main agent starts no subagents: hand work to a project with canvastty-assistant__projects (action "start").', isError: true };
    // Lines kept: a list of parts is part of the task's shape.
    const task = planTask(input.task);
    if (!task) return { content: 'Give the whole task in `task`.', isError: true };
    const { plan, view, shaped, from } = await this.planOf(task, this.classOf(caller.id), caller.id);
    if (this.bindings.isAuto(caller.id)) this.bindings.setPlan(caller.id, plan.children);
    return { content: `${planText(plan)}\n${JSON.stringify({ ...plan, type: view.type, level: view.level, shape: shaped.shape, parts: shaped.parts, from })}` };
  }

  /** Jev's task.route and task.shape on a whole task (2.5 s, then word rules), and the plan code makes of them. */
  private async planOf(task: string, dataClass: DataClass, sessionId: string): Promise<{ plan: AutopilotPlan; view: TurnView; shaped: ShapeView; from: 'jev' | 'rules'; decision: TurnDecision | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_500);
    const ctx = { signal: controller.signal, assertCurrent: () => { if (controller.signal.aborted) throw new Error('aborted'); }, requester: 'orchestrator' as const, sessionId };
    const quiet = <T>(work: Promise<T>): Promise<T | null> => Promise.race([work.catch(() => null), new Promise<null>(resolve => controller.signal.addEventListener('abort', () => resolve(null)))]);
    const mode = this.engine.mode('task.route');
    const asks = mode === 'suggest' || mode === 'auto';
    const [decision, shape] = await Promise.all([
      asks ? quiet(this.turnDifficulty(task, dataClass, sessionId, 'orchestrator', controller.signal)) : Promise.resolve(null),
      asks ? quiet(askTaskShape(this.engine, { task, dataClass }, ctx)) : Promise.resolve(null)
    ]);
    clearTimeout(timer);
    const view = decision ? turnView(decision, 'jev', task, { role: 'subagent' }) : turnView({ difficulty: ruleDifficulty(task), strong: false }, 'rules', task, { role: 'subagent' });
    const shaped = shape ?? ruleShape(task);
    return { plan: planFor(view, shaped, { perTaskUsd: this.auto.settings.perCardUsdCap }), view, shaped, from: shape ? 'jev' : 'rules', decision };
  }

  /**
   * Whether this CanvasTTY lets a plugin start an orchestrator (core B8), asked once per service run without
   * starting anything: a role it does not know is refused by such a core before anything else; an older core ignores
   * `role` and refuses the call for the missing provider and folder.
   */
  private async orchestratorsSupported(): Promise<boolean> {
    if (this.b8 !== null) return this.b8;
    try {
      await this.host.callHost('sessions.create', { role: 'probe' });
      this.b8 = false;
    } catch (error) {
      this.b8 = /role must be agent or orchestrator/iu.test(error instanceof Error ? error.message : String(error));
    }
    return this.b8;
  }

  /** Folders of the cards open now (newest first), for the start form; and whether servers are on. */
  autopilotEntry(): { folders: string[]; servers: boolean; routing: boolean } {
    const folders: string[] = [];
    for (const session of [...this.sessions.values()].reverse()) {
      const folder = typeof session.workingDirectory === 'string' && session.workingDirectory ? session.workingDirectory : session.cwd;
      if (typeof folder === 'string' && folder && !folders.includes(folder)) folders.push(folder);
      if (folders.length >= 8) break;
    }
    const route = this.routing.settings;
    return { folders, servers: route.serversOn && route.servers.length > 0, routing: this.harness.settings.routing };
  }

  /**
   * "Start with Auto (Jev)" (autopilot phase 2, core B8): Jev reads the task, and code chooses the CLI, the sign-in
   * (a declared subscription or coding plan, or a model account), the model and effort, and with `server` one of the
   * person's declared servers, for an orchestrator this plugin starts with `sessions.create {role: "orchestrator"}`.
   * Its launch is bound to that decision (single use), its subagents are routed like any Auto card's, and its first
   * prompt is the task with the plan. Needs the person's "May start orchestrators" for this plugin; without it, or on
   * a core without it, nothing starts and the answer says how to start Auto instead. Never an OpenRouter route.
   */
  async startAuto(input: Record<string, unknown>): Promise<StartAnswer> {
    const task = planTask(input.task);
    const cwd = text(input.cwd, 4_096);
    if (!task || !cwd || !(cwd.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(cwd))) return { started: false, code: 'input' };
    if (!this.harness.settings.routing) return { started: false, code: 'routingOff' };
    if (!await this.orchestratorsSupported()) return { started: false, code: 'core' };
    const dataClass = this.settings.defaultDataClass;
    const { plan, decision } = await this.planOf(task, dataClass, 'autopilot-start');
    // The orchestrator's own turns are never small (D2).
    const view = decision ? turnView(decision, 'jev', task, { role: 'orchestrator' }) : turnView({ difficulty: ruleDifficulty(task), strong: false }, 'rules', task, { role: 'orchestrator' });
    const route = this.routing.settings;
    const onServer = input.server === true && route.serversOn && route.servers.length > 0;
    const busy = (label: string): number => [...this.leaves.values(), ...this.started.values()].filter(entry => entry.server === label).length;
    const servers = onServer ? route.servers.filter(entry => busy(entry.label) < entry.maxParallel) : [];
    if (onServer && !servers.length) return { started: false, code: 'noServer' };
    const { candidates, dropped } = await this.routing.orchestratorRoutes(view, dataClass, onServer ? { clis: [...new Set(servers.flatMap(entry => entry.clis))], ownSignIn: true } : {});
    const chosen = candidates.map(candidate => ({ candidate, target: topTargetOf(candidate.spawn, onServer) })).find(entry => entry.target !== null);
    if (!chosen) return { started: false, code: 'noRoute', ...(dropped.length ? { detail: dropped.join('; ') } : {}) };
    const { candidate } = chosen;
    const spawn = candidate.spawn;
    const server = onServer ? servers.find(entry => entry.clis.includes(spawn.provider))!.label : null;
    const decisionId = randomUUID().slice(0, 8);
    const launchOptions: Spawn['launchOptions'] = {};
    for (const [pluginId, values] of Object.entries(spawn.launchOptions)) if (pluginId !== ASSISTANT_ID) launchOptions[pluginId] = { ...values };
    launchOptions[ASSISTANT_ID] = { model: this.bindings.bindTop(spawn.provider, chosen.target!, decisionId, expectedOf({ launchOptions })) };
    const label = `${spawn.provider} · ${candidate.label}${spawn.model ? ` · ${spawn.model}` : ''}${spawn.effort ? `@${spawn.effort}` : ''}${server ? ` · ${server}` : ''}`.slice(0, 160);
    let sessionId: string | null = null;
    try {
      const created = await this.host.callHost('sessions.create', {
        provider: spawn.provider, cwd, role: 'orchestrator', title: text(input.title, 80) || 'Auto (Jev)', launchOptions,
        ...(server ? { environment: { pluginId: 'canvastty-environments', kind: 'ssh-host', options: { host: server } } } : {})
      }) as { sessionId?: unknown };
      sessionId = typeof created?.sessionId === 'string' ? created.sessionId : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not allowed this plugin to start orchestrators/iu.test(message)) return { started: false, code: 'consent' };
      return { started: false, code: 'refused', detail: message.replace(/[\u0000-\u001f\u007f]+/gu, ' ').slice(0, 240) };
    }
    if (!sessionId) return { started: false, code: 'refused' };
    // Marked before its launch is prepared too: its subagents are routed, within the plan's child count.
    this.bindings.markAuto(sessionId);
    this.bindings.setPlan(sessionId, plan.children);
    // The person typed this task on the Assistant's page: their own text for this orchestrator (by its full session id)
    // and for the trust chain of its subagents, as a task typed in the launcher's Task field would be.
    this.review.notePersonStart(sessionId, task);
    // The agent tree shows the route this decision chose (model, account or plan, its cost basis), by full session id.
    const treeRoute: TreeRoute = { model: candidate.model, identity: candidate.identity, kind: candidate.kind, label: candidate.label, costBasis: candidate.costBasis, estimate: candidate.estimate };
    this.started.set(sessionId, { server, provider: spawn.provider, route: treeRoute });
    while (this.started.size > 64) this.started.delete(this.started.keys().next().value!);
    // The first prompt is typed once the launch started (CanvasTTY waits for it); the person sees the card meanwhile.
    void this.host.callHost('sessions.send', { sessionId, text: `${task.replace(/\s*\n\s*/gu, ' ')} — ${AUTOPILOT_PROMPT} ${planText(plan)}` }).catch(() => undefined);
    return { started: true, sessionId, provider: spawn.provider, route: label, kind: candidate.kind, server, plan: { mode: plan.mode, children: plan.children } };
  }

  /**
   * The main agent or one of its project agents (conductor-design.md §3.3, §3.4): Jev routing among the CLIs whose
   * agents reach this plugin's tools (Claude Code, Codex, Qwen Code, OpenCode). The main agent goes on the strongest
   * route, flat-rate first (a subscription, a coding plan, the CLI's own sign-in, a plan account); a project agent on
   * what Jev chooses for its task, with its plan. Started like "Start with Auto (Jev)": bound to the decision,
   * `sessions.create {role: "orchestrator"}` in the given folder, only with the person's "May start orchestrators".
   */
  async startTop(input: { kind: 'conductor' | 'lead'; task: string; cwd: string; title: string }): Promise<TopStart> {
    const task = planTask(input.task);
    if (!task || !input.cwd) return { started: false, code: 'input' };
    if (!this.harness.settings.routing) return { started: false, code: 'routingOff' };
    if (!await this.orchestratorsSupported()) return { started: false, code: 'core' };
    const dataClass = this.settings.defaultDataClass;
    let plan: AutopilotPlan | null = null;
    let view: TurnView;
    if (input.kind === 'lead') {
      const planned = await this.planOf(task, dataClass, 'conductor-lead');
      plan = planned.plan;
      view = planned.decision ? turnView(planned.decision, 'jev', task, { role: 'orchestrator' }) : turnView({ difficulty: ruleDifficulty(task), strong: false }, 'rules', task, { role: 'orchestrator' });
    } else view = turnView({ difficulty: 'hard', strong: true }, 'rules', task, { role: 'orchestrator' });
    const { candidates, dropped } = await this.routing.orchestratorRoutes(view, dataClass, { clis: TOOL_CLIS });
    const ordered = input.kind === 'conductor' ? [...candidates].sort((a, b) => Number(flatRate(b)) - Number(flatRate(a))) : candidates;
    const chosen = ordered.map(candidate => ({ candidate, target: topTargetOf(candidate.spawn, false) })).find(entry => entry.target !== null && (TOOL_CLIS as readonly string[]).includes(entry.candidate.spawn.provider));
    if (!chosen) return { started: false, code: 'noRoute', ...(dropped.length ? { detail: dropped.join('; ').slice(0, 240) } : {}) };
    const { candidate } = chosen;
    const spawn = candidate.spawn;
    const launchOptions: Spawn['launchOptions'] = {};
    for (const [pluginId, values] of Object.entries(spawn.launchOptions)) if (pluginId !== ASSISTANT_ID) launchOptions[pluginId] = { ...values };
    launchOptions[ASSISTANT_ID] = { model: this.bindings.bindTop(spawn.provider, chosen.target!, randomUUID().slice(0, 8), expectedOf({ launchOptions })) };
    let sessionId: string | null = null;
    try {
      const created = await this.host.callHost('sessions.create', { provider: spawn.provider, cwd: input.cwd, role: 'orchestrator', title: text(input.title, 80) || 'Auto (Jev)', launchOptions }) as { sessionId?: unknown };
      sessionId = typeof created?.sessionId === 'string' ? created.sessionId : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not allowed this plugin to start orchestrators/iu.test(message)) { this.orchestratorConsent = { at: Date.now(), state: 'missing' }; return { started: false, code: 'consent' }; }
      return { started: false, code: 'refused', detail: message.replace(/[\u0000-\u001f\u007f]+/gu, ' ').slice(0, 240) };
    }
    if (!sessionId) return { started: false, code: 'refused' };
    this.orchestratorConsent = { at: Date.now(), state: 'ok' };
    this.bindings.markAuto(sessionId);
    // The main agent starts nobody; a project agent within its plan's child count.
    this.bindings.setPlan(sessionId, plan ? plan.children : 0);
    const treeRoute: TreeRoute = { model: candidate.model, identity: candidate.identity, kind: candidate.kind, label: candidate.label, costBasis: candidate.costBasis, estimate: candidate.estimate, signIn: candidate.signIn, cli: candidate.cli };
    this.started.set(sessionId, { server: null, provider: spawn.provider, route: treeRoute });
    while (this.started.size > 64) this.started.delete(this.started.keys().next().value!);
    const route: LeadRoute = { cli: spawn.provider, kind: candidate.kind, label: `${spawn.provider} · ${candidate.label}${spawn.model ? ` · ${spawn.model}` : ''}${spawn.effort ? `@${spawn.effort}` : ''}`.slice(0, 160), model: spawn.model ?? candidate.model ?? null, effort: spawn.effort ?? candidate.effort ?? null, signIn: candidate.signIn, accountId: candidate.accountId ?? null };
    return { started: true, sessionId, route, planLine: plan ? planText(plan) : null };
  }

  /**
   * The account a route runs on and the quota left there, for status lines and the agent tree: a model account or
   * a pool from Accounts' quota share (accounts.quota, accounts.routes; the last answers, no read here), a CLI's own
   * subscription from CanvasTTY's limit windows (the tightest window not yet reset).
   */
  accountOf(route: Pick<LeadRoute, 'cli' | 'kind' | 'label' | 'signIn'> & { accountId?: string | null }): { account: string | null; quota: { percent: number | null; resetsAt: number | null } | null } {
    const signIn = route.signIn ?? '';
    const ru = this.locale === 'ru';
    const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    if (signIn.startsWith('account:')) {
      const id = route.accountId || signIn.slice(8);
      const answer = record(this.accounts.peekQuota());
      const rows = [...(Array.isArray(answer?.accounts) ? answer.accounts : []), ...(Array.isArray(answer?.poolAccounts) ? answer.poolAccounts : [])].map(record).filter((row): row is Record<string, unknown> => !!row);
      const row = rows.find(entry => entry.accountId === id);
      const quota = row ? accountQuotaFrom(row.quota) : undefined;
      const label = row && typeof row.account === 'string' && row.account.trim() ? row.account.trim().slice(0, 60) : route.label.replace(/ · [^·]*$/u, '').slice(0, 60);
      return { account: label, quota: quota ? { percent: quota.remainingPercent, resetsAt: quota.resetsAt } : null };
    }
    if (signIn.startsWith('pool:')) {
      const pool = this.accounts.peekRoutes()?.pools.find(entry => entry.cli === signIn.slice(5));
      return { account: pool?.label ?? route.label.replace(/ \(\d+\/\d+ free\)$/u, '').slice(0, 60), quota: pool?.quota ? { percent: pool.quota.remainingPercent, resetsAt: pool.quota.resetsAt } : null };
    }
    if (route.kind === 'auto') return { account: 'Auto (Jev)', quota: null };
    const own = route.kind === 'cli-default' ? (ru ? 'своя подписка' : 'own sign-in') : route.label.slice(0, 60);
    // CanvasTTY's windows are the CLI's default sign-in: a subscription on it, or the CLI's own default.
    if (route.kind === 'subscription' || route.kind === 'cli-default') {
      const limits = this.routing.limits?.providers.find(entry => entry.provider === route.cli);
      const now = Date.now();
      const open = (limits?.state === 'available' ? limits.windows : []).filter(window => window.resetsAt === null || window.resetsAt > now);
      if (open.length) {
        const tight = open.reduce((a, b) => b.usedPercent > a.usedPercent ? b : a);
        return { account: own, quota: { percent: Math.max(0, 100 - tight.usedPercent), resetsAt: tight.resetsAt } };
      }
    }
    return { account: own, quota: null };
  }

  /** The agent tree's account and quota for a card: its route decision, its start, or its Auto sign-in. */
  private treeAccount(id: string): TreeAccount | null {
    const route = this.routing.routeOf(id) ?? this.started.get(id)?.route ?? null;
    const lead = this.conductor.routeOf(id);
    const card = this.sessions.get(id);
    let found: ReturnType<Assistant['accountOf']> | null = null;
    if (lead) found = this.accountOf(lead);
    else if (route?.signIn && route.cli) found = this.accountOf({ cli: route.cli, kind: route.kind, label: route.label, signIn: route.signIn, accountId: route.signIn.startsWith('account:') ? route.signIn.slice(8) : null });
    else if (this.autoTop.has(id) && card) found = this.accountOf({ cli: card.provider, kind: 'subscription', label: this.autoTop.get(id)!.label, signIn: `cli:${card.provider}` });
    return found?.account ? { label: found.account, quota: found.quota } : null;
  }

  private sharesAskedAt = 0;
  /** The person's "May start orchestrators" for this plugin, last seen (a probe or a start). */
  private orchestratorConsent: { at: number; state: 'ok' | 'missing' | 'unsupported' } | null = null;

  /**
   * Whether the person allowed this plugin to start orchestrators, asked without starting anything: CanvasTTY checks
   * the role and that consent before the CLI and the folder, so a call without them is refused for one or the other.
   */
  private async orchestratorsAllowed(): Promise<'ok' | 'missing' | 'unsupported'> {
    if (this.orchestratorConsent && Date.now() - this.orchestratorConsent.at < 15_000) return this.orchestratorConsent.state;
    // An older core ignores the role and refuses for the missing CLI: not "allowed".
    if (!await this.orchestratorsSupported()) return 'unsupported';
    let state: 'ok' | 'missing' | 'unsupported';
    try { await this.host.callHost('sessions.create', { role: 'orchestrator' }); state = 'ok'; } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state = /not allowed this plugin to start orchestrators/iu.test(message) ? 'missing' : /role must be agent or orchestrator|does not have the sessions:launch permission|unknown host method/iu.test(message) ? 'unsupported' : 'ok';
    }
    this.orchestratorConsent = { at: Date.now(), state };
    return state;
  }

  /**
   * The setup checklist on the Assistant page (conductor-design.md §2.1, "this week, without core"): what the main
   * agent needs and what is missing, each with the CanvasTTY grant that gives it (for a host that offers
   * `grants.request`, C2) and the Settings section where the person gives it today. Read from what this service
   * already sees: the routing switch, the orchestrator consent probe, Accounts' shared reads, the brokered accounts,
   * CanvasTTY's environments. Nothing here grants anything.
   */
  async setupChecklist(): Promise<{ items: SetupItem[]; ready: boolean }> {
    // Accounts' shared reads were refused or not read yet: asked again (the person may have just allowed them), at most
    // every 10 s; otherwise the last answer stands.
    if (this.accounts.mode !== 'ready' && Date.now() - this.sharesAskedAt > 10_000) {
      this.sharesAskedAt = Date.now();
      await this.accounts.quota(60_000, 800, true).catch(() => null);
    }
    const accountsState = this.accounts.state();
    const [orchestrators, brokered, listed] = await Promise.all([
      this.orchestratorsAllowed(),
      this.auto.broker.list().catch(() => []),
      this.providers.list(60_000, 800).catch(() => null)
    ]);
    const reason = accountsState.reason ?? '';
    const accountsRunning: ItemState = accountsState.mode === 'ready' || /^not_(approved|declared|shared)$/u.test(reason) ? 'ok'
      : /provider_unavailable|not_running|not_installed|disabled/u.test(reason) ? 'missing' : accountsState.mode === 'unsupported' ? 'unsupported' : 'unknown';
    const shares: ItemState = accountsState.mode === 'ready' ? 'ok' : /^not_approved$/u.test(reason) ? 'missing' : accountsState.mode === 'unsupported' ? 'unsupported' : 'unknown';
    const brokerState: ItemState = this.auto.broker.mode === 'unsupported' ? 'unsupported' : brokered.length ? 'ok' : this.auto.broker.mode === 'ready' ? 'missing' : 'unknown';
    const environments: ItemState = listed ? listed.environments.some(entry => entry.pluginId === 'canvastty-environments') ? 'ok' : 'unknown' : 'unknown';
    const items: SetupItem[] = [
      { id: 'routing', state: this.harness.settings.routing ? 'ok' : 'missing', section: 'page' },
      { id: 'orchestrators', state: orchestrators, section: 'native-code', grants: [{ kind: 'mayStartOrchestrators' }] },
      { id: 'projects', state: this.conductor.settings.projects.length ? 'ok' : 'missing', section: 'page', count: this.conductor.settings.projects.length },
      { id: 'accounts', state: accountsRunning, optional: true, section: 'native-code', grants: [{ kind: 'nativeCode', plugin: ACCOUNTS_ID }] },
      { id: 'shares', state: shares, optional: true, section: 'native-code', grants: [{ kind: 'sharedRead', provider: ACCOUNTS_ID, method: 'accounts.routes' }, { kind: 'sharedRead', provider: ACCOUNTS_ID, method: 'accounts.quota' }] },
      { id: 'broker', state: brokerState, optional: true, section: 'broker', count: brokered.length, grants: [{ kind: 'brokerGrant', owner: ACCOUNTS_ID, account: '*' }] },
      { id: 'decisions', state: 'unknown', optional: true, section: 'native-code', grants: [{ kind: 'decisionsMayAllow' }] },
      { id: 'environments', state: environments, optional: true, section: 'native-code', grants: [{ kind: 'nativeCode', plugin: 'canvastty-environments' }] },
      // The owner's choice: updates from the same repository keep trust for the Assistant and Environments, never for
      // Accounts (it holds the keys).
      { id: 'trustUpdates', state: 'unknown', optional: true, section: 'native-code', grants: [{ kind: 'trustUpdates', plugin: ASSISTANT_ID }, { kind: 'trustUpdates', plugin: 'canvastty-environments' }] },
      { id: 'widget', state: 'unknown', optional: true, section: 'home' }
    ];
    return { items, ready: items.every(item => item.optional || item.state === 'ok') };
  }

  /** The Assistant page's "main agent" section and the HOME widget. */
  async conductorState(): Promise<unknown> {
    const view = this.conductor.view();
    return {
      settings: this.conductor.settings, folder: this.conductor.folder, ...view, suggestions: this.conductor.suggestions(),
      checklist: await this.setupChecklist(), routing: this.harness.settings.routing
    };
  }

  /**
   * start_leaf (D6, Phase 1): an independent leaf task on a server the person declared (Advanced, off by default),
   * as a card this plugin starts there (Environments ssh-host) on that server's own CLI sign-in. Only a leaf: it
   * cannot start subagents. Nothing from this computer's sign-ins or keys reaches the server.
   */
  private async startLeaf(caller: SessionSummary | undefined, input: Record<string, unknown>): Promise<{ content: unknown; isError?: boolean }> {
    if (!caller || typeof caller.id !== 'string') return { content: 'CanvasTTY did not say which card is calling.', isError: true };
    const route = this.routing.settings;
    if (!route.serversOn || !route.servers.length) return { content: 'Servers are off in the Assistant settings: run this part with pick_route and spawn_agent here.', isError: true };
    const task = text(input.task, 4_000);
    const cwd = text(input.cwd, 4_096);
    if (!task || !cwd) return { content: 'Give `task` and `cwd` (the project folder as on the server).', isError: true };
    const wanted = text(input.server, 64);
    const cli = text(input.provider, 40);
    const running = (label: string): number => [...this.leaves.values()].filter(leaf => leaf.server === label).length;
    const server = route.servers.find(entry => (!wanted || entry.label === wanted) && (!cli || entry.clis.includes(cli)) && running(entry.label) < entry.maxParallel);
    if (!server) return { content: wanted ? `Server ${wanted} is not declared, has no ${cli || 'such'} CLI, or is full now.` : 'No declared server has room now: run this part here with pick_route and spawn_agent.', isError: true };
    const provider = cli && server.clis.includes(cli) ? cli : server.clis[0]!;
    try {
      const created = await this.host.callHost('sessions.create', {
        provider, cwd, title: text(input.title, 80) || 'Leaf task',
        launchOptions: { [ASSISTANT_ID]: { model: 'off' } },
        environment: { pluginId: 'canvastty-environments', kind: 'ssh-host', options: { host: server.label } }
      }) as { sessionId?: unknown };
      const sessionId = typeof created?.sessionId === 'string' ? created.sessionId : null;
      if (!sessionId) return { content: 'CanvasTTY did not start the card.', isError: true };
      this.leaves.set(sessionId, { parent: caller.id, server: server.label, provider });
      await this.host.callHost('sessions.send', { sessionId, text: task });
      return { content: `Started on ${server.label} (${provider}, its own sign-in). Check it with leaf_status {sessionId:"${sessionId}"}.\n${JSON.stringify({ sessionId, server: server.label, provider })}` };
    } catch (error) {
      return { content: `CanvasTTY refused the card: ${error instanceof Error ? error.message.slice(0, 200) : 'error'}.`, isError: true };
    }
  }

  private leafStatus(caller: SessionSummary | undefined, input: Record<string, unknown>): { content: unknown; isError?: boolean } {
    const sessionId = text(input.sessionId, 80);
    const leaf = this.leaves.get(sessionId);
    if (!caller || !leaf || leaf.parent !== caller.id) return { content: 'No leaf card of yours with that sessionId.', isError: true };
    const session = this.sessions.get(sessionId) as (SessionSummary & { status?: string; exitCode?: number | null }) | undefined;
    return { content: JSON.stringify({ sessionId, server: leaf.server, provider: leaf.provider, status: session?.status ?? 'unknown', exitCode: session?.exitCode ?? null }) };
  }

  /** pick_route for a caller in an Auto tree: each option's spawn carries a single-use route value. */
  private bindSpawn(callerId: string, spawn: Spawn, decisionId: string, orchestrate: boolean): Spawn | null {
    if (!this.bindings.isAuto(callerId)) return null;
    const next: Spawn = { ...spawn, launchOptions: { ...spawn.launchOptions } };
    let target: ChildTarget = spawn.launchOptions[ASSISTANT_ID]?.model === 'auto' ? 'auto' : 'off';
    // An OpenCode coding-plan model is pinned by the Assistant (the model travels in its option, not next to it).
    if (target === 'off' && spawn.provider === 'opencode' && spawn.model && /^[a-z0-9][a-z0-9._-]*\//u.test(spawn.model)) {
      target = `plan:${spawn.model}`;
      delete next.model;
    }
    // The launch must then ask for exactly this (checked where the core shows it: model, effort, the account).
    next.launchOptions[ASSISTANT_ID] = { model: this.bindings.bind(callerId, spawn.provider, target, decisionId, orchestrate, expectedOf(next)) };
    return next;
  }

  /**
   * Jev's view of one Auto turn: the existing task triage (task.route) on the latest user text only, through the
   * engine (data-class gate, budget, cache, breaker, log). Only while task triage is Suggest or Auto; otherwise, or
   * without an answer, null and the router uses word rules.
   */
  private async turnDifficulty(task: string, dataClass: DataClass, sessionId: string, role: string, signal: AbortSignal): Promise<TurnDecision | null> {
    const mode = this.engine.mode('task.route');
    if (mode !== 'suggest' && mode !== 'auto') return null;
    const { triage } = await askTaskRoute(this.engine, { task, dataClass }, {
      signal, assertCurrent: () => { if (signal.aborted) throw new Error('aborted'); }, requester: role === 'subagent' ? 'orchestrator' : 'person', sessionId
    });
    // Difficulty and task type from the same ten answers (kind → type inside its band; difficulty with its
    // probabilities, so "small" can require high confidence).
    return triage ? decisionFromTriage(triage, ROUTE_TAUS.strong) : null;
  }

  private async triage(sessionId: string, task: string, dataClass: DataClass | null, cwd: string): Promise<void> {
    const advice = await this.advice(task, dataClass, cwd, sessionId).catch(() => null);
    if (!advice || advice.kind !== 'advice') { this.review.noteTriage(sessionId, false); return; }
    this.review.noteTriage(sessionId, advice.advice.reviewStrict);
    this.triaged.delete(sessionId); this.triaged.set(sessionId, advice.advice);
    while (this.triaged.size > 512) this.triaged.delete(this.triaged.keys().next().value!);
    await this.harness.setBadge(sessionId, 'triage', () => triageBadge(advice.advice, this.harness.strings));
  }

  /** task.route + the policy. `kind` says why there is no advice (off, learning, no answer). */
  /** `requester`: who wrote the task text: the person (the launch form) or an agent (`recommend`, `route`). */
  async advice(task: string, dataClass: DataClass | null, cwd: string, sessionId?: string, deadlineMs = TRIAGE_DEADLINE_MS, requester: 'person' | 'orchestrator' | 'agent' = 'person'): Promise<{ kind: 'advice'; advice: Advice; model: string | null } | { kind: 'off' | 'learning' | 'unavailable'; reason: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    try {
      const { decision, triage } = await askTaskRoute(this.engine, { task, dataClass: dataClass ?? this.settings.defaultDataClass }, {
        signal: controller.signal, assertCurrent: () => undefined, requester, ...(sessionId ? { sessionId } : {})
      });
      if (decision.branch === 'off') return { kind: 'off', reason: null };
      // Learning shows nothing, whether a model answered (recorded) or not.
      if (decision.mode === 'shadow') return { kind: 'learning', reason: null };
      if (!triage) return { kind: 'unavailable', reason: decision.fallbackReason };
      const git = isGitRepository(cwd);
      return { kind: 'advice', advice: advise(triage, { explicit: {}, isGitRepo: git, mentionedExistingPaths: git ? mentionedExistingPaths(task, cwd) : 0 }), model: decision.backend?.modelLabel ?? null };
    } finally { clearTimeout(timer); }
  }

  // -------------------------------------------------------------------------
  // EP-6: orchestrator tools
  // -------------------------------------------------------------------------

  async tool(name: string, caller: SessionSummary | undefined, input: Record<string, unknown>): Promise<{ content: unknown; isError?: boolean }> {
    if (name === 'projects' || name === 'report_to_main') return this.conductor.tool(name, caller, input);
    if (this.harness.handles(name)) return this.harness.tool(name, caller, input);
    if (this.routing.handles(name)) {
      if (!caller || typeof caller.id !== 'string') return { content: 'CanvasTTY did not say which card is calling.', isError: true };
      return this.routing.tool(name, caller, input);
    }
    if (name === 'autopilot_plan') return this.autopilotPlan(caller, input);
    if (name === 'start_leaf') return this.startLeaf(caller, input);
    if (name === 'leaf_status') return this.leafStatus(caller, input);
    if (name === 'recommend') {
      const task = text(input.task, 2_000);
      if (!task) return { content: 'Give the task text in `task`.', isError: true };
      const cwd = caller?.workingDirectory || caller?.cwd || process.cwd();
      // CanvasTTY gives a tool 15 s; the advice must come back before that.
      const answer = await this.advice(task, null, cwd, caller?.id, TOOL_ADVICE_DEADLINE_MS, requesterOf(caller?.role));
      if (answer.kind === 'off') return { content: 'The Assistant\'s task triage is off (Assistant settings in CanvasTTY).' };
      if (answer.kind === 'learning') return { content: 'The Assistant\'s task triage is learning and gives no advice yet.' };
      if (answer.kind !== 'advice') return { content: `No decision model answered (${answer.reason ?? 'unavailable'}); decide as you would without the Assistant.` };
      const a = answer.advice;
      const lines = [
        `Category: ${a.category}; difficulty: ${a.difficulty}${a.strongModel ? ' (design-level: use the strongest model you have)' : ''}.`,
        `Isolation: ${a.isolation === 'direct' ? 'none needed' : `run it in a ${a.isolation}`}${a.reasons.length ? ` (${a.reasons.join(', ')})` : ''}.`,
        a.reviewStrict ? 'Risky task: expect command review to ask the person for anything but read-only commands.' : 'Command review: normal.',
        a.suggestOrchestrator ? 'It splits into independent parts: spawn one subagent per part.' : '',
        a.underspecified ? 'The task misses information: ask before starting.' : ''
      ].filter(Boolean);
      return { content: `${lines.join('\n')}\n${JSON.stringify({ ...a, model: answer.model })}` };
    }
    if (name === 'review_status') {
      const status = await this.engine.status();
      // The caller's own card and every card below it, by full session id (never by prefix).
      const recent = (caller && typeof caller.id === 'string' ? this.review.recentFor(this.treeBelow(caller.id)) : []).slice(0, 10).map(({ at, session, summary, act, outcome, tier, reason }) => ({ at: new Date(at).toISOString(), session, summary, act, outcome, tier, reason }));
      return {
        content: JSON.stringify({
          enabled: this.settings.enabled, commandReview: this.engine.mode('command.review'), triage: this.engine.mode('task.route'), strictness: this.settings.reviewStrictness,
          backends: status.backends.map(({ id, preset, enabled, target, tested, breaker }) => ({ id, preset, enabled, target, tested, breaker: breaker.state })),
          recent
        })
      };
    }
    return { content: `Unknown tool ${name.slice(0, 40)}.`, isError: true };
  }

  // -------------------------------------------------------------------------
  // EP-1: the settings page (never a key; keys are write-only from the page)
  // -------------------------------------------------------------------------

  async state(): Promise<unknown> {
    const status = await this.engine.status().catch(() => ({ enabled: this.settings.enabled, backends: [] }));
    const slots = Object.fromEntries(this.settings.backends.map(entry => { try { return [entry.id, this.engine.keySlot(entry.id)]; } catch { return [entry.id, null]; } }));
    return { settings: this.settings, status, slots, checks: Object.fromEntries(this.checks), recent: this.review.recent() };
  }

  /**
   * The harness page: its four controls (command review here, the rest in the harness) and nothing else. A command
   * review the levels do not describe exactly is `custom`, with what it is, shown read-only until a level is chosen.
   */
  /**
   * The Agent tree card: who started whom, with each card's model, status, task, route cost and times. Built on
   * request from what the service already holds; nothing is stored for it.
   */
  async treeView(): Promise<TreeView & { focus: string | null; now: number }> {
    const cards = this.harness.cards();
    // Measured tokens per card where the core says (usage:read), read within a short deadline; older answers stay.
    await this.usage.refreshCards(cards.map(card => card.id).slice(0, 64));
    const { catalog } = (() => { try { return this.auto.routingIndex(); } catch { return { catalog: null }; } })();
    const perTask = TASK_TOKENS.medium.input + TASK_TOKENS.medium.output;
    const view = buildTree({
      cards,
      usage: id => {
        const used = this.usage.peekCard(id);
        if (!used) return null;
        const route = this.routing.routeOf(id);
        const identity = route?.identity ?? null;
        const usd = route && route.costBasis === 'api' && catalog ? measuredUsd(used.totals, apiPrice(catalog, identity)) : null;
        const tokens = effectiveTokens(used.totals);
        return {
          tokens: Math.round(tokens), input: used.totals.input, output: used.totals.output, cached: used.totals.cached,
          usd, share: Math.round((tokens * this.routing.settings.expectedShare.medium / perTask) * 100) / 100,
          ...(used.totals.providerCostEstimate !== undefined ? { providerEstimate: Math.round(used.totals.providerCostEstimate * 10_000) / 10_000 } : {})
        };
      },
      route: id => this.routing.routeOf(id) ?? this.started.get(id)?.route ?? null,
      refused: id => this.refused.has(id),
      // Model: Auto (Jev): the models its calls used through the router, and what they cost there.
      auto: id => {
        const used = this.auto.treeAuto(id);
        if (!used) return null;
        const share = used.plan ? Math.round((used.tokens * this.routing.settings.expectedShare.medium / perTask) * 100) / 100 : null;
        return { models: used.models, plan: used.plan, usd: used.usd, share };
      },
      task: id => this.review.taskOf(id) ?? this.conductor.taskOf(id),
      account: id => this.treeAccount(id),
      planChildren: id => this.bindings.planOf(id),
      endedAt: id => this.harness.finished(id),
      autoTop: id => this.autoTop.get(id) ?? null
    }, { focus: this.harness.treeFocus() });
    return { ...view, focus: this.harness.treeFocus(), now: Date.now() };
  }

  harnessState(): { commandReview: CommandReviewState; custom: { mode: string; strictness: string } | null; settingsUnavailable: boolean; routing: boolean; loopAlerts: boolean; flows: boolean; trustChain: boolean; models: number } {
    const level = commandReviewLevel(this.settings);
    return {
      commandReview: level,
      custom: level === 'custom' ? { mode: this.settings.modes['command.review'], strictness: this.settings.reviewStrictness } : null,
      settingsUnavailable: !this.settingsReadable || !this.harnessReadable,
      ...this.harness.settings, models: this.settings.backends.filter(entry => entry.enabled).length
    };
  }

  private fail(code: ConstructorParameters<typeof HarnessError>[0]): never { throw new HarnessError(code, this.locale); }

  async saveHarness(value: unknown): Promise<unknown> {
    if (!this.settingsReadable || !this.harnessReadable) this.fail('settingsUnavailable');
    const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const { commandReview, ...rest } = record;
    const current = commandReviewLevel(this.settings);
    // "custom" is only "leave it as it is", and only while it is custom.
    const keep = commandReview === 'custom' && current === 'custom';
    if (!keep && !COMMAND_REVIEW_LEVELS.includes(commandReview as CommandReviewLevel)) this.fail('reviewLevel');
    await this.harness.saveSettings(rest);
    if (!keep && commandReview !== current) await this.save(withCommandReview(this.settings, commandReview as CommandReviewLevel));
    else this.host.emit('settings', null);
    return this.harnessState();
  }

  /** Both pages save here; both listen for `settings` and reload. */
  async save(value: unknown): Promise<AssistantSettings> {
    if (!this.settingsReadable) this.fail('settingsUnavailable');
    const next = validateAssistantSettings(value);
    await this.host.callHost('storage.set', { key: SETTINGS_KEY, value: next });
    this.settings = next;
    this.engine.settingsChanged();
    this.host.emit('settings', null);
    return next;
  }

  /** A later read of the stored settings succeeded (after a storage error at start): they apply now. */
  storageRecovered(stored: { settings?: unknown; harness?: unknown; autoRouting?: unknown; routing?: unknown; conductor?: unknown }): void {
    if ('settings' in stored) {
      this.settings = normalizeAssistantSettings(stored.settings);
      this.settingsReadable = true;
      this.engine.settingsChanged();
    }
    if ('harness' in stored) { this.harness.loadSettings(stored.harness); this.harnessReadable = true; }
    if ('autoRouting' in stored) this.auto.loaded(stored.autoRouting);
    if ('routing' in stored) this.routing.loaded(stored.routing);
    if ('conductor' in stored) this.conductor.loaded(stored.conductor);
    this.host.emit('settings', null);
  }

  /** «Проверить»: the synthetic battery (no user data). It can take longer than a page request, so the answer is an event. */
  check(backendId: string): { running: true } {
    if (!this.settings.backends.some(entry => entry.id === backendId)) throw new Error('Unknown backend.');
    this.checks.set(backendId, { running: true });
    void this.engine.check(backendId).then(
      result => { this.checks.set(backendId, result); this.host.emit('check', result); },
      (error: unknown) => {
        const failed = { error: error instanceof Error ? error.message.slice(0, 200) : 'The check failed.' };
        this.checks.set(backendId, failed);
        this.host.emit('check', { backendId, ...failed });
      });
    return { running: true };
  }

  /**
   * The short view's Jev key was saved (the person's click): Jev decides turns from now on when task triage was Off.
   * The key serves Jev only; Auto never sends model calls to OpenRouter. Nothing else changes.
   */
  async quickKeySaved(backendId: string): Promise<null> {
    this.keyChanged(backendId);
    if (this.settings.modes['task.route'] === 'off') {
      const next = structuredClone(this.settings);
      next.modes['task.route'] = 'auto';
      next.enabled = true;
      await this.save(next);
    }
    return null;
  }

  keyChanged(backendId: string): void {
    const slot = this.engine.keySlot(backendId);
    if (slot) this.generations.set(slot.secret, (this.generations.get(slot.secret) ?? 0) + 1);
    this.engine.keyChanged();
  }
}

function suggestionBadge(verdict: CommandReviewVerdict, summary: string, strings: ServiceStrings): { text: string; tone: 'info' | 'warn'; tooltip: string } | null {
  if (verdict.outcome === 'allow') return { text: strings.reviewFine, tone: 'info', tooltip: strings.reviewTip(summary) };
  if (verdict.outcome === 'deny') return { text: strings.reviewRisky, tone: 'warn', tooltip: strings.reviewTip(summary) };
  if (verdict.reason === 'unavailable') return null;
  return { text: strings.reviewAsk, tone: 'warn', tooltip: strings.reviewTip(`${summary} (${verdict.reason})`) };
}

function triageBadge(advice: Advice, strings: ServiceStrings): { text: string; tone: 'info' | 'warn'; tooltip: string } {
  const t = strings.triage;
  const label = `${t.difficulty[advice.difficulty] ?? advice.difficulty} · ${t.category[advice.category] ?? advice.category}`.slice(0, 24);
  const hints = [
    advice.isolation !== 'direct' ? t.isolation(advice.isolation) : '',
    advice.reviewStrict ? t.strict : '',
    advice.strongModel ? t.strong : '',
    advice.suggestOrchestrator ? t.split : '',
    advice.underspecified ? t.missing : ''
  ].filter(Boolean);
  return { text: label, tone: advice.reviewStrict || advice.isolation !== 'direct' ? 'warn' : 'info', tooltip: t.tip(hints.join('; ')).slice(0, 200) };
}

/** Who wrote a tool's task text: an orchestrator or another agent, never the person. */
function requesterOf(role: unknown): 'orchestrator' | 'agent' { return role === 'orchestrator' ? 'orchestrator' : 'agent'; }

/** A flat-rate route (paid for already): a subscription, a coding plan, the CLI's own sign-in, a plan account. */
function flatRate(candidate: Candidate): boolean {
  return candidate.kind === 'subscription' || candidate.kind === 'coding-plan' || candidate.kind === 'cli-default' || candidate.costBasis === 'plan' || candidate.costBasis === 'flat';
}

export type ItemState = 'ok' | 'missing' | 'unknown' | 'unsupported';
/** One CanvasTTY grant, in the shape `grants.request` (C2) takes. */
export type GrantItem =
  | { kind: 'nativeCode'; plugin: string } | { kind: 'mayStartOrchestrators' } | { kind: 'decisionsMayAllow' }
  | { kind: 'sharedRead'; provider: string; method: string } | { kind: 'brokerGrant'; owner: string; account: string } | { kind: 'trustUpdates'; plugin: string };
export interface SetupItem { id: string; state: ItemState; optional?: boolean; count?: number; section: 'page' | 'native-code' | 'broker' | 'home'; grants?: GrantItem[] }
