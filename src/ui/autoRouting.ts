// The "Model: Auto (Jev)" rows on the decision models page: the public catalog's freshness (with a manual refresh),
// upstreams (keys are write-only, bound to the upstream's address) with a table of their models — price, context and
// score are read-only, detected from the catalog; the person's choices are the exclude toggle, an optional manual
// tier and effort — the preference, caps, who decides, and the recent decisions (task type, difficulty, model,
// score, price, why — never any text). Same look as the rest of the page.
import type { CatalogStatus } from '../auto/catalog/catalog.ts';
import { EFFORTS } from '../auto/catalog/identity.ts';
import type { DecisionRecord, RouterStats } from '../auto/router.ts';
import type { ModelRow } from '../auto/service.ts';
import { DEFAULT_AUTO_SETTINGS, accountUpstream, type AutoModel, type AutoRoutingSettings, type AutoStrategySettings, type AutoTier, type AutoUpstream } from '../auto/settings.ts';
import { el } from './common.ts';

export interface AutoState {
  /** The Jev · OpenRouter key is saved (absent from an older service). */
  jevKey?: boolean;
  settings: AutoRoutingSettings;
  readable: boolean;
  keys: Record<string, boolean>;
  recent: DecisionRecord[];
  stats: RouterStats & { spentToday: number; callsToday?: number; listening: boolean; cards: number };
  /** Absent from an older service. */
  catalog?: CatalogStatus;
  models?: Record<string, ModelRow[]>;
  waitingForList?: string[];
  /** Accounts CanvasTTY brokers for this plugin (absent from an older service). */
  brokered?: { mode: string; accounts: BrokeredAccountView[] };
}

/** One account CanvasTTY's accounts.list gave (no key, no secret name). */
export interface BrokeredAccountView { ref: string; ownerName: string; id: string; label: string; protocol: string; origin: string; paths: string[]; models: string[]; flatRate: boolean }

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

/**
 * The catalog's notes (written by the service in English) as one short phrase in the person's language. A note this
 * page does not know is shown as it came in English, and as a generic phrase in Russian.
 */
export function catalogNote(text: string, locale: 'en' | 'ru'): string {
  const partial = /returned (\d+) rows \((\d+) known\)/u.exec(text);
  if (partial) return locale === 'ru' ? `пришло ${partial[1]} строк из ${partial[2]}; прежние оценки сохранены` : `returned ${partial[1]} of ${partial[2]} rows; earlier scores kept`;
  if (/unavailable; earlier scores keep their age/u.test(text)) return locale === 'ru' ? 'недоступен; прежние оценки сохранены' : 'unavailable; earlier scores kept';
  if (/unavailable; the earlier list keeps its age/u.test(text)) return locale === 'ru' ? 'недоступен; прежний список сохранён' : 'unavailable; earlier list kept';
  if (/timed out/u.test(text)) return locale === 'ru' ? 'не успело за отведённое время' : 'timed out';
  if (/cancelled/u.test(text)) return locale === 'ru' ? 'отменено' : 'cancelled';
  if (/unavailable|failed/u.test(text)) return locale === 'ru' ? 'источник недоступен' : 'a source is unavailable';
  return locale === 'ru' ? 'данные источника не подошли' : text;
}

/** An upstream on OpenRouter (saved before the Jev-only rule): shown off, with a note. */
const jevOnlyUpstream = (upstream: AutoUpstream): boolean => upstream.preset === 'openrouter' || /(?:^|\.)openrouter\.ai$/iu.test((() => { try { return new URL(upstream.baseUrl).hostname.replace(/\.+$/u, ''); } catch { return ''; } })());

const AUTO_TYPE_EN: Record<string, string> = { coding: 'coding', review: 'review', research: 'research', writing: 'writing', chat: 'chat' };
const AUTO_TYPE_RU: Record<string, string> = { coding: 'код', review: 'ревью', research: 'исследование', writing: 'тексты', chat: 'общение' };
const AUTO_LEVEL_EN: Record<string, string> = { small: 'small', medium: 'medium', large: 'large' };
const AUTO_LEVEL_RU: Record<string, string> = { small: 'маленький', medium: 'средний', large: 'большой' };

