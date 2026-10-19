// The Task board card (bundled to apps/board.js): the tasks an orchestrator and its subagents keep with the
// task_add / task_update tools, and the roles of an approved flow. Read-only: the agents keep it current.
import { el, errorText, host, onContext, SERVICE, whenIdle, type PageLocale } from './common.ts';

type Status = 'todo' | 'doing' | 'done' | 'blocked';
interface Task { id: string; title: string; detail: string; status: Status; assignee: string | null; note: string; addedBy: 'orchestrator' | 'flow'; updatedAt: number }
interface Board { orchestratorId: string; title: string; tasks: Task[] }
interface View { focus: { board: string | null }; boards: Board[]; titles: Record<string, string> }

const STRINGS = {
  en: {
    board: 'Board', none: 'No task board yet. It fills when an orchestrator adds tasks or a flow you started adds its roles.',
    empty: 'This board has no tasks.', columns: { todo: 'To do', doing: 'In progress', done: 'Done', blocked: 'Blocked' } as Record<Status, string>,
    assignee: 'Assignee', progress: (done: number, total: number) => `${done} of ${total} done`, fromFlow: 'from a flow'
  },
  ru: {
    board: 'Доска', none: 'Досок задач пока нет. Доска заполнится, когда оркестратор добавит задачи или запущенный вами сценарий добавит свои роли.',
    empty: 'На этой доске нет задач.', columns: { todo: 'Сделать', doing: 'В работе', done: 'Готово', blocked: 'Заблокировано' } as Record<Status, string>,
    assignee: 'Исполнитель', progress: (done: number, total: number) => `готово ${done} из ${total}`, fromFlow: 'из сценария'
  }
};

let t = STRINGS.en;
let view: View | null = null;
let chosen: string | null = null;
const root = document.querySelector('#app')!;
const status = document.querySelector('#status')!;
const say = (message: string, error = false): void => { status.textContent = message; status.classList.toggle('is-error', error); };

async function load(): Promise<void> {
  view = await host.service.request(SERVICE, 'harness.view') as View;
  const ids = view.boards.map(board => board.orchestratorId);
  if (view.focus.board && ids.includes(view.focus.board) && !chosen) chosen = view.focus.board;
  if (!chosen || !ids.includes(chosen)) chosen = ids[0] ?? null;
  render();
}

function render(): void {
  if (!view) return;
  if (!view.boards.length) { root.replaceChildren(el('div', { className: 'empty', textContent: t.none })); return; }
  const board = view.boards.find(item => item.orchestratorId === chosen) ?? view.boards[0]!;
  const select = el('select', { className: 'select', name: 'board' });
  for (const item of view.boards) select.append(el('option', { value: item.orchestratorId, textContent: item.title, selected: item.orchestratorId === board.orchestratorId }));
  select.addEventListener('change', () => { chosen = select.value; render(); });
  const done = board.tasks.filter(task => task.status === 'done').length;
  const columns = (['todo', 'doing', 'done', 'blocked'] as Status[]).map(state => el('div', { className: 'column' },
    el('div', { className: 'column__head', textContent: `${t.columns[state]} · ${board.tasks.filter(task => task.status === state).length}` }),
    ...board.tasks.filter(task => task.status === state).map(task => el('div', { className: 'task' },
      el('div', {}, el('span', { className: 'muted', textContent: `${task.id} ` }), task.title),
      task.assignee ? el('div', { className: 'task__note', textContent: `${t.assignee}: ${view!.titles[task.assignee] ?? task.assignee.slice(0, 8)}` }) : null,
      task.note ? el('div', { className: 'task__note', textContent: task.note }) : null,
      task.addedBy === 'flow' ? el('span', { className: 'tag', textContent: t.fromFlow }) : null))));
  root.replaceChildren(
    el('div', { className: 'row' }, el('label', { className: 'field' }, el('span', { className: 'field__label', textContent: t.board }), select),
      el('span', { className: 'muted', textContent: board.tasks.length ? t.progress(done, board.tasks.length) : t.empty })),
    el('div', { className: 'columns' }, ...columns));
}

onContext((locale: PageLocale) => { t = STRINGS[locale]; render(); });
host.service.onEvent(({ serviceId, event, data }) => {
  if (serviceId !== SERVICE) return;
  if (event === 'focus') { const focus = (data as { board?: string | null } | null)?.board; if (focus) chosen = focus; }
  if (event === 'board' || event === 'changed' || event === 'focus') whenIdle(() => { void load().catch(error => say(errorText(error), true)); });
});
load().catch(error => say(errorText(error), true));
