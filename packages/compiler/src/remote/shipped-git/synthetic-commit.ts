/**
 * The synthetic commit of a dirty tree: one commit on HEAD storing what the developer's own
 * `git add <changed paths>` and commit would store. The developer's git builds it with their
 * config, so every content mapping applies (`core.autocrlf`, `core.eol`, `core.fileMode`,
 * `core.symlinks`, repository and global attributes, filter drivers). Only side effects are cut
 * off: a temporary index seeded from HEAD, a temporary object directory (the developer's objects
 * read as alternates), and no hooks, fsmonitor, split index, signing, lazy fetch or automatic
 * maintenance. The build writes no ref, index, object, reflog or config in the developer's
 * repository. The hermetic git writes the synthetic tags (`--tag`) into the shipped repository
 * only.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { KICI_GIT_IDENTITY, type GitIdentity } from './git-ship-types.js';
import type { HermeticGit } from './hermetic-git.js';

/** `Name <email>`: a name without angle brackets or line breaks, and an email without spaces. */
const AUTHOR_PATTERN = /^([^<>\r\n\0]+?)\s*<([^<>\s]+)>$/;

/** Parse a `--commit-author` value. */
export function parseCommitAuthor(value: string): GitIdentity {
  const match = AUTHOR_PATTERN.exec(value);
  const name = match?.[1].trim();
  if (!match || !name) {
    throw new Error(`--commit-author must look like "Name <email>", got '${value}'`);
  }
  return { name, email: match[2] };
}

