import { join } from 'node:path';
import type { Host } from '../rpc.ts';
import type { Locale } from '../harness/i18n.ts';
import type { Badge } from '../harness/badges.ts';
import type { DataClass, DataClassMode } from '../shared/settings.ts';
import { AUTO_STRINGS, badgeText } from './i18n.ts';
import { autoRefusal, openCodeContribution } from './launch.ts';
import { AutoRouter, type DecisionRecord, type RouterDeps, type RouterStats, type TurnDecision } from './router.ts';
import {
  JEV_OPENROUTER_SECRET, normalizeAutoSettings, originOf, upstreamSecret, validateAutoSettings,
  type AutoRoutingSettings, type AutoUpstream
} from './settings.ts';
import type { LaunchGrant } from './tokens.ts';

/**
 * Auto (Jev) inside the Assistant service: its settings (storage key `autoRouting`), the router, the launch
 * contribution and the decision models page's rows. Upstream keys are read from the plugin's secrets only when a
 * call is made, and only for the address they were saved for.
 */
export const AUTO_STORAGE_KEY = 'autoRouting';
export const PLUGIN_ID = 'canvastty-assistant';
const TEST_TIMEOUT_MS = 10_000;

export interface AutoServiceOptions {
  host: Host;
  dataDir: string;
  locale: Locale;
  saved?: unknown;
  savedUnavailable?: boolean;
  /** `{ origin, value }` saved under a secret name, or null. */
  readKey(owner: string): Promise<{ origin: string; value: string } | null>;
  dataClassMode(): DataClassMode;
  /** Jev's view of a turn, or null (Jev off, not set up, not allowed for this class, or no answer). */
  decide?(text: string, grant: LaunchGrant, signal: AbortSignal): Promise<TurnDecision | null>;
  publishBadge(sessionId: string, badge: Badge | null): void;
  transport?: typeof fetch;
  now?: () => number;
  timeouts?: RouterDeps['timeouts'];
}

export interface AutoPrepareInput {
  sessionId: string; provider: string; role: string; cwd: string; parentSessionId: string | null;
  environment: { pluginId: string; kind: string } | null | undefined;
  dataClass: DataClass;
}

export type AutoPrepareAnswer = ReturnType<typeof openCodeContribution> | { refuse: { reason: string } };

export class AutoService {
  settings: AutoRoutingSettings;
  readable: boolean;
  readonly router: AutoRouter;
  private readonly options: AutoServiceOptions;

  constructor(options: AutoServiceOptions) {
    this.options = options;
    this.readable = options.savedUnavailable !== true;
    this.settings = normalizeAutoSettings(this.readable ? options.saved : null);
    const strings = AUTO_STRINGS[options.locale];
    this.router = new AutoRouter({
      directory: join(options.dataDir, 'auto'),
      settings: () => this.settings,
      dataClassMode: options.dataClassMode,
      key: upstream => this.keyFor(upstream),
      ...(options.decide ? { decide: options.decide } : {}),
      badge: (sessionId, model) => options.publishBadge(sessionId, model ? { text: badgeText(model.model), tone: 'neutral', tooltip: strings.badgeTip(model.tier, model.source) } : null),
      log: (level, message) => options.host.log(level, message),
      ...(options.transport ? { transport: options.transport } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.timeouts ? { timeouts: options.timeouts } : {})
    });
  }

  /** The key for an upstream, only when it was saved for this upstream's own address. */
  private async keyFor(upstream: AutoUpstream): Promise<string | null> {
    if (upstream.key === 'none') return null;
    const stored = await this.options.readKey(upstream.key === 'jev' ? JEV_OPENROUTER_SECRET : upstreamSecret(upstream.id));
    if (!stored) return null;
    // A key saved for another address is never sent anywhere else.
    return stored.origin === originOf(upstream.baseUrl) ? stored.value : null;
  }

  loaded(saved: unknown): void { this.settings = normalizeAutoSettings(saved); this.readable = true; }

  /** `model: "auto"` for this launch: refuse with a reason, or the contribution with a fresh key. Never waits on a model. */
  async prepare(input: AutoPrepareInput): Promise<AutoPrepareAnswer> {
    const strings = AUTO_STRINGS[this.options.locale];
    const refusal = autoRefusal({ provider: input.provider, role: input.role, cwd: input.cwd, environment: input.environment, dataClass: input.dataClass, settings: this.settings, mode: this.options.dataClassMode() });
    if (refusal) return { refuse: { reason: strings[refusal] } };
    let granted: { token: string; port: number };
    try {
      granted = await this.router.grant({ sessionId: input.sessionId, provider: input.provider, role: input.role, parentSessionId: input.parentSessionId, dataClass: input.dataClass });
    } catch (error) {
      this.options.host.log('warn', `Auto (Jev): no local port (${error instanceof Error ? error.message.slice(0, 120) : 'error'})`);
      return { refuse: { reason: strings.router } };
    }
    return openCodeContribution({ port: granted.port, token: granted.token, settings: this.settings });
  }

