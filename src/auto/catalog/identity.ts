/** The exact effort vocabulary benchmark rows use; an unknown configuration stays unrated. */
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type ReasoningEffort = typeof EFFORTS[number];
export const isEffort = (value: unknown): value is ReasoningEffort => typeof value === 'string' && (EFFORTS as readonly string[]).includes(value);

/** Separator-only normalization: never drops model dates, versions or suffixes. */
export const normalizeModelIdentity = (value: string): string => value.toLowerCase().replace(/[. _]/g, '-');
