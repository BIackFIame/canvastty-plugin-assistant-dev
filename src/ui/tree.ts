// The Agent tree card (bundled to apps/tree.js): who started whom. The root orchestrator on top, the agents it
// started below, joined by lines; each card shows its name, model, status, task, cost and time, and a click on it
// shows that card on the canvas. Read-only: the service builds the tree from session events and its own routes.
import { el, errorText, host, onContext, SERVICE, type PageLocale } from './common.ts';

type Status = 'running' | 'waiting' | 'approval' | 'done' | 'failed';
type Cost =
  | { kind: 'usd'; low: number; high: number }
  | { kind: 'plan'; label: string; share: number | null; window: string | null }
  | { kind: 'launch'; label: string; used: number; allowance: number; windowHours: number }
  | { kind: 'flat'; label: string };
interface TreeNode {
  id: string; title: string; role: string; provider: string; model: string | null; status: Status; task: string | null;
  cost: Cost | null; startedAt: number | null; endedAt: number | null; planChildren: number | null; descendants: number; children: TreeNode[];
}
interface Totals { agents: number; running: number; usd: { low: number; high: number } | null; plans: Array<{ label: string; share: number | null; window: string | null; cards: number; launches: number }>; unpriced: number }
interface View { trees: Array<{ root: TreeNode; totals: Totals }>; focus: string | null; now: number }

const PROVIDERS: Record<string, string> = {
  claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', grok: 'Grok', qwen: 'Qwen Code', kimi: 'Kimi', hermes: 'Hermes', omp: 'OMP', pi: 'Pi', terminal: 'Terminal'
};

/** Russian plural: 1 агент, 2 агента, 5 агентов. */
const ruPlural = (n: number, one: string, few: string, many: string): string => {
  const ten = n % 10, hundred = n % 100;
  return ten === 1 && hundred !== 11 ? one : ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14) ? few : many;
};
const money = (value: number): string => value === 0 ? '0' : value < 0.01 ? '<0.01' : value < 10 ? value.toFixed(2) : value.toFixed(0);
const usdText = (cost: { low: number; high: number }): string => cost.low === cost.high ? `$${money(cost.low)}` : `$${money(cost.low)}–${money(cost.high)}`;
const share = (value: number): string => value < 1 ? '<1' : String(Math.round(value));
/** Limit windows come labelled in English ("5 h", "7 d"): the Russian page says ч and д. */
const ruWindow = (label: string | null): string => (label ?? '').replace(/(\d+)\s*h\b/gu, '$1 ч').replace(/(\d+)\s*d\b/gu, '$1 д').replace(/\bweek\b/gu, 'неделя');

