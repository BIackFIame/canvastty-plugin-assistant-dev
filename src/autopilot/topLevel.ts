/**
 * Auto (Jev) on the card's own sign-in (jev-autopilot-design.md §2, D2): for Claude Code and Codex the Assistant
 * contributes only the model and effort Jev chose for that CLI's own subscription, and pins the vendor endpoint so
 * a person-level config cannot redirect the traffic. No proxy, no key: the CLI's own login is used.
 *
 * - Claude Code: `--model <alias>`, `--effort <e>`, and `--settings {"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com"}}`
 *   (the shape CanvasTTY merges into its own settings).
 * - Codex: `--model <id>`, `-c model_reasoning_effort="<e>"`, `-c model_provider="openai"`.
 */
export const OWN_SIGN_IN_CLIS = ['claude', 'codex'] as const;
export type OwnSignInCli = typeof OWN_SIGN_IN_CLIS[number];
export const isOwnSignInCli = (cli: string): cli is OwnSignInCli => (OWN_SIGN_IN_CLIS as readonly string[]).includes(cli);

const EFFORTS: Readonly<Record<OwnSignInCli, readonly string[]>> = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['minimal', 'low', 'medium', 'high', 'xhigh'] };
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,119}$/u;
export const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com';

export function ownSignInArgs(cli: OwnSignInCli, choice: { model: string | null; effort: string | null }): string[] {
  const args: string[] = [];
  if (choice.model && MODEL.test(choice.model)) args.push('--model', choice.model);
  const effort = choice.effort && EFFORTS[cli].includes(choice.effort) ? choice.effort : null;
  if (cli === 'claude') {
    if (effort) args.push('--effort', effort);
    args.push('--settings', JSON.stringify({ env: { ANTHROPIC_BASE_URL: ANTHROPIC_ENDPOINT } }));
  } else {
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    args.push('-c', 'model_provider="openai"');
  }
  return args;
}

/**
 * An OpenCode coding-plan model chosen by pick_route (`provider/model`, from `opencode models`), pinned: OpenCode
 * uses only that provider, for the main model and the small one (titles, summaries).
 */
export function openCodePlanContribution(model: string): { env: Record<string, string>; args: string[]; files: Array<{ relPath: string; content: string }> } | null {
  const match = /^([a-z0-9][a-z0-9._-]{0,63})\/([A-Za-z0-9][A-Za-z0-9._:/@+-]{0,120})$/u.exec(model);
  if (!match || match[1] === 'openrouter') return null;
  const config = { $schema: 'https://opencode.ai/config.json', model, small_model: model, enabled_providers: [match[1]] };
  return { env: { OPENCODE_CONFIG: '{launchFiles}/opencode.json' }, args: ['--model', model], files: [{ relPath: 'opencode.json', content: `${JSON.stringify(config, null, 2)}\n` }] };
}
