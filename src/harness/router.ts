/**
 * Routing as an orchestrator tool. The orchestrator asks `route` before `spawn_agent` and passes what it gets back
 * (provider, model, effort) to CanvasTTY's own `spawn_agent`; nothing is started here and CanvasTTY still checks
 * every value. The difficulty comes from a decision model (Jev, when one is set up and its data rules allow the
 * task text) or else from simple word rules; the model list is the one `list_providers` returned, passed in by the
 * orchestrator. Accounts stay with the accounts plugin: its own tool returns launch options for `spawn_agent`.
 */
export type Difficulty = 'simple' | 'normal' | 'hard';

/** One entry of CanvasTTY's `list_providers().providers`, as much of it as routing reads. */
export interface ProviderEntry {
  id: string;
  available?: boolean;
  signIn?: string;
  subagent?: boolean;
  model?: { supported?: boolean; known?: string[] };
  efforts?: string[];
  launchOptions?: Array<{ pluginId?: string; fields?: Array<{ key?: string }> }>;
}

export interface RouteSuggestion {
  provider: string;
  model?: string;
  effort?: string;
  difficulty: Difficulty;
  source: 'model' | 'rules';
  reason: string;
  /** Plugin tools that pick an account or route for `spawn_agent.launchOptions` (from `launchOptionTools`). */
  accountTool?: string;
  /** Model: Auto (Jev) for the subagent: pass as `spawn_agent.launchOptions`; the router picks the model per turn. */
  launchOptions?: Record<string, Record<string, string>>;
}

const HARD = /\b(?:design|architect\w*|migrat\w*|security|threat|auth\w*|permission model|concurren\w*|race|deadlock|intermittent|protocol|schema|refactor\w* (?:the|all|across)|across (?:services|modules|the codebase)|root cause|investigate|performance regression|data loss)\b|архитектур|миграц|безопасн|гонк|взаимоблок|протокол|расследова/iu;
const SIMPLE = /\b(?:typo|rename|format\w*|lint\w*|bump|changelog|readme|comment\w*|label|sort|import|spelling|whitespace|version string|run (?:the )?(?:unit )?tests)\b|опечатк|переименова|форматир|отсортир/iu;

/** Word rules, used when no decision model answers. */
export function ruleDifficulty(task: string): Difficulty {
  const text = task.slice(0, 4_000);
  if (HARD.test(text)) return 'hard';
  if (SIMPLE.test(text) && text.length < 400) return 'simple';
  return 'normal';
}

const SMALL_MODEL = /(?:flash|mini|haiku|small|fast|lite|nano|instant|luna)/iu;
const STRONG_MODEL = /(?:opus|\bo[13]\b|-pro\b|\bpro\b|ultra|large|reasoner|thinking|astra|max)/iu;
/** 1 small … 5 strong, from the model name only. */
export function modelRank(name: string): number { return SMALL_MODEL.test(name) ? 1 : STRONG_MODEL.test(name) ? 5 : 3; }

const PREFERENCE = ['codex', 'claude', 'opencode', 'qwen', 'grok', 'kimi', 'hermes'];

function usable(entry: ProviderEntry): boolean {
  return entry.available !== false && entry.subagent !== false && entry.signIn !== 'signed_out' && entry.signIn !== 'expired';
}

function pickModel(entry: ProviderEntry | undefined, difficulty: Difficulty): string | undefined {
  const listed = entry?.model && typeof entry.model === 'object' && Array.isArray(entry.model.known) ? entry.model.known : [];
  const known = entry?.model?.supported === false ? [] : listed.filter(name => typeof name === 'string' && name.length > 0 && name.length <= 200).slice(0, 64);
  if (!known.length || difficulty === 'normal') return undefined;
  const ranked = [...known].sort((a, b) => modelRank(a) - modelRank(b));
  const chosen = difficulty === 'simple' ? ranked[0]! : ranked.at(-1)!;
  // A list of same-rank names says nothing: keep the provider default.
  return modelRank(chosen) === 3 && ranked.every(name => modelRank(name) === 3) ? undefined : chosen;
}

