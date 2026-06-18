import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLI_PATH = path.resolve(__dirname, '../dist/cli.js');

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCli(args: string): CliResult {
  try {
    const stdout = execSync(`node "${CLI_PATH}" ${args}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      exitCode: error.status ?? 1,
    };
  }
}

// Each test spawns `node dist/cli.js` via execSync — under parallel test-package
// load (pnpm -r test) the default 5s timeout is not always enough for a fresh
// Node startup + CLI parse. Bump to 30s to absorb cold-cache jitter.
const SPAWN_TIMEOUT_MS = 30_000;

describe('CLI argument errors', () => {
  it(
    'kici test without fixture lists fixtures or shows empty message',
    () => {
      const result = runCli('test');
      // In the fixture-based interface, kici test (no args) lists available fixtures.
      // It exits 0 even when no fixtures are found (informational output).
      // It should NOT show argument errors about events.
      expect(result.stderr).not.toContain('missing required argument');
      expect(result.stderr).not.toContain('Allowed choices');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'kici fixture without event shows missing argument error',
    () => {
      const result = runCli('fixture');
      // Commander shows "missing required argument" when no event is provided.
      // The choices are only listed when an invalid value is given (see next test).
      expect(result.stderr).toContain('missing required argument');
      expect(result.stderr).toContain('event');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'kici test with fixture name does not show argument error',
    () => {
      const result = runCli('test some-fixture');
      // In the fixture-based interface, any string is a valid fixture name.
      // It may fail (no matching fixture) but should NOT show argument errors.
      expect(result.stderr).not.toContain('Allowed choices');
      expect(result.stderr).not.toContain('missing required argument');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'kici fixture with invalid event shows choices',
    () => {
      const result = runCli('fixture bad-value');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('bad-value');
      expect(result.stderr).toContain('pr:open');
      expect(result.stderr).toContain('Available events');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'kici test with --dry-run and valid event does not show argument error',
    () => {
      const result = runCli('test --dry-run pr:open');
      // Events are now only used with --dry-run. Should not show argument errors.
      expect(result.stderr).not.toContain('missing required argument');
      expect(result.stderr).not.toContain('Allowed choices');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'kici run local --pick combined with --workflow exits 2',
    () => {
      const result = runCli('run local --pick --workflow ci');
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('mutually exclusive');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'kici run local with no event and no --pick exits 2',
    () => {
      const result = runCli('run local');
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('missing event argument');
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('version banner', () => {
  it(
    'prints the banner on a plain command invocation',
    () => {
      // `runs show` errors without auth, but the banner fires in the preAction
      // hook before the action runs, so it lands on stdout regardless.
      const result = runCli('runs show some-fake-id');
      expect(result.stdout).toContain('kici v');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'suppresses the banner when --json is set',
    () => {
      const result = runCli('runs show some-fake-id --json');
      expect(result.stdout).not.toContain('kici v');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'suppresses the banner when --quiet is set',
    () => {
      // run remote carries --quiet; it errors fast without config but the
      // preAction hook has already decided whether to print.
      const result = runCli('run remote --quiet');
      expect(result.stdout).not.toContain('kici v');
    },
    SPAWN_TIMEOUT_MS,
  );
});
