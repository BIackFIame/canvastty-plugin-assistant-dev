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
import { localeOf, type Locale, type ServiceStrings } from '../harness/i18n.ts';
import { commandReviewLevel, firstRunAssistantSettings, withCommandReview, COMMAND_REVIEW_LEVELS, type CommandReviewLevel } from '../harness/settings.ts';

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
  readonly harness: Harness;

  constructor(options: { host: Host; dataDir: string; settings?: unknown; harness?: unknown; locale?: unknown; transport?: typeof fetch; git?: null; now?: () => number }) {
    this.host = options.host;
    // Nothing saved yet: a fresh install starts with command review on Warn (see harness/settings.ts).
    this.settings = options.settings === null || options.settings === undefined ? firstRunAssistantSettings() : normalizeAssistantSettings(options.settings);
    const locale: Locale = localeOf(options.locale);
    this.harness = new Harness({
      host: options.host, dataDir: options.dataDir, locale, ...(options.now ? { now: options.now } : {}),
      publishBadge: (sessionId, badge) => this.host.callHost('cards.setBadge', { sessionId, badge }).then(() => undefined, () => undefined),
      modelDifficulty: async (task, caller, deadlineMs) => {
        const answer = await this.advice(task, null, caller.workingDirectory || caller.cwd || process.cwd(), caller.id, deadlineMs);
        return answer.kind === 'advice' ? answer.advice.difficulty : null;
      }
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
    this.review = new ReviewService({
      engine: this.engine, settings: () => this.settings,
      ...(options.git === null ? { git: null } : {}),
      suggest: (sessionId, verdict, summary) => { void this.harness.setBadge(sessionId, 'review', suggestionBadge(verdict, summary, this.harness.strings)); }
    });
  }

  /** A key the settings page wrote: `{ origin, value }` as JSON under the backend's secret name. */
  private async readKey(owner: string): Promise<{ origin: string; value: string } | null> {
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
  }

  sessionEvent(event: { type?: unknown; session?: unknown }): void {
    const session = event.session as SessionSummary | undefined;
    if (!session || typeof session.id !== 'string') return;
    this.harness.sessionEvent(event);
    if (event.type === 'closed') { this.sessions.delete(session.id); this.review.forget(session.id); return; }
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
  launch(context: LaunchContext): null {
    if (context.chosen === false) return null;
    const options = context.options ?? {};
    const task = text(options.task, 2_000) || null;
    const dataClass = DATA_CLASSES.includes(options.dataClass as DataClass) ? options.dataClass as DataClass : null;
    const mode = this.engine.mode('task.route');
    const triage = !!task && (mode === 'suggest' || mode === 'auto' || mode === 'shadow');
    this.review.noteLaunch(context.sessionId, { task, dataClass, triage: triage && mode !== 'shadow' });
    if (triage) void this.triage(context.sessionId, task!, dataClass, context.cwd);
    return null;
  }

  private async triage(sessionId: string, task: string, dataClass: DataClass | null, cwd: string): Promise<void> {
    const advice = await this.advice(task, dataClass, cwd, sessionId).catch(() => null);
    if (!advice || advice.kind !== 'advice') { this.review.noteTriage(sessionId, false); return; }
    this.review.noteTriage(sessionId, advice.advice.reviewStrict);
    await this.harness.setBadge(sessionId, 'triage', triageBadge(advice.advice));
  }

  /** task.route + the policy. `kind` says why there is no advice (off, learning, no answer). */
  async advice(task: string, dataClass: DataClass | null, cwd: string, sessionId?: string, deadlineMs = TRIAGE_DEADLINE_MS): Promise<{ kind: 'advice'; advice: Advice; model: string | null } | { kind: 'off' | 'learning' | 'unavailable'; reason: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    try {
      const { decision, triage } = await askTaskRoute(this.engine, { task, dataClass: dataClass ?? this.settings.defaultDataClass }, {
        signal: controller.signal, assertCurrent: () => undefined, requester: 'person', ...(sessionId ? { sessionId } : {})
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
    if (name === 'recommend') {
      const task = text(input.task, 2_000);
      if (!task) return { content: 'Give the task text in `task`.', isError: true };
      const cwd = caller?.workingDirectory || caller?.cwd || process.cwd();
      // CanvasTTY gives a tool 15 s; the advice must come back before that.
      const answer = await this.advice(task, null, cwd, caller?.id, TOOL_ADVICE_DEADLINE_MS);
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

  /** The harness page: its four controls (command review here, the rest in the harness) and nothing else. */
  harnessState(): { commandReview: CommandReviewLevel; routing: boolean; loopAlerts: boolean; flows: boolean; models: number } {
    return { commandReview: commandReviewLevel(this.settings), ...this.harness.settings, models: this.settings.backends.filter(entry => entry.enabled).length };
  }

  async saveHarness(value: unknown): Promise<unknown> {
    const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const { commandReview, ...rest } = record;
    if (!COMMAND_REVIEW_LEVELS.includes(commandReview as CommandReviewLevel)) throw new Error('Command review is Strict, Warn or Off.');
    await this.harness.saveSettings(rest);
    if (commandReview !== commandReviewLevel(this.settings)) await this.save(withCommandReview(this.settings, commandReview as CommandReviewLevel));
    return this.harnessState();
  }

  async save(value: unknown): Promise<AssistantSettings> {
    const next = validateAssistantSettings(value);
    await this.host.callHost('storage.set', { key: SETTINGS_KEY, value: next });
    this.settings = next;
    this.engine.settingsChanged();
    return next;
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

function triageBadge(advice: Advice): { text: string; tone: 'info' | 'warn'; tooltip: string } {
  const label = `${advice.difficulty} · ${advice.category}`.slice(0, 24);
  const hints = [
    advice.isolation !== 'direct' ? `better in a ${advice.isolation}` : '',
    advice.reviewStrict ? 'strict command review' : '',
    advice.strongModel ? 'use a strong model' : '',
    advice.suggestOrchestrator ? 'splits into subagents' : '',
    advice.underspecified ? 'the task misses information' : ''
  ].filter(Boolean);
  return { text: label, tone: advice.reviewStrict || advice.isolation !== 'direct' ? 'warn' : 'info', tooltip: `Assistant triage: ${hints.join('; ') || 'nothing to add'}`.slice(0, 200) };
}
