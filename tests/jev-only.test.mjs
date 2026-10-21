// The owner's rule: OpenRouter carries only Jev's own decision calls. Model traffic — Auto's upstreams, consensus
// drafts and judges, agent-level routes — never goes there, even with tampered settings or inventory. Offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoRouter } from '../src/auto/router.ts';
import { JevOnlyHosts, modelTrafficForbidden } from '../src/auto/jevOnly.ts';
import { normalizeAutoSettings, validateAutoSettings } from '../src/auto/settings.ts';
import { decide } from '../src/route/engine.ts';
import { accountRowsFrom, providersFrom } from '../src/route/service.ts';
import { startFakeUpstream } from './helpers/fake-upstream.mjs';
import { recordingTransport } from './helpers/hosts.mjs';
import { catalog, declared, index, NOW, providers, view } from './helpers/route-fixtures.mjs';
import { parseLimits } from '../src/route/limits.ts';
import { limitsAnswer } from './helpers/route-fixtures.mjs';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'canvastty-jev-only-')));
process.on('exit', () => rmSync(base, { recursive: true, force: true }));

test('the host rule: openrouter.ai and its subdomains in any spelling; a literal IP it resolves to; never a lookup for loopback', async () => {
  for (const url of ['https://openrouter.ai/api/v1', 'https://OpenRouter.AI./api/v1', 'https://api.openrouter.ai/v1', 'https://openrouter.ai:443/x', 'https://xn--openrouter-.ai.openrouter.ai/v1', 'not a url'])
    assert.equal(modelTrafficForbidden(url), true, url);
  for (const url of ['https://api.z.ai/api/paas/v4', 'https://openrouter.ai.example.com/v1', 'https://notopenrouter.ai/v1', 'http://127.0.0.1:9/v1']) assert.equal(modelTrafficForbidden(url), false, url);
  let lookups = 0;
  const hosts = new JevOnlyHosts({ lookup: async () => { lookups++; return ['104.18.2.115', '2606:4700::6812:273']; } });
  assert.equal(await hosts.forbidden('https://104.18.2.115/api/v1'), true, 'its address, written as an IP');
  assert.equal(await hosts.forbidden('https://1746010739/api/v1'), true, 'the same address as one number (the URL parser normalizes it)');
  assert.equal(await hosts.forbidden('https://[2606:4700::6812:273]/api/v1'), true);
  assert.equal(await hosts.forbidden('https://203.0.113.9/v1'), false);
  assert.equal(lookups, 1, 'cached');
  const quiet = new JevOnlyHosts({ lookup: async () => { throw new Error('no network in tests'); } });
  assert.equal(await quiet.forbidden('http://127.0.0.1:8080/v1'), false, 'loopback: no lookup at all');
});

function call(port, token, text = 'Write a function') {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ model: 'auto', stream: true, max_tokens: 500, messages: [{ role: 'user', content: text }] }));
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', agent: false, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': payload.length } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') })); response.on('error', reject);
    });
    req.on('error', reject); req.end(payload);
  });
}

const entry = (upstream, model, value, priceIn = 1, priceOut = 4) => ({ key: `${upstream.id}|${model}|`, upstream, model, effort: null, sendEffort: false, tier: null, listed: true, fromList: false, excluded: false,
  priceIn, priceOut, priceSource: 'person', context: 400_000, output: 32_000, known: true, measuredEfforts: [], scores: { research: { value, cohort: 'c', label: 'x', rowId: 'r', historical: false, effort: null, documentedDefault: false } }, speed: null });

