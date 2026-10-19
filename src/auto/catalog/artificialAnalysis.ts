import { isEffort, type ReasoningEffort } from './identity.ts';
import type { CatalogBenchmark, CatalogSpeed } from './catalog.ts';

/**
 * Artificial Analysis: the public model page carries its comparison rows (each variant with its effort) as React
 * Server Component JSON. Since about 2026-10 it carries full rows only for the models of its default chart (27 on
 * 2026-10-18, against 221 in the bundled snapshot); the others load in the browser, and the page's slim list of
 * releases has no effort or sub-scores, so it is not read. The catalog therefore keeps earlier rows a partial page
 * lacks (catalog.ts, mergePartialRefresh). The page is read as text: no key, no script runs. Only measured values are kept:
 * an estimated Intelligence Index is dropped, and a variant whose reasoning setup is not an exact effort keeps that
 * label in `thinking`, which routing never scores.
 *
 * Speed: each full row carries `performanceByPromptType.medium` (AA's medium prompt, medians on the model's
 * reference endpoint): `medianOutputSpeed` (output tokens per second) and `medianTimeToFirstChunk` (seconds). They are
 * kept as the row's `speed` when the page states them; a row without them has no speed.
 */
export const ARTIFICIAL_ANALYSIS_URL = 'https://artificialanalysis.ai/models/glm-5-3';
export const ARTIFICIAL_ANALYSIS_METHODOLOGY = 'https://artificialanalysis.ai/methodology';
export const ARTIFICIAL_ANALYSIS_BYTES = 12 * 1024 * 1024;
export const AA_CATEGORIES = ['Intelligence Index', 'Terminal-Bench 4.0', 'SciCode'] as const;

const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const text = (v: unknown, max = 256): string => {
  if (typeof v !== 'string' || !v || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) throw Error('Invalid Artificial Analysis identity');
  return v;
};
const slug = (v: unknown): string => { const s = text(v); if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)) throw Error('Invalid Artificial Analysis slug'); return s; };
const points = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
const percent = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v * 100 : null;
const round = (v: number, digits: number): number => Math.round(v * 10 ** digits) / 10 ** digits;

/** The medium-prompt medians, when both are plausible numbers (output speed alone is enough; latency may be missing). */
export function speedOf(row: Record<string, unknown>): CatalogSpeed | null {
  const medium = object(object(row.performanceByPromptType)?.medium);
  const tps = medium?.medianOutputSpeed;
  if (typeof tps !== 'number' || !Number.isFinite(tps) || tps < 0.1 || tps > 100_000) return null;
  const latency = medium?.medianTimeToFirstChunk;
  return { outputTps: round(tps, 2), latencyS: typeof latency === 'number' && Number.isFinite(latency) && latency >= 0 && latency <= 3_600 ? round(latency, 3) : null };
}

export function normalizeArtificialAnalysis(html: string, fetchedAt: number): CatalogBenchmark[] {
  if (Buffer.byteLength(html) > ARTIFICIAL_ANALYSIS_BYTES) throw Error('Artificial Analysis response too large');
  const versions = new Set([...html.matchAll(/Intelligence Index\s+v(\d+(?:\.\d+){1,2})\b/g)].map(match => match[1]!));
  const indexVersion = [...versions].sort((a, b) => b.length - a.length)[0];
  if (!indexVersion || [...versions].some(version => version !== indexVersion && !indexVersion.startsWith(version + '.'))) throw Error('Artificial Analysis index version missing or ambiguous');
  const segments: string[] = [];
  for (const match of html.matchAll(/self\.__next_f\.push\((\[[\s\S]*?\])\)\s*;?\s*<\/script>/g)) {
    let segment: unknown;
    try { segment = JSON.parse(match[1]!); } catch { throw Error('Invalid Artificial Analysis page data'); }
    if (Array.isArray(segment) && segment[0] === 1 && typeof segment[1] === 'string') segments.push(segment[1]);
  }
  const pending: Array<{ value: unknown; depth: number }> = [];
  for (const line of segments.join('').split('\n')) {
    const body = line.slice(line.indexOf(':') + 1);
    if (!/^[\[{]/.test(body)) continue; // RSC import/reference/text records are not JSON data.
    try { pending.push({ value: JSON.parse(body), depth: 0 }); } catch { /* incomplete or non-JSON RSC record */ }
  }
  const rows = new Map<string, CatalogBenchmark>();
  let visited = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++visited > 500_000 || depth > 64) throw Error('Artificial Analysis page nesting too large');
    if (!value || typeof value !== 'object') continue;
    const row = object(value), release = object(row?.release);
    if (row && release && 'intelligenceIndex' in row && 'slug' in row && 'id' in row) {
      const modelSlug = slug(row.slug), modelId = slug(release.slug), id = text(row.id);
      const effortRaw = object(row.effort)?.slug;
      const suffix = typeof row.suffix === 'string' ? text(row.suffix, 128) : null;
      let reasoningEffort: ReasoningEffort | null = isEffort(effortRaw) ? effortRaw : null;
      let thinking: string | null = null;
      if (effortRaw && !reasoningEffort) thinking = text(effortRaw, 128);
      if (suffix && suffix.toLowerCase() !== reasoningEffort) {
        if (suffix === 'Non-reasoning' && row.isReasoning === false && !reasoningEffort) reasoningEffort = 'none';
        else thinking = suffix;
      }
      if (row.isReasoning === true && !reasoningEffort && !thinking) thinking = 'Reasoning configuration unspecified';
      const measured = row.intelligenceIndexIsEstimated === false ? points(row.intelligenceIndex) : null;
      const benchmark: CatalogBenchmark = {
        id: `aa:${id}`, modelId, reasoningEffort, thinking,
        categories: { 'Intelligence Index': measured, 'Terminal-Bench 4.0': percent(row.terminalBench40), SciCode: percent(row.scicode) },
        overall: measured,
        source: { kind: 'artificial-analysis', url: ARTIFICIAL_ANALYSIS_URL, releaseDate: null, fetchedAt, indexVersion, modelUrl: `https://artificialanalysis.ai/models/${modelSlug}` }
      };
      const speed = speedOf(row);
      if (speed) benchmark.speed = speed;
      const prior = rows.get(benchmark.id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(benchmark)) throw Error('Conflicting duplicate Artificial Analysis variant');
      rows.set(benchmark.id, benchmark);
      if (rows.size > 5_000) throw Error('Too many Artificial Analysis variants');
    } else {
      for (const child of Array.isArray(value) ? value : Object.values(value)) pending.push({ value: child, depth: depth + 1 });
    }
  }
  if (!rows.size || ![...rows.values()].some(row => Object.values(row.categories).some(score => score !== null))) throw Error('No measured Artificial Analysis variants');
  return [...rows.values()].reverse();
}
