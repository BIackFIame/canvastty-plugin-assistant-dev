// The "Model: Auto (Jev)" rows on the decision models page: upstreams with their models and tiers (keys are
// write-only, bound to the upstream's address), preference, caps, who decides, and the recent routing decisions
// (time, card, tier, model, why, status, cost — never any text). Same look as the rest of the page.
import type { AutoModel, AutoRoutingSettings, AutoTier, AutoUpstream } from '../auto/settings.ts';
import type { DecisionRecord, RouterStats } from '../auto/router.ts';
import { el } from './common.ts';

export interface AutoState {
  settings: AutoRoutingSettings;
  readable: boolean;
  keys: Record<string, boolean>;
  recent: DecisionRecord[];
  stats: RouterStats & { spentToday: number; listening: boolean; cards: number };
}

export interface AutoPageHost {
  request(method: string, params?: unknown): Promise<unknown>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
  say(message: string): void;
  reload(): void;
}

const OPENROUTER = 'https://openrouter.ai/api/v1';

export const AUTO_PAGE_STRINGS = {
  en: {
    title: 'Model: Auto (Jev)',
    lead: 'For OpenCode cards started with Model: Auto (Jev) (launcher → Advanced → Use CanvasTTY Assistant). A local router on 127.0.0.1, protected by a key per card, picks one of the models below for each new turn: Jev (task triage, when it is Suggest or Auto above) judges how hard the turn is, otherwise word rules do. Tool steps keep the turn\'s model; titles use the cheapest one. Prompts go only to the upstream that answers; Jev gets only the latest user text, under the data rules below. Leave the launcher\'s Model at Default and choose no model account.',
    upstreams: 'Upstreams', none: 'None yet.', add: 'Add', remove: 'Remove', on: 'On', check: 'Check', checking: 'Checking…',
    preset: { openrouter: 'OpenRouter', 'openai-compatible': 'OpenAI-compatible' } as Record<string, string>,
    idLabel: 'Name (a-z, 0-9, -)', baseUrl: 'Base URL (…/v1)', trust: 'I trust it with', trustHelp: 'D3 only for a server on this computer.',
    keyFrom: 'Key', keyOwn: 'Its own key', keyJev: 'The Jev · OpenRouter key', keyNone: 'No key (a server on this computer)',
    keySet: 'key saved', keyMissing: 'no key', keyPlaceholder: 'Key', saveKey: 'Save key', removeKey: 'Remove key',
    models: 'Models', modelId: 'Model id', tier: { small: 'small', medium: 'medium', large: 'large' } as Record<AutoTier, string>,
    priceIn: '$/M in', priceOut: '$/M out', addModel: 'Add model', noModels: 'No models: add at least one.',
    checkOk: (listed: number | null, missing: string[]) => `Works${listed !== null ? ` (${listed} models listed)` : ''}.${missing.length ? ` Not listed by it: ${missing.join(', ')}.` : ''}`,
    checkFail: (status: number | null) => status === null ? 'No answer, or no key saved.' : `It answered ${status}.`,
    choices: 'Choices', preference: 'Preference', pref: { cheap: 'Cheap', balanced: 'Balanced', best: 'Best' } as Record<string, string>,
    prefHelp: 'Cheap goes one tier down and the lowest price first; Best one tier up and the highest price first.',
    cheaper: 'If a tier has no usable model, a cheaper one may answer (a stronger one is always tried first)',
    decider: 'Who judges a turn', deciderJev: 'Jev, word rules when it does not answer', deciderRules: 'Word rules only',
    daily: 'Daily cap, USD', perCard: 'Per card, USD', capsHelp: 'Counted from the cost the upstream reports, or from the prices you entered. 0 stops Auto.',
    save: 'Save',
    recent: 'Recent routing', noRecent: 'Nothing routed yet.',
    stats: (s: AutoState['stats']) => `${s.requests} model calls, Jev asked ${s.jevAsked} times (${s.jevAnswered} answered), ${s.leaseReuses} reused a turn's choice, ${s.failovers} failovers; today $${s.spentToday.toFixed(4)}; ${s.listening ? `listening for ${s.cards} card(s)` : 'not listening'}${s.hosts.length ? `; sent to ${s.hosts.join(', ')}` : ''}.`,
    kind: { turn: 'turn', continuation: 'tool step', small: 'title' } as Record<string, string>,
    source: { jev: 'Jev', rules: 'rules', lease: 'same turn', small: 'small rule' } as Record<string, string>,
    unreadable: 'The saved Auto (Jev) settings could not be read yet; nothing can be changed until they are.'
  },
  ru: {
    title: 'Модель: Авто (Jev)',
    lead: 'Для окон OpenCode, запущенных с моделью «Авто (Jev)» (запуск → Дополнительно → Ассистент CanvasTTY). Локальный маршрутизатор на 127.0.0.1 с ключом на каждое окно на каждом новом ходе выбирает одну из моделей ниже: насколько ход сложный, решает Jev (разбор задачи, когда он в режиме «Подсказки» или «Авто» выше), иначе словесные правила. Шаги с инструментами остаются на модели хода, заголовки — на самой дешёвой. Запросы уходят только поставщику, который отвечает; Jev получает только последний текст пользователя по правилам данных ниже. В окне запуска оставьте «Модель» по умолчанию и не выбирайте аккаунт модели.',
    upstreams: 'Поставщики', none: 'Пока нет.', add: 'Добавить', remove: 'Удалить', on: 'Вкл', check: 'Проверить', checking: 'Проверяю…',
    preset: { openrouter: 'OpenRouter', 'openai-compatible': 'Совместимый с OpenAI' } as Record<string, string>,
    idLabel: 'Имя (a-z, 0-9, -)', baseUrl: 'Базовый адрес (…/v1)', trust: 'Доверяю до', trustHelp: 'D3 — только серверу на этом компьютере.',
    keyFrom: 'Ключ', keyOwn: 'Свой ключ', keyJev: 'Ключ Jev · OpenRouter', keyNone: 'Без ключа (сервер на этом компьютере)',
    keySet: 'ключ сохранён', keyMissing: 'нет ключа', keyPlaceholder: 'Ключ', saveKey: 'Сохранить ключ', removeKey: 'Удалить ключ',
    models: 'Модели', modelId: 'Id модели', tier: { small: 'маленькая', medium: 'средняя', large: 'большая' } as Record<AutoTier, string>,
    priceIn: '$/М вход', priceOut: '$/М выход', addModel: 'Добавить модель', noModels: 'Моделей нет: добавьте хотя бы одну.',
    checkOk: (listed: number | null, missing: string[]) => `Работает${listed !== null ? ` (моделей в списке: ${listed})` : ''}.${missing.length ? ` Нет в его списке: ${missing.join(', ')}.` : ''}`,
    checkFail: (status: number | null) => status === null ? 'Нет ответа или не сохранён ключ.' : `Ответ: ${status}.`,
    choices: 'Выбор', preference: 'Предпочтение', pref: { cheap: 'Дешевле', balanced: 'Сбалансированно', best: 'Лучше' } as Record<string, string>,
    prefHelp: '«Дешевле» — на уровень ниже и сначала самая низкая цена; «Лучше» — на уровень выше и сначала самая высокая.',
    cheaper: 'Если на уровне нет доступной модели, может ответить более дешёвая (сначала всегда пробуется более сильная)',
    decider: 'Кто оценивает ход', deciderJev: 'Jev, словесные правила, если он не ответил', deciderRules: 'Только словесные правила',
    daily: 'Предел в день, USD', perCard: 'На окно, USD', capsHelp: 'Считается по стоимости, которую сообщает поставщик, или по введённым ценам. 0 останавливает «Авто».',
    save: 'Сохранить',
    recent: 'Последние решения', noRecent: 'Пока ничего не маршрутизировано.',
    stats: (s: AutoState['stats']) => `Вызовов моделей: ${s.requests}, Jev спрошен ${s.jevAsked} раз (ответил ${s.jevAnswered}), решение хода повторно: ${s.leaseReuses}, переключений: ${s.failovers}; сегодня $${s.spentToday.toFixed(4)}; ${s.listening ? `слушает, окон: ${s.cards}` : 'не слушает'}${s.hosts.length ? `; отправлено на ${s.hosts.join(', ')}` : ''}.`,
    kind: { turn: 'ход', continuation: 'шаг инструмента', small: 'заголовок' } as Record<string, string>,
    source: { jev: 'Jev', rules: 'правила', lease: 'тот же ход', small: 'правило маленькой' } as Record<string, string>,
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

export function renderAuto(state: AutoState, t: Strings, page: AutoPageHost, checks: Map<string, string>): HTMLElement {
  const settings = state.settings;
  const save = (change: (next: AutoRoutingSettings) => void): void => {
    const next = structuredClone(settings);
    change(next);
    page.request('auto.save', { settings: next }).then(() => page.reload(), error => page.say(error instanceof Error ? error.message : String(error)));
  };
  const section = el('section', { className: 'auto', dataset: { section: 'auto' } });
  section.append(el('h2', { textContent: t.title }), el('p', { className: 'muted', textContent: t.lead }));
  if (!state.readable) section.append(el('p', { className: 'muted', textContent: t.unreadable }));

  section.append(el('h2', { textContent: t.upstreams }));
  const list = el('ul', { className: 'backends' });
  if (!settings.upstreams.length) list.append(el('li', { className: 'muted', textContent: t.none }));
  for (const upstream of settings.upstreams) list.append(upstreamRow(upstream, state, t, page, save, checks));
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
  for (const record of state.recent.slice(0, 20)) {
    const time = new Date(record.at).toLocaleTimeString(document.documentElement.lang || 'en', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const tier = record.tier ? t.tier[record.tier] : '—';
    const cost = record.costUsd === null ? '' : ` · $${record.costUsd.toFixed(5)}`;
    const failovers = record.failovers.length ? ` · ↷${record.failovers.length}` : '';
    recent.append(el('li', {}, `${time} · ${record.session} · ${t.kind[record.kind] ?? record.kind} · ${tier} · `, el('code', { textContent: record.model ?? '—' }), ` · ${t.source[record.source] ?? record.source} (${record.reason}) · ${record.status}${failovers}${cost}`));
  }
  section.append(recent);
  return section;
}

function upstreamRow(upstream: AutoUpstream, state: AutoState, t: Strings, page: AutoPageHost, save: (change: (next: AutoRoutingSettings) => void) => void, checks: Map<string, string>): HTMLLIElement {
  const edit = (change: (entry: AutoUpstream) => void): void => save(next => { change(next.upstreams.find(entry => entry.id === upstream.id)!); });
  const item = el('li', { className: 'backend', dataset: { upstream: upstream.id } });
  item.append(el('div', { className: 'row' }, el('strong', { textContent: `${t.preset[upstream.preset] ?? upstream.preset} · ${upstream.id}` }), el('span', { className: 'muted', textContent: upstream.baseUrl })));
  const trustOptions: Array<[AutoUpstream['trust'], string]> = [['D0', 'D0'], ['D1', 'D1'], ['D2', 'D2'], ...(isLocal(upstream.baseUrl) ? [['D3', 'D3'] as [AutoUpstream['trust'], string]] : [])];
  const check = el('button', { type: 'button', textContent: t.check, name: `auto-check-${upstream.id}` });
  check.addEventListener('click', () => {
    checks.set(upstream.id, t.checking); page.reload();
    page.request('auto.test', { upstreamId: upstream.id }).then(result => {
      const r = result as { ok: boolean; status: number | null; missing: string[]; listed: number | null };
      checks.set(upstream.id, r.ok ? t.checkOk(r.listed, r.missing) : t.checkFail(r.status));
      page.reload();
    }, error => { checks.set(upstream.id, error instanceof Error ? error.message : String(error)); page.reload(); });
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
  // Models and their tiers.
  const models = el('ul', { className: 'recent' });
  if (!upstream.models.length) models.append(el('li', { className: 'muted', textContent: t.noModels }));
  for (const model of upstream.models) {
    const drop = el('button', { type: 'button', textContent: t.remove });
    drop.addEventListener('click', () => edit(entry => { entry.models = entry.models.filter(other => other.id !== model.id); }));
    const prices = model.priceIn !== undefined || model.priceOut !== undefined ? ` · $${model.priceIn ?? 0}/$${model.priceOut ?? 0}` : '';
    models.append(el('li', { className: 'row', dataset: { model: model.id } }, el('code', { textContent: model.id }),
      selectOf(`auto-tier-${upstream.id}-${model.id}`, model.tier, (['small', 'medium', 'large'] as const).map(tier => [tier, t.tier[tier]!] as [AutoTier, string]), value => edit(entry => { entry.models.find(other => other.id === model.id)!.tier = value; })),
      el('span', { className: 'muted', textContent: prices }), drop));
  }
  const id = el('input', { name: `auto-model-id-${upstream.id}`, placeholder: t.modelId });
  const tier = selectOf<AutoTier>(`auto-model-tier-${upstream.id}`, 'medium', (['small', 'medium', 'large'] as const).map(value => [value, t.tier[value]!] as [AutoTier, string]), () => undefined);
  const priceIn = el('input', { type: 'number', min: '0', step: '0.01', placeholder: t.priceIn, name: `auto-price-in-${upstream.id}` });
  const priceOut = el('input', { type: 'number', min: '0', step: '0.01', placeholder: t.priceOut, name: `auto-price-out-${upstream.id}` });
  const add = el('button', { type: 'button', textContent: t.addModel, name: `auto-add-model-${upstream.id}` });
  add.addEventListener('click', () => {
    const modelId = id.value.trim();
    if (!modelId) return;
    const model: AutoModel = { id: modelId, tier: tier.value as AutoTier };
    const pin = number(priceIn.value), pout = number(priceOut.value);
    if (pin !== undefined) model.priceIn = pin;
    if (pout !== undefined) model.priceOut = pout;
    edit(entry => { entry.models.push(model); });
  });
  item.append(el('div', {}, el('span', { className: 'label', textContent: t.models }), models), el('div', { className: 'add' }, id, tier, priceIn, priceOut, add));
  const result = checks.get(upstream.id);
  if (result) item.append(el('div', { className: 'check-result', textContent: result, dataset: { result: upstream.id } }));
  return item;
}

function addUpstream(settings: AutoRoutingSettings, t: Strings, save: (change: (next: AutoRoutingSettings) => void) => void): HTMLDivElement {
  const form = el('div', { className: 'add' });
  const preset = selectOf<AutoUpstream['preset']>('auto-new-preset', 'openrouter', [['openrouter', t.preset.openrouter!], ['openai-compatible', t.preset['openai-compatible']!]], value => { url.disabled = value === 'openrouter'; url.value = value === 'openrouter' ? OPENROUTER : 'https://'; });
  const id = el('input', { name: 'auto-new-id', placeholder: t.idLabel, value: settings.upstreams.some(entry => entry.id === 'openrouter') ? '' : 'openrouter' });
  const url = el('input', { name: 'auto-new-url', placeholder: t.baseUrl, value: OPENROUTER, disabled: true });
  const add = el('button', { type: 'button', textContent: t.add, name: 'auto-add-upstream' });
  add.addEventListener('click', () => {
    const kind = preset.value as AutoUpstream['preset'];
    const entry: AutoUpstream = { id: id.value.trim(), preset: kind, baseUrl: kind === 'openrouter' ? OPENROUTER : url.value.trim(), trust: 'D1', key: 'own', models: [], enabled: true };
    save(next => { next.upstreams.push(entry); });
  });
  form.append(preset, id, url, add);
  return form;
}