async function routerWith(t, { entries, settings, extraTimeouts = {} }) {
  const fake = await startFakeUpstream({ behaviours: { 'a/strong': 'text', 'b/swift': 'text', 'c/steady': 'text', 'or/best': 'text' } });
  t.after(() => fake.close());
  // Everything on 127.0.0.1 is the fake; an OpenRouter address would be rewritten to it too — so only the recorded
  // host list can tell, and it must never name OpenRouter.
  const recorder = recordingTransport((url, init) => fetch(String(url).replace(/^https:\/\/[^/]+\/api\/v1/u, fake.url).replace(/^http:\/\/127\.0\.0\.1:\d+\/v1/u, fake.url), init));
  const router = new AutoRouter({
    directory: mkdtempSync(join(base, 'r-')), settings: () => settings, inventory: () => ({ entries, cohorts: {}, waitingForList: [] }), dataClassMode: () => 'off', key: async () => 'up-key',
    decide: async () => ({ difficulty: 'hard', strong: true, type: 'research', confidence: 0.05 }), transport: recorder.transport,
    jevOnly: new JevOnlyHosts({ lookup: async () => ['104.18.2.115'] }), noProviderMessage: () => 'NO-PROVIDER-MESSAGE',
    timeouts: { jevMs: 200, headersMs: 500, firstChunkMs: 500, idleMs: 500, memberMs: 1_000, ...extraTimeouts }
  });
  t.after(() => router.stop());
  const { token, port } = await router.grant({ sessionId: 'card-jev-only-1', provider: 'opencode', role: 'agent', parentSessionId: null, dataClass: 'D1' });
  return { router, recorder, fake, token, port };
}

