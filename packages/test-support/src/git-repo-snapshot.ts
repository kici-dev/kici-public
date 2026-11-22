/**
 * A fingerprint of a git repository's on-disk state, for property tests that
 * assert an operation leaves a repository untouched: take one before, one
 * after, and compare.
 *
 * The fingerprint covers the objects, the refs, the index (content and
 * mtime), every reflog, the working-tree status, the stashes, and every file
 * of the git directory (and, for a linked worktree, of the common directory)
 * with its content hash; object files are listed with their sizes. Taking it never writes the
 * repository: the index is read before any git call, and every git call runs
 * with `GIT_OPTIONAL_LOCKS=0`, so `git status` does not refresh the index.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** The git directory of the repository at `dir`, following a worktree's `.git` file. */
function gitDirOf(dir: string): string {
  const dotGit = path.join(dir, '.git');
  if (statSync(dotGit).isDirectory()) return dotGit;
  const match = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, 'utf8'));
  if (!match) throw new Error(`${dotGit} is neither a directory nor a gitdir file`);
  return path.resolve(dir, match[1].trim());
}

function indexFingerprint(gitDir: string): string {
  const index = path.join(gitDir, 'index');
  if (!existsSync(index)) return 'index: absent';
  const { mtimeNs } = statSync(index, { bigint: true });
  const digest = createHash('sha256').update(readFileSync(index)).digest('hex');
  return `index: ${digest} ${mtimeNs}`;
}

/** The common git directory of a linked worktree's git directory, else undefined. */
function commonDirOf(gitDir: string): string | undefined {
  const file = path.join(gitDir, 'commondir');
  if (!existsSync(file)) return undefined;
  return path.resolve(gitDir, readFileSync(file, 'utf8').trim());
}

/**
 * Every entry under `root`. A file outside `objects/` carries its content
 * hash, so a same-size rewrite (a config value of the same length) shows;
 * an object file, whose name is its content, carries its size.
 */
function listing(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
    const full = path.join(root, entryRel);
    if (entry.isDirectory()) {
      out.push(`${entryRel}/`, ...listing(root, entryRel));
    } else if (entryRel.startsWith('objects/') || !entry.isFile()) {
      out.push(`${entryRel} ${statSync(full, { throwIfNoEntry: false })?.size ?? 'dangling'}`);
    } else {
      out.push(`${entryRel} ${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
    }
  }
  return out;
}

/** The environment of the snapshot's git calls: no inherited `GIT_*` variable, no optional lock. */
function snapshotEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

export async function snapshotRepo(dir: string): Promise<string> {
  const gitDir = gitDirOf(dir);
  // First, before any git call can touch the index.
  const index = indexFingerprint(gitDir);
  const commonDir = commonDirOf(gitDir);
  const env = snapshotEnv();
  const git = (args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  return [
    index,
    `refs:\n${git(['for-each-ref'])}`,
    `objects:\n${git(['count-objects', '-v'])}`,
    `reflog:\n${git(['log', '-g', '--all', '--format=%H%gs'])}`,
    `status:\n${git(['--no-optional-locks', 'status', '--porcelain=v1', '-z'])}`,
    `stash:\n${git(['stash', 'list'])}`,
    `git dir:\n${listing(gitDir).sort().join('\n')}`,
    `common dir:\n${commonDir ? listing(commonDir).sort().join('\n') : '(none)'}`,
  ].join('\n');
}
