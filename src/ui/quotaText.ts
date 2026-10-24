/**
 * A limit window for people: the used share and what is left, never a bare percent. CanvasTTY's windows carry the used
 * share (Codex `usedPercent`, Claude `utilization`); a lone "9%" next to a window reads as either.
 */
export type QuotaLocale = 'ru' | 'en';

/** "9% used · 91% left" / «использовано 9% · осталось 91%» (whole percents). */
export function usedLeft(locale: QuotaLocale, usedPercent: number): string {
  const used = Math.round(Math.max(0, Math.min(100, usedPercent)));
  return locale === 'ru' ? `использовано ${used}% · осталось ${100 - used}%` : `${used}% used · ${100 - used}% left`;
}
