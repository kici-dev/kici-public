import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainEntryPoint, buildProgram } from './cli.js';
import type { Command } from 'commander';

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
    'kici preview without event shows usage help',
    () => {
      const result = runCli('preview');
      // kici preview (no event) prints usage help and exits 0.
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
    'kici preview with fixture-like name shows migration message, not an argument error',
    () => {
      const result = runCli('preview some-fixture');
      // A non-event arg prints the "moved to kici run remote" migration message.
      // It exits non-zero but must NOT show Commander argument errors.
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
    'kici preview with a valid event does not show an argument error',
    () => {
      const result = runCli('preview pr:open');
      // A known event type runs the dry-run preview path. No argument errors.
      expect(result.stderr).not.toContain('missing required argument');
      expect(result.stderr).not.toContain('Allowed choices');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'kici run local is retired and redirects to the routed run (exit 2)',
    () => {
      // The `local` subcommand is gone; `kici run local` reaches the parent
      // `kici run` action (event === 'local'), which prints the retirement hint
      // pointing at `kici run <event> --local` and exits non-zero.
      const result = runCli('run local');
      expect(result.exitCode).toBe(2);
      const out = `${result.stdout}\n${result.stderr}`;
      expect(out).toContain('`kici run local` is retired');
      expect(out).toContain('kici run <event> --local');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'kici status prints a retired-command redirect to kici runs and a help pointer',
    () => {
      const result = runCli('status');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("unknown command 'status'");
      expect(result.stderr).toContain('kici runs');
      expect(result.stderr).toContain('kici --help');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'kici cancel redirects to kici runs cancel',
    () => {
      const result = runCli('cancel');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('kici runs cancel');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'kici with an unknown command shows the help pointer but no retired redirect',
    () => {
      const result = runCli('bogus');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('kici --help');
      // The retired-command map is scoped, not a catch-all: an unrelated typo
      // must not print a redirect that names kici runs.
      expect(result.stderr).not.toContain('kici runs');
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

describe('run remote --approve-all / --yes option wiring', () => {
  function runRemoteCommand(): Command {
    const program = buildProgram();
    const run = program.commands.find((c) => c.name() === 'run');
    if (!run) throw new Error('run command not found');
    const remote = run.commands.find((c) => c.name() === 'remote');
    if (!remote) throw new Error('run remote command not found');
    return remote;
  }

  it('binds the approve-all/--yes flags to the approveAll property (not `yes`)', () => {
    // Commander derives an option's property name from its LAST long flag. If the
    // flag string lists `--approve-all` last, the property is `approveAll`; had it
    // listed `--yes` last, `options.approveAll` would silently be undefined and the
    // breakglass would never fire. This asserts the correct binding.
    const remote = runRemoteCommand();
    const opt = remote.options.find((o) => o.attributeName() === 'approveAll');
    expect(opt, 'run remote must expose an --approve-all option bound to approveAll').toBeDefined();
    expect(opt!.long).toBe('--approve-all');
    // Both spellings remain accepted aliases.
    expect(opt!.flags).toContain('--approve-all');
    expect(opt!.flags).toContain('--yes');
    // The mis-binding would have produced a `yes` attribute instead.
    expect(remote.options.some((o) => o.attributeName() === 'yes')).toBe(false);
  });

  it('parses --approve-all and --yes to approveAll:true', () => {
    for (const flag of ['--approve-all', '--yes']) {
      const remote = runRemoteCommand();
      // Neutralise the action so parsing does not execute the real command.
      remote.action(() => {});
      remote.parse(['fixture-id', flag], { from: 'user' });
      expect(remote.opts().approveAll, `${flag} should set approveAll`).toBe(true);
    }
  });
});

describe('isMainEntryPoint (symlink-tolerant entry-point guard)', () => {
  it('returns true when argv[1] is the real module path', () => {
    expect(isMainEntryPoint(CLI_PATH, pathToFileURL(CLI_PATH).href)).toBe(true);
  });

  it('returns true when argv[1] is a SYMLINK to the module (the .bin/kici case)', () => {
    // node_modules/.bin/kici is a symlink to the compiler's dist/cli.js.
    // Executing the symlink sets process.argv[1] to the symlink path; the guard
    // must still recognise the module as the entry point.
    const dir = mkdtempSync(path.join(tmpdir(), 'kici-cli-guard-'));
    const link = path.join(dir, 'kici');
    try {
      symlinkSync(CLI_PATH, link);
      expect(isMainEntryPoint(link, pathToFileURL(CLI_PATH).href)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false when argv[1] points at a different file (imported, not entry)', () => {
    expect(isMainEntryPoint(__filename, pathToFileURL(CLI_PATH).href)).toBe(false);
  });

  it('returns false when argv[1] is absent', () => {
    expect(isMainEntryPoint(undefined, pathToFileURL(CLI_PATH).href)).toBe(false);
  });

  it('falls back to resolve() comparison when argv[1] does not exist on disk', () => {
    // A non-existent argv[1] makes realpathSync throw; the fallback compares
    // resolved paths. Identical non-existent paths still match.
    const ghost = path.join(tmpdir(), 'does-not-exist-kici-cli.js');
    expect(isMainEntryPoint(ghost, pathToFileURL(ghost).href)).toBe(true);
    expect(isMainEntryPoint(ghost, pathToFileURL(CLI_PATH).href)).toBe(false);
  });
});

describe('CLI invoked through a bin symlink', () => {
  it(
    'runs (prints version) when launched via a symlink to dist/cli.js',
    () => {
      // Reproduces the staging canary failure: `node <symlink-to-cli.js> ...`.
      // Before the symlink-tolerant guard, the main-module check failed and the
      // CLI silently exited 0 with no output (no command ran).
      const dir = mkdtempSync(path.join(tmpdir(), 'kici-cli-binlink-'));
      const link = path.join(dir, 'kici');
      try {
        symlinkSync(CLI_PATH, link);
        const stdout = execSync(`node "${link}" --version`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        expect(stdout.trim().length).toBeGreaterThan(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});
