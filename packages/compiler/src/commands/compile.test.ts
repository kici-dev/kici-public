import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as childProcess from 'node:child_process';
import { logger } from '@kici-dev/core';
import { initCommand } from './init.js';
import { compileCommand } from './compile.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn(actual.execSync) };
});

describe('kici compile: dep-reinstall gate', () => {
  let tempDir: string;
  let originalCwd: string;
  let originalCI: string | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalCI = process.env.CI;
    process.env.CI = 'true';
    const packageDir = path.resolve(import.meta.dirname, '..', '..');
    tempDir = await fs.mkdtemp(path.join(packageDir, '.test-compile-'));
    process.chdir(tempDir);
    vi.mocked(childProcess.execSync).mockClear();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    process.env.CI = originalCI;
    delete process.env.KICI_DEV;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // Mark `.kici/kici.lock.json`'s `lockfileHash` stale so the dep-change branch
  // would fire.
  async function staleDepsHash(): Promise<void> {
    const lockPath = path.join(tempDir, '.kici', 'kici.lock.json');
    const lock = JSON.parse(await fs.readFile(lockPath, 'utf-8'));
    lock.lockfileHash = 'sha256-deadbeef-stale-hash-for-test';
    await fs.writeFile(lockPath, JSON.stringify(lock, null, 2));
  }

  it('skips reinstall when `.kici/package.json` is absent (workspace-managed deps)', async () => {
    // Setup: scaffold a `.kici/` with workflows + lock file, then remove the
    // `package.json` to simulate a workspace member whose deps live at the
    // repo root (the kici monorepo's own dogfood `.kici/`).
    expect(await initCommand({ skipInstall: true })).toBe(true);
    expect(await compileCommand({ check: false, verbose: false })).toBe(true);
    await fs.rm(path.join(tempDir, '.kici', 'package.json'));
    await staleDepsHash();

    // The "deps changed" branch must NOT call `npm install` here: with no
    // `.kici/package.json`, npm walks up to the workspace root and chokes on
    // `workspace:*` refs.
    vi.mocked(childProcess.execSync).mockClear();
    expect(await compileCommand({ check: false, verbose: false })).toBe(true);

    const installCalls = vi
      .mocked(childProcess.execSync)
      .mock.calls.filter(([cmd]) => /\bnpm (ci|install)\b/.test(String(cmd)));
    expect(installCalls).toEqual([]);
  });
});

describe('kici compile: dynamic-value functions', () => {
  let tempDir: string;
  let originalCwd: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    originalCwd = process.cwd();
    process.env.CI = 'true';
    const packageDir = path.resolve(import.meta.dirname, '..', '..');
    tempDir = await fs.mkdtemp(path.join(packageDir, '.test-compile-dynamic-'));
    process.chdir(tempDir);
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('compiles a function context to a dynamic marker (no inline expression, no purity warning)', async () => {
    expect(await initCommand({ skipInstall: true })).toBe(true);
    // Replace the scaffolded workflow with one whose context is a function.
    const workflowsDir = path.join(tempDir, '.kici', 'workflows');
    for (const f of await fs.readdir(workflowsDir)) {
      await fs.rm(path.join(workflowsDir, f));
    }
    await fs.writeFile(
      path.join(workflowsDir, 'dynamic.ts'),
      [
        "import { workflow, job, step, push } from '@kici-dev/sdk';",
        "export default workflow('ci', {",
        '  on: push({ branches: ["main"] }),',
        '  jobs: [',
        "    job('build', {",
        '      runsOn: ["self-hosted"],',
        '      context: (event) => event.targetBranch,',
        "      steps: [step('run', async ({ $ }) => { await $`echo hi`; })],",
        '    }),',
        '  ],',
        '});',
        '',
      ].join('\n'),
      'utf-8',
    );

    const ok = await compileCommand({ check: false, verbose: false });
    expect(ok).toBe(true);

    // The function context is serialized as a dynamic marker, never an inline
    // expression — the agent init round resolves it.
    const lockPath = path.join(tempDir, '.kici', 'kici.lock.json');
    const lockJson = await fs.readFile(lockPath, 'utf-8');
    expect(lockJson).not.toContain('_type": "inline"');
    const lock = JSON.parse(lockJson);
    expect(lock.workflows[0].jobs[0].contexts).toEqual([{ value: '', dynamic: true }]);

    // No purity / init-job warning is emitted (the notion no longer exists).
    const warnLines = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnLines).not.toContain('is not pure');
    expect(warnLines).not.toContain('~5-10s');
  });
});
