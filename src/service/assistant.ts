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
import { DEFAULT_MAX_PARALLEL } from '../route/settings.ts';

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
  /** Each card's effective data class, so a subagent's can be clamped to its parent's. */
  private readonly classes = new Map<string, DataClass>();
  /** Each card's triage advice, so its badge can be written again in another language. */
  private readonly triaged = new Map<string, Advice>();

  constructor(options: { host: Host; dataDir: string; settings?: unknown; settingsUnavailable?: boolean; harness?: unknown; harnessUnavailable?: boolean; autoRouting?: unknown; autoRoutingUnavailable?: boolean; routing?: unknown; routingUnavailable?: boolean; locale?: unknown; transport?: typeof fetch; catalogTransport?: typeof fetch; git?: null; now?: () => number; autoTimeouts?: RouterDeps['timeouts'] }) {
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
    this.routing = new RouteService({
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
    this.review = new ReviewService({
      engine: this.engine, settings: () => this.settings, locale, trustChain: () => this.harness.settings.trustChain,
      ...(options.git === null ? { git: null } : {}),
      suggest: (sessionId, verdict, summary) => { void this.harness.setBadge(sessionId, 'review', suggestionBadge(verdict, summary, this.harness.strings)); }
    });
  }

  get pageLocale(): Locale { return this.locale; }

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
    // Badges already on cards are written again in the new language.
    for (const [sessionId, advice] of this.triaged) void this.harness.setBadge(sessionId, 'triage', triageBadge(advice, this.harness.strings));
    return locale;
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
  }

  sessionEvent(event: { type?: unknown; session?: unknown }): void {
    const session = event.session as SessionSummary | undefined;
    if (!session || typeof session.id !== 'string') return;
    this.harness.sessionEvent(event);
    this.routing.sessionEvent(event);
    if (event.type === 'closed') { this.sessions.delete(session.id); this.review.forget(session.id); this.classes.delete(session.id); this.triaged.delete(session.id); this.auto.sessionClosed(session.id); return; }
    this.sessions.set(session.id, session);
  }

  // -------------------------------------------------------------------------
  // EP-5: the decision hook
  // -------------------------------------------------------------------------

  async decide(params: Record<string, unknown>): Promise<DecideAnswer> {
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
  async launch(context: LaunchContext): Promise<AutoPrepareAnswer | null> {
    if (context.chosen === false) return null;
    const options = context.options ?? {};
    const task = text(options.task, 2_000) || null;
    const requested = DATA_CLASSES.includes(options.dataClass as DataClass) ? options.dataClass as DataClass : null;
    // An orchestrator may choose these options for its subagents (delegable), but never a lower class than its own.
    const parentClass = context.role === 'subagent' && context.parentSessionId ? this.classes.get(context.parentSessionId) ?? null : null;
    const dataClass = requested ? clampClass(requested, parentClass) : parentClass;
    this.classes.set(context.sessionId, dataClass ?? this.settings.defaultDataClass);
    while (this.classes.size > 4_096) this.classes.delete(this.classes.keys().next().value!);
    const model = options.model ?? 'off';
    if (model !== 'off' && model !== 'auto') { const refusal = AUTO_STRINGS[this.locale].unknownValue; return { refuse: { reason: refusal } }; }
    const mode = this.engine.mode('task.route');
    const triage = !!task && (mode === 'suggest' || mode === 'auto' || mode === 'shadow');
    this.review.noteLaunch(context.sessionId, { task, dataClass, triage: triage && mode !== 'shadow', role: context.role, parentSessionId: context.parentSessionId ?? null });
    if (triage) void this.triage(context.sessionId, task!, dataClass, context.cwd);
    if (model !== 'auto') return null;
    return this.auto.prepare({
      sessionId: context.sessionId, provider: context.provider, role: context.role, cwd: context.cwd, parentSessionId: context.parentSessionId ?? null,
      environment: context.environment, dataClass: dataClass ?? this.settings.defaultDataClass
    });
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
    await this.harness.setBadge(sessionId, 'triage', triageBadge(advice.advice, this.harness.strings));
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
    if (this.harness.handles(name)) return this.harness.tool(name, caller, input);
    if (this.routing.handles(name)) {
      if (!caller || typeof caller.id !== 'string') return { content: 'CanvasTTY did not say which card is calling.', isError: true };
      return this.routing.tool(name, caller, input);
    }
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
      const mine = new Set([caller?.id, ...[...this.sessions.values()].filter(session => caller && session.parentSessionId === caller.id).map(session => session.id)].filter(Boolean).map(id => String(id).slice(0, 8)));
      const recent = this.review.recent().filter(entry => mine.has(entry.session)).slice(0, 10).map(({ at, session, summary, act, outcome, tier, reason }) => ({ at: new Date(at).toISOString(), session, summary, act, outcome, tier, reason }));
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
  storageRecovered(stored: { settings?: unknown; harness?: unknown; autoRouting?: unknown; routing?: unknown }): void {
    if ('settings' in stored) {
      this.settings = normalizeAssistantSettings(stored.settings);
      this.settingsReadable = true;
      this.engine.settingsChanged();
    }
    if ('harness' in stored) { this.harness.loadSettings(stored.harness); this.harnessReadable = true; }
    if ('autoRouting' in stored) this.auto.loaded(stored.autoRouting);
    if ('routing' in stored) this.routing.loaded(stored.routing);
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
