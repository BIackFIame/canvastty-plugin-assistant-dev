import { randomBytes } from 'node:crypto';

/**
 * Auto (Jev) autopilot, binding every subagent spawn to a `pick_route` decision (jev-autopilot-design.md §3.3).
 *
 * `pick_route` hands out one value per option in the Assistant's `model` field: `r:<id>:<target>` (an
 * `optionsFrom: "service"` field accepts any text up to 200), where the target says what the child's launch gets:
 * `off` (a subscription, coding plan or account route: nothing from the Assistant), `auto` (the Auto proxy on
 * OpenCode) or `plan:<provider>/<model>` (an OpenCode coding-plan model, pinned to that provider). Each value is
 * single-use, bound to the orchestrator that asked and the CLI the route chose, and expires after BIND_TTL_MS.
 *
 * Where CanvasTTY shows a launch service what the launch asks for (`requested`: model, effort, selected plugins) and
 * the fields other plugins share with it (`peerOptions`, core B7), the check also compares those with the decision:
 * the model, the effort and the Accounts plugin's account (once Accounts shares it). Without them (older cores) the
 * check is what it was: the value, its orchestrator and its CLI.
 *
 * "Start with Auto (Jev)" (core B8) binds the top-level orchestrator the same way: `r:<id>:top:<inner>`, where the
 * inner target is `off`, `auto`, `plan:<provider>/<model>` or `own:<model>~<effort>` (the CLI's own sign-in with the
 * model and effort Jev chose; either may be empty). The inner target is in the value itself, so a restart or a
 * restore after the service restarted starts the card the same way. A subagent never launches with a top value.
 */
export const BIND_TTL_MS = 10 * 60_000;
const MAX_BINDINGS = 512;
const PLAN = 'plan:[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,150}';
const OWN = 'own:[A-Za-z0-9._:@+-]{0,120}~[a-z]{0,12}';
const VALUE = new RegExp(`^r:([a-z0-9]{12}):(off|auto|${PLAN}|top:(?:off|auto|${PLAN}|${OWN}))$`, 'u');

export type ChildTarget = 'off' | 'auto' | `plan:${string}`;
export type TopTarget = ChildTarget | `own:${string}~${string}`;
export type BindTarget = ChildTarget | `top:${TopTarget}`;

/** What a launch asks for, as CanvasTTY ≥ B7 says (`requested`, `peerOptions`). */
export interface LaunchAsk {
  requested: { model?: string; effort?: string; plugins: string[] };
  peerOptions: Record<string, Record<string, string | boolean>>;
}

/** What the decision said the launch is: model and effort (null: the CLI's default) and other plugins' options. */
export interface Expected {
  model: string | null;
  effort: string | null;
  options: Record<string, Record<string, string | boolean>>;
}

interface Binding { parent: string | null; provider: string; target: BindTarget; decisionId: string; orchestrate: boolean; at: number; used: boolean; expect: Expected | null }

export type Mismatch = 'wrong-model' | 'wrong-effort' | 'wrong-account' | 'wrong-options';
export type BindCheck =
  | { ok: true; target: BindTarget; decisionId: string; orchestrate: boolean }
  | { ok: false; reason: 'unrouted' | 'unknown' | 'used' | 'expired' | 'wrong-parent' | 'wrong-cli' | 'over-plan' | 'leaf' | Mismatch };

const ACCOUNTS_ID = 'canvastty-accounts';
const ASSISTANT_ID = 'canvastty-assistant';

export const isBoundValue = (value: unknown): value is string => typeof value === 'string' && VALUE.test(value);
export const isTopValue = (value: unknown): value is string => isBoundValue(value) && VALUE.exec(value)![2]!.startsWith('top:');
/** The target a value names (no checks). */
export const targetOf = (value: string): BindTarget => VALUE.exec(value)![2] as BindTarget;
/** `own:<model>~<effort>` → its parts (null: the CLI's default). */
export function ownChoice(target: TopTarget): { model: string | null; effort: string | null } | null {
  const match = /^own:([^~]*)~(.*)$/u.exec(target);
  return match ? { model: match[1] || null, effort: match[2] || null } : null;
}
export const ownTarget = (model: string | null, effort: string | null): TopTarget => `own:${model ?? ''}~${effort ?? ''}`;

