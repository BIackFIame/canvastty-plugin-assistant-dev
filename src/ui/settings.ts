// The Assistant's decision models page (bundled to settings/assistant.js); command review itself is set on the
// plugin's settings page (settings/harness.html). It runs in CanvasTTY's sandboxed plugin frame:
// settings go through the service (which validates and stores them), keys are written straight into the plugin's
// secrets and never read back — the page only learns whether one exists.
import type { AssistantBackendPreset, AssistantBackendSettings, AssistantBackendStatus, AssistantCheckResult, AssistantSettings } from '../shared/settings.ts';
import type { RecentReview } from '../review/reviewService.ts';
import { applyAppearance, whenIdle, type Appearance } from './common.ts';
import { AUTO_PAGE_STRINGS, newAutoView, renderAuto, type AutoState } from './autoRouting.ts';
import { renderRouting, ROUTE_PAGE_STRINGS, type RouteState } from './routing.ts';

interface PluginHost {
  onContext(listener: (context: { appearance: Appearance }) => void): void;
  /** Host SDK requests; `limits.get` needs the manifest's `limits:read`. */
  request?(method: string, params?: unknown): Promise<unknown>;
  onVisibilityChange?(listener: (state: 'visible' | 'hidden') => void): void;
  secrets: { set(key: string, value: string): Promise<void>; delete(key: string): Promise<void> };
  service: {
    request(serviceId: string, method: string, params?: unknown): Promise<unknown>;
    onEvent(listener: (event: { serviceId: string; event: string; data: unknown }) => void): void;
  };
}
interface State {
  settings: AssistantSettings;
  status: { enabled: boolean; backends: AssistantBackendStatus[] };
  slots: Record<string, { secret: string; origin: string } | null>;
  checks: Record<string, AssistantCheckResult | { running: true } | { error: string }>;
  recent: RecentReview[];
}

const host = (window as unknown as { CanvasTTYPlugin: PluginHost }).CanvasTTYPlugin;
const SERVICE = 'assistant';

