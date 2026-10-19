import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isCredentialPath, isProtectedRel, realish } from './commandFacts.ts';
import { gitConfigSafe } from './gitConfig.ts';

/**
 * Plain read-only inspection for the trust chain (reviewService.ts decides when it applies). One command, words
 * only: bare words, or quoted words with nothing to expand ('…' or "…" without $, `, \ or !). No operators,
 * redirects, globs, `NAME=value`, or anything the shell would expand. A strict allowlist of programs and flags:
 *
 * - `pwd`; `ls [-flags] [paths]`; `cat [-n] <files>`; `head`/`tail [-n N | -N] <files>`; `wc [-l|-w|-c|-m] <files>`;
 * - `git status|diff|log` with only the listed flags (no --output, --ext-diff, --textconv, --show-signature, -c), in a
 *   repository whose own configuration starts no other program (gitConfig.ts).
 *
 * Every path is inside the project (after symlinks), and never a credential or protected path (.git included).
 * Why a separate rule rather than another "serves" bar: the review's question set is pinned and calibrated (its hash
 * is checked); looking at the project is safe whatever the task says, so a deterministic rule is the honest answer.
 */
const WORD = /^(?:[A-Za-z0-9_\-.,/:@+]+|'[^'\n]*'|"[^"$`\\!\n]*")+$/u;
const UNQUOTED_GLOB = /[*?[\]{}~]/u;

/** Words of a plain command (quotes removed), or null when it has any shell syntax beyond plain quoting. */
export function plainWords(command: string): string[] | null {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 1_000 || /[\n\r\t]/u.test(trimmed)) return null;
  const words: string[] = [];
  for (const word of trimmed.split(/ +/u)) {
    if (!WORD.test(word)) return null;
    // Glob characters only inside quotes (where the shell does not expand them).
    const bare = word.replace(/'[^']*'|"[^"]*"/gu, '');
    // `=` only inside a flag (`--stat=…`): a leading `NAME=value` would set the program's environment.
    if (UNQUOTED_GLOB.test(bare) || bare.includes('=') && (!words.length || !bare.startsWith('-'))) return null;
    words.push(word.replace(/'([^']*)'|"([^"]*)"/gu, (_m, a, b) => a ?? b));
  }
  return words;
}

const GIT_FLAGS: Readonly<Record<string, RegExp>> = {
  status: /^(?:-s|--short|-b|--branch|--porcelain|--porcelain=v[12]|-u|-uno|--untracked-files=(?:no|normal|all)|--no-renames)$/u,
  diff: /^(?:--stat|--numstat|--shortstat|--name-only|--name-status|--cached|--staged|-U\d{1,3}|--unified=\d{1,3}|--no-color|--color=never|--no-ext-diff|--no-textconv|-w|--ignore-all-space|--)$/u,
  log: /^(?:--oneline|-\d{1,4}|-n|--max-count=\d{1,4}|--stat|--name-only|--name-status|-p|--patch|--no-color|--graph|--decorate|--no-decorate|--format=[A-Za-z%:() -]{1,40}|--pretty=(?:oneline|short|medium|full|fuller)|--no-ext-diff|--no-textconv|--)$/u
};
/** A revision or count word git log/diff takes that is not a path (HEAD, HEAD~2, main..HEAD, a hash, a number). */
const REVISION = /^(?:HEAD(?:[~^]\d{0,3})*|[0-9a-f]{7,40}|[A-Za-z0-9._/-]+\.\.[A-Za-z0-9._/~^-]+|\d{1,4})$/u;
/** Whether `command`, run in `cwd`, is plain inspection inside `root`. */
export function plainInspection(command: string, cwd: string, root: string): boolean {
  const words = plainWords(command);
  if (!words?.length) return false;
  const rootReal = realish(resolve(root));
  const here = realish(resolve(cwd));
  const insideRoot = (abs: string): boolean => abs === rootReal || abs.startsWith(`${rootReal}${sep}`);
  if (!insideRoot(here)) return false;
  const pathOk = (word: string): boolean => {
    const abs = realish(isAbsolute(word) ? word : resolve(here, word));
    if (!insideRoot(abs) || isCredentialPath(abs)) return false;
    const rel = relative(rootReal, abs).split(sep).join('/');
    return !rel || !isProtectedRel(rel) && !/(?:^|\/)\.git(?:\/|$)/u.test(rel);
  };
  const [program, ...args] = words;
  switch (program) {
    case 'pwd': return args.length === 0;
    case 'ls': {
      const paths = args.filter(arg => !/^-[A-Za-z1]+$/u.test(arg));
      return paths.every(path => !path.startsWith('-') && pathOk(path));
    }
    case 'cat': case 'head': case 'tail': case 'wc': {
      const paths: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (program === 'cat' && arg === '-n') continue;
        if ((program === 'head' || program === 'tail') && /^-\d{1,6}$/u.test(arg)) continue;
        if ((program === 'head' || program === 'tail') && arg === '-n' && /^\d{1,6}$/u.test(args[i + 1] ?? '')) { i++; continue; }
        if (program === 'wc' && /^-[lwcm]+$/u.test(arg)) continue;
        if (arg.startsWith('-')) return false;
        paths.push(arg);
      }
      return paths.length > 0 && paths.every(path => {
        if (!pathOk(path)) return false;
        try { return statSync(realish(isAbsolute(path) ? path : resolve(here, path))).isFile(); } catch { return false; }
      });
    }
    case 'git': {
      const [sub, ...rest] = args;
      const flags = sub ? GIT_FLAGS[sub] : undefined;
      if (!flags || !gitConfigSafe(here)) return false;
      let afterDashes = false;
      for (const arg of rest) {
        if (arg === '--') { afterDashes = true; continue; }
        if (!afterDashes && arg.startsWith('-')) { if (!flags.test(arg)) return false; continue; }
        if (!afterDashes && sub !== 'status' && REVISION.test(arg)) continue;
        if (!pathOk(arg)) return false;
      }
      return true;
    }
    default: return false;
  }
}
