// Texts of the main agent («Главный агент») on the Assistant page and the HOME widget (ru/en, complete).
export type ConductorLocale = 'en' | 'ru';

export interface ConductorView {
  settings: { projects: Array<{ id: string; name: string; path: string }>; push: boolean; maxProjects: number };
  folder: string;
  conductor: { id: string; status: string | null } | null;
  lines: Array<{ projectId: string; name: string; text: string; state: string; sessionId: string | null; focus: string | null }>;
  running: number;
  suggestions: string[];
  checklist: { items: Array<{ id: string; state: 'ok' | 'missing' | 'unknown' | 'unsupported'; optional?: boolean; count?: number; section: 'page' | 'native-code' | 'broker' | 'home'; grants?: unknown[] }>; ready: boolean };
  routing: boolean;
}

const PLUGIN = 'CanvasTTY Assistant';

export const CONDUCTOR_TEXT = {
  en: {
    title: 'Main agent',
    help: 'One agent you talk to: it hands your tasks to your projects, starts a project agent in each on the route Jev picks, and follows them. It works only in the folders listed here.',
    start: 'Start the main agent', starting: 'Starting…', open: 'Show the main agent',
    status: (s: string | null) => s === 'working' ? 'working' : s === 'needs_approval' ? 'waits for you' : s === 'idle' ? 'ready' : s ?? '',
    running: (n: number, max: number) => `Projects running: ${n} of ${max}`,
    codes: {
      routingOff: 'Turn on Automatic routing above first.',
      core: 'This CanvasTTY does not let plugins start orchestrators.',
      consent: `Allow “May start orchestrators” for the Assistant first (see the checklist).`,
      noRoute: 'No route can run the main agent now: it needs Claude Code, Codex, Qwen Code or OpenCode with a sign-in, plan or account.',
      refused: 'CanvasTTY did not start it.', folder: 'Its folder could not be created.', busy: 'It is starting already.', input: 'CanvasTTY did not start it.'
    } as Record<string, string>,
    checklist: 'What the main agent needs', allowMissing: 'Allow what is missing…', allowHelp: 'CanvasTTY shows one dialog with each permission; you untick what you do not want.',
    noBundle: 'This CanvasTTY cannot ask for these permissions from a page: give them in Settings at the paths shown.',
    openSettings: 'Open Settings', noOpen: 'Open it yourself:',
    state: { ok: 'done', missing: 'missing', unknown: 'not known', unsupported: 'not in this CanvasTTY' } as Record<string, string>,
    optional: 'optional',
    items: {
      routing: ['Automatic routing is on', 'Turn it on above.'],
      orchestrators: ['The Assistant may start orchestrators', `Settings → Agents → Extension native code → ${PLUGIN} → May start orchestrators`],
      projects: ['At least one project folder', 'Add folders below.'],
      accounts: ['Accounts runs (its native code is trusted)', 'Settings → Agents → Extension native code → CanvasTTY Accounts'],
      shares: ['The Assistant reads Accounts’ routes and quota', `Settings → Agents → Extension native code → ${PLUGIN} → Reads from other extensions`],
      broker: ['Plan accounts allowed for the Assistant', 'Settings → Agents → Accounts for other extensions'],
      decisions: ['The Assistant may allow the main agent’s project tool (no prompt in Claude Code)', `Settings → Agents → Extension native code → ${PLUGIN} → May allow agent actions`],
      environments: ['Environments runs (servers; not needed for local work)', 'Settings → Agents → Extension native code → CanvasTTY Environments'],
      trustUpdates: ['Updates keep trust (Assistant and Environments, not Accounts)', 'Asked in CanvasTTY’s permission dialog where this CanvasTTY has it.'],
      widget: ['The “Main agent” tile on HOME', 'Settings → Appearance → HOME composition']
    } as Record<string, [string, string]>,
    count: (n: number) => ` (${n})`,
    projects: 'My projects', projectsHelp: 'The main agent starts work only in these folders. It never adds one itself.',
    noProjects: 'No folders yet.', remove: 'Remove', add: 'Add', pick: 'Choose…', pathPlaceholder: 'Full path of a project folder',
    suggest: 'Folders of open cards — add?',
    refused: {
      path: 'Write a full path.', missing: 'No such folder.', notDirectory: 'That is not a folder.', root: 'Not the disk root.', home: 'Not your home folder itself: choose a project inside it.',
      system: 'Not a system folder.', private: 'Not a folder with keys, sign-ins or CanvasTTY data.', conductor: 'That is the main agent’s own folder.', full: 'The list is full (32).', listed: 'Already listed.'
    } as Record<string, string>,
    push: 'Report status by itself', pushHelp: 'The Assistant types a project’s status line into the main agent when the project is done, failed, blocked or waits for you, but only while the main agent is idle and nothing was typed there for a while; changes close together go as one line.',
    max: 'Projects at once', maxHelp: 'A start beyond this waits until a project ends. Each project agent may start agents of its own.',
    folderLine: (path: string) => `Its folder: ${path}`,
    saved: 'Saved.', notSaved: 'Not saved: ',
    widgetSetup: 'Setup is not finished: the Assistant page lists what is missing.', openPage: 'Assistant page…',
    focusOld: 'This CanvasTTY cannot show a card from here.', noProjectsWidget: 'No projects yet: add folders on the Assistant page.'
  },
  ru: {
    title: 'Главный агент',
    help: 'Один агент, с которым вы говорите: он передаёт задачи вашим проектам, запускает в каждом агента проекта на маршруте, который выбирает Jev, и следит за ними. Работает только в папках из этого списка.',
    start: 'Запустить главного агента', starting: 'Запуск…', open: 'Показать главного агента',
    status: (s: string | null) => s === 'working' ? 'работает' : s === 'needs_approval' ? 'ждёт вас' : s === 'idle' ? 'готов' : s ?? '',
    running: (n: number, max: number) => `Проектов в работе: ${n} из ${max}`,
    codes: {
      routingOff: 'Сначала включите автоматический выбор модели выше.',
      core: 'Эта версия CanvasTTY не разрешает плагинам запускать оркестраторов.',
      consent: 'Сначала разрешите Помощнику «Может запускать оркестраторов» (см. список ниже).',
      noRoute: 'Сейчас нет маршрута для главного агента: нужен Claude Code, Codex, Qwen Code или OpenCode со входом, планом или аккаунтом.',
      refused: 'CanvasTTY не запустил его.', folder: 'Не удалось создать его папку.', busy: 'Он уже запускается.', input: 'CanvasTTY не запустил его.'
    } as Record<string, string>,
    checklist: 'Что нужно главному агенту', allowMissing: 'Разрешить недостающее…', allowHelp: 'CanvasTTY покажет одно окно со всеми разрешениями; ненужное можно снять.',
    noBundle: 'Эта версия CanvasTTY не умеет запрашивать разрешения со страницы: включите их в Настройках по указанным путям.',
    openSettings: 'Открыть настройки', noOpen: 'Откройте сами:',
    state: { ok: 'готово', missing: 'не хватает', unknown: 'неизвестно', unsupported: 'нет в этой версии' } as Record<string, string>,
    optional: 'по желанию',
    items: {
      routing: ['Включён автоматический выбор модели', 'Включите его выше.'],
      orchestrators: ['Помощник может запускать оркестраторов', `Настройки → Агенты → Нативный код расширений → ${PLUGIN} → Может запускать оркестраторов`],
      projects: ['Хотя бы одна папка проекта', 'Добавьте папки ниже.'],
      accounts: ['Accounts работает (его нативный код подтверждён)', 'Настройки → Агенты → Нативный код расширений → CanvasTTY Accounts'],
      shares: ['Помощник читает маршруты и квоты Accounts', `Настройки → Агенты → Нативный код расширений → ${PLUGIN} → Чтение данных других расширений`],
      broker: ['Аккаунты планов разрешены Помощнику', 'Настройки → Агенты → Учётные записи для других расширений'],
      decisions: ['Помощник может разрешать главному агенту его инструмент проектов (без вопроса в Claude Code)', `Настройки → Агенты → Нативный код расширений → ${PLUGIN} → Может разрешать действия агентов`],
      environments: ['Environments работает (серверы; для работы на этом компьютере не нужен)', 'Настройки → Агенты → Нативный код расширений → CanvasTTY Environments'],
      trustUpdates: ['Обновления сохраняют доверие (Помощник и Environments, не Accounts)', 'Спрашивается в окне разрешений CanvasTTY, где оно есть.'],
      widget: ['Плитка «Главный агент» на HOME', 'Настройки → Оформление → Состав HOME']
    } as Record<string, [string, string]>,
    count: (n: number) => ` (${n})`,
    projects: 'Мои проекты', projectsHelp: 'Главный агент начинает работу только в этих папках. Сам он папок не добавляет.',
    noProjects: 'Папок пока нет.', remove: 'Убрать', add: 'Добавить', pick: 'Выбрать…', pathPlaceholder: 'Полный путь к папке проекта',
    suggest: 'Папки открытых окон — добавить?',
    refused: {
      path: 'Напишите полный путь.', missing: 'Такой папки нет.', notDirectory: 'Это не папка.', root: 'Не корень диска.', home: 'Не сама домашняя папка: выберите проект внутри неё.',
      system: 'Не системная папка.', private: 'Не папка с ключами, входами или данными CanvasTTY.', conductor: 'Это папка самого главного агента.', full: 'Список полон (32).', listed: 'Уже в списке.'
    } as Record<string, string>,
    push: 'Сообщать статус самому', pushHelp: 'Помощник впечатывает строку статуса проекта в главного агента, когда проект готов, упал, заблокирован или ждёт вас, но только пока главный агент свободен и в нём какое-то время ничего не печатали; близкие по времени изменения идут одной строкой.',
    max: 'Проектов одновременно', maxHelp: 'Запуск сверх этого ждёт, пока какой-то проект закончит. Агент проекта может запускать своих агентов.',
    folderLine: (path: string) => `Его папка: ${path}`,
    saved: 'Сохранено.', notSaved: 'Не сохранено: ',
    widgetSetup: 'Настройка не закончена: на странице Помощника видно, чего не хватает.', openPage: 'Страница Помощника…',
    focusOld: 'Эта версия CanvasTTY не умеет показывать окно отсюда.', noProjectsWidget: 'Проектов пока нет: добавьте папки на странице Помощника.'
  }
};

/** The Settings section an item lives in, for `settings.open` on a host that has it. */
export const SETTINGS_SECTION: Record<string, string> = { 'native-code': 'native-code', broker: 'agents', home: 'appearance' };

/** A host method this CanvasTTY does not have (the frame answers "Unsupported plugin method"). */
export const unsupportedMethod = (error: unknown): boolean => /unsupported plugin method|unknown (host )?method|not (supported|available)/iu.test(error instanceof Error ? error.message : String(error));