export const AUTO_PAGE_STRINGS = {
  en: {
    title: 'Model: Auto (Jev)',
    lead: 'For OpenCode cards started with Model: Auto. Each new turn goes to the model that suits it best for the price, among the models you allow. How it decides: README, "How Auto decides".',
    catalog: 'Catalog', refresh: 'Refresh now', refreshing: 'Refreshing…',
    catalogLead: 'Public model lists and benchmark scores, read without your key or any task text.',
    sourceName: { 'models.dev': 'models.dev', 'artificial-analysis': 'Artificial Analysis', livebench: 'LiveBench', openrouter: 'OpenRouter models' } as Record<string, string>,
    source: (s: CatalogStatus['sources'][number], date: (at: number) => string) => `${s.fetchedAt === null ? 'not loaded' : `loaded ${date(s.fetchedAt)}`}${s.version ? `, v${s.version}` : ''}${s.rows ? `, ${s.measured ? `${s.measured} measured of ` : ''}${s.rows} rows` : ''}${s.fetchedAt !== null && s.stale ? ' — old' : ''}${s.error ? ` — ${catalogNote(s.error, 'en')}` : ''}`,
    bundled: 'Using the scores that ship with the plugin until the first download.',
    next: (date: string) => `Next background refresh: ${date}.`, noNext: 'Background refresh is off (or no upstream is on).',
    autoRefresh: 'Refresh in the background', every: 'every, hours', lastError: (e: string) => `Last refresh: ${catalogNote(e, 'en')}.`,
    upstreams: 'Upstreams', none: 'None yet.', add: 'Add', remove: 'Remove', on: 'On', check: 'Check', checking: 'Checking…',
    preset: { openrouter: 'OpenRouter', 'openai-compatible': 'OpenAI-compatible', account: 'Account in another extension' } as Record<string, string>,
    brokered: 'Accounts from other extensions',
    brokeredLead: 'Accounts another extension (for example Accounts) lets Auto use: CanvasTTY sends each request with that extension\'s key, and Auto never sees it. Mark an account there, allow Assistant under Settings → Agents → Extension native code, then add it here and choose how far you trust it.',
    brokeredNone: 'No account is allowed for Auto yet.',
    brokeredUnsupported: 'This CanvasTTY cannot send requests through other extensions\' accounts.',
    brokeredUse: 'Use in Auto', brokeredAnthropic: 'speaks the Anthropic API; Auto needs an OpenAI-compatible account',
    accountVia: (owner: string, label: string) => `Through CanvasTTY: ${owner} · ${label}. The key stays there.`,
    accountNotListed: 'CanvasTTY does not offer this account to Auto now (not allowed, unmarked, or its extension is off).',
    fromPlan: 'plan',
    idLabel: 'Name (a-z, 0-9, -)', baseUrl: 'Base URL (…/v1)', trust: 'I trust it with', trustHelp: 'Secret data only for a server on this computer.',
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
    tableHelp: 'Untick a model to exclude it. Hover a score for its source.',
    checkOk: (listed: number | null, missing: string[]) => `Works${listed !== null ? ` (${listed} models listed)` : ''}.${missing.length ? ` Not listed by it: ${missing.join(', ')}.` : ''}`,
    checkFail: (status: number | null) => status === null ? 'No answer, or no key saved.' : `It answered ${status}.`,
    choices: 'Choices', preference: 'Preference', pref: { cheap: 'Cheap', balanced: 'Balanced', best: 'Best' } as Record<string, string>,
    prefHelp: 'Cheaper gives up a little quality for price; Better always takes the best-scored model.',
    cheaper: 'If a model you pinned to a level is not available, a cheaper level may answer',
    decider: 'Who judges a turn', deciderJev: 'Jev, word rules when it does not answer', deciderRules: 'Word rules only',
    daily: 'Daily cap, USD', perCard: 'Per card, USD', capsHelp: 'Auto stops when a limit is spent. 0 turns it off.',
    save: 'Save',
    strategies: 'Several models on hard turns', consensus: 'Consensus', consensusMode: { off: 'Off', auto: 'Auto: only when it pays', always: 'Always for hard turns' } as Record<string, string>,
    models_k: 'Models in a consensus', bestOfN: 'Compare several models and keep the best answer (best of N)', turnCap: 'At most per turn, USD',
    strategyHelp: 'Only for hard writing and design turns. Auto: only when several models are likely better than one strong model for the price. Best of N stays off unless you turn it on.',
    strategyOf: { single: 'one model', consensus: 'consensus', 'best-of-n': 'best of N' } as Record<string, string>,
    fanOutcome: { merged: 'merged', picked: 'best picked', tool_calls: 'tool call: one model', one_draft: 'one draft left', no_draft: 'no draft: one model', judge_failed: 'judge failed: best draft' } as Record<string, string>,
    drafts: (ok: number, all: number) => `${ok} of ${all} drafts`,
    fanStats: (s: AutoState['stats']) => s.fanOuts ? ` Several models: ${s.fanOuts} turns, ${s.merged} merged, ${s.fanOutToolCalls} turned out to call tools, ${s.fanOutDegraded} with drafts missing, ${s.judgeFailed} judge failures.` : '',
    classes: { D0: 'Public', D1: 'Internal', D2: 'Confidential', D3: 'Secret' } as Record<string, string>,
    jevOnlyNote: 'Off: OpenRouter serves only Jev\'s own decisions, never Auto\'s model calls.',
    turnLine: (r: DecisionRecord) => `${r.model ?? '—'} · ${r.taskType ? AUTO_TYPE_EN[r.taskType] ?? r.taskType : '—'}, ${r.difficulty ? AUTO_LEVEL_EN[r.difficulty] ?? r.difficulty : '—'}${r.strategy && r.strategy !== 'single' ? ' · several models' : ''}${r.costUsd !== null ? ` · $${r.costUsd.toFixed(4)}` : ''}`,
    recent: 'Recent decisions', noRecent: 'Nothing routed yet.',
    stats: (s: AutoState['stats']) => `${s.requests} model calls, Jev asked ${s.jevAsked} times (${s.jevAnswered} answered), ${s.leaseReuses} reused a turn's choice, ${s.failovers} failovers; today $${s.spentToday.toFixed(4)}; ${s.listening ? `listening for ${s.cards} card(s)` : 'not listening'}${s.hosts.length ? `; sent to ${s.hosts.join(', ')}` : ''}.`,
    kind: { turn: 'turn', continuation: 'tool step', small: 'title' } as Record<string, string>,
    sourceOf: { jev: 'Jev', rules: 'rules', lease: 'same turn', small: 'small rule' } as Record<string, string>,
    why: { small_model: 'cheapest', manual_tier: 'your tier', best_score: 'best score', cheaper_tie: 'best score, cheaper', cheaper_within_loss: 'cheaper, within the allowed loss', lower_effort_within_loss: 'lower effort, within the allowed loss', kept_turn_model: 'turn\'s model', manual_tier_fallback: 'your tiers (nothing scored)', unknown_scores: 'no scores: middle price', no_model: 'no model' } as Record<string, string>,
    tradeoff: (lost: string, best: string, score: string, cheaper: string | null, window: number) => `${lost} points below ${best} (${score})${cheaper ? `, ${cheaper}% cheaper` : ''}; allowed ${window}`,
    unreadable: 'The saved Auto (Jev) settings could not be read yet; nothing can be changed until they are.'
  },
  ru: {
    title: 'Модель: Авто (Jev)',
    lead: 'Для окон OpenCode, запущенных с «Модель: Авто». Каждый новый ход получает модель, которая лучше всего подходит по цене, из разрешённых вами. Как это решается — в README, «Как решает Авто».',
    catalog: 'Каталог', refresh: 'Обновить сейчас', refreshing: 'Обновляю…',
    catalogLead: 'Открытые списки моделей и оценки бенчмарков; читаются без вашего ключа и без текста задач.',
    sourceName: { 'models.dev': 'models.dev', 'artificial-analysis': 'Artificial Analysis', livebench: 'LiveBench', openrouter: 'Модели OpenRouter' } as Record<string, string>,
    source: (s: CatalogStatus['sources'][number], date: (at: number) => string) => `${s.fetchedAt === null ? 'не загружено' : `загружено ${date(s.fetchedAt)}`}${s.version ? `, v${s.version}` : ''}${s.rows ? (s.measured ? `, измерено ${s.measured} строк из ${s.rows}` : `, строк: ${s.rows}`) : ''}${s.fetchedAt !== null && s.stale ? ' — устарело' : ''}${s.error ? ` — ${catalogNote(s.error, 'ru')}` : ''}`,
    bundled: 'До первой загрузки используются оценки, поставляемые с плагином.',
    next: (date: string) => `Следующее фоновое обновление: ${date}.`, noNext: 'Фоновое обновление выключено (или нет включённого поставщика).',
    autoRefresh: 'Обновлять в фоне', every: 'каждые, часов', lastError: (e: string) => `Последнее обновление: ${catalogNote(e, 'ru')}.`,
    upstreams: 'Поставщики', none: 'Пока нет.', add: 'Добавить', remove: 'Удалить', on: 'Вкл', check: 'Проверить', checking: 'Проверяю…',
    preset: { openrouter: 'OpenRouter', 'openai-compatible': 'Совместимый с OpenAI', account: 'Учётная запись другого расширения' } as Record<string, string>,
    brokered: 'Учётные записи других расширений',
    brokeredLead: 'Учётные записи, которые другое расширение (например, Accounts) разрешает Auto: CanvasTTY отправляет каждый запрос с ключом того расширения, Auto его не видит. Отметьте запись там, разрешите Assistant в Настройки → Агенты → Нативный код расширений, затем добавьте её здесь и выберите, насколько ей доверяете.',
    brokeredNone: 'Пока ни одна учётная запись не разрешена для Auto.',
    brokeredUnsupported: 'Этот CanvasTTY не умеет отправлять запросы через учётные записи других расширений.',
    brokeredUse: 'Использовать в Auto', brokeredAnthropic: 'работает по API Anthropic; Auto нужна совместимая с OpenAI запись',
    accountVia: (owner: string, label: string) => `Через CanvasTTY: ${owner} · ${label}. Ключ остаётся там.`,
    accountNotListed: 'CanvasTTY сейчас не предлагает эту запись Auto (не разрешена, не отмечена или её расширение выключено).',
    fromPlan: 'подписка',
    idLabel: 'Имя (a-z, 0-9, -)', baseUrl: 'Базовый адрес (…/v1)', trust: 'Доверяю до', trustHelp: 'Секретные данные — только серверу на этом компьютере.',
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
    tableHelp: 'Снимите отметку, чтобы исключить модель. Источник оценки — в подсказке.',
    checkOk: (listed: number | null, missing: string[]) => `Работает${listed !== null ? ` (моделей в списке: ${listed})` : ''}.${missing.length ? ` Нет в его списке: ${missing.join(', ')}.` : ''}`,
    checkFail: (status: number | null) => status === null ? 'Нет ответа или не сохранён ключ.' : `Ответ: ${status}.`,
    choices: 'Выбор', preference: 'Предпочтение', pref: { cheap: 'Дешевле', balanced: 'Сбалансированно', best: 'Лучше' } as Record<string, string>,
    prefHelp: '«Дешевле» уступает немного качества ради цены; «Лучше» всегда берёт модель с лучшей оценкой.',
    cheaper: 'Если закреплённая за уровнем модель недоступна, может ответить более дешёвый уровень',
    decider: 'Кто оценивает ход', deciderJev: 'Jev, словесные правила, если он не ответил', deciderRules: 'Только словесные правила',
    daily: 'Предел в день, USD', perCard: 'На окно, USD', capsHelp: 'Когда предел потрачен, «Авто» останавливается. 0 выключает его.',
    save: 'Сохранить',
    strategies: 'Несколько моделей на сложных ходах', consensus: 'Консенсус', consensusMode: { off: 'Выключен', auto: 'Авто: только когда окупается', always: 'Всегда на сложных ходах' } as Record<string, string>,
    models_k: 'Моделей в консенсусе', bestOfN: 'Сравнивать несколько моделей и оставлять лучший ответ (лучший из N)', turnCap: 'Не больше за ход, USD',
    strategyHelp: 'Только для сложных ходов с текстом и проектированием. «Авто»: только когда несколько моделей, вероятно, лучше одной сильной за свою цену. «Лучший из N» выключен, пока вы его не включите.',
    strategyOf: { single: 'одна модель', consensus: 'консенсус', 'best-of-n': 'лучший из N' } as Record<string, string>,
    fanOutcome: { merged: 'сведено', picked: 'выбран лучший', tool_calls: 'вызов инструмента: одна модель', one_draft: 'остался один черновик', no_draft: 'нет черновиков: одна модель', judge_failed: 'судья не ответил: лучший черновик' } as Record<string, string>,
    drafts: (ok: number, all: number) => `черновиков: ${ok} из ${all}`,
    fanStats: (s: AutoState['stats']) => s.fanOuts ? ` Несколько моделей: ходов ${s.fanOuts}, сведено ${s.merged}, оказались с инструментами ${s.fanOutToolCalls}, без части черновиков ${s.fanOutDegraded}, отказов судьи ${s.judgeFailed}.` : '',
    classes: { D0: 'Открытые', D1: 'Внутренние', D2: 'Конфиденциальные', D3: 'Секретные' } as Record<string, string>,
    jevOnlyNote: 'Выключен: OpenRouter служит только для решений самого Jev, не для вызовов моделей «Авто».',
    turnLine: (r: DecisionRecord) => `${r.model ?? '—'} · ${r.taskType ? AUTO_TYPE_RU[r.taskType] ?? r.taskType : '—'}, ${r.difficulty ? AUTO_LEVEL_RU[r.difficulty] ?? r.difficulty : '—'}${r.strategy && r.strategy !== 'single' ? ' · несколько моделей' : ''}${r.costUsd !== null ? ` · $${r.costUsd.toFixed(4)}` : ''}`,
    recent: 'Последние решения', noRecent: 'Пока ничего не маршрутизировано.',
    stats: (s: AutoState['stats']) => `Вызовов моделей: ${s.requests}, Jev спрошен ${s.jevAsked} раз (ответил ${s.jevAnswered}), решение хода повторно: ${s.leaseReuses}, переключений: ${s.failovers}; сегодня $${s.spentToday.toFixed(4)}; ${s.listening ? `слушает, окон: ${s.cards}` : 'не слушает'}${s.hosts.length ? `; отправлено на ${s.hosts.join(', ')}` : ''}.`,
    kind: { turn: 'ход', continuation: 'шаг инструмента', small: 'заголовок' } as Record<string, string>,
    sourceOf: { jev: 'Jev', rules: 'правила', lease: 'тот же ход', small: 'правило маленькой' } as Record<string, string>,
    why: { small_model: 'самая дешёвая', manual_tier: 'ваш уровень', best_score: 'лучшая оценка', cheaper_tie: 'лучшая оценка, дешевле', cheaper_within_loss: 'дешевле, в пределах допустимой потери', lower_effort_within_loss: 'меньше рассуждения, в пределах допустимой потери', kept_turn_model: 'модель хода', manual_tier_fallback: 'ваши уровни (оценок нет)', unknown_scores: 'оценок нет: средняя цена', no_model: 'нет модели' } as Record<string, string>,
    tradeoff: (lost: string, best: string, score: string, cheaper: string | null, window: number) => `на ${lost} балла ниже ${best} (${score})${cheaper ? `, дешевле на ${cheaper}%` : ''}; допустимо ${window}`,
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
  if (state.brokered) section.append(brokeredSection(state.brokered, settings, t, save));

  section.append(el('h2', { textContent: t.choices }),
    labelled(t.preference, selectOf('auto-preference', settings.preference, (['cheap', 'balanced', 'best'] as const).map(p => [p, t.pref[p]!] as [typeof p, string]), value => save(next => { next.preference = value; }))),
    el('p', { className: 'muted', textContent: t.prefHelp }),
    checkOf('auto-cheaper', settings.cheaperFallback, t.cheaper, value => save(next => { next.cheaperFallback = value; })),
    labelled(t.decider, selectOf('auto-decider', settings.decider, [['jev', t.deciderJev], ['rules', t.deciderRules]], value => save(next => { next.decider = value; }))));
  // The daily limit is in the short view above; here only the limit per card.
  const perCard = el('input', { type: 'number', name: 'auto-per-card', min: '0', max: '100', step: '0.01', value: String(settings.perCardUsdCap) });
  const saveCaps = el('button', { type: 'button', textContent: t.save, name: 'auto-caps-save' });
  saveCaps.addEventListener('click', () => save(next => { next.perCardUsdCap = Number(perCard.value); }));
  section.append(el('div', { className: 'row' }, el('span', { className: 'label', textContent: t.perCard }), perCard, saveCaps),
    el('p', { className: 'muted', textContent: t.capsHelp }));

  section.append(strategySection(settings, t, save));

  section.append(el('h2', { textContent: t.recent }), el('p', { className: 'muted', textContent: t.stats(state.stats) + t.fanStats(state.stats), dataset: { auto: 'stats' } }));
  const recent = el('ul', { className: 'recent', dataset: { auto: 'recent' } });
  if (!state.recent.length) recent.append(el('li', { className: 'muted', textContent: t.noRecent }));
  for (const record of state.recent.slice(0, 5)) recent.append(recentRow(record, t));
  section.append(recent);
  return section;
}

/** Several models on hard turns: consensus mode, K, best of N (off by default), the cap per turn. */
function strategySection(settings: AutoRoutingSettings, t: Strings, save: (change: (next: AutoRoutingSettings) => void) => void): HTMLElement {
  // An older service sends no strategy: its defaults are shown, and saving adds them.
  const current: AutoStrategySettings = settings.strategy ?? DEFAULT_AUTO_SETTINGS.strategy;
  const edit = (change: (strategy: AutoStrategySettings) => void): void => save(next => { next.strategy = { ...current }; change(next.strategy); });
  const box = el('div', { dataset: { auto: 'strategies' } });
  const cap = el('input', { type: 'number', name: 'auto-turn-cap', min: '0', max: '100', step: '0.01', value: String(current.turnUsdCap) });
  const saveCap = el('button', { type: 'button', textContent: t.save, name: 'auto-turn-cap-save' });
  saveCap.addEventListener('click', () => edit(strategy => { strategy.turnUsdCap = Number(cap.value); }));
  box.append(el('h2', { textContent: t.strategies }),
    labelled(t.consensus, selectOf('auto-consensus', current.consensus, (['off', 'auto', 'always'] as const).map(mode => [mode, t.consensusMode[mode]!] as [typeof mode, string]), value => edit(strategy => { strategy.consensus = value; }))),
    labelled(t.models_k, selectOf('auto-consensus-k', String(current.k), [['2', '2'], ['3', '3']], value => edit(strategy => { strategy.k = Number(value); }))),
    checkOf('auto-best-of-n', current.bestOfN, t.bestOfN, value => edit(strategy => { strategy.bestOfN = value; })),
    el('div', { className: 'row' }, el('span', { className: 'label', textContent: t.turnCap }), cap, saveCap),
    el('p', { className: 'muted', textContent: t.strategyHelp }));
  return box;
}

/** What a decision gave up against the best-scored model for its type, when it took another one. */
function tradeoffText(record: DecisionRecord, t: Strings): string | null {
  const trade = record.tradeoff;
  if (!trade || !record.model || typeof record.score !== 'number') return null;
  if (trade.bestModel === record.model && trade.bestEffort === record.effort) return null;
  const blend = (priceIn: number | null, priceOut: number | null): number | null => priceIn === null && priceOut === null ? null : (priceIn ?? 0) + (priceOut ?? 0) * 3;
  const chosen = blend(record.priceIn, record.priceOut), best = blend(trade.bestPriceIn, trade.bestPriceOut);
  const cheaper = chosen !== null && best !== null && best > 0 && chosen < best ? String(Math.round((1 - chosen / best) * 100)) : null;
  return t.tradeoff(Math.max(0, trade.bestScore - record.score).toFixed(1), `${trade.bestModel}${trade.bestEffort ? `@${trade.bestEffort}` : ''}`, trade.bestScore.toFixed(1), cheaper, trade.window);
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
  const trade = tradeoffText(record, t);
  if (trade) tail.push(trade);
  if (record.strategy && record.strategy !== 'single') {
    const drafts = record.fanOut?.drafts ?? [];
    tail.push([t.strategyOf[record.strategy] ?? record.strategy, record.fanOut?.outcome ? t.fanOutcome[record.fanOut.outcome] ?? record.fanOut.outcome : null,
      drafts.length ? t.drafts(drafts.filter(d => d.status === 'text' || d.status === 'tool_calls').length, drafts.length) : null].filter(Boolean).join(', '));
  } else if (record.fanOut === null && record.strategyWhy === 'single_better') tail.push(t.strategyOf.single!);
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
  const trustOptions: Array<[AutoUpstream['trust'], string]> = (['D0', 'D1', 'D2', ...(isLocal(upstream.baseUrl) ? ['D3'] : [])] as Array<AutoUpstream['trust']>).map(c => [c, t.classes[c] ?? c] as [AutoUpstream['trust'], string]);
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
  if (jevOnlyUpstream(upstream)) item.append(el('p', { className: 'muted', textContent: t.jevOnlyNote, dataset: { note: 'jev-only' } }));
  item.append(el('p', { className: 'muted', textContent: t.trustHelp }));
  if (upstream.preset === 'account') {
    // Another extension's account: no key here, CanvasTTY adds it; only its models table follows.
    const account = state.brokered?.accounts.find(entry => entry.ref === upstream.account);
    item.append(el('p', { className: 'muted', dataset: { note: 'account' }, textContent: account ? t.accountVia(account.ownerName, account.label) : t.accountNotListed }));
    item.append(modelTable(upstream, state.models?.[upstream.id] ?? null, t, page, edit, view));
    const done = view.checks.get(upstream.id);
    if (done) item.append(el('div', { className: 'check-result', textContent: done, dataset: { result: upstream.id } }));
    return item;
  }
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
    for (const label of [t.col.use, t.col.model, t.col.score, t.col.effort, t.col.tier, t.col.remove]) head.append(el('th', { textContent: label }));
    table.append(el('thead', {}, head));
    const body = el('tbody');
    for (const row of matching.slice(0, shownCount)) {
      const use = el('input', { type: 'checkbox', checked: !row.excluded, name: `auto-use-${upstream.id}-${row.id}` });
      use.addEventListener('change', () => edit(entry => { entry.excluded = use.checked ? entry.excluded.filter(id => id !== row.id) : [...new Set([...entry.excluded, row.id])]; }));
      const score = row.scores[view.type as keyof ModelRow['scores']];
      const priceFrom = row.priceSource === 'plan' ? t.fromPlan : row.priceSource === 'person' ? t.fromPerson : row.priceSource === 'openrouter' ? t.fromList : row.priceSource === 'models.dev' ? t.fromDev : '';
      // OpenRouter: only efforts the catalog measured (Auto sends them); elsewhere any effort names the upstream's own setting.
      const efforts = upstream.preset === 'openrouter' ? row.measuredEfforts : [...EFFORTS];
      const effortSelect = selectOf(`auto-effort-${upstream.id}-${row.id}`, row.effort ?? '', [['', t.effortDefault], ...[...new Set([...(row.effort ? [row.effort] : []), ...efforts])].map(effort => [effort, effort] as [string, string])],
        value => edit(entry => setOverride(entry, row.id, row.fromList, model => { if (value) model.effort = value as AutoModel['effort']; else delete model.effort; })));
      const tierSelect = selectOf(`auto-tier-${upstream.id}-${row.id}`, row.tier ?? '', [['', t.tierAuto], ...(['small', 'medium', 'large'] as const).map(tier => [tier, t.tier[tier]!] as [string, string])],
        value => edit(entry => setOverride(entry, row.id, row.fromList, model => { if (value) model.tier = value as AutoTier; else delete model.tier; })));
      const drop = el('button', { type: 'button', textContent: t.remove, name: `auto-drop-${upstream.id}-${row.id}` });
      drop.addEventListener('click', () => edit(entry => { entry.models = entry.models.filter(other => other.id !== row.id); }));
      // Two lines per model (id; context and price), the score with its source and age in the tooltip: no column
      // runs off a narrow page.
      const price = row.priceIn === null && row.priceOut === null ? t.unknown : `$${usd(row.priceIn)} · $${usd(row.priceOut)}`;
      const scoreCell = el('td', { textContent: score ? `${score.value.toFixed(1)}${score.effort ? ` @${score.effort}` : ''}${score.historical ? ` (${t.old})` : ''}` : t.unknown });
      if (score || row.measuredEfforts.length) scoreCell.title = [score ? score.label : null, row.measuredEfforts.length ? `${t.col.efforts}: ${row.measuredEfforts.join(', ')}` : null].filter(Boolean).join(' · ');
      const modelCell = el('td', {}, el('code', { textContent: row.id }), el('div', { className: 'muted', textContent: `${kTokens(row.context)} · ${price}` }));
      if (priceFrom) modelCell.title = `${t.col.price}: ${priceFrom}`;
      body.append(el('tr', { dataset: { model: row.id } },
        el('td', {}, use),
        modelCell,
        scoreCell,
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
  // OpenRouter serves only Jev: Auto's providers are OpenAI-compatible addresses elsewhere.
  const preset = selectOf<AutoUpstream['preset']>('auto-new-preset', 'openai-compatible', [['openai-compatible', t.preset['openai-compatible']!]], () => undefined);
  const id = el('input', { name: 'auto-new-id', placeholder: t.idLabel, value: '' });
  const url = el('input', { name: 'auto-new-url', placeholder: t.baseUrl, value: 'https://' });
  const add = el('button', { type: 'button', textContent: t.add, name: 'auto-add-upstream' });
  add.addEventListener('click', () => {
    void preset;
    const entry: AutoUpstream = { id: id.value.trim(), preset: 'openai-compatible', baseUrl: url.value.trim(), trust: 'D1', key: 'own', models: [], allModels: false, excluded: [], enabled: true };
    save(next => { next.upstreams.push(entry); });
  });
  form.append(preset, id, url, add);
  return form;
}

/** Accounts CanvasTTY brokers for Auto: each one not added yet can become an upstream (trust chosen after adding). */
function brokeredSection(brokered: NonNullable<AutoState['brokered']>, settings: AutoRoutingSettings, t: Strings, save: (change: (next: AutoRoutingSettings) => void) => void): HTMLElement {
  const box = el('div', { className: 'brokered', dataset: { section: 'brokered' } });
  box.append(el('h3', { textContent: t.brokered }), el('p', { className: 'muted', textContent: t.brokeredLead }));
  if (brokered.mode === 'unsupported') { box.append(el('p', { className: 'muted', textContent: t.brokeredUnsupported })); return box; }
  if (!brokered.accounts.length) { box.append(el('p', { className: 'muted', textContent: t.brokeredNone })); return box; }
  const list = el('ul', { className: 'backends' });
  for (const account of brokered.accounts) {
    const added = settings.upstreams.some(upstream => upstream.preset === 'account' && upstream.account === account.ref);
    const usable = account.protocol === 'openai' && account.paths.includes('/chat/completions');
    const row = el('li', { className: 'backend', dataset: { account: account.ref } },
      el('strong', { textContent: `${account.ownerName} · ${account.label}` }),
      el('span', { className: 'muted', textContent: ` ${account.origin} · ${account.models.join(', ')}${account.flatRate ? ` · ${t.fromPlan}` : ''}${usable ? '' : ` · ${t.brokeredAnthropic}`}` }));
    if (!added && usable) {
      const use = el('button', { type: 'button', textContent: t.brokeredUse, name: `auto-use-${account.ref}` });
      use.addEventListener('click', () => save(next => { next.upstreams.push(accountUpstream(account, next.upstreams.map(upstream => upstream.id))); }));
      row.append(use);
    }
    list.append(row);
  }
  box.append(list);
  return box;
}
