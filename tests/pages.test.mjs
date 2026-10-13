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

function page(file, replies) {
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
    canvas: { open: async id => { requests.push({ method: 'canvas.open', params: id }); } }
  };
  const document = { documentElement: html, activeElement: null, createElement: tag => new Node(tag), querySelector: selector => selector === '#app' ? app : status };
  vm.runInNewContext(readFileSync(join(root, file), 'utf8'), { window: { CanvasTTYPlugin: sdk }, document, console, setTimeout, clearTimeout });
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
