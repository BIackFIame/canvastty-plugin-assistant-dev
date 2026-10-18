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

/** `{ manifest, localized }`: localized is false when the core refused the localized keys and they were dropped. */
export function manifestForCore(validatePluginManifest, manifest) {
  try {
    validatePluginManifest(manifest);
    return { manifest, localized: true };
  } catch (error) {
    if (!/unknown field: [A-Za-z]+\.(?:ru|en|zh-CN)\b/u.test(String(error?.message))) throw error;
    return { manifest: withoutLocalizedKeys(manifest), localized: false };
  }
}
