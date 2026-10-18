// The "Model: Auto (Jev)" rows on the decision models page: the public catalog's freshness (with a manual refresh),
// upstreams (keys are write-only, bound to the upstream's address) with a table of their models — price, context and
// score are read-only, detected from the catalog; the person's choices are the exclude toggle, an optional manual
// tier and effort — the preference, caps, who decides, and the recent decisions (task type, difficulty, model,
// score, price, why — never any text). Same look as the rest of the page.
import type { CatalogStatus } from '../auto/catalog/catalog.ts';
import { EFFORTS } from '../auto/catalog/identity.ts';
import type { DecisionRecord, RouterStats } from '../auto/router.ts';
import type { ModelRow } from '../auto/service.ts';
import type { AutoModel, AutoRoutingSettings, AutoTier, AutoUpstream } from '../auto/settings.ts';
import { el } from './common.ts';

export interface AutoState {
  settings: AutoRoutingSettings;
  readable: boolean;
  keys: Record<string, boolean>;
  recent: DecisionRecord[];
  stats: RouterStats & { spentToday: number; listening: boolean; cards: number };
  /** Absent from an older service. */
  catalog?: CatalogStatus;
  models?: Record<string, ModelRow[]>;
  waitingForList?: string[];
}

export interface AutoPageHost {
  request(method: string, params?: unknown): Promise<unknown>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
  say(message: string): void;
  reload(): void;
}

/** What the page remembers between renders: check results, the model filter, the score type shown, rows shown. */
export interface AutoView { checks: Map<string, string>; filter: Map<string, string>; type: string; shown: Map<string, number>; refreshing: boolean }
export const newAutoView = (): AutoView => ({ checks: new Map(), filter: new Map(), type: 'coding', shown: new Map(), refreshing: false });

const OPENROUTER = 'https://openrouter.ai/api/v1';
const TYPES = ['coding', 'review', 'research', 'writing', 'chat'] as const;
const PAGE = 40;

