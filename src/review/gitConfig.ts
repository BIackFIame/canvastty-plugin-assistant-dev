import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Whether a read-only git command run in `cwd` could make git start another program through the repository's own
 * configuration: an external diff or a diff driver's command, a textconv, a pager, an fsmonitor, a hooks path, a
 * clean/smudge/process filter, a gpg program or log.showSignature, or any include (which could bring any of those in).
 * Reads the repository's `config`, and for a linked worktree its `config.worktree` and the common folder's `config`.
 * The person's own global and system configuration are theirs and not read. Anything that cannot be read or told is
 * unsafe, so the caller falls through to the normal review: this never denies on its own.
 */
const RISKY_KEY = /^\s*(?:external|command|textconv|pager|fsmonitor|hookspath|clean|smudge|process|program|showsignature)\s*=/imu;
const RISKY_SECTION = /^\s*\[\s*(?:include|includeif|pager|filter|gpg)\b/imu;

function read(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/** The git folders whose configuration applies to `cwd`, or null when no repository is found or it cannot be read. */
function gitDirs(cwd: string): string[] | null {
  let dir = resolve(cwd);
  for (let i = 0; i < 128; i++) {
    const dotGit = join(dir, '.git');
    let stat;
    try { stat = statSync(dotGit); } catch { stat = null; }
    if (stat?.isDirectory()) return [dotGit];
    if (stat?.isFile()) {
      const pointer = /^gitdir:\s*(.+)\s*$/mu.exec(read(dotGit) ?? '')?.[1];
      if (!pointer) return null;
      const gitDir = isAbsolute(pointer) ? pointer : resolve(dir, pointer);
      const common = read(join(gitDir, 'commondir'))?.trim();
      return [gitDir, ...(common ? [isAbsolute(common) ? common : resolve(gitDir, common)] : [])];
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function gitConfigSafe(cwd: string): boolean {
  const dirs = gitDirs(cwd);
  if (!dirs) return false;
  let found = false;
  for (const dir of dirs) {
    for (const name of ['config', 'config.worktree']) {
      const text = read(join(dir, name));
      if (text === null) { if (name === 'config' && dir === dirs.at(-1)) return false; continue; }
      found = true;
      if (RISKY_KEY.test(text) || RISKY_SECTION.test(text)) return false;
    }
  }
  return found;
}
