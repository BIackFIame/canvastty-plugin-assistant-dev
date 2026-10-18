import type { Host } from '../rpc.ts';

/**
 * Reading the saved settings at start. "Nothing saved" (null) and "could not read" (the host call failed) are kept
 * apart: the first is a fresh install or an update from a version that saved nothing, the second must never be taken
 * for it. On a failed read the Assistant runs with command review Off, saves nothing over the stored value, logs it,
 * and reads again later.
 */
export const STORED_KEYS = ['settings', 'harness', 'autoRouting'] as const;
export type StoredKey = typeof STORED_KEYS[number];
export type Stored = Partial<Record<StoredKey, unknown>>;

/** Delays between later reads after a failed one (the last repeats). */
export const RETRY_DELAYS_MS: readonly number[] = [2_000, 10_000, 30_000, 60_000, 300_000];

export async function readStored(host: Host, keys: readonly StoredKey[] = STORED_KEYS): Promise<{ values: Stored; failed: StoredKey[] }> {
  const values: Stored = {};
  const failed: StoredKey[] = [];
  for (const key of keys) {
    try { values[key] = await host.callHost('storage.get', { key }); } catch (error) {
      failed.push(key);
      host.log('warn', `storage.get ${key} failed (${error instanceof Error ? error.message.slice(0, 120) : 'error'}); command review stays Off and nothing is saved until it is read`);
    }
  }
  return { values, failed };
}

/** Reads the keys that failed again until they are read; `apply` gets each value once. Returns a stop function. */
export function retryStored(host: Host, failed: StoredKey[], apply: (values: Stored) => void, delays: readonly number[] = RETRY_DELAYS_MS): () => void {
  let left = [...failed];
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const next = (): void => {
    if (stopped || !left.length) return;
    timer = setTimeout(() => {
      void readStored(host, left).then(({ values, failed: still }) => {
        if (stopped) return;
        if (Object.keys(values).length) { apply(values); host.log('info', `storage read again: ${Object.keys(values).join(', ')}`); }
        left = still;
        attempt++;
        next();
      });
    }, delays[Math.min(attempt, delays.length - 1)]);
    timer.unref?.();
  };
  next();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
