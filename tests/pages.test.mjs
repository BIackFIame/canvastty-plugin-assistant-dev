// The bundled pages run against a tiny stand-in DOM and a fake host SDK: the settings page has exactly four
// controls in both languages, takes the palette from the context, and the Flow preview shows a waiting plan with
// Start and Cancel; a project flow is marked as the project's own. No browser is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const root = new URL('../', import.meta.url).pathname;

class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {}; this.textContent = ''; this.parent = null; this.className = ''; this.props = {}; this.style = { setProperty: (name, value) => { this.props[name] = value; } }; }
  append(...nodes) { for (const node of nodes) { const child = typeof node === 'string' ? Object.assign(new Node('#text'), { textContent: node }) : node; child.parent = this; this.children.push(child); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  closest(selector) { let node = this; while (node) { if (selector === '#app' && node.id === 'app') return node; node = node.parent; } return null; }
  get classList() { const self = this; return { toggle(name, on) { const set = new Set(self.className.split(' ').filter(Boolean)); if (on) set.add(name); else set.delete(name); self.className = [...set].join(' '); } }; }
  click() { for (const listener of this.listeners.click ?? []) listener(); }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
  text() { return [this.textContent, ...this.children.map(child => child.text())].filter(Boolean).join(' ').replace(/\s+/gu, ' '); }
}

function page(file, replies, extraSdk = {}) {
  const app = Object.assign(new Node('main'), { id: 'app' });
  const status = Object.assign(new Node('output'), { id: 'status' });
  const html = new Node('html');
  const requests = [];
  const events = [];
  let context = null;
  const sdk = {
    onContext(listener) { context = listener; },
    service: {
      async request(serviceId, method, params) { params = params === undefined ? undefined : JSON.parse(JSON.stringify(params)); requests.push({ serviceId, method, params }); const reply = replies[method]; return typeof reply === 'function' ? reply(params) : reply; },
      onEvent(listener) { events.push(listener); }
    },
    canvas: { open: async id => { requests.push({ method: 'canvas.open', params: id }); } },
    ...extraSdk
  };
  const document = { documentElement: html, activeElement: null, createElement: tag => new Node(tag), querySelector: selector => selector === '#app' ? app : status };
  vm.runInNewContext(readFileSync(join(root, file), 'utf8'), { window: { CanvasTTYPlugin: sdk }, document, console, setTimeout, clearTimeout, structuredClone });
  return { app, html, requests, context: (locale, palette, extra = {}) => context({ appearance: { locale, palette, ...extra } }), event: (event, data) => events.forEach(listener => listener({ serviceId: 'assistant', event, data })) };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 10));

