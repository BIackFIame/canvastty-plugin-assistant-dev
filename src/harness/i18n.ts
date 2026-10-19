/**
 * Strings the person reads from the service: card badges (24 characters at most), their tooltips, card action
 * toasts, errors the plugin's pages show and the reasons a project flow was not loaded. The locale comes from
 * `canvastty.initialize`. Tool answers are for agents and stay in English (`STRINGS.en`).
 */
import type { FlowField, FlowProblem } from './flowFile.ts';

export type Locale = 'en' | 'ru';

export const localeOf = (value: unknown): Locale => value === 'ru' ? 'ru' : 'en';

/** Errors a page shows; the service throws them by code and the text follows the person's language. */
export type ErrorCode =
  | 'chooseOrchestrator' | 'goalFirst' | 'unknownFlow' | 'startOrCancel' | 'unknownPlan' | 'alreadyStarted' | 'planCancelled'
  | 'orchestratorGone' | 'unknownAction' | 'invalidSettings' | 'reviewLevel' | 'settingsUnavailable';

const time = (locale: string) => (at: number): string => new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const EN = {
  loopBadge: 'loop?',
  loopTip: (count: number, what: 'command' | 'action') => `The same ${what} was repeated ${count} times in one turn, with no file edits seen in between. A hint only: look at the card.`,
  flowBadge: 'flow: preview',
  flowTip: 'The orchestrator asks you to approve a flow. Open Flow preview (Settings → Plugins → CanvasTTY Assistant) to see roles and tasks, then Start or Cancel.',
  tasksBadge: (done: number, total: number) => `tasks ${done}/${total}`,
  tasksTip: 'Tasks on this orchestrator\'s board. Open Task board from the card menu.',
  reviewFine: 'review: fine', reviewRisky: 'review: risky', reviewAsk: 'review: ask me',
  reviewTip: (summary: string) => `Assistant suggestion (not enforced): ${summary}`,
  triage: {
    difficulty: { simple: 'simple', normal: 'normal', hard: 'hard' } as Record<string, string>,
    category: { code: 'code', review: 'review', research: 'research', writing: 'writing', general: 'general' } as Record<string, string>,
    isolation: (kind: string) => `better in a ${kind === 'container' ? 'container' : 'worktree'}`,
    strict: 'strict command review', strong: 'use a strong model', split: 'splits into subagents', missing: 'the task misses information',
    tip: (hints: string) => `Assistant triage: ${hints || 'nothing to add'}`
  },
  boardToast: (title: string, done: number, total: number) => total
    ? `Task board now shows "${title}" (${done}/${total} done). Open it from Settings → Plugins → CanvasTTY Assistant → Task board; an open board switches by itself.`
    : `"${title}" has no tasks yet. The board fills when the orchestrator adds tasks or starts a flow.`,
  flowToast: (title: string) => `Flow preview now shows "${title}". Open it from Settings → Plugins → CanvasTTY Assistant → Flow preview, pick a flow and a goal, then press Start. Tell the orchestrator to run the approved flow.`,
  flowsOff: 'Flows are off in the Assistant settings.',
  errors: {
    chooseOrchestrator: 'Choose an open orchestrator card.', goalFirst: 'Write the goal first.', unknownFlow: 'This flow is not available any more.',
    startOrCancel: 'Choose Start or Cancel.', unknownPlan: 'This plan is not available any more.', alreadyStarted: 'This plan was already started.',
    planCancelled: 'This plan was cancelled.', orchestratorGone: 'Its orchestrator card is closed; the plan cannot be started.',
    unknownAction: 'This action is not known to the Assistant.', invalidSettings: 'These settings are not valid.',
    reviewLevel: 'Command review is Strict, Basic rules or Off.',
    settingsUnavailable: 'The saved settings could not be read yet, so nothing is changed. The Assistant tries again by itself.'
  } as Record<ErrorCode, string>,
  flowProblem: (problem: FlowProblem): string => {
    const at = problem.role ? `role ${problem.role}: ` : '';
    const line = problem.line ? ` (line ${problem.line})` : '';
    switch (problem.code) {
      case 'link': return 'a link is not read; copy the file into the folder';
      case 'folderLink': return 'the folder is a link; flows are read only from a real folder inside the project';
      case 'outside': return 'the folder is outside the project';
      case 'tooLarge': return 'the file is larger than 32 KB';
      case 'json': return `not valid JSON${line}`;
      case 'yaml': return `YAML this reader cannot read${line}; use the simple form or JSON`;
      case 'yamlUnsupported': return `this YAML feature is not supported, use JSON${line}`;
      case 'reservedKey': return `${at}keys named __proto__, constructor or prototype are not allowed`;
      case 'shape': return 'a flow is a mapping with name and roles';
      case 'unknownKey': return `${at}a key a flow cannot have`;
      case 'field': return `${at}${FIELD_EN[problem.field ?? 'name']}`;
      case 'duplicate': return 'a flow with the same id is already listed';
      default: return 'the file could not be read';
    }
  },
  report: {
    title: (title: string) => `Report: ${title}`,
    role: { agent: 'agent', orchestrator: 'orchestrator', subagent: 'subagent' } as Record<string, string>,
    status: { idle: 'idle', working: 'working', needs_approval: 'waiting for approval', unavailable: 'waiting for the first prompt', done: 'done', failed: 'failed' } as Record<string, string>,
    started: 'Started', ran: 'Ran', state: 'Status', exit: 'Exit code', turns: 'Turns', children: 'Subagents',
    commandsReviewed: 'Commands reviewed', commandsSeen: 'Commands seen', reviewed: (deny: number, ask: number) => `declined ${deny}, sent to you ${ask}`,
    loops: 'Loop alerts', tasks: 'Tasks', none: 'none',
    cost: 'Tokens and cost: not available to plugins on this CanvasTTY version.',
    minutes: (m: number) => m < 1 ? 'under a minute' : `${Math.round(m)} min`,
    time: time('en')
  }
};

