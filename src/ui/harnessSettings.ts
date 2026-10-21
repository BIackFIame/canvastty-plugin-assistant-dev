// The plugin's settings page (bundled to settings/harness.js): command review (with its trust chain), routing, loop alerts and flows,
// and one action: Start with Auto (Jev). Decision models are optional and live
// on their own page, opened from the link at the bottom.
import { el, errorText, host, onContext, segmented, SERVICE, settingRow, toggle, whenIdle, type PageLocale } from './common.ts';

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
      basic: 'Basic rules: blocks sudo, piping downloads into a shell and writing outside the project; the rest runs.',
      off: 'Off: the Assistant does not review commands.'
    },
    customHelp: (mode: string, strictness: string) => `Set on the Decision models page (${mode}, ${strictness}). Choose a level to replace it.`,
    modes: { off: 'Off', shadow: 'Learning', suggest: 'Suggest', auto: 'Auto' } as Record<string, string>,
    strictness: { triage: 'by the task', strict: 'always strict' } as Record<string, string>,
    unavailable: 'The saved settings could not be read yet: command review is Off and nothing can be saved. The Assistant tries again by itself.',
    chain: 'Let subagents create new files for a task you typed', chainHelp: 'Also lets them run their tests, look around the project and fix files they wrote. Never secrets, files outside the project, or other commands.',
    routing: 'Automatic routing', routingHelp: 'Orchestrators get a provider and model suggestion for each subagent.',
    loops: 'Loop alerts', loopsHelp: 'A "loop?" badge when a card repeats the same command in one turn with no file edits seen.',
    flows: 'Flows', flowsHelp: 'An orchestrator may ask you to approve its roles and tasks first (a request, not a lock).',
    models: (n: number) => n ? `Decision models: ${n} on` : 'Decision models: none (simple rules are used)', openModels: 'Decision models…', openTree: 'Agent tree…',
    saved: 'Saved.', notSaved: 'Not saved: ',
    start: {
      title: 'Start with Auto (Jev)',
      help: 'Jev reads the task and chooses where an orchestrator runs: the CLI, your subscription, plan or account, the model and effort. The Assistant starts it, gives it the task and routes each of its subagents.',
      task: 'Task', taskPlaceholder: 'What should be done', folder: 'Project folder', server: 'On one of your servers (Jev picks one)',
      button: 'Start with Auto (Jev)', starting: 'Starting…',
      started: (route: string) => `Started: ${route}. Its subagents are routed by Jev.`,
      codes: {
        input: 'Write the task and the project folder (a full path).',
        routingOff: 'Turn on Automatic routing above first: Auto (Jev) routes every subagent.',
        core: 'This CanvasTTY does not let plugins start orchestrators: start one yourself in the launcher with Model: Auto (Jev).',
        consent: 'To start it from here, allow “May start orchestrators” for the Assistant in Settings → Extension native code. Or start an orchestrator yourself in the launcher with Model: Auto (Jev).',
        noRoute: 'No declared subscription, coding plan or account can run an orchestrator now (Where agents run, on the Decision models page).',
        noServer: 'No declared server has room now.',
        refused: 'CanvasTTY did not start it.'
      } as Record<string, string>
    }
  },
  ru: {
    lead: 'Здесь всё решаете вы. Проверка команд сначала выключена; включите её, если она нужна.',
    review: 'Проверка команд', reviewHelp: 'Проверяет команды и записи файлов агентов до запуска.',
    strict: 'Строго', basic: 'Базовые правила', off: 'Выкл', custom: 'Своя',
    levels: {
      strict: 'Строго: всё, кроме команд чтения, ждёт вашего ответа.',
      basic: 'Базовые правила: блокирует sudo, загрузку прямо в оболочку и запись вне проекта; остальное выполняется.',
      off: 'Выкл: Помощник не проверяет команды.'
    },
    customHelp: (mode: string, strictness: string) => `Задана на странице моделей решений («${mode}», «${strictness}»). Выберите уровень, чтобы заменить её.`,
    modes: { off: 'Выкл', shadow: 'Обучение', suggest: 'Подсказки', auto: 'Авто' },
    strictness: { triage: 'по задаче', strict: 'всегда строго' },
    unavailable: 'Сохранённые настройки пока не прочитаны: проверка команд выключена, сохранить ничего нельзя. Помощник попробует ещё раз сам.',
    chain: 'Разрешить субагентам создавать новые файлы для задачи, которую вы написали', chainHelp: 'А также запускать свои тесты, смотреть файлы проекта и исправлять файлы, которые они сами записали. Никогда — секреты, файлы вне проекта и другие команды.',
    routing: 'Автоматический выбор модели', routingHelp: 'Оркестратор получает предложение провайдера и модели для каждого субагента.',
    loops: 'Сигнал зацикливания', loopsHelp: 'Значок «цикл?», когда окно за один ход повторяет одну команду, а правок файлов не видно.',
    flows: 'Сценарии', flowsHelp: 'Оркестратор может сначала попросить вас одобрить роли и задачи (это просьба, а не запрет).',
    models: (n: number) => n ? `Модели решений: включено ${n}` : 'Модели решений: нет (работают простые правила)', openModels: 'Модели решений…', openTree: 'Дерево агентов…',
    saved: 'Сохранено.', notSaved: 'Не сохранено: ',
    start: {
      title: 'Запустить с «Авто (Jev)»',
      help: 'Jev читает задачу и выбирает, где работает оркестратор: CLI, вашу подписку, план или аккаунт, модель и усилие. Помощник запускает его, передаёт задачу и направляет каждого его субагента.',
      task: 'Задача', taskPlaceholder: 'Что нужно сделать', folder: 'Папка проекта', server: 'На одном из ваших серверов (выберет Jev)',
      button: 'Запустить с «Авто (Jev)»', starting: 'Запуск…',
      started: (route: string) => `Запущен: ${route}. Его субагентов направляет Jev.`,
      codes: {
        input: 'Напишите задачу и папку проекта (полный путь).',
        routingOff: 'Сначала включите автоматический выбор модели выше: «Авто (Jev)» направляет каждого субагента.',
        core: 'Эта версия CanvasTTY не разрешает плагинам запускать оркестраторы: запустите его сами в окне запуска с моделью «Авто (Jev)».',
        consent: 'Чтобы запускать отсюда, разрешите Помощнику «Может запускать оркестраторов» в Настройки → Нативный код расширений. Или запустите оркестратор сами в окне запуска с моделью «Авто (Jev)».',
        noRoute: 'Сейчас ни одна объявленная подписка, план или аккаунт не может вести оркестратор («Где работают агенты» на странице моделей решений).',
        noServer: 'Сейчас ни на одном объявленном сервере нет места.',
        refused: 'CanvasTTY не запустил его.'
      }
    }
  }
};

