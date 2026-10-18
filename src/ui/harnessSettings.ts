// The plugin's settings page (bundled to settings/harness.js): command review (with its trust chain), routing, loop alerts and flows. Decision models are optional and live
// on their own page, opened from the link at the bottom.
import { el, errorText, host, onContext, segmented, SERVICE, settingRow, toggle, type PageLocale } from './common.ts';

type Level = 'strict' | 'basic' | 'off';
interface State {
  commandReview: Level | 'custom'; custom: { mode: string; strictness: string } | null; settingsUnavailable: boolean;
  routing: boolean; loopAlerts: boolean; flows: boolean; trustChain?: boolean; models: number;
}

const STRINGS = {
  en: {
    lead: 'Everything here is your choice. Command review starts Off; turn it on if you want it.',
    review: 'Command review', reviewHelp: 'Checks agents\' shell commands and file writes before they run.',
    strict: 'Strict', basic: 'Basic rules', off: 'Off', custom: 'Custom',
    levels: {
      strict: 'Strict: anything but read-only commands waits for your answer.',
      basic: 'Basic rules: blocks what the hard rules forbid (sudo, piping downloads into a shell, deleting or writing outside the project); the rest runs, with a hint on the card.',
      off: 'Off: the Assistant does not review commands.'
    },
    customHelp: (mode: string, strictness: string) => `Custom: set by an older version or the decision models page (mode ${mode}, strictness ${strictness}). It stays as it is until you choose a level.`,
    modes: { off: 'Off', shadow: 'Learning', suggest: 'Suggest', auto: 'Auto' } as Record<string, string>,
    strictness: { triage: 'by the task', strict: 'always strict' } as Record<string, string>,
    unavailable: 'The saved settings could not be read yet: command review is Off and nothing can be saved. The Assistant tries again by itself.',
    chain: 'Trust the orchestrator\'s task for its subagents\' new files', chainHelp: 'When you typed the orchestrator\'s task yourself, its subagents may create new files inside the project without asking, if the review is at least 95% sure the file serves that task. Never for changes to existing files, files outside the project, secrets, or commands.',
    routing: 'Automatic routing', routingHelp: 'Orchestrators get a provider and model suggestion for each subagent.',
    loops: 'Loop alerts', loopsHelp: 'A "loop?" badge when a card repeats the same command in one turn with no file edits seen.',
    flows: 'Flows', flowsHelp: 'An orchestrator may ask you to approve a flow (roles and tasks). This is a request it is told to follow, not a lock: CanvasTTY cannot yet stop an orchestrator that starts agents without it.',
    models: (n: number) => n ? `Decision models: ${n} on` : 'Decision models: none (simple rules are used)', openModels: 'Decision models…',
    saved: 'Saved.', notSaved: 'Not saved: '
  },
  ru: {
    lead: 'Здесь всё решаете вы. Проверка команд сначала выключена; включите её, если она нужна.',
    review: 'Проверка команд', reviewHelp: 'Проверяет команды и записи файлов агентов до запуска.',
    strict: 'Строго', basic: 'Базовые правила', off: 'Выкл', custom: 'Особая',
    levels: {
      strict: 'Строго: всё, кроме команд чтения, ждёт вашего ответа.',
      basic: 'Базовые правила: блокирует то, что запрещают жёсткие правила (sudo, загрузка прямо в оболочку, удаление или запись вне проекта); остальное выполняется с подсказкой на окне.',
      off: 'Выкл: Помощник не проверяет команды.'
    },
    customHelp: (mode: string, strictness: string) => `Особая: задана старой версией или на странице моделей решений (режим «${mode}», строгость «${strictness}»). Остаётся как есть, пока вы не выберете уровень.`,
    modes: { off: 'Выкл', shadow: 'Обучение', suggest: 'Подсказки', auto: 'Авто' },
    strictness: { triage: 'по задаче', strict: 'всегда строго' },
    unavailable: 'Сохранённые настройки пока не прочитаны: проверка команд выключена, сохранить ничего нельзя. Помощник попробует ещё раз сам.',
    chain: 'Доверять задаче оркестратора для новых файлов его субагентов', chainHelp: 'Если задачу оркестратору вы написали сами, его субагенты могут без вопроса создавать новые файлы в проекте, когда проверка не меньше чем на 95% уверена, что файл нужен для этой задачи. Никогда — для изменения существующих файлов, файлов вне проекта, секретов и команд.',
    routing: 'Автоматический выбор модели', routingHelp: 'Оркестратор получает предложение провайдера и модели для каждого субагента.',
    loops: 'Сигнал зацикливания', loopsHelp: 'Значок «цикл?», когда окно за один ход повторяет одну команду, а правок файлов не видно.',
    flows: 'Сценарии', flowsHelp: 'Оркестратор может попросить вас одобрить сценарий (роли и задачи). Это просьба, которой его просят следовать, а не запрет: CanvasTTY пока не может остановить оркестратор, который запускает агентов без неё.',
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
    const { routing, loopAlerts, flows, commandReview } = state;
    const trustChain = state.trustChain === true;
    try {
      state = await host.service.request(SERVICE, 'harness.saveSettings', { settings: { commandReview, routing, loopAlerts, flows, trustChain, ...change } }) as State;
      say(t.saved);
    } catch (error) { say(`${t.notSaved}${errorText(error)}`, true); }
    render();
  });
}

