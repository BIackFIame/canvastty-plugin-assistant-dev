import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gitState, isCredentialPath, isProtectedRel, realish, type GitRunner } from './commandFacts.ts';

/**
 * The trust chain for a test command (the person's switch; reviewService.ts decides when it applies): a subagent may
 * run its tests when the command is a known test runner invocation and every file that runner will execute is one
 * the review already saw whole in this card (same content now) or is tracked in git and unchanged. Pure parsing plus
 * reads of the files themselves; git only through the review's own safe plumbing. Anything it cannot determine is
 * not allowed (the person decides, as before).
 *
 * Runners (a strict allowlist; one plain command, no shell syntax at all, no `=` anywhere, no extra flags):
 * - `node --test <file.mjs|.js|.cjs> …` (explicit files only: discovery could run anything);
 * - `npm test`, `npm t`, `npm run test`, `pnpm test`, `pnpm run test`, `yarn test`, `yarn run test`: the cwd's own
 *   package.json must itself be verified, its `test` script must be a plain `node --test …` or `pytest …` of the same
 *   kind, with no `pretest`/`posttest`, and no package-manager config (.npmrc, .yarnrc, .yarnrc.yml, .pnpmfile.cjs)
 *   between the cwd and the project root (it can name another script shell or node options);
 * - `pytest <file.py> …`, `python -m pytest <file.py> …`, `python3 -m pytest <file.py> …`: every conftest.py from the
 *   test's folder up to the project root is executed and must be verified too; a pytest config in that chain must be
 *   verified and set no `addopts` or plugins.
 * - `go test`, `cargo test` and others compile whole packages (build scripts included): never determinable here.
 *
 * Imports: JavaScript `import … from`, `import '…'`, `export … from`, `import('…')`, `require('…')` with a literal
 * relative path are followed (exact file, or with .js/.mjs/.cjs, or a folder's index.js); `node:` and built-in
 * modules are fine; any other bare specifier (a package) or a non-literal `import(`/`require(` is not determinable.
 * Python `import x` / `from x import …`: a module that is a file in the test's folder or the project root is
 * followed; relative imports are followed; others are the installed environment; `__import__`/`importlib` are not
 * determinable. At most 64 files.
 */
export type TestRunner = 'node' | 'pytest';
export interface ParsedRun { runner: TestRunner; files: string[]; viaPackage: boolean }

