// The main agent on the Assistant page and the HOME widget, run as bundled against a tiny stand-in DOM and a fake
// host SDK (no browser): ru and en complete, the checklist with its Settings paths, «Мои проекты» (adding goes to the
// service, which checks the folder), the bundled permission request only where the host has `grants.request`, and a
// click on a status line shows that card (sessions.focus).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { CONDUCTOR_TEXT } from '../src/ui/conductorText.ts';

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

function page(file, replies, request = undefined) {
  const app = Object.assign(new Node('main'), { id: 'app' });
  const status = Object.assign(new Node('output'), { id: 'status' });
  const html = new Node('html');
  const requests = [];
  let context = null;
  const sdk = {
    onContext(listener) { context = listener; },
    service: {
      async request(serviceId, method, params) { params = params === undefined ? undefined : JSON.parse(JSON.stringify(params)); requests.push({ serviceId, method, params }); const reply = replies[method]; return typeof reply === 'function' ? reply(params) : reply; },
      onEvent() {}
    },
    canvas: { open: async id => { requests.push({ method: 'canvas.open', params: id }); } },
    ...(request ? { request: async (method, params) => { requests.push({ method: `host:${method}`, params: JSON.parse(JSON.stringify(params ?? null)) }); return request(method, params); } } : {})
  };
  const document = { documentElement: html, activeElement: null, createElement: tag => new Node(tag), querySelector: selector => selector === '#app' ? app : status };
  vm.runInNewContext(readFileSync(join(root, file), 'utf8'), { window: { CanvasTTYPlugin: sdk }, document, console, setTimeout, clearTimeout, setInterval: () => 0, structuredClone, URL });
  return { app, status, requests, context: locale => context({ appearance: { locale, palette: 'sage' } }) };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 15));
const button = (ui, text) => ui.app.all().find(node => node.tagName === 'BUTTON' && node.textContent === text);

const view = (extra = {}) => ({
  settings: { projects: [{ id: 'shop-api', name: 'shop-api', path: '/home/p/code/shop-api' }], push: true, maxProjects: 4 },
  folder: '/home/p/CanvasTTY/main-agent',
  conductor: null,
  lines: [{ projectId: 'shop-api', name: 'shop-api', text: '▸ shop-api — waits for your decision (card “payment fix”)', state: 'approval', sessionId: 'lead-1', focus: 'kid-1' }],
  running: 1, suggestions: ['/home/p/code/landing'],
  checklist: { ready: false, items: [
    { id: 'routing', state: 'ok', section: 'page' },
    { id: 'orchestrators', state: 'missing', section: 'native-code', grants: [{ kind: 'mayStartOrchestrators' }] },
    { id: 'projects', state: 'ok', section: 'page', count: 1 },
    { id: 'broker', state: 'missing', optional: true, section: 'broker', grants: [{ kind: 'brokerGrant', owner: 'canvastty-accounts', account: '*' }] },
    { id: 'trustUpdates', state: 'unknown', optional: true, section: 'native-code', grants: [{ kind: 'trustUpdates', plugin: 'canvastty-assistant' }, { kind: 'trustUpdates', plugin: 'canvastty-environments' }] },
    { id: 'widget', state: 'unknown', optional: true, section: 'home' }
  ] },
  routing: true, ...extra
});
const harness = { commandReview: 'off', custom: null, settingsUnavailable: false, routing: true, loopAlerts: true, flows: true, models: 0 };

test('texts: Russian and English have the same keys, and every checklist item has a label and a path', () => {
  const keys = locale => Object.keys(CONDUCTOR_TEXT[locale]).sort();
  assert.deepEqual(keys('ru'), keys('en'));
  for (const group of ['items', 'refused', 'codes', 'state']) assert.deepEqual(Object.keys(CONDUCTOR_TEXT.ru[group]).sort(), Object.keys(CONDUCTOR_TEXT.en[group]).sort(), group);
  for (const locale of ['ru', 'en']) for (const [id, [label, path]] of Object.entries(CONDUCTOR_TEXT[locale].items)) assert.ok(label && path, `${locale} ${id}`);
  assert.match(CONDUCTOR_TEXT.ru.items.orchestrators[1], /Настройки → Агенты → Нативный код расширений → .* → Может запускать оркестраторов/u);
  assert.match(CONDUCTOR_TEXT.en.items.widget[1], /Settings → Appearance → HOME composition/u);
});