  /** For `route`: the launch options that give a subagent Auto too, when the caller itself runs on it. */
  launchOptionsFor(sessionId: string): Record<string, Record<string, string>> | null {
    return this.router.tokens.forSession(sessionId) ? { [PLUGIN_ID]: { model: 'auto' } } : null;
  }

  sessionClosed(sessionId: string): void { this.router.closeSession(sessionId); }
  sessionsKnown(ids: ReadonlySet<string>): void { this.router.retainSessions(ids); }
  resume(): Promise<void> { return this.router.resume(); }
  stop(): Promise<void> { return this.router.stop(); }

  // ---------------------------------------------------------------------------------------------------------------
  // The decision models page
  // ---------------------------------------------------------------------------------------------------------------

  async state(): Promise<{ settings: AutoRoutingSettings; readable: boolean; keys: Record<string, boolean>; recent: DecisionRecord[]; stats: RouterStats & { spentToday: number; listening: boolean; cards: number } }> {
    const keys: Record<string, boolean> = {};
    for (const upstream of this.settings.upstreams) keys[upstream.id] = upstream.key === 'none' ? true : !!(await this.keyFor(upstream).catch(() => null));
    return { settings: this.settings, readable: this.readable, keys, recent: this.router.recent(), stats: this.router.statsView() };
  }

  async save(value: unknown): Promise<AutoRoutingSettings> {
    if (!this.readable) throw new Error(this.options.locale === 'ru' ? 'Сохранённые настройки ещё не прочитаны, поэтому ничего не изменено.' : 'The saved settings could not be read yet, so nothing is changed.');
    const next = validateAutoSettings(value);
    await this.options.host.callHost('storage.set', { key: AUTO_STORAGE_KEY, value: next });
    this.settings = next;
    this.options.host.emit('settings', null);
    return next;
  }

  /** The secret name and origin the page writes an upstream's own key under (never the key itself). */
  keySlot(upstreamId: string): { secret: string; origin: string } {
    const upstream = this.settings.upstreams.find(entry => entry.id === upstreamId);
    if (!upstream || upstream.key !== 'own') throw new Error('This upstream takes no key of its own.');
    return { secret: upstreamSecret(upstream.id), origin: originOf(upstream.baseUrl) };
  }

  /**
   * «Проверить»: GETs of the upstream's model list (and OpenRouter's /key) with its key: no prompt, no tokens spent.
   * Says whether the key works and which configured model ids the upstream does not list.
   */
  async test(upstreamId: string): Promise<{ ok: boolean; status: number | null; missing: string[]; listed: number | null }> {
    const upstream = this.settings.upstreams.find(entry => entry.id === upstreamId);
    if (!upstream) throw new Error('Unknown upstream.');
    const key = await this.keyFor(upstream);
    if (upstream.key !== 'none' && !key) return { ok: false, status: null, missing: [], listed: null };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    try {
      const get = (path: string): Promise<Response> => (this.options.transport ?? fetch)(`${upstream.baseUrl}${path}`, { headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, signal: controller.signal, redirect: 'error' });
      // OpenRouter lists models without a key; its /key answers only for a valid one (no tokens spent either way).
      if (upstream.preset === 'openrouter') {
        const checked = await get('/key');
        if (!checked.ok) return { ok: false, status: checked.status, missing: [], listed: null };
      }
      const answer = await get('/models');
      if (!answer.ok) return { ok: false, status: answer.status, missing: [], listed: null };
      const body = await answer.json().catch(() => null) as { data?: Array<{ id?: unknown }> } | null;
      const ids = new Set((Array.isArray(body?.data) ? body!.data : []).map(entry => entry?.id).filter((id): id is string => typeof id === 'string'));
      return { ok: true, status: answer.status, missing: ids.size ? upstream.models.map(model => model.id).filter(id => !ids.has(id)) : [], listed: ids.size };
    } catch {
      return { ok: false, status: null, missing: [], listed: null };
    } finally { clearTimeout(timer); }
  }
}