test('settings page: four controls (Strict/Basic rules/Off, then three switches), Russian and English, the palette from the context', async () => {
  const state = { commandReview: 'off', custom: null, settingsUnavailable: false, routing: true, loopAlerts: true, flows: true, models: 0 };
  const ui = page('settings/harness.js', { 'harness.settings': state, 'harness.saveSettings': ({ settings }) => ({ ...state, ...settings }) });
  await settle();
  ui.context('ru', 'night', { uiScale: 1.25 });
  assert.equal(ui.html.dataset.palette, 'night');
  assert.equal(ui.html.lang, 'ru');
  assert.equal(ui.html.props['--ui-scale'], '1.25', 'the host scale, when sent, sizes the page');
  const rows = ui.app.all().filter(node => node.className === 'setting-row');
  assert.equal(rows.length, 4);
  assert.match(ui.app.text(), /Проверка команд .* Строго Базовые правила Выкл/u);
  // Each level in one line; Basic rules says it blocks.
  assert.match(ui.app.text(), /Строго: всё, кроме команд чтения, ждёт вашего ответа\./u);
  assert.match(ui.app.text(), /Базовые правила: блокирует то, что запрещают жёсткие правила/u);
  assert.match(ui.app.text(), /Выкл: Помощник не проверяет команды\./u);
  assert.doesNotMatch(ui.app.text(), /Предупреждать|до запуска ничего/u);
  assert.match(ui.app.text(), /Сценарии/u);
  assert.equal(ui.app.all().filter(node => node.tagName === 'INPUT').length, 3);
  // Strict saves through the service with every other value as it was.
  ui.app.all().find(node => node.tagName === 'BUTTON' && node.textContent === 'Строго').click();
  await settle();
  assert.deepEqual(ui.requests.find(request => request.method === 'harness.saveSettings').params, { settings: { commandReview: 'strict', routing: true, loopAlerts: true, flows: true } });
  ui.context('en', 'sage');
  assert.match(ui.app.text(), /Command review .* Strict Basic rules Off/u);
  assert.match(ui.app.text(), /not a lock/u, 'flows are described as a request, not a gate');
  assert.doesNotMatch(ui.app.text(), /Warn|before anything starts/u);
  assert.match(ui.app.text(), /Decision models: none/u);
  ui.app.all().find(node => node.tagName === 'BUTTON' && node.textContent === 'Decision models…').click();
  assert.ok(ui.requests.some(request => request.method === 'canvas.open' && request.params === 'models'));
  // Another page saved: this one reloads.
  const loads = ui.requests.filter(request => request.method === 'harness.settings').length;
  ui.event('settings', null);
  await settle();
  assert.equal(ui.requests.filter(request => request.method === 'harness.settings').length, loads + 1);
});

test('settings page: a custom command review is shown read-only with what it is; an unreadable store says so', async () => {
  const state = { commandReview: 'custom', custom: { mode: 'shadow', strictness: 'triage' }, settingsUnavailable: true, routing: true, loopAlerts: false, flows: true, models: 1 };
  const ui = page('settings/harness.js', { 'harness.settings': state, 'harness.saveSettings': ({ settings }) => ({ ...state, ...settings }) });
  await settle();
  ui.context('en', 'sage');
  assert.match(ui.app.text(), /Strict Basic rules Off Custom/u);
  assert.match(ui.app.text(), /Custom: set by an older version or the decision models page \(mode Learning, strictness by the task\)/u);
  assert.match(ui.app.text(), /could not be read yet: command review is Off and nothing can be saved/u);
  const custom = ui.app.all().find(node => node.tagName === 'BUTTON' && node.textContent === 'Custom');
  assert.equal(custom.attributes['aria-checked'], 'true');
  custom.click();
  await settle();
  assert.equal(ui.requests.some(request => request.method === 'harness.saveSettings'), false, 'Custom is not a choice');
  // A switch keeps the custom review as it is.
  ui.app.all().find(node => node.tagName === 'INPUT' && node.name === 'loopAlerts').listeners.change[0]();
  await settle();
  assert.equal(ui.requests.find(request => request.method === 'harness.saveSettings').params.settings.commandReview, 'custom');
});

