import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as childProcess from 'node:child_process';
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