let t = STRINGS.en;
let state: State | null = null;
/** "Start with Auto (Jev)": the open cards' folders and whether servers are on (null on an older service). */
let entry: { folders: string[]; servers: boolean } | null = null;
const draft = { task: '', folder: '', server: false };
let starting = false;
/** The last start that did not happen: its one-line hint stays under the button (in the page's language). */
let hint: { code: string; detail?: string } | null = null;
const root = document.querySelector('#app')!;
const status = document.querySelector('#status')!;
const say = (message: string, error = false): void => { status.textContent = message; status.classList.toggle('is-error', error); };

async function load(): Promise<void> {
  state = await host.service.request(SERVICE, 'harness.settings') as State;
  entry = await (host.service.request(SERVICE, 'autopilot.entry') as Promise<{ folders: string[]; servers: boolean }>).catch(() => null);
  if (entry && !draft.folder && entry.folders[0]) draft.folder = entry.folders[0];
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
  // One line: what the chosen level does (the others are one click away).
  const lines = [s.commandReview === 'custom' && s.custom ? t.customHelp(t.modes[s.custom.mode] ?? s.custom.mode, t.strictness[s.custom.strictness] ?? s.custom.strictness)
    : s.commandReview === 'custom' ? t.reviewHelp : t.levels[s.commandReview]];
  return el('div', {}, ...lines.map(line => el('div', { textContent: line })));
}

