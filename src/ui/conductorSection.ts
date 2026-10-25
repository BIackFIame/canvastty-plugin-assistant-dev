// The main agent's section on the Assistant page: start or show it, the setup checklist, «Мои проекты» and its two
// options. Text only (textContent); every folder is checked by the service, never trusted from the page.
import { el, errorText, host, SERVICE, settingRow, toggle } from './common.ts';
import { CONDUCTOR_TEXT, SETTINGS_SECTION, unsupportedMethod, type ConductorLocale, type ConductorView } from './conductorText.ts';

let view: ConductorView | null = null;
let draftPath = '';
let hint: string | null = null;
let busy = false;
/** Host methods this CanvasTTY turned out not to have (asked on the person's click only). */
const missing = new Set<string>();

export async function loadConductor(): Promise<void> {
  view = await (host.service.request(SERVICE, 'conductor.state') as Promise<ConductorView>).catch(() => null);
}

export function conductorSection(locale: ConductorLocale, rerender: () => void, say: (message: string, error?: boolean) => void): HTMLElement | null {
  if (!view) return null;
  const t = CONDUCTOR_TEXT[locale];
  const v = view;
  const act = (work: () => Promise<unknown>): void => {
    if (busy) return;
    busy = true; hint = null; rerender();
    work().catch(error => { hint = errorText(error); }).finally(async () => { busy = false; await loadConductor(); rerender(); });
  };

  // Start, or show the open main agent.
  const main = el('button', { type: 'button', className: 'button button--primary', disabled: busy, textContent: v.conductor ? t.open : busy ? t.starting : t.start });
  main.addEventListener('click', () => {
    if (v.conductor) { void focus(v.conductor.id, t.focusOld, say); return; }
    act(async () => {
      const answer = await host.service.request(SERVICE, 'conductor.start') as { started?: boolean; open?: string; code?: string; detail?: string };
      if (answer.open) { await focus(answer.open, t.focusOld, say); return; }
      if (answer.started === false) hint = `${t.codes[answer.code ?? 'refused'] ?? t.codes.refused}${answer.detail ? ` ${answer.detail}` : ''}`;
    });
  });
  const head = el('div', { className: 'row' }, main,
    v.conductor ? el('span', { className: 'muted', textContent: t.status(v.conductor.status) }) : null,
    el('span', { className: 'muted', textContent: t.running(v.running, v.settings.maxProjects) }));

  // The setup checklist.
  const grants = v.checklist.items.filter(item => item.state !== 'ok' && item.state !== 'unsupported').flatMap(item => item.grants ?? []);
  const bundle = el('button', { type: 'button', className: 'button', textContent: t.allowMissing, disabled: busy || !grants.length || missing.has('grants.request') });
  bundle.addEventListener('click', () => act(async () => {
    if (!host.request) { missing.add('grants.request'); hint = t.noBundle; return; }
    try { await host.request('grants.request', { reason: t.title, items: grants }); } catch (error) {
      if (unsupportedMethod(error)) { missing.add('grants.request'); hint = t.noBundle; return; }
      throw error;
    }
  }));
  const rows = v.checklist.items.map(item => {
    const [label, path] = t.items[item.id] ?? [item.id, ''];
    const tag = el('span', { className: `tag${item.state === 'ok' ? '' : ' tag--warn'}`, textContent: `${t.state[item.state] ?? item.state}${item.optional && item.state !== 'ok' ? ` · ${t.optional}` : ''}` });
    const section = SETTINGS_SECTION[item.section];
    let control: Node = tag;
    if (item.state !== 'ok' && section && !missing.has('settings.open')) {
      const open = el('button', { type: 'button', className: 'link-button', textContent: t.openSettings });
      open.addEventListener('click', () => {
        if (!host.request) { missing.add('settings.open'); rerender(); return; }
        host.request('settings.open', { section }).catch(error => { if (unsupportedMethod(error)) { missing.add('settings.open'); rerender(); } else say(errorText(error), true); });
      });
      control = el('div', { className: 'row' }, tag, open);
    }
    const help = item.state === 'ok' ? '' : `${missing.has('settings.open') && section ? `${t.noOpen} ` : ''}${path}`;
    return settingRow(`${label}${item.count ? t.count(item.count) : ''}`, help, control);
  });
  const checklist = el('div', { className: 'setting-group' }, ...rows);

  // «Мои проекты».
  const list = v.settings.projects.length ? el('div', { className: 'setting-group' }, ...v.settings.projects.map(project => {
    const remove = el('button', { type: 'button', className: 'link-button', textContent: t.remove, disabled: busy });
    remove.addEventListener('click', () => act(() => host.service.request(SERVICE, 'conductor.removeProject', { projectId: project.id })));
    return settingRow(project.name, project.path, remove);
  })) : el('p', { className: 'muted', textContent: t.noProjects });
  const add = (path: string): void => act(async () => {
    const answer = await host.service.request(SERVICE, 'conductor.addProject', { path }) as { project?: unknown; refused?: string };
    if (answer.refused) hint = t.refused[answer.refused] ?? answer.refused;
    else { draftPath = ''; say(t.saved); }
  });
  const input = el('input', { className: 'input', name: 'projectPath', value: draftPath, maxLength: 1024, spellcheck: false, placeholder: t.pathPlaceholder });
  input.addEventListener('input', () => { draftPath = input.value; });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && draftPath.trim()) add(draftPath); });
  const addButton = el('button', { type: 'button', className: 'button', textContent: t.add, disabled: busy });
  addButton.addEventListener('click', () => { if (draftPath.trim()) add(draftPath); });
  // CanvasTTY's own folder dialog where the host has one (C6); the service checks the folder either way.
  const pick = missing.has('folders.pick') || !host.request ? null : el('button', { type: 'button', className: 'link-button', textContent: t.pick, disabled: busy });
  pick?.addEventListener('click', () => {
    host.request!('folders.pick', {}).then(picked => {
      const path = typeof picked === 'string' ? picked : picked && typeof picked === 'object' && typeof (picked as { path?: unknown }).path === 'string' ? (picked as { path: string }).path : '';
      if (path) add(path);
    }, error => { if (unsupportedMethod(error)) { missing.add('folders.pick'); rerender(); } else say(errorText(error), true); });
  });
  const suggestions = v.suggestions.length ? el('div', { className: 'setting-group' },
    el('div', { className: 'muted', textContent: t.suggest }),
    ...v.suggestions.map(path => {
      const button = el('button', { type: 'button', className: 'link-button', textContent: t.add, disabled: busy });
      button.addEventListener('click', () => add(path));
      return settingRow(path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path, path, button);
    })) : null;

  // Options.
  const save = (change: Record<string, unknown>): void => act(() => host.service.request(SERVICE, 'conductor.save', { settings: change }).then(() => say(t.saved)));
  const max = el('select', { className: 'select', name: 'maxProjects', disabled: busy }, ...[1, 2, 3, 4, 5, 6, 8, 10, 12, 15].map(n => el('option', { value: String(n), textContent: String(n), selected: n === v.settings.maxProjects })));
  max.addEventListener('change', () => save({ maxProjects: Number(max.value) }));

  return el('section', { className: 'card' },
    el('h2', { className: 'card__title', textContent: t.title }),
    el('p', { className: 'muted', textContent: t.help }),
    head,
    hint ? el('p', { className: 'notice', textContent: hint }) : null,
    el('h3', { className: 'card__title', textContent: t.checklist }),
    checklist,
    el('div', { className: 'row' }, bundle, el('span', { className: 'muted', textContent: missing.has('grants.request') ? t.noBundle : t.allowHelp })),
    el('h3', { className: 'card__title', textContent: t.projects }),
    el('p', { className: 'muted', textContent: t.projectsHelp }),
    list,
    el('div', { className: 'row' }, input, addButton, pick),
    suggestions,
    el('div', { className: 'setting-group' },
      settingRow(t.push, t.pushHelp, toggle('conductorPush', v.settings.push, t.push, value => save({ push: value }))),
      settingRow(t.max, t.maxHelp, max)),
    el('p', { className: 'muted', textContent: t.folderLine(v.folder) }));
}

/** Shows a card on the canvas (CanvasTTY answers only a click or key press in this frame). */
export async function focus(sessionId: string, old: string, say: (message: string, error?: boolean) => void): Promise<void> {
  if (!host.request) { say(old, true); return; }
  try { await host.request('sessions.focus', { sessionId }); } catch (error) { say(unsupportedMethod(error) ? old : errorText(error), true); }
}
