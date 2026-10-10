import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { UNSETTLED_EXIT_MESSAGE } from './cli-unsettled-guard.js';

/**
 * The guard, transpiled to plain JavaScript for the spawned processes. A
 * spawned Node cannot be relied on to load `.ts` itself: Debian's packaged
 * Node.js, which the public CI replica runs, is built without type stripping
 * and refuses the import with ERR_UNKNOWN_FILE_EXTENSION.
 */
function transpiledGuardUrl(): string {
  const source = readFileSync(path.join(__dirname, 'cli-unsettled-guard.ts'), 'utf-8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const file = path.join(
    mkdtempSync(path.join(tmpdir(), 'kici-guard-')),
    'cli-unsettled-guard.mjs',
  );
  writeFileSync(file, outputText);
  return pathToFileURL(file).href;
}

const GUARD_URL = transpiledGuardUrl();

/** Each case runs in its own Node process: the guard acts on that process's exit. */
const SPAWN_TIMEOUT_MS = 30_000;

/** Run `body` as an ES module in a fresh Node process, with the guard imported as `guard`. */
function runNode(body: string): { status: number | null; stderr: string } {
  const script = `import { guardUnsettledExit as guard } from ${JSON.stringify(GUARD_URL)};\n${body}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf-8',
    timeout: SPAWN_TIMEOUT_MS,
  });
  return { status: result.status, stderr: result.stderr };
}

describe('guardUnsettledExit', () => {
  it(
    'exits 0 with no output when nothing guards a promise that never settles',
    () => {
      // The failure the guard exists for: Node drains the event loop and reports success.
      const result = runNode('new Promise(() => {});');
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'exits 1 with the internal-error message when the guarded promise never settles',
    () => {
      // fails-when: the guard is not installed, and the same script exits 0 (case above)
      const result = runNode('guard(new Promise(() => {}));');
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(`${UNSETTLED_EXIT_MESSAGE}\n`);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'leaves the exit code alone once the guarded promise resolves',
    () => {
      // breaks-if-wrong: a command that finishes and lets the loop drain must still exit 0
      const result = runNode(
        'guard(new Promise((resolve) => setTimeout(resolve, 10))); console.error("done");',
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('done\n');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'leaves the exit code alone once the guarded promise rejects and the rejection is handled',
    () => {
      const result = runNode(
        'const work = Promise.reject(new Error("x")); guard(work); work.catch(() => {});',
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'does not interfere with a command that calls process.exit while its promise is pending',
    () => {
      // breaks-if-wrong: most commands end with process.exit(code) from inside the action
      const result = runNode(
        'guard(new Promise(() => {})); setTimeout(() => process.exit(0), 10);',
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    },
    SPAWN_TIMEOUT_MS,
  );
});
