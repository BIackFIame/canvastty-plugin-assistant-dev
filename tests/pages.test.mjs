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
  vm.runInNewContext(readFileSync(join(root, file), 'utf8'), { window: { CanvasTTYPlugin: sdk }, document, console, setTimeout, clearTimeout, structuredClone, URL });
  return { app, html, requests, context: (locale, palette, extra = {}) => context({ appearance: { locale, palette, ...extra } }), event: (event, data) => events.forEach(listener => listener({ serviceId: 'assistant', event, data })) };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 10));

test('settings page: five controls (Strict/Basic rules/Off, the trust chain off by default, then three switches), Russian and English, the palette from the context', async () => {
  const state = { commandReview: 'off', custom: null, settingsUnavailable: false, routing: true, loopAlerts: true, flows: true, models: 0 };
  const ui = page('settings/harness.js', { 'harness.settings': state, 'harness.saveSettings': ({ settings }) => ({ ...state, ...settings }) });
  await settle();
  ui.context('ru', 'night', { uiScale: 1.25 });
  assert.equal(ui.html.dataset.palette, 'night');
  assert.equal(ui.html.lang, 'ru');
  assert.equal(ui.html.props['--ui-scale'], '1.25', 'the host scale, when sent, sizes the page');
  const rows = ui.app.all().filter(node => node.className === 'setting-row');
  assert.equal(rows.length, 5);
  assert.match(ui.app.text(), /Проверка команд .* Строго Базовые правила Выкл/u);
  assert.match(ui.app.text(), /Разрешить субагентам создавать новые файлы для задачи, которую вы написали/u);
  assert.equal(ui.app.all().find(node => node.name === 'trustChain').checked, false, 'off until the person turns it on');
  // One line: what the chosen level does (Off now); the others are not spelled out.
  assert.match(ui.app.text(), /Выкл: Помощник не проверяет команды\./u);
  assert.doesNotMatch(ui.app.text(), /Строго: всё, кроме|Базовые правила: блокирует/u);
  assert.doesNotMatch(ui.app.text(), /Предупреждать|до запуска ничего/u);
  assert.match(ui.app.text(), /Сценарии/u);
  assert.equal(ui.app.all().filter(node => node.tagName === 'INPUT').length, 4);
  // Strict saves through the service with every other value as it was.
  ui.app.all().find(node => node.tagName === 'BUTTON' && node.textContent === 'Строго').click();
  await settle();
  assert.deepEqual(ui.requests.find(request => request.method === 'harness.saveSettings').params, { settings: { commandReview: 'strict', routing: true, loopAlerts: true, flows: true, trustChain: false } });
  assert.match(ui.app.text(), /Строго: всё, кроме команд чтения, ждёт вашего ответа\./u, 'the chosen level\'s line');
  // The trust chain: saved with everything else as it was.
  const chain = ui.app.all().find(node => node.name === 'trustChain');
  chain.checked = true;
  for (const listener of chain.listeners.change) listener();
  await settle();
  assert.equal(ui.requests.filter(request => request.method === 'harness.saveSettings').at(-1).params.settings.trustChain, true);
  ui.context('en', 'sage');
  assert.match(ui.app.text(), /Let subagents create new files for a task you typed/u);
  assert.match(ui.app.text(), /Command review .* Strict Basic rules Off/u);
  assert.match(ui.app.text(), /not a lock/u, 'flows are described as a request, not a gate');
  assert.doesNotMatch(ui.app.text(), /95%/u, 'no thresholds on the main page');
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
  assert.match(ui.app.text(), /Set on the Decision models page \(Learning, by the task\)\. Choose a level to replace it\./u);
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

test('settings page: one action, Start with Auto (Jev): task and folder; without consent a one-line hint says how; started says where; ru/en', async () => {
  const state = { commandReview: 'off', custom: null, settingsUnavailable: false, routing: true, loopAlerts: true, flows: true, models: 0 };
  let answer = { started: false, code: 'consent' };
  const ui = page('settings/harness.js', {
    'harness.settings': state, 'autopilot.entry': { folders: ['/work/app', '/work/lib'], servers: false, routing: true }, 'autopilot.start': () => answer
  });
  await settle();
  ui.context('en', 'sage');
  assert.match(ui.app.text(), /Start with Auto \(Jev\) Jev reads the task and chooses where an orchestrator runs/u);
  assert.equal(ui.app.all().filter(node => node.className === 'setting-row').length, 5, 'no new setting: servers are off');
  const folder = ui.app.all().find(node => node.name === 'autoFolder');
  assert.equal(folder.value, '/work/app', 'the newest open card\'s folder');
  assert.deepEqual(ui.app.all().filter(node => node.tagName === 'OPTION').map(node => node.value), ['/work/app', '/work/lib']);
  const task = ui.app.all().find(node => node.name === 'autoTask');
  task.value = 'Add a dark theme';
  task.listeners.input[0]();
  ui.app.all().find(node => node.tagName === 'BUTTON' && node.textContent === 'Start with Auto (Jev)').click();
  await settle();
  assert.deepEqual(ui.requests.find(request => request.method === 'autopilot.start').params, { task: 'Add a dark theme', cwd: '/work/app', server: false });
  const hint = ui.app.all().find(node => node.className === 'notice');
  assert.match(hint.textContent, /allow “May start orchestrators” for the Assistant in Settings → Extension native code\. Or start an orchestrator yourself in the launcher with Model: Auto \(Jev\)\./u);
  ui.context('ru', 'sage');
  assert.match(ui.app.text(), /Запустить с «Авто \(Jev\)»/u);
  assert.match(ui.app.text(), /Задача Папка проекта/u);
  assert.match(ui.app.all().find(node => node.className === 'notice').textContent, /разрешите Помощнику «Может запускать оркестраторов»/u, 'the hint follows the language');
  answer = { started: false, code: 'core' };
  ui.app.all().find(node => node.tagName === 'BUTTON' && node.textContent === 'Запустить с «Авто (Jev)»').click();
  await settle();
  assert.match(ui.app.all().find(node => node.className === 'notice').textContent, /не разрешает плагинам запускать оркестраторы/u);
  answer = { started: true, route: 'codex · Pro · gpt-5.5@high' };
  ui.app.all().find(node => node.tagName === 'BUTTON' && node.textContent === 'Запустить с «Авто (Jev)»').click();
  await settle();
  assert.equal(ui.app.all().some(node => node.className === 'notice'), false, 'the hint is gone');
  // With servers on: one more row, the server switch.
  const servers = page('settings/harness.js', { 'harness.settings': state, 'autopilot.entry': { folders: [], servers: true, routing: true } });
  await settle();
  servers.context('en', 'sage');
  assert.equal(servers.app.all().filter(node => node.className === 'setting-row').length, 6);
  assert.match(servers.app.text(), /On one of your servers \(Jev picks one\)/u);
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
  assert.match(ru, /На окно, USD/u);
  assert.doesNotMatch(ru, /Предел в день, USD/u, 'the daily limit is in the short view only');
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
  assert.match(text, /Artificial Analysis — loaded .*v4\.3\.2, 221 measured of 690 rows — old — unavailable; earlier scores kept/u);
  assert.match(text, /OpenRouter models — loaded/u);
  // Two lines per model; the score's source and age and the measured efforts in its tooltip (no overflow).
  assert.match(text, /vendor\/alpha-1 400k · \$1\.00 · \$4\.00 57\.5 @high \(old\)/u);
  assert.match(text, /vendor\/gamma-3 64k · \$0\.2 · \$0\.8 unknown/u);
  const alphaScore = ui.app.all().find(node => node.tagName === 'TD' && node.textContent === '57.5 @high (old)');
  assert.equal(alphaScore.title, 'Artificial Analysis v4.3.2 · Measured at: high, low');
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

test('decision models page: "Where agents run" — plans with windows and aliases, accounts, choices, pins, recent routes; limits forwarded; ru/en complete', async () => {
  const { DEFAULT_ASSISTANT_SETTINGS } = await import('../src/shared/settings.ts');
  const { DEFAULT_ROUTE_SETTINGS } = await import('../src/route/settings.ts');
  globalThis.window ??= { CanvasTTYPlugin: {} }; // the strings module sits next to the page helpers
  const { ROUTE_PAGE_STRINGS } = await import('../src/ui/routing.ts');
  const at = Date.UTC(2026, 9, 18, 12, 0, 0);
  const settings = { ...structuredClone(DEFAULT_ROUTE_SETTINGS), plans: [
    { id: 'claude-max', cli: 'claude', kind: 'subscription', label: 'Max', models: ['opus', 'mystery'], reserve: 20, maxParallel: 2, allow: 'prefer', trust: 'D2' },
    { id: 'glm-plan', cli: 'opencode', kind: 'coding-plan', label: 'GLM plan', models: ['zai-coding-plan/*'], reserve: 20, maxParallel: 2, allowance: 100, windowHours: 5, allow: 'allow', trust: 'unset' }
  ], pins: { 'glm-5-3-flash': 'small' }, boosts: { 'claude-sonnet-5': 3 } };
  const route = {
    settings, readable: true, now: at, staleAfterMs: 1_800_000, aliases: { asOf: '2026-10-15', bundled: { claude: { opus: 'claude-opus-4-8' } } },
    plans: [
      { id: 'claude-max', models: [{ model: 'opus', identity: 'claude-opus-4-8', from: 'bundled' }, { model: 'mystery', identity: null, from: 'none' }], quota: { state: 'known', headroom: 39, pace: 0.8, window: { label: '5 h', usedPercent: 41, minutes: 300 }, readAt: at - 180_000, note: '', code: '' }, running: 1, launches: null },
      { id: 'glm-plan', models: [], quota: null, running: 0, launches: 14 }
    ],
    limits: { receivedAt: at - 180_000, providers: [] },
    accounts: { at: at - 720_000, rows: [{ provider: 'claude', accountId: 'zai-glm', account: 'Z.AI GLM', model: 'glm-5.3', endpoint: 'api.z.ai', state: 'ready' }] },
    cooldowns: [{ signIn: 'plan:claude-max', until: at + 300_000, reason: 'it hit a usage limit' }],
    recent: [{ id: 'd1', at, card: 'orch-123', type: 'research', level: 'medium', typeFrom: 'jev', confidence: 0.2, strategy: 'single-strong', cohort: 'aa', candidates: 9, dropped: 3, explored: false, preferred: false,
      options: [{ key: 'k', cli: 'claude', kind: 'subscription', signIn: 'plan:claude-max', label: 'Max', model: 'opus', identity: 'claude-opus-4-8', effort: 'max', score: 41.8, scoreSource: 'measured', cost: 0, costBasis: 'free', estimate: '≈ 8% of the 5 h', estimateData: { kind: 'window', share: 8, window: '5 h', usedPercent: 41 }, scoreLabel: 'Artificial Analysis v4.3.2', below: 3, why: 'claude · opus@max … subscription: free' }],
      outcome: { result: 'done', ok: true, by: 'orchestrator', at } }],
    exploration: [{ identity: 'fresh-1', n: 20, ok: 18, incumbent: 0.9, verdict: 'use' }]
  };
  const forwarded = [];
  const ui = page('settings/assistant.js', {
    state: { settings: DEFAULT_ASSISTANT_SETTINGS, status: { enabled: false, backends: [] }, slots: {}, checks: {}, recent: [] },
    'route.state': route, 'route.save': ({ settings: next }) => next, 'route.limits': ({ snapshot }) => { forwarded.push(snapshot); return { ok: true, providers: 1 }; }, 'route.feedback': () => ({ ok: true })
  }, { secrets: { set: async () => undefined, delete: async () => undefined }, request: async method => { if (method !== 'limits.get') throw new Error(method); return { state: 'ready', snapshot: { fetchedAt: at, providers: [{ provider: 'claude', state: 'available', fetchedAt: at, windows: [] }] } }; } });
  await settle();
  assert.equal(forwarded.length, 1, 'the page forwards CanvasTTY\'s limit windows when it opens');
  assert.equal(forwarded[0].state, 'ready');
  ui.context('en', 'sage');
  const text = ui.app.text();
  assert.match(text, /Where agents run/u);
  assert.match(text, /Limit windows: read 3 min ago/u);
  assert.match(text, /Claude Code · subscription · Max/u);
  assert.match(text, /5 h 41% used · headroom 39% · read 3 min ago · 1 routed running/u);
  assert.match(text, /opus → claude-opus-4-8 \(alias table 2026-10-15\); mystery → no score/u);
  assert.match(text, /14 of 100 launches counted in 5 h/u);
  assert.match(text, /Z\.AI GLM · glm-5\.3 · Claude Code · ready/u);
  assert.match(text, /fresh-1: 18 of 20 ok, others 90% · about as good: use it\?/u);
  assert.match(text, /orch-123 · research\/medium · one strong .*claude · opus@max .*≈ 8% of the 5 h .*subscription: Max · score 41\.8 \(Artificial Analysis v4\.3\.2\), 3 below the best · free within the window/u);
  const all = () => ui.app.all();
  const byName = name => all().find(node => node.name === name);
  // Declare a plan: the whole settings go to the service, which validates them.
  byName('route-new-cli').value = 'codex';
  byName('route-new-kind').value = 'subscription';
  byName('route-new-name').value = 'Pro';
  byName('route-new-models').value = 'gpt-5.5, gpt-5.4-mini';
  byName('route-new-add').click();
  await settle();
  const saved = ui.requests.filter(r => r.method === 'route.save').at(-1).params.settings;
  assert.deepEqual(saved.plans.at(-1), { id: 'codex-pro', cli: 'codex', kind: 'subscription', label: 'Pro', models: ['gpt-5.5', 'gpt-5.4-mini'], reserve: 20, maxParallel: 2, allow: 'allow', trust: 'unset' });
  // Trust for an account address, Never for a CLI, the new-model policy, a pin.
  byName('route-trust-api.z.ai').value = 'D1';
  for (const listener of byName('route-trust-api.z.ai').listeners.change) listener();
  await settle();
  assert.deepEqual(ui.requests.filter(r => r.method === 'route.save').at(-1).params.settings.trust, { 'host:api.z.ai': 'D1' });
  byName('route-never-cli').value = 'qwen';
  byName('route-never-add').click();
  await settle();
  assert.equal(ui.requests.filter(r => r.method === 'route.save').at(-1).params.settings.allow['cli:qwen'], 'never');
  const policy = byName('route-new-model-policy');
  policy.value = 'explore';
  for (const listener of policy.listeners.change) listener();
  await settle();
  assert.equal(ui.requests.filter(r => r.method === 'route.save').at(-1).params.settings.newModels, 'explore');
  // Use an explored model (+5 boost), and the person's ✗ on a decision.
  byName('route-use-fresh-1').click();
  await settle();
  assert.equal(ui.requests.filter(r => r.method === 'route.save').at(-1).params.settings.boosts['fresh-1'], 5);
  byName('route-wrong-d1').click();
  await settle();
  assert.deepEqual(ui.requests.filter(r => r.method === 'route.feedback').at(-1).params, { id: 'd1', ok: false });
  byName('route-limits-read').click();
  await settle();
  assert.equal(forwarded.length, 2, 'Read now forwards again');
  // Russian: complete, nothing English left in the section.
  ui.context('ru', 'night');
  const ru = ui.app.all().find(node => node.dataset?.section === 'routing').text();
  assert.match(ru, /Где работают агенты/u);
  assert.match(ru, /Claude Code · подписка · Max/u);
  assert.match(ru, /5 h: использовано 41% · запас 39% · прочитано 3 мин назад · запущено через route: 1/u);
  assert.match(ru, /opus → claude-opus-4-8 \(таблица псевдонимов 2026-10-15\); mystery → без оценки/u);
  assert.match(ru, /исследование\/средняя · одна сильная .*≈ 8% окна 5 h .*подписка: Max · оценка 41,8 \(Artificial Analysis v4\.3\.2\), на 3 ниже лучшей · бесплатно в пределах окна/u);
  assert.match(ru, /Отдыхают после лимита: claude-max → /u);
  assert.doesNotMatch(ru, /\b(?:subscription|coding plan|headroom|read \d|Where agents|Prefer|Allow|Never|launches|routed|score|below the best|free within|Remove|Add|Save)\b/u, 'no English left in the section');
  // Both languages have the same keys.
  const shape = value => typeof value === 'function' ? 'fn' : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, shape(value[key])])) : typeof value;
  assert.deepEqual(shape(ROUTE_PAGE_STRINGS.ru), shape(ROUTE_PAGE_STRINGS.en));
});

test('decision models page: several models on hard turns — consensus Off/Auto/Always (Auto by default), K, best of N off by default, cap per turn; fan-outs in recent decisions; ru/en', async () => {
  const { DEFAULT_ASSISTANT_SETTINGS } = await import('../src/shared/settings.ts');
  const at = Date.UTC(2026, 9, 19, 9, 0, 0);
  const record = (extra) => ({ at, session: 'abcd1234', conversation: 'c', turn: 't', kind: 'turn', source: 'jev', tier: 'large', taskType: 'research', difficulty: 'large', confidence: 0.05, why: 'best_score', upstream: 'or', model: 'a/strong', effort: null, score: 70, scoreSource: 'Artificial Analysis v4.3.2', priceIn: 5, priceOut: 25, attempts: 1, failovers: [], status: 200, reason: 'jev', ttfbMs: 300, totalMs: 900, tokensIn: 10, tokensOut: 2, costUsd: 0.0008, tradeoff: null, ...extra });
  const drafts = [{ upstream: 'or', model: 'a/strong', effort: null, status: 'text', http: 200, ms: 10, costUsd: 0.0002 }, { upstream: 'or', model: 'b/swift', effort: null, status: 'text', http: 200, ms: 10, costUsd: 0.0002 }, { upstream: 'or', model: 'c/steady', effort: null, status: 'timeout', http: 200, ms: 10, costUsd: null }];
  const auto = {
    settings: { upstreams: [], preference: 'balanced', cheaperFallback: false, decider: 'jev', dailyUsdCap: 1, perCardUsdCap: 0.4, catalog: { autoRefresh: true, refreshHours: 168 } },
    readable: true, keys: {},
    recent: [record({ strategy: 'consensus', strategyWhy: 'consensus_pays', fanOut: { kind: 'consensus', estimateUsd: 0.28, drafts, judge: { upstream: 'or', model: 'a/strong' }, outcome: 'merged' } })],
    stats: { requests: 4, turns: 1, continuations: 0, small: 0, jevAsked: 1, jevAnswered: 1, rules: 0, leaseReuses: 0, failovers: 0, fanOuts: 1, merged: 1, fanOutToolCalls: 0, fanOutDegraded: 0, judgeFailed: 0, hosts: [], spentToday: 0.0008, listening: true, cards: 1 }
  };
  const ui = page('settings/assistant.js', {
    state: { settings: DEFAULT_ASSISTANT_SETTINGS, status: { enabled: false, backends: [] }, slots: {}, checks: {}, recent: [] },
    'auto.state': auto, 'auto.save': ({ settings }) => settings
  }, { secrets: { set: async () => undefined, delete: async () => undefined } });
  await settle();
  ui.context('en', 'sage');
  const text = ui.app.text();
  assert.match(text, /Several models on hard turns/u);
  assert.match(text, /Consensus Off Auto: only when it pays Always for hard turns/u);
  assert.match(text, /consensus, merged, 2 of 3 drafts/u);
  assert.match(text, /Several models: 1 turns, 1 merged/u);
  const all = ui.app.all();
  const byName = name => all.find(node => node.name === name);
  assert.equal(byName('auto-consensus').value ?? 'auto', 'auto', 'an older service (no strategy): the defaults');
  assert.equal(byName('auto-best-of-n').checked, false, 'best of N is off unless turned on');
  byName('auto-consensus').value = 'always';
  for (const listener of byName('auto-consensus').listeners.change) listener();
  await settle();
  assert.deepEqual(ui.requests.filter(r => r.method === 'auto.save').at(-1).params.settings.strategy, { consensus: 'always', k: 3, bestOfN: false, turnUsdCap: 1 });
  byName('auto-turn-cap').value = '0.5';
  byName('auto-turn-cap-save').click();
  await settle();
  assert.equal(ui.requests.filter(r => r.method === 'auto.save').at(-1).params.settings.strategy.turnUsdCap, 0.5);
  ui.context('ru', 'night');
  const ru = ui.app.text();
  assert.match(ru, /Несколько моделей на сложных ходах/u);
  assert.match(ru, /консенсус, сведено, черновиков: 2 из 3/u);
  assert.match(ru, /Лучший из N|лучший из N/u);
  assert.doesNotMatch(ru, /Several models|Consensus|merged|drafts|best of N|per turn/u, 'no English left in the strategy rows');
});

test('decision models page: a short default view (Auto, the Jev key, preference, daily limit, today) and everything else under Advanced; the key serves Jev only; ru/en', async () => {
  const { DEFAULT_ASSISTANT_SETTINGS } = await import('../src/shared/settings.ts');
  const at = Date.UTC(2026, 9, 19, 9, 0, 0);
  let main = { settings: structuredClone(DEFAULT_ASSISTANT_SETTINGS), status: { enabled: false, backends: [] }, slots: {}, checks: {}, recent: [] };
  const auto = {
    jevKey: false,
    settings: { upstreams: [{ id: 'zai', preset: 'openai-compatible', baseUrl: 'https://api.z.ai/api/paas/v4', trust: 'D1', key: 'own', models: [{ id: 'glm-5.3' }], allModels: false, excluded: [], enabled: true },
      { id: 'jev-or', preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', trust: 'D1', key: 'jev', models: [], allModels: true, excluded: [], enabled: false }], preference: 'balanced', cheaperFallback: false, decider: 'jev', dailyUsdCap: 1, perCardUsdCap: 0.4, catalog: { autoRefresh: true, refreshHours: 168 } },
    readable: true, keys: {},
    recent: [{ at, session: 'abcd1234', conversation: 'c', turn: 't', kind: 'turn', source: 'jev', tier: 'large', taskType: 'writing', difficulty: 'large', confidence: 0.05, why: 'best_score', upstream: 'openrouter', model: 'google/gemini-3.1-pro-preview', effort: 'high', score: 82.2, scoreSource: 'x', priceIn: 2, priceOut: 12, attempts: 1, failovers: [], status: 200, reason: 'jev', ttfbMs: 1, totalMs: 2, tokensIn: 1, tokensOut: 1, costUsd: 0.184, tradeoff: null, strategy: 'consensus', fanOut: null }],
    stats: { requests: 14, turns: 3, continuations: 10, small: 1, jevAsked: 3, jevAnswered: 3, rules: 0, leaseReuses: 10, failovers: 0, hosts: [], spentToday: 0.39, listening: false, cards: 0 }
  };
  const secrets = [];
  const ui = page('settings/assistant.js', {
    state: () => main,
    save: ({ settings }) => { main = { ...main, settings, slots: Object.fromEntries(settings.backends.map(b => [b.id, b.preset === 'openrouter' ? { secret: 'assistant-openrouter', origin: 'https://openrouter.ai' } : null])) }; return settings; },
    quickKeySaved: () => { auto.jevKey = true; main.settings.modes['task.route'] = 'auto'; return null; },
    'auto.state': () => auto, 'auto.save': ({ settings }) => { auto.settings = settings; return settings; }, 'route.state': null
  }, { secrets: { set: async (key, value) => { secrets.push({ key, value }); }, delete: async () => undefined } });
  await settle();
  ui.context('en', 'sage');
  const outside = node => { for (let n = node; n; n = n.parent) if (n.tagName === 'DETAILS') return false; return true; };
  const controls = () => ui.app.all().filter(node => ['INPUT', 'SELECT', 'BUTTON'].includes(node.tagName) && outside(node));
  const advanced = ui.app.all().find(node => node.tagName === 'DETAILS');
  assert.equal(advanced.open, false, 'Advanced starts closed');
  assert.ok(controls().length <= 9, `a short default view (${controls().length} controls)`);
  const quick = ui.app.all().find(node => node.dataset?.section === 'quick').text();
  assert.match(quick, /Auto \(Jev\) Auto .* Jev key \(OpenRouter\) Not saved\. Used only for Jev's own decisions, never for model calls/u);
  assert.match(quick, /Cheaper Balanced Better/u);
  assert.match(quick, /Daily limit, \$/u);
  assert.match(quick, /\$0\.39 google\/gemini-3\.1-pro-preview · writing, large · several models · \$0\.1840/u);
  assert.doesNotMatch(quick, /D0|D1|D2|D3|tier|effort|upstream|cohort|8 \/ 5 \/ 3/u, 'no jargon in the default view');
  // Paste the key: the Jev · OpenRouter decision model is added, the key stored for OpenRouter's address only, then the service sets Jev and Auto up.
  const key = ['sk', 'or', 'v1', 'a'.repeat(24)].join('-');
  const input = ui.app.all().find(node => node.name === 'quick-key');
  input.value = key;
  ui.app.all().find(node => node.name === 'quick-key-save').click();
  await settle(); await settle();
  assert.equal(main.settings.backends[0].preset, 'openrouter');
  assert.deepEqual(secrets, [{ key: 'assistant-openrouter', value: JSON.stringify({ origin: 'https://openrouter.ai', value: key }) }]);
  assert.ok(ui.requests.some(r => r.method === 'quickKeySaved' && r.params.backendId === main.settings.backends[0].id));
  assert.equal(input.value, '', 'cleared once stored');
  await settle();
  assert.match(ui.app.all().find(node => node.dataset?.section === 'quick').text(), /Jev key \(OpenRouter\) Saved\./u);
  assert.equal(auto.settings.upstreams.length, 2, 'the key adds no Auto upstream: OpenRouter serves only Jev');
  // The OpenRouter upstream saved before the rule: shown off, with a note.
  assert.ok(ui.app.all().some(node => node.dataset?.note === 'jev-only'));
  // Auto off and on: the person's providers; the OpenRouter one stays off.
  const toggle = () => ui.app.all().find(node => node.name === 'auto-on');
  assert.equal(toggle().checked, true);
  toggle().checked = false;
  for (const listener of toggle().listeners.change) listener();
  await settle();
  assert.equal(auto.settings.upstreams[0].enabled, false);
  await settle();
  toggle().checked = true;
  for (const listener of toggle().listeners.change) listener();
  await settle();
  assert.deepEqual(auto.settings.upstreams.map(u => u.enabled), [true, false], JSON.stringify(ui.requests.filter(r => r.method === 'auto.save').map(r => r.params.settings.upstreams.map(u => u.enabled))) + String(toggle().checked));
  // Russian: the same view, no English.
  ui.context('ru', 'night');
  const ru = ui.app.all().find(node => node.dataset?.section === 'quick').text();
  assert.match(ru, /Ключ Jev \(OpenRouter\) Сохранён\./u);
  assert.match(ru, /Дешевле Сбалансированно Лучше/u);
  assert.match(ru, /Предел в день, \$/u);
  assert.match(ru, /исследование|тексты/u);
  assert.doesNotMatch(ru, /Auto[^ ]|Cheaper|Daily|calls|several|saved|writing/u, 'no English in the Russian default view');
  assert.match(ui.app.all().find(node => node.tagName === 'DETAILS').text(), /Дополнительно/u);
});

test('re-audit: today is consistent after a restart; a model on your own server is behind its link; no daily limit twice; plain words in Advanced', async () => {
  const { DEFAULT_ASSISTANT_SETTINGS } = await import('../src/shared/settings.ts');
  const auto = {
    jevKey: true,
    settings: { upstreams: [{ id: 'openrouter', preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', trust: 'D1', key: 'jev', models: [], allModels: true, excluded: [], enabled: true }], preference: 'balanced', cheaperFallback: false, decider: 'jev', dailyUsdCap: 1, perCardUsdCap: 0.4, catalog: { autoRefresh: true, refreshHours: 168 } },
    readable: true, keys: { openrouter: true }, recent: [],
    // After a restart: this run made no calls yet, the day's spend and paid calls come from disk.
    stats: { requests: 0, turns: 0, continuations: 0, small: 0, jevAsked: 0, jevAnswered: 0, rules: 0, leaseReuses: 0, failovers: 0, hosts: [], spentToday: 0.39, callsToday: 14, listening: false, cards: 0 }
  };
  const ui = page('settings/assistant.js', {
    state: { settings: structuredClone(DEFAULT_ASSISTANT_SETTINGS), status: { enabled: false, backends: [] }, slots: {}, checks: {}, recent: [] },
    'auto.state': auto, 'auto.save': ({ settings }) => settings
  }, { secrets: { set: async () => undefined, delete: async () => undefined } });
  await settle();
  ui.context('ru', 'night');
  const quick = ui.app.all().find(node => node.dataset?.section === 'quick').text();
  assert.match(quick, /\$0\.39 · вызовов: 14/u);
  assert.doesNotMatch(quick, /Ходов пока не было/u, 'no "nothing yet" next to a spend');
  const all = ui.app.all();
  const presets = all.find(node => node.name === 'preset').children.map(option => option.value);
  assert.ok(!presets.includes('emulated') && !presets.includes('laya') && presets.includes('openrouter'), presets.join());
  all.find(node => node.name === 'add-local').click();
  assert.ok(ui.app.all().find(node => node.name === 'preset').children.some(option => option.value === 'emulated'), 'shown after the link');
  assert.equal(ui.app.all().filter(node => node.name === 'auto-daily').length, 0, 'the daily limit only in the short view');
  const text = ui.app.text();
  assert.doesNotMatch(text, /R²|пояснени|окна качества|баллов от лучшей|typesafe|TypeSafe/u, 'no jargon left');
});
