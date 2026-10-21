// The Agent tree: building it from session events (parents, status, circles, lone agents), costs from route records
// (dollars for paid routes, a plan share for subscriptions and coding plans, never dollars), totals, model labels, the
// service end to end (an Auto orchestrator and a routed child), and the bundled page in Russian and English against a
// stand-in DOM and a fake host SDK. No browser, no model, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { buildTree, costOf, modelLabel, rootOf, statusOf } from '../src/tree/agentTree.ts';
import { Assistant } from '../src/service/assistant.ts';
import { DEFAULT_ROUTE_SETTINGS } from '../src/route/settings.ts';
import { limitsAnswer } from './helpers/route-fixtures.mjs';

const root = new URL('../', import.meta.url).pathname;
const base = realpathSync(mkdtempSync(join(tmpdir(), 'canvastty-tree-')));
process.on('exit', () => rmSync(base, { recursive: true, force: true }));

const card = (id, extra = {}) => ({ id, provider: 'claude', role: 'subagent', title: id, status: 'working', exitCode: null, startedAt: 1_000, ...extra });
const inputs = (cards, extra = {}) => ({ cards, route: () => null, task: () => null, planChildren: () => null, endedAt: () => null, ...extra });

// ---------------------------------------------------------------------------------------------------------------
// Building the tree
// ---------------------------------------------------------------------------------------------------------------

test('status: CanvasTTY\'s card states and exit codes map to Running, Waiting, Needs approval, Done and Failed', () => {
  assert.equal(statusOf({ status: 'working' }), 'running');
  assert.equal(statusOf({ status: 'idle' }), 'waiting');
  assert.equal(statusOf({ status: 'unavailable' }), 'waiting');
  assert.equal(statusOf({ status: 'needs_approval' }), 'approval');
  assert.equal(statusOf({ status: 'done' }), 'done');
  assert.equal(statusOf({ status: 'failed' }), 'failed');
  assert.equal(statusOf({ status: 'working', exitCode: 0 }), 'done', 'an exit code wins over a stale status');
  assert.equal(statusOf({ status: 'idle', exitCode: 2 }), 'failed');
});

test('tree from events: the orchestrator on top, children in start order, grandchildren below; lone agents are no tree', () => {
  const cards = [
    card('lead', { role: 'orchestrator', parentSessionId: undefined, startedAt: 100, title: 'Lead' }),
    card('b', { parentSessionId: 'lead', startedAt: 300 }),
    card('a', { parentSessionId: 'lead', startedAt: 200, role: 'orchestrator' }),
    card('a1', { parentSessionId: 'a', startedAt: 400, status: 'needs_approval' }),
    card('solo', { role: 'agent', startedAt: 50 }),
    card('lone-orch', { role: 'orchestrator', startedAt: 10 })
  ];
  const view = buildTree(inputs(cards));
  assert.deepEqual(view.trees.map(tree => tree.root.id), ['lead', 'lone-orch'], 'newest first; an agent that started nobody is not a tree');
  const lead = view.trees[0].root;
  assert.deepEqual(lead.children.map(child => child.id), ['a', 'b']);
  assert.deepEqual(lead.children[0].children.map(child => child.id), ['a1']);
  assert.equal(lead.descendants, 3);
  assert.equal(lead.children[0].children[0].status, 'approval');
  assert.equal(view.trees[0].totals.agents, 4);
  assert.equal(view.trees[0].totals.running, 3);
  // A child whose parent CanvasTTY no longer lists heads its own tree.
  const orphan = buildTree(inputs([card('kid', { parentSessionId: 'closed' }), card('grand', { parentSessionId: 'kid' })]));
  assert.deepEqual(orphan.trees.map(tree => tree.root.id), ['kid']);
  // The focused card's tree comes first, also when a child is focused.
  assert.equal(buildTree(inputs(cards), { focus: 'lone-orch' }).trees[0].root.id, 'lone-orch');
  assert.equal(buildTree(inputs(cards), { focus: 'a1' }).trees[0].root.id, 'lead');
  assert.equal(rootOf('a1', new Map(cards.map(item => [item.id, item]))), 'lead');
});

