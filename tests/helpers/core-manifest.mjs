// The manifest as the core under test (CANVASTTY_REPO) accepts it. Localized keys (`name.ru`, `label.ru`,
// `title.ru`, …) need a core with localized manifest strings; CanvasTTY main (1.8.1) refuses them as unknown
// fields. Against such a core the tests use the manifest without them, and say so, so everything else is still
// checked by the core's own validator. A core that knows them gets the manifest unchanged.
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

const declaresPolicy = manifest => manifest.services.some(service => service.launch?.policy !== undefined);

/**
 * `{ manifest, localized, policy }`: localized is false when the core refused the localized keys and they were
 * dropped; policy says whether the accepted manifest declares a launch policy (false when the core refused the
 * scoped form and it was dropped, or the manifest has none: the 1.8.x variant).
 */
export function manifestForCore(validatePluginManifest, manifest) {
  let current = manifest, localized = true, policy = true;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      validatePluginManifest(current);
      return { manifest: current, localized, policy: policy && declaresPolicy(current) };
    } catch (error) {
      const message = String(error?.message);
      if (localized && /unknown field: [A-Za-z]+\.(?:ru|en|zh-CN)\b/u.test(message)) { current = withoutLocalizedKeys(current); localized = false; continue; }
      if (policy && /launch policy/iu.test(message)) { current = withoutPolicy(current); policy = false; continue; }
      throw error;
    }
  }
  validatePluginManifest(current);
  return { manifest: current, localized, policy: policy && declaresPolicy(current) };
}
