// The HOME widget «Главный агент» (bundled to apps/main.js): start or show the main agent, and one status line per
// project; a click on a line shows that project's card (or the card waiting for you). Text only.
import { el, errorText, host, onContext, SERVICE, type PageLocale } from './common.ts';
import { CONDUCTOR_TEXT, type ConductorView } from './conductorText.ts';
import { focus } from './conductorSection.ts';

let t = CONDUCTOR_TEXT.en;
let view: ConductorView | null = null;
let busy = false;
let hint: string | null = null;
const root = document.querySelector('#app')!;
const status = document.querySelector('#status')!;
const say = (message: string, error = false): void => { status.textContent = message; status.classList.toggle('is-error', error); };

async function load(): Promise<void> {
  view = await host.service.request(SERVICE, 'conductor.state') as ConductorView;
  render();
}

function start(): void {
  if (!view || busy) return;
  if (view.conductor) { void focus(view.conductor.id, t.focusOld, say); return; }
  busy = true; hint = null; render();
  (host.service.request(SERVICE, 'conductor.start') as Promise<{ started?: boolean; open?: string; code?: string; detail?: string }>)
    .then(async answer => {
      if (answer.open) await focus(answer.open, t.focusOld, say);
      else if (answer.started === false) hint = `${t.codes[answer.code ?? 'refused'] ?? t.codes.refused}${answer.detail ? ` ${answer.detail}` : ''}`;
    }, error => { hint = errorText(error); })
    .finally(() => { busy = false; void load().catch(error => say(errorText(error), true)); });
}

function render(): void {
  if (!view) return;
  const v = view;
  const button = el('button', { type: 'button', className: 'button button--primary', disabled: busy, textContent: v.conductor ? t.open : busy ? t.starting : t.start });
  button.addEventListener('click', start);
  const lines = v.lines.length ? el('div', { className: 'widget-lines' }, ...v.lines.map(line => {
    const row = el('button', { type: 'button', className: `widget-line${line.state === 'approval' ? ' is-warn' : ''}`, textContent: line.text, disabled: !line.focus });
    row.title = line.text;
    row.addEventListener('click', () => { if (line.focus) void focus(line.focus, t.focusOld, say); });
    return row;
  })) : el('p', { className: 'muted', textContent: t.noProjectsWidget });
  const setup = v.checklist.ready ? null : (() => {
    const open = el('button', { type: 'button', className: 'link-button', textContent: t.openPage });
    open.addEventListener('click', () => { host.canvas?.open('settings').catch(error => say(errorText(error), true)); });
    return el('p', { className: 'muted' }, t.widgetSetup, ' ', open);
  })();
  root.replaceChildren(
    el('div', { className: 'row' }, el('h2', { className: 'card__title', textContent: t.title }),
      v.conductor ? el('span', { className: 'muted', textContent: t.status(v.conductor.status) }) : null,
      el('span', { className: 'muted', textContent: t.running(v.running, v.settings.maxProjects) })),
    el('div', { className: 'row' }, button),
    ...([hint ? el('p', { className: 'notice', textContent: hint }) : null, lines, setup] as Array<HTMLElement | null>).filter((node): node is HTMLElement => node !== null));
}

onContext((locale: PageLocale) => { t = CONDUCTOR_TEXT[locale]; render(); });
host.service.onEvent(({ serviceId, event }) => { if (serviceId === SERVICE && (event === 'conductor' || event === 'settings')) void load().catch(error => say(errorText(error), true)); });
// Elapsed minutes in the lines: read again now and then while the tile is visible.
let visible = true;
host.onVisibilityChange?.(state => { visible = state === 'visible'; if (visible) void load().catch(() => undefined); });
setInterval(() => { if (visible) void load().catch(() => undefined); }, 60_000);
load().catch(error => say(errorText(error), true));