function reviewHelp(s: State): HTMLDivElement {
  const lines = [t.reviewHelp, t.levels.strict, t.levels.basic, t.levels.off];
  if (s.commandReview === 'custom' && s.custom) lines.push(t.customHelp(t.modes[s.custom.mode] ?? s.custom.mode, t.strictness[s.custom.strictness] ?? s.custom.strictness));
  return el('div', {}, ...lines.map(line => el('div', { textContent: line })));
}

function render(): void {
  if (!state) return;
  const s = state;
  const openModels = el('button', { type: 'button', className: 'link-button', textContent: t.openModels });
  openModels.addEventListener('click', () => { host.canvas?.open('models').catch(error => say(errorText(error), true)); });
  const levels: Array<[Level | 'custom', string]> = [['strict', t.strict], ['basic', t.basic], ['off', t.off]];
  // A custom setting is shown, pressed and read-only; choosing a level replaces it.
  if (s.commandReview === 'custom') levels.push(['custom', t.custom]);
  const review = segmented(t.review, s.commandReview, levels, value => { if (value !== 'custom') save({ commandReview: value }); });
  root.replaceChildren(
    el('p', { className: 'page__lead', textContent: t.lead }),
    ...(s.settingsUnavailable ? [el('p', { className: 'notice', textContent: t.unavailable })] : []),
    el('div', { className: 'setting-group' },
      settingRow(t.review, reviewHelp(s), review),
      settingRow(t.chain, t.chainHelp, toggle('trustChain', s.trustChain === true, t.chain, value => save({ trustChain: value }))),
      settingRow(t.routing, t.routingHelp, toggle('routing', s.routing, t.routing, value => save({ routing: value }))),
      settingRow(t.loops, t.loopsHelp, toggle('loopAlerts', s.loopAlerts, t.loops, value => save({ loopAlerts: value }))),
      settingRow(t.flows, t.flowsHelp, toggle('flows', s.flows, t.flows, value => save({ flows: value })))),
    el('div', { className: 'row' }, el('span', { className: 'muted', textContent: t.models(s.models) }), openModels)
  );
}

onContext((locale: PageLocale) => { t = STRINGS[locale]; render(); });
// Either settings page saving (or a delayed read of the saved settings) sends `settings`.
host.service.onEvent(({ serviceId, event }) => { if (serviceId === SERVICE && event === 'settings') void load().catch(error => say(errorText(error), true)); });
load().catch(error => say(errorText(error), true));