test('parents in a circle, self-parents and deep chains do not loop or overflow', () => {
  const circle = buildTree(inputs([card('x', { parentSessionId: 'y' }), card('y', { parentSessionId: 'x' }), card('self', { parentSessionId: 'self', role: 'orchestrator' })]));
  assert.ok(circle.trees.some(tree => tree.root.id === 'self'), 'a card that names itself as parent is a root');
  assert.equal(circle.trees.length, 2, 'the circle x↔y becomes one tree');
  const seen = [];
  const walk = node => { seen.push(node.id); node.children.forEach(walk); };
  circle.trees.forEach(tree => walk(tree.root));
  assert.equal(new Set(seen).size, seen.length, 'every card at most once');
  assert.ok(seen.includes('x') && seen.includes('y') && seen.includes('self'));
  const chain = Array.from({ length: 40 }, (_, i) => card(`c${i}`, { parentSessionId: i ? `c${i - 1}` : undefined, role: i ? 'subagent' : 'orchestrator' }));
  let depth = 0;
  for (let node = buildTree(inputs(chain)).trees[0].root; node.children.length; node = node.children[0]) depth++;
  assert.equal(depth, 12, 'depth is bounded');
});

test('text from cards is one line, bounded; a title falls back to the id', () => {
  const view = buildTree(inputs([card('lead-123456789', { role: 'orchestrator', title: '  ' }), card('k', { parentSessionId: 'lead-123456789', title: 'Fix\nthe cache' })],
    { task: id => id === 'k' ? `Rewrite the cache layer\n\nthen ${'x'.repeat(400)}` : null }));
  const lead = view.trees[0].root;
  assert.equal(lead.title, 'lead-123');
  assert.equal(lead.children[0].title, 'Fix the cache');
  assert.ok(lead.children[0].task.length <= 160 && lead.children[0].task.endsWith('…'));
  assert.doesNotMatch(lead.children[0].task, /\n/u);
});

// ---------------------------------------------------------------------------------------------------------------
// Costs and models
// ---------------------------------------------------------------------------------------------------------------

test('costs: paid routes in dollars; subscriptions, coding plans and flat-rate accounts as a plan, never dollars', () => {
  const route = (estimate, extra = {}) => ({ model: 'm', kind: 'account', label: 'L', costBasis: 'api', estimate, ...extra });
  assert.deepEqual(costOf(route({ kind: 'usd', low: 0.1, high: 0.3 })), { kind: 'usd', low: 0.1, high: 0.3 });
  assert.deepEqual(costOf(route({ kind: 'window', share: 4.5, window: '5 h', usedPercent: 30 }, { kind: 'subscription', label: 'Claude Max', costBasis: 'shadow' })),
    { kind: 'plan', label: 'Claude Max', share: 4.5, window: '5 h' });
  assert.deepEqual(costOf(route({ kind: 'launches', used: 3, allowance: 100, windowHours: 5 }, { kind: 'coding-plan', label: 'GLM Coding Plan', costBasis: 'plan' })),
    { kind: 'launch', label: 'GLM Coding Plan', used: 3, allowance: 100, windowHours: 5 });
  assert.deepEqual(costOf(route({ kind: 'flat' }, { costBasis: 'flat' })), { kind: 'flat', label: 'L' });
  assert.deepEqual(costOf(route({ kind: 'usd', low: 0, high: 0 }, { costBasis: 'plan' })), { kind: 'flat', label: 'L' }, 'a plan priced at $0 is still a plan');
  assert.deepEqual(costOf(route({ kind: 'unknown', note: 'quota unknown' }, { kind: 'subscription', label: 'Pro' })), { kind: 'plan', label: 'Pro', share: null, window: null });
  assert.equal(costOf(route({ kind: 'unknown', note: 'no price known' })), null);
  assert.equal(costOf(null), null);
});