/** A well-formed `requested` / `peerOptions` from a prepare context, or null on a core that does not send them. */
export function launchAsk(context: { requested?: unknown; peerOptions?: unknown }): LaunchAsk | null {
  const requested = context.requested;
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) return null;
  const r = requested as Record<string, unknown>;
  if (!Array.isArray(r.plugins)) return null;
  const peers: LaunchAsk['peerOptions'] = {};
  if (context.peerOptions && typeof context.peerOptions === 'object' && !Array.isArray(context.peerOptions)) {
    for (const [pluginId, values] of Object.entries(context.peerOptions as Record<string, unknown>)) {
      if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
      const kept: Record<string, string | boolean> = {};
      for (const [key, value] of Object.entries(values as Record<string, unknown>)) if (typeof value === 'string' || typeof value === 'boolean') kept[key] = value;
      peers[pluginId] = kept;
    }
  }
  return {
    requested: {
      ...(typeof r.model === 'string' ? { model: r.model } : {}),
      ...(typeof r.effort === 'string' ? { effort: r.effort } : {}),
      plugins: r.plugins.filter((id): id is string => typeof id === 'string')
    },
    peerOptions: peers
  };
}

/**
 * Whether a launch is the one the decision named. Model and effort exactly (absent = the CLI's default); every other
 * plugin the decision named still selected (Accounts' "none" may be left out: that is the CLI's own sign-in); and
 * every field a plugin shares with the Assistant equal to the decision's value. An account a launch adds that the
 * decision did not name is refused once Accounts shares it.
 */
export function mismatchOf(expect: Expected, ask: LaunchAsk): Mismatch | null {
  if ((ask.requested.model ?? null) !== expect.model) return 'wrong-model';
  if ((ask.requested.effort ?? null) !== expect.effort) return 'wrong-effort';
  const selected = new Set(ask.requested.plugins);
  const reason = (pluginId: string): Mismatch => pluginId === ACCOUNTS_ID ? 'wrong-account' : 'wrong-options';
  for (const [pluginId, values] of Object.entries(expect.options)) {
    if (pluginId === ASSISTANT_ID) continue;
    if (!selected.has(pluginId)) {
      if (pluginId === ACCOUNTS_ID && (values.account ?? 'none') === 'none') continue;
      return reason(pluginId);
    }
    const shared = ask.peerOptions[pluginId] ?? {};
    for (const [key, value] of Object.entries(shared)) if (key in values && values[key] !== value) return reason(pluginId);
  }
  for (const [pluginId, shared] of Object.entries(ask.peerOptions)) {
    if (pluginId in expect.options || pluginId === ASSISTANT_ID) continue;
    if (pluginId === ACCOUNTS_ID && typeof shared.account === 'string' && shared.account !== 'none') return 'wrong-account';
  }
  return null;
}

/** The expectation a spawn sets: its model and effort, and every plugin's options but the Assistant's own. */
export function expectedOf(spawn: { model?: string; effort?: string; launchOptions: Record<string, Record<string, string | boolean>> }): Expected {
  const options: Expected['options'] = {};
  for (const [pluginId, values] of Object.entries(spawn.launchOptions)) if (pluginId !== ASSISTANT_ID) options[pluginId] = { ...values };
  return { model: spawn.model ?? null, effort: spawn.effort ?? null, options };
}

export class Bindings {
  private readonly bindings = new Map<string, Binding>();
  /** Cards in an Auto tree: an Auto top-level card, or a routed child that may split further. */
  private readonly autoCards = new Map<string, { root: string; children: Set<string>; maxChildren: number | null }>();
  /** Routed children that were not routed to split (leaves of an Auto tree), with their orchestrator. */
  private readonly leaves = new Map<string, string>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  /** The card was started with Model: Auto (Jev): its subagents must be routed. */
  markAuto(sessionId: string, root = sessionId): void {
    const known = this.autoCards.get(sessionId);
    this.autoCards.set(sessionId, { root, children: known?.children ?? new Set(), maxChildren: known?.maxChildren ?? null });
    while (this.autoCards.size > MAX_BINDINGS) this.autoCards.delete(this.autoCards.keys().next().value!);
  }
  isAuto(sessionId: string | null | undefined): boolean { return !!sessionId && this.autoCards.has(sessionId); }
  /** A routed child of an Auto tree that was not routed to split (`orchestrate` was not asked). */
  isLeaf(sessionId: string | null | undefined): boolean { return !!sessionId && this.leaves.has(sessionId); }
  /** The autopilot plan's child count for this orchestrator (D3); null: no plan, only CanvasTTY's own caps. */
  setPlan(sessionId: string, children: number | null): void { const card = this.autoCards.get(sessionId); if (card) card.maxChildren = children; }
  running(sessionId: string): number { return this.autoCards.get(sessionId)?.children.size ?? 0; }
  /** The plan's child count for this card (null: none, or not an Auto card). */
  planned(sessionId: string): number | null { return this.autoCards.get(sessionId)?.maxChildren ?? null; }

