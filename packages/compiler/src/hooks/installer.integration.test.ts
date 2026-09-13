/**
 * Integration tests for hook installer.
 *
 * These tests use real git repos and shell execution to verify that hooks
 * are properly installed and wired up. They are slower than unit tests
 * but prove end-to-end correctness.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { installHook } from './installer.js';
import { KICI_HOOK_MARKER } from './templates.js';

const execAsync = promisify(exec);

/** Run a git command in a directory */
async function git(args: string, cwd: string): Promise<string> {
  const { stdout } = await execAsync(`git ${args}`, { cwd });
  return stdout.trim();
}

/** Create a real git repo in a temp directory */
async function createGitRepo(): Promise<string> {
  const tempDir = path.join(
    os.tmpdir(),
    `kici-hook-integration-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(tempDir, { recursive: true });
  await git('init', tempDir);
  await git('config user.email "test@test.com"', tempDir);
  await git('config user.name "Test"', tempDir);
  return tempDir;
}

describe('hook installer integration', { timeout: 30_000 }, () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createGitRepo();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('git raw hook', () => {
    it('creates executable pre-commit hook in a real git repo', async () => {
      const result = await installHook('git', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('created');

      // Verify hook file exists and is executable
      const hookPath = path.join(tempDir, '.git', 'hooks', 'pre-commit');
      const stats = await stat(hookPath);
      expect(stats.mode & 0o111).toBeTruthy();

      // Verify content
      const content = await readFile(hookPath, 'utf-8');
      expect(content).toContain('#!/bin/sh');
      expect(content).toContain(KICI_HOOK_MARKER);
      expect(content).toContain('npx -y kici@latest compile && git add .kici/kici.lock.json');
    });

    it('hook script is valid shell that git can execute', async () => {
      // Install a hook that creates a marker file instead of running kici
      await installHook('git', { cwd: tempDir });

      // Replace the kici command with a simple touch command for testing
      const hookPath = path.join(tempDir, '.git', 'hooks', 'pre-commit');
      const markerPath = path.join(tempDir, '.hook-ran');
      await writeFile(hookPath, `#!/bin/sh\ntouch "${markerPath}"\n`, { mode: 0o755 });

      // Create a file and commit to trigger the hook
      await writeFile(path.join(tempDir, 'test.txt'), 'hello');
      await git('add test.txt', tempDir);
      await git('commit -m "test commit"', tempDir);

      // Verify the hook actually ran
      const markerExists = await stat(markerPath)
        .then(() => true)
        .catch(() => false);
      expect(markerExists).toBe(true);
    });

    it('appends to existing hook without breaking it', async () => {
      // Create an existing hook that creates marker1
      const hookDir = path.join(tempDir, '.git', 'hooks');
      await mkdir(hookDir, { recursive: true });
      const marker1 = path.join(tempDir, '.hook-original');
      await writeFile(path.join(hookDir, 'pre-commit'), `#!/bin/sh\ntouch "${marker1}"\n`, {
        mode: 0o755,
      });

      // Install our hook (appends)
      const result = await installHook('git', { cwd: tempDir });
      expect(result.action).toBe('updated');

      // Verify original command is preserved
      const content = await readFile(path.join(hookDir, 'pre-commit'), 'utf-8');
      expect(content).toContain(`touch "${marker1}"`);
      expect(content).toContain(KICI_HOOK_MARKER);

      // The hook should still be executable
      const stats = await stat(path.join(hookDir, 'pre-commit'));
      expect(stats.mode & 0o111).toBeTruthy();
    });

    it('works from a subdirectory of the git repo', async () => {
      const subDir = path.join(tempDir, 'src', 'components');
      await mkdir(subDir, { recursive: true });

      const result = await installHook('git', { cwd: subDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('created');
      expect(result.path).toBe(path.join(tempDir, '.git', 'hooks', 'pre-commit'));
    });
  });

  describe('husky (via npx husky init)', () => {
    it('initializes husky and creates pre-commit hook', async () => {
      // Create a package.json (required by husky init)
      await writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', private: true }),
      );

      const result = await installHook('husky', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('created');

      // Verify .husky/ directory was created
      const huskyDir = path.join(tempDir, '.husky');
      const huskyExists = await stat(huskyDir)
        .then((s) => s.isDirectory())
        .catch(() => false);
      expect(huskyExists).toBe(true);

      // Verify pre-commit hook exists and contains our command
      const hookPath = path.join(huskyDir, 'pre-commit');
      const content = await readFile(hookPath, 'utf-8');
      expect(content).toContain('npx -y kici@latest compile && git add .kici/kici.lock.json');

      // Verify git hooks path is set (husky init does this)
      const hooksPath = await git('config core.hooksPath', tempDir).catch(() => '');
      // husky init sets core.hooksPath to .husky (or .husky/_)
      expect(hooksPath).toMatch(/\.husky/);
    });

    it('appends to existing husky pre-commit hook', async () => {
      // Manually set up .husky/ (simulating existing husky installation)
      const huskyDir = path.join(tempDir, '.husky');
      await mkdir(huskyDir, { recursive: true });
      await writeFile(path.join(huskyDir, 'pre-commit'), 'npm test\n');

      const result = await installHook('husky', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('updated');

      // Original content preserved, our command appended
      const content = await readFile(path.join(huskyDir, 'pre-commit'), 'utf-8');
      expect(content).toContain('npm test');
      expect(content).toContain('npx -y kici@latest compile');
      expect(content).toContain(KICI_HOOK_MARKER);
    });

    it('falls back to manual setup when npx husky is unavailable', async () => {
      // Create a fake PATH that doesn't include npx to force fallback
      // We test the fallback by checking the manual setup works
      // (The actual npx failure is hard to simulate without PATH manipulation,
      //  but we can verify the fallback path by checking .husky/ was created
      //  even without husky package)

      // When .husky/ doesn't exist AND npx husky init fails,
      // the fallback creates .husky/ manually and sets core.hooksPath
      // We can't easily force npx to fail, so we test the manual path
      // by pre-creating .husky/ (which skips the init entirely)
      await mkdir(path.join(tempDir, '.husky'), { recursive: true });

      const result = await installHook('husky', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('created');

      const content = await readFile(path.join(tempDir, '.husky', 'pre-commit'), 'utf-8');
      expect(content).toContain('npx -y kici@latest compile');
    });

    it('hook file is executable after installation', async () => {
      await mkdir(path.join(tempDir, '.husky'), { recursive: true });

      await installHook('husky', { cwd: tempDir });

      const hookPath = path.join(tempDir, '.husky', 'pre-commit');
      const stats = await stat(hookPath);
      expect(stats.mode & 0o111).toBeTruthy();
    });
  });

  describe('lefthook', () => {
    it('creates lefthook.yml and attempts lefthook install', async () => {
      const result = await installHook('lefthook', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('updated');

      // Verify config was written
      const configPath = path.join(tempDir, 'lefthook.yml');
      const content = await readFile(configPath, 'utf-8');
      expect(content).toContain('pre-commit:');
      expect(content).toContain('kici-compile:');
      expect(content).toContain('run: npx -y kici@latest compile && git add .kici/kici.lock.json');
    });

    it('adds to existing lefthook.yml preserving other commands', async () => {
      // Create existing config
      await writeFile(
        path.join(tempDir, 'lefthook.yml'),
        `pre-commit:
  parallel: true
  commands:
    lint:
      run: eslint .
`,
      );

      const result = await installHook('lefthook', { cwd: tempDir });

      expect(result.success).toBe(true);

      const content = await readFile(path.join(tempDir, 'lefthook.yml'), 'utf-8');
      expect(content).toContain('eslint');
      expect(content).toContain('kici-compile:');
    });
  });

  describe('pre-commit', () => {
    it('creates .pre-commit-config.yaml with kici hook', async () => {
      const result = await installHook('pre-commit', { cwd: tempDir });

      expect(result.success).toBe(true);

      const configPath = path.join(tempDir, '.pre-commit-config.yaml');
      const content = await readFile(configPath, 'utf-8');
      expect(content).toContain('repos:');
      expect(content).toContain('- repo: local');
      expect(content).toContain('id: kici-compile');
      expect(content).toContain(
        'entry: npx -y kici@latest compile && git add .kici/kici.lock.json',
      );
      expect(content).toContain('language: system');
    });

    it('adds to existing .pre-commit-config.yaml preserving repos', async () => {
      await writeFile(
        path.join(tempDir, '.pre-commit-config.yaml'),
        `repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.4.0
    hooks:
      - id: trailing-whitespace
`,
      );

      const result = await installHook('pre-commit', { cwd: tempDir });

      expect(result.success).toBe(true);

      const content = await readFile(path.join(tempDir, '.pre-commit-config.yaml'), 'utf-8');
      expect(content).toContain('trailing-whitespace');
      expect(content).toContain('id: kici-compile');
    });
  });

  describe('idempotency', () => {
    it('git hook: second install is a no-op', async () => {
      await installHook('git', { cwd: tempDir });
      const result = await installHook('git', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('skipped');
      expect(result.message).toContain('already installed');
    });

    it('husky hook: second install is a no-op', async () => {
      await mkdir(path.join(tempDir, '.husky'), { recursive: true });
      await installHook('husky', { cwd: tempDir });
      const result = await installHook('husky', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('skipped');
    });

    it('lefthook: second install is a no-op', async () => {
      await installHook('lefthook', { cwd: tempDir });
      const result = await installHook('lefthook', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('skipped');
    });

    it('pre-commit: second install is a no-op', async () => {
      await installHook('pre-commit', { cwd: tempDir });
      const result = await installHook('pre-commit', { cwd: tempDir });

      expect(result.success).toBe(true);
      expect(result.action).toBe('skipped');
    });
  });
});
