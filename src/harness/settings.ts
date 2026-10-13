/**
 * The harness page's four controls. Command review is a view of the Assistant's own settings (its mode and
 * strictness); routing, loop alerts and flows are the harness's own switches, kept in plugin storage under `harness`.
 * Shared by the service and the page: no Node APIs.
 */
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantSettings } from '../shared/settings.ts';

export type CommandReviewLevel = 'strict' | 'warn' | 'off';
export const COMMAND_REVIEW_LEVELS: readonly CommandReviewLevel[] = ['strict', 'warn', 'off'];

export interface HarnessSettings {
  /** The `route` tool answers with a provider/model suggestion; off: it says so and suggests nothing. */
  routing: boolean;
  /** A "loop?" badge when an agent repeats the same command without changing a file in between. */
  loopAlerts: boolean;
  /** The flow tools and the flow preview card. */
  flows: boolean;
}

export const DEFAULT_HARNESS_SETTINGS: Readonly<HarnessSettings> = Object.freeze({ routing: true, loopAlerts: true, flows: true });
const KEYS = Object.keys(DEFAULT_HARNESS_SETTINGS) as Array<keyof HarnessSettings>;

export function validateHarnessSettings(value: unknown): HarnessSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid harness settings.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !KEYS.includes(key as keyof HarnessSettings)) || KEYS.some(key => typeof record[key] !== 'boolean')) {
    throw new Error('Invalid harness settings.');
  }
  return { routing: record.routing as boolean, loopAlerts: record.loopAlerts as boolean, flows: record.flows as boolean };
}

/** Saved values made valid: a missing or bad key takes its default. */
export function normalizeHarnessSettings(value: unknown): HarnessSettings {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return Object.fromEntries(KEYS.map(key => [key, typeof record[key] === 'boolean' ? record[key] : DEFAULT_HARNESS_SETTINGS[key]])) as unknown as HarnessSettings;
}

/** What the page shows for the Assistant's command review. */
export function commandReviewLevel(settings: AssistantSettings): CommandReviewLevel {
  const mode = settings.enabled ? settings.modes['command.review'] : 'off';
  if (mode === 'off') return 'off';
  return mode === 'auto' ? 'strict' : 'warn';
}

/**
 * The Assistant's settings with command review set to `level`:
 * - Strict: Auto, always strict (anything but a read-only command goes to the person; without a decision model too).
 * - Warn: Suggest (hard rules still deny; a model's opinion, when one is set up, shows on the card only).
 * - Off: no command review; task triage keeps its own mode.
 */
export function withCommandReview(settings: AssistantSettings, level: CommandReviewLevel): AssistantSettings {
  const next = structuredClone(settings);
  if (level === 'off') {
    next.modes['command.review'] = 'off';
    next.enabled = next.modes['task.route'] !== 'off';
  } else {
    next.enabled = true;
    next.modes['command.review'] = level === 'strict' ? 'auto' : 'suggest';
    next.reviewStrictness = level === 'strict' ? 'strict' : 'triage';
  }
  return next;
}

/** A fresh install: command review on Warn (automatic, nothing enforced beyond the hard rules), nothing else asked. */
export function firstRunAssistantSettings(): AssistantSettings {
  return withCommandReview(structuredClone(DEFAULT_ASSISTANT_SETTINGS), 'warn');
}
