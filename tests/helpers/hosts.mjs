// Every host a transport was asked to contact, and an assertion that model traffic never reached OpenRouter.
import assert from 'node:assert/strict';

export function recordingTransport(inner = fetch) {
  const hosts = [];
  const transport = (url, init) => { hosts.push(new URL(String(url)).hostname.toLowerCase()); return inner(url, init); };
  return { transport, hosts, assertNoOpenRouter: () => assert.ok(!hosts.some(host => host === 'openrouter.ai' || host.endsWith('.openrouter.ai') || host === 'openrouter.ai.'), `contacted: ${hosts.join(', ')}`) };
}
