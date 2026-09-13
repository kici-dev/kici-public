import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { compilerError } from '../errors/index.js';
import type { TypecheckResult } from '../validation/typecheck.js';

// Mock the type-check module so the wiring is exercised deterministically
// (a real tsc run needs an installed workspace — that path is covered by E2E).
const runTypecheck = vi.fn<() => Promise<TypecheckResult>>();
vi.mock('../validation/typecheck.js', () => ({
  runTypecheck: () => runTypecheck(),
  parseTscOutput: vi.fn(),
}));

const { initCommand } = await import('./init.js');
const { compileCommand } = await import('./compile.js');

describe('kici compile --check: type-check wiring', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    process.env.CI = 'true';
    const packageDir = path.resolve(import.meta.dirname, '..', '..');
    tempDir = await fs.mkdtemp(path.join(packageDir, '.test-compile-check-'));
    process.chdir(tempDir);
    expect(await initCommand({ skipInstall: true })).toBe(true);
    runTypecheck.mockReset();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('--check fails when the type-check reports errors', async () => {
    runTypecheck.mockResolvedValue({
      ran: true,
      errors: [
        compilerError('E120', "TS2322: Type 'number' is not assignable to type 'string'.", {
          location: { file: 'workflows/ci.ts', line: 4, column: 3 },
        }),
      ],
    });
    const ok = await compileCommand({ check: true, verbose: false, quiet: true });
    expect(ok).toBe(false);
    expect(runTypecheck).toHaveBeenCalledOnce();
    // --check never writes the lock file.
    expect(existsSync(path.join(tempDir, '.kici', 'kici.lock.json'))).toBe(false);
  });

  it('--check passes when the type-check is clean and writes no lock file', async () => {
    runTypecheck.mockResolvedValue({ ran: true, errors: [] });
    const ok = await compileCommand({ check: true, verbose: false, quiet: true });
    expect(ok).toBe(true);
    expect(runTypecheck).toHaveBeenCalledOnce();
    expect(existsSync(path.join(tempDir, '.kici', 'kici.lock.json'))).toBe(false);
  });

  it('--check succeeds when the type-check is skipped (no tsconfig)', async () => {
    runTypecheck.mockResolvedValue({ ran: false, errors: [] });
    const ok = await compileCommand({ check: true, verbose: false, quiet: true });
    expect(ok).toBe(true);
    expect(runTypecheck).toHaveBeenCalledOnce();
  });

  it('normal compile does not type-check and writes the lock file', async () => {
    const ok = await compileCommand({ check: false, verbose: false, quiet: true });
    expect(ok).toBe(true);
    expect(runTypecheck).not.toHaveBeenCalled();
    expect(existsSync(path.join(tempDir, '.kici', 'kici.lock.json'))).toBe(true);
  });
});
