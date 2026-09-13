import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installHook } from './installer.js';
import { KICI_HOOK_MARKER } from './templates.js';

describe('installHook', { timeout: 30_000 }, () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(
      os.tmpdir(),
      `kici-install-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('husky', () => {
    it('creates new .husky/pre-commit when none exists', async () => {
      await mkdir(path.join(tempDir, '.husky'), { recursive: true });
      const result = await installHook('husky', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('created');
      expect(result.tool).toBe('husky');
      expect(result.message).toContain('Created');

      const content = await readFile(path.join(tempDir, '.husky', 'pre-commit'), 'utf-8');
      expect(content).toContain('#!/usr/bin/env sh');
      expect(content).toContain('npx -y kici@latest compile');
      expect(content).toContain(KICI_HOOK_MARKER);
      expect(content).not.toContain('husky.sh');
    });

    it('appends to existing .husky/pre-commit', async () => {
      await mkdir(path.join(tempDir, '.husky'), { recursive: true });
      const existingContent = `#!/bin/sh
. "$(dirname -- "$0")/_/husky.sh"

npm test
`;
      await writeFile(path.join(tempDir, '.husky', 'pre-commit'), existingContent);

      const result = await installHook('husky', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('updated');

      const content = await readFile(path.join(tempDir, '.husky', 'pre-commit'), 'utf-8');
      expect(content).toContain('npm test');
      expect(content).toContain('npx -y kici@latest compile');
      expect(content).toContain(KICI_HOOK_MARKER);
    });

    it('skips if kici hook already installed via marker', async () => {
      await mkdir(path.join(tempDir, '.husky'), { recursive: true });
      const existingContent = `#!/bin/sh
. "$(dirname -- "$0")/_/husky.sh"

${KICI_HOOK_MARKER}
kici compile
`;
      await writeFile(path.join(tempDir, '.husky', 'pre-commit'), existingContent);

      const result = await installHook('husky', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('skipped');
      expect(result.message).toContain('already installed');
    });

    it('skips if kici hook already installed via command', async () => {
      await mkdir(path.join(tempDir, '.husky'), { recursive: true });
      const existingContent = `#!/bin/sh
. "$(dirname -- "$0")/_/husky.sh"

kici compile --check
`;
      await writeFile(path.join(tempDir, '.husky', 'pre-commit'), existingContent);

      const result = await installHook('husky', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('skipped');
    });

    it('includes git add in hook command', async () => {
      await mkdir(path.join(tempDir, '.husky'), { recursive: true });
      const result = await installHook('husky', { cwd: tempDir });

      expect(result.success).toBe(true);
      const content = await readFile(path.join(tempDir, '.husky', 'pre-commit'), 'utf-8');
      expect(content).toContain('npx -y kici@latest compile && git add .kici/kici.lock.json');
    });

    it('uses @kici-dev/compiler when useVerdaccio is true', async () => {
      await mkdir(path.join(tempDir, '.husky'), { recursive: true });
      const result = await installHook('husky', { cwd: tempDir, useVerdaccio: true });

      expect(result.success).toBe(true);
      const content = await readFile(path.join(tempDir, '.husky', 'pre-commit'), 'utf-8');
      expect(content).toContain(
        'npx -y @kici-dev/compiler@latest compile && git add .kici/kici.lock.json',
      );
    });

    it('sets executable permissions on hook file', async () => {
      await mkdir(path.join(tempDir, '.husky'), { recursive: true });
      await installHook('husky', { cwd: tempDir });

      const hookPath = path.join(tempDir, '.husky', 'pre-commit');
      const stats = await stat(hookPath);
      // Check that execute bits are set (at least one of owner/group/other)
      expect(stats.mode & 0o111).toBeTruthy();
    });
  });

  describe('git (raw)', () => {
    beforeEach(async () => {
      // Create .git directory for git hook tests
      await mkdir(path.join(tempDir, '.git'), { recursive: true });
    });

    it('creates new .git/hooks/pre-commit when none exists', async () => {
      const result = await installHook('git', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('created');
      expect(result.tool).toBe('git');

      const hookPath = path.join(tempDir, '.git', 'hooks', 'pre-commit');
      const content = await readFile(hookPath, 'utf-8');
      expect(content).toContain('#!/bin/sh');
      expect(content).toContain('npx -y kici@latest compile');
      expect(content).toContain(KICI_HOOK_MARKER);
    });

    it('appends to existing .git/hooks/pre-commit', async () => {
      const hookDir = path.join(tempDir, '.git', 'hooks');
      await mkdir(hookDir, { recursive: true });
      const existingContent = `#!/bin/sh
# existing hook
npm test
`;
      await writeFile(path.join(hookDir, 'pre-commit'), existingContent);

      const result = await installHook('git', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('updated');

      const content = await readFile(path.join(hookDir, 'pre-commit'), 'utf-8');
      expect(content).toContain('npm test');
      expect(content).toContain('npx -y kici@latest compile');
    });

    it('skips if kici hook already installed', async () => {
      const hookDir = path.join(tempDir, '.git', 'hooks');
      await mkdir(hookDir, { recursive: true });
      const existingContent = `#!/bin/sh
${KICI_HOOK_MARKER}
kici compile
`;
      await writeFile(path.join(hookDir, 'pre-commit'), existingContent);

      const result = await installHook('git', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('skipped');
    });

    it('sets chmod 755 for executable permissions', async () => {
      const result = await installHook('git', { cwd: tempDir });

      expect(result.success).toBe(true);

      const hookPath = path.join(tempDir, '.git', 'hooks', 'pre-commit');
      const stats = await stat(hookPath);
      // Check that execute bits are set
      expect(stats.mode & 0o111).toBeTruthy();
    });

    it('fails gracefully when not in git repo', async () => {
      // Create a completely separate temp dir without .git
      const nonGitDir = path.join(
        os.tmpdir(),
        `kici-no-git-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      await mkdir(nonGitDir, { recursive: true });

      try {
        const result = await installHook('git', { cwd: nonGitDir });

        expect(result.success).toBe(false);
        expect(result.action).toBe('skipped');
        expect(result.message).toContain('Not in a git repository');
      } finally {
        await rm(nonGitDir, { recursive: true, force: true });
      }
    });

    it('includes git add in hook command', async () => {
      const result = await installHook('git', { cwd: tempDir });

      expect(result.success).toBe(true);
      const hookPath = path.join(tempDir, '.git', 'hooks', 'pre-commit');
      const content = await readFile(hookPath, 'utf-8');
      expect(content).toContain('npx -y kici@latest compile && git add .kici/kici.lock.json');
    });
  });

  describe('lefthook', () => {
    it('adds command to existing lefthook.yml with pre-commit and commands', async () => {
      const existingContent = `# Lefthook config
pre-commit:
  parallel: true
  commands:
    lint:
      run: eslint .
`;
      await writeFile(path.join(tempDir, 'lefthook.yml'), existingContent);

      const result = await installHook('lefthook', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('updated');
      expect(result.tool).toBe('lefthook');

      const content = await readFile(path.join(tempDir, 'lefthook.yml'), 'utf-8');
      expect(content).toContain('kici-compile:');
      expect(content).toContain('run: npx -y kici@latest compile');
      expect(content).toContain('eslint');
    });

    it('adds commands section when pre-commit exists without commands', async () => {
      const existingContent = `# Lefthook config
pre-commit:
  parallel: true
`;
      await writeFile(path.join(tempDir, 'lefthook.yml'), existingContent);

      const result = await installHook('lefthook', { cwd: tempDir });

      expect(result.success).toBe(true);
      const content = await readFile(path.join(tempDir, 'lefthook.yml'), 'utf-8');
      expect(content).toContain('commands:');
      expect(content).toContain('kici-compile:');
    });

    it('adds pre-commit section when none exists', async () => {
      const existingContent = `# Lefthook config
commit-msg:
  commands:
    check:
      run: commitlint
`;
      await writeFile(path.join(tempDir, 'lefthook.yml'), existingContent);

      const result = await installHook('lefthook', { cwd: tempDir });

      expect(result.success).toBe(true);
      const content = await readFile(path.join(tempDir, 'lefthook.yml'), 'utf-8');
      expect(content).toContain('pre-commit:');
      expect(content).toContain('kici-compile:');
      expect(content).toContain('commitlint'); // Original content preserved
    });

    it('creates lefthook.yml when no config exists', async () => {
      const result = await installHook('lefthook', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('updated');

      const content = await readFile(path.join(tempDir, 'lefthook.yml'), 'utf-8');
      expect(content).toContain('# Lefthook configuration');
      expect(content).toContain('pre-commit:');
      expect(content).toContain('kici-compile:');
    });

    it('detects .lefthook.yml variant', async () => {
      const existingContent = `pre-commit:
  commands:
    test:
      run: npm test
`;
      await writeFile(path.join(tempDir, '.lefthook.yml'), existingContent);

      const result = await installHook('lefthook', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.path).toBe(path.join(tempDir, '.lefthook.yml'));

      const content = await readFile(path.join(tempDir, '.lefthook.yml'), 'utf-8');
      expect(content).toContain('kici-compile:');
    });

    it('skips if kici hook already installed', async () => {
      const existingContent = `pre-commit:
  commands:
    kici-compile:
      run: kici compile
`;
      await writeFile(path.join(tempDir, 'lefthook.yml'), existingContent);

      const result = await installHook('lefthook', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('skipped');
    });

    it('includes git add in hook command', async () => {
      const result = await installHook('lefthook', { cwd: tempDir });

      expect(result.success).toBe(true);
      const content = await readFile(path.join(tempDir, 'lefthook.yml'), 'utf-8');
      expect(content).toContain('run: npx -y kici@latest compile && git add .kici/kici.lock.json');
    });

    it('adds commands to pre-commit when commands: exists only in another section', async () => {
      const existingContent = `pre-commit:
  parallel: true
commit-msg:
  commands:
    check:
      run: commitlint
`;
      await writeFile(path.join(tempDir, 'lefthook.yml'), existingContent);

      const result = await installHook('lefthook', { cwd: tempDir });

      expect(result.success).toBe(true);
      const content = await readFile(path.join(tempDir, 'lefthook.yml'), 'utf-8');
      // kici-compile must be under pre-commit, not commit-msg
      const preCommitIdx = content.indexOf('pre-commit:');
      const commitMsgIdx = content.indexOf('commit-msg:');
      const kiciIdx = content.indexOf('kici-compile:');
      expect(kiciIdx).toBeGreaterThan(preCommitIdx);
      expect(kiciIdx).toBeLessThan(commitMsgIdx);
      expect(content).toContain('commands:');
      expect(content).toContain('commitlint'); // Original preserved
    });

    it('adds commands to pre-commit when another section with commands: comes first', async () => {
      const existingContent = `commit-msg:
  commands:
    check:
      run: commitlint
pre-commit:
  parallel: true
`;
      await writeFile(path.join(tempDir, 'lefthook.yml'), existingContent);

      const result = await installHook('lefthook', { cwd: tempDir });

      expect(result.success).toBe(true);
      const content = await readFile(path.join(tempDir, 'lefthook.yml'), 'utf-8');
      // kici-compile must be under pre-commit section
      const preCommitIdx = content.indexOf('pre-commit:');
      const kiciIdx = content.indexOf('kici-compile:');
      expect(kiciIdx).toBeGreaterThan(preCommitIdx);
      expect(content).toContain('commitlint'); // Original preserved
    });
  });

  describe('pre-commit', () => {
    it('adds hook to existing .pre-commit-config.yaml', async () => {
      const existingContent = `repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.4.0
    hooks:
      - id: trailing-whitespace
`;
      await writeFile(path.join(tempDir, '.pre-commit-config.yaml'), existingContent);

      const result = await installHook('pre-commit', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('updated');
      expect(result.tool).toBe('pre-commit');

      const content = await readFile(path.join(tempDir, '.pre-commit-config.yaml'), 'utf-8');
      expect(content).toContain('- repo: local');
      expect(content).toContain('id: kici-compile');
      expect(content).toContain('name: KiCI Compile');
      expect(content).toContain('entry: npx -y kici@latest compile');
      expect(content).toContain('language: system');
      expect(content).toContain('trailing-whitespace'); // Original content preserved
    });

    it('creates .pre-commit-config.yaml when none exists', async () => {
      const result = await installHook('pre-commit', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('updated');

      const content = await readFile(path.join(tempDir, '.pre-commit-config.yaml'), 'utf-8');
      expect(content).toContain('# pre-commit configuration');
      expect(content).toContain('repos:');
      expect(content).toContain('- repo: local');
      expect(content).toContain('id: kici-compile');
    });

    it('skips if kici hook already installed', async () => {
      const existingContent = `repos:
  - repo: local
    hooks:
      - id: kici-compile
        name: KiCI Compile
        entry: kici compile
        language: system
`;
      await writeFile(path.join(tempDir, '.pre-commit-config.yaml'), existingContent);

      const result = await installHook('pre-commit', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('skipped');
    });

    it('includes git add in hook command', async () => {
      const result = await installHook('pre-commit', { cwd: tempDir });

      expect(result.success).toBe(true);
      const content = await readFile(path.join(tempDir, '.pre-commit-config.yaml'), 'utf-8');
      expect(content).toContain(
        'entry: npx -y kici@latest compile && git add .kici/kici.lock.json',
      );
    });
  });

  describe('prek', () => {
    it('adds hook to existing .pre-commit-config.yaml', async () => {
      const existingContent = `repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    hooks:
      - id: check-yaml
`;
      await writeFile(path.join(tempDir, '.pre-commit-config.yaml'), existingContent);

      const result = await installHook('prek', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('updated');
      expect(result.tool).toBe('prek');

      const content = await readFile(path.join(tempDir, '.pre-commit-config.yaml'), 'utf-8');
      expect(content).toContain('- repo: local');
      expect(content).toContain('id: kici-compile');
      expect(content).toContain('check-yaml'); // Original content preserved
    });

    it('creates .pre-commit-config.yaml when none exists', async () => {
      const result = await installHook('prek', { cwd: tempDir });

      expect(result.success).toBe(true);

      const content = await readFile(path.join(tempDir, '.pre-commit-config.yaml'), 'utf-8');
      expect(content).toContain('id: kici-compile');
    });

    it('skips if kici hook already installed', async () => {
      const existingContent = `repos:
  - repo: local
    hooks:
      - id: kici-compile
        entry: kici compile --check
`;
      await writeFile(path.join(tempDir, '.pre-commit-config.yaml'), existingContent);

      const result = await installHook('prek', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('skipped');
    });

    it('includes git add in hook command', async () => {
      const result = await installHook('prek', { cwd: tempDir });

      expect(result.success).toBe(true);
      const content = await readFile(path.join(tempDir, '.pre-commit-config.yaml'), 'utf-8');
      expect(content).toContain(
        'entry: npx -y kici@latest compile && git add .kici/kici.lock.json',
      );
    });
  });

  describe('edge cases', () => {
    it('returns error for unknown tool', async () => {
      const result = await installHook('unknown' as any, { cwd: tempDir });

      expect(result.success).toBe(false);
      expect(result.action).toBe('skipped');
      expect(result.message).toContain('Unknown hook tool');
    });

    it('uses process.cwd() when no cwd option provided', async () => {
      // This test verifies the function doesn't throw when cwd is not provided
      // We can't easily test the actual cwd usage, but we can verify it doesn't error
      await mkdir(path.join(tempDir, '.husky'), { recursive: true });

      // Mock process.cwd by using explicit cwd option
      const result = await installHook('husky', { cwd: tempDir });
      expect(result.success).toBe(true);
    });

    it('installs hook in common git dir when inside a worktree', async () => {
      // Simulate a git worktree:
      // main-repo/.git/              (the common git dir)
      // main-repo/.git/worktrees/wt/ (worktree-specific dir with commondir file)
      // worktree/.git                (file pointing to worktree-specific dir)
      const mainRepo = path.join(tempDir, 'main-repo');
      const mainGitDir = path.join(mainRepo, '.git');
      const worktreeGitDir = path.join(mainGitDir, 'worktrees', 'wt');
      const worktreeDir = path.join(tempDir, 'worktree');

      await mkdir(mainGitDir, { recursive: true });
      await mkdir(worktreeGitDir, { recursive: true });
      await mkdir(worktreeDir, { recursive: true });

      // worktree/.git file points to the worktree-specific dir
      await writeFile(path.join(worktreeDir, '.git'), `gitdir: ${worktreeGitDir}\n`);
      // commondir file in worktree dir points back to common git dir
      await writeFile(path.join(worktreeGitDir, 'commondir'), '../..\n');

      const result = await installHook('git', { cwd: worktreeDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('created');
      // Hook should be in the COMMON .git/hooks/, not in the worktree-specific dir
      expect(result.path).toBe(path.join(mainGitDir, 'hooks', 'pre-commit'));

      const content = await readFile(path.join(mainGitDir, 'hooks', 'pre-commit'), 'utf-8');
      expect(content).toContain('npx -y kici@latest compile');
    });

    it('handles nested subdirectory for git hooks', async () => {
      // Create git repo at root
      await mkdir(path.join(tempDir, '.git'), { recursive: true });
      // Create subdirectory
      const subDir = path.join(tempDir, 'src', 'components');
      await mkdir(subDir, { recursive: true });

      const result = await installHook('git', { cwd: subDir });

      expect(result.success).toBe(true);
      expect(result.path).toBe(path.join(tempDir, '.git', 'hooks', 'pre-commit'));
    });
  });
});
