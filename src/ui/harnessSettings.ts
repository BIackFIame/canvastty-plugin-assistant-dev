// The plugin's settings page (bundled to settings/harness.js): four controls. Decision models are optional and live
// on their own page, opened from the link at the bottom.
import { el, errorText, host, onContext, segmented, SERVICE, settingRow, toggle, type PageLocale } from './common.ts';

type Level = 'strict' | 'warn' | 'off';
interface State { commandReview: Level; routing: boolean; loopAlerts: boolean; flows: boolean; models: number }

const STRINGS = {
  en: {
    lead: 'Works by itself: nothing here needs changing for it to run.',
    review: 'Command review', reviewHelp: 'Checks agents\' shell commands and file writes before they run. Strict sends anything but read-only commands to you; Warn only blocks clearly dangerous ones and shows suggestions on the card.',
    strict: 'Strict', warn: 'Warn', off: 'Off',
    routing: 'Automatic routing', routingHelp: 'Orchestrators get a provider and model suggestion for each subagent.',
    loops: 'Loop alerts', loopsHelp: 'A "loop?" badge on a card that repeats the same command without changing files.',
    flows: 'Flows', flowsHelp: 'Orchestrators may propose flows; you preview roles and tasks before anything starts.',
    models: (n: number) => n ? `Decision models: ${n} on` : 'Decision models: none (simple rules are used)', openModels: 'Decision models…',
    saved: 'Saved.', notSaved: 'Not saved: '
  },
  ru: {
    lead: 'Работает сам: ничего менять не нужно.',
    review: 'Проверка команд', reviewHelp: 'Проверяет команды и записи файлов агентов до запуска. «Строго» передаёт вам всё, кроме команд чтения; «Предупреждать» блокирует только явно опасное и показывает подсказки на окне.',
    strict: 'Строго', warn: 'Предупреждать', off: 'Выкл',
    routing: 'Автоматический выбор модели', routingHelp: 'Оркестратор получает предложение провайдера и модели для каждого субагента.',
    loops: 'Сигнал зацикливания', loopsHelp: 'Значок «цикл?» на окне, которое повторяет одну команду, не меняя файлов.',
    flows: 'Сценарии', flowsHelp: 'Оркестратор может предложить сценарий; вы видите роли и задачи до запуска.',
    models: (n: number) => n ? `Модели решений: включено ${n}` : 'Модели решений: нет (работают простые правила)', openModels: 'Модели решений…',
    saved: 'Сохранено.', notSaved: 'Не сохранено: '
  }
};

let t = STRINGS.en;
let state: State | null = null;
const root = document.querySelector('#app')!;
const status = document.querySelector('#status')!;
const say = (message: string, error = false): void => { status.textContent = message; status.classList.toggle('is-error', error); };

async function load(): Promise<void> {
  state = await host.service.request(SERVICE, 'harness.settings') as State;
  render();
}

let saving: Promise<void> = Promise.resolve();
function save(change: Partial<State>): void {
  saving = saving.then(async () => {
    if (!state) return;
    const { models: _models, ...current } = state;
    try {
      state = await host.service.request(SERVICE, 'harness.saveSettings', { settings: { ...current, ...change } }) as State;
      say(t.saved);
    } catch (error) { say(`${t.notSaved}${errorText(error)}`, true); }
    render();
  });
}

function render(): void {
  if (!state) return;
  const s = state;
  const openModels = el('button', { type: 'button', className: 'link-button', textContent: t.openModels });
  openModels.addEventListener('click', () => { host.canvas?.open('models').catch(error => say(errorText(error), true)); });
  root.replaceChildren(
    el('p', { className: 'page__lead', textContent: t.lead }),
    el('div', { className: 'setting-group' },
      settingRow(t.review, t.reviewHelp, segmented(t.review, s.commandReview, [['strict', t.strict], ['warn', t.warn], ['off', t.off]], value => save({ commandReview: value }))),
      settingRow(t.routing, t.routingHelp, toggle('routing', s.routing, t.routing, value => save({ routing: value }))),
      settingRow(t.loops, t.loopsHelp, toggle('loopAlerts', s.loopAlerts, t.loops, value => save({ loopAlerts: value }))),
      settingRow(t.flows, t.flowsHelp, toggle('flows', s.flows, t.flows, value => save({ flows: value })))),
    el('div', { className: 'row' }, el('span', { className: 'muted', textContent: t.models(s.models) }), openModels)
  );
}

onContext((locale: PageLocale) => { t = STRINGS[locale]; render(); });
host.service.onEvent(({ serviceId, event }) => { if (serviceId === SERVICE && event === 'settings') void load(); });
load().catch(error => say(errorText(error), true));