  private id(): string { return randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/gu, '0').slice(0, 12).padEnd(12, '0'); }
  private keep(id: string, binding: Binding): void {
    this.bindings.set(id, binding);
    while (this.bindings.size > MAX_BINDINGS) this.bindings.delete(this.bindings.keys().next().value!);
  }

  /** A value for `pick_route`'s spawn (one per option). `expect`: what the spawn asks for, checked where the core says. */
  bind(parent: string, provider: string, target: ChildTarget, decisionId: string, orchestrate: boolean, expect: Expected | null = null): string {
    const id = this.id();
    this.keep(id, { parent, provider, target, decisionId, orchestrate, at: this.now(), used: false, expect });
    return `r:${id}:${target}`;
  }

  /** A value for a top-level orchestrator this plugin starts ("Start with Auto (Jev)"). */
  bindTop(provider: string, target: TopTarget, decisionId: string, expect: Expected): string {
    const id = this.id();
    this.keep(id, { parent: null, provider, target: `top:${target}`, decisionId, orchestrate: true, at: this.now(), used: false, expect });
    return `r:${id}:top:${target}`;
  }

  private find(value: string): { binding: Binding } | { reason: 'unknown' | 'used' | 'expired' } {
    const binding = this.bindings.get(VALUE.exec(value)![1]!);
    if (!binding) return { reason: 'unknown' };
    if (binding.used) return { reason: 'used' };
    if (this.now() - binding.at > BIND_TTL_MS) return { reason: 'expired' };
    return { binding };
  }

  /**
   * A subagent launch of an Auto card. `value` is the Assistant's `model` option as it came (inherited or named);
   * `ask` what the launch asks for where the core says (B7). Allowed once per value, for the orchestrator and CLI it
   * was given to, with the decision's model, effort and account, within the plan's child count.
   */
  check(input: { value: unknown; parent: string; provider: string; sessionId: string; ask?: LaunchAsk | null }): BindCheck {
    if (!isBoundValue(input.value) || isTopValue(input.value)) return { ok: false, reason: 'unrouted' };
    const found = this.find(input.value);
    if (!('binding' in found)) return { ok: false, reason: found.reason };
    const binding = found.binding;
    if (binding.parent !== input.parent) return { ok: false, reason: 'wrong-parent' };
    if (binding.provider !== input.provider) return { ok: false, reason: 'wrong-cli' };
    if (input.ask && binding.expect) {
      const mismatch = mismatchOf(binding.expect, input.ask);
      if (mismatch) return { ok: false, reason: mismatch };
    }
    const parent = this.autoCards.get(input.parent);
    if (parent?.maxChildren !== null && parent?.maxChildren !== undefined && parent.children.size >= parent.maxChildren) return { ok: false, reason: 'over-plan' };
    binding.used = true;
    parent?.children.add(input.sessionId);
    // A child that may split further is itself an Auto card: its own subagents are routed too. One that may not is a
    // leaf: where the core shows a policy every launch, its own subagents are refused.
    if (binding.orchestrate) this.markAuto(input.sessionId, parent?.root ?? input.parent);
    else {
      this.leaves.set(input.sessionId, input.parent);
      while (this.leaves.size > MAX_BINDINGS) this.leaves.delete(this.leaves.keys().next().value!);
    }
    return { ok: true, target: binding.target as ChildTarget, decisionId: binding.decisionId, orchestrate: binding.orchestrate };
  }

  /**
   * The launch of a top-level orchestrator with a top value. Not known any more (the service restarted) or already
   * used (the card is restarted): the value's own target, as for any route value outside a tree.
   */
  checkTop(input: { value: string; provider: string; ask?: LaunchAsk | null }): { ok: true; target: TopTarget; fresh: boolean } | { ok: false; reason: 'wrong-cli' | 'expired' | Mismatch } {
    const target = targetOf(input.value).slice(4) as TopTarget;
    const found = this.find(input.value);
    if (!('binding' in found)) return found.reason === 'expired' ? { ok: false, reason: 'expired' } : { ok: true, target, fresh: false };
    const binding = found.binding;
    if (binding.provider !== input.provider) return { ok: false, reason: 'wrong-cli' };
    if (input.ask && binding.expect) {
      const mismatch = mismatchOf(binding.expect, input.ask);
      if (mismatch) return { ok: false, reason: mismatch };
    }
    binding.used = true;
    return { ok: true, target, fresh: true };
  }

  ended(sessionId: string): void {
    for (const card of this.autoCards.values()) card.children.delete(sessionId);
    this.autoCards.delete(sessionId);
    this.leaves.delete(sessionId);
  }
}
