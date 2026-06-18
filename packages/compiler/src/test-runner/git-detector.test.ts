import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { detectRepoFromGit } from './git-detector.js';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

describe('detectRepoFromGit', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create temporary directory for test
    tempDir = path.join(tmpdir(), `kici-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    await mkdir(path.join(tempDir, '.git'), { recursive: true });
  });

  afterEach(async () => {
    // Clean up temporary directory
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