test('Flow preview: a waiting plan shows roles, models and tasks with Start and Cancel; Start decides it', async () => {
  const plan = {
    id: 'p1', orchestratorId: 'o1', orchestratorTitle: 'Lead', flowId: 'docs', source: 'project', name: 'Docs pass', description: 'Writer drafts',
    goal: 'the CLI', status: 'pending', requestedBy: 'orchestrator', createdAt: 1,
    roles: [{ id: 'writer', title: 'Writer', task: 'Write docs for the CLI.', provider: 'claude', model: 'claude-haiku-4', reason: '' }, { id: 'editor', title: 'Editor', task: 'Check', provider: null, reason: '' }]
  };
  const ui = page('apps/flows.js', {
    'harness.view': { settings: { flows: true }, focus: { flows: 'o1' }, orchestrators: [{ id: 'o1', title: 'Lead' }], plans: [plan] },
    'flows.choices': { flows: [{ id: 'docs', name: 'Docs pass', description: 'Writer drafts', source: 'project', roles: [] }], problems: [] },
    'flows.decide': () => ({ ...plan, status: 'approved' })
  });
  await settle();
  ui.context('en', 'lilac');
  const text = ui.app.text();
  assert.match(text, /Flow: Docs pass From this project proposed by the orchestrator/u);
  assert.match(text, /claude \/ claude-haiku-4 Write docs for the CLI\./u);
  assert.match(text, /chosen by the orchestrator/u, 'a role without a provider says who chooses');
  assert.match(text, /This is a request it is told to follow, not a lock/u);
  assert.doesNotMatch(text, /Permissions are unchanged|before anything starts/u);
  // Start is held for a moment after a plan first shows.
  const start = () => ui.app.all().find(node => node.tagName === 'BUTTON' && node.textContent === 'Start');
  assert.equal(start().disabled, true);
  start().click();
  await settle();
  assert.equal(ui.requests.some(request => request.method === 'flows.decide'), false, 'a click in the first moment does nothing');
  await new Promise(resolve => setTimeout(resolve, 1_550));
  assert.equal(start().disabled, false);
  start().click();
  await settle();
  assert.deepEqual(ui.requests.find(request => request.method === 'flows.decide').params, { planId: 'p1', decision: 'approved' });
  ui.context('ru', 'lilac');
  assert.match(ui.app.text(), /Сценарий: Docs pass Из этого проекта/u);
});

test('Flow preview: a plan that replaces the one on screen says so and holds Start again', async () => {
  const plan = id => ({
    id, orchestratorId: 'o1', orchestratorTitle: 'Lead', flowId: 'test-fix', source: 'built-in', name: `Plan ${id}`, description: '',
    goal: 'g', status: 'pending', requestedBy: 'orchestrator', createdAt: 1, roles: [{ id: 'a', title: 'A', task: `task of ${id}`, provider: 'claude', reason: '' }]
  });
  let current = plan('pA');
  const ui = page('apps/flows.js', {
    'harness.view': () => ({ settings: { flows: true }, focus: { flows: 'o1' }, orchestrators: [{ id: 'o1', title: 'Lead' }], plans: [current] }),
    'flows.choices': { flows: [], problems: [] }
  });
  await settle();
  ui.context('en', 'sage');
  assert.doesNotMatch(ui.app.text(), /The plan changed/u);
  await new Promise(resolve => setTimeout(resolve, 1_550));
  // The orchestrator proposes again while the person reads plan A.
  current = plan('pB');
  ui.event('changed', null);
  await settle();
  assert.match(ui.app.text(), /The plan changed: the orchestrator replaced the plan that was shown here/u);
  assert.match(ui.app.text(), /task of pB/u);
  assert.equal(ui.app.all().find(node => node.tagName === 'BUTTON' && node.textContent === 'Start').disabled, true, 'Start is held again for the new plan');
  ui.context('ru', 'sage');
  assert.match(ui.app.text(), /План изменился/u);
});

test('no page or manifest text promises that the flow preview enforces anything', () => {
  const texts = ['apps/flows.js', 'settings/harness.js', 'services/assistant.mjs', 'canvastty.plugin.json', 'README.md', 'README.ru.md'].map(file => readFileSync(join(root, file), 'utf8'));
  for (const text of texts) assert.doesNotMatch(text, /nothing starts before|before anything starts|Permissions are unchanged|до запуска ничего|Права не меняются/u);
});

