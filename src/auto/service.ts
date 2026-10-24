import { join } from 'node:path';
import type { Host } from '../rpc.ts';
import type { Locale } from '../harness/i18n.ts';
import type { BadgeSource } from '../harness/badges.ts';
import type { DataClass, DataClassMode } from '../shared/settings.ts';
import bundledCatalog from './catalog/bundled.json' with { type: 'json' };
import { CatalogStore, type CatalogStatus, type RoutingCatalog } from './catalog/catalog.ts';
import { BenchmarkIndex, bareModelId, TASK_TYPES, type TaskType } from './catalog/scoring.ts';
import { normalizeModelIdentity, type ReasoningEffort } from './catalog/identity.ts';
import { upstreamAllowed } from './classify.ts';
import { plan, type TurnView } from './select.ts';
import { AUTO_STRINGS, badgeText } from './i18n.ts';
import type { RouteOutcome } from './consensus.ts';
import type { JevOnlyHosts } from './jevOnly.ts';
import { buildInventory, type Inventory, type InventoryEntry } from './inventory.ts';
import { autoRefusal, limitsFor, openCodeContribution } from './launch.ts';
import { AutoRouter, type DecisionRecord, type RouterDeps, type RouterStats, type TurnDecision } from './router.ts';
import {
  JEV_OPENROUTER_SECRET, isJevOnlyUpstream, normalizeAutoSettings, OPENROUTER_BASE_URL, originOf, upstreamSecret, validateAutoSettings,
  type AutoRoutingSettings, type AutoUpstream
} from './settings.ts';
import type { LaunchGrant } from './tokens.ts';
import { AccountBroker, type BrokeredAccount, type BrokerMode } from './broker.ts';

/**
 * Auto (Jev) inside the Assistant service: its settings (storage key `autoRouting`), the router, the launch
 * contribution and the decision models page's rows. Upstream keys are read from the plugin's secrets only when a
 * call is made, and only for the address they were saved for.
 */
export const AUTO_STORAGE_KEY = 'autoRouting';
export const PLUGIN_ID = 'canvastty-assistant';
const TEST_TIMEOUT_MS = 10_000;
/** CanvasTTY allows 4 open brokered requests per account and caller: a fan-out stays under it. */
const BROKER_PARALLEL = 4;
/** A launch waits at most this long for CanvasTTY's list of brokered accounts. */
const BROKER_LIST_MS = 2_000;

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
  /** A new user turn of a card (its latest user text), for the card's command review. */
  turn?(text: string, grant: LaunchGrant): void;
  publishBadge(sessionId: string, badge: BadgeSource): void;
  /** The request-time OpenRouter check (tests pass one with their own lookup). */
  jevOnly?: JevOnlyHosts;
  /** At most this many calls at once on a subscription-like upstream (the person marked its address flat-rate). */
  parallelCap?(upstream: AutoUpstream): number | null;
  transport?: typeof fetch;
  /** For the public catalog downloads (tests pass a fake; nothing else may reach the network). */
  catalogTransport?: typeof fetch;
  /** The first background catalog refresh waits this long after start (default 20 s). */
  catalogStartDelayMs?: number;
  now?: () => number;
  timeouts?: RouterDeps['timeouts'];
}

/** One model of an upstream as the decision models page shows it (read-only facts plus the person's choices). */
export interface ModelRow {
  id: string;
  listed: boolean;
  /** OpenRouter's own list offers it. */
  fromList: boolean;
  excluded: boolean;
  tier: string | null;
  effort: string | null;
  priceIn: number | null;
  priceOut: number | null;
  priceSource: InventoryEntry['priceSource'];
  context: number | null;
  known: boolean;
  measuredEfforts: string[];
  /** The best variant's score per task type (null: unknown), and that variant's effort. */
  scores: Partial<Record<TaskType, { value: number; effort: string | null; label: string; historical: boolean }>>;
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
  readonly catalog: CatalogStore;
  /** Accounts other extensions keep, called through CanvasTTY without their keys (an older core lists none). */
  readonly broker: AccountBroker;
  private readonly options: AutoServiceOptions;
  private memo: { settings: AutoRoutingSettings; version: number; hour: number; inventory: Inventory } | null = null;
  private index: { version: number; hour: number; index: BenchmarkIndex } | null = null;

