import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pr, push, schedule, tag, type FixtureOptions } from '@kici-dev/sdk';
import { buildFixtureEvent, type FixtureEvent } from '../fixtures/event.js';
import { GitTagMode, type ShippedGit } from './shipped-git/git-ship-types.js';
import { createOverlayTarball } from './uploader.js';
import { computeRemoteChangedFiles } from './remote-changed-files.js';

/** Temp roots, removed after each test. */
const roots: string[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(join(os.tmpdir(), `kici-remote-changed-${label}-`));
  roots.push(dir);
  return dir;
}

beforeEach(() => {
  // The developer's own git config never reaches the test repositories.
  const globalConfig = join(tempDir('global'), 'gitconfig');
  writeFileSync(globalConfig, '');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
  vi.stubEnv('GIT_AUTHOR_NAME', 'Test');
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'test@example.com');
  vi.stubEnv('GIT_COMMITTER_NAME', 'Test');
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'test@example.com');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function writeIn(dir: string, rel: string, content: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

function commit(dir: string, rel: string, message: string): void {
  writeIn(dir, rel, `${message}\n`);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', message]);
}

/**
 * `main` with `a.txt` and `b.txt`; `feature` branched from it with
 * `feat1.txt` and `feat2.txt`; then `main3.txt` on `main` after the branch
 * point. `feature` is checked out.
 */
function makeSourceRepo(): string {
  const src = join(tempDir('src'), 'src');
  mkdirSync(src);
  git(src, ['init', '-q', '-b', 'main']);
  commit(src, 'a.txt', 'a');
  commit(src, 'b.txt', 'b');
  git(src, ['checkout', '-q', '-b', 'feature']);
  commit(src, 'feat1.txt', 'feat1');
  commit(src, 'feat2.txt', 'feat2');
  git(src, ['checkout', '-q', 'main']);
  commit(src, 'main3.txt', 'main3');
  git(src, ['checkout', '-q', 'feature']);
  return src;
}

/** A modified, a deleted and an untracked file. */
function dirty(src: string): void {
  writeIn(src, 'a.txt', 'modified\n');
  unlinkSync(join(src, 'b.txt'));
  writeIn(src, 'new.txt', 'new\n');
}

/** Ship `src` as `kici run remote` does; the shipped repository stays beside the tarball. */
async function shipOf(src: string, commit = true): Promise<ShippedGit> {
  const { tempDir, git: shipped } = await createOverlayTarball(src, {
    fullWorkingTree: true,
    git: { depth: 1, tags: GitTagMode.Default, commit },
  });
  roots.push(tempDir.path);
  if (!shipped) throw new Error('no .git shipped');
  return shipped;
}

function eventOf(opts: FixtureOptions, shipped: ShippedGit): FixtureEvent {
  return buildFixtureEvent(opts, {
    branch: shipped.branch,
    sha: shipped.workspaceSha,
    ...(shipped.parentSha && { parentSha: shipped.parentSha }),
  });
}

function changed(src: string, shipped: ShippedGit, event: FixtureEvent) {
  return computeRemoteChangedFiles({
    repoRoot: src,
    shipRoot: shipped.root,
    event,
    workspaceSha: shipped.workspaceSha,
    ...(shipped.parentSha && { parentSha: shipped.parentSha }),
    ...(shipped.uncommittedPaths && { uncommittedPaths: shipped.uncommittedPaths }),
  });
}

const FEATURE_FILES = ['feat1.txt', 'feat2.txt'];
const DIRTY_FILES = ['a.txt', 'b.txt', 'new.txt'];

describe('computeRemoteChangedFiles', { timeout: 60_000 }, () => {
  it('push: lists before..after of the synthetic commit', async () => {
    const src = makeSourceRepo();
    const head = git(src, ['rev-parse', 'HEAD']);
    dirty(src);
    const shipped = await shipOf(src);
    expect(shipped.synthetic).toBe(true);
    expect(shipped.parentSha).toBe(head);
    // Positive control: the synthetic commit lives only in the shipped objects,
    // so a diff that does not read them cannot resolve it.
    expect(() => git(src, ['cat-file', '-e', shipped.workspaceSha])).toThrow();

    const event = eventOf({ event: push() }, shipped);
    expect(event.payload.before).toBe(head);
    // fails-when: the shipped objects are not an alternate, or the range is not parent..synthetic
    expect(changed(src, shipped, event)).toEqual({ files: DIRTY_FILES });
    // breaks-if-wrong: the synthetic commit already holds the changes, so none is listed twice
    expect(shipped.uncommittedPaths).toBeUndefined();
  });

  describe('--no-commit', () => {
    /** The dirty files, plus one the developer's git ignores. */
    function dirtyWithIgnored(src: string): void {
      dirty(src);
      writeIn(src, '.git/info/exclude', 'ignored.txt\n');
      writeIn(src, 'ignored.txt', 'secret\n');
    }

    it('push: lists HEAD^..HEAD and the uncommitted changes', async () => {
      const src = makeSourceRepo();
      const head = git(src, ['rev-parse', 'HEAD']);
      dirtyWithIgnored(src);
      const shipped = await shipOf(src, false);
      expect(shipped.synthetic).toBe(false);
      expect(shipped.workspaceSha).toBe(head);
      // fails-when: only the commit range is diffed, so the files under test are missing
      expect(changed(src, shipped, eventOf({ event: push() }, shipped))).toEqual({
        files: [...DIRTY_FILES, 'feat2.txt'].sort(),
      });
    });

    it('pull request: lists the merge-base diff and the uncommitted changes', async () => {
      const src = makeSourceRepo();
      dirtyWithIgnored(src);
      const shipped = await shipOf(src, false);
      // fails-when: only the commit range is diffed, so the files under test are missing
      expect(changed(src, shipped, eventOf({ event: pr(), branch: 'main' }, shipped))).toEqual({
        files: [...DIRTY_FILES, ...FEATURE_FILES].sort(),
      });
    });

    it('a clean tree lists the commit range only', async () => {
      const src = makeSourceRepo();
      const shipped = await shipOf(src, false);
      expect(shipped.uncommittedPaths).toBeUndefined();
      expect(changed(src, shipped, eventOf({ event: push() }, shipped))).toEqual({
        files: ['feat2.txt'],
      });
    });
  });

  it('push on a clean tree: lists HEAD^..HEAD', async () => {
    const src = makeSourceRepo();
    const shipped = await shipOf(src);
    expect(shipped.synthetic).toBe(false);
    expect(shipped.workspaceSha).toBe(git(src, ['rev-parse', 'HEAD']));
    // fails-when: a clean tree diffs anything but the last commit
    expect(changed(src, shipped, eventOf({ event: push() }, shipped))).toEqual({
      files: ['feat2.txt'],
    });
  });

  it('pull request: lists the three-dot diff against the base branch, uncommitted changes included', async () => {
    const src = makeSourceRepo();
    dirty(src);
    const shipped = await shipOf(src);
    const expected = { files: [...DIRTY_FILES, ...FEATURE_FILES].sort() };
    // fails-when: a two-dot diff lists main3.txt, a commit only the base has;
    // or the base diffs against HEAD and loses the uncommitted changes
    expect(changed(src, shipped, eventOf({ event: pr(), branch: 'main' }, shipped))).toEqual(
      expected,
    );
    // Every pull-request-family event diffs against its base.
    const review: FixtureEvent = { type: 'review', targetBranch: 'main', payload: {} };
    expect(changed(src, shipped, review)).toEqual(expected);
  });

  it('pull request: resolves origin/<base> when no local branch exists', async () => {
    const src = makeSourceRepo();
    git(src, ['update-ref', 'refs/remotes/origin/release', 'main']);
    expect(() => git(src, ['rev-parse', '--verify', '--quiet', 'refs/heads/release'])).toThrow();
    dirty(src);
    const shipped = await shipOf(src);
    // fails-when: only local branches are looked up, so a base known only from the remote sends no list
    expect(changed(src, shipped, eventOf({ event: pr(), branch: 'release' }, shipped))).toEqual({
      files: [...DIRTY_FILES, ...FEATURE_FILES].sort(),
    });
  });

  it('pull request with no local base: sends no list and one warning', async () => {
    const src = makeSourceRepo();
    const shipped = await shipOf(src);
    // fails-when: a missing base yields an empty list, which reads as "nothing changed"
    expect(changed(src, shipped, eventOf({ event: pr(), branch: 'nope' }, shipped))).toEqual({
      warning:
        "Base branch 'nope' does not exist locally, so the run sends no changed files; the agent decides path filters and ctx.changedFiles.",
    });
  });

  it('pull request whose base shares no history: sends no list and one warning', async () => {
    const src = makeSourceRepo();
    git(src, ['checkout', '-q', '--orphan', 'unrelated']);
    git(src, ['rm', '-rqf', '.']);
    commit(src, 'other.txt', 'other');
    git(src, ['checkout', '-q', 'feature']);
    // Positive control: the base really has no merge base with the feature branch.
    expect(() => git(src, ['merge-base', 'unrelated', 'feature'])).toThrow();
    const shipped = await shipOf(src);
    // fails-when: the missing merge base sends no list and prints nothing
    expect(changed(src, shipped, eventOf({ event: pr(), branch: 'unrelated' }, shipped))).toEqual({
      warning:
        "Base branch 'unrelated' shares no history with the workspace commit in your local repository (a shallow clone, or unrelated histories), so the run sends no changed files; the agent decides path filters and ctx.changedFiles.",
    });
  });

  it('push whose diff fails: sends no list and one warning naming the range', async () => {
    const src = makeSourceRepo();
    const shipped = await shipOf(src);
    const missing = '0'.repeat(40);
    // fails-when: a failing diff for a known parent sends no list and prints nothing
    expect(
      computeRemoteChangedFiles({
        repoRoot: src,
        shipRoot: shipped.root,
        event: eventOf({ event: push() }, shipped),
        workspaceSha: shipped.workspaceSha,
        parentSha: missing,
      }),
    ).toEqual({
      warning: `git diff ${missing}..${shipped.workspaceSha} failed, so the run sends no changed files; the agent decides path filters and ctx.changedFiles.`,
    });
  });

  it("sends no before and no changed files when HEAD's parent is absent locally", async () => {
    const src = makeSourceRepo();
    const clone = join(tempDir('shallow'), 'clone');
    git(dirname(clone), [
      'clone',
      '-q',
      '--depth',
      '1',
      '--branch',
      'feature',
      pathToFileURL(src).href,
      clone,
    ]);
    // Positive control: the clone really lacks HEAD's parent.
    expect(() => git(clone, ['rev-parse', '--verify', '--quiet', 'HEAD^'])).toThrow();
    const shipped = await shipOf(clone);
    expect(shipped.parentSha).toBeUndefined();
    const event = eventOf({ event: push() }, shipped);
    // fails-when: an unknown parent becomes an empty or made-up range
    expect(event.payload).not.toHaveProperty('before');
    expect(changed(clone, shipped, event)).toEqual({});
  });

  it('lists a non-ASCII path verbatim', async () => {
    const src = makeSourceRepo();
    writeIn(src, 'src/ü.ts', 'export {};\n');
    const shipped = await shipOf(src);
    // fails-when: git C-quotes the name ("src/\303\274.ts"), so no path pattern matches it
    expect(changed(src, shipped, eventOf({ event: push() }, shipped))).toEqual({
      files: ['src/ü.ts'],
    });
  });

  it('tag, schedule and manual events carry no list', async () => {
    const src = makeSourceRepo();
    dirty(src);
    const shipped = await shipOf(src);
    const manual: FixtureEvent = { type: 'manual', targetBranch: 'feature', payload: {} };
    for (const event of [
      eventOf({ event: tag(), branch: 'v1.0.0' }, shipped),
      eventOf({ event: schedule({ cron: '0 0 * * *' }) }, shipped),
      manual,
    ]) {
      // fails-when: a diff-less event gets a list, so ctx.changedFiles reads a diff it has none of
      expect(changed(src, shipped, event), event.type).toEqual({});
    }
  });
});
