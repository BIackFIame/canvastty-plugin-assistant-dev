/** The name rule of jevOnly.ts, with no Node APIs (the pages and the shared settings use it too). */
export const JEV_ONLY_DOMAINS = ['openrouter.ai'] as const;

export function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase().replace(/\.+$/u, '').replace(/^\[|\]$/gu, ''); } catch { return null; }
}

export function modelTrafficForbidden(url: string): boolean {
  const host = hostOf(url);
  if (host === null) return true;
  return JEV_ONLY_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`));
}