  constructor(options: AutoServiceOptions) {
    this.options = options;
    this.readable = options.savedUnavailable !== true;
    this.settings = normalizeAutoSettings(this.readable ? options.saved : null);
    this.catalog = new CatalogStore({
      directory: join(options.dataDir, 'auto'), bundled: bundledCatalog,
      ...(options.catalogTransport ? { transport: options.catalogTransport } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.catalogStartDelayMs !== undefined ? { startDelayMs: options.catalogStartDelayMs } : {}),
      onChange: () => { this.memo = null; }
    });
    this.configureCatalog();
    this.broker = new AccountBroker(options.host, { ...(options.now ? { now: options.now } : {}), log: (level, message) => options.host.log(level, message) });
    const parallelCap = options.parallelCap;
    this.router = new AutoRouter({
      directory: join(options.dataDir, 'auto'),
      settings: () => this.settings,
      inventory: () => this.inventory(),
      dataClassMode: options.dataClassMode,
      key: upstream => this.keyFor(upstream),
      ...(options.decide ? { decide: options.decide } : {}),
      ...(options.turn ? { turn: options.turn } : {}),
      badge: (sessionId, model) => options.publishBadge(sessionId, model ? () => ({ text: badgeText(model.model), tone: 'neutral', tooltip: AUTO_STRINGS[this.options.locale].badgeTip(model.tier, model.source) }) : null),
      log: (level, message) => options.host.log(level, message),
      parallelCap: upstream => upstream.preset === 'account' ? BROKER_PARALLEL : parallelCap?.(upstream) ?? null,
      broker: {
        send: (upstream, path, init) => this.broker.send(upstream.account ?? '', path, init as Parameters<AccountBroker['send']>[2]),
        ready: upstream => this.accountReady(upstream),
        refresh: async () => { await this.broker.list(); },
        withdrawn: upstream => !!upstream.account && this.broker.withdrawn(upstream.account)
      },
      withdrawnMessage: () => AUTO_STRINGS[this.options.locale].grantWithdrawn,
      noProviderMessage: () => AUTO_STRINGS[this.options.locale].noProvider,
      ...(options.jevOnly ? { jevOnly: options.jevOnly } : {}),
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

  /** An account upstream CanvasTTY lists now (granted by the person, offered by its owner) for a model it offers. */
  accountReady(upstream: AutoUpstream): boolean {
    if (upstream.preset !== 'account' || !upstream.account) return false;
    const account = this.broker.known(upstream.account);
    return !!account && account.protocol === 'openai' && account.paths.includes('/chat/completions');
  }

  /** The inventory without account upstreams CanvasTTY does not list now (no grant, owner off, older core). */
  private reachableInventory(inventory: Inventory): Inventory {
    if (!inventory.entries.some(entry => entry.upstream.preset === 'account')) return inventory;
    return { ...inventory, entries: inventory.entries.filter(entry => entry.upstream.preset !== 'account' || this.accountReady(entry.upstream)) };
  }

  setLocale(locale: Locale): void { this.options.locale = locale; }

  loaded(saved: unknown): void { this.settings = normalizeAutoSettings(saved); this.readable = true; this.configureCatalog(); }

  /** Whether the Jev · OpenRouter key is saved (for OpenRouter's own address). */
  async jevKey(): Promise<boolean> {
    const stored = await this.options.readKey(JEV_OPENROUTER_SECRET).catch(() => null);
    return !!stored && stored.origin === originOf(OPENROUTER_BASE_URL);
  }


  /** Background refresh only while an upstream is on; OpenRouter's list only when an OpenRouter upstream uses it. */
  private configureCatalog(): void {
    const enabled = this.settings.upstreams.filter(upstream => upstream.enabled);
    this.catalog.configure({
      autoRefresh: this.settings.catalog.autoRefresh && enabled.length > 0,
      refreshHours: this.settings.catalog.refreshHours,
      openRouter: enabled.some(upstream => upstream.preset === 'openrouter' && upstream.allModels)
    });
  }

  /** The models Auto may choose from, rebuilt when the settings or the catalog change (and hourly, for staleness). */
  inventory(): Inventory {
    const hour = Math.floor((this.options.now ?? Date.now)() / 3_600_000);
    const memo = this.memo;
    if (memo && memo.settings === this.settings && memo.version === this.catalog.version && memo.hour === hour) return memo.inventory;
    const routing = this.catalog.routing();
    if (!this.index || this.index.version !== this.catalog.version || this.index.hour !== hour) this.index = { version: this.catalog.version, hour, index: new BenchmarkIndex(routing) };
    const inventory = buildInventory(this.settings, routing, this.index.index);
    this.memo = { settings: this.settings, version: this.catalog.version, hour, inventory };
    return inventory;
  }

  /** `model: "auto"` for this launch: refuse with a reason, or the contribution with a fresh key. Never waits on a model. */
  async prepare(input: AutoPrepareInput): Promise<AutoPrepareAnswer> {
    const strings = AUTO_STRINGS[this.options.locale];
    if (this.settings.upstreams.some(upstream => upstream.enabled && upstream.preset === 'account')) {
      await Promise.race([this.broker.list(), new Promise(resolve => setTimeout(resolve, BROKER_LIST_MS).unref?.())]);
    }
    const inventory = this.reachableInventory(this.inventory());
    const refusal = autoRefusal({ provider: input.provider, role: input.role, cwd: input.cwd, environment: input.environment, dataClass: input.dataClass, settings: this.settings, mode: this.options.dataClassMode(), inventory });
    if (refusal === 'listLoading') void this.catalog.refresh().catch(() => undefined);
    if (refusal) return { refuse: { reason: strings[refusal] } };
    let granted: { token: string; port: number };
    try {
      granted = await this.router.grant({ sessionId: input.sessionId, provider: input.provider, role: input.role, parentSessionId: input.parentSessionId, dataClass: input.dataClass });
    } catch (error) {
      this.options.host.log('warn', `Auto (Jev): no local port (${error instanceof Error ? error.message.slice(0, 120) : 'error'})`);
      return { refuse: { reason: strings.router } };
    }
    return openCodeContribution({ port: granted.port, token: granted.token, limit: limitsFor(inventory) });
  }

  /** The catalog and its benchmark index, as Auto compares models (for agent-level routing). */
  routingIndex(): { catalog: RoutingCatalog; index: BenchmarkIndex } {
    this.inventory();
    return { catalog: this.catalog.routing(), index: this.index!.index };
  }

  /**
   * For agent-level routing: the model Auto's request router would pick for a task like this one (its expected
   * value; the router still decides per turn), or null when Auto has no enabled upstream with a key.
   */
  async expectation(view: TurnView, cardClass: DataClass): Promise<{ model: string; identity: string | null; effort: ReasoningEffort | null; priceIn: number | null; priceOut: number | null; trusted: boolean } | null> {
    const mode = this.options.dataClassMode();
    const keyed: AutoUpstream[] = [];
    for (const upstream of this.settings.upstreams) {
      if (!upstream.enabled) continue;
      if (upstream.preset === 'account' ? this.accountReady(upstream) : upstream.key === 'none' || await this.keyFor(upstream).catch(() => null)) keyed.push(upstream);
    }
    if (!keyed.length || this.settings.dailyUsdCap <= 0) return null;
    const ids = new Set(keyed.map(upstream => upstream.id));
    const entries = this.inventory().entries.filter(entry => ids.has(entry.upstream.id) && !entry.excluded);
    const trustedEntries = entries.filter(entry => upstreamAllowed(entry.upstream, cardClass, mode));
    const usable = trustedEntries.length ? trustedEntries : entries;
    const top = plan(usable, { kind: 'turn', view, preferred: null }, { preference: this.settings.preference, cheaperFallback: this.settings.cheaperFallback }).list[0];
    if (!top) return null;
    const bare = bareModelId(top.model);
    return { model: top.model, identity: bare ? normalizeModelIdentity(bare) : null, effort: top.effort, priceIn: top.priceIn, priceOut: top.priceOut, trusted: trustedEntries.length > 0 };
  }

  /** For `route`: the launch options that give a subagent Auto too, when the caller itself runs on it. */
  launchOptionsFor(sessionId: string): Record<string, Record<string, string>> | null {
    return this.router.tokens.forSession(sessionId) ? { [PLUGIN_ID]: { model: 'auto' } } : null;
  }

  /**
   * A card on Model: Auto (Jev), for the agent tree: the models its answered calls used through the router (most
   * used first) and what they cost. A flat-rate upstream (a brokered plan account) is a plan, never dollars; a paid
   * one sums the router's own cost per call. Null: the router answered nothing for this card.
   */
  treeAuto(sessionId: string): { models: Array<{ model: string; calls: number }>; plan: string | null; usd: number | null; tokens: number } | null {
    const turns = this.router.sessionTurns(sessionId);
    if (!turns.length) return null;
    const models = new Map<string, number>();
    for (const turn of turns) models.set(turn.model, (models.get(turn.model) ?? 0) + turn.turns);
    const upstreams = new Map(this.settings.upstreams.map(upstream => [upstream.id, upstream]));
    const flat = turns.filter(turn => { const upstream = upstreams.get(turn.upstream); return !!upstream && upstream.preset === 'account' && upstream.flatRate === true; });
    const top = [...flat].sort((a, b) => b.turns - a.turns)[0];
    const account = top ? upstreams.get(top.upstream)?.account ?? null : null;
    const label = account ? this.broker.known(account)?.label : undefined;
    const plan = top ? label ?? top.upstream : null;
    const paid = turns.filter(turn => !flat.includes(turn) && turn.usd !== null);
    return {
      models: [...models].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([model, calls]) => ({ model, calls })),
      plan, usd: paid.length ? Math.round(paid.reduce((sum, turn) => sum + (turn.usd ?? 0), 0) * 1e6) / 1e6 : null,
      tokens: turns.reduce((sum, turn) => sum + turn.tokensIn + turn.tokensOut, 0)
    };
  }

  sessionClosed(sessionId: string): void { this.router.closeSession(sessionId); }
  sessionsKnown(ids: ReadonlySet<string>): void { this.router.retainSessions(ids); }
  /** Service start: the catalog caches are read, and cards that still hold keys get their listener back. */
  async resume(): Promise<void> { await this.catalog.load(); await this.router.resume(); }
  stop(): Promise<void> { this.catalog.dispose(); this.broker.close(); return this.router.stop(); }

  /** «Обновить каталог»: downloads every source now (fixed public addresses; no task text, no key). */
  async refreshCatalog(): Promise<CatalogStatus> {
    try { await this.catalog.refresh({ force: true }); } catch { /* the status says what failed */ }
    return this.catalog.status();
  }

  /** Each upstream's models for the page: one row per model id, the best variant's score per task type. */
  modelRows(): Record<string, ModelRow[]> {
    const rows: Record<string, ModelRow[]> = {};
    const byModel = new Map<string, ModelRow>();
    for (const entry of this.inventory().entries) {
      const key = `${entry.upstream.id}|${entry.model}`;
      let row = byModel.get(key);
      if (!row) {
        const person = entry.upstream.models.find(model => model.id === entry.model);
        row = { id: entry.model, listed: entry.listed, fromList: entry.fromList, excluded: entry.excluded, tier: entry.tier, effort: person?.effort ?? null, priceIn: entry.priceIn, priceOut: entry.priceOut,
          priceSource: entry.priceSource, context: entry.context, known: entry.known, measuredEfforts: entry.measuredEfforts, scores: {} };
        byModel.set(key, row);
        (rows[entry.upstream.id] ??= []).push(row);
      }
      for (const type of TASK_TYPES) {
        const score = entry.scores[type];
        if (score && (!row.scores[type] || score.value > row.scores[type]!.value)) row.scores[type] = { value: score.value, effort: entry.effort, label: score.label, historical: score.historical };
      }
    }
    for (const list of Object.values(rows)) list.sort((a, b) => Number(b.listed) - Number(a.listed) || (b.scores.coding?.value ?? b.scores.chat?.value ?? -1) - (a.scores.coding?.value ?? a.scores.chat?.value ?? -1) || a.id.localeCompare(b.id));
    return rows;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The decision models page
  // ---------------------------------------------------------------------------------------------------------------

  async state(): Promise<{ jevKey: boolean; settings: AutoRoutingSettings; readable: boolean; keys: Record<string, boolean>; recent: DecisionRecord[]; stats: RouterStats & { spentToday: number; callsToday?: number; listening: boolean; cards: number }; catalog: CatalogStatus; models: Record<string, ModelRow[]>; waitingForList: string[]; outcomes: Record<string, RouteOutcome>; brokered: { mode: BrokerMode; accounts: BrokeredAccount[] } }> {
    const accounts = await this.broker.list();
    const keys: Record<string, boolean> = {};
    for (const upstream of this.settings.upstreams) keys[upstream.id] = upstream.preset === 'account' ? this.accountReady(upstream) : upstream.key === 'none' ? true : !!(await this.keyFor(upstream).catch(() => null));
    return { jevKey: await this.jevKey(), settings: this.settings, readable: this.readable, keys, recent: this.router.recent(), stats: this.router.statsView(), catalog: this.catalog.status(), models: this.modelRows(), waitingForList: this.inventory().waitingForList, outcomes: this.router.routeOutcomes(),
      brokered: { mode: this.broker.mode, accounts } };
  }

  async save(value: unknown): Promise<AutoRoutingSettings> {
    if (!this.readable) throw new Error(this.options.locale === 'ru' ? 'Сохранённые настройки ещё не прочитаны, поэтому ничего не изменено.' : 'The saved settings could not be read yet, so nothing is changed.');
    const next = validateAutoSettings(value);
    // OpenRouter is for Jev only: no new upstream there, even switched off (one saved before the rule stays, off).
    if (next.upstreams.some(upstream => isJevOnlyUpstream(upstream) && !this.settings.upstreams.some(old => old.id === upstream.id && isJevOnlyUpstream(old)))) throw new Error(AUTO_STRINGS[this.options.locale].jevOnly);
    await this.options.host.callHost('storage.set', { key: AUTO_STORAGE_KEY, value: next });
    this.settings = next;
    this.configureCatalog();
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
    if (isJevOnlyUpstream(upstream)) throw new Error(AUTO_STRINGS[this.options.locale].jevOnly);
    if (upstream.preset === 'account') return this.testAccount(upstream);
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

  /** «Проверить» for an account upstream: CanvasTTY's GET /models through the broker (no prompt, no tokens). */
  private async testAccount(upstream: AutoUpstream): Promise<{ ok: boolean; status: number | null; missing: string[]; listed: number | null }> {
    this.broker.invalidate();
    const account = (await this.broker.list()).find(entry => entry.ref === upstream.account);
    if (!account) return { ok: false, status: null, missing: [], listed: null };
    const missing = upstream.models.map(model => model.id).filter(id => !account.models.includes(id));
    if (!account.paths.includes('/models')) return { ok: true, status: null, missing, listed: account.models.length };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    try {
      const answer = await this.broker.send(account.ref, '/models', { method: 'GET', signal: controller.signal });
      await answer.text().catch(() => '');
      return { ok: answer.ok, status: answer.status, missing, listed: account.models.length };
    } catch {
      return { ok: false, status: null, missing, listed: null };
    } finally { clearTimeout(timer); }
  }
}