const STRINGS = {
  en: {
    title: 'Decision models', lead: 'Optional. A small decision model (Jev: TypeSafe, OpenRouter, Vercel; Laya; an Eikos server; or a model on your Ollama) sharpens command review, task triage and routing. Without one, simple rules are used. Command review itself (Strict, Basic rules, Off) is set on the Assistant settings page.',
    modes: 'Modes', triage: 'Task triage (launch and orchestrator)',
    off: 'Off', shadow: 'Learning', suggest: 'Suggest', auto: 'Auto',
    modeHelp: 'Learning records answers only. Suggest shows them on the card and enforces nothing. Auto may change what a launch is advised.',
    data: 'Data', dataMode: 'Data check', strict: 'Strict', warn: 'Warn only', dataOff: 'Off',
    grant: 'What may leave this computer', grantOff: 'Only code facts (no text)', grantD1: 'Texts up to D1', grantD2: 'Texts up to D2',
    defaultClass: 'Class of card text', engine: 'Where it runs', engineAuto: 'Jev first, then this computer', engineJev: 'Jev only', engineLocal: 'This computer only',
    backends: 'Decision models', none: 'None yet.', add: 'Add', model: 'Model', url: 'Address', local: 'This server runs on this computer and sends nothing anywhere',
    check: 'Check', checking: 'Checking…', remove: 'Remove', enabledBackend: 'On', key: 'Key', keySet: 'key saved', keyNone: 'no key', saveKey: 'Save key', removeKey: 'Remove key',
    trust: 'I trust it with', where: { local: 'this computer', remote: 'leaves this computer' },
    checkOk: (r: AssistantCheckResult) => `OK: ${r.modelLabel ?? 'the model'} answered${r.latencyMs !== null ? ` in ${r.latencyMs} ms` : ''} (${r.requests} requests).`,
    checkFail: (r: AssistantCheckResult) => `Not usable: ${r.checks.filter(c => c.status === 'fail').map(c => c.detail).join(' ') || r.failure || 'the check failed'}`,
    smart: 'Second reviewer (larger local Ollama model)', smartNone: 'None', smartModel: 'Ollama model', smartAsk: 'While learning, also ask the second reviewer',
    recent: 'Recent reviews', noRecent: 'Nothing reviewed yet.', right: 'Right', wrong: 'Wrong',
    saved: 'Saved.', notSaved: 'Not saved: '
  },
  ru: {
    title: 'Модели решений', lead: 'Необязательно. Маленькая модель решений (Jev: TypeSafe, OpenRouter, Vercel; Laya; сервер Eikos или модель в вашей Ollama) уточняет проверку команд, разбор задач и выбор модели. Без неё работают простые правила. Саму проверку команд («Строго», «Базовые правила», «Выкл») задают на странице настроек Помощника.',
    modes: 'Режимы', triage: 'Разбор задачи (запуск и оркестратор)',
    off: 'Выкл', shadow: 'Обучение', suggest: 'Подсказки', auto: 'Авто',
    modeHelp: 'Обучение только записывает ответы. Подсказки показывают их на окне и ничего не решают. Авто может менять советы при запуске.',
    data: 'Данные', dataMode: 'Проверка данных', strict: 'Строго', warn: 'Только предупреждать', dataOff: 'Выкл',
    grant: 'Что может уйти с этого компьютера', grantOff: 'Только служебные признаки (без текста)', grantD1: 'Тексты до D1', grantD2: 'Тексты до D2',
    defaultClass: 'Класс текста окна', engine: 'Где работает', engineAuto: 'Сначала Jev, потом этот компьютер', engineJev: 'Только Jev', engineLocal: 'Только этот компьютер',
    backends: 'Модели решений', none: 'Пока нет.', add: 'Добавить', model: 'Модель', url: 'Адрес', local: 'Сервер работает на этом компьютере и никуда не отправляет данные',
    check: 'Проверить', checking: 'Проверяю…', remove: 'Удалить', enabledBackend: 'Вкл', key: 'Ключ', keySet: 'ключ сохранён', keyNone: 'нет ключа', saveKey: 'Сохранить ключ', removeKey: 'Удалить ключ',
    trust: 'Доверяю до', where: { local: 'этот компьютер', remote: 'уходит с компьютера' },
    checkOk: (r: AssistantCheckResult) => `Работает: ${r.modelLabel ?? 'модель'} ответила${r.latencyMs !== null ? ` за ${r.latencyMs} мс` : ''} (запросов: ${r.requests}).`,
    checkFail: (r: AssistantCheckResult) => `Не подходит: ${r.checks.filter(c => c.status === 'fail').map(c => c.detail).join(' ') || r.failure || 'проверка не прошла'}`,
    smart: 'Второй проверяющий (большая локальная модель Ollama)', smartNone: 'Нет', smartModel: 'Модель Ollama', smartAsk: 'Во время обучения тоже спрашивать второго проверяющего',
    recent: 'Последние проверки', noRecent: 'Пока ничего не проверялось.', right: 'Верно', wrong: 'Неверно',
    saved: 'Сохранено.', notSaved: 'Не сохранено: '
  }
};
type Strings = typeof STRINGS.en;
let t: Strings = STRINGS.en;
let autoStrings = AUTO_PAGE_STRINGS.en;
let state: State | null = null;
let autoState: AutoState | null = null;
let routeStrings = ROUTE_PAGE_STRINGS.en;
let routeState: RouteState | null = null;
/** The last «Проверить» result per Auto upstream, until the page reloads. */
const autoView = newAutoView();
const root = document.querySelector('#app')!;
const status = document.querySelector('#status')!;

const PRESETS: Array<{ id: AssistantBackendPreset; label: string; keyed: boolean; url: string | null; model: string }> = [
  { id: 'emulated', label: 'Ollama', keyed: false, url: 'http://127.0.0.1:11434', model: 'qwen3.5:9b' },
  { id: 'typesafe', label: 'Jev · TypeSafe', keyed: true, url: null, model: 'jev-1.13.0' },
  { id: 'openrouter', label: 'Jev · OpenRouter', keyed: true, url: null, model: 'typesafe/jev-1.13' },
  { id: 'vercel', label: 'Jev · Vercel', keyed: true, url: null, model: 'typesafe-ai/jev' },
  { id: 'laya', label: 'Laya', keyed: false, url: 'http://127.0.0.1:8000', model: 'typed-decisions' },
  { id: 'eikos', label: 'Eikos (serve.py)', keyed: false, url: 'http://127.0.0.1:8000', model: 'eikos' },
  { id: 'custom', label: 'System One server', keyed: false, url: 'https://', model: 'default' }
];

function say(message: string): void { status.textContent = message; }
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(node, rest);
  if (dataset) Object.assign(node.dataset, dataset);
  node.append(...children);
  return node;
}