const FIELD_EN: Record<FlowField, string> = {
  name: 'name is missing or too long', description: 'description is too long', id: 'id must be unique lower-case letters, digits, - or _',
  roles: 'roles must list 1 to 8 roles', role: 'a role must be a mapping', title: 'title is too long', task: 'task is missing or too long',
  difficulty: 'difficulty is simple, normal or hard', provider: 'provider has characters it cannot have', model: 'model has characters it cannot have',
  effort: 'effort has characters it cannot have'
};

const FIELD_RU: Record<FlowField, string> = {
  name: 'нет имени (name) или оно слишком длинное', description: 'описание (description) слишком длинное',
  id: 'id — уникальные строчные латинские буквы, цифры, - или _', roles: 'roles — от 1 до 8 ролей', role: 'роль должна быть набором ключей',
  title: 'заголовок (title) слишком длинный', task: 'нет задачи (task) или она слишком длинная', difficulty: 'difficulty — simple, normal или hard',
  provider: 'в provider недопустимые символы', model: 'в model недопустимые символы', effort: 'в effort недопустимые символы'
};

type Strings = typeof EN;

const RU: Strings = {
  loopBadge: 'цикл?',
  loopTip: (count, what) => `Одна и та же ${what === 'command' ? 'команда' : 'операция'} повторилась ${count} раз за один ход, правок файлов между повторами не замечено. Это только подсказка: посмотрите на окно.`,
  flowBadge: 'сценарий: просмотр',
  flowTip: 'Оркестратор просит одобрить сценарий. Откройте «Просмотр сценария» (Настройки → Плагины → Ассистент CanvasTTY), посмотрите роли и задачи, затем «Запустить» или «Отмена».',
  tasksBadge: (done, total) => `задачи ${done}/${total}`,
  tasksTip: 'Задачи на доске этого оркестратора. Откройте «Доску задач» из меню окна.',
  reviewFine: 'проверка: ок', reviewRisky: 'проверка: риск', reviewAsk: 'проверка: решите вы',
  reviewTip: summary => `Подсказка Помощника (не применяется): ${summary}`,
  triage: {
    difficulty: { simple: 'простая', normal: 'обычная', hard: 'сложная' },
    category: { code: 'код', review: 'ревью', research: 'исследование', writing: 'текст', general: 'общее' },
    isolation: kind => `лучше в ${kind === 'container' ? 'контейнере' : 'worktree'}`,
    strict: 'строгая проверка команд', strong: 'нужна сильная модель', split: 'делится на субагентов', missing: 'в задаче не хватает данных',
    tip: hints => `Разбор Помощника: ${hints || 'добавить нечего'}`
  },
  boardToast: (title, done, total) => total
    ? `Доска задач показывает «${title}» (готово ${done} из ${total}). Откройте её: Настройки → Плагины → Ассистент CanvasTTY → Доска задач; открытая доска переключится сама.`
    : `У «${title}» пока нет задач. Доска заполнится, когда оркестратор добавит задачи или запустит сценарий.`,
  flowToast: title => `«Просмотр сценария» показывает «${title}». Откройте его: Настройки → Плагины → Ассистент CanvasTTY → Просмотр сценария, выберите сценарий и цель, нажмите «Запустить». Затем попросите оркестратор выполнить одобренный сценарий.`,
  flowsOff: 'Сценарии выключены в настройках Помощника.',
  errors: {
    chooseOrchestrator: 'Выберите открытое окно оркестратора.', goalFirst: 'Сначала напишите цель.', unknownFlow: 'Этот сценарий больше недоступен.',
    startOrCancel: 'Выберите «Запустить» или «Отмена».', unknownPlan: 'Этот план больше недоступен.', alreadyStarted: 'Этот план уже запущен.',
    planCancelled: 'Этот план отменён.', orchestratorGone: 'Окно его оркестратора закрыто; план нельзя запустить.',
    unknownAction: 'Помощник не знает этого действия.', invalidSettings: 'Эти настройки недопустимы.',
    reviewLevel: 'Проверка команд: «Строго», «Базовые правила» или «Выкл».',
    settingsUnavailable: 'Сохранённые настройки пока не прочитаны, поэтому ничего не изменено. Помощник попробует ещё раз сам.'
  },
  flowProblem: problem => {
    const at = problem.role ? `роль ${problem.role}: ` : '';
    const line = problem.line ? ` (строка ${problem.line})` : '';
    switch (problem.code) {
      case 'link': return 'ссылка не читается; скопируйте файл в папку';
      case 'folderLink': return 'папка — это ссылка; сценарии читаются только из настоящей папки внутри проекта';
      case 'outside': return 'папка находится вне проекта';
      case 'tooLarge': return 'файл больше 32 КБ';
      case 'json': return `недопустимый JSON${line}`;
      case 'yaml': return `этот YAML не читается${line}; используйте простую форму или JSON`;
      case 'yamlUnsupported': return `эта возможность YAML не поддерживается, используйте JSON${line}`;
      case 'reservedKey': return `${at}ключи __proto__, constructor и prototype недопустимы`;
      case 'shape': return 'сценарий — это набор ключей с name и roles';
      case 'unknownKey': return `${at}ключ, которого у сценария не бывает`;
      case 'field': return `${at}${FIELD_RU[problem.field ?? 'name']}`;
      case 'duplicate': return 'сценарий с таким id уже есть';
      default: return 'файл не удалось прочитать';
    }
  },
  report: {
    title: title => `Отчёт: ${title}`,
    role: { agent: 'агент', orchestrator: 'оркестратор', subagent: 'субагент' },
    status: { idle: 'ждёт', working: 'работает', needs_approval: 'ждёт подтверждения', unavailable: 'ждёт первого запроса', done: 'завершён', failed: 'ошибка' },
    started: 'Запущен', ran: 'Работал', state: 'Состояние', exit: 'Код выхода', turns: 'Ходов', children: 'Субагенты',
    commandsReviewed: 'Команд проверено', commandsSeen: 'Команд замечено', reviewed: (deny, ask) => `отклонено ${deny}, передано вам ${ask}`,
    loops: 'Сигналы цикла', tasks: 'Задачи', none: 'нет',
    cost: 'Токены и стоимость: этой версии CanvasTTY плагинам недоступны.',
    minutes: m => m < 1 ? 'меньше минуты' : `${Math.round(m)} мин`,
    time: time('ru')
  }
};

export const STRINGS: Readonly<Record<Locale, Strings>> = { en: EN, ru: RU };
export type ServiceStrings = Strings;

/** An error whose text is chosen where it is shown (a page), in the person's language. */
export class HarnessError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, locale: Locale = 'en') { super(STRINGS[locale].errors[code]); this.code = code; }
}
