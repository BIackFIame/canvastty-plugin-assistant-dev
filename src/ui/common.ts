// Shared by the plugin's pages (settings, Flow preview, Task board): the host SDK, the palette and locale from
// CanvasTTY's context, and a tiny element helper. Pages render text only (textContent), never HTML.
export type PageLocale = 'en' | 'ru';

export interface PluginHost {
  onContext(listener: (context: { appearance: Appearance }) => void): void;
  service: {
    request(serviceId: string, method: string, params?: unknown): Promise<unknown>;
    onEvent(listener: (event: { serviceId: string; event: string; data: unknown }) => void): void;
  };
  canvas?: { open(contributionId: string): Promise<void> };
  onVisibilityChange?(listener: (state: 'visible' | 'hidden') => void): void;
}

/** What CanvasTTY's context says about the look. `uiScale` (or `scale`) is read when a host version sends it. */
export interface Appearance { locale: string; palette?: string; uiScale?: unknown; scale?: unknown }

export const host = (window as unknown as { CanvasTTYPlugin: PluginHost }).CanvasTTYPlugin;
export const SERVICE = 'assistant';

/**
 * Language, system palette (sage, lilac, night) and, when the host sends it, the interface scale as `--ui-scale` on
 * the root: every size in apps/harness.css is in rem/em from `calc(13px * var(--ui-scale, 1))`.
 */
let lastLocale: PageLocale | null = null;
export function applyAppearance(appearance: Appearance): PageLocale {
  const locale: PageLocale = appearance.locale === 'ru' ? 'ru' : 'en';
  const root = document.documentElement;
  root.lang = locale;
  root.dataset.palette = appearance.palette === 'lilac' || appearance.palette === 'night' ? appearance.palette : 'sage';
  const scale = typeof appearance.uiScale === 'number' ? appearance.uiScale : typeof appearance.scale === 'number' ? appearance.scale : null;
  if (scale !== null && Number.isFinite(scale) && scale >= 0.5 && scale <= 3) root.style?.setProperty('--ui-scale', String(scale));
  // The service hears CanvasTTY's language only when it starts: tell it, so its badges and toasts follow.
  if (locale !== lastLocale) { lastLocale = locale; void host?.service?.request(SERVICE, 'locale', { locale })?.catch?.(() => undefined); }
  return locale;
}

export function onContext(render: (locale: PageLocale) => void): void {
  host.onContext(({ appearance }) => { render(applyAppearance(appearance)); });
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {}, ...children: Array<Node | string | null | false>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(node, rest);
  if (dataset) Object.assign(node.dataset, dataset);
  for (const child of children) if (child !== null && child !== false) node.append(child);
  return node;
}

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 300);

/** A segmented control: one button per choice, the chosen one pressed. */
export function segmented<T extends string>(name: string, value: T, options: Array<[T, string]>, onChange: (value: T) => void): HTMLDivElement {
  const group = el('div', { className: 'segmented', role: 'radiogroup' });
  group.setAttribute('aria-label', name);
  for (const [option, label] of options) {
    const button = el('button', { type: 'button', textContent: label, className: option === value ? 'is-on' : '', dataset: { value: option } });
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(option === value));
    button.addEventListener('click', () => { if (option !== value) onChange(option); });
    group.append(button);
  }
  return group;
}

/** An on/off switch (a checkbox styled as a switch). */
export function toggle(name: string, checked: boolean, label: string, onChange: (checked: boolean) => void): HTMLLabelElement {
  const input = el('input', { type: 'checkbox', checked, name, className: 'switch__input' });
  input.addEventListener('change', () => onChange(input.checked));
  const wrap = el('label', { className: 'switch' }, input, el('span', { className: 'switch__track' }));
  wrap.setAttribute('aria-label', label);
  return wrap;
}

/** One settings row: label and help on the left, one control on the right. */
export function settingRow(label: string, help: string | Node, control: Node): HTMLDivElement {
  const helpNode = typeof help === 'string' ? el('div', { className: 'setting-row__help', textContent: help }) : el('div', { className: 'setting-row__help' }, help);
  return el('div', { className: 'setting-row' },
    el('div', { className: 'setting-row__copy' }, el('div', { className: 'setting-row__label', textContent: label }), helpNode),
    el('div', { className: 'setting-row__control' }, control));
}

/** Runs `refresh` now, or once the person leaves the field they are typing in (a re-render would take the focus). */
let deferred = false;
export function whenIdle(refresh: () => void): void {
  const active = document.activeElement;
  if (active && /^(INPUT|SELECT|TEXTAREA)$/u.test(active.tagName) && active.closest('#app')) {
    if (!deferred) { deferred = true; active.addEventListener('focusout', () => { deferred = false; refresh(); }, { once: true }); }
    return;
  }
  refresh();
}