function select<T extends string>(value: T, options: Array<[T, string]>, onChange: (value: T) => void, name: string): HTMLSelectElement {
  const node = el('select', { name });
  for (const [option, label] of options) node.append(el('option', { value: option, textContent: label, selected: option === value }));
  node.addEventListener('change', () => onChange(node.value as T));
  return node;
}

function checkbox(checked: boolean, label: string, onChange: (checked: boolean) => void, name: string): HTMLLabelElement {
  const input = el('input', { type: 'checkbox', checked, name });
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { className: 'check' }, input, ` ${label}`);
}

async function load(): Promise<void> {
  const [main, auto, route] = await Promise.all([
    host.service.request(SERVICE, 'state') as Promise<State>,
    // A service from before Auto (Jev) has no such method: the page simply shows no Auto rows.
    (host.service.request(SERVICE, 'auto.state') as Promise<AutoState>).catch(() => null),
    (host.service.request(SERVICE, 'route.state') as Promise<RouteState>).catch(() => null)
  ]);
  state = main;
  autoState = auto;
  routeState = route;
  render();
}

/**
 * CanvasTTY gives a service no limit windows of its own (phase 1): this page reads them with `limits.get` when it
 * opens and every 60 s while it is visible, and forwards the sanitized snapshot. The service counts anything older
 * than 30 minutes as unknown.
 */
const LIMITS_EVERY_MS = 60_000;
let visible = true;
async function forwardLimits(): Promise<void> {
  if (!host.request) return;
  const snapshot = await host.request('limits.get');
  await host.service.request(SERVICE, 'route.limits', { snapshot });
}
function forwardQuietly(): void { if (visible) void forwardLimits().catch(() => undefined); }
host.onVisibilityChange?.(next => { visible = next === 'visible'; if (visible) forwardQuietly(); });
if (typeof setInterval === 'function') setInterval(forwardQuietly, LIMITS_EVERY_MS);

/** Saves run one at a time, each on the settings the previous one left, so a quick second change keeps the first. */
let saving: Promise<void> = Promise.resolve();
function save(change: (settings: AssistantSettings) => void): Promise<void> {
  saving = saving.then(async () => {
    if (!state) return;
    const next = structuredClone(state.settings);
    change(next);
    try {
      await host.service.request(SERVICE, 'save', { settings: next });
      say(t.saved);
    } catch (error) {
      say(`${t.notSaved}${errorText(error)}`);
    }
    await load().catch(error => say(errorText(error)));
  });
  return saving;
}


function row(label: string, control: Node): HTMLDivElement { return el('div', { className: 'row' }, el('span', { className: 'label', textContent: label }), control); }

function backendRow(entry: AssistantBackendSettings): HTMLLIElement {
  const preset = PRESETS.find(item => item.id === entry.preset);
  const info = state!.status.backends.find(item => item.id === entry.id);
  const slot = state!.slots[entry.id] ?? null;
  const check = state!.checks[entry.id];
  const item = el('li', { className: 'backend', dataset: { backend: entry.id } });
  const head = el('div', { className: 'row' },
    el('strong', { textContent: `${preset?.label ?? entry.preset} · ${entry.model ?? ''}` }),
    el('span', { className: 'muted', textContent: `${entry.url ?? ''} — ${info ? t.where[info.target] : ''}` }));
  const controls = el('div', { className: 'row' });
  controls.append(checkbox(entry.enabled, t.enabledBackend, value => void save(s => { s.backends.find(b => b.id === entry.id)!.enabled = value; }), `enabled-${entry.id}`));
  if (info?.target === 'remote') {
    controls.append(el('span', { className: 'label', textContent: t.trust }), select(entry.trust ?? 'D0', [['D0', 'D0'], ['D1', 'D1'], ['D2', 'D2']], value => void save(s => { s.backends.find(b => b.id === entry.id)!.trust = value; }), `trust-${entry.id}`));
  }
  const checkButton = el('button', { type: 'button', textContent: t.check, name: `check-${entry.id}` });
  checkButton.addEventListener('click', () => {
    say(t.checking);
    host.service.request(SERVICE, 'check', { backendId: entry.id }).then(() => load(), error => say(errorText(error)));
  });
  const removeButton = el('button', { type: 'button', textContent: t.remove });
  removeButton.addEventListener('click', () => void save(s => { s.backends = s.backends.filter(b => b.id !== entry.id); }));
  controls.append(checkButton, removeButton);
  item.append(head, controls);
  if (slot) {
    // Write-only: the value goes into the plugin's secrets bound to this address and is never read back here.
    const input = el('input', { type: 'password', placeholder: t.key, autocomplete: 'off', name: `key-${entry.id}` });
    const saveKey = el('button', { type: 'button', textContent: t.saveKey });
    saveKey.addEventListener('click', async () => {
      const value = input.value.trim();
      if (!value) return;
      // The field is cleared only once the key is stored: a failed write keeps what the person pasted.
      let stored = false;
      try {
        await host.secrets.set(slot.secret, JSON.stringify({ origin: slot.origin, value }));
        stored = true; input.value = '';
        await host.service.request(SERVICE, 'keyChanged', { backendId: entry.id });
        say(t.saved);
      } catch (error) { say(`${t.notSaved}${errorText(error)}`); }
      if (stored) await load();
    });
    const removeKey = el('button', { type: 'button', textContent: t.removeKey });
    removeKey.addEventListener('click', async () => {
      try {
        await host.secrets.delete(slot.secret);
        await host.service.request(SERVICE, 'keyChanged', { backendId: entry.id });
      } catch (error) { say(errorText(error)); }
      await load();
    });
    item.append(el('div', { className: 'row' }, el('span', { className: 'muted', textContent: info?.keyConfigured ? t.keySet : t.keyNone }), input, saveKey, removeKey));
  }
  if (check) {
    const line = 'running' in check ? t.checking : 'error' in check ? check.error : check.added ? t.checkOk(check) : t.checkFail(check);
    item.append(el('div', { className: 'check-result', textContent: line, dataset: { result: entry.id } }));
  }
  return item;
}

