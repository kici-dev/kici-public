import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkdir, LOCAL_RUN_BRANCH } from './source-provider.js';

/** Create a throwaway git repo with one committed file. */
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-src-repo-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@kici.dev']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(dir, 'committed.txt'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  return dir;
}

describe('LocalSourceProvider resolveWorkdir', () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('--in-place returns the repo root with a no-op cleanup', async () => {
    const wd = await resolveWorkdir({ inPlace: true, repoRoot: repo });
    expect(wd.dir).toBe(repo);
    expect(wd.ref).toMatch(/^refs\/heads\//);
    expect(wd.sha).toMatch(/^[0-9a-f]{40}$/);
    await wd.cleanup();
    // The working tree survives cleanup.
    expect(fs.existsSync(path.join(repo, 'committed.txt'))).toBe(true);
  });

  it('isolated materializes a clone carrying the committed base tree', async () => {
    const wd = await resolveWorkdir({ inPlace: false, repoRoot: repo });
    expect(wd.dir).not.toBe(repo);
    expect(wd.branch).toBe(LOCAL_RUN_BRANCH);
    expect(wd.ref).toBe(`refs/heads/${LOCAL_RUN_BRANCH}`);
    expect(fs.readFileSync(path.join(wd.dir, 'committed.txt'), 'utf-8')).toBe('base\n');
    await wd.cleanup();
    expect(fs.existsSync(wd.dir)).toBe(false);
  });

  it('isolated commits the dirty + untracked overlay into the clone sha', async () => {
    // Dirty a tracked file and add an untracked one — neither committed.
    fs.writeFileSync(path.join(repo, 'committed.txt'), 'dirty\n');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');

    const wd = await resolveWorkdir({ inPlace: false, repoRoot: repo });

    // The clone working tree carries the overlay …
    expect(fs.readFileSync(path.join(wd.dir, 'committed.txt'), 'utf-8')).toBe('dirty\n');
    expect(fs.readFileSync(path.join(wd.dir, 'untracked.txt'), 'utf-8')).toBe('new\n');
    // … and it is committed (clean tree, HEAD carries it — clone-by-sha sees it).
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: wd.dir,
      encoding: 'utf8',
    }).trim();
    expect(status).toBe('');
    const show = execFileSync('git', ['show', `${wd.sha}:untracked.txt`], {
      cwd: wd.dir,
      encoding: 'utf8',
    });
    expect(show).toBe('new\n');

    // The developer's working tree is never mutated.
    expect(fs.existsSync(path.join(repo, 'untracked.txt'))).toBe(true); // still there, but as their own file
    await wd.cleanup();
  });

  it('throws when the path is not a git work tree', async () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'kici-nonrepo-'));
    await expect(resolveWorkdir({ inPlace: true, repoRoot: nonRepo })).rejects.toThrow(
      /not inside a git work tree/,
    );
    fs.rmSync(nonRepo, { recursive: true, force: true });
  });
});