test('totals: dollars add up, plan shares add up per plan, unrouted cards are counted as unpriced', () => {
  const routes = {
    a: { model: 'claude-opus-5-5', kind: 'subscription', label: 'Claude Max', costBasis: 'shadow', estimate: { kind: 'window', share: 4, window: '5 h', usedPercent: 10 } },
    b: { model: 'claude-sonnet-5', kind: 'subscription', label: 'Claude Max', costBasis: 'shadow', estimate: { kind: 'window', share: 2.5, window: '5 h', usedPercent: 10 } },
    c: { model: 'openai/gpt-5.4', kind: 'account', label: 'OpenRouter', costBasis: 'api', estimate: { kind: 'usd', low: 0.12, high: 0.4 } },
    d: { model: 'deepseek-v4', kind: 'account', label: 'DeepSeek', costBasis: 'api', estimate: { kind: 'usd', low: 0.01, high: 0.05 } },
    e: { model: 'zai-coding-plan/glm-5.3-flash', kind: 'coding-plan', label: 'GLM Coding Plan', costBasis: 'plan', estimate: { kind: 'launches', used: 7, allowance: 100, windowHours: 5 } }
  };
  const cards = [card('lead', { role: 'orchestrator' }), ...Object.keys(routes).map(id => card(id, { parentSessionId: 'lead' }))];
  const { totals, root: lead } = buildTree(inputs(cards, { route: id => routes[id] ?? null })).trees[0];
  assert.deepEqual(totals.usd, { low: 0.13, high: 0.45 });
  assert.deepEqual(totals.plans, [
    { label: 'Claude Max', share: 6.5, window: '5 h', cards: 2, launches: 0 },
    { label: 'GLM Coding Plan', share: null, window: null, cards: 1, launches: 1 }
  ]);
  assert.equal(totals.unpriced, 1, 'the orchestrator itself was not routed');
  assert.deepEqual(lead.children.map(child => child.model), ['Opus 5.5', 'Sonnet 5', 'GPT-5.4', 'deepseek-v4', 'GLM-5.3-flash']);
  // Only plans: no dollar total at all.
  const plansOnly = buildTree(inputs(cards.slice(0, 3), { route: id => routes[id] ?? null })).trees[0].totals;
  assert.equal(plansOnly.usd, null);
});

test('model labels: the names people use; the launch model from CanvasTTY wins over the route; Auto cards show the chosen model and plan', () => {
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelLabel('anthropic/claude-sonnet-4-6-20260101'), 'Sonnet 4.6');
  assert.equal(modelLabel('opus'), 'Opus');
  assert.equal(modelLabel('zai-coding-plan/glm-5.3-flash'), 'GLM-5.3-flash');
  assert.equal(modelLabel('gpt-5.5'), 'GPT-5.5');
  assert.equal(modelLabel('qwen3-coder'), 'Qwen3-coder');
  assert.equal(modelLabel('kimi-k3'), 'Kimi-k3');
  assert.equal(modelLabel(''), null);
  const view = buildTree(inputs([card('lead', { role: 'orchestrator', model: 'claude-opus-5-5' }), card('k', { parentSessionId: 'lead', model: 'gpt-5.5' })], {
    route: id => id === 'k' ? { model: 'other', kind: 'subscription', label: 'Pro', costBasis: 'shadow', estimate: null } : null,
    autoTop: id => id === 'lead' ? { model: 'sonnet', label: 'Claude Max' } : null
  })).trees[0].root;
  assert.equal(view.model, 'Opus 5.5', 'what CanvasTTY says the card was launched with');
  assert.deepEqual(view.cost, { kind: 'plan', label: 'Claude Max', share: null, window: null }, 'an Auto card on its own sign-in runs on a plan');
  assert.equal(view.children[0].model, 'GPT-5.5');
});

