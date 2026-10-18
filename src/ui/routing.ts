// "Where agents run" on the decision models page: the subscriptions and coding plans the person declares (with
// reserve, parallel limit, trust and their limit windows as CanvasTTY last read them), model accounts the
// orchestrator showed, which routes may be used, pins and boosts, the new-model policy, the alias table, and the
// recent route decisions with their why-lines and outcomes. Same look as the rest of the page; text only.
import type { AutoTier } from '../auto/settings.ts';
import type { SubscriptionQuota } from '../route/limits.ts';
import type { RouteRecord } from '../route/records.ts';
import type { Estimate } from '../route/engine.ts';
import { ROUTE_CLIS, type QuotaBy, type ValueSpeed, type NewModelPolicy, type PlanDecl, type RouteAllow, type RouteSettings, type TrustLevel } from '../route/settings.ts';
import { el } from './common.ts';

export interface RouteState {
  settings: RouteSettings;
  readable: boolean;
  now: number;
  staleAfterMs: number;
  aliases: { asOf: string; bundled: Record<string, Record<string, string>> };
  plans: Array<{ id: string; models: Array<{ model: string; identity: string | null; from: string }>; quota: SubscriptionQuota | null; running: number; launches: number | null }>;
  limits: { receivedAt: number; providers: Array<{ provider: string; state: string; fetchedAt: number | null }> } | null;
  accounts: { at: number; rows: Array<{ provider: string; accountId: string; account?: string; model: string; endpoint: string; state: string }> } | null;
  cooldowns: Array<{ signIn: string; until: number; reason: string }>;
  recent: RouteRecord[];
  exploration: Array<{ identity: string; n: number; ok: number; incumbent: number | null; verdict: 'pending' | 'use' | 'retire' }>;
}

export interface RoutePageHost {
  request(method: string, params?: unknown): Promise<unknown>;
  /** Reads CanvasTTY's limit windows now and forwards them to the service. */
  forwardLimits(): Promise<void>;
  say(message: string): void;
  reload(): void;
}

const CLI_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok Build', kimi: 'Kimi', qwen: 'Qwen Code', opencode: 'OpenCode', hermes: 'Hermes', omp: 'OMP', pi: 'Pi', cursor: 'Cursor', minimax: 'MiniMax Code', devin: 'Devin', antigravity: 'Antigravity' };
const cliName = (id: string): string => CLI_NAMES[id] ?? id;

