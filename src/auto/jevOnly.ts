import { isIP } from 'node:net';

/**
 * OpenRouter carries only Jev's own decision calls (the owner's rule). Model traffic — Auto's upstreams, consensus
 * drafts and judges, agent-level routes — never goes there. `modelTrafficForbidden` checks a URL's host as the URL
 * parser normalizes it (case, a trailing dot, IDN, numeric IPv4 forms): openrouter.ai and every subdomain. The
 * router also refuses, at request time, a literal IP address that openrouter.ai resolves to (`JevOnlyHosts`), and
 * every model request is sent with redirects refused. A name that merely shares a CDN address is not refused.
 */
import { hostOf, JEV_ONLY_DOMAINS, modelTrafficForbidden } from './jevOnlyRule.ts';
export { hostOf, JEV_ONLY_DOMAINS, modelTrafficForbidden };

const PRIVATE = /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|0\.|::1$|::$|f[cd][0-9a-f]{2}:|fe80:)/iu;

type Lookup = (host: string) => Promise<string[]>;

/** The request-time check: the name rule, plus literal IPs that openrouter.ai resolves to (cached 10 min). */
export class JevOnlyHosts {
  private cache: { at: number; addresses: Set<string> } | null = null;
  private readonly lookup: Lookup | null;
  private readonly now: () => number;
  constructor(options: { lookup?: Lookup | null; now?: () => number } = {}) {
    this.lookup = options.lookup === undefined ? defaultLookup : options.lookup;
    this.now = options.now ?? Date.now;
  }
  async forbidden(url: string): Promise<boolean> {
    if (modelTrafficForbidden(url)) return true;
    const host = hostOf(url)!;
    // Only a public literal address can be OpenRouter's (a name is checked by the rule above).
    if (!isIP(host) || !this.lookup || PRIVATE.test(host)) return false;
    if (!this.cache || this.now() - this.cache.at > 600_000) {
      const addresses = new Set<string>();
      for (const domain of JEV_ONLY_DOMAINS) for (const address of await this.lookup(domain).catch(() => [] as string[])) addresses.add(address.toLowerCase());
      this.cache = { at: this.now(), addresses };
    }
    return this.cache.addresses.has(host.toLowerCase());
  }
}

const defaultLookup: Lookup = async host => {
  const { lookup } = await import('node:dns/promises');
  return (await lookup(host, { all: true })).map(entry => entry.address);
};