const STRINGS = {
  en: {
    title: 'Agent tree', tree: 'Tree',
    none: 'No agent tree yet. It appears when an orchestrator starts subagents, or when you mark an orchestrator in the card menu → Agent tree.',
    agents: (n: number) => `${n} ${n === 1 ? 'agent' : 'agents'}`, running: (n: number) => `${n} running`,
    plan: 'plan', planShare: (plan: Totals['plans'][number]) => plan.share !== null ? `${plan.label}: ≈${share(plan.share)}% of ${plan.window ?? 'the window'}` : plan.launches ? `${plan.label}: ${plan.launches} ${plan.launches === 1 ? 'launch' : 'launches'}` : `${plan.label}: plan`,
    status: { running: 'Running', waiting: 'Waiting', approval: 'Needs approval', done: 'Done', failed: 'Failed' } as Record<Status, string>,
    roles: { orchestrator: 'orchestrator', subagent: 'subagent', agent: 'agent' } as Record<string, string>,
    defaultModel: (provider: string) => `${provider}, default model`,
    cost: (cost: Cost | null): string => {
      if (!cost) return 'cost unknown';
      if (cost.kind === 'usd') return usdText(cost);
      if (cost.kind === 'plan') return cost.share === null ? 'plan' : `plan · ≈${share(cost.share)}% of ${cost.window ?? 'window'}`;
      if (cost.kind === 'launch') return `plan · 1 launch (${cost.used}/${cost.allowance} in ${cost.windowHours} h)`;
      return 'plan · flat rate';
    },
    costTip: (cost: Cost | null): string => !cost ? 'The Assistant did not route this card, so it has no estimate.' : cost.kind === 'usd' ? 'Estimated price of one task on this model.' : `Runs on ${cost.label}: a share of the plan, not money.`,
    elapsed: (ms: number): string => {
      const s = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60);
      return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
    },
    children: (n: number) => `${n} ${n === 1 ? 'agent' : 'agents'}`, planned: (n: number, of: number) => `${n} of ${of} planned`,
    expand: 'Show agents', collapse: 'Hide agents', show: (title: string) => `Show ${title} on the canvas`,
    focusOld: 'This CanvasTTY version cannot show a card from a plugin page. Find it on the canvas by its title.',
    focusFail: (why: string) => `Could not show the card: ${why}`
  },
  ru: {
    title: 'Дерево агентов', tree: 'Дерево',
    none: 'Дерева агентов пока нет. Оно появится, когда оркестратор запустит субагентов, или когда вы выберете в меню окна оркестратора «Дерево агентов».',
    agents: (n: number) => `${n} ${ruPlural(n, 'агент', 'агента', 'агентов')}`, running: (n: number) => `${n} ${ruPlural(n, 'работает', 'работают', 'работают')}`,
    plan: 'план', planShare: (plan: Totals['plans'][number]) => plan.share !== null ? `${plan.label}: ≈${share(plan.share)}% окна ${ruWindow(plan.window)}`.trimEnd() : plan.launches ? `${plan.label}: ${plan.launches} ${ruPlural(plan.launches, 'запуск', 'запуска', 'запусков')}` : `${plan.label}: план`,
    status: { running: 'Работает', waiting: 'Ждёт', approval: 'Нужно одобрение', done: 'Готово', failed: 'Ошибка' } as Record<Status, string>,
    roles: { orchestrator: 'оркестратор', subagent: 'субагент', agent: 'агент' } as Record<string, string>,
    defaultModel: (provider: string) => `${provider}, модель по умолчанию`,
    cost: (cost: Cost | null): string => {
      if (!cost) return 'цена неизвестна';
      if (cost.kind === 'usd') return usdText(cost);
      if (cost.kind === 'plan') return cost.share === null ? 'план' : `план · ≈${share(cost.share)}% окна ${ruWindow(cost.window)}`.trimEnd();
      if (cost.kind === 'launch') return `план · 1 запуск (${cost.used}/${cost.allowance} за ${cost.windowHours} ч)`;
      return 'план · без лимита по цене';
    },
    costTip: (cost: Cost | null): string => !cost ? 'Помощник не выбирал маршрут для этого окна, оценки нет.' : cost.kind === 'usd' ? 'Оценка цены одной задачи на этой модели.' : `Работает на «${cost.label}»: доля плана, а не деньги.`,
    elapsed: (ms: number): string => {
      const s = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60);
      return h ? `${h} ч ${String(m % 60).padStart(2, '0')} мин` : m ? `${m} мин ${String(s % 60).padStart(2, '0')} с` : `${s} с`;
    },
    children: (n: number) => `${n} ${ruPlural(n, 'агент', 'агента', 'агентов')}`, planned: (n: number, of: number) => `${n} из ${of} по плану`,
    expand: 'Показать агентов', collapse: 'Скрыть агентов', show: (title: string) => `Показать «${title}» на холсте`,
    focusOld: 'Эта версия CanvasTTY не умеет показывать окно со страницы плагина. Найдите его на холсте по названию.',
    focusFail: (why: string) => `Не удалось показать окно: ${why}`
  }
};

let t = STRINGS.en;
let view: View | null = null;
/** Clock skew between the service and this page: elapsed times use the service's clock. */
let offset = 0;
let chosen: string | null = null;
const collapsed = new Set<string>();
const root = document.querySelector('#app')!;
const status = document.querySelector('#status')!;
const say = (message: string, error = false): void => { status.textContent = message; status.classList.toggle('is-error', error); };

async function load(): Promise<void> {
  view = await host.service.request(SERVICE, 'tree.view') as View;
  offset = typeof view.now === 'number' ? view.now - Date.now() : 0;
  const ids = view.trees.map(tree => tree.root.id);
  // The service lists the focused card's tree first.
  if (!chosen && view.focus) chosen = ids[0] ?? null;
  if (!chosen || !ids.includes(chosen)) chosen = ids[0] ?? null;
  render();
}

const elapsedOf = (node: TreeNode): string | null => node.startedAt === null ? null : t.elapsed((node.endedAt ?? Date.now() + offset) - node.startedAt);

/** Shows the card on the canvas (sessions.focus: CanvasTTY answers only a click or key press in this card). */
async function focusCard(node: TreeNode): Promise<void> {
  if (!host.request) { say(t.focusOld, true); return; }
  try { await host.request('sessions.focus', { sessionId: node.id }); say(''); } catch (error) {
    const text = errorText(error);
    say(/Unsupported plugin method/u.test(text) ? t.focusOld : t.focusFail(text), true);
  }
}

