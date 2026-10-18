/**
 * A CLI's own model ids → catalog identities. A full id that the catalog knows (`gpt-5.5`, `claude-opus-4-8`) is its
 * own identity. A short alias (`opus`) moves between models over time, so it resolves only through this table,
 * which carries the date it was written; the person's own entries (settings page) win over it. An alias that
 * resolves nowhere is unscored: it is never guessed (the catalog's exact-variant rule).
 * Shared by the service and the page: no Node APIs.
 */
import { normalizeModelIdentity } from '../auto/catalog/identity.ts';
import type { AliasOverride } from './settings.ts';

/** When the bundled table was last checked against the CLIs' own documentation. */
export const ALIAS_TABLE_AS_OF = '2026-10-15';

/** cli → alias → identity (normalized). Only aliases the CLI documents; no full ids (they resolve as themselves). */
export const BUNDLED_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  claude: Object.freeze({ opus: 'claude-opus-4-8', sonnet: 'claude-sonnet-5' }),
  grok: Object.freeze({ 'grok-build': 'grok-build-0-1' })
});

export interface Resolved {
  /** The catalog identity, or null: unscored. */
  identity: string | null;
  /** Where it came from: the id itself, the person's table, the bundled table (with its date), or nothing. */
  from: 'id' | 'person' | 'bundled' | 'none';
}

/**
 * `known(identity)` says whether the catalog has rows for it. OpenCode and model-account ids are `provider/model`:
 * the part after the last `/` is the model.
 */
export function resolveModel(cli: string, model: string, overrides: readonly AliasOverride[], known: (identity: string) => boolean): Resolved {
  const bare = model.includes('/') ? model.split('/').at(-1)! : model;
  const person = overrides.find(entry => entry.cli === cli && (entry.alias === model || entry.alias === bare));
  if (person) return { identity: normalizeModelIdentity(person.identity), from: 'person' };
  const id = normalizeModelIdentity(bare);
  if (bare && known(id)) return { identity: id, from: 'id' };
  const bundled = BUNDLED_ALIASES[cli]?.[bare];
  if (bundled) return { identity: bundled, from: 'bundled' };
  return { identity: null, from: 'none' };
}