type StartAnswer = { started: true; route: string } | { started: false; code: string; detail?: string };

function startAuto(): void {
  if (starting) return;
  starting = true; hint = null; render();
  host.service.request(SERVICE, 'autopilot.start', { task: draft.task, cwd: draft.folder.trim(), server: draft.server })
    .then(raw => {
      const answer = raw as StartAnswer;
      if (answer.started) { draft.task = ''; say(t.start.started(answer.route)); return; }
      hint = { code: answer.code, ...(answer.detail ? { detail: answer.detail } : {}) };
    }, error => { hint = { code: 'refused', detail: errorText(error) }; })
    .finally(() => { starting = false; render(); });
}

/** One action: the task, the folder (the open cards' folders offered), and on a server only when servers are on. */
function startCard(): HTMLElement | null {
  if (!entry) return null;
  const task = el('textarea', { className: 'input', name: 'autoTask', rows: 3, maxLength: 2000, placeholder: t.start.taskPlaceholder, value: draft.task });
  task.addEventListener('input', () => { draft.task = task.value; });
  const folders = el('datalist', { id: 'auto-folders' }, ...entry.folders.map(folder => el('option', { value: folder })));
  const folder = el('input', { className: 'input', name: 'autoFolder', value: draft.folder, maxLength: 4096, spellcheck: false });
  folder.setAttribute('list', 'auto-folders');
  folder.addEventListener('input', () => { draft.folder = folder.value; });
  const button = el('button', { type: 'button', className: 'button button--primary', textContent: starting ? t.start.starting : t.start.button, disabled: starting });
  button.addEventListener('click', startAuto);
  return el('section', { className: 'card' },
    el('h2', { className: 'card__title', textContent: t.start.title }),
    el('p', { className: 'muted', textContent: t.start.help }),
    el('label', { className: 'field' }, el('span', { className: 'field__label', textContent: t.start.task }), task),
    el('label', { className: 'field' }, el('span', { className: 'field__label', textContent: t.start.folder }), folder, folders),
    entry.servers ? settingRow(t.start.server, '', toggle('autoServer', draft.server, t.start.server, value => { draft.server = value; })) : null,
    hint ? el('p', { className: 'notice', textContent: `${t.start.codes[hint.code] ?? t.start.codes.refused}${hint.detail ? ` ${hint.detail}` : ''}` }) : null,
    el('div', { className: 'row row--end' }, button));
}

function render(): void {
  if (!state) return;
  const s = state;
  const openModels = el('button', { type: 'button', className: 'link-button', textContent: t.openModels });
  openModels.addEventListener('click', () => { host.canvas?.open('models').catch(error => say(errorText(error), true)); });
  const openTree = el('button', { type: 'button', className: 'link-button', textContent: t.openTree });
  openTree.addEventListener('click', () => { host.canvas?.open('tree').catch(error => say(errorText(error), true)); });
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
    el('div', { className: 'row' }, el('span', { className: 'muted', textContent: t.models(s.models) }), openModels, openTree),
    ...[startCard()].filter((node): node is HTMLElement => node !== null)
  );
}

onContext((locale: PageLocale) => { t = STRINGS[locale]; render(); });
// Either settings page saving (or a delayed read of the saved settings) sends `settings`.
host.service.onEvent(({ serviceId, event }) => { if (serviceId === SERVICE && event === 'settings') whenIdle(() => { void load().catch(error => say(errorText(error), true)); }); });
load().catch(error => say(errorText(error), true));
