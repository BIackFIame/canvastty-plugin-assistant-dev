/**
 * The person's project folders for the main agent (conductor-design.md §3.6): a list the person adds on the
 * Assistant page, by hand. The model never supplies a path: the main agent names a project by the id this list
 * gave it, and the folder is checked again here when a project is started. A folder must be an existing directory
 * (symbolic links resolved), and never the file system root, the home folder itself, a system folder, a folder of
 * keys or agent sign-ins, or CanvasTTY's plugin data.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

export const MAX_PROJECTS = 32;
export const MAX_PATH = 1_024;

export interface Project { id: string; name: string; path: string; addedAt: number }

export type FolderRefusal = 'path' | 'missing' | 'notDirectory' | 'root' | 'home' | 'system' | 'private' | 'conductor';

/** Folders under home that hold keys, tokens or agents' sign-ins: never a project, nor anything inside them. */
const PRIVATE_UNDER_HOME = [
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.password-store', '.config', '.local/share/keyrings',
  '.claude', '.codex', '.grok', '.gemini', '.qwen', '.kimi', '.opencode', '.netrc', 'Library/Keychains',
  'Library/Application Support', 'Library/Containers', 'Library/Group Containers', 'Library/Cookies', 'AppData'
];
/** System folders: never a project, nor anything inside them. */
const SYSTEM = ['/bin', '/sbin', '/usr', '/etc', '/var', '/private', '/System', '/Library', '/dev', '/proc', '/sys', '/boot', '/opt/homebrew', '/Applications'];

/** `inner` is `outer` or inside it (both resolved). */
export function within(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

const resolved = (path: string): string => { try { return realpathSync(path); } catch { return path; } };

/**
 * A folder the person typed or picked, checked: `{ path }` resolved, or the refusal. `home`, the plugin data folder
 * and the main agent's own folder come from the service (not from the page).
 */
export function checkFolder(value: unknown, context: { home: string; dataDir: string; conductorFolder?: string | null }): { path: string } | { refused: FolderRefusal } {
  if (typeof value !== 'string') return { refused: 'path' };
  const raw = value.trim().replace(/[\\/]+$/u, '') || value.trim();
  if (!raw || raw.length > MAX_PATH || /[\u0000-\u001f\u007f]/u.test(raw)) return { refused: 'path' };
  const expanded = raw === '~' ? context.home : raw.startsWith('~/') ? join(context.home, raw.slice(2)) : raw;
  if (!isAbsolute(expanded)) return { refused: 'path' };
  if (!existsSync(expanded)) return { refused: 'missing' };
  let path: string;
  try { path = realpathSync(expanded); } catch { return { refused: 'missing' }; }
  try { if (!statSync(path).isDirectory()) return { refused: 'notDirectory' }; } catch { return { refused: 'missing' }; }
  if (dirname(path) === path) return { refused: 'root' };
  const home = resolved(context.home);
  if (path === home || within(path, home)) return { refused: 'home' };
  for (const folder of SYSTEM) {
    const real = resolved(folder);
    // A project inside the home folder is fine even where home itself lives under a system folder.
    if ((within(folder, path) || within(real, path)) && !within(home, path)) return { refused: 'system' };
  }
  for (const folder of PRIVATE_UNDER_HOME) if (within(resolved(join(home, folder)), path)) return { refused: 'private' };
  // CanvasTTY's plugin data (this plugin's and every other plugin's folders next to it).
  const data = resolved(dirname(context.dataDir));
  if (within(data, path) || within(path, data)) return { refused: 'private' };
  if (context.conductorFolder && within(resolved(context.conductorFolder), path)) return { refused: 'conductor' };
  return { path };
}

/** A short id from the folder name, unique in the list ("shop-api", "shop-api-2"). */
export function projectId(path: string, taken: ReadonlySet<string>): string {
  const base = basename(path).normalize('NFKD').toLowerCase().replace(/[^a-z0-9а-яё]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40) || 'project';
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1_000; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${Date.now().toString(36)}`;
}

/** Saved projects, only well-formed entries (a stored list is re-read, never trusted blindly). */
export function projectsFrom(value: unknown): Project[] {
  if (!Array.isArray(value)) return [];
  const out: Project[] = [];
  for (const entry of value.slice(0, MAX_PROJECTS)) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, name, path, addedAt } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[a-z0-9а-яё][a-z0-9а-яё-]{0,47}$/u.test(id) || out.some(project => project.id === id)) continue;
    if (typeof path !== 'string' || !path || path.length > MAX_PATH || !isAbsolute(path)) continue;
    out.push({ id, name: typeof name === 'string' && name.trim() ? name.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 80) : basename(path), path, addedAt: typeof addedAt === 'number' && Number.isFinite(addedAt) ? addedAt : 0 });
  }
  return out;
}

/** The checked-out branch, read from `.git/HEAD` (no git process); null when not a repository or detached. */
export function gitBranch(path: string): string | null {
  try {
    let gitDir = join(path, '.git');
    if (statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/mu.exec(readFileSync(gitDir, 'utf8'));
      if (!pointer) return null;
      gitDir = isAbsolute(pointer[1]!.trim()) ? pointer[1]!.trim() : join(path, pointer[1]!.trim());
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8');
    const ref = /^ref:\s*refs\/heads\/(.+)$/mu.exec(head);
    return ref ? ref[1]!.trim().slice(0, 120) : null;
  } catch { return null; }
}

export const PATH_SEPARATOR = sep;