function addForm(): HTMLDivElement {
  const form = el('div', { className: 'add' });
  const presetSelect = el('select', { name: 'preset' });
  for (const preset of PRESETS) presetSelect.append(el('option', { value: preset.id, textContent: preset.label }));
  const model = el('input', { name: 'model', placeholder: t.model, value: PRESETS[0]!.model });
  const url = el('input', { name: 'url', placeholder: t.url, value: PRESETS[0]!.url ?? '' });
  const localInput = el('input', { type: 'checkbox', name: 'local', checked: true });
  const local = el('label', { className: 'check' }, localInput, ` ${t.local}`);
  const sync = (): void => {
    const preset = PRESETS.find(item => item.id === presetSelect.value)!;
    model.value = preset.model;
    url.value = preset.url ?? '';
    url.disabled = preset.url === null;
    local.hidden = preset.url === null;
    localInput.checked = !!preset.url && /^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)/u.test(preset.url);
  };
  presetSelect.addEventListener('change', sync);
  const add = el('button', { type: 'button', textContent: t.add, name: 'add' });
  add.addEventListener('click', () => {
    const preset = PRESETS.find(item => item.id === presetSelect.value)!;
    const taken = new Set(state!.settings.backends.map(b => b.id));
    let n = 1;
    while (taken.has(`${preset.id}-${n}`)) n++;
    const entry: AssistantBackendSettings = { id: `${preset.id}-${n}`, preset: preset.id, enabled: true, model: model.value.trim() };
    if (preset.id === 'emulated') entry.runtime = 'ollama';
    if (preset.url !== null) entry.url = url.value.trim();
    if (preset.url !== null && localInput.checked) {
      try {
        const parsed = new URL(entry.url!);
        entry.localConfirmed = { port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)), at: Date.now() };
      } catch { /* the service refuses the address */ }
    }
    void save(s => { s.backends.push(entry); });
  });
  form.append(presetSelect, model, url, add, local);
  return form;
}

function smartSection(): HTMLDivElement {
  const smart = state!.settings.smart;
  const model = el('input', { name: 'smart-model', placeholder: t.smartModel, value: smart.kind === 'ollama-chat' ? smart.model : '' });
  const saveSmart = el('button', { type: 'button', textContent: t.add, name: 'smart-save' });
  saveSmart.addEventListener('click', () => void save(s => {
    s.smart = model.value.trim() ? { kind: 'ollama-chat', url: 'http://127.0.0.1:11434', model: model.value.trim() } : { kind: 'none' };
  }));
  return el('div', {},
    row(t.smart, el('span', {}, model, saveSmart)),
    checkbox(state!.settings.shadowAsksSmart, t.smartAsk, value => void save(s => { s.shadowAsksSmart = value; }), 'shadow-asks-smart'));
}

