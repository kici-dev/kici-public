import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { detectCurrentBranch, detectRepoFromGit } from './git-detector.js';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

describe('detectRepoFromGit', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `kici-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    await mkdir(path.join(tempDir, '.git'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns null in non-git directory', async () => {
    const nonGitDir = path.join(tmpdir(), `kici-test-nongit-${Date.now()}`);
    await mkdir(nonGitDir, { recursive: true });
    try {
      const result = await detectRepoFromGit(nonGitDir);
      expect(result).toBeNull();
    } finally {
      await rm(nonGitDir, { recursive: true, force: true });
    }
  });

  it('parses SSH URL correctly', async () => {
    const config = `
[core]
  repositoryformatversion = 0
[remote "origin"]
  url = git@github.com:test-owner/test-repo.git
  fetch = +refs/heads/*:refs/remotes/origin/*
`;
    await writeFile(path.join(tempDir, '.git', 'config'), config, 'utf-8');

    const result = await detectRepoFromGit(tempDir);
    expect(result).toEqual({ owner: 'test-owner', name: 'test-repo' });
  });

  it('parses HTTPS URL correctly', async () => {
    const config = `
[core]
  repositoryformatversion = 0
[remote "origin"]
  url = https://github.com/test-owner/test-repo.git
  fetch = +refs/heads/*:refs/remotes/origin/*
`;
    await writeFile(path.join(tempDir, '.git', 'config'), config, 'utf-8');

    const result = await detectRepoFromGit(tempDir);
    expect(result).toEqual({ owner: 'test-owner', name: 'test-repo' });
  });

  it('parses URL without .git extension', async () => {
    const config = `
[remote "origin"]
  url = git@github.com:test-owner/test-repo
`;
    await writeFile(path.join(tempDir, '.git', 'config'), config, 'utf-8');

    const result = await detectRepoFromGit(tempDir);
    expect(result).toEqual({ owner: 'test-owner', name: 'test-repo' });
  });

  it('returns null if no origin remote', async () => {
    const config = `
[core]
  repositoryformatversion = 0
`;
    await writeFile(path.join(tempDir, '.git', 'config'), config, 'utf-8');

    const result = await detectRepoFromGit(tempDir);
    expect(result).toBeNull();
  });

  it('returns null if URL is not GitHub', async () => {
    const config = `
[remote "origin"]
  url = git@gitlab.com:test-owner/test-repo.git
`;
    await writeFile(path.join(tempDir, '.git', 'config'), config, 'utf-8');

    const result = await detectRepoFromGit(tempDir);
    expect(result).toBeNull();
  });
});

describe('detectCurrentBranch', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();

  beforeAll(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'kici-fixture-head-'));
    git('init', '--quiet', '--initial-branch=ci/kici');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'init');
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('reads a slash-named branch', () => {
    // fails-when: the branch is read with --short and a same-named tag yields heads/<name>
    git('tag', 'ci/kici');
    expect(detectCurrentBranch(repo)).toBe('ci/kici');
  });

  it('returns undefined on a detached HEAD and outside a repository', async () => {
    git('checkout', '--quiet', '--detach');
    expect(detectCurrentBranch(repo)).toBeUndefined();
    git('checkout', '--quiet', 'ci/kici');
    const empty = await mkdtemp(path.join(tmpdir(), 'kici-fixture-nogit-'));
    try {
      expect(detectCurrentBranch(empty)).toBeUndefined();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