export const ROUTE_PAGE_STRINGS = {
  en: {
    title: 'Where agents run',
    lead: 'What the orchestrator\'s route tool chooses from when it starts a subagent: your subscriptions and coding plans (each reached only through its own CLI and its own sign-in), model accounts of the Accounts plugin, Model: Auto (Jev), and any other CLI on its own default model as the last fallback. A model is chosen by its measured score for the task type, then by price or by how much of a window it would take; a subscription with headroom above your reserve costs nothing. Nothing is started here, and the orchestrator\'s spawn is still checked by CanvasTTY.',
    limits: (age: string | null) => age === null ? 'Limit windows: not read yet.' : `Limit windows: read ${age}. They are read while this page is open; after 30 minutes without it they count as unknown, never as used up.`,
    readNow: 'Read now',
    plans: 'Subscriptions and coding plans', noPlans: 'None declared: subagents run on each CLI\'s own default model, after any scored option.',
    kind: { subscription: 'subscription', 'coding-plan': 'coding plan' } as Record<string, string>,
    allow: { prefer: 'Prefer', allow: 'Allow', never: 'Never' } as Record<string, string>,
    reserve: 'Reserve, %', parallel: 'At once', trust: 'Trusted with', trustUnset: 'not set',
    allowance: 'Launches per window', windowHours: 'Window, hours', remove: 'Remove', save: 'Save',
    quota: (q: SubscriptionQuota | null, ago: (at: number | null) => string) => !q ? '' : q.state === 'unknown' ? `quota unknown (${q.note})`
      : q.state === 'exhausted' ? `no headroom above the reserve${q.window ? ` (${q.window.label ?? 'window'} ${Math.round(q.window.usedPercent)}% used)` : ''} · read ${ago(q.readAt)}`
        : `${q.window ? `${q.window.label ?? 'window'} ${Math.round(q.window.usedPercent)}% used · ` : ''}headroom ${q.headroom}%${q.pace !== null && q.pace > 1 ? ` · burning faster than its window (pace ${q.pace})` : ''}${q.state === 'presumed-reset' ? ' · probably reset since' : ''} · read ${ago(q.readAt)}`,
    running: (n: number) => n ? `${n} routed running` : '',
    launches: (n: number, allowance: number | undefined, hours: number) => `${n}${allowance ? ` of ${allowance}` : ''} launches counted in ${hours} h${allowance ? '' : ' (no allowance set: quota unknown)'}`,
    models: 'Models', modelsHelp: 'The CLI\'s own ids or aliases, comma-separated; for OpenCode provider/model or provider/*. Empty: the CLI\'s default.',
    resolved: (model: string, identity: string | null, from: string, asOf: string) => identity === null ? `${model} → no score (unknown model or alias)` : from === 'id' ? `${model} → scored as ${identity}` : `${model} → ${identity} (${from === 'person' ? 'your alias' : `alias table ${asOf}`})`,
    add: 'Add', newPlan: 'Declare a subscription or plan', name: 'Name (Max, Pro, GLM plan…)', cli: 'CLI', planKind: 'Kind',
    accounts: 'Model accounts (CanvasTTY Accounts)', accountsSeen: (age: string) => `As the orchestrator last passed them, ${age}.`, accountsNone: 'Not passed by an orchestrator since the Assistant started.',
    flatRate: 'flat-rate plan',
    plansSmall: 'Prefer plans and subscriptions for small tasks', plansWindow: 'within, points of the best',
    quotaBy: 'Quota counted by', quotaKind: { tokens: 'tokens', prompts: 'prompts', unknown: 'not known' } as Record<string, string>,
    weights: 'Quota weights (model=weight, …; 1 = like the plan\'s top model)', speeds: 'Output speeds (model=tokens/s, …)',
    valueSpeed: 'On plans, value speed', speed: { low: 'little', moderate: 'moderately', high: 'a lot' } as Record<string, string>,
    planHelp: 'On a plan a model costs the quota it uses and the time it takes: its expected tokens (a small model ×1.2 until outcomes say otherwise) times its quota weight (by default its API price against the plan\'s top model), and, when you give speeds, its time. Within the quality window the cheapest wins for small and medium tasks; large or risky tasks stay quality-first.',
    other: 'Other routes', autoRoute: 'Model: Auto (Jev) as a subagent route', never: 'Never use this CLI on its own sign-in',
    neverList: 'Never:', choices: 'Choices', preferSubs: 'Prefer subscriptions with headroom over a cheaper API route, within the quality window',
    newModels: 'New models', policy: { wait: 'Wait for a measured score', provisional: 'Provisional score (mapped, −5)', explore: 'Provisional, and explore 5% of easy tasks' } as Record<string, string>,
    policyHelp: 'A model without its own measured score is not used until you pin or boost it. Provisional maps a score from another source through models measured in both (at least 8, R² shown in the why-line). Exploration sends a small share of small and medium, low-risk tasks to the best new model and counts its outcomes; after 20 it suggests using or retiring it.',
    pins: 'Pins and boosts', pinsHelp: 'A pin makes a model answer tasks of that level first; a boost adds points to its score. Both show in every why-line.',
    identity: 'Model (catalog id)', tier: { small: 'small', medium: 'medium', large: 'large' } as Record<string, string>, noTier: 'no pin', boost: 'Boost',
    aliases: 'Alias table', aliasesHelp: (asOf: string) => `Short aliases change meaning over time. The bundled table is from ${asOf}; your entries win over it.`, alias: 'Alias', aliasTo: 'Catalog id',
    exploration: 'New models tried', explored: (e: RouteState['exploration'][number]) => `${e.identity}: ${e.ok} of ${e.n} ok${e.incumbent !== null ? `, others ${Math.round(e.incumbent * 100)}%` : ''}`,
    verdict: { pending: 'collecting', use: 'about as good: use it?', retire: 'clearly worse: retired' } as Record<string, string>, useIt: 'Use it (+5)',
    recent: 'Recent routes', noRecent: 'No route decisions yet.', right: 'Right', wrong: 'Wrong',
    outcome: { done: 'done', failed: 'failed', limit: 'hit a limit', cancelled: 'cancelled' } as Record<string, string>, byPerson: 'you',
    strategy: { 'single-cheap': 'one cheap', 'single-strong': 'one strong' } as Record<string, string>,
    type: { coding: 'coding', review: 'review', research: 'research', writing: 'writing', chat: 'chat' } as Record<string, string>,
    level: { small: 'small', medium: 'medium', large: 'large' } as Record<string, string>,
    routeKind: { subscription: 'subscription', 'coding-plan': 'coding plan', account: 'model account', auto: 'Auto (Jev)', 'cli-default': 'its own sign-in' } as Record<string, string>,
    basis: { free: 'free within the window', burning: 'burning faster than its window', low: 'close to the reserve', unknown: 'quota unknown', plan: 'coding plan', local: 'on this computer', flat: 'flat-rate, unpriced', api: 'API price', unpriced: 'no price known', unavailable: 'unavailable' } as Record<string, string>,
    score: (value: number | null, label: string | null, below: number | null) => value === null ? 'no score' : `score ${value.toFixed(1)}${label ? ` (${label})` : ''}${below ? `, ${below} below the best` : ''}`,
    estimate: (e: Estimate | undefined, fallback: string) => !e ? fallback : e.kind === 'usd' ? (e.high === 0 ? '$0' : `$${e.low}–${e.high}`) : e.kind === 'window' ? `≈ ${e.share}% of the ${e.window ?? 'window'}` : e.kind === 'launches' ? `1 launch (${e.used} of ${e.allowance} in ${e.windowHours} h)` : e.kind === 'flat' ? 'flat-rate, unpriced' : 'quota unknown',
    explore: 'explored', unreadable: 'The saved routing settings could not be read yet; nothing can be changed until they are.',
    cooling: 'Resting after a usage limit:'
  },
  ru: {
    title: 'Где работают агенты',
    lead: 'Из чего выбирает инструмент route оркестратора, когда запускает субагента: ваши подписки и планы для кода (каждый — только через свой CLI и его собственный вход), аккаунты моделей плагина Accounts, модель «Авто (Jev)» и любой другой CLI на его модели по умолчанию — в последнюю очередь. Модель выбирается по измеренной оценке для типа задачи, затем по цене или по доле окна, которую она займёт; подписка с запасом выше вашего резерва ничего не стоит. Здесь ничего не запускается, а запуск оркестратора по-прежнему проверяет CanvasTTY.',
    limits: (age: string | null) => age === null ? 'Окна лимитов: ещё не прочитаны.' : `Окна лимитов: прочитаны ${age}. Они читаются, пока эта страница открыта; через 30 минут без неё считаются неизвестными, но не исчерпанными.`,
    readNow: 'Прочитать сейчас',
    plans: 'Подписки и планы для кода', noPlans: 'Ничего не объявлено: субагенты работают на модели по умолчанию своего CLI, после вариантов с оценкой.',
    kind: { subscription: 'подписка', 'coding-plan': 'план для кода' } as Record<string, string>,
    allow: { prefer: 'Предпочитать', allow: 'Разрешить', never: 'Никогда' } as Record<string, string>,
    reserve: 'Резерв, %', parallel: 'Одновременно', trust: 'Доверяю до', trustUnset: 'не задано',
    allowance: 'Запусков за окно', windowHours: 'Окно, часов', remove: 'Удалить', save: 'Сохранить',
    quota: (q: SubscriptionQuota | null, ago: (at: number | null) => string) => !q ? '' : q.state === 'unknown' ? `лимит неизвестен (${({ unread: 'ещё не прочитан', unreadable: 'не читается', stale: 'прочитан больше 30 мин назад', 'no-windows': 'нет окон' } as Record<string, string>)[q.code] ?? q.code})`
      : q.state === 'exhausted' ? `нет запаса выше резерва${q.window ? ` (${q.window.label ?? 'окно'} использовано ${Math.round(q.window.usedPercent)}%)` : ''} · прочитано ${ago(q.readAt)}`
        : `${q.window ? `${q.window.label ?? 'окно'}: использовано ${Math.round(q.window.usedPercent)}% · ` : ''}запас ${q.headroom}%${q.pace !== null && q.pace > 1 ? ` · расходуется быстрее окна (темп ${q.pace})` : ''}${q.state === 'presumed-reset' ? ' · вероятно, уже сбросилось' : ''} · прочитано ${ago(q.readAt)}`,
    running: (n: number) => n ? `запущено через route: ${n}` : '',
    launches: (n: number, allowance: number | undefined, hours: number) => `запусков за ${hours} ч: ${n}${allowance ? ` из ${allowance}` : ' (лимит не задан: неизвестно)'}`,
    models: 'Модели', modelsHelp: 'Собственные id или псевдонимы CLI через запятую; для OpenCode — provider/model или provider/*. Пусто — модель CLI по умолчанию.',
    resolved: (model: string, identity: string | null, from: string, asOf: string) => identity === null ? `${model} → без оценки (неизвестная модель или псевдоним)` : from === 'id' ? `${model} → оценивается как ${identity}` : `${model} → ${identity} (${from === 'person' ? 'ваш псевдоним' : `таблица псевдонимов ${asOf}`})`,
    add: 'Добавить', newPlan: 'Объявить подписку или план', name: 'Название (Max, Pro, план GLM…)', cli: 'CLI', planKind: 'Вид',
    accounts: 'Аккаунты моделей (CanvasTTY Accounts)', accountsSeen: (age: string) => `Как их последний раз передал оркестратор, ${age}.`, accountsNone: 'С запуска Ассистента оркестратор их не передавал.',
    flatRate: 'фиксированный тариф',
    plansSmall: 'Для маленьких задач предпочитать планы и подписки', plansWindow: 'в пределах, баллов от лучшей',
    quotaBy: 'Квота считается по', quotaKind: { tokens: 'токенам', prompts: 'запросам', unknown: 'неизвестно' } as Record<string, string>,
    weights: 'Веса квоты (модель=вес, …; 1 — как у старшей модели плана)', speeds: 'Скорость вывода (модель=токенов/с, …)',
    valueSpeed: 'На планах ценить скорость', speed: { low: 'немного', moderate: 'умеренно', high: 'сильно' } as Record<string, string>,
    planHelp: 'На плане модель стоит ту квоту, которую тратит, и то время, которое занимает: ожидаемые токены (у маленькой модели ×1,2, пока результаты не покажут иное) на её вес квоты (по умолчанию — её цена API к старшей модели плана) и, если вы указали скорости, её время. В пределах окна качества для маленьких и средних задач побеждает самая дешёвая; большие и рискованные задачи — сначала качество.',
    other: 'Другие пути', autoRoute: 'Модель «Авто (Jev)» как путь для субагента', never: 'Никогда не запускать этот CLI на его собственном входе',
    neverList: 'Никогда:', choices: 'Выбор', preferSubs: 'Предпочитать подписки с запасом более дешёвому API в пределах окна качества',
    newModels: 'Новые модели', policy: { wait: 'Ждать измеренной оценки', provisional: 'Предварительная оценка (пересчитанная, −5)', explore: 'Предварительная и проба на 5% простых задач' } as Record<string, string>,
    policyHelp: 'Модель без собственной измеренной оценки не используется, пока вы её не закрепите или не повысите. Предварительная оценка пересчитывается из другого источника по моделям, измеренным в обоих (не меньше 8; R² показан в пояснении). Проба отправляет небольшую долю маленьких и средних задач без риска лучшей новой модели и считает результаты; после 20 предлагает использовать её или убрать.',
    pins: 'Закрепления и повышения', pinsHelp: 'Закреплённая модель первой получает задачи своего уровня; повышение добавляет баллы к её оценке. Оба видны в каждом пояснении.',
    identity: 'Модель (id каталога)', tier: { small: 'маленькая', medium: 'средняя', large: 'большая' } as Record<string, string>, noTier: 'без закрепления', boost: 'Повышение',
    aliases: 'Таблица псевдонимов', aliasesHelp: (asOf: string) => `Короткие псевдонимы со временем меняют смысл. Встроенная таблица от ${asOf}; ваши записи важнее.`, alias: 'Псевдоним', aliasTo: 'Id каталога',
    exploration: 'Опробованные новые модели', explored: (e: RouteState['exploration'][number]) => `${e.identity}: успешно ${e.ok} из ${e.n}${e.incumbent !== null ? `, у остальных ${Math.round(e.incumbent * 100)}%` : ''}`,
    verdict: { pending: 'собираю данные', use: 'примерно не хуже: использовать?', retire: 'явно хуже: убрана' } as Record<string, string>, useIt: 'Использовать (+5)',
    recent: 'Последние решения route', noRecent: 'Решений пока нет.', right: 'Верно', wrong: 'Неверно',
    outcome: { done: 'готово', failed: 'ошибка', limit: 'упёрлось в лимит', cancelled: 'отменено' } as Record<string, string>, byPerson: 'вы',
    strategy: { 'single-cheap': 'одна дешёвая', 'single-strong': 'одна сильная' } as Record<string, string>,
    type: { coding: 'код', review: 'ревью', research: 'исследование', writing: 'тексты', chat: 'общение' } as Record<string, string>,
    level: { small: 'маленькая', medium: 'средняя', large: 'большая' } as Record<string, string>,
    routeKind: { subscription: 'подписка', 'coding-plan': 'план для кода', account: 'аккаунт модели', auto: 'Авто (Jev)', 'cli-default': 'свой вход CLI' } as Record<string, string>,
    basis: { free: 'бесплатно в пределах окна', burning: 'расходуется быстрее окна', low: 'близко к резерву', unknown: 'лимит неизвестен', plan: 'план для кода', local: 'на этом компьютере', flat: 'фиксированный тариф, без цены', api: 'цена API', unpriced: 'цена неизвестна', unavailable: 'недоступно' } as Record<string, string>,
    score: (value: number | null, label: string | null, below: number | null) => value === null ? 'без оценки' : `оценка ${value.toFixed(1).replace('.', ',')}${label ? ` (${label})` : ''}${below ? `, на ${String(below).replace('.', ',')} ниже лучшей` : ''}`,
    estimate: (e: Estimate | undefined, fallback: string) => !e ? fallback : e.kind === 'usd' ? (e.high === 0 ? '$0' : `$${e.low}–${e.high}`) : e.kind === 'window' ? `≈ ${e.share}% окна ${e.window ?? ''}`.trim() : e.kind === 'launches' ? `1 запуск (${e.used} из ${e.allowance} за ${e.windowHours} ч)` : e.kind === 'flat' ? 'фиксированный тариф, без цены' : 'лимит неизвестен',
    explore: 'проба', unreadable: 'Сохранённые настройки маршрутизации ещё не прочитаны; пока их нельзя менять.',
    cooling: 'Отдыхают после лимита:'
  }
};
type Strings = typeof ROUTE_PAGE_STRINGS.en;

