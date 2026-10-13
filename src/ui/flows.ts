// The Flow preview card (bundled to apps/flows.js). It shows a proposed flow's roles, provider/model and tasks
// before anything starts; Start hands the plan to the orchestrator (which starts the subagents itself with
// CanvasTTY's spawn_agent), Cancel drops it. A flow from the project's .canvastty/flows is shown as written.
import { el, errorText, host, onContext, SERVICE, whenIdle, type PageLocale } from './common.ts';

interface PlannedRole { id: string; title: string; task: string; provider: string | null; model?: string; effort?: string; reason: string }
interface Plan {
  id: string; orchestratorId: string; orchestratorTitle: string; flowId: string; source: 'built-in' | 'project'; name: string; description: string;
  goal: string; roles: PlannedRole[]; status: 'pending' | 'approved' | 'cancelled'; requestedBy: 'orchestrator' | 'person'; createdAt: number;
}
interface Flow { id: string; name: string; description: string; source: 'built-in' | 'project'; roles: Array<{ id: string; title: string }> }
interface View { settings: { flows: boolean }; focus: { flows: string | null }; orchestrators: Array<{ id: string; title: string }>; plans: Plan[] }

const STRINGS = {
  en: {
    off: 'Flows are off in the Assistant settings.',
    waiting: 'Waiting for you', none: 'No flow is waiting. When an orchestrator proposes one, it appears here before anything starts.',
    flow: 'Flow', builtIn: 'Built in', project: 'From this project', what: 'What it does', goal: 'Goal', for: 'Orchestrator',
    role: 'Role', model: 'Provider / model', task: 'Task', auto: 'chosen by the orchestrator', providerDefault: 'default model',
    unchanged: 'Permissions are unchanged: each agent uses the launch profile of its orchestrator, and CanvasTTY checks every launch.',
    start: 'Start', cancel: 'Cancel', started: 'Started. The orchestrator gets the plan with flow_status; if it is not waiting for it, tell it to run the approved flow.', cancelled: 'Cancelled.',
    yourself: 'Choose a flow yourself', chooseOrch: 'Orchestrator', chooseFlow: 'Flow', goalPlaceholder: 'What should the flow achieve?', preview: 'Preview',
    noOrch: 'Open an orchestrator card first.', problems: 'Not loaded from .canvastty/flows:', recent: 'Recent',
    approved: 'started', cancelledTag: 'cancelled', askedBy: { orchestrator: 'proposed by the orchestrator', person: 'chosen by you' }
  },
  ru: {
    off: 'Сценарии выключены в настройках Помощника.',
    waiting: 'Ждёт вас', none: 'Нет сценариев, ждущих решения. Когда оркестратор предложит сценарий, он появится здесь до запуска.',
    flow: 'Сценарий', builtIn: 'Встроенный', project: 'Из этого проекта', what: 'Что делает', goal: 'Цель', for: 'Оркестратор',
    role: 'Роль', model: 'Провайдер / модель', task: 'Задача', auto: 'выберет оркестратор', providerDefault: 'модель по умолчанию',
    unchanged: 'Права не меняются: каждый агент запускается с профилем своего оркестратора, и CanvasTTY проверяет каждый запуск.',
    start: 'Запустить', cancel: 'Отмена', started: 'Запущено. Оркестратор получит план через flow_status; если он его не ждёт, попросите его выполнить одобренный сценарий.', cancelled: 'Отменено.',
    yourself: 'Выбрать сценарий самому', chooseOrch: 'Оркестратор', chooseFlow: 'Сценарий', goalPlaceholder: 'Чего должен добиться сценарий?', preview: 'Показать',
    noOrch: 'Сначала откройте окно оркестратора.', problems: 'Не загружено из .canvastty/flows:', recent: 'Недавние',
    approved: 'запущен', cancelledTag: 'отменён', askedBy: { orchestrator: 'предложил оркестратор', person: 'выбрали вы' }
  }
};

let t = STRINGS.en;
let view: View | null = null;
let choices: { flows: Flow[]; problems: Array<{ file: string; problem: string }> } = { flows: [], problems: [] };
let chosenOrchestrator: string | null = null;
let chosenFlow: string | null = null;
let goalDraft = '';
const root = document.querySelector('#app')!;
const status = document.querySelector('#status')!;
const say = (message: string, error = false): void => { status.textContent = message; status.classList.toggle('is-error', error); };

async function load(): Promise<void> {
  view = await host.service.request(SERVICE, 'harness.view') as View;
  const ids = view.orchestrators.map(item => item.id);
  if (view.focus.flows && ids.includes(view.focus.flows)) chosenOrchestrator ??= view.focus.flows;
  if (!chosenOrchestrator || !ids.includes(chosenOrchestrator)) chosenOrchestrator = ids[0] ?? null;
  await loadChoices();
}

async function loadChoices(): Promise<void> {
  choices = chosenOrchestrator ? await host.service.request(SERVICE, 'flows.choices', { orchestratorId: chosenOrchestrator }) as typeof choices : { flows: [], problems: [] };
  if (!chosenFlow || !choices.flows.some(flow => flow.id === chosenFlow)) chosenFlow = choices.flows[0]?.id ?? null;
  render();
}

function sourceTag(source: Plan['source']): HTMLSpanElement {
  return el('span', { className: 'tag', textContent: source === 'project' ? t.project : t.builtIn });
}

