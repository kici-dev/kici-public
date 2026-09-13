import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { detectHookTools, findGitDir, findGitRoot } from './detector.js';

describe('detectHookTools', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(
      os.tmpdir(),
      `kici-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns empty array when no hook tools detected', async () => {
    const result = await detectHookTools(tempDir);
    expect(result).toEqual([]);
  });

  it('detects husky via .husky/ directory', async () => {
    await mkdir(path.join(tempDir, '.husky'), { recursive: true });

    const result = await detectHookTools(tempDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('husky');
    expect(result[0].priority).toBe(1);
  });

  it('detects lefthook via lefthook.yml', async () => {
    await writeFile(path.join(tempDir, 'lefthook.yml'), 'pre-commit:\n  commands: {}');

    const result = await detectHookTools(tempDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('lefthook');
    expect(result[0].priority).toBe(2);
  });

  it('detects lefthook via .lefthook.yml', async () => {
    await writeFile(path.join(tempDir, '.lefthook.yml'), 'pre-commit:\n  commands: {}');

    const result = await detectHookTools(tempDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('lefthook');
  });

  it('detects pre-commit via .pre-commit-config.yaml', async () => {
    await writeFile(path.join(tempDir, '.pre-commit-config.yaml'), 'repos: []');

    const result = await detectHookTools(tempDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('pre-commit');
    expect(result[0].priority).toBe(3);
  });

  it('detects prek via prek.toml', async () => {
    await writeFile(path.join(tempDir, 'prek.toml'), '[hooks]');

    const result = await detectHookTools(tempDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('prek');
    expect(result[0].priority).toBe(4);
  });

  it('detects prek via .prek.toml', async () => {
    await writeFile(path.join(tempDir, '.prek.toml'), '[hooks]');

    const result = await detectHookTools(tempDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('prek');
  });

  it('returns multiple tools sorted by priority', async () => {
    // Create config files for multiple tools
    await mkdir(path.join(tempDir, '.husky'), { recursive: true });
    await writeFile(path.join(tempDir, '.pre-commit-config.yaml'), 'repos: []');
    await writeFile(path.join(tempDir, 'prek.toml'), '[hooks]');

    const result = await detectHookTools(tempDir);
    expect(result).toHaveLength(3);
    // Should be sorted by priority: husky (1) < pre-commit (3) < prek (4)
    expect(result[0].name).toBe('husky');
    expect(result[1].name).toBe('pre-commit');
    expect(result[2].name).toBe('prek');
  });

  it('includes configPath in results', async () => {
    await mkdir(path.join(tempDir, '.husky'), { recursive: true });

    const result = await detectHookTools(tempDir);
    expect(result[0].configPath).toBe(path.join(tempDir, '.husky/'));
  });
});

describe('findGitDir', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(
      os.tmpdir(),
      `kici-git-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns null when not in a git repo', async () => {
    const result = await findGitDir(tempDir);
    expect(result).toBeNull();
  });

  it('finds .git directory in current folder', async () => {
    await mkdir(path.join(tempDir, '.git'), { recursive: true });

    const result = await findGitDir(tempDir);
    expect(result).toBe(path.join(tempDir, '.git'));
  });

  it('finds .git directory in parent folder', async () => {
    await mkdir(path.join(tempDir, '.git'), { recursive: true });
    const subDir = path.join(tempDir, 'src', 'components');
    await mkdir(subDir, { recursive: true });

    const result = await findGitDir(subDir);
    expect(result).toBe(path.join(tempDir, '.git'));
  });

  it('resolves .git file with absolute gitdir path (worktree)', async () => {
    // Simulate a worktree: .git is a file pointing to the actual git dir
    const actualGitDir = path.join(tempDir, 'actual-repo', '.git', 'worktrees', 'my-worktree');
    await mkdir(actualGitDir, { recursive: true });

    const worktreeDir = path.join(tempDir, 'my-worktree');
    await mkdir(worktreeDir, { recursive: true });
    await writeFile(path.join(worktreeDir, '.git'), `gitdir: ${actualGitDir}\n`);

    const result = await findGitDir(worktreeDir);
    expect(result).toBe(actualGitDir);
  });

  it('resolves .git file with relative gitdir path (submodule)', async () => {
    // Simulate a submodule: .git file with relative path
    const parentGitModules = path.join(tempDir, '.git', 'modules', 'my-sub');
    await mkdir(parentGitModules, { recursive: true });

    const submoduleDir = path.join(tempDir, 'my-sub');
    await mkdir(submoduleDir, { recursive: true });
    await writeFile(path.join(submoduleDir, '.git'), 'gitdir: ../.git/modules/my-sub\n');

    const result = await findGitDir(submoduleDir);
    expect(result).toBe(parentGitModules);
  });

  it('resolves .git file from subdirectory of worktree', async () => {
    const actualGitDir = path.join(tempDir, 'actual-repo', '.git', 'worktrees', 'wt');
    await mkdir(actualGitDir, { recursive: true });

    const worktreeDir = path.join(tempDir, 'wt');
    await mkdir(worktreeDir, { recursive: true });
    await writeFile(path.join(worktreeDir, '.git'), `gitdir: ${actualGitDir}\n`);

    const subDir = path.join(worktreeDir, 'src', 'lib');
    await mkdir(subDir, { recursive: true });

    const result = await findGitDir(subDir);
    expect(result).toBe(actualGitDir);
  });

  it('returns null for .git file with invalid content', async () => {
    await writeFile(path.join(tempDir, '.git'), 'not a valid gitdir reference\n');

    const result = await findGitDir(tempDir);
    // Should skip this .git file and continue walking up (eventually returns null)
    expect(result).toBeNull();
  });
});

describe('findGitRoot', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(
      os.tmpdir(),
      `kici-root-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns cwd when not in a git repo', async () => {
    const result = await findGitRoot(tempDir);
    expect(result).toBe(tempDir);
  });

  it('returns git root directory', async () => {
    await mkdir(path.join(tempDir, '.git'), { recursive: true });
    const subDir = path.join(tempDir, 'src', 'components');
    await mkdir(subDir, { recursive: true });

    const result = await findGitRoot(subDir);
    expect(result).toBe(tempDir);
  });

  it('returns worktree root when .git is a file', async () => {
    // The worktree root is where the .git file lives, not where it points to
    const actualGitDir = path.join(tempDir, 'repo', '.git', 'worktrees', 'wt');
    await mkdir(actualGitDir, { recursive: true });

    const worktreeDir = path.join(tempDir, 'wt');
    await mkdir(worktreeDir, { recursive: true });
    await writeFile(path.join(worktreeDir, '.git'), `gitdir: ${actualGitDir}\n`);

    const subDir = path.join(worktreeDir, 'src');
    await mkdir(subDir, { recursive: true });

    const result = await findGitRoot(subDir);
    expect(result).toBe(worktreeDir);
  });
});
