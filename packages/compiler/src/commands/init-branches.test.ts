import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DefaultBranchSource,
  detectCheckedOutBranch,
  detectDefaultBranch,
  parseRemoteHeadSymref,
} from './init-branches.js';

const COMMIT_FLAGS = [
  '-c',
  'user.email=init@test.kici.dev',
  '-c',
  'user.name=init test',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
}

function commitEmpty(cwd: string): void {
  git(cwd, ...COMMIT_FLAGS, 'commit', '-q', '--allow-empty', '-m', 'init');
}

let root: string;
let savedCeiling: string | undefined;

/** A fresh directory under the temp root. */
async function dir(name: string): Promise<string> {
  const d = path.join(root, name);
  await fs.mkdir(d, { recursive: true });
  return d;
}

/** A bare origin on `defaultBranch` and a clone of it checked out on `kici-workflows`. */
async function makeOriginAndClone(name: string, defaultBranch: string): Promise<string> {
  const base = await dir(name);
  const seed = path.join(base, 'seed');
  await fs.mkdir(seed);
  git(seed, 'init', '-q', '-b', defaultBranch);
  commitEmpty(seed);
  git(base, 'clone', '-q', '--bare', seed, 'origin.git');
  git(base, 'clone', '-q', 'origin.git', 'work');
  const work = path.join(base, 'work');
  git(work, 'checkout', '-q', '-b', 'kici-workflows');
  return work;
}

/** A repository with one commit on `branch` and no remote. */
async function makeRepo(name: string, branch: string): Promise<string> {
  const repo = await dir(name);
  git(repo, 'init', '-q', '-b', branch);
  commitEmpty(repo);
  return repo;
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kici-init-branches-'));
  // git never walks above the temp root into an enclosing repository.
  savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(root);
});

afterAll(async () => {
  if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
  await fs.rm(root, { recursive: true, force: true });
});

describe('detectDefaultBranch', () => {
  it('reads origin/HEAD, not the checked-out branch', async () => {
    const work = await makeOriginAndClone('origin-head', 'trunk');
    // fails-when: detection falls back to the checked-out branch (the #496 bug)
    expect(await detectDefaultBranch(work)).toEqual({
      branch: 'trunk',
      source: DefaultBranchSource.OriginHead,
    });
  });

  it('prefers the local origin/HEAD over the remote HEAD', async () => {
    const work = await makeOriginAndClone('precedence', 'trunk');
    git(work, 'push', '-q', 'origin', 'HEAD:release');
    git(work, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release');
    // fails-when: ls-remote runs first, or origin/HEAD is ignored
    expect(await detectDefaultBranch(work)).toEqual({
      branch: 'release',
      source: DefaultBranchSource.OriginHead,
    });
  });

  it('asks the origin remote when origin/HEAD was never set', async () => {
    const work = await makeOriginAndClone('remote-head', 'trunk');
    git(work, 'remote', 'set-head', 'origin', '--delete');
    // fails-when: the ls-remote step is missing, so this falls through to main
    expect(await detectDefaultBranch(work)).toEqual({
      branch: 'trunk',
      source: DefaultBranchSource.RemoteHead,
    });
  });

  it('uses main with no origin remote, even on a feature branch', async () => {
    const repo = await makeRepo('no-remote', 'kici-workflows');
    // fails-when: the fallback chain reads the checked-out branch
    expect(await detectDefaultBranch(repo)).toEqual({
      branch: 'main',
      source: DefaultBranchSource.Fallback,
    });
  });

  it('uses main when origin is unreachable, and does not throw', async () => {
    const repo = await makeRepo('unreachable', 'kici-workflows');
    git(repo, 'remote', 'add', 'origin', path.join(root, 'nonexistent', 'kici-origin.git'));
    // fails-when: a failing ls-remote rejects instead of falling back
    expect(await detectDefaultBranch(repo)).toEqual({
      branch: 'main',
      source: DefaultBranchSource.Fallback,
    });
  });

  it('gives up on a hanging origin within the timeout', async () => {
    const repo = await makeRepo('hanging', 'kici-workflows');
    git(repo, 'config', 'protocol.ext.allow', 'always');
    // ext:: splits on spaces: `ext::sh -c "sleep 30"` would fail at once and pass vacuously.
    git(repo, 'remote', 'add', 'origin', 'ext::sleep 30');
    const started = Date.now();
    // fails-when: ls-remote has no timeout (the test itself times out at 15 s)
    expect(await detectDefaultBranch(repo, { lsRemoteTimeoutMs: 500 })).toEqual({
      branch: 'main',
      source: DefaultBranchSource.Fallback,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it('gives up on a hanging origin on a host with no ps', async () => {
    const repo = await makeRepo('hanging-no-ps', 'kici-workflows');
    git(repo, 'config', 'protocol.ext.allow', 'always');
    git(repo, 'remote', 'add', 'origin', 'ext::sleep 30');
    // A PATH holding only the tools the call needs, so `ps` cannot be found.
    const bin = await dir('bin-no-ps');
    for (const tool of ['git', 'sh', 'sleep']) {
      await fs.symlink(
        execFileSync('which', [tool], { encoding: 'utf-8' }).trim(),
        path.join(bin, tool),
      );
    }
    const savedPath = process.env.PATH;
    process.env.PATH = bin;
    const started = Date.now();
    try {
      // fails-when: the timeout kills the process tree by listing it with `ps`
      // (an uncaught TypeError fails the run)
      expect(await detectDefaultBranch(repo, { lsRemoteTimeoutMs: 500 })).toEqual({
        branch: 'main',
        source: DefaultBranchSource.Fallback,
      });
    } finally {
      process.env.PATH = savedPath;
    }
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it('uses main outside a git repository', async () => {
    const plain = await dir('plain');
    // fails-when: git walks into an enclosing repository, or a failing git rejects
    expect(await detectDefaultBranch(plain)).toEqual({
      branch: 'main',
      source: DefaultBranchSource.Fallback,
    });
    expect(await detectCheckedOutBranch(plain)).toBeUndefined();
  });
});

describe('detectCheckedOutBranch', () => {
  it('reads the checked-out branch, including an unborn one', async () => {
    const work = await makeOriginAndClone('checked-out', 'trunk');
    expect(await detectCheckedOutBranch(work)).toBe('kici-workflows');

    const unborn = await dir('unborn');
    git(unborn, 'init', '-q', '-b', 'master');
    // fails-when: rev-parse --abbrev-ref HEAD is used (it fails with no commits)
    expect(await detectCheckedOutBranch(unborn)).toBe('master');

    git(work, 'checkout', '-q', '--detach');
    // fails-when: a detached HEAD reads back as the literal `HEAD`
    expect(await detectCheckedOutBranch(work)).toBeUndefined();
  });
});

describe('parseRemoteHeadSymref', () => {
  it.each([
    ['ref: refs/heads/main\tHEAD\n0123abc\tHEAD\n', 'main'],
    ['ref: refs/heads/ci/kici\tHEAD\n', 'ci/kici'],
    ['0123abc\tHEAD\n', undefined],
    ['ref: refs/tags/v1\tHEAD\n', undefined],
    ['', undefined],
  ])('%j -> %j', (input, expected) => {
    // fails-when: a non-branch ref or a plain sha line is read as a branch name
    expect(parseRemoteHeadSymref(input)).toBe(expected);
  });
});
