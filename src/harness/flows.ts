import { randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { FLOW_LIMITS, parseFlowYaml, validateFlow, type FlowDefinition, type FlowRole } from './flowFile.ts';
import type { Locale } from './i18n.ts';
import { suggestRoute, type ProviderEntry } from './router.ts';

/**
 * Flows: a named set of roles with their tasks. The orchestrator asks for a plan (`flow_plan`), the person sees it
 * in the Flow preview card (roles, provider/model, tasks) and presses Start or Cancel, and only then does
 * `flow_status` hand the orchestrator what to pass to CanvasTTY's `spawn_agent`. Nothing is started by the plugin:
 * the subagents are the orchestrator's own, with CanvasTTY's parent, isolation and launch checks.
 */

type BuiltIn = { id: string; roles: Array<Omit<FlowRole, 'title' | 'task'> & { title: Record<Locale, string>; task: Record<Locale, string> }>; name: Record<Locale, string>; description: Record<Locale, string> };

const BUILT_IN: readonly BuiltIn[] = [
  {
    id: 'executor-reviewer',
    name: { en: 'Executor and reviewer', ru: 'Исполнитель и проверяющий' },
    description: { en: 'One agent implements, a second one reviews the diff and reports problems.', ru: 'Один агент делает работу, второй проверяет изменения и сообщает о проблемах.' },
    roles: [
      { id: 'executor', difficulty: 'normal', title: { en: 'Executor', ru: 'Исполнитель' },
        task: { en: 'Implement: {goal}. Keep the change focused and run the relevant tests.', ru: 'Сделайте: {goal}. Держите изменения узкими и запустите нужные тесты.' } },
      { id: 'reviewer', difficulty: 'hard', title: { en: 'Reviewer', ru: 'Проверяющий' },
        task: { en: 'Review the executor\'s changes for: {goal}. Report bugs and risks; change nothing.', ru: 'Проверьте изменения исполнителя для задачи: {goal}. Сообщите об ошибках и рисках; ничего не меняйте.' } }
    ]
  },
  {
    id: 'research-implement',
    name: { en: 'Research, then implement', ru: 'Разобраться, затем сделать' },
    description: { en: 'A researcher reads the code and writes a short plan; an implementer follows it.', ru: 'Исследователь читает код и пишет короткий план; исполнитель делает по нему.' },
    roles: [
      { id: 'researcher', difficulty: 'hard', title: { en: 'Researcher', ru: 'Исследователь' },
        task: { en: 'Read the code related to: {goal}. Write a short plan (files, steps, risks). Change nothing.', ru: 'Прочитайте код, связанный с задачей: {goal}. Напишите короткий план (файлы, шаги, риски). Ничего не меняйте.' } },
      { id: 'implementer', difficulty: 'normal', title: { en: 'Implementer', ru: 'Исполнитель' },
        task: { en: 'Implement the researcher\'s plan for: {goal}. Run the relevant tests.', ru: 'Выполните план исследователя для задачи: {goal}. Запустите нужные тесты.' } }
    ]
  },
  {
    id: 'test-fix',
    name: { en: 'Test first, then fix', ru: 'Сначала тест, потом исправление' },
    description: { en: 'One agent writes a failing test that shows the problem; another makes it pass.', ru: 'Один агент пишет падающий тест, который показывает проблему; другой добивается, чтобы он прошёл.' },
    roles: [
      { id: 'tester', difficulty: 'normal', title: { en: 'Tester', ru: 'Тестировщик' },
        task: { en: 'Write a test that fails because of: {goal}. Do not fix the code.', ru: 'Напишите тест, который падает из-за проблемы: {goal}. Код не исправляйте.' } },
      { id: 'fixer', difficulty: 'normal', title: { en: 'Fixer', ru: 'Исправляющий' },
        task: { en: 'Make the new test pass without weakening it: {goal}.', ru: 'Добейтесь, чтобы новый тест прошёл, не ослабляя его: {goal}.' } }
    ]
  }
];

export function builtInFlows(locale: Locale): FlowDefinition[] {
  return BUILT_IN.map(flow => ({
    id: flow.id, name: flow.name[locale], description: flow.description[locale], source: 'built-in' as const,
    roles: flow.roles.map(role => ({ ...role, title: role.title[locale], task: role.task[locale] }))
  }));
}

/** Project flows of `cwd` (never outside `<cwd>/.canvastty/flows`), plus a reason for each file that was refused. */
export function projectFlows(cwd: string | null): { flows: FlowDefinition[]; problems: Array<{ file: string; problem: string }> } {
  const flows: FlowDefinition[] = [];
  const problems: Array<{ file: string; problem: string }> = [];
  if (!cwd) return { flows, problems };
  const dir = join(cwd, '.canvastty', 'flows');
  let names: string[];
  try { names = readdirSync(dir).filter(name => /\.(json|ya?ml)$/iu.test(name)).sort().slice(0, FLOW_LIMITS.files); } catch { return { flows, problems }; }
  for (const name of names) {
    const path = join(dir, name);
    try {
      // A link could point anywhere: only plain files inside the folder are read.
      const info = lstatSync(path);
      if (!info.isFile()) { if (info.isSymbolicLink()) problems.push({ file: name, problem: 'a link is not read; copy the file here' }); continue; }
      if (info.size > FLOW_LIMITS.fileBytes) throw new Error('the file is too large');
      const text = readFileSync(path, 'utf8');
      const parsed = extname(name).toLowerCase() === '.json' ? JSON.parse(text) as unknown : parseFlowYaml(text);
      const flow = validateFlow(parsed, basename(name, extname(name)));
      if (flows.some(item => item.id === flow.id)) throw new Error(`a flow with id "${flow.id}" is already listed`);
      flows.push(flow);
    } catch (error) {
      problems.push({ file: name, problem: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
    }
  }
  return { flows, problems };
}

export interface PlannedRole {
  id: string; title: string; task: string; provider: string | null; model?: string; effort?: string; reason: string;
}

export interface FlowPlan {
  id: string;
  orchestratorId: string;
  orchestratorTitle: string;
  flowId: string;
  source: FlowDefinition['source'];
  name: string;
  description: string;
  goal: string;
  roles: PlannedRole[];
  status: 'pending' | 'approved' | 'cancelled';
  /** Who asked for it: the orchestrator (`flow_plan`) or the person (the preview card). */
  requestedBy: 'orchestrator' | 'person';
  createdAt: number;
  decidedAt: number | null;
  /** flow_status handed the approved plan to the orchestrator. */
  delivered: boolean;
}

const MAX_PLANS = 64;

export function planFlow(flow: FlowDefinition, input: { goal: string; orchestratorId: string; orchestratorTitle: string; callerProvider: string | null; providers: ProviderEntry[]; requestedBy: FlowPlan['requestedBy']; now: number; routing: boolean }): FlowPlan {
  const roles = flow.roles.map((role): PlannedRole => {
    const task = role.task.split('{goal}').join(input.goal);
    if (role.provider) {
      return { id: role.id, title: role.title, task, provider: role.provider, ...(role.model ? { model: role.model } : {}), ...(role.effort ? { effort: role.effort } : {}), reason: 'set by the flow' };
    }
    if (!input.routing) return { id: role.id, title: role.title, task, provider: null, reason: 'automatic routing is off: the orchestrator chooses' };
    const suggestion = suggestRoute({ difficulty: role.difficulty, source: 'rules', callerProvider: input.callerProvider, providers: input.providers });
    return suggestion
      ? { id: role.id, title: role.title, task, provider: suggestion.provider, ...(suggestion.model ? { model: suggestion.model } : {}), ...(suggestion.effort ? { effort: suggestion.effort } : {}), reason: `${role.difficulty} role` }
      : { id: role.id, title: role.title, task, provider: null, reason: 'no available provider was listed: the orchestrator chooses' };
  });
  return {
    id: `p${randomBytes(5).toString('hex')}`, orchestratorId: input.orchestratorId, orchestratorTitle: input.orchestratorTitle.slice(0, 120),
    flowId: flow.id, source: flow.source, name: flow.name, description: flow.description, goal: input.goal, roles,
    status: 'pending', requestedBy: input.requestedBy, createdAt: input.now, decidedAt: null, delivered: false
  };
}

/** What the orchestrator reads once the person pressed Start. */
export function approvedInstructions(plan: FlowPlan): string {
  const spawns = plan.roles.map(role => ({
    title: role.title,
    ...(role.provider ? { provider: role.provider } : {}),
    ...(role.model ? { model: role.model } : {}),
    ...(role.effort ? { effort: role.effort } : {}),
    prompt: role.task
  }));
  return [
    `The person approved flow "${plan.name}" (${plan.source === 'project' ? 'from this project' : 'built in'}) for: ${plan.goal}`,
    'Start one subagent per role with spawn_agent, passing provider, model, effort, title and prompt as listed (pick a provider yourself where none is given). Keep your usual profile and folder. The roles are already on your task board: update them with task_update as they progress.',
    JSON.stringify({ planId: plan.id, spawn: spawns })
  ].join('\n');
}

/** The plans, kept in memory and in the plugin's data folder. */
export class PlanStore {
  private plans: FlowPlan[] = [];
  private readonly save: (plans: FlowPlan[]) => void;
  private readonly waiters = new Set<() => void>();

  constructor(initial: unknown, save: (plans: FlowPlan[]) => void) {
    this.save = save;
    if (Array.isArray(initial)) this.plans = initial.filter(plan => plan && typeof plan === 'object' && typeof (plan as FlowPlan).id === 'string').slice(-MAX_PLANS) as FlowPlan[];
  }

  list(): FlowPlan[] { return structuredClone(this.plans); }
  get(id: string): FlowPlan | null { return this.plans.find(plan => plan.id === id) ?? null; }

  add(plan: FlowPlan): void {
    // One open plan per orchestrator: a newer one replaces a pending one.
    for (const other of this.plans) if (other.orchestratorId === plan.orchestratorId && other.status === 'pending') { other.status = 'cancelled'; other.decidedAt = plan.createdAt; }
    this.plans.push(plan);
    while (this.plans.length > MAX_PLANS) this.plans.shift();
    this.changed();
  }

  decide(id: string, decision: 'approved' | 'cancelled', now: number): FlowPlan {
    const plan = this.get(id);
    if (!plan) throw new Error('Unknown plan.');
    if (plan.status !== 'pending') throw new Error(plan.status === 'approved' ? 'This plan was already started.' : 'This plan was cancelled.');
    plan.status = decision;
    plan.decidedAt = now;
    this.changed();
    return structuredClone(plan);
  }

  delivered(id: string): void {
    const plan = this.get(id);
    if (plan && !plan.delivered) { plan.delivered = true; this.changed(); }
  }

  /** The newest plan of this orchestrator: the one named, else an undelivered approved one, else a pending one. */
  current(orchestratorId: string, planId?: string): FlowPlan | null {
    const own = this.plans.filter(plan => plan.orchestratorId === orchestratorId);
    if (planId) return own.find(plan => plan.id === planId) ?? null;
    return [...own].reverse().find(plan => plan.status === 'approved' && !plan.delivered)
      ?? [...own].reverse().find(plan => plan.status === 'pending') ?? null;
  }

  forgetOrchestrator(orchestratorId: string): void {
    const before = this.plans.length;
    this.plans = this.plans.filter(plan => plan.orchestratorId !== orchestratorId || plan.status === 'approved');
    if (this.plans.length !== before) this.changed();
  }

  /** Resolves on the next change or after `ms`. */
  waitForChange(ms: number): Promise<void> {
    return new Promise(resolve => {
      const done = (): void => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  private changed(): void {
    this.save(this.plans);
    for (const waiter of [...this.waiters]) waiter();
  }
}