test('Russian names: every card action has title.ru, and Russian text names the plugin as it is shown (Ассистент CanvasTTY)', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'canvastty.plugin.json'), 'utf8'));
  const actions = manifest.services.flatMap(service => service.cardActions ?? []);
  assert.deepEqual(actions.map(action => action['title.ru']), ['План по сценарию…', 'Доска задач', 'Отчёт']);
  for (const action of actions) assert.ok(action['title.ru'].length <= 40 && action.title.length <= 40, action.id);
  assert.equal(manifest['name.ru'], 'Ассистент CanvasTTY');
  assert.match(manifest['description.ru'], /Плагины → Ассистент CanvasTTY → Настройки/u);
  const flows = manifest.contributions.find(item => item.id === 'flows');
  // The Russian strings name the shown titles: the plugin, and the Flow preview card as its manifest title says.
  // The bundles escape non-ASCII text, so the sources are read (the coreFiles test ties the bundles to them).
  const strings = readFileSync(join(root, 'src/harness/i18n.ts'), 'utf8');
  const ru = strings.slice(strings.indexOf('const RU'));
  assert.ok(ru.length < strings.length, 'the Russian strings are found');
  for (const text of [manifest['description.ru'], readFileSync(join(root, 'README.ru.md'), 'utf8'), ru]) assert.doesNotMatch(text, /Плагины → CanvasTTY Assistant|Просмотр сценариев/u);
  assert.match(ru, new RegExp(`Плагины → Ассистент CanvasTTY → ${flows['title.ru']}`, 'u'));
});

test('settings rows wrap the control under the description when the row is narrow, in rem so --ui-scale wraps sooner', () => {
  const css = readFileSync(join(root, 'apps/harness.css'), 'utf8');
  const rule = selector => css.match(new RegExp(`^\\${selector} \\{([^}]*)\\}`, 'mu'))?.[1] ?? '';
  assert.match(rule('.setting-row'), /display: flex;.*flex-wrap: wrap;/u);
  assert.match(rule('.setting-row__copy'), /flex: 1 1 \d+(\.\d+)?rem;/u);
  assert.match(rule('.setting-row__control'), /flex: none;/u);
  assert.match(css, /font-size: calc\(13px \* var\(--ui-scale, 1\)\)/u);
});

test('Task board: columns by status, assignee by card title, empty state', async () => {
  const ui = page('apps/board.js', {
    'harness.view': { focus: { board: 'o1' }, titles: { s1: 'Worker' }, boards: [{ orchestratorId: 'o1', title: 'Lead', tasks: [
      { id: 't1', title: 'Parser', detail: '', status: 'done', assignee: 's1', note: 'merged', addedBy: 'orchestrator', updatedAt: 1 },
      { id: 't2', title: 'Docs', detail: '', status: 'todo', assignee: null, note: '', addedBy: 'flow', updatedAt: 1 }] }] }
  });
  await settle();
  ui.context('en', 'sage');
  assert.match(ui.app.text(), /1 of 2 done/u);
  assert.match(ui.app.text(), /To do · 1 t2 Docs from a flow/u);
  assert.match(ui.app.text(), /Done · 1 t1 Parser Assignee: Worker merged/u);
  const empty = page('apps/board.js', { 'harness.view': { focus: { board: null }, titles: {}, boards: [] } });
  await settle();
  empty.context('ru', 'sage');
  assert.match(empty.app.text(), /Досок задач пока нет/u);
});

