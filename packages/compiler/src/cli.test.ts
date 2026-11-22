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

// Each test spawns `node dist/cli.js`; under parallel load (pnpm -r test) a cold
// Node startup can exceed the default 5s timeout.
const SPAWN_TIMEOUT_MS = 30_000;

describe('CLI argument errors', () => {
  it(
    'kici preview without event shows usage help',
    () => {
      const result = runCli('preview');
      // No event: usage help, exit 0, no argument errors.
      expect(result.stderr).not.toContain('missing required argument');
      expect(result.stderr).not.toContain('Allowed choices');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'kici fixture without event shows missing argument error',
    () => {
      const result = runCli('fixture');
      // Commander lists the choices only for an invalid value (next test).
      expect(result.stderr).toContain('missing required argument');
      expect(result.stderr).toContain('event');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'kici preview with fixture-like name shows migration message, not an argument error',
    () => {
      const result = runCli('preview some-fixture');
      // Non-zero exit, but no Commander argument errors.
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
      expect(result.stderr).not.toContain('missing required argument');
      expect(result.stderr).not.toContain('Allowed choices');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'kici run local is retired and redirects to the routed run (exit 2)',
    () => {
      // `kici run local` reaches the parent action (event === 'local'), which
      // prints the retirement hint.
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
      // The retired-command map is not a catch-all.
      expect(result.stderr).not.toContain('kici runs');
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('version banner', () => {
  it(
    'prints the banner on a plain command invocation',
    () => {
      // The banner fires in the preAction hook, before the unauthenticated action errors.
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
      // Errors fast without config, after the preAction hook decided whether to print.
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
    // Commander names an option's property after its LAST long flag: with `--yes`
    // last, `options.approveAll` would be undefined and the breakglass never fire.
    const remote = runRemoteCommand();
    const opt = remote.options.find((o) => o.attributeName() === 'approveAll');
    expect(opt, 'run remote must expose an --approve-all option bound to approveAll').toBeDefined();
    expect(opt!.long).toBe('--approve-all');
    expect(opt!.flags).toContain('--approve-all');
    expect(opt!.flags).toContain('--yes');
    expect(remote.options.some((o) => o.attributeName() === 'yes')).toBe(false);
  });

  it('parses --approve-all and --yes to approveAll:true', () => {
    for (const flag of ['--approve-all', '--yes']) {
      const remote = runRemoteCommand();
      // Neutralise the action so parsing does not run the real command.
      remote.action(() => {});
      remote.parse(['fixture-id', flag], { from: 'user' });
      expect(remote.opts().approveAll, `${flag} should set approveAll`).toBe(true);
    }
  });
});

describe('run remote git flag wiring', () => {
  function parseRemote(args: string[]): Record<string, unknown> {
    const program = buildProgram();
    const run = program.commands.find((c) => c.name() === 'run');
    const remote = run?.commands.find((c) => c.name() === 'remote');
    if (!remote) throw new Error('run remote command not found');
    // Neutralise the action so parsing does not run the real command.
    remote.action(() => {});
    remote.parse(['fixture-id', ...args], { from: 'user' });
    return remote.opts();
  }

  it('gives the tag policy three states: --git-tags, --no-git-tags, neither', () => {
    // fails-when: declaring --no-git-tags makes Commander default gitTags to true,
    // so a run without the flag overrides the lock-derived tag policy
    expect(parseRemote(['--git-tags']).gitTags).toBe(true);
    expect(parseRemote(['--no-git-tags']).gitTags).toBe(false);
    expect(parseRemote([]).gitTags).toBeUndefined();
  });

  it('defaults commit to true and turns it off with --no-commit', () => {
    expect(parseRemote([]).commit).toBe(true);
    expect(parseRemote(['--no-commit']).commit).toBe(false);
  });

  it('collects every --tag and keeps --git-depth raw', () => {
    const opts = parseRemote(['--tag', 'v1', '--tag', 'v2', '--git-depth', '0']);
    expect(opts.tag).toEqual(['v1', 'v2']);
    expect(opts.gitDepth).toBe('0');
    expect(parseRemote([]).tag).toEqual([]);
  });

  it.each([
    ['--tag a..b', "Error: --tag 'a..b' is not a valid tag name"],
    ["--commit-message ''", 'Error: --commit-message must not be empty'],
  ])(
    'exits 2 with a clean error on %s, before any other work',
    (flag, message) => {
      const result = runCli(`run remote push-main ${flag}`);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(message);
      // fails-when: the validator's plain Error escapes as an uncaught stack trace
      expect(result.stderr).not.toMatch(/^\s+at /m);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('isMainEntryPoint (symlink-tolerant entry-point guard)', () => {
  it('returns true when argv[1] is the real module path', () => {
    expect(isMainEntryPoint(CLI_PATH, pathToFileURL(CLI_PATH).href)).toBe(true);
  });

  it('returns true when argv[1] is a SYMLINK to the module (the .bin/kici case)', () => {
    // node_modules/.bin/kici symlinks dist/cli.js, so argv[1] is the symlink path.
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
    // realpathSync throws on a non-existent path; the fallback compares resolved paths.
    const ghost = path.join(tmpdir(), 'does-not-exist-kici-cli.js');
    expect(isMainEntryPoint(ghost, pathToFileURL(ghost).href)).toBe(true);
    expect(isMainEntryPoint(ghost, pathToFileURL(CLI_PATH).href)).toBe(false);
  });
});

describe('CLI invoked through a bin symlink', () => {
  it(
    'runs (prints version) when launched via a symlink to dist/cli.js',
    () => {
      // `node <symlink-to-cli.js>`: a symlink-intolerant main-module check makes
      // the CLI exit 0 silently with no command run.
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

describe('kici login --help', () => {
  function loginHelp(): string {
    const login = buildProgram().commands.find((c) => c.name() === 'login');
    if (!login) throw new Error('login command not found');
    let out = '';
    login.configureOutput({ writeOut: (s) => (out += s), writeErr: (s) => (out += s) });
    login.outputHelp();
    return out;
  }

  it('describes --platform-endpoint as the Platform API URL and lists KICI_PLATFORM_URL', () => {
    const help = loginHelp();
    // fails-when: the flag is described as the relay (WebSocket) URL, which kici login refuses
    // Commander wraps option descriptions; compare with the line breaks folded.
    expect(help.replace(/\s+/g, ' ')).toContain(
      'Platform API URL (http:// or https://, default https://api.kici.dev)',
    );
    expect(help).not.toContain('Platform relay URL');
    // fails-when: the environment block omits the variable kici login reads for the endpoint
    expect(help).toMatch(/^\s+KICI_PLATFORM_URL\s+Platform API URL/m);
    // breaks-if-wrong: the existing variables stay listed
    expect(help).toMatch(/^\s+KICI_OIDC_ISSUER\s+/m);
  });

  it('lists the extra-scope flag and variable', () => {
    const help = loginHelp();
    expect(help).toContain('--oidc-scope <scope>');
    // fails-when: the help hides that one value may list several scopes
    expect(help.replace(/\s+/g, ' ')).toContain(
      'a value may list several scopes separated by commas or spaces',
    );
    expect(help).toMatch(/^\s+KICI_OIDC_EXTRA_SCOPES\s+Extra OIDC scopes/m);
  });

  // fails-when: a second --oidc-scope replaces the first instead of adding to it
  it('collects every --oidc-scope in order', () => {
    const parse = (args: string[]) => {
      const login = buildProgram().commands.find((c) => c.name() === 'login')!;
      login.action(() => {});
      login.parse(args, { from: 'user' });
      return login.opts().oidcScope as string[];
    };
    expect(parse(['--oidc-scope', 'groups', '--oidc-scope', 'api://kici/.default'])).toEqual([
      'groups',
      'api://kici/.default',
    ]);
    expect(parse([])).toEqual([]);
  });
});
