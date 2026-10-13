/**
 * Strings the person reads from the service: card badges (24 characters at most), their tooltips and card action
 * toasts. The locale comes from `canvastty.initialize`. Tool answers are for agents and stay in English.
 */
export type Locale = 'en' | 'ru';

export const localeOf = (value: unknown): Locale => value === 'ru' ? 'ru' : 'en';

const EN = {
  loopBadge: 'loop?',
  loopTip: (count: number, what: string) => `The agent ran the same ${what} ${count} times without changing a file in between. Look at the card.`,
  flowBadge: 'flow: preview',
  flowTip: 'The orchestrator proposed a flow. Open Flow preview (Settings → Plugins → CanvasTTY Assistant) to see roles and tasks, then Start or Cancel.',
  tasksBadge: (done: number, total: number) => `tasks ${done}/${total}`,
  tasksTip: 'Tasks on this orchestrator\'s board. Open Task board from the card menu.',
  reviewFine: 'review: fine', reviewRisky: 'review: risky', reviewAsk: 'review: ask me',
  reviewTip: (summary: string) => `Assistant suggestion (not enforced): ${summary}`,
  boardToast: (title: string, done: number, total: number) => total
    ? `Task board now shows "${title}" (${done}/${total} done). Open it from Settings → Plugins → CanvasTTY Assistant → Task board; an open board switches by itself.`
    : `"${title}" has no tasks yet. The board fills when the orchestrator adds tasks or starts a flow.`,
  flowToast: (title: string) => `Flow preview now shows "${title}". Open it from Settings → Plugins → CanvasTTY Assistant → Flow preview, pick a flow and a goal, then press Start. Tell the orchestrator to run the approved flow.`,
  flowsOff: 'Flows are off in the Assistant settings.',
  report: {
    title: (title: string) => `Report: ${title}`,
    role: { agent: 'agent', orchestrator: 'orchestrator', subagent: 'subagent' } as Record<string, string>,
    started: 'Started', ran: 'Ran', status: 'Status', exit: 'Exit code', turns: 'Turns', children: 'Subagents',
    commands: 'Commands seen', reviewed: (deny: number, ask: number) => `declined ${deny}, sent to you ${ask}`,
    loops: 'Loop alerts', tasks: 'Tasks', none: 'none',
    cost: 'Tokens and cost: not available to plugins on this CanvasTTY version.',
    minutes: (m: number) => m < 1 ? 'under a minute' : `${Math.round(m)} min`
  }
};

type Strings = typeof EN;

const RU: Strings = {
  loopBadge: 'цикл?',
  loopTip: (count, what) => `Агент ${count} раз запустил одну и ту же ${what === 'command' ? 'команду' : 'операцию'}, не меняя файлов между запусками. Посмотрите на окно.`,
  flowBadge: 'сценарий: просмотр',
  flowTip: 'Оркестратор предложил сценарий. Откройте «Просмотр сценария» (Настройки → Плагины → CanvasTTY Assistant), посмотрите роли и задачи, затем «Запустить» или «Отмена».',
  tasksBadge: (done, total) => `задачи ${done}/${total}`,
  tasksTip: 'Задачи на доске этого оркестратора. Откройте «Доску задач» из меню окна.',
  reviewFine: 'проверка: ок', reviewRisky: 'проверка: риск', reviewAsk: 'проверка: решите вы',
  reviewTip: summary => `Подсказка Помощника (не применяется): ${summary}`,
  boardToast: (title, done, total) => total
    ? `Доска задач показывает «${title}» (готово ${done} из ${total}). Откройте её: Настройки → Плагины → CanvasTTY Assistant → Доска задач; открытая доска переключится сама.`
    : `У «${title}» пока нет задач. Доска заполнится, когда оркестратор добавит задачи или запустит сценарий.`,
  flowToast: title => `«Просмотр сценария» показывает «${title}». Откройте его: Настройки → Плагины → CanvasTTY Assistant → Просмотр сценария, выберите сценарий и цель, нажмите «Запустить». Затем попросите оркестратор выполнить одобренный сценарий.`,
  flowsOff: 'Сценарии выключены в настройках Помощника.',
  report: {
    title: title => `Отчёт: ${title}`,
    role: { agent: 'агент', orchestrator: 'оркестратор', subagent: 'субагент' },
    started: 'Запущен', ran: 'Работал', status: 'Состояние', exit: 'Код выхода', turns: 'Ходов', children: 'Субагенты',
    commands: 'Команд проверено', reviewed: (deny, ask) => `отклонено ${deny}, передано вам ${ask}`,
    loops: 'Сигналы цикла', tasks: 'Задачи', none: 'нет',
    cost: 'Токены и стоимость: этой версии CanvasTTY плагинам недоступны.',
    minutes: m => m < 1 ? 'меньше минуты' : `${Math.round(m)} мин`
  }
};

export const STRINGS: Readonly<Record<Locale, Strings>> = { en: EN, ru: RU };
export type ServiceStrings = Strings;
