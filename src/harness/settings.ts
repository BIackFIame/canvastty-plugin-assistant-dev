/**
 * The harness page's four controls. Command review is a view of the Assistant's own settings (its mode and
 * strictness); routing, loop alerts and flows are the harness's own switches, kept in plugin storage under `harness`.
 * Shared by the service and the page: no Node APIs.
 */
import type { AssistantSettings } from '../shared/settings.ts';

/**
 * The levels the page offers. Basic rules is not "warn only": the hard rules (elevation, pipe to a shell, writes
 * outside the project…) block; anything else only shows a suggestion on the card. Anything the Assistant's own
 * settings hold that is not one of these exactly (an older version's Learning mode, Auto by the task's triage…) is
 * shown as `custom` and kept until the person picks a level.
 */
export type CommandReviewLevel = 'strict' | 'basic' | 'off';
export type CommandReviewState = CommandReviewLevel | 'custom';
export const COMMAND_REVIEW_LEVELS: readonly CommandReviewLevel[] = ['strict', 'basic', 'off'];

export interface HarnessSettings {
  /** The `route` tool answers with a provider/model suggestion; off: it says so and suggests nothing. */
  routing: boolean;
  /** A "loop?" badge when a card repeats the same command in one turn with no file edits seen in between. */
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

/** What the page shows for the Assistant's command review: exactly what its saved settings do. */
export function commandReviewLevel(settings: AssistantSettings): CommandReviewState {
  const mode = settings.enabled ? settings.modes['command.review'] : 'off';
  if (mode === 'off') return 'off';
  if (mode === 'auto' && settings.reviewStrictness === 'strict') return 'strict';
  if (mode === 'suggest' && settings.reviewStrictness === 'triage') return 'basic';
  return 'custom';
}

/**
 * The Assistant's settings with command review set to `level`:
 * - Strict: Auto, always strict (anything but a read-only command goes to the person; without a decision model too).
 * - Basic rules: Suggest (the hard rules block; a model's opinion, when one is set up, shows on the card only).
 * - Off: no command review; task triage keeps its own mode.
 * There is no first-run default here: a fresh install and an update both start Off (the person decides trust).
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