function pickEffort(entry: ProviderEntry | undefined, difficulty: Difficulty): string | undefined {
  const efforts = Array.isArray(entry?.efforts) ? entry.efforts.filter(effort => typeof effort === 'string') : [];
  if (difficulty === 'simple') return efforts.find(effort => effort === 'low');
  if (difficulty === 'hard') return efforts.find(effort => effort === 'high') ?? efforts.find(effort => effort === 'xhigh');
  return undefined;
}

export function suggestRoute(input: {
  difficulty: Difficulty; source: 'model' | 'rules'; callerProvider: string | null; providers: ProviderEntry[];
  prefer?: string | null; launchOptionTools?: string[];
  /** The caller runs on Auto (Jev): an OpenCode subagent gets it too, instead of a fixed model. */
  autoLaunchOptions?: Record<string, Record<string, string>> | null;
}): RouteSuggestion | null {
  const listed = (Array.isArray(input.providers) ? input.providers : []).filter(entry => entry && typeof entry === 'object' && typeof entry.id === 'string');
  const candidates = listed.filter(usable);
  const byId = (id: string | null | undefined): ProviderEntry | undefined => id ? candidates.find(entry => entry.id === id) : undefined;
  let entry = byId(input.prefer) ?? byId(input.callerProvider);
  if (!entry) entry = [...candidates].sort((a, b) => rank(a.id) - rank(b.id))[0];
  let provider = entry?.id ?? null;
  if (!provider && !listed.length) provider = input.prefer || input.callerProvider;
  if (!provider) return null;
  // On Auto the router chooses the model each turn; a fixed model here would override it.
  const auto = provider === 'opencode' && input.autoLaunchOptions ? input.autoLaunchOptions : null;
  const model = auto ? undefined : pickModel(entry, input.difficulty);
  const effort = auto ? undefined : pickEffort(entry, input.difficulty);
  const accountTool = (Array.isArray(input.launchOptionTools) ? input.launchOptionTools : []).find(name => typeof name === 'string' && /__(?:pick_account|pick_route)$/u.test(name));
  const why = input.difficulty === 'simple' ? 'a routine task: a small, quick model is enough'
    : input.difficulty === 'hard' ? 'a difficult task: use the strongest model offered'
      : 'a task of ordinary difficulty: the provider default fits';
  const from = input.source === 'model' ? 'the decision model' : 'word rules (no decision model answered)';
  const keep = entry && entry.id === input.callerProvider ? 'your own provider' : entry ? 'the first available provider' : 'your own provider (no provider list was given)';
  return {
    provider, ...(model ? { model } : {}), ...(effort ? { effort } : {}), difficulty: input.difficulty, source: input.source,
    reason: auto ? `you run on Model: Auto (Jev), so the subagent does too: its model is chosen per turn (difficulty from ${from}; ${keep}).` : `${why} (difficulty from ${from}; ${keep}).`,
    ...(accountTool && !auto ? { accountTool } : {}),
    ...(auto ? { launchOptions: auto } : {})
  };
}

const rank = (id: string): number => { const index = PREFERENCE.indexOf(id); return index < 0 ? PREFERENCE.length : index; };

/** The tool's text for the orchestrator: one line to read and the JSON to pass on. */
export function routeAnswer(suggestion: RouteSuggestion): string {
  const spawn = { provider: suggestion.provider, ...(suggestion.model ? { model: suggestion.model } : {}), ...(suggestion.effort ? { effort: suggestion.effort } : {}), ...(suggestion.launchOptions ? { launchOptions: suggestion.launchOptions } : {}) };
  const lines = [
    `Suggested: ${suggestion.provider}${suggestion.launchOptions ? ' on Model: Auto (Jev) (do not pass a model)' : suggestion.model ? ` / ${suggestion.model}` : ' (its default model)'}${suggestion.effort ? `, effort ${suggestion.effort}` : ''}. Why: ${suggestion.reason}`,
    `Pass these to spawn_agent: ${JSON.stringify(spawn)}.`,
    suggestion.accountTool ? `To choose an account, call ${suggestion.accountTool} and pass what it returns as spawn_agent.launchOptions.` : ''
  ].filter(Boolean);
  return `${lines.join('\n')}\n${JSON.stringify({ ...suggestion, spawn })}`;
}