export const AUTO_PAGE_STRINGS = {
  en: {
    title: 'Model: Auto (Jev)',
    lead: 'For OpenCode cards started with Model: Auto (Jev) (launcher → Advanced → Use CanvasTTY Assistant). A local router on 127.0.0.1, protected by a key per card, picks a model for each new turn from data: Jev (task triage, when it is Suggest or Auto above) says the task type and how hard the turn is, otherwise word rules do; the catalog\'s benchmark score for that type and the price decide among the models you allow. Tool steps keep the turn\'s model; titles use the cheapest one. Prompts go only to the upstream that answers; Jev gets only the latest user text, under the data rules below. Leave the launcher\'s Model at Default and choose no model account.',
    catalog: 'Catalog', refresh: 'Refresh now', refreshing: 'Refreshing…',
    catalogLead: 'Public sources read from fixed addresses: models.dev (models, prices, limits), Artificial Analysis and LiveBench (measured scores per model and effort), OpenRouter\'s model list. No task text or key is sent. A score belongs to one exact model and effort; nothing else inherits it, and a model with no row of its own stays unknown. Old scores still count (marked old); prices older than 7 days do not.',
    sourceName: { 'models.dev': 'models.dev', 'artificial-analysis': 'Artificial Analysis', livebench: 'LiveBench', openrouter: 'OpenRouter models' } as Record<string, string>,
    source: (s: CatalogStatus['sources'][number], date: (at: number) => string) => `${s.fetchedAt === null ? 'not loaded' : `loaded ${date(s.fetchedAt)}`}${s.version ? `, v${s.version}` : ''}${s.rows ? `, ${s.measured ? `${s.measured} measured of ` : ''}${s.rows} rows` : ''}${s.fetchedAt !== null && s.stale ? ' — old' : ''}${s.error ? ` — ${s.error}` : ''}`,
    bundled: 'Using the scores that ship with the plugin until the first download.',
    next: (date: string) => `Next background refresh: ${date}.`, noNext: 'Background refresh is off (or no upstream is on).',
    autoRefresh: 'Refresh in the background', every: 'every, hours', lastError: (e: string) => `Last refresh: ${e}.`,
    upstreams: 'Upstreams', none: 'None yet.', add: 'Add', remove: 'Remove', on: 'On', check: 'Check', checking: 'Checking…',
    preset: { openrouter: 'OpenRouter', 'openai-compatible': 'OpenAI-compatible' } as Record<string, string>,
    idLabel: 'Name (a-z, 0-9, -)', baseUrl: 'Base URL (…/v1)', trust: 'I trust it with', trustHelp: 'D3 only for a server on this computer.',
    keyFrom: 'Key', keyOwn: 'Its own key', keyJev: 'The Jev · OpenRouter key', keyNone: 'No key (a server on this computer)',
    keySet: 'key saved', keyMissing: 'no key', keyPlaceholder: 'Key', saveKey: 'Save key', removeKey: 'Remove key',
    allModels: 'Offer every suitable OpenRouter model (tools, text, a fixed price; no :free variants)',
    waiting: 'OpenRouter\'s list is not loaded yet: refresh the catalog.',
    models: 'Models', modelId: 'Model id', filter: 'Filter', scoreFor: 'Score for',
    type: { coding: 'coding', review: 'review', research: 'research', writing: 'writing', chat: 'chat' } as Record<string, string>,
    col: { use: 'Use', model: 'Model', context: 'Context', price: '$/M in · out', score: 'Score', efforts: 'Measured at', effort: 'Effort', tier: 'Tier', remove: '' },
    tier: { small: 'small', medium: 'medium', large: 'large' } as Record<string, string>, tierAuto: 'by score',
    effortDefault: 'default', unknown: 'unknown', old: 'old', fromPerson: 'yours', fromList: 'OpenRouter', fromDev: 'models.dev',
    shown: (shown: number, total: number) => `${shown} of ${total} models`, more: 'Show more',
    priceIn: '$/M in', priceOut: '$/M out', addModel: 'Add model', noModels: 'No models: add at least one.',
    tableHelp: 'Price, context and score come from the catalog (read-only). Untick a model to exclude it. A manual tier makes the model answer turns of that tier first; an effort names the setting it runs at (on OpenRouter Auto sends it).',
    checkOk: (listed: number | null, missing: string[]) => `Works${listed !== null ? ` (${listed} models listed)` : ''}.${missing.length ? ` Not listed by it: ${missing.join(', ')}.` : ''}`,
    checkFail: (status: number | null) => status === null ? 'No answer, or no key saved.' : `It answered ${status}.`,
    choices: 'Choices', preference: 'Preference', pref: { cheap: 'Cheap', balanced: 'Balanced', best: 'Best' } as Record<string, string>,
    prefHelp: 'Every turn takes the best score for its task type, and the cheaper model on a tie. Only a turn Jev is sure is small (≥ 0.9) may give up score for price: Cheap up to 10 points, Balanced 3, Best none. Unknown scores never beat known ones.',
    cheaper: 'Manual tiers: if a tier has no usable model, a cheaper tier may answer (a stronger one is always tried first)',
    decider: 'Who judges a turn', deciderJev: 'Jev, word rules when it does not answer', deciderRules: 'Word rules only',
    daily: 'Daily cap, USD', perCard: 'Per card, USD', capsHelp: 'Counted from the cost the upstream reports, or from the catalog\'s prices. 0 stops Auto.',
    save: 'Save',
    recent: 'Recent decisions', noRecent: 'Nothing routed yet.',
    stats: (s: AutoState['stats']) => `${s.requests} model calls, Jev asked ${s.jevAsked} times (${s.jevAnswered} answered), ${s.leaseReuses} reused a turn's choice, ${s.failovers} failovers; today $${s.spentToday.toFixed(4)}; ${s.listening ? `listening for ${s.cards} card(s)` : 'not listening'}${s.hosts.length ? `; sent to ${s.hosts.join(', ')}` : ''}.`,
    kind: { turn: 'turn', continuation: 'tool step', small: 'title' } as Record<string, string>,
    sourceOf: { jev: 'Jev', rules: 'rules', lease: 'same turn', small: 'small rule' } as Record<string, string>,
    why: { small_model: 'cheapest', manual_tier: 'your tier', best_score: 'best score', cheaper_tie: 'best score, cheaper', cheaper_within_loss: 'cheaper, within the allowed loss', kept_turn_model: 'turn\'s model', manual_tier_fallback: 'your tiers (nothing scored)', unknown_scores: 'no scores: middle price', no_model: 'no model' } as Record<string, string>,
    unreadable: 'The saved Auto (Jev) settings could not be read yet; nothing can be changed until they are.'
  },
  ru: {
    title: 'Модель: Авто (Jev)',
    lead: 'Для окон OpenCode, запущенных с моделью «Авто (Jev)» (запуск → Дополнительно → Ассистент CanvasTTY). Локальный маршрутизатор на 127.0.0.1 с ключом на каждое окно на каждом новом ходе выбирает модель по данным: Jev (разбор задачи, когда он в режиме «Подсказки» или «Авто» выше) называет тип задачи и сложность хода, иначе это делают словесные правила; среди разрешённых вами моделей решают оценка бенчмарка для этого типа из каталога и цена. Шаги с инструментами остаются на модели хода, заголовки — на самой дешёвой. Запросы уходят только поставщику, который отвечает; Jev получает только последний текст пользователя по правилам данных ниже. В окне запуска оставьте «Модель» по умолчанию и не выбирайте аккаунт модели.',
    catalog: 'Каталог', refresh: 'Обновить сейчас', refreshing: 'Обновляю…',
    catalogLead: 'Публичные источники с фиксированных адресов: models.dev (модели, цены, пределы), Artificial Analysis и LiveBench (измеренные оценки по модели и уровню рассуждения), список моделей OpenRouter. Текст задач и ключи не отправляются. Оценка относится к одной точной модели и уровню рассуждения, другим не передаётся; модель без собственной строки остаётся неизвестной. Старые оценки учитываются (с пометкой), цены старше 7 дней — нет.',
    sourceName: { 'models.dev': 'models.dev', 'artificial-analysis': 'Artificial Analysis', livebench: 'LiveBench', openrouter: 'Модели OpenRouter' } as Record<string, string>,
    source: (s: CatalogStatus['sources'][number], date: (at: number) => string) => `${s.fetchedAt === null ? 'не загружено' : `загружено ${date(s.fetchedAt)}`}${s.version ? `, v${s.version}` : ''}${s.rows ? (s.measured ? `, измерено ${s.measured} строк из ${s.rows}` : `, строк: ${s.rows}`) : ''}${s.fetchedAt !== null && s.stale ? ' — устарело' : ''}${s.error ? ` — ${s.error}` : ''}`,
    bundled: 'До первой загрузки используются оценки, поставляемые с плагином.',
    next: (date: string) => `Следующее фоновое обновление: ${date}.`, noNext: 'Фоновое обновление выключено (или нет включённого поставщика).',
    autoRefresh: 'Обновлять в фоне', every: 'каждые, часов', lastError: (e: string) => `Последнее обновление: ${e}.`,
    upstreams: 'Поставщики', none: 'Пока нет.', add: 'Добавить', remove: 'Удалить', on: 'Вкл', check: 'Проверить', checking: 'Проверяю…',
    preset: { openrouter: 'OpenRouter', 'openai-compatible': 'Совместимый с OpenAI' } as Record<string, string>,
    idLabel: 'Имя (a-z, 0-9, -)', baseUrl: 'Базовый адрес (…/v1)', trust: 'Доверяю до', trustHelp: 'D3 — только серверу на этом компьютере.',
    keyFrom: 'Ключ', keyOwn: 'Свой ключ', keyJev: 'Ключ Jev · OpenRouter', keyNone: 'Без ключа (сервер на этом компьютере)',
    keySet: 'ключ сохранён', keyMissing: 'нет ключа', keyPlaceholder: 'Ключ', saveKey: 'Сохранить ключ', removeKey: 'Удалить ключ',
    allModels: 'Предлагать все подходящие модели OpenRouter (инструменты, текст, фиксированная цена; без вариантов :free)',
    waiting: 'Список OpenRouter ещё не загружен: обновите каталог.',
    models: 'Модели', modelId: 'Id модели', filter: 'Фильтр', scoreFor: 'Оценка для',
    type: { coding: 'код', review: 'ревью', research: 'исследование', writing: 'тексты', chat: 'общение' } as Record<string, string>,
    col: { use: 'Исп.', model: 'Модель', context: 'Контекст', price: '$/М вход · выход', score: 'Оценка', efforts: 'Измерена при', effort: 'Рассуждение', tier: 'Уровень', remove: '' },
    tier: { small: 'маленькая', medium: 'средняя', large: 'большая' } as Record<string, string>, tierAuto: 'по оценке',
    effortDefault: 'по умолчанию', unknown: 'неизвестно', old: 'старая', fromPerson: 'ваша', fromList: 'OpenRouter', fromDev: 'models.dev',
    shown: (shown: number, total: number) => `${shown} из ${total} моделей`, more: 'Показать ещё',
    priceIn: '$/М вход', priceOut: '$/М выход', addModel: 'Добавить модель', noModels: 'Моделей нет: добавьте хотя бы одну.',
    tableHelp: 'Цена, контекст и оценка берутся из каталога (только чтение). Снимите отметку, чтобы исключить модель. Ручной уровень даёт модели ходы этого уровня в первую очередь; уровень рассуждения указывает настройку, с которой она работает (на OpenRouter «Авто» его отправляет).',
    checkOk: (listed: number | null, missing: string[]) => `Работает${listed !== null ? ` (моделей в списке: ${listed})` : ''}.${missing.length ? ` Нет в его списке: ${missing.join(', ')}.` : ''}`,
    checkFail: (status: number | null) => status === null ? 'Нет ответа или не сохранён ключ.' : `Ответ: ${status}.`,
    choices: 'Выбор', preference: 'Предпочтение', pref: { cheap: 'Дешевле', balanced: 'Сбалансированно', best: 'Лучше' } as Record<string, string>,
    prefHelp: 'Каждый ход получает лучшую оценку для своего типа задачи, при равенстве — более дешёвую модель. Пожертвовать оценкой ради цены можно только на ходе, который Jev уверенно (≥ 0,9) считает простым: «Дешевле» — до 10 баллов, «Сбалансированно» — 3, «Лучше» — нисколько. Неизвестная оценка никогда не побеждает известную.',
    cheaper: 'Ручные уровни: если на уровне нет доступной модели, может ответить более дешёвый (сначала всегда пробуется более сильный)',
    decider: 'Кто оценивает ход', deciderJev: 'Jev, словесные правила, если он не ответил', deciderRules: 'Только словесные правила',
    daily: 'Предел в день, USD', perCard: 'На окно, USD', capsHelp: 'Считается по стоимости, которую сообщает поставщик, или по ценам каталога. 0 останавливает «Авто».',
    save: 'Сохранить',
    recent: 'Последние решения', noRecent: 'Пока ничего не маршрутизировано.',
    stats: (s: AutoState['stats']) => `Вызовов моделей: ${s.requests}, Jev спрошен ${s.jevAsked} раз (ответил ${s.jevAnswered}), решение хода повторно: ${s.leaseReuses}, переключений: ${s.failovers}; сегодня $${s.spentToday.toFixed(4)}; ${s.listening ? `слушает, окон: ${s.cards}` : 'не слушает'}${s.hosts.length ? `; отправлено на ${s.hosts.join(', ')}` : ''}.`,
    kind: { turn: 'ход', continuation: 'шаг инструмента', small: 'заголовок' } as Record<string, string>,
    sourceOf: { jev: 'Jev', rules: 'правила', lease: 'тот же ход', small: 'правило маленькой' } as Record<string, string>,
    why: { small_model: 'самая дешёвая', manual_tier: 'ваш уровень', best_score: 'лучшая оценка', cheaper_tie: 'лучшая оценка, дешевле', cheaper_within_loss: 'дешевле, в пределах допустимой потери', kept_turn_model: 'модель хода', manual_tier_fallback: 'ваши уровни (оценок нет)', unknown_scores: 'оценок нет: средняя цена', no_model: 'нет модели' } as Record<string, string>,
    unreadable: 'Сохранённые настройки «Авто (Jev)» ещё не прочитаны; пока их нельзя менять.'
  }
};
type Strings = typeof AUTO_PAGE_STRINGS.en;

