import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  GitObjectFormat,
  GitTagMode,
  type GitShipOptions,
  type ShippedGit,
} from './git-ship-types.js';
import { describeHistoryGap } from '@kici-dev/engine';
import { snapshotRepo } from '@kici-dev/test-support/git-repo-snapshot';
import { classifyOverlayEntries } from '../overlay-links.js';
import { createOverlayTarball, selectOverlayFiles, shippedGitInputs } from '../uploader.js';
import { computeRemoteChangedFiles } from '../remote-changed-files.js';
import { renderShippedGitConfig } from './shipped-git-config.js';
import { buildShippedGit, uploadPackCommand } from './shipped-git.js';

/** Temp roots, removed after each test. */
const roots: string[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(join(os.tmpdir(), `kici-shipped-git-${label}-`));
  roots.push(dir);
  return dir;
}

/** An empty global config, so the test's own git calls see no developer settings. */
let testGlobalConfig: string;

beforeAll(() => {
  testGlobalConfig = join(tempDir('global'), 'gitconfig');
  writeFileSync(testGlobalConfig, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function testEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: testGlobalConfig,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}

function git(dir: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: testEnv(),
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/** Untrimmed stdout, for output whose leading spaces matter. */
function gitRaw(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: testEnv() });
}

function readFileOr(file: string, fallback: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : fallback;
}

const refs = (dir: string): string[] =>
  git(dir, ['for-each-ref', '--format=%(refname) %(objectname) %(symref)']).split('\n').sort();
const objects = (dir: string): string[] =>
  [
    ...new Set(
      git(dir, ['rev-list', '--all', '--objects'])
        .split('\n')
        .map((l) => l.split(' ')[0]),
    ),
  ].sort();
/** Every object the repository stores, reachable or not. */
const storedObjects = (dir: string): string[] =>
  git(dir, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)']).split('\n').sort();
const shallow = (dir: string): string[] =>
  readFileOr(join(dir, '.git', 'shallow'), '')
    .split('\n')
    .filter(Boolean)
    .sort();

function writeIn(dir: string, rel: string, content: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

/**
 * A repository with 5 commits on `main`, a `feature` branch with a commit of
 * its own, a lightweight tag `light` at `HEAD~1`, an annotated tag `ann` at
 * `HEAD`, a stash, extra reflog entries, a hook, `ORIG_HEAD`, an unreachable
 * object, developer-only `.git` content and an `origin` URL carrying a token.
 */
function makeSourceRepo(): string {
  const src = join(tempDir('src'), 'src');
  mkdirSync(src);
  git(src, ['init', '-q', '-b', 'main']);
  writeIn(src, 'sub/s.txt', 'sub\n');
  writeIn(src, 'run.sh', '#!/bin/sh\necho hi\n');
  chmodSync(join(src, 'run.sh'), 0o755);
  for (let i = 1; i <= 5; i++) {
    writeIn(src, `f${i}.txt`, `${i}\n`);
    git(src, ['add', '-A']);
    git(src, ['commit', '-qm', `c${i}`]);
  }
  git(src, ['checkout', '-q', '-b', 'feature', 'HEAD~2']);
  writeIn(src, 'feature.txt', 'feature\n');
  git(src, ['add', '-A']);
  git(src, ['commit', '-qm', 'feature']);
  git(src, ['checkout', '-q', 'main']);
  git(src, ['tag', 'light', 'HEAD~1']);
  git(src, ['tag', '-a', 'ann', '-m', 'annotated']);
  writeIn(src, 'f1.txt', 'stashed\n');
  git(src, ['stash', '-q']);
  git(src, ['update-ref', '-m', 'extra reflog', 'HEAD', 'HEAD']);
  git(src, ['update-ref', 'ORIG_HEAD', 'HEAD~1']);
  git(src, ['hash-object', '-w', '--stdin'], 'unreachable blob\n');
  git(src, ['remote', 'add', 'origin', 'https://user:tok@example.com/r.git']);
  git(src, ['config', 'devonly.marker', 'leak']);
  git(src, ['config', 'core.hooksPath', '.git/hooks']);
  writeIn(src, '.git/hooks/pre-commit', '#!/bin/sh\nexit 0\n');
  writeIn(src, '.git/info/exclude', '/dev-only-scratch\n');
  writeIn(src, '.git/FETCH_HEAD', 'deadbeef\n');
  writeIn(src, '.git/rr-cache/x/preimage', 'x\n');
  writeIn(src, '.git/lfs/objects/x', 'x\n');
  writeIn(src, '.git/modules/m/HEAD', 'ref: refs/heads/main\n');
  return src;
}

function trackedPaths(src: string): Set<string> {
  return new Set(git(src, ['ls-files']).split('\n').filter(Boolean));
}

async function ship(
  src: string,
  options: GitShipOptions,
  shippedPaths?: ReadonlySet<string>,
  deletions: readonly string[] = [],
  changedPaths: ReadonlySet<string> = new Set(),
) {
  const result = await buildShippedGit({
    repoRoot: src,
    workDir: tempDir('work'),
    options,
    shippedPaths: shippedPaths ?? trackedPaths(src),
    deletions,
    changedPaths,
  });
  if (!('git' in result)) throw new Error(`unexpected skip: ${result.skipped}`);
  return result.git;
}

/** Whether the git on PATH is at least `major.minor`. */
function gitAtLeast(major: number, minor: number): boolean {
  const m = /git version (\d+)\.(\d+)/.exec(
    execFileSync('git', ['--version'], { encoding: 'utf8' }),
  );
  if (!m) throw new Error('git --version printed no version');
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > major || (maj === major && min >= minor);
}

/**
 * Whether a shallow, single-branch `git clone` writes the `refs/remotes/origin/HEAD` symref
 * depends on the git version: git 2.47 writes it, and a newer git differs. The product does not
 * clone: it writes its own refs, the same on every git version, so a shallow comparison with a
 * reference clone leaves the symref out on both sides, and a separate assertion pins the
 * product's own symref ({@link expectBranchRemoteHead}).
 */
function withoutRemoteHead(lines: string[]): string[] {
  return lines.filter((l) => !l.startsWith('refs/remotes/origin/HEAD '));
}

/** A ship from `branch` carries `origin/HEAD` as a symref to that branch's remote ref. */
function expectBranchRemoteHead(root: string, branch: string): void {
  // fails-when: the shipped tree drops or retargets origin/HEAD, which the reference-clone
  //   comparison leaves out for shallow ships
  expect(
    git(root, ['for-each-ref', '--format=%(refname) %(symref)', 'refs/remotes/origin/HEAD']),
  ).toBe(`refs/remotes/origin/HEAD refs/remotes/origin/${branch}`);
}

function cloneRef(src: string, cloneArgs: string[]): string {
  const ref = join(tempDir('ref'), 'ref');
  git(dirname(ref), ['clone', '-q', ...cloneArgs, pathToFileURL(src).href, ref]);
  return ref;
}

/** A config key's value, or '' when unset. */
function configKey(dir: string, key: string): string {
  try {
    return git(dir, ['config', '--get', key]);
  } catch {
    return '';
  }
}

/**
 * A blob-less partial clone of `makeSourceRepo`, whose history holds a blob
 * the clone's checkout never fetched.
 */
function makePartialClone(): string {
  const src = makeSourceRepo();
  git(src, ['config', 'uploadpack.allowFilter', 'true']);
  writeIn(src, 'f1.txt', 'rewritten\n');
  git(src, ['commit', '-qam', 'rewrite f1']);
  const partial = cloneRef(src, ['--filter=blob:none', '--branch', 'main']);
  expect(git(partial, ['config', '--get', 'remote.origin.promisor'])).toBe('true');
  return partial;
}

/** A plain `git fetch` into a new repository through `uploadPack`, outside the hermetic runner. */
function fetchThrough(
  src: string,
  uploadPack: string,
  args: { env?: Record<string, string>; depth?: number },
): { status: number | null; stderr: string } {
  const into = join(tempDir('fetch'), 'into');
  git(dirname(into), ['init', '-q', into]);
  const result = spawnSync(
    'git',
    [
      '-c',
      `safe.directory=${into}`,
      '-C',
      into,
      'fetch',
      '-q',
      ...(args.depth ? ['--depth', String(args.depth)] : []),
      '--upload-pack',
      uploadPack,
      pathToFileURL(src).href,
      '+refs/heads/*:refs/remotes/origin/*',
    ],
    { env: { ...testEnv(), ...args.env }, encoding: 'utf8' },
  );
  return { status: result.status, stderr: result.stderr };
}

/**
 * The remote workspace as the agent builds it: the commit's files from
 * `git archive`, then each shipped `.git` file copied on its own (the agent
 * copies files, never empty directories).
 */
function agentWorkspace(src: string, shipped: ShippedGit): string {
  const dir = tempDir('workspace');
  const tar = join(tempDir('archive'), 'head.tar');
  git(src, ['archive', '--format=tar', '-o', tar, shipped.workspaceSha]);
  execFileSync('tar', ['-xf', tar, '-C', dir]);
  for (const file of shipped.files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    copyFileSync(join(shipped.root, file), join(dir, file));
  }
  return dir;
}

/** What `createOverlayTarball` passes `buildShippedGit` for `kici run remote`. */
async function overlayOf(src: string): Promise<ReturnType<typeof shippedGitInputs>> {
  const selection = await selectOverlayFiles(src, { fullWorkingTree: true });
  const entries = await classifyOverlayEntries(src, selection, () => false);
  return shippedGitInputs(selection, entries);
}

/** Ship `overlay` (by default, the working tree of `src`) as `kici run remote` does. */
async function shipOverlay(
  src: string,
  options: GitShipOptions,
  overlay: ReturnType<typeof shippedGitInputs>,
): Promise<ShippedGit> {
  return ship(src, options, overlay.shippedPaths, overlay.deletions, overlay.changedPaths);
}

/** Ship the dirty working tree of `src` as `kici run remote` does. */
async function shipDirty(src: string, options: GitShipOptions) {
  const overlay = await overlayOf(src);
  return { shipped: await shipOverlay(src, options, overlay), ...overlay };
}

/**
 * The remote `git status` (porcelain lines, sorted) of a workspace holding
 * exactly the shipped working-tree paths of `src` and the shipped `.git`,
 * each file taken from where the tarball takes it: the checkout replacement
 * when there is one, else the developer's working tree. Modes are copied.
 */
function statusAfterCheckout(
  src: string,
  shipped: ShippedGit,
  paths: ReadonlySet<string>,
): string[] {
  const dir = tempDir('checkout');
  const replaced = new Set(shipped.checkout?.paths ?? []);
  for (const rel of paths) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    if (replaced.has(rel)) {
      copyFileSync(join(shipped.checkout?.root ?? '', rel), join(dir, rel));
    } else if (lstatSync(join(src, rel)).isSymbolicLink()) {
      symlinkSync(readlinkSync(join(src, rel)), join(dir, rel));
    } else {
      copyFileSync(join(src, rel), join(dir, rel));
    }
  }
  for (const file of shipped.files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    copyFileSync(join(shipped.root, file), join(dir, file));
  }
  return gitRaw(dir, ['status', '--porcelain=v1', '-z']).split('\0').filter(Boolean).sort();
}

/** The paths of a commit's tree, verbatim. */
const treePaths = (dir: string, commit: string): string[] =>
  gitRaw(dir, ['ls-tree', '-r', '-z', '--name-only', commit]).split('\0').filter(Boolean);

/**
 * Dirty `makeSourceRepo`: a modified tracked file, a staged change, an
 * untracked file, a deleted tracked file and a gitignored file.
 */
function dirty(src: string): void {
  writeIn(src, 'f1.txt', 'modified\n');
  writeIn(src, 'f2.txt', 'staged\n');
  git(src, ['add', 'f2.txt']);
  writeIn(src, 'new.txt', 'new\n');
  unlinkSync(join(src, 'f3.txt'));
  writeIn(src, '.gitignore', 'ignored.txt\n');
  writeIn(src, 'ignored.txt', 'secret\n');
}

/** `makeSourceRepo` with a commit on a detached HEAD at `HEAD~1`, which no branch holds. */
function detachedWork(): { src: string; head: string } {
  const src = makeSourceRepo();
  git(src, ['checkout', '-q', '--detach', 'HEAD~1']);
  writeIn(src, 'detached.txt', 'detached\n');
  git(src, ['add', '-A']);
  git(src, ['commit', '-qm', 'detached work']);
  return { src, head: git(src, ['rev-parse', 'HEAD']) };
}

describe('buildShippedGit', { timeout: 60_000 }, () => {
  it.each<[GitShipOptions, string[]]>([
    [{ depth: 1, tags: GitTagMode.Default }, ['--depth', '1', '--branch', 'main']],
    [{ depth: 3, tags: GitTagMode.Default }, ['--depth', '3', '--branch', 'main']],
    [{ depth: 3, tags: GitTagMode.None }, ['--depth', '3', '--no-tags', '--branch', 'main']],
    [{ depth: 0, tags: GitTagMode.Default }, ['--branch', 'main']],
  ])('ships what git clone %j produces (refs, objects, shallow)', async (options, cloneArgs) => {
    const src = makeSourceRepo();
    const shipped = await ship(src, options);
    const ref = cloneRef(src, cloneArgs);
    // fails-when: the builder ships a different ref layout, a missing or extra object, or a different shallow boundary than a fresh clone
    const layout = options.depth > 0 ? withoutRemoteHead : (l: string[]) => l;
    expect(layout(refs(shipped.root))).toEqual(layout(refs(ref)));
    expectBranchRemoteHead(shipped.root, 'main');
    expect(objects(shipped.root)).toEqual(objects(ref));
    expect(shallow(shipped.root)).toEqual(shallow(ref));
    // fails-when: a no-tags ship omits the tagOpt a `git clone --no-tags` writes
    expect(configKey(shipped.root, 'remote.origin.tagOpt')).toBe(
      configKey(ref, 'remote.origin.tagOpt'),
    );
    expect(shipped.warnings).toEqual([]);
    // fails-when: an unreachable object (the source's loose blob, a stash) is stored in the shipped pack
    expect(storedObjects(shipped.root)).toEqual(objects(shipped.root));
    expect(shipped.baseSha).toBe(git(src, ['rev-parse', 'HEAD']));
    expect(shipped.workspaceSha).toBe(shipped.baseSha);
    expect(shipped.parentSha).toBe(git(src, ['rev-parse', 'HEAD~1']));
    expect(shipped.branch).toBe('main');
  });

  it('tags: all at depth 3 matches clone --depth 3 + fetch --depth 3 --tags', async () => {
    const src = makeSourceRepo();
    // A tag outside the first 3 commits, which only an all-tags fetch brings.
    git(src, ['tag', 'old', 'HEAD~4']);
    const shipped = await ship(src, { depth: 3, tags: GitTagMode.All });
    const ref = cloneRef(src, ['--depth', '3', '--branch', 'main']);
    git(ref, ['fetch', '-q', '--depth', '3', '--tags']);
    // fails-when: the all-tags mode fetches only the tags inside the shipped depth
    expect(refs(shipped.root)).toEqual(refs(ref));
    expect(refs(shipped.root).some((r) => r.startsWith('refs/tags/old '))).toBe(true);
    expect(objects(shipped.root)).toEqual(objects(ref));
    expect(shallow(shipped.root)).toEqual(shallow(ref));
  });

  it.each<[GitShipOptions, { fetchDepth: number; allTags: boolean }]>([
    [
      { depth: 1, tags: GitTagMode.Default },
      { fetchDepth: 1, allTags: false },
    ],
    [
      { depth: 3, tags: GitTagMode.All },
      { fetchDepth: 3, allTags: true },
    ],
    [
      { depth: 3, tags: GitTagMode.None },
      { fetchDepth: 3, allTags: false },
    ],
    [
      { depth: 0, tags: GitTagMode.Default },
      { fetchDepth: 0, allTags: true },
    ],
    [
      { depth: 0, tags: GitTagMode.All },
      { fetchDepth: 0, allTags: true },
    ],
    [
      { depth: 0, tags: GitTagMode.None },
      { fetchDepth: 0, allTags: false },
    ],
  ])('records %j as %j', async (options, record) => {
    const src = makeSourceRepo();
    const shipped = await ship(src, options);
    // fails-when: depth 0 is recorded without its implied tags, or a no-tags ship claims all tags
    expect(shipped.record).toEqual(record);
    const hasTags = refs(shipped.root).some((r) => r.startsWith('refs/tags/'));
    expect(hasTags).toBe(options.tags !== GitTagMode.None);
  });

  it('detached HEAD at depth 0 ships every branch as origin/* and a detached HEAD', async () => {
    const { src, head } = detachedWork();

    const shipped = await ship(src, { depth: 0, tags: GitTagMode.Default });

    // fails-when: the detached commit (on no branch) is lost, or the temp ref ships
    expect(git(shipped.root, ['rev-parse', 'HEAD'])).toBe(head);
    expect(readFileSync(join(shipped.root, '.git', 'HEAD'), 'utf8')).toBe(`${head}\n`);
    expect(
      refs(shipped.root)
        .map((r) => r.split(' ')[0])
        .filter((r) => !r.startsWith('refs/tags/')),
    ).toEqual(['refs/remotes/origin/feature', 'refs/remotes/origin/main']);
    expect(shallow(shipped.root)).toEqual([]);
    expect(storedObjects(shipped.root)).toEqual(objects(shipped.root));
    expect(git(agentWorkspace(src, shipped), ['status', '--porcelain'])).toBe('');
  });

  it('detached HEAD ships a detached HEAD and no branch ref', async () => {
    const { src, head } = detachedWork();

    const shipped = await ship(src, { depth: 1, tags: GitTagMode.None });

    expect(readFileSync(join(shipped.root, '.git', 'HEAD'), 'utf8')).toBe(`${head}\n`);
    expect(shipped.branch).toBeUndefined();
    expect(refs(shipped.root).filter((r) => r.startsWith('refs/'))).toEqual([]);
    expect(readFileSync(join(shipped.root, '.git', 'config'), 'utf8')).not.toContain('[branch');
    // breaks-if-wrong: with no ref at all the extracted `.git` has no refs/
    //   directory, and git refuses it as "not a git repository"
    const workspace = agentWorkspace(src, shipped);
    expect(git(workspace, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(workspace, ['status', '--porcelain'])).toBe('');
  });

  it('works from a linked worktree', async () => {
    const src = makeSourceRepo();
    const wt = join(dirname(src), 'wt');
    git(src, ['worktree', 'add', '-q', '-b', 'wtbranch', wt, 'HEAD~1']);
    const head = git(wt, ['rev-parse', 'HEAD']);

    const shipped = await ship(wt, { depth: 1, tags: GitTagMode.Default });

    // fails-when: the builder reads `<repo>/.git` as a directory and finds nothing in a worktree
    expect(git(shipped.root, ['rev-parse', 'HEAD'])).toBe(head);
    expect(shipped.branch).toBe('wtbranch');
    expect(git(shipped.root, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/wtbranch');
  });

  it('ships what exists from a shallow source, depth 0 included', async () => {
    const src = makeSourceRepo();
    const shallowSrc = cloneRef(src, ['--depth', '2', '--branch', 'main']);

    const deeper = await ship(shallowSrc, { depth: 5, tags: GitTagMode.Default });
    expect(git(deeper.root, ['rev-list', '--count', 'HEAD'])).toBe('2');
    // fails-when: the requested depth is recorded instead of the 2 commits that shipped
    expect(deeper.record).toEqual({ fetchDepth: 2, allTags: false });
    // fails-when: the developer is not told that the shallow local repository is the limit
    expect(deeper.warnings).toHaveLength(1);
    expect(deeper.warnings[0]).toContain(`Your local repository ${shallowSrc} is shallow`);
    expect(deeper.warnings[0]).toContain('git fetch --unshallow');

    const full = await ship(shallowSrc, { depth: 0, tags: GitTagMode.Default });
    expect(git(full.root, ['rev-list', '--count', 'HEAD'])).toBe('2');
    expect(shallow(full.root)).toEqual(shallow(shallowSrc));
    expect(full.record).toEqual({ fetchDepth: 2, allTags: true });

    // breaks-if-wrong: a depth within what the source holds keeps its requested value
    const within = await ship(shallowSrc, { depth: 1, tags: GitTagMode.Default });
    expect(within.record).toEqual({ fetchDepth: 1, allTags: false });
    expect(within.warnings).toEqual([]);
  });

  it('records a depth-0 ship from a 1-commit shallow source as a gap for a fetchDepth: 0 job', async () => {
    const src = makeSourceRepo();
    const shallowSrc = cloneRef(src, ['--depth', '1', '--branch', 'main']);
    // Positive control: the agent reports no gap for a record that claims full history.
    expect(describeHistoryGap({ fetchDepth: 0 }, { fetchDepth: 0, allTags: true })).toBeNull();

    const shipped = await ship(shallowSrc, { depth: 0, tags: GitTagMode.Default });

    // fails-when: the requested depth (0, full history) is recorded, so the agent sees no gap
    expect(shipped.record.fetchDepth).toBe(1);
    expect(describeHistoryGap({ fetchDepth: 0 }, shipped.record)).toContain(
      'fetchDepth 0 requested, depth 1 shipped',
    );
  });

  it('explains a fetch a partial clone cannot serve', async () => {
    const partial = makePartialClone();
    const objectCount = (): string => git(partial, ['count-objects', '-v']);
    const before = objectCount();

    // breaks-if-wrong: a depth whose objects the checkout already holds still ships
    const shallowShip = await ship(partial, { depth: 1, tags: GitTagMode.Default });
    expect(git(shallowShip.root, ['rev-parse', 'HEAD'])).toBe(git(partial, ['rev-parse', 'HEAD']));

    // fails-when: git's raw "possible repository corruption" error surfaces instead
    const full = buildShippedGit({
      repoRoot: partial,
      workDir: tempDir('work'),
      options: { depth: 0, tags: GitTagMode.Default },
      shippedPaths: trackedPaths(partial),
      deletions: [],
      changedPaths: new Set(),
    });
    await expect(full).rejects.toThrow(`The local repository ${partial} is a partial clone`);
    await expect(full).rejects.toThrow('a smaller --git-depth');
    // The fetch never asks the promisor remote, so nothing is written into the local repository.
    expect(objectCount()).toBe(before);
  });

  it('never lazy-fetches from a partial clone, even when the environment allows it', () => {
    const objectCount = (dir: string): string => git(dir, ['count-objects', '-v']);
    const lazyAllowed = { GIT_NO_LAZY_FETCH: '0' };

    // Positive control: a plain upload-pack lazy-fetches the missing blob into the partial clone.
    const control = makePartialClone();
    const controlBefore = objectCount(control);
    expect(fetchThrough(control, 'git upload-pack', { env: lazyAllowed }).status).toBe(0);
    expect(objectCount(control)).not.toBe(controlBefore);

    const partial = makePartialClone();
    const before = objectCount(partial);
    // fails-when: the upload-pack command drops GIT_NO_LAZY_FETCH=1, so the partial clone fetches from its promisor
    expect(fetchThrough(partial, uploadPackCommand(partial), { env: lazyAllowed }).status).not.toBe(
      0,
    );
    expect(objectCount(partial)).toBe(before);
  });

  it('trusts the developer repository for upload-pack, and only that repository', () => {
    const src = join(tempDir('owner'), "it's a repo");
    mkdirSync(src);
    git(src, ['init', '-q', '-b', 'main']);
    writeIn(src, 'a.txt', 'a\n');
    git(src, ['add', '-A']);
    git(src, ['commit', '-qm', 'one']);
    const wt = join(dirname(src), 'linked wt');
    git(src, ['worktree', 'add', '-q', '-b', 'wtb', wt]);
    const otherOwner = { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' };

    // From git 2.48, upload-pack serves a repository another user owns ("cloning a suspicious
    // repository is a safe first step to inspect it": bc/allow-upload-pack-from-other-people,
    // release notes 2.48.0), so the trust below is needed only on an older git.
    const enforcesOwnership = !gitAtLeast(2, 48);
    const plain = fetchThrough(src, 'git upload-pack', { env: otherOwner, depth: 1 });
    if (!enforcesOwnership) {
      // breaks-if-wrong: on a current git, every fetch through the command still succeeds
      expect(plain.status, plain.stderr).toBe(0);
      expect(fetchThrough(src, uploadPackCommand(src), { env: otherOwner, depth: 1 }).status).toBe(
        0,
      );
      expect(fetchThrough(wt, uploadPackCommand(wt), { env: otherOwner, depth: 1 }).status).toBe(0);
      expect(fetchThrough(src, uploadPackCommand(src), { depth: 1 }).status).toBe(0);
      expect(uploadPackCommand(src)).not.toContain('safe.directory=*');
      return;
    }
    // Positive control: git refuses a repository it believes another user owns.
    expect(plain.status).not.toBe(0);
    expect(plain.stderr).toContain('dubious ownership');

    // fails-when: the upload-pack command carries no safe.directory for the developer repository
    expect(fetchThrough(src, uploadPackCommand(src), { env: otherOwner, depth: 1 }).status).toBe(0);
    expect(fetchThrough(wt, uploadPackCommand(wt), { env: otherOwner, depth: 1 }).status).toBe(0);
    // breaks-if-wrong: a repository the developer owns still fetches
    expect(fetchThrough(src, uploadPackCommand(src), { depth: 1 }).status).toBe(0);
    expect(uploadPackCommand(src)).not.toContain('safe.directory=*');
    // The trust names this repository only: another repository stays refused.
    const other = join(tempDir('other'), 'repo');
    mkdirSync(other);
    git(other, ['init', '-q']);
    git(other, ['commit', '-q', '--allow-empty', '-m', 'x']);
    expect(
      fetchThrough(other, uploadPackCommand(src), { env: otherOwner, depth: 1 }).status,
    ).not.toBe(0);
  });

  it('records the requested depth through a merge, and the real depth from a shallow merge', async () => {
    const src = join(tempDir('merge'), 'src');
    mkdirSync(src);
    git(src, ['init', '-q', '-b', 'main']);
    const commit = (file: string): void => {
      writeIn(src, file, `${file}\n`);
      git(src, ['add', '-A']);
      git(src, ['commit', '-qm', file]);
    };
    commit('c1');
    commit('c2');
    git(src, ['checkout', '-q', '-b', 'side', 'HEAD~1']);
    commit('s1');
    commit('s2');
    commit('s3');
    git(src, ['checkout', '-q', 'main']);
    commit('c3');
    git(src, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side']);

    for (const depth of [2, 3]) {
      const shipped = await ship(src, { depth, tags: GitTagMode.Default });
      const ref = cloneRef(src, ['--depth', String(depth), '--branch', 'main']);
      expect(objects(shipped.root)).toEqual(objects(ref));
      expect(shallow(shipped.root)).toEqual(shallow(ref));
      // fails-when: a merge's second parent line shortens the recorded depth, so every run warns
      expect(shipped.record.fetchDepth).toBe(depth);
      expect(shipped.warnings).toEqual([]);
    }
    expect((await ship(src, { depth: 0, tags: GitTagMode.Default })).record.fetchDepth).toBe(0);

    // A depth-2 clone holds the merge and both of its parents.
    const shallowSrc = cloneRef(src, ['--depth', '2', '--branch', 'main']);
    const full = await ship(shallowSrc, { depth: 0, tags: GitTagMode.Default });
    expect(git(full.root, ['rev-list', '--count', 'HEAD'])).toBe('3');
    expect(full.record.fetchDepth).toBe(2);
  });

  it('writes the generated config, never the developer config', async () => {
    const src = makeSourceRepo();
    const shipped = await ship(src, { depth: 1, tags: GitTagMode.Default });
    // fails-when: the developer's .git/config (or any key of it) ships
    expect(readFileSync(join(shipped.root, '.git', 'config'), 'utf8')).toBe(
      renderShippedGitConfig({
        objectFormat: GitObjectFormat.Sha1,
        originUrl: 'https://example.com/r.git',
        branch: 'main',
        depth: 1,
      }),
    );
  });

  it('ships nothing from the forbidden list', async () => {
    const src = makeSourceRepo();
    const shipped = await ship(src, { depth: 1, tags: GitTagMode.Default });
    // fails-when: any of these ships
    for (const p of [
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
    ]) {
      expect(existsSync(join(shipped.root, '.git', p)), p).toBe(false);
    }
    expect(shipped.files.filter((f) => /^\.git\/objects\/[0-9a-f]{2}\//.test(f))).toEqual([]);
    expect(readdirSync(shipped.root)).toEqual(['.git']);
    expect(shipped.files).toEqual([...shipped.files].sort());
    expect(shipped.files).toContain('.git/HEAD');
    expect(shipped.files).toContain('.git/index');
  });

  it('ships .git/info/exclude exactly as a clone writes it, and nothing else under info/', async () => {
    const src = makeSourceRepo();
    const shipped = await ship(src, { depth: 1, tags: GitTagMode.Default });
    const ref = cloneRef(src, ['--depth', '1', '--branch', 'main']);
    // breaks-if-wrong: the agent's dep-restore appends to .git/info/exclude and gets ENOENT when info/ is missing,
    //   so its scratch dirs show in the remote `git status`
    // fails-when: info/ is pruned (no exclude) or the developer's own exclude patterns ship
    expect(readdirSync(join(shipped.root, '.git', 'info'))).toEqual(['exclude']);
    const exclude = readFileSync(join(shipped.root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toBe(readFileSync(join(ref, '.git', 'info', 'exclude'), 'utf8'));
    expect(exclude).not.toContain('dev-only-scratch');
  });

  it('writes an index whose checkout reports a clean status', async () => {
    const src = makeSourceRepo();
    const shipped = await ship(src, { depth: 1, tags: GitTagMode.Default });
    const workspace = agentWorkspace(src, shipped);
    // fails-when: the index is missing or describes another tree, so every file reads as added or deleted
    expect(git(workspace, ['status', '--porcelain'])).toBe('');
    expect(git(workspace, ['ls-files']).split('\n').sort()).toEqual([...trackedPaths(src)].sort());
  });

  it('marks unshipped tracked paths skip-worktree so status stays clean', async () => {
    const src = makeSourceRepo();
    const paths = trackedPaths(src);
    paths.delete('f2.txt');
    const shipped = await ship(src, { depth: 1, tags: GitTagMode.Default }, paths);
    const workspace = agentWorkspace(src, shipped);
    unlinkSync(join(workspace, 'f2.txt'));
    // fails-when: an unshipped tracked file reads as deleted in the remote `git status`
    expect(git(workspace, ['status', '--porcelain'])).toBe('');
    const flagged = git(workspace, ['ls-files', '-v'])
      .split('\n')
      .filter((l) => l.startsWith('S '));
    expect(flagged).toEqual(['S f2.txt']);
  });

  it("ignores the developer's global git config", async () => {
    const src = makeSourceRepo();
    const dir = tempDir('devglobal');
    const marker = join(dir, 'hook-ran');
    const hook = `#!/bin/sh\necho ran >> '${marker}'\n`;
    writeIn(dir, 'template/hooks/pre-commit', hook);
    writeIn(dir, 'hooks/reference-transaction', hook);
    writeIn(dir, 'hooks/post-checkout', hook);
    chmodSync(join(dir, 'template/hooks/pre-commit'), 0o755);
    chmodSync(join(dir, 'hooks/reference-transaction'), 0o755);
    chmodSync(join(dir, 'hooks/post-checkout'), 0o755);
    // A signing program that records each call and refuses to sign.
    const signMarker = join(dir, 'gpg-ran');
    writeIn(dir, 'fake-gpg', `#!/bin/sh\necho ran >> '${signMarker}'\nexit 1\n`);
    chmodSync(join(dir, 'fake-gpg'), 0o755);
    const devGlobal = join(dir, 'gitconfig');
    writeFileSync(
      devGlobal,
      '[commit]\n\tgpgSign = true\n[tag]\n\tgpgSign = true\n' +
        `[gpg]\n\tprogram = ${join(dir, 'fake-gpg')}\n` +
        `[init]\n\ttemplateDir = ${join(dir, 'template')}\n` +
        `[core]\n\thooksPath = ${join(dir, 'hooks')}\n`,
    );

    // Positive control: under this global config, a ref update runs the hook.
    const control = join(tempDir('control'), 'repo');
    const devEnv = { ...testEnv(), GIT_CONFIG_GLOBAL: devGlobal };
    execFileSync('git', ['init', '-q', control], { env: devEnv });
    expect(existsSync(join(control, '.git', 'hooks', 'pre-commit'))).toBe(true);
    const blob = execFileSync('git', ['-C', control, 'hash-object', '-w', '--stdin'], {
      env: devEnv,
      input: 'control\n',
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['-C', control, 'update-ref', 'refs/tags/x', blob], {
      env: devEnv,
      stdio: 'ignore',
    });
    expect(existsSync(marker)).toBe(true);
    // Positive control: under this global config, a commit is signed through the fake program.
    const signed = spawnSync(
      'git',
      ['-C', control, 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'x'],
      {
        env: devEnv,
        encoding: 'utf8',
      },
    );
    expect(signed.status).not.toBe(0);
    expect(existsSync(signMarker)).toBe(true);
    unlinkSync(marker);
    unlinkSync(signMarker);

    writeIn(src, 'f1.txt', 'dirty\n');
    const overlay = await overlayOf(src);
    vi.stubEnv('GIT_CONFIG_GLOBAL', devGlobal);
    vi.stubEnv('GIT_INDEX_FILE', join(dir, 'stray-index'));
    const shipped = await ship(
      src,
      { depth: 1, tags: GitTagMode.Default, commit: true },
      overlay.shippedPaths,
      overlay.deletions,
      overlay.changedPaths,
    );
    // fails-when: a template hook or a hooksPath hook reaches the build, or an inherited GIT_* variable redirects a write
    expect(existsSync(join(shipped.root, '.git', 'hooks'))).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(dir, 'stray-index'))).toBe(false);
    expect(existsSync(join(shipped.root, '.git', 'index'))).toBe(true);
    // fails-when: the synthetic commit is signed, or the signing config reaches its build
    expect(shipped.synthetic).toBe(true);
    expect(git(shipped.root, ['cat-file', 'commit', 'HEAD'])).not.toContain('gpgsig');
    expect(existsSync(signMarker)).toBe(false);
  });

  it('ships a sha256 repository with its object format', async () => {
    const src = join(tempDir('sha256'), 'src');
    mkdirSync(src);
    git(src, ['init', '-q', '-b', 'main', '--object-format=sha256']);
    writeIn(src, 'a.txt', 'a\n');
    git(src, ['add', '-A']);
    git(src, ['commit', '-qm', 'one']);
    const shipped = await ship(src, { depth: 1, tags: GitTagMode.Default });
    expect(git(shipped.root, ['rev-parse', '--show-object-format'])).toBe('sha256');
    expect(git(shipped.root, ['rev-parse', 'HEAD'])).toBe(git(src, ['rev-parse', 'HEAD']));
    expect(git(agentWorkspace(src, shipped), ['status', '--porcelain'])).toBe('');
  });

  it('skips the .git when .kici is not at the repository top level', async () => {
    const src = makeSourceRepo();
    expect(
      await buildShippedGit({
        repoRoot: join(src, 'sub'),
        workDir: tempDir('work'),
        options: { depth: 1, tags: GitTagMode.Default },
        shippedPaths: new Set(['s.txt']),
        deletions: [],
        changedPaths: new Set(),
      }),
    ).toEqual({ skipped: expect.stringContaining('not at the repository top level') });
  });

  it('refuses an unborn HEAD with an actionable error', async () => {
    const emptyInit = join(tempDir('empty'), 'repo');
    mkdirSync(emptyInit);
    git(emptyInit, ['init', '-q']);
    await expect(
      buildShippedGit({
        repoRoot: emptyInit,
        workDir: tempDir('work'),
        options: { depth: 1, tags: GitTagMode.Default },
        shippedPaths: new Set(),
        deletions: [],
        changedPaths: new Set(),
      }),
    ).rejects.toThrow('kici run remote needs at least one commit');
  });
});

describe('buildShippedGit synthetic commit', { timeout: 60_000 }, () => {
  beforeEach(() => {
    // The author the developer's commit would carry comes from these first.
    vi.stubEnv('GIT_AUTHOR_NAME', undefined);
    vi.stubEnv('GIT_AUTHOR_EMAIL', undefined);
  });

  /** `makeSourceRepo` with a developer identity in its config. */
  function devRepo(): string {
    const src = makeSourceRepo();
    git(src, ['config', 'user.name', 'Dev']);
    git(src, ['config', 'user.email', 'dev@example.com']);
    return src;
  }

  it('a dirty tree ships a synthetic commit on top of HEAD', async () => {
    const src = devRepo();
    const base = git(src, ['rev-parse', 'HEAD']);
    dirty(src);

    // No commitAuthor or commitMessage: buildShippedGit applies both defaults.
    const { shipped, shippedPaths } = await shipDirty(src, {
      depth: 1,
      tags: GitTagMode.Default,
      commit: true,
    });

    const ship = shipped.root;
    expect(shipped.synthetic).toBe(true);
    expect(shipped.baseSha).toBe(base);
    expect(shipped.workspaceSha).toBe(git(ship, ['rev-parse', 'HEAD']));
    expect(shipped.parentSha).toBe(base);
    expect(git(ship, ['rev-parse', 'HEAD^'])).toBe(base);
    expect(git(ship, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
    // fails-when: origin/main moves to the synthetic commit, so the remote workspace shows no unpushed commit
    expect(git(ship, ['rev-parse', 'refs/remotes/origin/main'])).toBe(base);
    expect(git(ship, ['log', '-1', '--format=%an <%ae>|%cn <%ce>|%s'])).toBe(
      'Dev <dev@example.com>|KiCI <noreply@kici.dev>|kici: working-tree snapshot',
    );
    // fails-when: a gitignored file enters the tree, a deleted file stays, or an untracked file is left out
    expect(treePaths(ship, 'HEAD')).toEqual([
      '.gitignore',
      'f1.txt',
      'f2.txt',
      'f4.txt',
      'f5.txt',
      'new.txt',
      'run.sh',
      'sub/s.txt',
    ]);
    expect(git(ship, ['cat-file', 'blob', 'HEAD:f1.txt'])).toBe('modified');
    expect(git(ship, ['cat-file', 'blob', 'HEAD:f2.txt'])).toBe('staged');
    // breaks-if-wrong: an unchanged executable keeps its mode
    expect(git(ship, ['ls-tree', 'HEAD', 'run.sh']).split(' ')[0]).toBe('100755');
    // fails-when: the index or tree does not match the shipped working tree
    expect(statusAfterCheckout(src, shipped, shippedPaths)).toEqual([]);
  });

  it('a dirty detached HEAD ships the synthetic commit as a detached HEAD', async () => {
    const src = devRepo();
    git(src, ['checkout', '-q', '--detach', 'HEAD~1']);
    const base = git(src, ['rev-parse', 'HEAD']);
    writeIn(src, 'new.txt', 'new\n');

    const { shipped, shippedPaths } = await shipDirty(src, {
      depth: 1,
      tags: GitTagMode.None,
      commit: true,
    });

    expect(shipped.synthetic).toBe(true);
    expect(shipped.branch).toBeUndefined();
    expect(readFileSync(join(shipped.root, '.git', 'HEAD'), 'utf8')).toBe(
      `${shipped.workspaceSha}\n`,
    );
    expect(git(shipped.root, ['rev-parse', 'HEAD^'])).toBe(base);
    expect(statusAfterCheckout(src, shipped, shippedPaths)).toEqual([]);
  });

  it('honours --commit-message and --commit-author', async () => {
    const src = devRepo();
    dirty(src);
    const { shipped } = await shipDirty(src, {
      depth: 1,
      tags: GitTagMode.Default,
      commit: true,
      commitMessage: 'wip: try the deploy',
      commitAuthor: { name: 'Ada Lovelace', email: 'ada@example.com' },
    });
    // fails-when: an override is dropped for the default; the committer stays KiCI either way
    expect(git(shipped.root, ['log', '-1', '--format=%an <%ae>|%cn <%ce>|%B'])).toBe(
      'Ada Lovelace <ada@example.com>|KiCI <noreply@kici.dev>|wip: try the deploy',
    );
  });

  it('depth 1 ships the synthetic commit plus the real HEAD', async () => {
    const src = devRepo();
    const base = git(src, ['rev-parse', 'HEAD']);
    dirty(src);
    const { shipped } = await shipDirty(src, { depth: 1, tags: GitTagMode.Default, commit: true });
    const ref = cloneRef(src, ['--depth', '1', '--branch', 'main']);
    // fails-when: the synthetic commit counts toward the depth, so the real HEAD is cut off
    expect(git(shipped.root, ['rev-list', '--count', 'HEAD'])).toBe('2');
    expect(shallow(shipped.root)).toEqual(shallow(ref));
    expect(shallow(shipped.root)).toEqual([base]);
    expect(shipped.record).toEqual({ fetchDepth: 1, allTags: false });
    expect(shipped.warnings).toEqual([]);
  });

  it('a clean tree ships HEAD and no synthetic commit', async () => {
    const src = devRepo();
    const base = git(src, ['rev-parse', 'HEAD']);
    const { shipped, shippedPaths } = await shipDirty(src, {
      depth: 1,
      tags: GitTagMode.Default,
      commit: true,
    });
    // fails-when: an unchanged tree still gets a synthetic commit
    expect(shipped.synthetic).toBe(false);
    expect(shipped.workspaceSha).toBe(base);
    expect(git(shipped.root, ['rev-parse', 'HEAD'])).toBe(base);
    expect(statusAfterCheckout(src, shipped, shippedPaths)).toEqual([]);
  });

  it.each<[string, boolean | undefined]>([
    ['commit: false', false],
    ['commit absent', undefined],
  ])('--no-commit (%s) ships HEAD with the changes uncommitted', async (_case, commit) => {
    const src = devRepo();
    const base = git(src, ['rev-parse', 'HEAD']);
    dirty(src);
    const { shipped, shippedPaths } = await shipDirty(src, {
      depth: 1,
      tags: GitTagMode.Default,
      ...(commit === undefined ? {} : { commit }),
    });
    expect(shipped.synthetic).toBe(false);
    expect(git(shipped.root, ['rev-parse', 'HEAD'])).toBe(base);
    // fails-when: a change is hidden from the remote `git status` (a deletion marked skip-worktree)
    const status = statusAfterCheckout(src, shipped, shippedPaths);
    expect(status).toEqual([' D f3.txt', ' M f1.txt', ' M f2.txt', '?? .gitignore', '?? new.txt']);
    // fails-when: the recorded uncommitted paths miss a change the remote `git status` shows
    expect(shipped.uncommittedPaths).toEqual(status.map((line) => line.slice(3)).sort());
  });

  it("a .kiciignored tracked file keeps HEAD's content and status stays clean", async () => {
    const src = devRepo();
    writeIn(src, 'f1.txt', 'local only\n');
    writeIn(src, 'new.txt', 'new\n');
    writeIn(src, '.kiciignore', 'f1.txt\n');
    const { shipped, shippedPaths } = await shipDirty(src, {
      depth: 1,
      tags: GitTagMode.Default,
      commit: true,
    });
    expect(shipped.synthetic).toBe(true);
    // fails-when: the .kiciignored local content enters the synthetic tree
    expect(git(shipped.root, ['rev-parse', 'HEAD:f1.txt'])).toBe(
      git(shipped.root, ['rev-parse', 'HEAD^:f1.txt']),
    );
    expect(statusAfterCheckout(src, shipped, shippedPaths)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'keeps a file named with spaces, ü and a newline in the synthetic tree',
    async () => {
      const src = devRepo();
      const name = 'dir with space/ü\nname.txt';
      writeIn(src, name, 'odd\n');
      const { shipped, shippedPaths } = await shipDirty(src, {
        depth: 1,
        tags: GitTagMode.Default,
        commit: true,
      });
      // fails-when: the name reaches git C-quoted or split at the newline
      expect(treePaths(shipped.root, 'HEAD')).toContain(name);
      expect(gitRaw(shipped.root, ['cat-file', 'blob', `HEAD:${name}`])).toBe('odd\n');
      expect(statusAfterCheckout(src, shipped, shippedPaths)).toEqual([]);
    },
  );

  it('replaces a tracked file turned into a directory and a directory turned into a symlink', async () => {
    const src = devRepo();
    rmSync(join(src, 'f4.txt'));
    writeIn(src, 'f4.txt/inside.txt', 'inside\n');
    rmSync(join(src, 'sub'), { recursive: true });
    symlinkSync('f4.txt', join(src, 'sub'));
    const { shipped, shippedPaths } = await shipDirty(src, {
      depth: 1,
      tags: GitTagMode.Default,
      commit: true,
    });
    // fails-when: the path that changed kind is refused as a file/directory conflict
    expect(treePaths(shipped.root, 'HEAD')).toEqual(
      expect.arrayContaining(['f4.txt/inside.txt', 'sub']),
    );
    expect(treePaths(shipped.root, 'HEAD')).not.toContain('sub/s.txt');
    expect(git(shipped.root, ['ls-tree', 'HEAD', 'sub']).split(' ')[0]).toBe('120000');
    expect(statusAfterCheckout(src, shipped, shippedPaths)).toEqual([]);
  });

  /**
   * `kici run remote`'s upload of `src` (full working tree, depth 1, a
   * synthetic commit), extracted into a new directory as the agent receives it.
   */
  async function shipAndExtract(src: string) {
    const result = await createOverlayTarball(src, {
      fullWorkingTree: true,
      git: { depth: 1, tags: GitTagMode.Default, commit: true },
    });
    const remote = tempDir('extracted');
    execFileSync('tar', ['-xzf', result.tarballPath, '-C', remote]);
    rmSync(dirname(result.tarballPath), { recursive: true, force: true });
    return { result, remote };
  }

  it('keeps a dangling tracked symlink in the synthetic tree, skip-worktree', async () => {
    const src = devRepo();
    symlinkSync('missing-target', join(src, 'dangling'));
    git(src, ['add', 'dangling']);
    git(src, ['commit', '-qm', 'dangling link']);
    writeIn(src, 'new.txt', 'new\n');
    // Through the production path: createOverlayTarball assembles the deletions.
    const { result, remote } = await shipAndExtract(src);
    expect(result.git?.synthetic).toBe(true);
    // fails-when: the dangling-link filter leaves uploader.ts, so the synthetic commit deletes a link the developer never deleted
    expect(treePaths(remote, 'HEAD')).toEqual(expect.arrayContaining(['dangling', 'new.txt']));
    expect(git(remote, ['ls-files', '-v', '--', 'dangling'])).toBe('S dangling');
    expect(result.manifest.deletions).toContain('dangling');
  });

  it.each([
    ['untracked: left out of the synthetic tree', false],
    ['tracked: kept in the synthetic tree, skip-worktree', true],
  ])(
    'keeps the remote status clean for a skipped outside directory symlink (%s)',
    async (_case, tracked) => {
      const src = devRepo();
      const store = tempDir('store');
      writeIn(store, 'pkg/index.js', 'module.exports = 1;\n');
      // A symlinked node_modules that `node_modules/` would not ignore.
      symlinkSync(store, join(src, 'node_modules'));
      if (tracked) {
        git(src, ['add', 'node_modules']);
        git(src, ['commit', '-qm', 'node_modules link']);
      }
      writeIn(src, 'new.txt', 'new\n');
      const { result, remote } = await shipAndExtract(src);
      // The agent removes the manifest directory once the overlay applies.
      rmSync(join(remote, '.kici-overlay-tmp'), { recursive: true, force: true });
      expect(result.git?.synthetic).toBe(true);
      // breaks-if-wrong: the link is really skipped, so the remote workspace lacks it
      expect(existsSync(join(remote, 'node_modules'))).toBe(false);
      expect(lstatSync(join(src, 'node_modules')).isSymbolicLink()).toBe(true);
      expect(treePaths(remote, 'HEAD')).toContain('new.txt');
      if (tracked) {
        expect(treePaths(remote, 'HEAD')).toContain('node_modules');
        expect(git(remote, ['ls-files', '-v', '--', 'node_modules'])).toBe('S node_modules');
      } else {
        // fails-when: the synthetic commit records a link the overlay did not ship
        expect(treePaths(remote, 'HEAD')).not.toContain('node_modules');
      }
      // fails-when: the remote `git status` reports the skipped link deleted or changed
      expect(git(remote, ['status', '--porcelain'])).toBe('');
    },
  );

  it('ships the synthetic commit in pack form only', async () => {
    const src = devRepo();
    dirty(src);
    const { shipped } = await shipDirty(src, { depth: 1, tags: GitTagMode.Default, commit: true });
    expect(shipped.synthetic).toBe(true);
    // fails-when: the synthetic commit's objects ship loose, or its temporary index ships
    expect(shipped.files.filter((f) => /^\.git\/objects\/[0-9a-f]{2}\//.test(f))).toEqual([]);
    expect(shipped.files).not.toContain('.git/kici-synth-index');
    expect(storedObjects(shipped.root)).toEqual(objects(shipped.root));
  });

  it("honours the developer's global attributes file", async () => {
    const src = devRepo();
    writeIn(src, 'crlf.txt', 'a\r\nb\r\n');
    const xdg = tempDir('xdg');
    writeIn(xdg, 'git/attributes', '* text=auto eol=crlf\n');
    const xdgEnv = { ...testEnv(), XDG_CONFIG_HOME: xdg };
    // Positive control: the developer's git normalizes the file under this global attributes file.
    const hash = (args: string[]): string =>
      execFileSync('git', ['hash-object', ...args], { cwd: src, env: xdgEnv, encoding: 'utf8' });
    expect(hash(['crlf.txt'])).not.toBe(hash(['--no-filters', 'crlf.txt']));

    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    const { shipped, shippedPaths } = await shipDirty(src, {
      depth: 1,
      tags: GitTagMode.Default,
      commit: true,
    });
    vi.unstubAllEnvs();
    // fails-when: the synthetic commit skips the developer's global attributes, so it stores other bytes than their own commit
    expect(gitRaw(shipped.root, ['cat-file', 'blob', 'HEAD:crlf.txt'])).toBe('a\nb\n');
    // The agent reads no global attributes file: it gets what its checkout writes.
    expect(readFileSync(join(shipped.checkout?.root ?? '', 'crlf.txt'), 'utf8')).toBe('a\nb\n');
    expect(statusAfterCheckout(src, shipped, shippedPaths)).toEqual([]);
  });

  /**
   * `devRepo` as a Windows checkout under `core.autocrlf=true` holds it: every
   * text file but `run.sh` in CRLF, plus a binary file with CRLF bytes. Then
   * `f1.txt` is modified and `new.txt` added.
   */
  function crlfRepo(): string {
    const src = devRepo();
    git(src, ['config', 'core.autocrlf', 'true']);
    writeFileSync(join(src, 'bin.dat'), Buffer.from([0, 13, 10, 1, 13, 10]));
    git(src, ['add', 'bin.dat']);
    git(src, ['commit', '-qm', 'binary']);
    // Checked out again by git itself, so the index records the CRLF files' stat data.
    const textFiles = ['f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt', 'sub/s.txt'];
    for (const file of textFiles) unlinkSync(join(src, file));
    git(src, ['checkout', '--', ...textFiles]);
    expect(readFileSync(join(src, 'f2.txt'), 'utf8')).toBe('2\r\n');
    writeIn(src, 'f1.txt', 'modified\r\n');
    writeIn(src, 'new.txt', 'new\r\n');
    // Positive control: the developer's own git sees exactly these changes.
    expect(gitRaw(src, ['status', '--porcelain=v1', '-z']).split('\0').filter(Boolean)).toEqual([
      ' M f1.txt',
      '?? new.txt',
    ]);
    return src;
  }

  it('core.autocrlf=true: a default run leaves the remote status clean', async () => {
    const src = crlfRepo();
    const { shipped, shippedPaths } = await shipDirty(src, {
      depth: 1,
      tags: GitTagMode.Default,
      commit: true,
    });
    expect(git(shipped.root, ['cat-file', 'blob', 'HEAD:f1.txt'])).toBe('modified');
    // fails-when: the CRLF working-tree bytes ship over LF blobs, so every converted file reads as modified
    expect(statusAfterCheckout(src, shipped, shippedPaths)).toEqual([]);
    // breaks-if-wrong: binary and unconverted files ship as the developer has them
    expect(shipped.checkout?.paths.sort()).toEqual([
      'f1.txt',
      'f2.txt',
      'f3.txt',
      'f4.txt',
      'f5.txt',
      'new.txt',
      'sub/s.txt',
    ]);
    expect(readFileSync(join(shipped.checkout?.root ?? '', 'f2.txt'), 'utf8')).toBe('2\n');
  });

  it('core.autocrlf=true: --no-commit shows only the changed files', async () => {
    const src = crlfRepo();
    const { shipped, shippedPaths } = await shipDirty(src, {
      depth: 1,
      tags: GitTagMode.Default,
      commit: false,
    });
    // fails-when: an unchanged CRLF file ships over its LF blob and reads as modified remotely
    expect(statusAfterCheckout(src, shipped, shippedPaths)).toEqual([' M f1.txt', '?? new.txt']);
    // A changed file has no commit to check out: it ships as the developer has it.
    expect(shipped.checkout?.paths.sort()).toEqual([
      'f2.txt',
      'f3.txt',
      'f4.txt',
      'f5.txt',
      'sub/s.txt',
    ]);
  });

  it('applies a repository eol=crlf attribute to the shipped checkout bytes', async () => {
    const src = devRepo();
    writeIn(src, '.gitattributes', '*.txt text eol=crlf\n');
    git(src, ['add', '.gitattributes']);
    git(src, ['commit', '-qm', 'eol']);
    // Checked out again by git, so the working tree holds CRLF as a real checkout writes it.
    unlinkSync(join(src, 'f2.txt'));
    git(src, ['checkout', '--', 'f2.txt']);
    writeIn(src, 'new.txt', 'new\r\n');
    // Positive control: f2.txt's bytes differ from its LF blob, so it goes through the checkout.
    expect(readFileSync(join(src, 'f2.txt'), 'utf8')).toBe('2\r\n');
    expect(git(src, ['hash-object', '--no-filters', 'f2.txt'])).not.toBe(
      git(src, ['rev-parse', 'HEAD:f2.txt']),
    );

    const { shipped, shippedPaths } = await shipDirty(src, {
      depth: 1,
      tags: GitTagMode.Default,
      commit: true,
    });
    expect(git(shipped.root, ['cat-file', 'blob', 'HEAD:new.txt'])).toBe('new');
    // fails-when: the checkout ignores the repository's attributes and ships LF where a real checkout writes CRLF
    expect(shipped.checkout?.paths ?? []).not.toContain('f2.txt');
    expect(shipped.checkout?.paths ?? []).not.toContain('new.txt');
    expect(statusAfterCheckout(src, shipped, shippedPaths)).toEqual([]);
  });

  it('core.fileMode=false: a clean tree ships HEAD and keeps the executable bit', async () => {
    const src = devRepo();
    git(src, ['config', 'core.fileMode', 'false']);
    chmodSync(join(src, 'run.sh'), 0o644);
    // Positive control: the developer's git sees no change.
    expect(git(src, ['status', '--porcelain'])).toBe('');
    const clean = await shipDirty(src, { depth: 1, tags: GitTagMode.Default, commit: true });
    // fails-when: the synthetic tree is built without the developer's core.fileMode, so the clean tree gets a commit
    expect(clean.shipped.synthetic).toBe(false);
    expect(git(clean.shipped.root, ['ls-tree', 'HEAD', 'run.sh']).split(' ')[0]).toBe('100755');
    // The remote checkout writes the executable bit, so its status is clean.
    expect(clean.shipped.checkout?.paths).toEqual(['run.sh']);
    expect(statSync(join(clean.shipped.checkout?.root ?? '', 'run.sh')).mode & 0o100).toBe(0o100);
    expect(statusAfterCheckout(src, clean.shipped, clean.shippedPaths)).toEqual([]);

    // breaks-if-wrong: a changed file keeps HEAD's mode, as the developer's `git add` does
    writeIn(src, 'run.sh', '#!/bin/sh\necho changed\n');
    const dirtyShip = await shipDirty(src, { depth: 1, tags: GitTagMode.Default, commit: true });
    expect(dirtyShip.shipped.synthetic).toBe(true);
    expect(git(dirtyShip.shipped.root, ['ls-tree', 'HEAD', 'run.sh']).split(' ')[0]).toBe('100755');
    expect(statusAfterCheckout(src, dirtyShip.shipped, dirtyShip.shippedPaths)).toEqual([]);
  });

  it("re-adds only the paths the developer's git reports as changed", async () => {
    const src = devRepo();
    writeIn(src, 'f2.txt', 'hidden local edit\n');
    git(src, ['update-index', '--assume-unchanged', 'f2.txt']);
    // Positive control: the developer's git reports no change.
    expect(git(src, ['status', '--porcelain'])).toBe('');
    const { shipped } = await shipDirty(src, { depth: 1, tags: GitTagMode.Default, commit: true });
    // fails-when: every shipped path is re-added, so a path the developer's git calls unchanged enters a commit
    expect(shipped.synthetic).toBe(false);
  });

  it("honours the developer's filter driver", async () => {
    const src = devRepo();
    // An LFS-like clean filter: the blob is a pointer naming the content's hash.
    git(src, ['config', 'filter.fake.clean', "sh -c 'echo pointer; sha256sum | cut -c1-12'"]);
    writeIn(src, '.gitattributes', '*.bin filter=fake\n');
    writeIn(src, 'big.bin', 'RAW 1\n');
    git(src, ['add', '-A']);
    git(src, ['commit', '-qm', 'filtered']);
    // Positive control: HEAD holds the pointer and the developer's git sees no change.
    expect(git(src, ['cat-file', 'blob', 'HEAD:big.bin'])).toMatch(/^pointer\n[0-9a-f]{12}$/);
    expect(git(src, ['status', '--porcelain'])).toBe('');

    const clean = await shipDirty(src, { depth: 1, tags: GitTagMode.Default, commit: true });
    // fails-when: the synthetic tree is built without the developer's filter, so the raw content enters a commit
    expect(clean.shipped.synthetic).toBe(false);
    expect(clean.shipped.checkout?.paths ?? []).not.toContain('big.bin');

    writeIn(src, 'big.bin', 'RAW 2\n');
    const changed = await shipDirty(src, { depth: 1, tags: GitTagMode.Default, commit: true });
    expect(changed.shipped.synthetic).toBe(true);
    // fails-when: a changed filtered file stores its raw content instead of the pointer its own commit stores
    expect(git(changed.shipped.root, ['rev-parse', 'HEAD:big.bin'])).toBe(
      git(src, ['hash-object', 'big.bin']),
    );
    expect(git(changed.shipped.root, ['cat-file', 'blob', 'HEAD:big.bin'])).not.toContain('RAW');
    // The run needs the content, not the pointer: the file ships as the developer has it.
    expect(changed.shipped.checkout?.paths ?? []).not.toContain('big.bin');
  });

  it('leaves the developer repository untouched', async () => {
    const src = devRepo();
    dirty(src);
    const before = await snapshotRepo(src);
    const result = await createOverlayTarball(src, {
      fullWorkingTree: true,
      git: { depth: 1, tags: GitTagMode.Default, commit: true },
    });
    // breaks-if-wrong: the synthetic commit was really built, so the build path ran in full
    expect(result.git?.synthetic).toBe(true);
    const shipped = result.git as ShippedGit;
    // The pull-request diff kici run remote sends reads the developer repo too.
    const changed = computeRemoteChangedFiles({
      repoRoot: src,
      shipRoot: shipped.root,
      event: { type: 'pull_request', targetBranch: 'feature', payload: {} },
      workspaceSha: shipped.workspaceSha,
    });
    // breaks-if-wrong: the diff really ran against the developer repo and the synthetic commit
    expect(changed.files).toEqual(expect.arrayContaining(['f1.txt', 'f2.txt', 'new.txt']));
    // fails-when: any build or diff step writes into the developer repo (an object, a ref, the index, a reflog)
    expect(await snapshotRepo(src)).toBe(before);
    rmSync(dirname(result.tarballPath), { recursive: true, force: true });
  });
});

describe('buildShippedGit synthetic tags', { timeout: 60_000 }, () => {
  /** The tag's type, tagger, message and commit in the shipped repository. */
  function tagInfo(dir: string, name: string) {
    return {
      type: git(dir, ['cat-file', '-t', `refs/tags/${name}`]),
      tagger: git(dir, [
        'for-each-ref',
        '--format=%(taggername) %(taggeremail)',
        `refs/tags/${name}`,
      ]),
      message: git(dir, ['for-each-ref', '--format=%(contents)', `refs/tags/${name}`]),
      commit: git(dir, ['rev-parse', `${name}^{commit}`]),
    };
  }

  it('creates an annotated tag at the synthetic commit', async () => {
    const src = makeSourceRepo();
    dirty(src);
    const { shipped } = await shipDirty(src, {
      depth: 1,
      tags: GitTagMode.None,
      commit: true,
      syntheticTags: ['v9'],
    });
    expect(shipped.synthetic).toBe(true);
    // fails-when: the tag is lightweight, points at HEAD instead of the synthetic commit, or has another tagger
    expect(tagInfo(shipped.root, 'v9')).toEqual({
      type: 'tag',
      tagger: 'KiCI <noreply@kici.dev>',
      message: 'v9',
      commit: shipped.workspaceSha,
    });
    // `git describe` without --tags reads annotated tags only.
    expect(git(shipped.root, ['describe'])).toBe('v9');
    // fails-when: the tag ref is created after the file list is taken, so it never ships
    expect(shipped.files).toContain('.git/refs/tags/v9');
    expect(shipped.createdTags).toEqual(['v9']);
    expect(shipped.replacedTags).toEqual([]);
  });

  it('points at HEAD under --no-commit', async () => {
    const src = makeSourceRepo();
    const base = git(src, ['rev-parse', 'HEAD']);
    dirty(src);
    const { shipped } = await shipDirty(src, {
      depth: 1,
      tags: GitTagMode.Default,
      syntheticTags: ['v9'],
    });
    expect(shipped.synthetic).toBe(false);
    expect(tagInfo(shipped.root, 'v9').commit).toBe(base);
    expect(git(agentWorkspace(src, shipped), ['rev-parse', 'v9^{commit}'])).toBe(base);
  });

  it('is repeatable', async () => {
    const src = makeSourceRepo();
    dirty(src);
    const { shipped } = await shipDirty(src, {
      depth: 1,
      tags: GitTagMode.None,
      commit: true,
      syntheticTags: ['a', 'release/b'],
    });
    expect(git(shipped.root, ['tag', '-l']).split('\n')).toEqual(['a', 'release/b']);
    expect(tagInfo(shipped.root, 'a').commit).toBe(shipped.workspaceSha);
    expect(tagInfo(shipped.root, 'release/b').commit).toBe(shipped.workspaceSha);
    expect(shipped.createdTags).toEqual(['a', 'release/b']);
  });

  it('replaces a shipped tag of the same name and reports it', async () => {
    const src = makeSourceRepo();
    const base = git(src, ['rev-parse', 'HEAD']);
    dirty(src);
    const overlay = await overlayOf(src);
    const options = { depth: 1, tags: GitTagMode.All, commit: true };
    // Positive control: without --tag, the developer's annotated `ann` ships at their HEAD.
    const plain = await shipOverlay(src, options, overlay);
    expect(tagInfo(plain.root, 'ann')).toMatchObject({ message: 'annotated', commit: base });
    expect(plain.replacedTags).toEqual([]);

    const shipped = await shipOverlay(src, { ...options, syntheticTags: ['ann'] }, overlay);
    // fails-when: an existing shipped tag is not detected, so it is not reported or `tag -a` refuses it
    expect(shipped.replacedTags).toEqual(['ann']);
    expect(tagInfo(shipped.root, 'ann')).toEqual({
      type: 'tag',
      tagger: 'KiCI <noreply@kici.dev>',
      message: 'ann',
      commit: shipped.workspaceSha,
    });
    // breaks-if-wrong: the other shipped tags stay as the developer has them
    expect(git(shipped.root, ['rev-parse', 'light'])).toBe(git(src, ['rev-parse', 'light']));
  });

  it('ships even with tags: None', async () => {
    const src = makeSourceRepo();
    // Positive control: tags: None ships none of the developer's tags.
    const none = await ship(src, { depth: 0, tags: GitTagMode.None });
    expect(git(none.root, ['tag', '-l'])).toBe('');
    const shipped = await ship(src, { depth: 0, tags: GitTagMode.None, syntheticTags: ['v9'] });
    // fails-when: the tag policy filters the synthetic tag out
    expect(git(shipped.root, ['tag', '-l'])).toBe('v9');
    expect(tagInfo(shipped.root, 'v9').commit).toBe(git(src, ['rev-parse', 'HEAD']));
  });

  it('never creates the tag in the developer repo', async () => {
    const src = makeSourceRepo();
    dirty(src);
    const before = await snapshotRepo(src);
    const result = await createOverlayTarball(src, {
      fullWorkingTree: true,
      git: { depth: 1, tags: GitTagMode.Default, commit: true, syntheticTags: ['v9'] },
    });
    // breaks-if-wrong: the tag was really created, so the tag path ran in full
    expect(result.git?.createdTags).toEqual(['v9']);
    expect(result.git?.synthetic).toBe(true);
    expect(result.git?.files).toContain('.git/refs/tags/v9');
    // fails-when: the tag, its object or a reflog entry is written into the developer repo
    expect(git(src, ['tag', '-l', 'v9'])).toBe('');
    expect(await snapshotRepo(src)).toBe(before);
    rmSync(dirname(result.tarballPath), { recursive: true, force: true });
  });

  it('signs nothing when tag.gpgSign is set globally', async () => {
    const src = makeSourceRepo();
    const devGlobal = join(tempDir('tagsign'), 'gitconfig');
    writeFileSync(
      devGlobal,
      '[tag]\n\tgpgSign = true\n\tforceSignAnnotated = true\n[gpg]\n\tprogram = /bin/false\n',
    );
    // Positive control: under this global config, an annotated tag fails to sign.
    const control = spawnSync('git', ['-C', src, 'tag', '-a', '-m', 'x', 'control'], {
      env: { ...testEnv(), GIT_CONFIG_GLOBAL: devGlobal },
      encoding: 'utf8',
    });
    expect(control.status).not.toBe(0);
    expect(git(src, ['tag', '-l', 'control'])).toBe('');

    vi.stubEnv('GIT_CONFIG_GLOBAL', devGlobal);
    const shipped = await ship(src, { depth: 1, tags: GitTagMode.None, syntheticTags: ['v9'] });
    // fails-when: the tag is built by a git that reads the developer's signing config without --no-sign
    expect(tagInfo(shipped.root, 'v9').type).toBe('tag');
    expect(git(shipped.root, ['cat-file', 'tag', 'v9'])).not.toContain('SIGNATURE');
  });
});