function recentSection(): HTMLUListElement {
  const list = el('ul', { className: 'recent' });
  if (!state!.recent.length) list.append(el('li', { className: 'muted', textContent: t.noRecent }));
  for (const entry of state!.recent.slice(0, 20)) {
    const item = el('li', {}, el('code', { textContent: entry.summary }), ` → ${entry.act ?? '—'} (${entry.outcome}, ${entry.tier ?? '—'}, ${entry.reason}) `);
    if (entry.auditId && entry.tier !== 'rule' && !entry.label) {
      for (const verdict of ['right', 'wrong'] as const) {
        const button = el('button', { type: 'button', textContent: t[verdict] });
        button.addEventListener('click', async () => { await host.service.request(SERVICE, 'feedback', { auditId: entry.auditId, verdict }); await load(); });
        item.append(button);
      }
    } else if (entry.label) item.append(el('span', { className: 'muted', textContent: t[entry.label] }));
    list.append(item);
  }
  return list;
}

function render(): void {
  if (!state) return;
  const s = state.settings;
  const backends = el('ul', { className: 'backends' });
  if (!s.backends.length) backends.append(el('li', { className: 'muted', textContent: t.none }));
  for (const entry of s.backends) backends.append(backendRow(entry));
  root.replaceChildren(
    el('h1', { textContent: t.title }),
    el('p', { className: 'muted', textContent: t.lead }),
    el('h2', { textContent: t.modes }),
    // Task triage needs the Assistant on; command review's own control keeps it on while review runs.
    row(t.triage, select(s.modes['task.route'], [['off', t.off], ['shadow', t.shadow], ['suggest', t.suggest], ['auto', t.auto]], value => void save(next => {
      next.modes['task.route'] = value;
      next.enabled = value !== 'off' || next.modes['command.review'] !== 'off';
    }), 'task.route')),
    el('p', { className: 'muted', textContent: t.modeHelp }),
    el('h2', { textContent: t.backends }),
    backends,
    addForm(),
    smartSection(),
    el('h2', { textContent: t.data }),
    row(t.engine, select(s.engine, [['auto', t.engineAuto], ['jev', t.engineJev], ['local', t.engineLocal]], value => void save(next => { next.engine = value; }), 'engine')),
    row(t.dataMode, select(s.dataClassMode, [['strict', t.strict], ['warn', t.warn], ['off', t.dataOff]], value => void save(next => { next.dataClassMode = value; }), 'data-mode')),
    row(t.grant, select(s.grant, [['off', t.grantOff], ['D1', t.grantD1], ['D2', t.grantD2]], value => void save(next => { next.grant = value; }), 'grant')),
    row(t.defaultClass, select(s.defaultDataClass, [['D0', 'D0'], ['D1', 'D1'], ['D2', 'D2'], ['D3', 'D3']], value => void save(next => { next.defaultDataClass = value; }), 'default-class')),
    el('h2', { textContent: t.recent }),
    recentSection(),
    ...(autoState ? [renderAuto(autoState, autoStrings, {
      request: (method, params) => host.service.request(SERVICE, method, params),
      setSecret: (key, value) => host.secrets.set(key, value),
      deleteSecret: key => host.secrets.delete(key),
      say,
      reload: () => { void load().catch(error => say(errorText(error))); }
    }, autoView)] : []),
    ...(routeState ? [renderRouting(routeState, routeStrings, {
      request: (method, params) => host.service.request(SERVICE, method, params),
      forwardLimits,
      say,
      reload: () => { void load().catch(error => say(errorText(error))); }
    })] : [])
  );
}

host.onContext(({ appearance }) => {
  const locale = applyAppearance(appearance);
  t = locale === 'ru' ? STRINGS.ru : STRINGS.en;
  autoStrings = locale === 'ru' ? AUTO_PAGE_STRINGS.ru : AUTO_PAGE_STRINGS.en;
  routeStrings = locale === 'ru' ? ROUTE_PAGE_STRINGS.ru : ROUTE_PAGE_STRINGS.en;
  render();
});
host.service.onEvent(({ serviceId, event, data }) => {
  // The other settings page saved (or the saved settings were read late): show what is in force now.
  if (serviceId === SERVICE && event === 'settings') { whenIdle(() => { void load().catch(error => say(errorText(error))); }); return; }
  if (serviceId !== SERVICE || event !== 'check') return;
  const result = data as AssistantCheckResult | { error: string };
  say('error' in result ? result.error : result.added ? t.checkOk(result) : t.checkFail(result));
  void load();
});
void forwardLimits().catch(() => undefined).finally(() => load().catch(error => say(errorText(error))));