/** Shell syntax of any kind, quoting, globbing, expansion, `=` (env assignments, `--flag=`). */
const SHELL_SYNTAX = /[|&;<>()$`\\"'*?{}[\]~!#%=\n\r\t^]/u;
const JS_FILE = /^(?!-)[\w./-]+\.(?:mjs|cjs|js)$/u;
const PY_FILE = /^(?!-)[\w./-]+\.py$/u;
const PACKAGE_TEST = [['npm', 'test'], ['npm', 't'], ['npm', 'run', 'test'], ['pnpm', 'test'], ['pnpm', 'run', 'test'], ['yarn', 'test'], ['yarn', 'run', 'test']];
const PACKAGE_CONFIG = ['.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs'];
const PYTEST_CONFIG = ['pytest.ini', 'tox.ini', 'setup.cfg', 'pyproject.toml'];
export const TEST_CHAIN_MAX_FILES = 64;

/** A plain runner invocation (null: not one this chain knows, or not plain). */
export function parseRunner(command: string, allowPackage = true): ParsedRun | { runner: 'package' } | null {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 1_000 || SHELL_SYNTAX.test(trimmed)) return null;
  const words = trimmed.split(/ +/u);
  if (words[0] === 'node' && words[1] === '--test' && words.length > 2 && words.slice(2).every(word => JS_FILE.test(word))) return { runner: 'node', files: words.slice(2), viaPackage: false };
  const py = words[0] === 'pytest' ? 1 : (words[0] === 'python' || words[0] === 'python3') && words[1] === '-m' && words[2] === 'pytest' ? 3 : 0;
  if (py && words.length > py && words.slice(py).every(word => PY_FILE.test(word))) return { runner: 'pytest', files: words.slice(py), viaPackage: false };
  if (allowPackage && PACKAGE_TEST.some(form => form.length === words.length && form.every((word, i) => words[i] === word))) return { runner: 'package' };
  return null;
}

export interface TestRunInput {
  command: string;
  /** Where the command runs (its own cwd, else the agent's). */
  cwd: string;
  /** The project root. */
  root: string;
  /** Whole contents this card's review allowed: real absolute path → sha256 of the content. */
  reviewed: ReadonlyMap<string, string>;
  git: GitRunner | null;
  signal: AbortSignal;
}
export type TestRunVerdict = { ok: true; runner: TestRunner; files: string[]; viaPackage: boolean } | { ok: false; why: string };

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const isFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };
const BUILTINS = new Set(builtinModules);

/** Literal module specifiers a JavaScript file imports; null when some import cannot be read. */
export function jsImports(source: string): string[] | null {
  const found: string[] = [];
  const literal = /(?:\bimport\s+(?:[\w*{}\s,$]+\s+from\s+)?|\bexport\s+[\w*{}\s,$]+\s+from\s+)(['"])([^'"\n]+)\1/gu;
  for (const match of source.matchAll(literal)) found.push(match[2]!);
  const calls = [...source.matchAll(/\b(?:import|require)\s*\(/gu)].length;
  const literalCalls = [...source.matchAll(/\b(?:import|require)\s*\(\s*(['"])([^'"\n]+)\1\s*\)/gu)];
  if (calls !== literalCalls.length) return null;
  for (const match of literalCalls) found.push(match[2]!);
  return found;
}

/** Module names a Python file imports (`.x` relative ones keep their dots); null when an import is dynamic. */
export function pyImports(source: string): string[] | null {
  if (/\b__import__\s*\(|\bimportlib\b|\bexec\s*\(|\beval\s*\(/u.test(source)) return null;
  const found: string[] = [];
  for (const line of source.split('\n')) {
    const from = /^\s*from\s+(\.*[\w.]*)\s+import\s+([\w\s,.*()]+)/u.exec(line);
    if (from) {
      found.push(from[1]!);
      // `from . import x`: x is a module of that package.
      if (/^\.+$/u.test(from[1]!)) for (const name of from[2]!.replace(/[()]/gu, '').split(',')) { const n = name.trim().split(/\s+/u)[0]; if (n && n !== '*') found.push(`${from[1]}${n}`); }
      continue;
    }
    const plain = /^\s*import\s+([\w\s,.]+)/u.exec(line);
    if (plain) for (const name of plain[1]!.split(',')) { const n = name.trim().split(/\s+/u)[0]; if (n) found.push(n); }
  }
  return found;
}

function resolveJs(spec: string, from: string): string | null | 'builtin' {
  if (spec.startsWith('node:') || BUILTINS.has(spec)) return 'builtin';
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  const base = resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, join(base, 'index.js')]) if (isFile(candidate)) return candidate;
  return null;
}

/** A Python module → a project file, 'external' (the installed environment), or null (relative but missing). */
function resolvePy(name: string, from: string, root: string): string | 'external' | null {
  const dots = /^\.*/u.exec(name)![0].length;
  const parts = name.slice(dots).split('.').filter(Boolean);
  const candidates = (dir: string): string[] => parts.length ? [join(dir, ...parts) + '.py', join(dir, ...parts, '__init__.py')] : [join(dir, '__init__.py')];
  if (dots) {
    let dir = dirname(from);
    for (let i = 1; i < dots; i++) dir = dirname(dir);
    return candidates(dir).find(isFile) ?? null;
  }
  for (const dir of chain(dirname(from), root)) {
    const hit = candidates(dir).find(isFile);
    if (hit) return hit;
    // A package folder of that name is a project module too (its __init__ may be missing: namespace package).
    try { if (parts[0] && statSync(join(dir, parts[0])).isDirectory()) return null; } catch { /* none */ }
  }
  return 'external';
}

/** Folders from `from` up to `root`, inclusive. */
function chain(from: string, root: string): string[] {
  const dirs: string[] = [];
  let dir = from;
  for (;;) {
    dirs.push(dir);
    if (dir === root || !dir.startsWith(`${root}${sep}`)) break;
    dir = dirname(dir);
  }
  return dirs;
}

export async function verifyTestRun(input: TestRunInput): Promise<TestRunVerdict> {
  const root = realish(resolve(input.root));
  const cwd = realish(resolve(input.cwd));
  const inside = (abs: string): boolean => abs === root || abs.startsWith(`${root}${sep}`);
  if (!inside(cwd)) return { ok: false, why: 'the command runs outside the project' };
  let parsed = parseRunner(input.command);
  if (!parsed) return { ok: false, why: 'not a plain known test runner command' };
  const mustCheck: string[] = [];
  let viaPackage = false;
  if (parsed.runner === 'package') {
    for (const dir of chain(cwd, root)) for (const name of PACKAGE_CONFIG) if (isFile(join(dir, name))) return { ok: false, why: `${name} may change how the package manager runs scripts` };
    const manifest = join(cwd, 'package.json');
    if (!isFile(manifest)) return { ok: false, why: 'no package.json in the folder it runs in' };
    let scripts: Record<string, unknown>;
    try { scripts = (JSON.parse(readFileSync(manifest, 'utf8')) as { scripts?: Record<string, unknown> }).scripts ?? {}; } catch { return { ok: false, why: 'package.json cannot be read' }; }
    if (scripts.pretest !== undefined || scripts.posttest !== undefined) return { ok: false, why: 'package.json has pretest or posttest scripts' };
    const inner = typeof scripts.test === 'string' ? parseRunner(scripts.test, false) : null;
    if (!inner || inner.runner === 'package') return { ok: false, why: 'the package\'s test script is not a plain known test runner command' };
    parsed = inner; viaPackage = true;
    mustCheck.push(manifest);
  }
  const run = parsed as ParsedRun;
  const files = run.files.map(file => realish(isAbsolute(file) ? file : resolve(cwd, file)));
  for (const file of files) {
    if (!inside(file) || isCredentialPath(file) || isProtectedRel(relative(root, file).split(sep).join('/'))) return { ok: false, why: 'a test file is outside the project or protected' };
    if (!isFile(file)) return { ok: false, why: 'a test file does not exist' };
  }
  if (run.runner === 'pytest') {
    for (const dir of new Set(files.flatMap(file => chain(dirname(file), root)))) {
      if (isFile(join(dir, 'conftest.py'))) mustCheck.push(join(dir, 'conftest.py'));
      for (const name of PYTEST_CONFIG) {
        const path = join(dir, name);
        if (!isFile(path)) continue;
        let text: string;
        try { text = readFileSync(path, 'utf8'); } catch { return { ok: false, why: `${name} cannot be read` }; }
        if (!/pytest/u.test(text)) continue;
        if (/\baddopts\b|\bplugins\b|(?:^|\s)-p\s/mu.test(text)) return { ok: false, why: `${name} sets pytest options or plugins` };
        mustCheck.push(path);
      }
    }
  }
  // Follow imports from every file that runs.
  const seen = new Set<string>();
  const queue = [...files, ...mustCheck.filter(path => path.endsWith('.py'))];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (seen.size > TEST_CHAIN_MAX_FILES) return { ok: false, why: 'it imports too many files to check' };
    if (!inside(file) || isCredentialPath(file)) return { ok: false, why: 'it imports a file outside the project' };
    let source: string;
    try { source = readFileSync(file, 'utf8'); } catch { return { ok: false, why: 'a file it runs cannot be read' }; }
    if (file.endsWith('.py')) {
      const names = pyImports(source);
      if (!names) return { ok: false, why: 'a file it runs imports modules dynamically' };
      for (const name of names) {
        const hit = resolvePy(name, file, root);
        if (hit === null) return { ok: false, why: 'it imports a project module that cannot be resolved' };
        if (hit !== 'external') queue.push(realish(hit));
      }
    } else {
      const specs = jsImports(source);
      if (!specs) return { ok: false, why: 'a file it runs imports modules dynamically' };
      for (const spec of specs) {
        const hit = resolveJs(spec, file);
        if (hit === null) return { ok: false, why: 'it imports a package or a file that cannot be resolved' };
        if (hit !== 'builtin') queue.push(realish(hit));
      }
    }
  }
  // Every file: the content the review allowed in this card, else tracked in git and unchanged. Read now.
  const all = [...new Set([...seen, ...mustCheck.map(path => realish(path))])];
  const unreviewed = all.filter(path => {
    try { return input.reviewed.get(path) !== sha256(readFileSync(path, 'utf8')); } catch { return true; }
  });
  if (unreviewed.length) {
    if (!input.git) return { ok: false, why: 'a file it runs was not reviewed in this card, or changed since' };
    const state = await gitState(root, unreviewed, input.git, input.signal);
    if (!state || !state.repo || unreviewed.some(path => !state.tracked.has(path) || state.changed.has(path))) return { ok: false, why: 'a file it runs was not reviewed in this card (or changed since) and is not tracked and unchanged in git' };
  }
  return { ok: true, runner: run.runner, files: all.map(path => relative(root, path).split(sep).join('/')), viaPackage };
}