function planCard(plan: Plan): HTMLElement {
  const rows = plan.roles.map(role => el('tr', {},
    el('td', { textContent: role.title }),
    el('td', { textContent: role.provider ? `${role.provider} / ${role.model ?? t.providerDefault}${role.effort ? ` · ${role.effort}` : ''}` : t.auto }),
    el('td', { textContent: role.task })));
  const start = el('button', { type: 'button', className: 'button button--primary', textContent: t.start });
  const cancel = el('button', { type: 'button', className: 'button', textContent: t.cancel });
  const decide = (decision: 'approved' | 'cancelled'): void => {
    start.disabled = cancel.disabled = true;
    host.service.request(SERVICE, 'flows.decide', { planId: plan.id, decision })
      .then(() => { say(decision === 'approved' ? t.started : t.cancelled); return load(); })
      .catch(error => { say(errorText(error), true); start.disabled = cancel.disabled = false; });
  };
  start.addEventListener('click', () => decide('approved'));
  cancel.addEventListener('click', () => decide('cancelled'));
  return el('section', { className: 'card' },
    el('div', { className: 'row' }, el('h2', { className: 'card__title', textContent: `${t.flow}: ${plan.name}` }), sourceTag(plan.source),
      el('span', { className: 'muted', textContent: t.askedBy[plan.requestedBy] })),
    plan.description ? el('div', {}, el('span', { className: 'muted', textContent: `${t.what}: ` }), plan.description) : null,
    el('div', {}, el('span', { className: 'muted', textContent: `${t.for}: ` }), plan.orchestratorTitle),
    el('div', {}, el('span', { className: 'muted', textContent: `${t.goal}: ` }), plan.goal),
    el('table', { className: 'table' },
      el('thead', {}, el('tr', {}, el('th', { textContent: t.role }), el('th', { textContent: t.model }), el('th', { textContent: t.task }))),
      el('tbody', {}, ...rows)),
    el('p', { className: 'muted', textContent: t.unchanged }),
    el('div', { className: 'row row--end' }, cancel, start));
}

function chooser(): HTMLElement {
  if (!view!.orchestrators.length) return el('div', { className: 'empty', textContent: t.noOrch });
  const orch = el('select', { className: 'select', name: 'orchestrator' });
  for (const item of view!.orchestrators) orch.append(el('option', { value: item.id, textContent: item.title, selected: item.id === chosenOrchestrator }));
  orch.addEventListener('change', () => { chosenOrchestrator = orch.value; void loadChoices().catch(error => say(errorText(error), true)); });
  const flow = el('select', { className: 'select', name: 'flow' });
  for (const item of choices.flows) flow.append(el('option', { value: item.id, textContent: `${item.name} (${item.source === 'project' ? t.project : t.builtIn})`, selected: item.id === chosenFlow }));
  flow.addEventListener('change', () => { chosenFlow = flow.value; render(); });
  const goal = el('input', { className: 'input', name: 'goal', placeholder: t.goalPlaceholder, value: goalDraft, maxLength: 1000 });
  goal.addEventListener('input', () => { goalDraft = goal.value; });
  const preview = el('button', { type: 'button', className: 'button', textContent: t.preview });
  preview.addEventListener('click', () => {
    if (!chosenOrchestrator || !chosenFlow) return;
    host.service.request(SERVICE, 'flows.create', { orchestratorId: chosenOrchestrator, flowId: chosenFlow, goal: goalDraft })
      .then(() => { goalDraft = ''; return load(); })
      .catch(error => say(errorText(error), true));
  });
  const selected = choices.flows.find(item => item.id === chosenFlow);
  return el('section', { className: 'card' },
    el('h2', { className: 'card__title', textContent: t.yourself }),
    el('label', { className: 'field' }, el('span', { className: 'field__label', textContent: t.chooseOrch }), orch),
    el('label', { className: 'field' }, el('span', { className: 'field__label', textContent: t.chooseFlow }), flow),
    selected ? el('p', { className: 'muted', textContent: selected.description }) : null,
    el('label', { className: 'field' }, el('span', { className: 'field__label', textContent: t.goal }), goal),
    choices.problems.length ? el('p', { className: 'muted', textContent: `${t.problems} ${choices.problems.map(p => `${p.file}: ${p.problem}`).join('; ')}` }) : null,
    el('div', { className: 'row row--end' }, preview));
}

function render(): void {
  if (!view) return;
  if (!view.settings.flows) { root.replaceChildren(el('div', { className: 'empty', textContent: t.off })); return; }
  const pending = view.plans.filter(plan => plan.status === 'pending');
  const recent = view.plans.filter(plan => plan.status !== 'pending').slice(0, 5);
  root.replaceChildren(
    pending.length ? el('div', { className: 'page__lead', textContent: t.waiting }) : el('div', { className: 'empty', textContent: t.none }),
    ...pending.map(planCard),
    chooser(),
    ...(recent.length ? [el('div', { className: 'muted' }, `${t.recent}: `, recent.map(plan => `${plan.name} — ${plan.orchestratorTitle} (${plan.status === 'approved' ? t.approved : t.cancelledTag})`).join('; '))] : [])
  );
}

onContext((locale: PageLocale) => { t = STRINGS[locale]; render(); });
host.service.onEvent(({ serviceId, event, data }) => {
  if (serviceId !== SERVICE) return;
  if (event === 'focus') {
    const focus = (data as { flows?: string | null } | null)?.flows;
    if (focus) chosenOrchestrator = focus;
  }
  if (event === 'changed' || event === 'focus') whenIdle(() => { void load().catch(error => say(errorText(error), true)); });
});
load().catch(error => say(errorText(error), true));