// ---------------------------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------------------------

const routing = () => ({ ...structuredClone(DEFAULT_ROUTE_SETTINGS), plans: [
  { id: 'claude-max', cli: 'claude', kind: 'subscription', label: 'Max', models: ['opus', 'sonnet'], reserve: 20, maxParallel: 2, allow: 'allow', trust: 'D2' },
  { id: 'codex-pro', cli: 'codex', kind: 'subscription', label: 'Pro', models: ['gpt-5.5'], reserve: 20, maxParallel: 2, allow: 'allow', trust: 'D2' },
  { id: 'glm-plan', cli: 'opencode', kind: 'coding-plan', label: 'GLM Coding Plan', models: ['zai-coding-plan/*'], reserve: 20, maxParallel: 2, allowance: 100, windowHours: 5, allow: 'allow', trust: 'D2' }
] });
const providers = [
  { id: 'claude', installed: true, available: true, signIn: 'ok', subagent: true, orchestrator: true, efforts: ['low', 'medium', 'high'], launchPlugins: ['canvastty-assistant'] },
  { id: 'codex', installed: true, available: true, signIn: 'ok', subagent: true, orchestrator: true, efforts: ['low', 'medium', 'high'], launchPlugins: ['canvastty-assistant'] },
  { id: 'opencode', installed: true, available: true, signIn: 'ok', subagent: true, orchestrator: true, model: { supported: true, known: ['zai-coding-plan/glm-5.3', 'zai-coding-plan/glm-5.3-flash'] }, launchPlugins: ['canvastty-assistant'] }
];

test('service: an Auto orchestrator and its routed child become a tree with model, task, plan cost and finish time; closing removes them', async () => {
  const emitted = [];
  const host = { callHost: async () => null, log() {}, emit: (event, data) => emitted.push({ event, data }) };
  const cwd = join(base, 'p'); mkdirSync(cwd, { recursive: true });
  let now = Date.now();
  const assistant = new Assistant({ host, dataDir: mkdtempSync(join(base, 'data-')), git: null, locale: 'en', routing: routing(), harness: { routing: true, loopAlerts: true, flows: true }, now: () => now });
  assistant.routing.receiveLimits(limitsAnswer({ now }));
  await assistant.launch({ sessionId: 'orch-0001', provider: 'claude', profile: 'normal', role: 'orchestrator', cwd, restoring: false, resume: false, options: { task: 'Ship the agent tree', dataClass: 'default', model: 'auto' }, chosen: true, environment: null });
  const lead = { id: 'orch-0001', provider: 'claude', role: 'orchestrator', title: 'Lead', status: 'working', exitCode: null, startedAt: now - 60_000, cwd, workingDirectory: cwd };
  assistant.sessionEvent({ type: 'created', session: lead });
  const answer = await assistant.tool('pick_route', lead, { task: 'Write the README section', providers, cwd });
  const spawn = JSON.parse(String(answer.content).split('\n').at(-1)).spawn;
  await assistant.launch({ sessionId: 'kid-00001', provider: spawn.provider, profile: 'normal', role: 'subagent', parentSessionId: 'orch-0001', cwd, restoring: false, resume: false, options: { task: 'Write the README section', dataClass: 'default', model: spawn.launchOptions['canvastty-assistant']?.model ?? 'off' }, chosen: true, environment: null });
  assistant.sessionEvent({ type: 'created', session: { id: 'kid-00001', provider: spawn.provider, role: 'subagent', parentSessionId: 'orch-0001', title: 'Docs', status: 'working', exitCode: null, startedAt: now, cwd, workingDirectory: cwd } });
  assert.ok(emitted.some(entry => entry.event === 'changed'), 'an open tree reloads on new cards');

  let view = assistant.treeView();
  assert.equal(view.trees.length, 1);
  const top = view.trees[0].root;
  assert.equal(top.task, 'Ship the agent tree');
  assert.equal(top.cost?.kind, 'plan', 'the Auto card runs on its own sign-in: a plan');
  const kid = top.children[0];
  assert.equal(kid.id, 'kid-00001');
  assert.equal(kid.task, 'Write the README section');
  assert.ok(kid.model, 'the routed model');
  assert.ok(kid.cost && kid.cost.kind !== 'usd', `a plan route is never dollars: ${JSON.stringify(kid.cost)}`);
  assert.equal(view.trees[0].totals.usd, null);
  assert.equal(view.trees[0].totals.running, 2);
  assert.equal(JSON.stringify(view).includes(cwd), false, 'no folder paths reach the page');

  // The child finishes: done, with the time it ended; then its card closes.
  now += 90_000;
  assistant.sessionEvent({ type: 'exited', session: { id: 'kid-00001', provider: spawn.provider, role: 'subagent', parentSessionId: 'orch-0001', title: 'Docs', status: 'idle', exitCode: 0, startedAt: now - 90_000, cwd, workingDirectory: cwd } });
  view = assistant.treeView();
  assert.equal(view.trees[0].root.children[0].status, 'done');
  assert.equal(view.trees[0].root.children[0].endedAt, now);
  // The card action points an open tree at this card.
  const toast = assistant.harness.cardAction('agent-tree', 'kid-00001', undefined);
  assert.match(toast.message, /Agent tree now shows "Docs"/u);
  assert.equal(assistant.treeView().focus, 'kid-00001');
  assert.ok(emitted.some(entry => entry.event === 'focus' && entry.data.tree === 'kid-00001'));
  assistant.sessionEvent({ type: 'closed', session: { id: 'kid-00001', role: 'subagent' } });
  assistant.sessionEvent({ type: 'closed', session: { id: 'orch-0001', role: 'orchestrator' } });
  assert.deepEqual(assistant.treeView().trees, []);
  await assistant.harness.flushWrites();
});

