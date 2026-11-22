import { execFileSync } from 'node:child_process';
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { snapshotRepo } from './git-repo-snapshot.js';
import { makeTempDir } from './tmp.js';

function git(dir: string, args: string[], input?: string): string {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    input,
    env: {
      ...env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/** A repository with two commits and `a.txt`, `b.txt` tracked. */
function makeRepo(): string {
  const dir = makeTempDir('git-repo-snapshot-');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Dev']);
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'one']);
  writeFileSync(path.join(dir, 'a.txt'), 'a2\n');
  git(dir, ['commit', '-qam', 'two']);
  return dir;
}

/** Move `file`'s mtime without changing its content, so a refreshing `git status` rewrites the index. */
function touchPast(dir: string, file: string): void {
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(path.join(dir, file), past, past);
}

const indexBytes = (dir: string): string =>
  readFileSync(path.join(dir, '.git', 'index')).toString('hex');

// Each case spawns about 20 git processes. Under the public CI's parallel
// `pnpm -r run test`, every package's vitest pool starts at once, and the first
// cases in this file can run past vitest's 5 s default.
describe('snapshotRepo', { timeout: 30_000 }, () => {
  it.each<[string, (dir: string) => void]>([
    ['an object', (dir) => git(dir, ['hash-object', '-w', '--stdin'], 'new object\n')],
    ['a ref', (dir) => git(dir, ['update-ref', 'refs/tags/x', 'HEAD'])],
    [
      'the index',
      (dir) => {
        touchPast(dir, 'b.txt');
        // A plain status refreshes the stat data and rewrites the index, and nothing else.
        git(dir, ['status', '--porcelain']);
      },
    ],
    ['a reflog', (dir) => git(dir, ['update-ref', '-m', 'extra', 'HEAD', 'HEAD'])],
    // A same-size rewrite: neither a size nor a ref changes.
    ['the config', (dir) => git(dir, ['config', 'user.name', 'Deb'])],
  ])('changes when %s changes', async (_what, mutate) => {
    const dir = makeRepo();
    const before = await snapshotRepo(dir);
    mutate(dir);
    // fails-when: the snapshot leaves out the part of the repository the mutation wrote
    expect(await snapshotRepo(dir)).not.toBe(before);
  });

  it('does not write the repository it snapshots', async () => {
    const dir = makeRepo();
    writeFileSync(path.join(dir, 'a.txt'), 'dirty\n');
    touchPast(dir, 'b.txt');
    const index = indexBytes(dir);

    // fails-when: the snapshot itself rewrites the index (a refreshing `git status`)
    expect(await snapshotRepo(dir)).toBe(await snapshotRepo(dir));
    expect(indexBytes(dir)).toBe(index);

    // Positive control: in this tree, a refreshing status does rewrite the index.
    git(dir, ['status', '--porcelain']);
    expect(indexBytes(dir)).not.toBe(index);
  });

  it.each<[string, (wt: string) => void]>([
    ['its own reflog', (wt) => git(wt, ['update-ref', '-m', 'extra', 'HEAD', 'HEAD'])],
    ['the shared config', (wt) => git(wt, ['config', 'user.name', 'Deb'])],
  ])('reads a linked worktree through its .git file: %s', async (_what, mutate) => {
    const dir = makeRepo();
    const wt = path.join(makeTempDir('git-repo-snapshot-wt-'), 'wt');
    git(dir, ['worktree', 'add', '-q', '-b', 'side', wt]);
    const before = await snapshotRepo(wt);
    mutate(wt);
    // fails-when: the snapshot reads only the worktree's private git dir, not the common dir
    expect(await snapshotRepo(wt)).not.toBe(before);
  });
});