function selectOf<T extends string>(name: string, value: T, options: Array<[T, string]>, onChange: (value: T) => void): HTMLSelectElement {
  const node = el('select', { name });
  for (const [option, label] of options) node.append(el('option', { value: option, textContent: label, selected: option === value }));
  node.addEventListener('change', () => onChange(node.value as T));
  return node;
}
const numberInput = (name: string, value: number | undefined, min: number, max: number): HTMLInputElement => el('input', { type: 'number', name, min: String(min), max: String(max), step: '1', value: value === undefined ? '' : String(value) });
const labelled = (label: string, control: Node): HTMLSpanElement => el('span', { className: 'row' }, el('span', { textContent: label }), control);

export function renderRouting(state: RouteState, t: Strings, page: RoutePageHost): HTMLElement {
  const settings = state.settings;
  const ago = (at: number | null): string => {
    if (!at) return '—';
    const minutes = Math.max(0, Math.round((state.now - at) / 60_000));
    return document.documentElement.lang === 'ru' ? (minutes < 1 ? 'только что' : `${minutes} мин назад`) : (minutes < 1 ? 'just now' : `${minutes} min ago`);
  };
  const save = (change: (next: RouteSettings) => void): void => {
    const next = structuredClone(settings);
    change(next);
    page.request('route.save', { settings: next }).then(() => page.reload(), error => page.say(error instanceof Error ? error.message : String(error)));
  };
  const trustOptions: Array<[TrustLevel, string]> = [['unset', t.trustUnset], ['D0', 'D0'], ['D1', 'D1'], ['D2', 'D2'], ['D3', 'D3']];
  const allowOptions: Array<[RouteAllow, string]> = (['prefer', 'allow', 'never'] as const).map(value => [value, t.allow[value]!]);
  const section = el('section', { className: 'auto', dataset: { section: 'routing' } });
  section.append(el('h2', { textContent: t.title }), el('p', { className: 'muted', textContent: t.lead }));
  if (!state.readable) section.append(el('p', { className: 'muted', textContent: t.unreadable }));
  const readNow = el('button', { type: 'button', textContent: t.readNow, name: 'route-limits-read' });
  readNow.addEventListener('click', () => { void page.forwardLimits().then(() => page.reload(), error => page.say(error instanceof Error ? error.message : String(error))); });
  section.append(el('div', { className: 'row', dataset: { route: 'limits' } }, el('span', { className: 'muted', textContent: t.limits(state.limits ? ago(state.limits.receivedAt) : null) }), readNow));
  const until = (at: number): string => new Date(at).toLocaleTimeString(document.documentElement.lang || 'en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if (state.cooldowns.length) section.append(el('p', { className: 'muted', textContent: `${t.cooling} ${state.cooldowns.map(c => `${c.signIn.replace(/^(?:plan|account|cli):/u, '')} → ${until(c.until)}`).join('; ')}` }));

  // Subscriptions and coding plans.
  section.append(el('h2', { textContent: t.plans }));
  const list = el('ul', { className: 'backends', dataset: { route: 'plans' } });
  if (!settings.plans.length) list.append(el('li', { className: 'muted', textContent: t.noPlans }));
  for (const plan of settings.plans) list.append(planRow(plan, state, t, save, ago, trustOptions, allowOptions));
  section.append(list, addPlan(settings, t, save));

  // Model accounts the orchestrator passed.
  section.append(el('h2', { textContent: t.accounts }));
  if (!state.accounts) section.append(el('p', { className: 'muted', textContent: t.accountsNone }));
  else {
    section.append(el('p', { className: 'muted', textContent: t.accountsSeen(ago(state.accounts.at)) }));
    const rows = el('ul', { className: 'recent', dataset: { route: 'accounts' } });
    for (const host of [...new Set(state.accounts.rows.map(row => row.endpoint))]) {
      const of = state.accounts.rows.filter(row => row.endpoint === host);
      const key = `host:${host}`;
      rows.append(el('li', { className: 'row', dataset: { host } },
        el('code', { textContent: host }),
        el('span', { textContent: of.map(row => `${row.account ?? row.accountId} · ${row.model} · ${cliName(row.provider)} · ${row.state}`).join('; ') }),
        selectOf(`route-allow-${host}`, settings.allow[key] ?? 'allow', allowOptions, value => save(next => { if (value === 'allow') delete next.allow[key]; else next.allow[key] = value; })),
        labelled(t.trust, selectOf(`route-trust-${host}`, settings.trust[key] ?? 'unset', trustOptions, value => save(next => { if (value === 'unset') delete next.trust[key]; else next.trust[key] = value; }))),
        flatToggle(host, settings, t, save)));
    }
    section.append(rows);
  }

  // Other routes: Auto, and CLIs on their own sign-in.
  section.append(el('h2', { textContent: t.other }),
    el('div', { className: 'row' }, el('span', { className: 'label', textContent: t.autoRoute }),
      selectOf('route-allow-auto', settings.allow.auto ?? 'allow', allowOptions, value => save(next => { if (value === 'allow') delete next.allow.auto; else next.allow.auto = value; }))));
  const nevers = Object.entries(settings.allow).filter(([key, value]) => key.startsWith('cli:') && value === 'never').map(([key]) => key.slice(4));
  const cli = selectOf<string>('route-never-cli', ROUTE_CLIS[0], ROUTE_CLIS.map(id => [id, cliName(id)] as [string, string]), () => undefined);
  const addNever = el('button', { type: 'button', textContent: t.add, name: 'route-never-add' });
  addNever.addEventListener('click', () => save(next => { next.allow[`cli:${cli.value}`] = 'never'; }));
  const neverRow = el('div', { className: 'row', dataset: { route: 'never' } }, el('span', { className: 'label', textContent: t.never }), cli, addNever);
  if (nevers.length) {
    neverRow.append(el('span', { textContent: t.neverList }));
    for (const id of nevers) {
      const drop = el('button', { type: 'button', textContent: `${cliName(id)} ×`, name: `route-never-drop-${id}` });
      drop.addEventListener('click', () => save(next => { delete next.allow[`cli:${id}`]; }));
      neverRow.append(drop);
    }
  }
  section.append(neverRow);

  // Choices.
  const prefer = el('input', { type: 'checkbox', checked: settings.preferSubscriptions, name: 'route-prefer-subs' });
  prefer.addEventListener('change', () => save(next => { next.preferSubscriptions = prefer.checked; }));
  const plansSmall = el('input', { type: 'checkbox', checked: settings.preferPlansSmall, name: 'route-plans-small' });
  plansSmall.addEventListener('change', () => save(next => { next.preferPlansSmall = plansSmall.checked; }));
  const plansWindow = numberInput('route-plans-window', settings.planWindowSmall, 0, 60);
  plansWindow.addEventListener('change', () => { const value = Math.round(Number(plansWindow.value)); if (value >= 0 && value <= 60) save(next => { next.planWindowSmall = value; }); });
  section.append(el('h2', { textContent: t.choices }), el('label', { className: 'check' }, prefer, ` ${t.preferSubs}`),
    el('div', { className: 'row' }, el('label', { className: 'check' }, plansSmall, ` ${t.plansSmall}`), el('span', { textContent: t.plansWindow }), plansWindow),
    el('div', { className: 'row' }, el('span', { className: 'label', textContent: t.newModels }),
      selectOf<NewModelPolicy>('route-new-model-policy', settings.newModels, (['wait', 'provisional', 'explore'] as const).map(value => [value, t.policy[value]!] as [NewModelPolicy, string]), value => save(next => { next.newModels = value; }))),
    el('p', { className: 'muted', textContent: t.policyHelp }),
    el('div', { className: 'row' }, el('span', { className: 'label', textContent: t.valueSpeed }),
      selectOf<ValueSpeed>('route-value-speed', settings.valueSpeed, (['low', 'moderate', 'high'] as const).map(value => [value, t.speed[value]!] as [ValueSpeed, string]), value => save(next => { next.valueSpeed = value; }))),
    pairsRow('route-speeds', t.speeds, settings.speeds, next => save(s => { s.speeds = next; })),
    pairsRow('route-quota-weights', t.weights, settings.quotaWeights, next => save(s => { s.quotaWeights = next; })),
    el('p', { className: 'muted', textContent: t.planHelp }));

  // Pins and boosts.
  section.append(el('h2', { textContent: t.pins }), el('p', { className: 'muted', textContent: t.pinsHelp }));
  const pinList = el('ul', { className: 'recent', dataset: { route: 'pins' } });
  for (const identity of [...new Set([...Object.keys(settings.pins), ...Object.keys(settings.boosts)])].sort()) {
    const drop = el('button', { type: 'button', textContent: t.remove, name: `route-pin-drop-${identity}` });
    drop.addEventListener('click', () => save(next => { delete next.pins[identity]; delete next.boosts[identity]; }));
    pinList.append(el('li', { className: 'row', dataset: { identity } }, el('code', { textContent: identity }),
      el('span', { textContent: [settings.pins[identity] ? t.tier[settings.pins[identity]!] : '', settings.boosts[identity] ? `${t.boost} ${settings.boosts[identity]! > 0 ? '+' : ''}${settings.boosts[identity]}` : ''].filter(Boolean).join(' · ') }), drop));
  }
  const identity = el('input', { name: 'route-pin-identity', placeholder: t.identity });
  const tier = selectOf<string>('route-pin-tier', '', [['', t.noTier], ...(['small', 'medium', 'large'] as const).map(value => [value, t.tier[value]!] as [string, string])], () => undefined);
  const boost = numberInput('route-pin-boost', undefined, -20, 20);
  boost.placeholder = t.boost;
  const addPin = el('button', { type: 'button', textContent: t.add, name: 'route-pin-add' });
  addPin.addEventListener('click', () => {
    const id = identity.value.trim().toLowerCase().replace(/[. _]/gu, '-');
    if (!id) return;
    save(next => {
      if (tier.value) next.pins[id] = tier.value as AutoTier;
      const b = Math.round(Number(boost.value));
      if (boost.value.trim() && Number.isFinite(b) && b !== 0) next.boosts[id] = Math.max(-20, Math.min(20, b));
    });
  });
  section.append(pinList, el('div', { className: 'add' }, identity, tier, boost, addPin));

  // Exploration results.
  if (state.exploration.length) {
    section.append(el('h2', { textContent: t.exploration }));
    const explored = el('ul', { className: 'recent', dataset: { route: 'exploration' } });
    for (const entry of state.exploration) {
      const item = el('li', { className: 'row' }, el('span', { textContent: `${t.explored(entry)} · ${t.verdict[entry.verdict]}` }));
      if (entry.verdict === 'use' && !settings.boosts[entry.identity]) {
        const use = el('button', { type: 'button', textContent: t.useIt, name: `route-use-${entry.identity}` });
        use.addEventListener('click', () => save(next => { next.boosts[entry.identity] = 5; }));
        item.append(use);
      }
      explored.append(item);
    }
    section.append(explored);
  }

  // Aliases.
  section.append(el('h2', { textContent: t.aliases }), el('p', { className: 'muted', textContent: `${t.aliasesHelp(state.aliases.asOf)} ${Object.entries(state.aliases.bundled).map(([c, table]) => `${cliName(c)}: ${Object.entries(table).map(([a, id]) => `${a} → ${id}`).join(', ')}`).join('; ')}` }));
  const aliasList = el('ul', { className: 'recent', dataset: { route: 'aliases' } });
  settings.aliases.forEach((entry, index) => {
    const drop = el('button', { type: 'button', textContent: t.remove, name: `route-alias-drop-${index}` });
    drop.addEventListener('click', () => save(next => { next.aliases.splice(index, 1); }));
    aliasList.append(el('li', { className: 'row' }, el('span', { textContent: `${cliName(entry.cli)}: ${entry.alias} → ${entry.identity}` }), drop));
  });
  const aliasCli = selectOf<string>('route-alias-cli', 'claude', ROUTE_CLIS.map(id => [id, cliName(id)] as [string, string]), () => undefined);
  const alias = el('input', { name: 'route-alias', placeholder: t.alias });
  const aliasTo = el('input', { name: 'route-alias-to', placeholder: t.aliasTo });
  const addAlias = el('button', { type: 'button', textContent: t.add, name: 'route-alias-add' });
  addAlias.addEventListener('click', () => {
    const a = alias.value.trim(), id = aliasTo.value.trim().toLowerCase().replace(/[. _]/gu, '-');
    if (a && id) save(next => { next.aliases = [...next.aliases.filter(entry => !(entry.cli === aliasCli.value && entry.alias === a)), { cli: aliasCli.value, alias: a, identity: id }]; });
  });
  section.append(aliasList, el('div', { className: 'add' }, aliasCli, alias, aliasTo, addAlias));

  // Recent decisions.
  section.append(el('h2', { textContent: t.recent }));
  const recent = el('ul', { className: 'recent', dataset: { route: 'recent' } });
  if (!state.recent.length) recent.append(el('li', { className: 'muted', textContent: t.noRecent }));
  for (const record of state.recent.slice(0, 20)) recent.append(recentRow(record, t, page));
  section.append(recent);
  return section;
}

/** A model account's address on a flat-rate plan (no price per call). */
function flatToggle(host: string, settings: RouteSettings, t: Strings, save: (change: (next: RouteSettings) => void) => void): HTMLLabelElement {
  const key = `host:${host}`;
  const input = el('input', { type: 'checkbox', checked: settings.flat.includes(key), name: `route-flat-${host}` });
  input.addEventListener('change', () => save(next => { next.flat = input.checked ? [...new Set([...next.flat, key])] : next.flat.filter(entry => entry !== key); }));
  return el('label', { className: 'check' }, input, ` ${t.flatRate}`);
}

function planRow(plan: PlanDecl, state: RouteState, t: Strings, save: (change: (next: RouteSettings) => void) => void, ago: (at: number | null) => string, trustOptions: Array<[TrustLevel, string]>, allowOptions: Array<[RouteAllow, string]>): HTMLLIElement {
  const edit = (change: (entry: PlanDecl) => void): void => save(next => { change(next.plans.find(entry => entry.id === plan.id)!); });
  const view = state.plans.find(entry => entry.id === plan.id);
  const item = el('li', { className: 'backend', dataset: { plan: plan.id } });
  const remove = el('button', { type: 'button', textContent: t.remove, name: `route-plan-remove-${plan.id}` });
  remove.addEventListener('click', () => save(next => { next.plans = next.plans.filter(entry => entry.id !== plan.id); }));
  item.append(el('div', { className: 'row' }, el('strong', { textContent: `${cliName(plan.cli)} · ${t.kind[plan.kind]} · ${plan.label}` }),
    selectOf(`route-plan-allow-${plan.id}`, plan.allow, allowOptions, value => edit(entry => { entry.allow = value; })), remove));
  const reserve = numberInput(`route-plan-reserve-${plan.id}`, plan.reserve, 0, 90);
  const parallel = numberInput(`route-plan-parallel-${plan.id}`, plan.maxParallel, 1, 8);
  const controls = el('div', { className: 'row' }, labelled(t.reserve, reserve), labelled(t.parallel, parallel),
    labelled(t.trust, selectOf(`route-plan-trust-${plan.id}`, plan.trust, trustOptions, value => edit(entry => { entry.trust = value; }))));
  let allowance: HTMLInputElement | null = null, hours: HTMLInputElement | null = null;
  if (plan.kind === 'coding-plan') {
    allowance = numberInput(`route-plan-allowance-${plan.id}`, plan.allowance, 1, 100_000);
    hours = numberInput(`route-plan-hours-${plan.id}`, plan.windowHours ?? 5, 1, 744);
    controls.append(labelled(t.allowance, allowance), labelled(t.windowHours, hours));
  }
  const saveNumbers = el('button', { type: 'button', textContent: t.save, name: `route-plan-save-${plan.id}` });
  saveNumbers.addEventListener('click', () => edit(entry => {
    entry.reserve = Math.round(Number(reserve.value)); entry.maxParallel = Math.round(Number(parallel.value));
    if (allowance) { if (allowance.value.trim()) entry.allowance = Math.round(Number(allowance.value)); else delete entry.allowance; }
    if (hours && hours.value.trim()) entry.windowHours = Math.round(Number(hours.value));
  }));
  controls.append(saveNumbers);
  item.append(controls);
  item.append(el('div', { className: 'row' }, el('span', { className: 'label', textContent: t.quotaBy }),
    selectOf<QuotaBy>(`route-plan-quota-${plan.id}`, plan.quotaBy ?? 'tokens', (['tokens', 'prompts', 'unknown'] as const).map(value => [value, t.quotaKind[value]!] as [QuotaBy, string]), value => edit(entry => { entry.quotaBy = value; }))),
    pairsRow(`route-plan-weights-${plan.id}`, t.weights, plan.multipliers ?? {}, next => edit(entry => { if (Object.keys(next).length) entry.multipliers = next; else delete entry.multipliers; })));
  const facts = [plan.kind === 'subscription' ? t.quota(view?.quota ?? null, ago) : t.launches(view?.launches ?? 0, plan.allowance, plan.windowHours ?? 5), t.running(view?.running ?? 0)].filter(Boolean).join(' · ');
  if (facts) item.append(el('p', { className: 'muted', textContent: facts, dataset: { quota: plan.id } }));
  const models = el('input', { name: `route-plan-models-${plan.id}`, value: plan.models.join(', ') });
  models.addEventListener('change', () => edit(entry => { entry.models = splitModels(models.value); }));
  item.append(el('div', { className: 'row' }, el('span', { className: 'label', textContent: t.models }), models),
    el('p', { className: 'muted', textContent: view?.models.length ? view.models.map(m => t.resolved(m.model, m.identity, m.from, state.aliases.asOf)).join('; ') : t.modelsHelp }));
  return item;
}

/** "glm-5-3-flash=0.3, glm-5-3=1" ↔ { id: number }; the service validates the result. */
function pairsRow(name: string, label: string, value: Record<string, number>, onChange: (next: Record<string, number>) => void): HTMLDivElement {
  const input = el('input', { name, value: Object.entries(value).map(([k, v]) => `${k}=${v}`).join(', ') });
  input.addEventListener('change', () => {
    const next: Record<string, number> = {};
    for (const part of input.value.split(/[,;\s]+/u).filter(Boolean)) {
      const [key, raw] = part.split('=');
      const number = Number(raw);
      if (key && Number.isFinite(number)) next[key.trim().toLowerCase().replace(/[. _]/gu, '-')] = number;
    }
    onChange(next);
  });
  return el('div', { className: 'row' }, el('span', { className: 'label', textContent: label }), input);
}

const splitModels = (value: string): string[] => [...new Set(value.split(/[,\s]+/u).map(part => part.trim()).filter(Boolean))].slice(0, 16);

function addPlan(settings: RouteSettings, t: Strings, save: (change: (next: RouteSettings) => void) => void): HTMLElement {
  const box = el('div', { dataset: { route: 'add-plan' } });
  const cli = selectOf<string>('route-new-cli', 'claude', ROUTE_CLIS.map(id => [id, cliName(id)] as [string, string]), () => undefined);
  const kind = selectOf<string>('route-new-kind', 'subscription', [['subscription', t.kind.subscription!], ['coding-plan', t.kind['coding-plan']!]], () => undefined);
  const name = el('input', { name: 'route-new-name', placeholder: t.name });
  const models = el('input', { name: 'route-new-models', placeholder: t.models });
  const add = el('button', { type: 'button', textContent: t.add, name: 'route-new-add' });
  add.addEventListener('click', () => {
    const label = name.value.trim().slice(0, 40) || cliName(cli.value);
    let id = `${cli.value}-${label.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')}`.slice(0, 40).replace(/-+$/u, '');
    for (let n = 2; settings.plans.some(plan => plan.id === id); n++) id = `${id.slice(0, 36)}-${n}`;
    const plan: PlanDecl = { id, cli: cli.value, kind: kind.value as PlanDecl['kind'], label, models: splitModels(models.value), reserve: 20, maxParallel: 2, allow: 'allow', trust: 'unset' };
    save(next => { next.plans.push(plan); });
  });
  box.append(el('div', { className: 'add' }, el('span', { className: 'label', textContent: t.newPlan }), cli, kind, name, models, add), el('p', { className: 'muted', textContent: t.modelsHelp }));
  return box;
}

function recentRow(record: RouteRecord, t: Strings, page: RoutePageHost): HTMLLIElement {
  const time = new Date(record.at).toLocaleTimeString(document.documentElement.lang || 'en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const option = record.options[record.spawned?.option ?? 0];
  const item = el('li', { dataset: { decision: record.id } });
  const head = [time, record.card, `${t.type[record.type] ?? record.type}/${t.level[record.level] ?? record.level}`, t.strategy[record.strategy] ?? record.strategy];
  if (record.explored) head.push(t.explore);
  item.append(el('div', { className: 'row' }, el('span', { textContent: head.join(' · ') }),
    el('code', { textContent: option ? `${option.cli}${option.model ? ` · ${option.model}` : ''}${option.effort ? `@${option.effort}` : ''}` : '—' }),
    el('span', { textContent: option ? t.estimate(option.estimateData, option.estimate) : '' })));
  // The why-line in the person's language, from the record's data (the orchestrator got the English one).
  if (option) item.append(el('div', { className: 'muted', textContent: [`${t.routeKind[option.kind] ?? option.kind}: ${option.label}`, t.score(option.score, option.scoreLabel ?? null, option.below ?? null), t.basis[option.costBasis] ?? option.costBasis].join(' · ') }));
  const outcome = record.outcome ? `${t.outcome[record.outcome.result] ?? record.outcome.result}${record.outcome.by === 'person' ? ` (${t.byPerson})` : ''}` : '';
  const right = el('button', { type: 'button', textContent: t.right, name: `route-right-${record.id}` });
  const wrong = el('button', { type: 'button', textContent: t.wrong, name: `route-wrong-${record.id}` });
  right.addEventListener('click', () => { void page.request('route.feedback', { id: record.id, ok: true }).then(() => page.reload(), error => page.say(String(error))); });
  wrong.addEventListener('click', () => { void page.request('route.feedback', { id: record.id, ok: false }).then(() => page.reload(), error => page.say(String(error))); });
  item.append(el('div', { className: 'row' }, el('span', { textContent: outcome }), right, wrong));
  return item;
}