/** A key of the developer's git config, with their own environment; '' when unset. */
function developerConfig(repoRoot: string, key: string): string {
  try {
    return execFileSync('git', ['-C', repoRoot, 'config', '--get', key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/** One identity field, in git's own order: the environment, `author.<key>`, then `user.<key>`. */
function authorField(repoRoot: string, key: 'name' | 'email'): string {
  const fromEnv = process.env[key === 'name' ? 'GIT_AUTHOR_NAME' : 'GIT_AUTHOR_EMAIL'];
  if (fromEnv) return fromEnv;
  return developerConfig(repoRoot, `author.${key}`) || developerConfig(repoRoot, `user.${key}`);
}

/**
 * `override`, else the identity the developer's commit would carry (`GIT_AUTHOR_*`, then
 * `author.*`, then `user.*`), else KiCI when either field is unset.
 */
export function resolveSyntheticAuthor(repoRoot: string, override?: GitIdentity): GitIdentity {
  if (override) return override;
  const name = authorField(repoRoot, 'name');
  const email = authorField(repoRoot, 'email');
  return name && email ? { name, email } : KICI_GIT_IDENTITY;
}

/** Large enough for a big monorepo's path lists. */
const MAX_BUFFER = 256 * 1024 * 1024;

/** Side effects the developer-context git never has. */
const SIDE_EFFECT_FLAGS = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'core.splitIndex=false',
  '-c',
  'core.logAllRefUpdates=false',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
  '-c',
  'commit.gpgSign=false',
];

export interface DeveloperGit {
  run(args: string[], opts?: { env?: Record<string, string>; input?: string }): string;
  /** Where the objects it writes go. */
  objectDir: string;
  /** The developer's own object directory, read as an alternate. */
  developerObjectDir: string;
}

/** The developer's git, environment and config, writing its index and objects under `scratchDir` only. */
export function createDeveloperGit(args: { repoRoot: string; scratchDir: string }): DeveloperGit {
  const objectDir = path.join(args.scratchDir, 'objects');
  mkdirSync(path.join(objectDir, 'pack'), { recursive: true });
  mkdirSync(path.join(objectDir, 'info'), { recursive: true });
  const commonDir = execFileSync('git', ['-C', args.repoRoot, 'rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const developerObjectDir = path.join(path.resolve(args.repoRoot, commonDir), 'objects');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    GIT_INDEX_FILE: path.join(args.scratchDir, 'index'),
    GIT_OBJECT_DIRECTORY: objectDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: developerObjectDir,
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  });
  return {
    objectDir,
    developerObjectDir,
    run(gitArgs, opts) {
      return execFileSync('git', [...SIDE_EFFECT_FLAGS, '-C', args.repoRoot, ...gitArgs], {
        env: { ...env, ...opts?.env },
        input: opts?.input,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    },
  };
}

/**
 * Write the synthetic commit: `baseSha`'s tree with `remove` dropped and `add` re-added from the
 * working tree as `git add` stores them. Removals go first, so a path that turned from a file
 * into a directory (or back) is replaced, not refused.
 *
 * @returns the commit, or null when the tree equals `baseSha`'s tree
 */
export function writeSyntheticCommit(
  git: DeveloperGit,
  args: {
    baseSha: string;
    add: readonly string[];
    remove: readonly string[];
    author: GitIdentity;
    message: string;
  },
): string | null {
  const run = (gitArgs: string[], input?: string): string => git.run(gitArgs, { input }).trim();
  run(['read-tree', args.baseSha]);
  if (args.remove.length > 0) {
    run(['update-index', '--force-remove', '-z', '--stdin'], `${args.remove.join('\0')}\0`);
  }
  if (args.add.length > 0) {
    run(['update-index', '--add', '--replace', '-z', '--stdin'], `${args.add.join('\0')}\0`);
  }
  const tree = run(['write-tree']);
  if (tree === run(['rev-parse', `${args.baseSha}^{tree}`])) return null;
  return git
    .run(['commit-tree', '--no-gpg-sign', '-p', args.baseSha, '-m', args.message, tree], {
      env: {
        GIT_AUTHOR_NAME: args.author.name,
        GIT_AUTHOR_EMAIL: args.author.email,
        GIT_COMMITTER_NAME: KICI_GIT_IDENTITY.name,
        GIT_COMMITTER_EMAIL: KICI_GIT_IDENTITY.email,
      },
    })
    .trim();
}

/** Names git resolves as a special ref before a same-named tag, making the name ambiguous. */
const SPECIAL_REF_NAMES: ReadonlySet<string> = new Set([
  'HEAD',
  '@',
  'FETCH_HEAD',
  'ORIG_HEAD',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_HEAD',
  'AUTO_MERGE',
]);

/**
 * Throw when `name` cannot name a tag. A leading `-` (an option to `git tag`), a special ref name
 * and a `refs/` prefix (both resolve to something else) are refused before git's own check,
 * which accepts all three.
 */
export function validateSyntheticTagName(name: string): void {
  const error = new Error(`--tag '${name}' is not a valid tag name`);
  if (name === '' || name.startsWith('-')) throw error;
  if (SPECIAL_REF_NAMES.has(name)) {
    throw new Error(
      `--tag '${name}' is not a valid tag name: git reserves '${name}' as a special ref name`,
    );
  }
  if (name.startsWith('refs/')) {
    throw new Error(
      `--tag '${name}' is not a valid tag name: a tag name cannot start with 'refs/', ` +
        'which git reads as a full ref name',
    );
  }
  try {
    execFileSync('git', ['check-ref-format', `refs/tags/${name}`], { stdio: 'ignore' });
  } catch {
    throw error;
  }
}

/** Whether `ref` resolves in the repository at `cwd`. */
function resolves(git: HermeticGit, cwd: string, ref: string): boolean {
  try {
    return git.run(['rev-parse', '--verify', '--quiet', ref], { cwd }).trim() !== '';
  } catch {
    return false;
  }
}

/**
 * An unsigned annotated tag per name at `target` in `shipDir`, KiCI as tagger, the name as
 * message. It replaces a developer tag the depth and tag policy shipped.
 *
 * @returns the names that replaced a shipped tag
 */
export function createSyntheticTags(
  git: HermeticGit,
  args: { shipDir: string; names: readonly string[]; target: string },
): { replaced: string[] } {
  const replaced: string[] = [];
  for (const name of new Set(args.names)) {
    const exists = resolves(git, args.shipDir, `refs/tags/${name}`);
    if (exists) replaced.push(name);
    git.run(['tag', '-a', '--no-sign', ...(exists ? ['-f'] : []), '-m', name, name, args.target], {
      cwd: args.shipDir,
      env: {
        GIT_COMMITTER_NAME: KICI_GIT_IDENTITY.name,
        GIT_COMMITTER_EMAIL: KICI_GIT_IDENTITY.email,
      },
    });
  }
  return { replaced };
}
