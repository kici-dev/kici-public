/**
 * Builds the `.git` that `kici run remote` ships: a fresh `git clone` of the developer's
 * repository at the requested depth and tag policy, at their HEAD or, for a dirty tree, at a
 * synthetic commit of the changes on top of it. A `file://` fetch into a temp directory brings
 * only objects reachable from the shipped refs within the depth: the developer's
 * `.git/config`, hooks, reflogs, stashes and unreachable objects never ship. The developer's
 * repository is only read; every write goes through a hermetic git.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { OverlayGitRecord } from '@kici-dev/engine';
import {
  GitObjectFormat,
  GitTagMode,
  SYNTHETIC_COMMIT_MESSAGE,
  type GitShipOptions,
  type ShippedGit,
  type ShippedGitResult,
} from './git-ship-types.js';
import { createHermeticGit, type HermeticGit } from './hermetic-git.js';
import { renderShippedGitConfig, shippedOriginUrl } from './shipped-git-config.js';
import { writeCheckoutBytes } from './checkout-bytes.js';
import {
  createDeveloperGit,
  createSyntheticTags,
  resolveSyntheticAuthor,
  writeSyntheticCommit,
} from './synthetic-commit.js';

/** The object directories a repository borrows from, relative to its `.git`. */
const ALTERNATES_FILE = path.join('objects', 'info', 'alternates');

/** git's default `info/exclude` template, which every clone writes. */
const DEFAULT_INFO_EXCLUDE =
  '# git ls-files --others --exclude-from=.git/info/exclude\n' +
  "# Lines that start with '#' are comments.\n" +
  '# For a project mostly in C, the following would be a good set of\n' +
  '# exclude patterns (uncomment them if you want to use them):\n' +
  '# *.[oa]\n' +
  '# *~\n';

/** A string as one POSIX shell word. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The `--upload-pack` command the fetch runs in the developer's repository.
 *
 * - `GIT_NO_LAZY_FETCH=1`: a partial clone never fetches missing objects from its promisor,
 *   whatever the git default, so nothing is written locally or sent over the network.
 * - `safe.directory`: the hermetic environment drops the global config that trusts a
 *   repository another user owns (a bind mount, a devcontainer, WSL); the developer's own git
 *   just read it, so it is trusted. A local fetch does not pass outer `-c` flags to
 *   upload-pack, which checks the git directory it enters: each spelling of it is trusted,
 *   never `*`.
 * - `uploadpack.allowAnySHA1InWant`: the fetch names HEAD by object id, ref or not.
 */
export function uploadPackCommand(repoRoot: string): string {
  const gitDirs = new Set([path.join(repoRoot, '.git'), path.join(realpathSync(repoRoot), '.git')]);
  const absoluteGitDir = readDeveloperGit(repoRoot, ['rev-parse', '--absolute-git-dir']);
  if (absoluteGitDir) gitDirs.add(absoluteGitDir);
  const trust = [...gitDirs].map((dir) => `-c ${shellQuote(`safe.directory=${dir}`)}`);
  return [
    'GIT_NO_LAZY_FETCH=1 git',
    ...trust,
    '-c uploadpack.allowAnySHA1InWant=true upload-pack',
  ].join(' ');
}

/** Holds a detached HEAD's commit during the fetch; deleted before shipping. */
const TMP_HEAD_REF = 'refs/kici-tmp/head';

/** The unborn branch `git init` names on a detached HEAD; never created. */
const DETACHED_INIT_BRANCH = 'kici-detached';

/** `.git` entries a fresh clone does not carry, removed before shipping. */
const FORBIDDEN_GIT_PATHS = [
  'hooks',
  'logs',
  'FETCH_HEAD',
  'ORIG_HEAD',
  'modules',
  'lfs',
  'worktrees',
  'rr-cache',
  'description',
  'refs/stash',
  'COMMIT_EDITMSG',
];

/**
 * Written only when `refs/` holds no ref file: git refuses a `.git` without `refs/`, the agent
 * recreates files but not empty directories, and git ignores ref names starting with a dot.
 */
const REFS_PLACEHOLDER = path.posix.join('refs', '.kici-keep');

interface SourceRepo {
  baseSha: string;
  branch?: string;
  objectFormat: GitObjectFormat;
  originUrl?: string;
}

