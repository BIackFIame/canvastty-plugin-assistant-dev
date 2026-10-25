// The manifest as the core under test (CANVASTTY_REPO) accepts it. Localized keys (`name.ru`, `label.ru`,
// `title.ru`, …) need a core with localized manifest strings; CanvasTTY main (1.8.1) refuses them as unknown
// fields. Against such a core the tests use the manifest without them, and say so, so everything else is still
// checked by the core's own validator. A core that knows them gets the manifest unchanged.
import { coreAllVariant } from '../../scripts/manifest-variant.mjs';

export const LOCALIZED_KEY = /^[A-Za-z]+\.(?:ru|en|zh-CN)$/u;

export function withoutLocalizedKeys(value) {
  if (Array.isArray(value)) return value.map(withoutLocalizedKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !LOCALIZED_KEY.test(key)).map(([key, entry]) => [key, withoutLocalizedKeys(entry)]));
  return value;
}

/**
 * The Assistant's launch policy is scoped (`"policy": { "scope": "own-trees" }`: only subagent launches inside trees
 * it contributed to or started, never a launch the person starts). A core that does not know the scoped form refuses
 * it; the plugin must then declare no policy at all (phase-1 checks only), never an unscoped one that would hold every
 * launch while its service is down. That is the 1.8.x variant of the manifest, and what the tests use on such a core.
 */
export function withoutPolicy(manifest) {
  return { ...manifest, services: manifest.services.map(service => {
    if (!service.launch) return service;
    const { policy: _drop, ...launch } = service.launch;
    return { ...service, launch };
  }) };
}

/**
 * The core-all keys (shared reads `uses`, the `providers:read`, `usage:read` and `accounts:broker` permissions): an older core refuses
 * them. Every read behind them is feature-detected at run time, so the tests use the manifest without them there,
 * which is exactly how the service then runs (orchestrators' rows, ~2 % per launch).
 */
export function withoutCoreAllKeys(manifest) {
  const { uses: _uses, ...rest } = manifest;
  return { ...rest, permissions: manifest.permissions.filter(permission => permission !== 'providers:read' && permission !== 'usage:read' && permission !== 'accounts:broker') };
}

/** The manifest lists own-cards tools (the Edge build; the core-all variant has none). */
const hasOwnCards = manifest => manifest.services.some(service => (service.tools ?? []).some(tool => tool.audience === 'own-cards'));
const declaresPolicy = manifest => manifest.services.some(service => service.launch?.policy !== undefined);

/**
 * `{ manifest, localized, policy }`: localized is false when the core refused the localized keys and they were
 * dropped; policy says whether the accepted manifest declares a launch policy (false when the core refused the
 * scoped form and it was dropped, or the manifest has none: the 1.8.x variant).
 */
export function manifestForCore(validatePluginManifest, manifest) {
  let current = manifest, localized = true, policy = true, coreAll = true, ownCards = true;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      validatePluginManifest(current);
      return { manifest: current, localized, policy: policy && declaresPolicy(current), ownCards: ownCards && hasOwnCards(current) };
    } catch (error) {
      const message = String(error?.message);
      // A core without own-cards tools (C4) and launcher entries (C5): the core-all variant (scripts/manifest-variant.mjs).
      if (ownCards && /unknown field: (launcherEntry|audience)\b|between 1 and 16 items/u.test(message)) { current = coreAllVariant(current); ownCards = false; continue; }
      if (localized && /unknown field: [A-Za-z]+\.(?:ru|en|zh-CN)\b/u.test(message)) { current = withoutLocalizedKeys(current); localized = false; continue; }
      if (policy && /launch policy/iu.test(message)) { current = withoutPolicy(current); policy = false; continue; }
      if (coreAll && /unknown field: uses\b|permission[^.]*(providers:read|usage:read|accounts:broker)|(providers:read|usage:read|accounts:broker)/iu.test(message)) { current = withoutCoreAllKeys(current); coreAll = false; continue; }
      throw error;
    }
  }
  validatePluginManifest(current);
  return { manifest: current, localized, policy: policy && declaresPolicy(current), ownCards: ownCards && hasOwnCards(current) };
}