test('the router refuses OpenRouter at request time, whatever the settings and inventory say: a clean failure when nothing else is allowed', async t => {
  // Tampered: an enabled OpenRouter upstream (bypassing validation), and an "OpenAI-compatible" one on its IP.
  const or = { id: 'or', preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', trust: 'D2', key: 'own', models: [], allModels: true, excluded: [], enabled: true };
  const ip = { id: 'ip', preset: 'openai-compatible', baseUrl: 'https://104.18.2.115/api/v1', trust: 'D2', key: 'own', models: [], allModels: false, excluded: [], enabled: true };
  const settings = { upstreams: [or, ip], preference: 'best', cheaperFallback: false, decider: 'jev', dailyUsdCap: 1, perCardUsdCap: 1, catalog: { autoRefresh: false, refreshHours: 168 }, strategy: { consensus: 'off', k: 3, bestOfN: false, turnUsdCap: 1 } };
  const { router, recorder, token, port } = await routerWith(t, { entries: [entry(or, 'or/best', 80), entry(ip, 'or/best', 79)], settings });
  const answer = await call(port, token);
  assert.equal(answer.status, 503);
  assert.match(answer.text, /NO-PROVIDER-MESSAGE/u, 'the localized message, pointing to the card\'s own model');
  assert.deepEqual(recorder.hosts, [], 'nothing was contacted');
  assert.equal(router.recent()[0].status, 503);
});

test('with an allowed provider too, model calls and consensus drafts and judges go only there', async t => {
  const or = { id: 'or', preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', trust: 'D2', key: 'own', models: [], allModels: true, excluded: [], enabled: true };
  const mine = { id: 'mine', preset: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', trust: 'D2', key: 'own', models: [], allModels: false, excluded: [], enabled: true };
  const mine2 = { ...mine, id: 'mine2' };
  const settings = { upstreams: [or, mine, mine2], preference: 'best', cheaperFallback: false, decider: 'jev', dailyUsdCap: 1, perCardUsdCap: 1, catalog: { autoRefresh: false, refreshHours: 168 }, strategy: { consensus: 'always', k: 3, bestOfN: false, turnUsdCap: 1 } };
  // OpenRouter's entries score best and would be drafts and the judge if they could.
  const entries = [entry(or, 'or/best', 90), entry(or, 'x/judge', 89), entry(mine, 'a/strong', 70), entry(mine2, 'b/swift', 66, 0.5, 2), entry(mine, 'c/steady', 65, 0.4, 1.6)];
  const { router, recorder, fake, token, port } = await routerWith(t, { entries, settings });
  const answer = await call(port, token);
  assert.equal(answer.status, 200);
  recorder.assertNoOpenRouter();
  assert.ok(recorder.hosts.length >= 3);
  const record = router.recent()[0];
  assert.equal(record.strategy, 'consensus');
  assert.ok(record.fanOut.drafts.every(d => d.upstream !== 'or') && record.fanOut.judge.upstream !== 'or', JSON.stringify(record.fanOut));
  assert.ok(fake.posts().every(post => !['or/best', 'x/judge'].includes(post.model)));
});

test('settings: an OpenRouter upstream cannot be on; one saved before the rule is kept, off', () => {
  const base = { preference: 'balanced', cheaperFallback: false, decider: 'jev', dailyUsdCap: 1, perCardUsdCap: 1 };
  assert.throws(() => validateAutoSettings({ ...base, upstreams: [{ id: 'or', preset: 'openrouter', trust: 'D1', key: 'own', models: [], enabled: true }] }), /only for Jev/u);
  assert.throws(() => validateAutoSettings({ ...base, upstreams: [{ id: 'x', preset: 'openai-compatible', baseUrl: 'https://eu.openrouter.ai/api/v1', trust: 'D1', key: 'own', models: [{ id: 'a/b' }], enabled: true }] }), /only for Jev/u);
  const kept = normalizeAutoSettings({ ...base, upstreams: [{ id: 'or', preset: 'openrouter', trust: 'D1', key: 'jev', models: [], enabled: true }] });
  assert.deepEqual(kept.upstreams.map(u => [u.id, u.enabled]), [['or', false]]);
});

test('agent-level routes: none whose model calls go to OpenRouter (an account on openrouter.ai, an OpenCode model under openrouter/)', () => {
  const cat = catalog();
  const rows = accountRowsFrom([
    { provider: 'claude', accountId: 'or-acct', account: 'OR', model: 'anthropic/claude-opus-4.8', endpoint: 'openrouter.ai', state: 'ready', launchOptions: { 'canvastty-accounts': { account: 'or-acct', effort: 'default', trustFolder: false } } },
    { provider: 'claude', accountId: 'or-sub', account: 'OR eu', model: 'anthropic/claude-opus-4.8', endpoint: 'https://eu.OpenRouter.ai/api', state: 'ready', launchOptions: { 'canvastty-accounts': { account: 'or-sub', effort: 'default', trustFolder: false } } }
  ]);
  const p = providersFrom(providers({ installed: ['claude', 'opencode'], known: { opencode: ['openrouter/z-ai/glm-5.3', 'zai-coding-plan/glm-5.3'] } }));
  const settings = declared({ plans: [{ id: 'oc', cli: 'opencode', kind: 'coding-plan', label: 'OC', models: ['openrouter/*', 'zai-coding-plan/*'], reserve: 20, maxParallel: 2, allow: 'allow', trust: 'D2' }] });
  const decision = decide({ view: view('coding', 'medium'), preference: 'balanced', settings, providers: p.list, providersGiven: true, accountRows: rows, callerProvider: 'claude', cardClass: 'D1', mode: 'warn',
    limits: parseLimits(limitsAnswer(), NOW), catalog: cat, index: index(cat), auto: null, now: NOW, busy: () => 0, launches: () => 0, cooldown: () => null, stats: new Map(), prefer: null, orchestrate: false,
    explore: { roll: 0.99, retired: new Set(), highRisk: false } });
  const offered = [decision.top, ...decision.groups.flat()].filter(Boolean);
  assert.ok(offered.every(c => !/openrouter/iu.test(`${c.endpoint ?? ''} ${c.model ?? ''}`)), offered.map(c => `${c.endpoint} ${c.model}`).join('; '));
  const dropped = decision.dropped.filter(d => /OpenRouter serves only Jev/u.test(d.reason));
  assert.ok(dropped.some(d => d.model === 'anthropic/claude-opus-4.8') && dropped.some(d => d.model === 'openrouter/z-ai/glm-5.3'), JSON.stringify(decision.dropped.map(d => [d.model, d.reason])));
});