function selectOf<T extends string>(name: string, value: T, options: Array<[T, string]>, onChange: (value: T) => void): HTMLSelectElement {
  const node = el('select', { name });
  for (const [option, label] of options) node.append(el('option', { value: option, textContent: label, selected: option === value }));
  node.addEventListener('change', () => onChange(node.value as T));
  return node;
}

function checkOf(name: string, checked: boolean, label: string, onChange: (checked: boolean) => void): HTMLLabelElement {
  const input = el('input', { type: 'checkbox', checked, name });
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { className: 'check' }, input, ` ${label}`);
}

const labelled = (label: string, control: Node): HTMLDivElement => el('div', { className: 'row' }, el('span', { className: 'label', textContent: label }), control);
const number = (value: string): number | undefined => value.trim() === '' ? undefined : Number(value);
const isLocal = (url: string): boolean => /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//u.test(`${url}/`);
const usd = (value: number | null): string => value === null ? '—' : value >= 1 ? value.toFixed(2) : String(Math.round(value * 1_000) / 1_000);
const kTokens = (value: number | null): string => value === null ? '—' : value >= 1_000_000 ? `${Math.round(value / 100_000) / 10}M` : `${Math.round(value / 1_000)}k`;
const dateOf = (at: number): string => new Date(at).toLocaleString(document.documentElement.lang || 'en', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function renderAuto(state: AutoState, t: Strings, page: AutoPageHost, view: AutoView): HTMLElement {
  const settings = state.settings;
  const save = (change: (next: AutoRoutingSettings) => void): void => {
    const next = structuredClone(settings);
    change(next);
    page.request('auto.save', { settings: next }).then(() => page.reload(), error => page.say(error instanceof Error ? error.message : String(error)));
  };
  const section = el('section', { className: 'auto', dataset: { section: 'auto' } });
  section.append(el('h2', { textContent: t.title }), el('p', { className: 'muted', textContent: t.lead }));
  if (!state.readable) section.append(el('p', { className: 'muted', textContent: t.unreadable }));
  if (state.catalog) section.append(catalogSection(state.catalog, settings, t, page, view, save));

  section.append(el('h2', { textContent: t.upstreams }));
  const list = el('ul', { className: 'backends' });
  if (!settings.upstreams.length) list.append(el('li', { className: 'muted', textContent: t.none }));
  for (const upstream of settings.upstreams) list.append(upstreamRow(upstream, state, t, page, save, view));
  section.append(list, addUpstream(settings, t, save));

  section.append(el('h2', { textContent: t.choices }),
    labelled(t.preference, selectOf('auto-preference', settings.preference, (['cheap', 'balanced', 'best'] as const).map(p => [p, t.pref[p]!] as [typeof p, string]), value => save(next => { next.preference = value; }))),
    el('p', { className: 'muted', textContent: t.prefHelp }),
    checkOf('auto-cheaper', settings.cheaperFallback, t.cheaper, value => save(next => { next.cheaperFallback = value; })),
    labelled(t.decider, selectOf('auto-decider', settings.decider, [['jev', t.deciderJev], ['rules', t.deciderRules]], value => save(next => { next.decider = value; }))));
  const daily = el('input', { type: 'number', name: 'auto-daily', min: '0', max: '100', step: '0.01', value: String(settings.dailyUsdCap) });
  const perCard = el('input', { type: 'number', name: 'auto-per-card', min: '0', max: '100', step: '0.01', value: String(settings.perCardUsdCap) });
  const saveCaps = el('button', { type: 'button', textContent: t.save, name: 'auto-caps-save' });
  saveCaps.addEventListener('click', () => save(next => { next.dailyUsdCap = Number(daily.value); next.perCardUsdCap = Number(perCard.value); }));
  section.append(el('div', { className: 'row' }, el('span', { className: 'label', textContent: t.daily }), daily, el('span', { textContent: t.perCard }), perCard, saveCaps),
    el('p', { className: 'muted', textContent: t.capsHelp }));

  section.append(el('h2', { textContent: t.recent }), el('p', { className: 'muted', textContent: t.stats(state.stats), dataset: { auto: 'stats' } }));
  const recent = el('ul', { className: 'recent', dataset: { auto: 'recent' } });
  if (!state.recent.length) recent.append(el('li', { className: 'muted', textContent: t.noRecent }));
  for (const record of state.recent.slice(0, 20)) recent.append(recentRow(record, t));
  section.append(recent);
  return section;
}

/** One decision: time · card · kind · type · difficulty (confidence) · model (effort) · score (source) · price · why · status · failovers · cost. */
function recentRow(record: DecisionRecord, t: Strings): HTMLLIElement {
  const time = new Date(record.at).toLocaleTimeString(document.documentElement.lang || 'en', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const level = record.difficulty ?? record.tier;
  const parts = [time, record.session, t.kind[record.kind] ?? record.kind];
  if (record.taskType) parts.push(t.type[record.taskType] ?? record.taskType);
  parts.push(`${level ? t.tier[level] ?? level : '—'}${typeof record.confidence === 'number' ? ` (${record.confidence.toFixed(2)})` : ''}`);
  const tail: string[] = [];
  if (typeof record.score === 'number') tail.push(`${record.score.toFixed(1)} ${record.scoreSource ?? ''}`.trim());
  else if (record.model && record.why) tail.push(t.unknown);
  if (typeof record.priceIn === 'number' || typeof record.priceOut === 'number') tail.push(`$${usd(record.priceIn ?? null)}/$${usd(record.priceOut ?? null)}`);
  tail.push(`${t.sourceOf[record.source] ?? record.source} (${record.why ? t.why[record.why] ?? record.why : record.reason})`);
  tail.push(String(record.status));
  if (record.failovers.length) tail.push(`↷${record.failovers.length}`);
  if (record.costUsd !== null) tail.push(`$${record.costUsd.toFixed(5)}`);
  return el('li', {}, `${parts.join(' · ')} · `, el('code', { textContent: `${record.model ?? '—'}${record.effort ? `@${record.effort}` : ''}` }), ` · ${tail.join(' · ')}`);
}

function catalogSection(status: CatalogStatus, settings: AutoRoutingSettings, t: Strings, page: AutoPageHost, view: AutoView, save: (change: (next: AutoRoutingSettings) => void) => void): HTMLElement {
  const box = el('div', { dataset: { auto: 'catalog' } });
  box.append(el('h2', { textContent: t.catalog }), el('p', { className: 'muted', textContent: t.catalogLead }));
  const sources = el('ul', { className: 'recent' });
  for (const source of status.sources) sources.append(el('li', { dataset: { source: source.id } }, el('strong', { textContent: t.sourceName[source.id] ?? source.id }), ` — ${t.source(source, dateOf)}`));
  box.append(sources);
  if (status.bundled) box.append(el('p', { className: 'muted', textContent: t.bundled }));
  if (status.lastError) box.append(el('p', { className: 'muted', textContent: t.lastError(status.lastError) }));
  box.append(el('p', { className: 'muted', textContent: status.nextRefreshAt ? t.next(dateOf(status.nextRefreshAt)) : t.noNext }));
  const busy = view.refreshing || status.refreshing;
  const refresh = el('button', { type: 'button', textContent: busy ? t.refreshing : t.refresh, name: 'auto-catalog-refresh', disabled: busy });
  refresh.addEventListener('click', () => {
    view.refreshing = true; page.reload();
    page.request('auto.refreshCatalog').catch(error => page.say(error instanceof Error ? error.message : String(error))).finally(() => { view.refreshing = false; page.reload(); });
  });
  const hours = el('input', { type: 'number', name: 'auto-catalog-hours', min: '1', max: '720', step: '1', value: String(settings.catalog.refreshHours) });
  hours.addEventListener('change', () => { const value = Math.round(Number(hours.value)); if (value >= 1 && value <= 720) save(next => { next.catalog.refreshHours = value; }); });
  box.append(el('div', { className: 'row' }, refresh,
    checkOf('auto-catalog-auto', settings.catalog.autoRefresh, t.autoRefresh, value => save(next => { next.catalog.autoRefresh = value; })),
    el('span', { textContent: t.every }), hours));
  return box;
}

function upstreamRow(upstream: AutoUpstream, state: AutoState, t: Strings, page: AutoPageHost, save: (change: (next: AutoRoutingSettings) => void) => void, view: AutoView): HTMLLIElement {
  const edit = (change: (entry: AutoUpstream) => void): void => save(next => { change(next.upstreams.find(entry => entry.id === upstream.id)!); });
  const item = el('li', { className: 'backend', dataset: { upstream: upstream.id } });
  item.append(el('div', { className: 'row' }, el('strong', { textContent: `${t.preset[upstream.preset] ?? upstream.preset} · ${upstream.id}` }), el('span', { className: 'muted', textContent: upstream.baseUrl })));
  const trustOptions: Array<[AutoUpstream['trust'], string]> = [['D0', 'D0'], ['D1', 'D1'], ['D2', 'D2'], ...(isLocal(upstream.baseUrl) ? [['D3', 'D3'] as [AutoUpstream['trust'], string]] : [])];
  const check = el('button', { type: 'button', textContent: t.check, name: `auto-check-${upstream.id}` });
  check.addEventListener('click', () => {
    view.checks.set(upstream.id, t.checking); page.reload();
    page.request('auto.test', { upstreamId: upstream.id }).then(result => {
      const r = result as { ok: boolean; status: number | null; missing: string[]; listed: number | null };
      view.checks.set(upstream.id, r.ok ? t.checkOk(r.listed, r.missing) : t.checkFail(r.status));
      page.reload();
    }, error => { view.checks.set(upstream.id, error instanceof Error ? error.message : String(error)); page.reload(); });
  });
  const remove = el('button', { type: 'button', textContent: t.remove, name: `auto-remove-${upstream.id}` });
  remove.addEventListener('click', () => save(next => { next.upstreams = next.upstreams.filter(entry => entry.id !== upstream.id); }));
  item.append(el('div', { className: 'row' },
    checkOf(`auto-enabled-${upstream.id}`, upstream.enabled, t.on, value => edit(entry => { entry.enabled = value; })),
    el('span', { className: 'label', textContent: t.trust }),
    selectOf(`auto-trust-${upstream.id}`, upstream.trust, trustOptions, value => edit(entry => { entry.trust = value; })),
    check, remove));
  item.append(el('p', { className: 'muted', textContent: t.trustHelp }));
  // Keys: written straight into the plugin's secrets, bound to this upstream's address, never read back.
  const keyChoices: Array<[AutoUpstream['key'], string]> = [['own', t.keyOwn], ...(upstream.preset === 'openrouter' ? [['jev', t.keyJev] as [AutoUpstream['key'], string]] : []), ...(isLocal(upstream.baseUrl) ? [['none', t.keyNone] as [AutoUpstream['key'], string]] : [])];
  const keyRow = el('div', { className: 'row' }, el('span', { className: 'label', textContent: t.keyFrom }), selectOf(`auto-key-from-${upstream.id}`, upstream.key, keyChoices, value => edit(entry => { entry.key = value; })), el('span', { className: 'muted', textContent: state.keys[upstream.id] ? t.keySet : t.keyMissing }));
  if (upstream.key === 'own') {
    const input = el('input', { type: 'password', placeholder: t.keyPlaceholder, autocomplete: 'off', name: `auto-key-${upstream.id}` });
    const saveKey = el('button', { type: 'button', textContent: t.saveKey });
    saveKey.addEventListener('click', async () => {
      const value = input.value.trim();
      if (!value) return;
      try {
        const slot = await page.request('auto.keySlot', { upstreamId: upstream.id }) as { secret: string; origin: string };
        await page.setSecret(slot.secret, JSON.stringify({ origin: slot.origin, value }));
        input.value = '';
        page.reload();
      } catch (error) { page.say(error instanceof Error ? error.message : String(error)); }
    });
    const removeKey = el('button', { type: 'button', textContent: t.removeKey });
    removeKey.addEventListener('click', async () => {
      try { const slot = await page.request('auto.keySlot', { upstreamId: upstream.id }) as { secret: string }; await page.deleteSecret(slot.secret); page.reload(); }
      catch (error) { page.say(error instanceof Error ? error.message : String(error)); }
    });
    keyRow.append(input, saveKey, removeKey);
  }
  item.append(keyRow);
  if (upstream.preset === 'openrouter') {
    item.append(checkOf(`auto-all-${upstream.id}`, upstream.allModels, t.allModels, value => edit(entry => { entry.allModels = value; })));
    if (state.waitingForList?.includes(upstream.id)) item.append(el('p', { className: 'muted', textContent: t.waiting }));
  }
  item.append(modelTable(upstream, state.models?.[upstream.id] ?? null, t, page, edit, view));
  const result = view.checks.get(upstream.id);
  if (result) item.append(el('div', { className: 'check-result', textContent: result, dataset: { result: upstream.id } }));
  return item;
}

/**
 * The person's choice for one model: kept in the listed entry (created for an override). An override on a model that
 * OpenRouter's own list offers is dropped again once it says nothing beyond the id.
 */
function setOverride(entry: AutoUpstream, id: string, fromList: boolean, change: (model: AutoModel) => void): void {
  let model = entry.models.find(other => other.id === id);
  if (!model) { model = { id }; entry.models.push(model); }
  change(model);
  if (fromList && Object.keys(model).length === 1) entry.models = entry.models.filter(other => other !== model);
}

function modelTable(upstream: AutoUpstream, rows: ModelRow[] | null, t: Strings, page: AutoPageHost, edit: (change: (entry: AutoUpstream) => void) => void, view: AutoView): HTMLElement {
  const box = el('div', { className: 'models', dataset: { models: upstream.id } });
  // An older service sends no rows: the person's own list, without catalog facts.
  const all: ModelRow[] = rows ?? upstream.models.map(model => ({ id: model.id, listed: true, fromList: false, excluded: (upstream.excluded ?? []).includes(model.id), tier: model.tier ?? null, effort: model.effort ?? null,
    priceIn: model.priceIn ?? null, priceOut: model.priceOut ?? null, priceSource: model.priceIn !== undefined || model.priceOut !== undefined ? 'person' : null, context: model.context ?? null, known: false, measuredEfforts: [], scores: {} }));
  const filter = view.filter.get(upstream.id) ?? '';
  const query = filter.trim().toLowerCase();
  const matching = query ? all.filter(row => row.id.toLowerCase().includes(query)) : all;
  const shownCount = Math.min(matching.length, view.shown.get(upstream.id) ?? PAGE);
  const filterInput = el('input', { name: `auto-filter-${upstream.id}`, placeholder: t.filter, value: filter });
  filterInput.addEventListener('change', () => { view.filter.set(upstream.id, filterInput.value); view.shown.delete(upstream.id); page.reload(); });
  const typeSelect = selectOf(`auto-score-type-${upstream.id}`, view.type, TYPES.map(type => [type, t.type[type]!] as [string, string]), value => { view.type = value; page.reload(); });
  box.append(el('div', { className: 'row' }, el('span', { className: 'label', textContent: t.models }), filterInput, el('span', { textContent: t.scoreFor }), typeSelect,
    el('span', { className: 'muted', textContent: t.shown(shownCount, matching.length) })));
  box.append(el('p', { className: 'muted', textContent: t.tableHelp }));
  if (!all.length) box.append(el('p', { className: 'muted', textContent: t.noModels }));
  else {
    const table = el('table', { className: 'model-table' });
    const head = el('tr');
    for (const label of [t.col.use, t.col.model, t.col.context, t.col.price, t.col.score, t.col.efforts, t.col.effort, t.col.tier, t.col.remove]) head.append(el('th', { textContent: label }));
    table.append(el('thead', {}, head));
    const body = el('tbody');
    for (const row of matching.slice(0, shownCount)) {
      const use = el('input', { type: 'checkbox', checked: !row.excluded, name: `auto-use-${upstream.id}-${row.id}` });
      use.addEventListener('change', () => edit(entry => { entry.excluded = use.checked ? entry.excluded.filter(id => id !== row.id) : [...new Set([...entry.excluded, row.id])]; }));
      const score = row.scores[view.type as keyof ModelRow['scores']];
      const priceFrom = row.priceSource === 'person' ? t.fromPerson : row.priceSource === 'openrouter' ? t.fromList : row.priceSource === 'models.dev' ? t.fromDev : '';
      // OpenRouter: only efforts the catalog measured (Auto sends them); elsewhere any effort names the upstream's own setting.
      const efforts = upstream.preset === 'openrouter' ? row.measuredEfforts : [...EFFORTS];
      const effortSelect = selectOf(`auto-effort-${upstream.id}-${row.id}`, row.effort ?? '', [['', t.effortDefault], ...[...new Set([...(row.effort ? [row.effort] : []), ...efforts])].map(effort => [effort, effort] as [string, string])],
        value => edit(entry => setOverride(entry, row.id, row.fromList, model => { if (value) model.effort = value as AutoModel['effort']; else delete model.effort; })));
      const tierSelect = selectOf(`auto-tier-${upstream.id}-${row.id}`, row.tier ?? '', [['', t.tierAuto], ...(['small', 'medium', 'large'] as const).map(tier => [tier, t.tier[tier]!] as [string, string])],
        value => edit(entry => setOverride(entry, row.id, row.fromList, model => { if (value) model.tier = value as AutoTier; else delete model.tier; })));
      const drop = el('button', { type: 'button', textContent: t.remove, name: `auto-drop-${upstream.id}-${row.id}` });
      drop.addEventListener('click', () => edit(entry => { entry.models = entry.models.filter(other => other.id !== row.id); }));
      body.append(el('tr', { dataset: { model: row.id } },
        el('td', {}, use),
        el('td', {}, el('code', { textContent: row.id })),
        el('td', { textContent: kTokens(row.context) }),
        el('td', { textContent: row.priceIn === null && row.priceOut === null ? t.unknown : `${usd(row.priceIn)} · ${usd(row.priceOut)}${priceFrom ? ` (${priceFrom})` : ''}` }),
        el('td', { textContent: score ? `${score.value.toFixed(1)}${score.effort ? ` @${score.effort}` : ''} · ${score.label}${score.historical ? ` · ${t.old}` : ''}` : t.unknown }),
        el('td', { textContent: row.measuredEfforts.join(', ') || '—' }),
        el('td', {}, effortSelect),
        el('td', {}, tierSelect),
        el('td', {}, row.listed && !row.fromList ? drop : '')));
    }
    table.append(body);
    box.append(el('div', { className: 'table-wrap' }, table));
    if (shownCount < matching.length) {
      const more = el('button', { type: 'button', textContent: t.more, name: `auto-more-${upstream.id}` });
      more.addEventListener('click', () => { view.shown.set(upstream.id, shownCount + PAGE); page.reload(); });
      box.append(more);
    }
  }
  // Add a model by its exact id (the whole allow-list of an OpenAI-compatible upstream; an addition on OpenRouter).
  const id = el('input', { name: `auto-model-id-${upstream.id}`, placeholder: t.modelId });
  const tier = selectOf<string>(`auto-model-tier-${upstream.id}`, '', [['', t.tierAuto], ...(['small', 'medium', 'large'] as const).map(value => [value, t.tier[value]!] as [string, string])], () => undefined);
  const priceIn = el('input', { type: 'number', min: '0', step: '0.01', placeholder: t.priceIn, name: `auto-price-in-${upstream.id}` });
  const priceOut = el('input', { type: 'number', min: '0', step: '0.01', placeholder: t.priceOut, name: `auto-price-out-${upstream.id}` });
  const add = el('button', { type: 'button', textContent: t.addModel, name: `auto-add-model-${upstream.id}` });
  add.addEventListener('click', () => {
    const modelId = id.value.trim();
    if (!modelId) return;
    const model: AutoModel = { id: modelId };
    if (tier.value) model.tier = tier.value as AutoTier;
    const pin = number(priceIn.value), pout = number(priceOut.value);
    if (pin !== undefined) model.priceIn = pin;
    if (pout !== undefined) model.priceOut = pout;
    edit(entry => { if (!entry.models.some(other => other.id === modelId)) entry.models.push(model); });
  });
  box.append(el('div', { className: 'add' }, id, tier, priceIn, priceOut, add));
  return box;
}

function addUpstream(settings: AutoRoutingSettings, t: Strings, save: (change: (next: AutoRoutingSettings) => void) => void): HTMLDivElement {
  const form = el('div', { className: 'add' });
  const preset = selectOf<AutoUpstream['preset']>('auto-new-preset', 'openrouter', [['openrouter', t.preset.openrouter!], ['openai-compatible', t.preset['openai-compatible']!]], value => { url.disabled = value === 'openrouter'; url.value = value === 'openrouter' ? OPENROUTER : 'https://'; });
  const id = el('input', { name: 'auto-new-id', placeholder: t.idLabel, value: settings.upstreams.some(entry => entry.id === 'openrouter') ? '' : 'openrouter' });
  const url = el('input', { name: 'auto-new-url', placeholder: t.baseUrl, value: OPENROUTER, disabled: true });
  const add = el('button', { type: 'button', textContent: t.add, name: 'auto-add-upstream' });
  add.addEventListener('click', () => {
    const kind = preset.value as AutoUpstream['preset'];
    const entry: AutoUpstream = { id: id.value.trim(), preset: kind, baseUrl: kind === 'openrouter' ? OPENROUTER : url.value.trim(), trust: 'D1', key: 'own', models: [], allModels: kind === 'openrouter', excluded: [], enabled: true };
    save(next => { next.upstreams.push(entry); });
  });
  form.append(preset, id, url, add);
  return form;
}
