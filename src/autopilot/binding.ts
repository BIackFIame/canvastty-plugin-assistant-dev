import { randomBytes } from 'node:crypto';

/**
 * Auto (Jev) autopilot, binding every subagent spawn to a `pick_route` decision (jev-autopilot-design.md §3.3),
 * without a launch policy: on CanvasTTY 1.8.2 a subagent of an Auto card either inherits the Assistant's options
 * (same CLI) or must name the Assistant (another CLI, since Auto set the orchestrator's model), so its launch
 * reaches the Assistant's prepare in every case. Launches outside an Auto tree never meet these checks, and the
 * person's own launches are never refused by them.
 *
 * `pick_route` hands out one value per option in the Assistant's `model` field: `r:<id>:<target>` (an
 * `optionsFrom: "service"` field accepts any text up to 200), where the target says what the child's launch gets:
 * `off` (a subscription, coding plan or account route: nothing from the Assistant), `auto` (the Auto proxy on
 * OpenCode) or `plan:<provider>/<model>` (an OpenCode coding-plan model, pinned to that provider). Each value is
 * single-use, bound to the orchestrator that asked and the CLI the route chose, and expires after BIND_TTL_MS.
 */
export const BIND_TTL_MS = 10 * 60_000;
const MAX_BINDINGS = 512;
const VALUE = /^r:([a-z0-9]{12}):(off|auto|plan:[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,150})$/u;

export type BindTarget = 'off' | 'auto' | `plan:${string}`;
interface Binding { parent: string; provider: string; target: BindTarget; decisionId: string; orchestrate: boolean; at: number; used: boolean }

export type BindCheck =
  | { ok: true; target: BindTarget; decisionId: string; orchestrate: boolean }
  | { ok: false; reason: 'unrouted' | 'unknown' | 'used' | 'expired' | 'wrong-parent' | 'wrong-cli' | 'over-plan' };

export const isBoundValue = (value: unknown): value is string => typeof value === 'string' && VALUE.test(value);

export class Bindings {
  private readonly bindings = new Map<string, Binding>();
  /** Cards in an Auto tree: an Auto top-level card, or a routed child that may split further. */
  private readonly autoCards = new Map<string, { root: string; children: Set<string>; maxChildren: number | null }>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  /** The card was started with Model: Auto (Jev): its subagents must be routed. */
  markAuto(sessionId: string, root = sessionId): void {
    const known = this.autoCards.get(sessionId);
    this.autoCards.set(sessionId, { root, children: known?.children ?? new Set(), maxChildren: known?.maxChildren ?? null });
    while (this.autoCards.size > MAX_BINDINGS) this.autoCards.delete(this.autoCards.keys().next().value!);
  }
  isAuto(sessionId: string | null | undefined): boolean { return !!sessionId && this.autoCards.has(sessionId); }
  /** The autopilot plan's child count for this orchestrator (D3); null: no plan, only CanvasTTY's own caps. */
  setPlan(sessionId: string, children: number | null): void { const card = this.autoCards.get(sessionId); if (card) card.maxChildren = children; }
  running(sessionId: string): number { return this.autoCards.get(sessionId)?.children.size ?? 0; }

  /** A value for `pick_route`'s spawn (one per option). */
  bind(parent: string, provider: string, target: BindTarget, decisionId: string, orchestrate: boolean): string {
    const id = randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/gu, '0').slice(0, 12).padEnd(12, '0');
    this.bindings.set(id, { parent, provider, target, decisionId, orchestrate, at: this.now(), used: false });
    while (this.bindings.size > MAX_BINDINGS) this.bindings.delete(this.bindings.keys().next().value!);
    return `r:${id}:${target}`;
  }

  /**
   * A subagent launch of an Auto card. `value` is the Assistant's `model` option as it came (inherited or named).
   * Allowed once per value, for the orchestrator and CLI it was given to, within the plan's child count.
   */
  check(input: { value: unknown; parent: string; provider: string; sessionId: string }): BindCheck {
    if (!isBoundValue(input.value)) return { ok: false, reason: 'unrouted' };
    const id = VALUE.exec(input.value)![1]!;
    const binding = this.bindings.get(id);
    if (!binding) return { ok: false, reason: 'unknown' };
    if (binding.used) return { ok: false, reason: 'used' };
    if (this.now() - binding.at > BIND_TTL_MS) return { ok: false, reason: 'expired' };
    if (binding.parent !== input.parent) return { ok: false, reason: 'wrong-parent' };
    if (binding.provider !== input.provider) return { ok: false, reason: 'wrong-cli' };
    const parent = this.autoCards.get(input.parent);
    if (parent?.maxChildren !== null && parent?.maxChildren !== undefined && parent.children.size >= parent.maxChildren) return { ok: false, reason: 'over-plan' };
    binding.used = true;
    parent?.children.add(input.sessionId);
    // A child that may split further is itself an Auto card: its own subagents are routed too.
    if (binding.orchestrate) this.markAuto(input.sessionId, parent?.root ?? input.parent);
    return { ok: true, target: binding.target, decisionId: binding.decisionId, orchestrate: binding.orchestrate };
  }

  ended(sessionId: string): void {
    for (const card of this.autoCards.values()) card.children.delete(sessionId);
    this.autoCards.delete(sessionId);
  }
}
