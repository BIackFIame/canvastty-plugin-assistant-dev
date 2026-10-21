/**
 * The agent tree: who started whom, built from CanvasTTY's session events (role, parent, status, start time, and the
 * launch model when the host sends it) and what the Assistant itself knows about each card: the route a subagent was
 * started on (model and what one task costs there), the task the card was given, and the autopilot plan's child
 * count. Pure: the service gathers the inputs, the Agent tree card renders the result. No folder paths, no screen
 * text, no keys.
 */
import type { Estimate } from '../route/engine.ts';

export type TreeStatus = 'running' | 'waiting' | 'approval' | 'done' | 'failed';
export const TREE_STATUSES: readonly TreeStatus[] = ['running', 'waiting', 'approval', 'done', 'failed'];

/**
 * What one card costs, as the route that started it estimated: dollars for a paid model, a share of a plan for a
 * subscription, a coding plan or a flat-rate account (never dollars: the person already paid for the plan).
 */
export type TreeCost =
  | { kind: 'usd'; low: number; high: number; measured?: boolean }
  | { kind: 'plan'; label: string; share: number | null; window: string | null; measured?: boolean }
  | { kind: 'launch'; label: string; used: number; allowance: number; windowHours: number }
  | { kind: 'flat'; label: string };

/** A card as the tree needs it (CanvasTTY's session summary; `model` only from hosts that send it). */
export interface TreeCard {
  id: string; provider: string; role: string; parentSessionId?: string; title: string; status: string;
  exitCode?: number | null; startedAt?: number; model?: string;
}

/** The route a card was started on, from the Assistant's route records. */
export interface TreeRoute { model: string | null; identity?: string | null; kind: string; label: string; costBasis: string; estimate: Estimate | null }

/**
 * A card's measured tokens (CanvasTTY's usage.session, where the core measures it): counts, the price of a paid
 * route's tokens at the catalog price (null: not a paid route or no price), their share of a plan's window, and the
 * agent's own price estimate (OpenCode's `cost`), which is an estimate, not a bill.
 */
export interface TreeUsage { tokens: number; input: number; output: number; cached: number; usd: number | null; share: number; providerEstimate?: number }

export interface TreeInputs {
  cards: readonly TreeCard[];
  route(id: string): TreeRoute | null;
  task(id: string): string | null;
  /** The autopilot plan's child count for an orchestrator (null: no plan). */
  planChildren(id: string): number | null;
  /** When a card finished (done, failed or exited), when the Assistant saw it. */
  endedAt(id: string): number | null;
  /** An Auto card on its CLI's own sign-in: the model the Assistant chose and the plan it runs on. */
  autoTop?(id: string): { model: string | null; label: string } | null;
  /** Measured usage of a card (null: not measured here). */
  usage?(id: string): TreeUsage | null;
  /** A launch that was refused and never started: left out of the agents and the plan count, counted apart. */
  refused?(id: string): boolean;
}

export interface TreeNode {
  id: string;
  title: string;
  role: string;
  provider: string;
  model: string | null;
  status: TreeStatus;
  task: string | null;
  cost: TreeCost | null;
  /** Measured tokens (null: not measured). */
  usage: TreeUsage | null;
  startedAt: number | null;
  endedAt: number | null;
  /** The autopilot plan's child count (null: none). */
  planChildren: number | null;
  /** Every card below this one (refused launches not counted). */
  descendants: number;
  /** Launches of this card's subagents that were refused and never started (not among `children`). */
  refused: number;
  children: TreeNode[];
}

export interface TreeTotals {
  /** Agents that started (refused launches are in `refused`). */
  agents: number;
  refused: number;
  running: number;
  /** Paid routes only; null when no card in the tree has a dollar estimate. */
  usd: { low: number; high: number } | null;
  /** Plan shares by plan: the sum of each task's estimated share of the plan's window. */
  plans: Array<{ label: string; share: number | null; window: string | null; cards: number; launches: number }>;
  unpriced: number;
  /** Measured tokens over the tree (null: none measured), and the agents' own price estimates (OpenCode). */
  tokens: number | null;
  providerEstimate: number | null;
}

export interface TreeView { trees: Array<{ root: TreeNode; totals: TreeTotals }> }

export const TREE_LIMITS = Object.freeze({ depth: 12, cards: 400, task: 160, title: 120 });