/** Read-only git against the developer's repository, with their environment; undefined on a non-zero exit. */
function readDeveloperGit(repoRoot: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function parseObjectFormat(value: string | undefined): GitObjectFormat {
  const format = Object.values(GitObjectFormat).find((f) => f === value);
  if (!format) throw new Error(`Unsupported git object format: ${value ?? '(unknown)'}`);
  return format;
}

/** The error for a repository whose HEAD has no commit yet. */
function unbornError(repoRoot: string): Error {
  return new Error(
    `kici run remote needs at least one commit in ${repoRoot}. Commit your files, then re-run.`,
  );
}

/** Throw for a repository with no commit; a directory outside any repository passes, for its caller. */
export function assertHasCommit(repoRoot: string): void {
  if (readDeveloperGit(repoRoot, ['rev-parse', '--git-dir']) === undefined) return;
  if (!readDeveloperGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'])) {
    throw unbornError(repoRoot);
  }
}

/** The developer's HEAD, branch, object format and origin, or why no `.git` ships. */
function resolveSource(repoRoot: string): SourceRepo | { skipped: string } {
  const top = readDeveloperGit(repoRoot, ['rev-parse', '--show-toplevel']);
  if (top === undefined) throw new Error(`${repoRoot} is not inside a git repository.`);
  if (realpathSync(top) !== realpathSync(repoRoot)) {
    return { skipped: `No .git ships: .kici is not at the repository top level (${top}).` };
  }
  const baseSha = readDeveloperGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (!baseSha) throw unbornError(repoRoot);
  const branch = readDeveloperGit(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const objectFormat = parseObjectFormat(
    readDeveloperGit(repoRoot, ['rev-parse', '--show-object-format']),
  );
  const originUrl = readDeveloperGit(repoRoot, ['config', '--get', 'remote.origin.url']);
  return {
    baseSha,
    ...(branch ? { branch } : {}),
    objectFormat,
    ...(originUrl ? { originUrl } : {}),
  };
}

/** The tag flags of the clone-equivalent fetch. */
function cloneTagFlags(options: GitShipOptions): string[] {
  if (options.tags === GitTagMode.None) return ['--no-tags'];
  // A full clone carries every tag; a shallow one, those pointing at fetched commits.
  return options.depth === 0 ? ['--tags'] : [];
}

/**
 * Fetch the history and tags a clone at this depth holds. Every tag at depth n > 0 takes a
 * second fetch, as a real run does (`git clone --depth n`, then `git fetch --depth n --tags`),
 * so both get the same shallow boundary.
 */
function fetchHistory(
  git: HermeticGit,
  ship: string,
  repoRoot: string,
  source: SourceRepo,
  options: GitShipOptions,
): void {
  const src = pathToFileURL(repoRoot).href;
  const headRef = source.branch ? `refs/remotes/origin/${source.branch}` : TMP_HEAD_REF;
  const depthArgs = options.depth > 0 ? ['--depth', String(options.depth)] : [];
  const refspecs =
    options.depth > 0
      ? [`+${source.baseSha}:${headRef}`]
      : [
          '+refs/heads/*:refs/remotes/origin/*',
          ...(source.branch ? [] : [`+${source.baseSha}:${TMP_HEAD_REF}`]),
        ];
  const uploadPack = uploadPackCommand(repoRoot);
  const fetch = (tagFlags: string[]): void => {
    git.run(
      [
        'fetch',
        '-q',
        '--update-shallow',
        // A clone does not fetch submodules; nor does the shipped repository.
        '--no-recurse-submodules',
        ...depthArgs,
        ...tagFlags,
        '--upload-pack',
        uploadPack,
        src,
        ...refspecs,
      ],
      { cwd: ship },
    );
  };
  fetch(cloneTagFlags(options));
  if (options.tags === GitTagMode.All && options.depth > 0) fetch(['--tags']);
}

/** Whether the developer's repository is a partial clone, whose promisor remote holds objects it lacks. */
function isPartialClone(repoRoot: string): boolean {
  if (readDeveloperGit(repoRoot, ['config', '--get', 'extensions.partialclone'])) return true;
  const promisors = readDeveloperGit(repoRoot, [
    'config',
    '--type=bool',
    '--get-regexp',
    '^remote\\..*\\.promisor$',
  ]);
  return (promisors ?? '').split('\n').some((line) => line.trim().endsWith(' true'));
}

/** The fetch; on a partial clone, a failure means local objects are missing, which it never lazy-fetches. */
function fetchHistoryOrExplain(
  git: HermeticGit,
  ship: string,
  repoRoot: string,
  source: SourceRepo,
  options: GitShipOptions,
): void {
  try {
    fetchHistory(git, ship, repoRoot, source, options);
  } catch (err) {
    if (!isPartialClone(repoRoot)) throw err;
    const history = options.depth === 0 ? 'the full history' : `the last ${options.depth} commits`;
    throw new Error(
      `The local repository ${repoRoot} is a partial clone: it lacks objects that ${history} ` +
        'need, so kici run remote cannot ship them. Fetch the missing objects into the local ' +
        'repository, or ship less history with a smaller --git-depth.',
      { cause: err },
    );
  }
}

function refExists(git: HermeticGit, ship: string, ref: string): boolean {
  try {
    git.run(['show-ref', '--verify', '--quiet', ref], { cwd: ship });
    return true;
  } catch {
    return false;
  }
}

/** Point HEAD at the workspace commit (branch or detached); `origin/<branch>` stays at the developer's HEAD. */
function writeRefs(git: HermeticGit, ship: string, source: SourceRepo, workspaceSha: string): void {
  const cwd = { cwd: ship };
  if (source.branch) {
    git.run(['update-ref', `refs/heads/${source.branch}`, workspaceSha], cwd);
    git.run(['symbolic-ref', 'HEAD', `refs/heads/${source.branch}`], cwd);
    git.run(
      ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${source.branch}`],
      cwd,
    );
    return;
  }
  git.run(['update-ref', '--no-deref', 'HEAD', workspaceSha], cwd);
  if (refExists(git, ship, TMP_HEAD_REF)) git.run(['update-ref', '-d', TMP_HEAD_REF], cwd);
  const initBranch = `refs/heads/${DETACHED_INIT_BRANCH}`;
  if (refExists(git, ship, initBranch)) git.run(['update-ref', '-d', initBranch], cwd);
}

/**
 * Write an index of `workspaceSha` for the remote `git status`. A tracked path the overlay does
 * not ship is skip-worktree, so its absence is no deletion, unless the developer deleted it:
 * without a synthetic commit, the remote `git status` shows that deletion.
 */
function writeIndex(
  git: HermeticGit,
  ship: string,
  workspaceSha: string,
  shippedPaths: ReadonlySet<string>,
  deletions: ReadonlySet<string>,
): void {
  const env = { GIT_INDEX_FILE: path.join(ship, '.git', 'index') };
  git.run(['read-tree', workspaceSha], { cwd: ship, env });
  const unshipped = git
    .run(['ls-tree', '-r', '-z', '--name-only', workspaceSha], { cwd: ship })
    .split('\0')
    .filter((p) => p.length > 0 && !shippedPaths.has(p) && !deletions.has(p));
  if (unshipped.length > 0) {
    git.run(['update-index', '--skip-worktree', '-z', '--stdin'], {
      cwd: ship,
      env,
      input: `${unshipped.join('\0')}\0`,
    });
  }
}

async function listFiles(root: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(root, rel)));
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(rel);
  }
  return out;
}

/** Write the generated config, pack every reachable object, drop what a clone lacks, and list the files. */
async function finalize(
  git: HermeticGit,
  ship: string,
  source: SourceRepo,
  options: GitShipOptions,
): Promise<string[]> {
  const gitDir = path.join(ship, '.git');
  await fs.writeFile(
    path.join(gitDir, 'config'),
    renderShippedGitConfig({
      objectFormat: source.objectFormat,
      ...(source.originUrl ? { originUrl: shippedOriginUrl(source.originUrl) } : {}),
      ...(source.branch ? { branch: source.branch } : {}),
      depth: options.depth,
      noTags: options.tags === GitTagMode.None,
    }),
  );
  // `-n`: no update-server-info, whose `info/refs` and `objects/info/packs` a clone lacks.
  git.run(['repack', '-a', '-d', '-q', '-n'], { cwd: ship });
  // The pack now holds every borrowed object; a clone has no alternates.
  await fs.rm(path.join(gitDir, ALTERNATES_FILE), { force: true });
  git.run(['prune', '--expire=now'], { cwd: ship });
  await Promise.all(
    FORBIDDEN_GIT_PATHS.map((p) => fs.rm(path.join(gitDir, p), { recursive: true, force: true })),
  );
  let files = await listFiles(ship, '.git');
  if (!files.some((f) => f.startsWith('.git/refs/'))) {
    await fs.mkdir(path.join(gitDir, 'refs'), { recursive: true });
    await fs.writeFile(path.join(gitDir, REFS_PLACEHOLDER), '');
    files = await listFiles(ship, '.git');
  }
  return files.sort();
}

/** The parent of `sha`, from the shipped repository or, past a shallow boundary, the developer's. */
function resolveParent(
  git: HermeticGit,
  ship: string,
  repoRoot: string,
  sha: string,
): string | undefined {
  try {
    const parent = git.run(['rev-parse', '--verify', '--quiet', `${sha}^`], { cwd: ship }).trim();
    if (parent) return parent;
  } catch {
    // Not in the shipped history: a shallow boundary or a root commit.
  }
  return readDeveloperGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${sha}^`]) || undefined;
}

/**
 * The depth shipped below `sha`: the requested one, or less from a shallow source. A shallow
 * boundary at distance d from `sha` (breadth-first, as git counts depth) caps it at d + 1.
 */
function shippedDepth(git: HermeticGit, ship: string, sha: string, requested: number): number {
  let shallowFile: string;
  try {
    shallowFile = readFileSync(path.join(ship, '.git', 'shallow'), 'utf8');
  } catch {
    return requested;
  }
  const boundaries = new Set(shallowFile.split('\n').filter(Boolean));
  if (boundaries.size === 0) return requested;

  const parents = new Map<string, string[]>();
  for (const line of git.run(['rev-list', '--parents', sha], { cwd: ship }).split('\n')) {
    const [commit, ...commitParents] = line.trim().split(' ');
    if (commit) parents.set(commit, commitParents);
  }
  const distance = new Map([[sha, 0]]);
  const queue = [sha];
  let nearest = Infinity;
  for (let i = 0; i < queue.length; i++) {
    const commit = queue[i];
    const d = distance.get(commit) ?? 0;
    if (boundaries.has(commit)) nearest = Math.min(nearest, d + 1);
    for (const parent of parents.get(commit) ?? []) {
      if (distance.has(parent)) continue;
      distance.set(parent, d + 1);
      queue.push(parent);
    }
  }
  if (nearest === Infinity) return requested;
  return requested === 0 ? nearest : Math.min(requested, nearest);
}

/** The warning for a shallow source that holds less history than requested. */
function shallowSourceWarning(repoRoot: string, depth: number, options: GitShipOptions): string {
  const requested = options.depth === 0 ? 'the full history' : `${options.depth} commits`;
  return (
    `Your local repository ${repoRoot} is shallow: the remote run gets ${depth} commit(s) of ` +
    `history, not ${requested}. A larger --git-depth cannot ship more than the local ` +
    'repository holds; fetch more history locally (git fetch --unshallow), then re-run.'
  );
}

function shippedRecord(options: GitShipOptions, fetchDepth: number): OverlayGitRecord {
  return {
    fetchDepth,
    allTags:
      options.tags === GitTagMode.All || (options.depth === 0 && options.tags !== GitTagMode.None),
  };
}

/**
 * The synthetic commit of the changes on top of HEAD when `options.commit` asks for one and
 * they alter HEAD's tree, else null. The shipped repository borrows its temporary object
 * directory until `finalize` packs them.
 */
async function syntheticCommit(
  ship: string,
  args: {
    repoRoot: string;
    scratchDir: string;
    baseSha: string;
    options: GitShipOptions;
    add: readonly string[];
    remove: readonly string[];
  },
): Promise<string | null> {
  if (args.options.commit !== true) return null;
  const developer = createDeveloperGit({ repoRoot: args.repoRoot, scratchDir: args.scratchDir });
  const sha = writeSyntheticCommit(developer, {
    baseSha: args.baseSha,
    add: args.add,
    remove: args.remove,
    author: resolveSyntheticAuthor(args.repoRoot, args.options.commitAuthor),
    message: args.options.commitMessage ?? SYNTHETIC_COMMIT_MESSAGE,
  });
  if (sha) {
    await fs.mkdir(path.join(ship, '.git', 'objects', 'info'), { recursive: true });
    // A new object may already be in the developer's store (a staged blob): borrow both.
    await fs.writeFile(
      path.join(ship, '.git', ALTERNATES_FILE),
      `${developer.objectDir}\n${developer.developerObjectDir}\n`,
    );
  }
  return sha;
}

export async function buildShippedGit(args: {
  repoRoot: string;
  /** Parent directory the shipped repo is created in (the overlay temp dir). */
  workDir: string;
  options: GitShipOptions;
  /** Repo-relative paths the overlay ships (files + directory symlinks). */
  shippedPaths: ReadonlySet<string>;
  /** Deleted or replaced paths: the synthetic commit drops them, else `git status` shows them. */
  deletions: readonly string[];
  /** Paths the developer's git reports changed: only these are re-added onto HEAD's tree. */
  changedPaths: ReadonlySet<string>;
}): Promise<ShippedGitResult> {
  const { repoRoot, workDir, options, shippedPaths, deletions, changedPaths } = args;
  const source = resolveSource(repoRoot);
  if ('skipped' in source) return source;

  const git = createHermeticGit({ scratchDir: path.join(workDir, 'git-scratch') });
  const ship = path.join(workDir, 'ship');
  git.run([
    'init',
    '-q',
    '--template=',
    `--object-format=${source.objectFormat}`,
    '-b',
    source.branch ?? DETACHED_INIT_BRANCH,
    ship,
  ]);
  // `--template=` writes no info/; a clone's info/exclude takes the agent's scratch paths.
  await fs.mkdir(path.join(ship, '.git', 'info'), { recursive: true });
  await fs.writeFile(path.join(ship, '.git', 'info', 'exclude'), DEFAULT_INFO_EXCLUDE);

  fetchHistoryOrExplain(git, ship, repoRoot, source, options);
  // The developer's changes within the overlay selection.
  const add = [...shippedPaths].filter((p) => changedPaths.has(p));
  const synthetic = await syntheticCommit(ship, {
    repoRoot,
    scratchDir: path.join(workDir, 'synthetic'),
    baseSha: source.baseSha,
    options,
    add,
    remove: deletions,
  });
  // Under `--no-commit` they stay uncommitted in the remote workspace.
  const uncommittedPaths =
    options.commit === true ? [] : [...new Set([...add, ...deletions])].sort();
  const workspaceSha = synthetic ?? source.baseSha;
  writeRefs(git, ship, source, workspaceSha);
  writeIndex(git, ship, workspaceSha, shippedPaths, new Set(deletions));
  // Before `finalize`, so the tag objects are packed and their refs listed.
  const createdTags = [...new Set(options.syntheticTags ?? [])];
  const { replaced: replacedTags } = createSyntheticTags(git, {
    shipDir: ship,
    names: createdTags,
    target: workspaceSha,
  });
  const files = await finalize(git, ship, source, options);
  // Without a synthetic commit, a changed path ships as the developer has it.
  const checkoutRoot = path.join(workDir, 'checkout');
  const checkoutPaths = await writeCheckoutBytes(git, {
    ship,
    repoRoot,
    workspaceSha,
    candidates: [...shippedPaths].filter((p) => synthetic !== null || !changedPaths.has(p)),
    outDir: checkoutRoot,
  });
  const parentSha = synthetic ? source.baseSha : resolveParent(git, ship, repoRoot, workspaceSha);
  // Depth counts real history, below the developer's HEAD.
  const depth = shippedDepth(git, ship, source.baseSha, options.depth);
  const warnings = depth === options.depth ? [] : [shallowSourceWarning(repoRoot, depth, options)];

  return {
    git: {
      root: ship,
      files,
      baseSha: source.baseSha,
      workspaceSha,
      synthetic: synthetic !== null,
      createdTags,
      replacedTags,
      ...(checkoutPaths.length > 0
        ? { checkout: { root: checkoutRoot, paths: checkoutPaths } }
        : {}),
      ...(parentSha ? { parentSha } : {}),
      ...(uncommittedPaths.length > 0 ? { uncommittedPaths } : {}),
      ...(source.branch ? { branch: source.branch } : {}),
      record: shippedRecord(options, depth),
      warnings,
    } satisfies ShippedGit,
  };
}
