import { FIELD_BOUNDS } from '../shared/catalog.ts';
import type { AssistantDecision, DataClass } from '../shared/settings.ts';
import type { AskContext, AssistantRequest } from '../engine/AssistantEngine.ts';
import type { S1Answer } from '../shared/systemOne.ts';
import type { TurnView } from '../auto/select.ts';

/**
 * Auto (Jev) autopilot, decision D3 (jev-autopilot-design.md §2): how a task splits. Jev answers the typed
 * `task.shape` set (structure and number of parts); code turns that into a plan. Below SHAPE_CONFIDENCE, or
 * without an answer, word rules decide, and an unsure large task falls back to "orchestrate, at most 3".
 */
export type Shape = 'single_step' | 'independent_parts' | 'pipeline' | 'unclear_large';
export type PartsBucket = 'one' | 'two_three' | 'four_six' | 'seven_plus';
export interface ShapeView { shape: Shape; parts: PartsBucket; from: 'jev' | 'rules'; confidence: number | null }

export const SHAPE_CONFIDENCE = 0.6;
/** Children at most per plan (core runs 8 subagents per orchestrator; the rest wait). */
export const MAX_CHILDREN = 6;
const BUCKET_COUNT: Readonly<Record<PartsBucket, number>> = { one: 1, two_three: 3, four_six: 6, seven_plus: 8 };

export async function askTaskShape(engine: { ask(request: AssistantRequest, ctx: AskContext): Promise<AssistantDecision> }, input: { task: string; dataClass: DataClass }, ctx: AskContext): Promise<ShapeView | null> {
  const request: AssistantRequest = {
    useCase: 'task.route', set: 'task.shape',
    fields: [{ name: 'task', value: input.task.trim(), dataClass: input.dataClass, disclosure: 'content', bound: FIELD_BOUNDS.task }],
    summary: 'task shape',
    map: answers => ({ outcome: `shape:${choice(answers.shape) ?? '?'}`, qualifiedOutcome: null })
  };
  const decision = await engine.ask(request, ctx);
  if (decision.fallbackReason || !decision.answers) return null;
  const shape = decision.answers.shape, parts = decision.answers.parts;
  if (shape?.type !== 'choice' || parts?.type !== 'choice') return null;
  if (shape.top < SHAPE_CONFIDENCE) return null;
  return { shape: shape.choice as Shape, parts: (parts.top >= SHAPE_CONFIDENCE ? parts.choice : 'two_three') as PartsBucket, from: 'jev', confidence: Math.round(shape.top * 1_000) / 1_000 };
}

const choice = (answer: S1Answer | undefined): string | null => answer?.type === 'choice' ? answer.choice : null;

/** Word rules: a list of items or "and then" steps. Never confident. */
export function ruleShape(task: string): ShapeView {
  const items = task.split('\n').filter(line => /^\s*(?:[-*•]|\d+[.)])\s+\S/u.test(line)).length;
  const sequence = /\b(?:then|after that|afterwards|finally|first|second)\b|затем|потом|после этого|сначала/iu.test(task);
  const many = items >= 2 ? items : (task.match(/;|\band\b|\bи\b/giu) ?? []).length + 1;
  const parts: PartsBucket = many <= 1 ? 'one' : many <= 3 ? 'two_three' : many <= 6 ? 'four_six' : 'seven_plus';
  const shape: Shape = items >= 2 ? (sequence ? 'pipeline' : 'independent_parts') : parts === 'one' ? 'single_step' : sequence ? 'pipeline' : 'single_step';
  return { shape, parts, from: 'rules', confidence: null };
}

export type PlanMode = 'solo' | 'orchestrate' | 'deep';
export interface AutopilotPlan {
  mode: PlanMode;
  /** Children the orchestrator may run (0 for solo). */
  children: number;
  /** Children that may split further (orchestrate: true), deep plans only. */
  deepChildren: number;
  strategy: 'single-cheap' | 'single-strong';
  /** USD this plan's children may spend in all (API routes; subscriptions count by window). */
  budgetUsd: number;
  why: string;
}

/**
 * D3 + D5 + D9: the shape and the turn's level → a plan. Solo for small single-step work; orchestrate N for
 * independent parts or a pipeline (N = parts, at most MAX_CHILDREN); deep (children may split once more, core's
 * depth limit is 2) only for a large task whose parts are many or not named. An unsure large task: orchestrate, ≤ 3.
 */
export function planFor(view: Pick<TurnView, 'level' | 'strong' | 'type'>, shape: ShapeView, caps: { perTaskUsd: number }): AutopilotPlan {
  const count = Math.min(MAX_CHILDREN, BUCKET_COUNT[shape.parts]);
  const strategy = view.level === 'small' ? 'single-cheap' : 'single-strong';
  const budgetUsd = caps.perTaskUsd;
  if (shape.shape === 'single_step' && view.level !== 'large') return { mode: 'solo', children: 0, deepChildren: 0, strategy, budgetUsd, why: 'one piece of work: do it yourself' };
  if (shape.shape === 'unclear_large' || shape.parts === 'seven_plus') {
    if (view.level === 'large' && shape.from === 'jev') return { mode: 'deep', children: Math.min(3, count), deepChildren: Math.min(3, count), strategy: 'single-strong', budgetUsd, why: 'large, with many or unnamed parts: split it, and let each part split once more' };
    return { mode: 'orchestrate', children: 3, deepChildren: 0, strategy, budgetUsd, why: 'large or unclear: split it into at most 3 parts' };
  }
  if (shape.shape === 'single_step') return { mode: 'orchestrate', children: 1, deepChildren: 0, strategy, budgetUsd, why: 'one large piece of work: give it to one strong subagent' };
  return { mode: 'orchestrate', children: Math.max(2, count), deepChildren: 0, strategy, budgetUsd, why: shape.shape === 'pipeline' ? 'parts in order: one subagent per step, each after the one before' : 'independent parts: one subagent per part, at the same time' };
}

/** The plan as the orchestrator reads it (English: tool answers are for agents). */
export function planText(plan: AutopilotPlan): string {
  const head = plan.mode === 'solo' ? 'Do this task yourself; start no subagent.'
    : plan.mode === 'deep' ? `Split the task into at most ${plan.children} parts; each part may split once more (route it with pick_route {orchestrate: true}).`
      : `Split the task into at most ${plan.children} part${plan.children === 1 ? '' : 's'}.`;
  const route = plan.mode === 'solo' ? '' : ' For each part call canvastty-assistant__pick_route {task, cwd} and pass its spawn values to spawn_agent unchanged; a spawn without them is refused. Then wait_for_agent, get_agent_result and route_outcome.';
  return `${head}${route} Why: ${plan.why}. Strategy: ${plan.strategy}. Budget for subagents on paid routes: $${plan.budgetUsd.toFixed(2)}.`;
}
