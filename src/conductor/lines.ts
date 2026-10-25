/**
 * Status lines of the main agent's projects (conductor-design.md §6), built by the Assistant from what it knows,
 * never by a model: «▸ shop-api — работает 12 мин · Claude Code · Max · opus/high · 3 агента · квота 64 %, сброс
 * 18:00». At most 120 characters, in the person's language. No report text ever goes into a line.
 */
export type LineLocale = 'en' | 'ru';

export type LeadState = 'starting' | 'running' | 'waiting' | 'approval' | 'done' | 'blocked' | 'failed' | 'stopped' | 'unavailable';

export interface LineInput {
  name: string;
  state: LeadState;
  /** Minutes since the lead started (running only). */
  minutes?: number | null;
  cli?: string | null;
  account?: string | null;
  model?: string | null;
  effort?: string | null;
  agents?: number;
  quota?: { percent: number | null; resetsAt: number | null } | null;
  /** The card that waits for the person (needs_approval), by its title. */
  waitingCard?: string | null;
  /** A report was filed (read it with result). */
  reported?: boolean;
}

export const MAX_LINE = 120;

const CLI_NAMES: Readonly<Record<string, string>> = { claude: 'Claude Code', codex: 'Codex', qwen: 'Qwen Code', opencode: 'OpenCode', grok: 'Grok', kimi: 'Kimi', gemini: 'Gemini' };
export const cliName = (cli: string | null | undefined): string | null => cli ? CLI_NAMES[cli] ?? cli : null;

const STRINGS = {
  en: {
    state: {
      starting: 'starting', running: 'working', waiting: 'idle', approval: 'waits for your decision', done: 'done', blocked: 'blocked',
      failed: 'failed', stopped: 'stopped', unavailable: 'unavailable'
    } as Record<LeadState, string>,
    minutes: (n: number) => n >= 60 ? `${Math.floor(n / 60)} h ${n % 60} min` : `${n} min`,
    agents: (n: number) => `${n} agent${n === 1 ? '' : 's'}`,
    card: (title: string) => `(card “${title}”)`,
    quota: (percent: number | null, reset: string | null) => `${percent === null ? 'quota ?' : `quota ${percent}%`}${reset ? `, resets ${reset}` : ''}`,
    reported: 'report filed'
  },
  ru: {
    state: {
      starting: 'запускается', running: 'работает', waiting: 'ждёт задачу', approval: 'ждёт вашего решения', done: 'готово', blocked: 'заблокирован',
      failed: 'ошибка', stopped: 'остановлен', unavailable: 'недоступен'
    } as Record<LeadState, string>,
    minutes: (n: number) => n >= 60 ? `${Math.floor(n / 60)} ч ${n % 60} мин` : `${n} мин`,
    agents: (n: number) => `${n} ${plural(n, 'агент', 'агента', 'агентов')}`,
    card: (title: string) => `(карточка «${title}»)`,
    quota: (percent: number | null, reset: string | null) => `${percent === null ? 'квота ?' : `квота ${percent} %`}${reset ? `, сброс ${reset}` : ''}`,
    reported: 'есть отчёт'
  }
};

function plural(n: number, one: string, few: string, many: string): string {
  const tens = n % 100, ones = n % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (ones === 1) return one;
  if (ones >= 2 && ones <= 4) return few;
  return many;
}

/** "18:00" in this computer's time zone. */
export function clock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const tidy = (value: string | null | undefined, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const line = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return line ? line.slice(0, max) : null;
};

export function statusLine(locale: LineLocale, input: LineInput): string {
  const t = STRINGS[locale];
  const name = tidy(input.name, 40) ?? '?';
  let state = t.state[input.state];
  if (input.state === 'running' && typeof input.minutes === 'number' && input.minutes >= 0) state += ` ${t.minutes(Math.round(input.minutes))}`;
  const waiting = input.state === 'approval' ? tidy(input.waitingCard, 40) : null;
  if (waiting) state += ` ${t.card(waiting)}`;
  const model = tidy(input.model, 40);
  const parts = [
    state,
    cliName(input.cli),
    tidy(input.account, 40),
    model ? `${model}${input.effort ? `/${tidy(input.effort, 12)}` : ''}` : null,
    input.agents && input.agents > 0 ? t.agents(input.agents) : null,
    input.quota ? t.quota(input.quota.percent === null ? null : Math.round(input.quota.percent), input.quota.resetsAt ? clock(input.quota.resetsAt) : null) : null,
    input.reported && input.state !== 'approval' ? t.reported : null
  ].filter((part): part is string => !!part);
  const line = `▸ ${name} — ${parts.join(' · ')}`;
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1).trimEnd()}…` : line;
}

/** A listed project nobody started yet. */
export function notStartedLine(locale: LineLocale, name: string): string {
  return `▸ ${tidy(name, 40) ?? '?'} — ${locale === 'ru' ? 'не запущен' : 'not started'}`;
}