function nodeCard(node: TreeNode): HTMLElement {
  const card = el('div', { className: `tree-node tree-node--${node.status}`, tabIndex: 0, dataset: { id: node.id } });
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', t.show(node.title));
  card.addEventListener('click', () => { void focusCard(node); });
  card.addEventListener('keydown', (event: Event) => {
    const key = (event as KeyboardEvent).key;
    if (key === 'Enter' || key === ' ') { event.preventDefault(); void focusCard(node); }
  });
  const provider = PROVIDERS[node.provider] ?? node.provider;
  const elapsed = elapsedOf(node);
  const meta: Array<HTMLElement | null> = [
    el('span', { className: `tree-cost${node.cost && node.cost.kind !== 'usd' ? ' tree-cost--plan' : ''}`, textContent: t.cost(node.cost), title: t.costTip(node.cost) }),
    elapsed ? el('span', { className: 'tree-elapsed', textContent: elapsed, dataset: { started: String(node.startedAt), ...(node.endedAt !== null ? { ended: String(node.endedAt) } : {}) } }) : null
  ];
  if (node.children.length) {
    const open = !collapsed.has(node.id);
    const toggle = el('button', { type: 'button', className: 'tree-toggle', title: open ? t.collapse : t.expand },
      el('span', { className: `tree-chevron${open ? ' is-open' : ''}` }),
      node.planChildren !== null ? t.planned(node.children.length, node.planChildren) : t.children(node.descendants));
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', `${open ? t.collapse : t.expand}: ${t.children(node.descendants)}`);
    toggle.addEventListener('click', (event: Event) => {
      event.stopPropagation();
      if (collapsed.has(node.id)) collapsed.delete(node.id); else collapsed.add(node.id);
      render();
    });
    meta.push(toggle);
  } else if (node.planChildren !== null) meta.push(el('span', { className: 'muted', textContent: t.planned(0, node.planChildren) }));
  card.append(
    el('div', { className: 'tree-node__head' },
      el('span', { className: 'tree-node__title', textContent: node.title, title: node.title }),
      el('span', { className: `pill pill--${node.status}`, textContent: t.status[node.status] })),
    el('div', { className: 'tree-node__model' },
      el('strong', { textContent: node.model ?? t.defaultModel(provider) }),
      node.model ? ` · ${provider}` : '', ` · ${t.roles[node.role] ?? node.role}`),
    ...(node.task ? [el('div', { className: 'tree-node__task', textContent: node.task, title: node.task })] : []),
    el('div', { className: 'tree-node__meta' }, ...meta));
  return card;
}

function branch(node: TreeNode): HTMLLIElement {
  const item = el('li', { className: 'tree-item' }, nodeCard(node));
  if (node.children.length && !collapsed.has(node.id)) item.append(el('ul', { className: 'tree-list' }, ...node.children.map(branch)));
  return item;
}

function summary(totals: Totals): string {
  const parts = [t.agents(totals.agents), t.running(totals.running)];
  if (totals.usd) parts.push(usdText(totals.usd));
  if (totals.plans.length) parts.push(totals.usd ? `+ ${t.plan}` : t.plan);
  return parts.join(' · ');
}

function render(): void {
  if (!view) return;
  if (!view.trees.length) { root.replaceChildren(el('div', { className: 'empty', textContent: t.none })); return; }
  const tree = view.trees.find(item => item.root.id === chosen) ?? view.trees[0]!;
  const head: Array<HTMLElement> = [];
  if (view.trees.length > 1) {
    const select = el('select', { className: 'select', name: 'tree' });
    for (const item of view.trees) select.append(el('option', { value: item.root.id, textContent: `${item.root.title} · ${t.agents(item.totals.agents)}`, selected: item.root.id === tree.root.id }));
    select.addEventListener('change', () => { chosen = select.value; render(); });
    head.push(el('label', { className: 'field tree-pick' }, el('span', { className: 'field__label', textContent: t.tree }), select));
  }
  root.replaceChildren(
    el('div', { className: 'tree-header' }, ...head,
      el('div', { className: 'tree-summary' },
        el('strong', { className: 'tree-summary__line', textContent: summary(tree.totals) }),
        ...(tree.totals.plans.length ? [el('div', { className: 'tree-summary__plans' }, ...tree.totals.plans.map(plan => el('span', { className: 'tag', textContent: t.planShare(plan) })))] : []))),
    el('ul', { className: 'tree-list tree-list--root' }, branch(tree.root)));
}

/** Elapsed times tick once a second while the card is visible; only their text changes. */
function tick(): void {
  for (const span of (root as Element).querySelectorAll?.('.tree-elapsed[data-started]') ?? []) {
    const node = span as HTMLElement;
    if (node.dataset.ended) continue;
    node.textContent = t.elapsed(Date.now() + offset - Number(node.dataset.started));
  }
}
let timer: ReturnType<typeof setInterval> | null = null;
const startTicking = (): void => { timer ??= setInterval(tick, 1_000); };
const stopTicking = (): void => { if (timer) { clearInterval(timer); timer = null; } };
host.onVisibilityChange?.(state => { if (state === 'visible') { startTicking(); tick(); } else stopTicking(); });
if (typeof setInterval === 'function') startTicking();

onContext((locale: PageLocale) => { t = STRINGS[locale]; document.title = t.title; render(); });
host.service.onEvent(({ serviceId, event, data }) => {
  if (serviceId !== SERVICE) return;
  if (event === 'focus') { const focus = (data as { tree?: string | null } | null)?.tree; if (focus) chosen = null; }
  // Tree data changes with card status, titles and new cards; there is no field to keep focus in, so reload now.
  if (event === 'changed' || event === 'focus' || event === 'board') void load().catch(error => say(errorText(error), true));
});
load().catch(error => say(errorText(error), true));