test('Assistant page: the main agent section in both languages; adding a folder goes to the service; the bundle only where the host has grants.request', async () => {
  let added = null;
  const replies = {
    'harness.settings': harness, 'autopilot.entry': { folders: [], servers: false }, 'conductor.state': view(),
    'conductor.addProject': ({ path }) => { added = path; return path.includes('.ssh') ? { refused: 'private' } : { project: { id: 'x' } }; },
    'conductor.start': { started: false, code: 'consent' }
  };
  // A host without grants.request or settings.open (CanvasTTY today).
  const ui = page('settings/harness.js', replies, async method => { throw new Error(`Unsupported plugin method: ${method}.`); });
  await settle();
  ui.context('ru');
  const t = CONDUCTOR_TEXT.ru;
  for (const text of [t.title, t.start, t.checklist, t.items.orchestrators[0], t.items.orchestrators[1], t.projects, '/home/p/code/shop-api', t.suggest, t.push, t.max]) assert.ok(ui.app.text().includes(text), text);
  // Start without consent: the one-line hint, nothing else.
  button(ui, t.start).click();
  await settle();
  assert.ok(ui.app.text().includes(t.codes.consent));
  // A folder from the page: the service decides; its refusal is shown in the page's language.
  const input = ui.app.all().find(node => node.name === 'projectPath');
  input.value = '/home/p/.ssh';
  for (const listener of input.listeners.input) listener();
  button(ui, t.add).click();
  await settle();
  assert.equal(added, '/home/p/.ssh');
  assert.ok(ui.app.text().includes(t.refused.private));
  // The bundled request: CanvasTTY without it says where to give each permission instead.
  button(ui, t.allowMissing).click();
  await settle();
  assert.ok(ui.requests.some(request => request.method === 'host:grants.request'));
  assert.ok(ui.app.text().includes(t.noBundle));
  button(ui, t.openSettings).click();
  await settle();
  assert.ok(ui.app.text().includes(t.noOpen), 'no settings.open: the path to open by hand');
  ui.context('en');
  for (const text of [CONDUCTOR_TEXT.en.title, CONDUCTOR_TEXT.en.items.broker[0], CONDUCTOR_TEXT.en.projects]) assert.ok(ui.app.text().includes(text), text);
});

test('Assistant page: with grants.request the missing items go in one request (trust updates for the Assistant and Environments only)', async () => {
  const asked = [];
  const ui = page('settings/harness.js', { 'harness.settings': harness, 'autopilot.entry': { folders: [], servers: false }, 'conductor.state': view() }, async (method, params) => { asked.push({ method, params }); return { results: [] }; });
  await settle();
  ui.context('en');
  button(ui, CONDUCTOR_TEXT.en.allowMissing).click();
  await settle();
  const request = asked.find(entry => entry.method === 'grants.request');
  assert.ok(request);
  assert.deepEqual(request.params.items, [{ kind: 'mayStartOrchestrators' }, { kind: 'brokerGrant', owner: 'canvastty-accounts', account: '*' }, { kind: 'trustUpdates', plugin: 'canvastty-assistant' }, { kind: 'trustUpdates', plugin: 'canvastty-environments' }]);
  assert.ok(!JSON.stringify(request.params).includes('"plugin":"canvastty-accounts"'), 'never trust updates for Accounts');
  // settings.open: each item's button opens its section (native code is scrolled to; broker grants are under Agents).
  const opens = ui.app.all().filter(node => node.tagName === 'BUTTON' && node.textContent === CONDUCTOR_TEXT.en.openSettings);
  for (const node of opens) node.click();
  await settle();
  assert.deepEqual(asked.filter(entry => entry.method === 'settings.open').map(entry => entry.params.section), ['native-code', 'agents', 'native-code', 'appearance']);
});

test('HOME widget: start or show, one line per project; a click shows the card that waits for the person', async () => {
  const focused = [];
  const ui = page('apps/main.js', { 'conductor.state': view({ conductor: { id: 'main-1', status: 'idle' } }) }, async (method, params) => { if (method === 'sessions.focus') focused.push(params.sessionId); return null; });
  await settle();
  ui.context('ru');
  const t = CONDUCTOR_TEXT.ru;
  assert.ok(ui.app.text().includes(t.title));
  assert.ok(ui.app.text().includes(t.open), 'it runs: show it');
  assert.ok(ui.app.text().includes(t.widgetSetup), 'setup not finished: says so');
  const line = ui.app.all().find(node => node.className?.split(' ')[0] === 'widget-line');
  assert.equal(line.className, 'widget-line is-warn');
  line.click();
  button(ui, t.open).click();
  await settle();
  assert.deepEqual(focused, ['kid-1', 'main-1']);
});