test('decision models page: Auto (Jev) rows in Russian and English — upstreams, models, preference, caps, recent routing without text; keys write-only', async () => {
  const { DEFAULT_ASSISTANT_SETTINGS } = await import('../src/shared/settings.ts');
  const auto = {
    settings: {
      upstreams: [{ id: 'openrouter', preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', trust: 'D1', key: 'jev', enabled: true, models: [{ id: 'qwen/qwen3-coder', tier: 'medium', priceIn: 0.2, priceOut: 0.8 }] }],
      preference: 'balanced', cheaperFallback: false, decider: 'jev', dailyUsdCap: 1, perCardUsdCap: 0.4
    },
    readable: true, keys: { openrouter: true },
    recent: [{ at: Date.UTC(2026, 9, 18, 10, 0, 0), session: 'abcd1234', conversation: 'c', turn: 't', kind: 'turn', source: 'jev', tier: 'medium', upstream: 'openrouter', model: 'qwen/qwen3-coder', attempts: 2, failovers: [{ upstream: 'openrouter', model: 'x', status: 429 }], status: 200, reason: 'jev', ttfbMs: 300, totalMs: 900, tokensIn: 10, tokensOut: 2, costUsd: 0.00012 }],
    stats: { requests: 12, turns: 2, continuations: 9, small: 1, jevAsked: 2, jevAnswered: 2, rules: 0, leaseReuses: 9, failovers: 1, hosts: ['openrouter.ai'], spentToday: 0.0123, listening: true, cards: 1 }
  };
  const secrets = [];
  const ui = page('settings/assistant.js', {
    state: { settings: DEFAULT_ASSISTANT_SETTINGS, status: { enabled: false, backends: [] }, slots: {}, checks: {}, recent: [] },
    'auto.state': auto, 'auto.save': ({ settings }) => settings, 'auto.keySlot': () => ({ secret: 'auto-upstream-local', origin: 'http://127.0.0.1:8080' })
  }, { secrets: { set: async (key, value) => { secrets.push({ key, value }); }, delete: async () => undefined } });
  await settle();
  ui.context('en', 'sage');
  const text = ui.app.text();
  assert.match(text, /Model: Auto \(Jev\)/u);
  assert.match(text, /OpenRouter · openrouter/u);
  assert.match(text, /The Jev · OpenRouter key/u);
  assert.match(text, /key saved/u);
  assert.match(text, /qwen\/qwen3-coder/u);
  assert.match(text, /12 model calls, Jev asked 2 times \(2 answered\), 9 reused a turn's choice, 1 failovers/u);
  assert.match(text, /abcd1234 · turn · medium · qwen\/qwen3-coder · Jev \(jev\) · 200 · ↷1 · \$0\.00012/u);
  ui.context('ru', 'night');
  const ru = ui.app.text();
  assert.match(ru, /Модель: Авто \(Jev\)/u);
  assert.match(ru, /Поставщики/u);
  assert.match(ru, /Ключ Jev · OpenRouter/u);
  assert.match(ru, /Предпочтение .*Сбалансированно/u);
  assert.match(ru, /Предел в день, USD/u);
  assert.match(ru, /ход · средняя · qwen\/qwen3-coder/u);
  assert.doesNotMatch(ru, /Model calls|Upstreams/u, 'no English left in the Auto rows');
  // Add an OpenAI-compatible upstream on this computer: the service gets the whole Auto settings to validate.
  const all = ui.app.all();
  const byName = name => all.find(node => node.name === name);
  byName('auto-new-preset').value = 'openai-compatible';
  for (const listener of byName('auto-new-preset').listeners.change) listener();
  byName('auto-new-id').value = 'local';
  byName('auto-new-url').value = 'http://127.0.0.1:8080/v1';
  byName('auto-add-upstream').click();
  await settle();
  const saved = ui.requests.filter(r => r.method === 'auto.save').at(-1).params.settings;
  assert.deepEqual(saved.upstreams.map(u => [u.id, u.preset, u.baseUrl, u.trust]), [['openrouter', 'openrouter', 'https://openrouter.ai/api/v1', 'D1'], ['local', 'openai-compatible', 'http://127.0.0.1:8080/v1', 'D1']]);
  // A key typed for an upstream goes to the plugin's secrets, bound to its origin, and is never sent to the service.
  auto.settings.upstreams.push({ id: 'local', preset: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1', trust: 'D3', key: 'own', enabled: true, models: [] });
  ui.event('settings', null);
  await settle();
  const keyInput = ui.app.all().find(node => node.name === 'auto-key-local');
  keyInput.value = 'sk-local-123456';
  ui.app.all().find(node => node.textContent === 'Сохранить ключ' && node.parent?.dataset?.upstream === undefined && node.parent.children.includes(keyInput)).click();
  await settle();
  assert.deepEqual(secrets, [{ key: 'auto-upstream-local', value: JSON.stringify({ origin: 'http://127.0.0.1:8080', value: 'sk-local-123456' }) }]);
  assert.ok(!JSON.stringify(ui.requests).includes('sk-local-123456'), 'the key never goes to the service');
});

test('decision models page: Auto from data — catalog freshness and refresh, model table (read-only facts, exclude, tier), decisions with type, difficulty, score, price and why', async () => {
  const { DEFAULT_ASSISTANT_SETTINGS } = await import('../src/shared/settings.ts');
  const at = Date.UTC(2026, 9, 18, 9, 0, 0);
  const auto = {
    settings: {
      upstreams: [{ id: 'or', preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', trust: 'D1', key: 'own', enabled: true, models: [], allModels: true, excluded: [] }],
      preference: 'balanced', cheaperFallback: false, decider: 'jev', dailyUsdCap: 1, perCardUsdCap: 0.4, catalog: { autoRefresh: true, refreshHours: 168 }
    },
    readable: true, keys: { or: true },
    catalog: { now: at, autoRefresh: true, refreshHours: 168, refreshing: false, bundled: false, lastError: null, lastAttemptAt: at, nextRefreshAt: at + 7 * 86_400_000, sources: [
      { id: 'models.dev', fetchedAt: at, version: null, rows: 8000, measured: 0, stale: false, error: null },
      { id: 'artificial-analysis', fetchedAt: at - 9 * 86_400_000, version: '4.3.2', rows: 690, measured: 221, stale: true, error: 'Artificial Analysis unavailable; earlier scores keep their age.' },
      { id: 'livebench', fetchedAt: at, version: '2026-06-25', rows: 28, measured: 28, stale: false, error: null },
      { id: 'openrouter', fetchedAt: at, version: null, rows: 300, measured: 0, stale: false, error: null }] },
    models: { or: [
      { id: 'vendor/alpha-1', listed: false, fromList: true, excluded: false, tier: null, effort: null, priceIn: 1, priceOut: 4, priceSource: 'openrouter', context: 400_000, known: true, measuredEfforts: ['high', 'low'], scores: { coding: { value: 57.5, effort: 'high', label: 'Artificial Analysis v4.3.2', historical: true } } },
      { id: 'vendor/gamma-3', listed: false, fromList: true, excluded: true, tier: null, effort: null, priceIn: 0.2, priceOut: 0.8, priceSource: 'openrouter', context: 64_000, known: true, measuredEfforts: [], scores: {} }
    ] },
    waitingForList: [],
    recent: [{ at, session: 'abcd1234', conversation: 'c', turn: 't', kind: 'turn', source: 'jev', tier: 'large', taskType: 'coding', difficulty: 'large', confidence: 0.05, why: 'best_score', upstream: 'or', model: 'vendor/alpha-1', effort: 'high', score: 57.5, scoreSource: 'Artificial Analysis v4.3.2', priceIn: 1, priceOut: 4, attempts: 1, failovers: [], status: 200, reason: 'jev', ttfbMs: 300, totalMs: 900, tokensIn: 10, tokensOut: 2, costUsd: 0.00012,
      tradeoff: { window: 0, bestModel: 'vendor/alpha-1', bestEffort: 'high', bestScore: 57.5, bestPriceIn: 1, bestPriceOut: 4 } },
    { at, session: 'abcd1234', conversation: 'c', turn: 't2', kind: 'turn', source: 'jev', tier: 'medium', taskType: 'coding', difficulty: 'medium', confidence: 0.1, why: 'cheaper_within_loss', upstream: 'or', model: 'vendor/beta-2', effort: null, score: 55, scoreSource: 'Artificial Analysis v4.3.2', priceIn: 0.5, priceOut: 2, attempts: 1, failovers: [], status: 200, reason: 'jev', ttfbMs: 300, totalMs: 900, tokensIn: 10, tokensOut: 2, costUsd: 0.00005,
      tradeoff: { window: 5, bestModel: 'vendor/alpha-1', bestEffort: 'high', bestScore: 57.5, bestPriceIn: 1, bestPriceOut: 4 } }],
    stats: { requests: 1, turns: 1, continuations: 0, small: 0, jevAsked: 1, jevAnswered: 1, rules: 0, leaseReuses: 0, failovers: 0, hosts: ['openrouter.ai'], spentToday: 0.0001, listening: true, cards: 1 }
  };
  const ui = page('settings/assistant.js', {
    state: { settings: DEFAULT_ASSISTANT_SETTINGS, status: { enabled: false, backends: [] }, slots: {}, checks: {}, recent: [] },
    'auto.state': auto, 'auto.save': ({ settings }) => settings, 'auto.refreshCatalog': () => auto.catalog
  }, { secrets: { set: async () => undefined, delete: async () => undefined } });
  await settle();
  ui.context('en', 'sage');
  const text = ui.app.text();
  assert.match(text, /Artificial Analysis — loaded .*v4\.3\.2, 221 measured of 690 rows — old — Artificial Analysis unavailable/u);
  assert.match(text, /OpenRouter models — loaded/u);
  assert.match(text, /vendor\/alpha-1 400k 1\.00 · 4\.00 \(OpenRouter\) 57\.5 @high · Artificial Analysis v4\.3\.2 · old high, low/u);
  assert.match(text, /vendor\/gamma-3 64k 0\.2 · 0\.8 \(OpenRouter\) unknown/u);
  assert.match(text, /abcd1234 · turn · coding · large \(0\.05\) · vendor\/alpha-1@high · 57\.5 Artificial Analysis v4\.3\.2 · \$1\.00\/\$4\.00 · Jev \(best score\) · 200/u);
  assert.match(text, /vendor\/beta-2 · 55\.0 Artificial Analysis v4\.3\.2 · \$0\.5\/\$2\.00 · Jev \(cheaper, within the allowed loss\) · 2\.5 points below vendor\/alpha-1@high \(57\.5\), 50% cheaper; allowed 5 · 200/u);
  assert.doesNotMatch(text, /alpha-1@high · 57\.5 Artificial Analysis v4\.3\.2 · \$1\.00\/\$4\.00 · Jev \(best score\) · [^2]/u, 'no trade-off shown for the best model itself');
  const all = ui.app.all();
  const byName = name => all.find(node => node.name === name);
  assert.equal(byName('auto-use-or-vendor/gamma-3').checked, false, 'the excluded model is unticked');
  // Exclude a model: only the exclusion is saved.
  byName('auto-use-or-vendor/alpha-1').checked = false;
  for (const listener of byName('auto-use-or-vendor/alpha-1').listeners.change) listener();
  await settle();
  assert.deepEqual(ui.requests.filter(r => r.method === 'auto.save').at(-1).params.settings.upstreams[0].excluded, ['vendor/alpha-1']);
  // A manual tier on a model from OpenRouter's list becomes an override; back to "by score" removes it again.
  byName('auto-tier-or-vendor/alpha-1').value = 'small';
  for (const listener of byName('auto-tier-or-vendor/alpha-1').listeners.change) listener();
  await settle();
  assert.deepEqual(ui.requests.filter(r => r.method === 'auto.save').at(-1).params.settings.upstreams[0].models, [{ id: 'vendor/alpha-1', tier: 'small' }]);
  // Refresh now.
  byName('auto-catalog-refresh').click();
  await settle();
  assert.ok(ui.requests.some(r => r.method === 'auto.refreshCatalog'));
  ui.context('ru', 'night');
  const ru = ui.app.text();
  assert.match(ru, /Каталог/u);
  assert.match(ru, /Обновить сейчас/u);
  assert.match(ru, /загружено .*v4\.3\.2, измерено 221 строк из 690 — устарело/u);
  assert.match(ru, /ход · код · большая \(0\.05\) · vendor\/alpha-1@high · 57\.5 Artificial Analysis v4\.3\.2 · \$1\.00\/\$4\.00 · Jev \(лучшая оценка\) · 200/u);
  assert.match(ru, /Jev \(дешевле, в пределах допустимой потери\) · на 2\.5 балла ниже vendor\/alpha-1@high \(57\.5\), дешевле на 50%; допустимо 5 · 200/u);
  assert.match(ru, /неизвестно/u);
  assert.doesNotMatch(ru, /Refresh now|Measured at|by score|best score|points below|allowed/u, 'no English left in the Auto rows');
});