const oneLine = (value: string | null | undefined, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const line = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** CanvasTTY's card status (and exit code) as one of the tree's five. */
export function statusOf(card: Pick<TreeCard, 'status' | 'exitCode'>): TreeStatus {
  if (card.status === 'failed') return 'failed';
  if (card.status === 'done') return 'done';
  if (typeof card.exitCode === 'number') return card.exitCode === 0 ? 'done' : 'failed';
  if (card.status === 'exited') return 'done';
  if (card.status === 'needs_approval') return 'approval';
  if (card.status === 'working') return 'running';
  return 'waiting';
}

/** A route's estimate as the tree's cost: plans and subscriptions as a share, never as dollars. */
export function costOf(route: TreeRoute | null): TreeCost | null {
  const estimate = route?.estimate;
  if (!route || !estimate) return null;
  switch (estimate.kind) {
    case 'usd': return route.costBasis === 'plan' || route.costBasis === 'flat' ? { kind: 'flat', label: route.label } : { kind: 'usd', low: estimate.low, high: estimate.high };
    case 'window': return { kind: 'plan', label: route.label, share: Number.isFinite(estimate.share) ? estimate.share : null, window: estimate.window };
    case 'launches': return { kind: 'launch', label: route.label, used: estimate.used, allowance: estimate.allowance, windowHours: estimate.windowHours };
    case 'flat': return { kind: 'flat', label: route.label };
    default:
      // A plan whose quota is not known yet is still a plan: shown as such, without a share.
      return route.kind === 'subscription' || route.kind === 'coding-plan' || route.kind === 'cli-default' ? { kind: 'plan', label: route.label, share: null, window: null } : null;
  }
}

/**
 * The route's estimate replaced by what the card measurably used: a paid route's tokens at the catalog price, a
 * plan's window share from its tokens. Launch-counted plans and flat-rate accounts stay as they are.
 */
export function measuredCost(cost: TreeCost | null, usage: TreeUsage | null): TreeCost | null {
  if (!cost || !usage) return cost;
  if (cost.kind === 'usd' && usage.usd !== null) return { kind: 'usd', low: usage.usd, high: usage.usd, measured: true };
  if (cost.kind === 'plan') return { ...cost, share: usage.share, measured: true };
  return cost;
}

/** Model ids as people say them: "claude-opus-5-5" → "Opus 5.5", "glm-5.3-flash" → "GLM-5.3-flash", "gpt-5.4" → "GPT-5.4". */
export function modelLabel(model: string | null | undefined): string | null {
  if (typeof model !== 'string' || !model.trim()) return null;
  let id = model.trim().slice(0, 120);
  id = id.replace(/^[a-z0-9-]+\/(?=.)/iu, '').replace(/\[[^\]]*\]$/u, '');
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:[-.](\d+))?(?:-\d{8})?$/iu.exec(id);
  if (claude) return `${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1).toLowerCase()} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
  const bare = /^(opus|sonnet|haiku|fable)$/iu.exec(id);
  if (bare) return `${bare[1]![0]!.toUpperCase()}${bare[1]!.slice(1).toLowerCase()}`;
  const upper = /^(glm|gpt|qwen|kimi|grok|minimax)(?=[-\d.])/iu.exec(id);
  if (upper) {
    const name = upper[1]!.toLowerCase();
    const shown = name === 'qwen' || name === 'kimi' || name === 'grok' ? `${name[0]!.toUpperCase()}${name.slice(1)}` : name === 'minimax' ? 'MiniMax' : name.toUpperCase();
    return `${shown}${id.slice(upper[1]!.length)}`;
  }
  return id;
}

function priceKey(cost: TreeCost): string | null { return cost.kind === 'plan' || cost.kind === 'launch' || cost.kind === 'flat' ? cost.label : null; }

function totalsOf(root: TreeNode): TreeTotals {
  const totals: TreeTotals = { agents: 0, refused: 0, running: 0, usd: null, plans: [], unpriced: 0, tokens: null, providerEstimate: null };
  const plans = new Map<string, TreeTotals['plans'][number]>();
  const visit = (node: TreeNode): void => {
    totals.agents++;
    totals.refused += node.refused;
    if (node.status === 'running') totals.running++;
    if (node.usage) {
      totals.tokens = (totals.tokens ?? 0) + node.usage.tokens;
      if (node.usage.providerEstimate !== undefined) totals.providerEstimate = round((totals.providerEstimate ?? 0) + node.usage.providerEstimate);
    }
    const cost = node.cost;
    if (!cost) totals.unpriced++;
    else if (cost.kind === 'usd') totals.usd = { low: round((totals.usd?.low ?? 0) + cost.low), high: round((totals.usd?.high ?? 0) + cost.high) };
    else {
      const key = priceKey(cost)!;
      const plan = plans.get(key) ?? { label: key, share: null, window: null, cards: 0, launches: 0 };
      plan.cards++;
      if (cost.kind === 'launch') plan.launches++;
      if (cost.kind === 'plan' && cost.share !== null) { plan.share = round((plan.share ?? 0) + cost.share); plan.window ??= cost.window; }
      plans.set(key, plan);
    }
    node.children.forEach(visit);
  };
  visit(root);
  totals.plans = [...plans.values()].sort((a, b) => b.cards - a.cards || a.label.localeCompare(b.label));
  return totals;
}

const round = (value: number): number => Math.round(value * 1_000) / 1_000;

/**
 * The trees: one per card at the top of a chain of parents (an orchestrator, or a card whose parent CanvasTTY no
 * longer lists). A lone agent that started nobody is not a tree. Parents that point in a circle (a corrupt event
 * stream) are cut where the circle closes; depth and size are bounded.
 */
export function buildTree(input: TreeInputs, options: { focus?: string | null } = {}): TreeView {
  const cards = input.cards.filter(card => card && typeof card.id === 'string' && card.id).slice(0, TREE_LIMITS.cards);
  const byId = new Map(cards.map(card => [card.id, card]));
  const kids = new Map<string, TreeCard[]>();
  for (const card of cards) {
    const parent = card.parentSessionId;
    if (!parent || parent === card.id || !byId.has(parent)) continue;
    const list = kids.get(parent) ?? [];
    list.push(card);
    kids.set(parent, list);
  }
  const placed = new Set<string>();
  const node = (card: TreeCard, depth: number): TreeNode => {
    placed.add(card.id);
    const route = input.route(card.id);
    const top = input.autoTop?.(card.id) ?? null;
    const below = (kids.get(card.id) ?? []).filter(child => !placed.has(child.id));
    // A refused launch never started: not an agent of the tree, not one of the plan's parts.
    const refused = below.filter(child => input.refused?.(child.id) === true && !kids.has(child.id));
    for (const child of refused) placed.add(child.id);
    const children = depth >= TREE_LIMITS.depth ? [] : below
      .filter(child => !refused.includes(child))
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id))
      .map(child => node(child, depth + 1));
    const usage = input.usage?.(card.id) ?? null;
    const cost = measuredCost(costOf(route) ?? (top ? { kind: 'plan', label: top.label, share: null, window: null } as const : null), usage);
    return {
      id: card.id,
      title: oneLine(card.title, TREE_LIMITS.title) ?? card.id.slice(0, 8),
      role: card.role,
      provider: card.provider,
      model: modelLabel(card.model ?? route?.model ?? top?.model ?? null),
      status: statusOf(card),
      task: oneLine(input.task(card.id), TREE_LIMITS.task),
      cost,
      usage,
      startedAt: typeof card.startedAt === 'number' && Number.isFinite(card.startedAt) ? card.startedAt : null,
      endedAt: input.endedAt(card.id),
      planChildren: card.role === 'orchestrator' || children.length || refused.length ? input.planChildren(card.id) : null,
      descendants: children.reduce((sum, child) => sum + 1 + child.descendants, 0),
      refused: refused.length,
      children
    };
  };
  const isRoot = (card: TreeCard): boolean => !card.parentSessionId || card.parentSessionId === card.id || !byId.has(card.parentSessionId);
  const roots = cards.filter(card => isRoot(card) && (card.role === 'orchestrator' || kids.has(card.id)))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || a.id.localeCompare(b.id));
  const trees = roots.map(card => node(card, 0));
  // Cards whose parents form a circle have no root above them: the circle's first card becomes one.
  for (const card of cards) {
    if (placed.has(card.id) || !kids.has(card.id)) continue;
    let top = card;
    const seen = new Set<string>();
    while (top.parentSessionId && byId.has(top.parentSessionId) && !seen.has(top.id)) { seen.add(top.id); top = byId.get(top.parentSessionId)!; }
    if (!placed.has(top.id)) trees.push(node(top, 0));
  }
  const focusRoot = options.focus ? rootOf(options.focus, byId) : null;
  if (focusRoot) trees.sort((a, b) => Number(b.id === focusRoot) - Number(a.id === focusRoot));
  return { trees: trees.map(root => ({ root, totals: totalsOf(root) })) };
}

/** The top of a card's chain of parents (bounded; a circle stops where it closes). */
export function rootOf(id: string, byId: ReadonlyMap<string, Pick<TreeCard, 'id' | 'parentSessionId'>>): string | null {
  let current = byId.get(id);
  if (!current) return null;
  const seen = new Set<string>();
  while (current.parentSessionId && byId.has(current.parentSessionId) && !seen.has(current.id) && seen.size < TREE_LIMITS.cards) {
    seen.add(current.id);
    current = byId.get(current.parentSessionId)!;
  }
  return current.id;
}