test('manifest: the Agent tree page, its card action and sessions:read (for showing a card) are declared and stamped', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'canvastty.plugin.json'), 'utf8'));
  assert.ok(manifest.permissions.includes('sessions:read'));
  const page = manifest.contributions.find(item => item.id === 'tree');
  assert.equal(page.kind, 'canvas-app');
  assert.equal(page['title.ru'], 'Дерево агентов');
  const action = manifest.services[0].cardActions.find(item => item.id === 'agent-tree');
  assert.deepEqual(action.when.roles, ['orchestrator', 'subagent']);
  assert.ok(manifest.services[0].cardActions.length <= 8);
  for (const path of ['apps/tree.html', 'apps/tree.js']) {
    const entry = manifest.coreFiles.find(file => file.path === path);
    assert.equal(entry.bytes, readFileSync(join(root, path)).length, `${path} is stamped`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------------------------

class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {}; this.textContent = ''; this.parent = null; this.className = ''; this.props = {}; this.style = { setProperty: (name, value) => { this.props[name] = value; } }; }
  append(...nodes) { for (const node of nodes) { const child = typeof node === 'string' ? Object.assign(new Node('#text'), { textContent: node }) : node; child.parent = this; this.children.push(child); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  closest() { return null; }
  get classList() { const self = this; return { toggle(name, on) { const set = new Set(self.className.split(' ').filter(Boolean)); if (on) set.add(name); else set.delete(name); self.className = [...set].join(' '); } }; }
  click() { for (const listener of this.listeners.click ?? []) listener({ stopPropagation() {}, preventDefault() {} }); }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
  text() { return [this.textContent, ...this.children.map(child => child.text())].filter(Boolean).join(' ').replace(/\s+/gu, ' '); }
}

function page(view, { focus } = {}) {
  const app = Object.assign(new Node('main'), { id: 'app' });
  const status = Object.assign(new Node('output'), { id: 'status' });
  const html = new Node('html');
  const requests = [];
  let context = null;
  const sdk = {
    onContext(listener) { context = listener; },
    service: { async request(serviceId, method) { requests.push({ serviceId, method }); return structuredClone(view); }, onEvent() {} },
    ...(focus ? { request: async (method, params) => { requests.push({ method, params }); return focus(method, params); } } : {})
  };
  const document = { documentElement: html, activeElement: null, title: '', createElement: tag => new Node(tag), querySelector: selector => selector === '#app' ? app : status };
  vm.runInNewContext(readFileSync(join(root, 'apps/tree.js'), 'utf8'), { window: { CanvasTTYPlugin: sdk }, document, console, setTimeout, clearTimeout, structuredClone, URL, Date });
  return { app, status, html, document, requests, context: (locale, palette, extra = {}) => context({ appearance: { locale, palette, ...extra } }) };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

function sampleView() {
  const routes = {
    a: { model: 'claude-opus-5-5', kind: 'subscription', label: 'Claude Max', costBasis: 'shadow', estimate: { kind: 'window', share: 4, window: '5 h', usedPercent: 10 } },
    b: { model: 'zai-coding-plan/glm-5.3-flash', kind: 'coding-plan', label: 'GLM Coding Plan', costBasis: 'plan', estimate: { kind: 'launches', used: 7, allowance: 100, windowHours: 5 } },
    c: { model: 'openai/gpt-5.4', kind: 'account', label: 'OpenRouter', costBasis: 'api', estimate: { kind: 'usd', low: 0.12, high: 0.4 } }
  };
  const now = 10_000_000;
  const cards = [
    card('lead', { role: 'orchestrator', title: 'Release lead', startedAt: now - 3_720_000, model: 'claude-opus-5-5' }),
    card('a', { parentSessionId: 'lead', title: 'API docs', startedAt: now - 300_000 }),
    card('b', { parentSessionId: 'lead', title: 'Tests', status: 'needs_approval', startedAt: now - 200_000 }),
    card('c', { parentSessionId: 'lead', title: 'Bench', status: 'idle', exitCode: 1, startedAt: now - 100_000 }),
    card('b1', { parentSessionId: 'b', title: 'Fixtures', status: 'idle', startedAt: now - 50_000 })
  ];
  return { ...buildTree(inputs(cards, { route: id => routes[id] ?? null, task: id => ({ a: 'Document the plugin API', b: 'Cover the tree builder' })[id] ?? null, planChildren: id => id === 'lead' ? 4 : null, endedAt: id => id === 'c' ? now - 40_000 : null })), focus: null, now };
}

test('page: the header, statuses, models, costs and times in English and Russian; plans as a share, never dollars', async () => {
  const ui = page(sampleView());
  await settle();
  ui.context('en', 'sage', { uiScale: 0.85 });
  assert.equal(ui.html.lang, 'en');
  assert.equal(ui.html.props['--ui-scale'], '0.85');
  const en = ui.app.text();
  assert.match(en, /5 agents · 2 running · \$0\.12–0\.40 · \+ plan/u);
  assert.match(en, /Claude Max: ≈4% of 5 h/u);
  assert.match(en, /GLM Coding Plan: 1 launch\b/u);
  assert.match(en, /Release lead Running Opus 5\.5 · Claude Code · orchestrator/u);
  assert.match(en, /API docs Running Opus 5\.5 · Claude Code · subagent Document the plugin API plan · ≈4% of 5 h/u);
  assert.match(en, /Tests Needs approval GLM-5\.3-flash/u);
  assert.match(en, /plan · 1 launch \(7\/100 in 5 h\)/u);
  assert.match(en, /Bench Failed GPT-5\.4 .* \$0\.12–0\.40 1m 00s/u, 'a finished card keeps its time');
  assert.match(en, /Fixtures Waiting Claude Code, default model · Claude Code · subagent|Fixtures Waiting Claude Code, default model/u);
  assert.match(en, /1h 02m/u);
  assert.match(en, /3 of 4 planned/u);
  assert.doesNotMatch(en.replace(/\$0\.12–0\.40/gu, ''), /\$/u, 'only the paid route shows dollars');
  ui.context('ru', 'night', { uiScale: 1.25 });
  assert.equal(ui.html.dataset.palette, 'night');
  const ru = ui.app.text();
  assert.match(ru, /5 агентов · 2 работают · \$0\.12–0\.40 · \+ план/u);
  assert.match(ru, /Claude Max: ≈4% окна 5 ч/u);
  assert.match(ru, /GLM Coding Plan: 1 запуск /u);
  assert.match(ru, /Release lead Работает Opus 5\.5 · Claude Code · оркестратор/u);
  assert.match(ru, /Нужно одобрение/u);
  assert.match(ru, /Ошибка/u);
  assert.match(ru, /Ждёт Claude Code, модель по умолчанию/u);
  assert.match(ru, /план · 1 запуск \(7\/100 за 5 ч\)/u);
  assert.match(ru, /1 ч 02 мин/u);
  assert.match(ru, /3 из 4 по плану/u);
  // No English words left in the Russian page apart from names, models and plan labels.
  const latin = new Set((ru.match(/[A-Za-z][A-Za-z-]{2,}/gu) ?? []));
  for (const word of ['Release', 'lead', 'API', 'docs', 'Tests', 'Bench', 'Fixtures', 'Opus', 'Claude', 'Code', 'GLM', 'GLM-', 'GPT-', 'Max', 'Coding', 'Plan', 'Document', 'the', 'plugin', 'Cover', 'tree', 'builder', 'flash']) latin.delete(word);
  assert.deepEqual([...latin], [], 'Russian text has no English words of its own');
});

test('page: collapsing a branch hides its agents; a click shows the card through sessions.focus; an old host gets a plain hint', async () => {
  const focused = [];
  const ui = page(sampleView(), { focus: (method, params) => { focused.push(params.sessionId); return null; } });
  await settle();
  ui.context('en', 'sage');
  const nodes = () => ui.app.all().filter(node => (node.className ?? '').startsWith('tree-node tree-node--'));
  assert.equal(nodes().length, 5);
  const toggle = ui.app.all().find(node => node.className === 'tree-toggle' && node.attributes['aria-expanded'] === 'true' && /1 agent$/u.test(node.text()));
  toggle.click();
  await settle();
  assert.equal(nodes().length, 4, 'the Tests branch is collapsed');
  assert.equal(ui.app.all().find(node => node.className === 'tree-toggle' && /1 agent$/u.test(node.text())).attributes['aria-expanded'], 'false');
  nodes().find(node => node.dataset.id === 'c').click();
  await settle();
  assert.deepEqual(focused, ['c']);
  assert.ok(ui.requests.some(request => request.method === 'sessions.focus'));

  const old = page(sampleView(), { focus: () => { throw new Error('Unsupported plugin method: sessions.focus.'); } });
  await settle();
  old.context('ru', 'sage');
  old.app.all().find(node => node.dataset?.id === 'a').click();
  await settle();
  assert.match(old.status.textContent, /Эта версия CanvasTTY не умеет показывать окно/u);
  const none = page(sampleView());
  await settle();
  none.context('en', 'sage');
  none.app.all().find(node => node.dataset?.id === 'a').click();
  await settle();
  assert.match(none.status.textContent, /cannot show a card from a plugin page/u);
});

test('page: no tree yet says how one appears, in both languages', async () => {
  const ui = page({ trees: [], focus: null, now: 1 });
  await settle();
  ui.context('en', 'sage');
  assert.match(ui.app.text(), /No agent tree yet/u);
  ui.context('ru', 'sage');
  assert.match(ui.app.text(), /Дерева агентов пока нет/u);
});
