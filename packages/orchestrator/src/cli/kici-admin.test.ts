import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { canonicalize, buildProgram, CLI_VERSION } from './kici-admin.js';

/**
 * The entry-point guard in kici-admin.ts compares the invoked script path
 * (`process.argv[1]`) against this module's own resolved path
 * (`fileURLToPath(import.meta.url)`). On macOS the light-package launcher runs
 * `node /tmp/.../kici-admin.cjs`, but `/tmp` is a symlink to `/private/tmp`, so
 * the two sides only match once both are canonicalized through their symlinks.
 * These tests pin `canonicalize` to that behavior.
 */
describe('canonicalize (kici-admin entry guard)', () => {
  let realDir: string;
  let symlinkDir: string;
  let realFile: string;

  beforeAll(() => {
    realDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'kici-canon-'));
    realFile = path.join(realDir, 'kici-admin.cjs');
    fs.writeFileSync(realFile, '// fixture', 'utf-8');
    symlinkDir = path.join(fs.realpathSync(os.tmpdir()), `kici-canon-link-${process.pid}`);
    try {
      fs.unlinkSync(symlinkDir);
    } catch {
      /* not present */
    }
    fs.symlinkSync(realDir, symlinkDir, 'dir');
  });

  afterAll(() => {
    try {
      fs.unlinkSync(symlinkDir);
    } catch {
      /* ignore */
    }
    fs.rmSync(realDir, { recursive: true, force: true });
  });

  it('resolves a path reached through a symlinked directory to its real path', () => {
    const viaSymlink = path.join(symlinkDir, 'kici-admin.cjs');
    // The symlinked path and the real path are different strings...
    expect(viaSymlink).not.toBe(realFile);
    // ...but canonicalize collapses both to the same on-disk identity, which is
    // what lets the entry guard match a symlinked launcher invocation.
    expect(canonicalize(viaSymlink)).toBe(canonicalize(realFile));
    expect(canonicalize(viaSymlink)).toBe(realFile);
  });

  it('falls back to a plain resolve when the path does not exist on disk', () => {
    const missing = path.join(realDir, 'does-not-exist.cjs');
    expect(canonicalize(missing)).toBe(path.resolve(missing));
  });

  it('resolves a relative path to an absolute one', () => {
    expect(path.isAbsolute(canonicalize('some/relative/path'))).toBe(true);
  });
});

/**
 * `--version` used to report a hardcoded `0.0.1` placeholder, so a support
 * bundle or an issue report carried no usable version context for the admin
 * CLI. The version now comes from the build-injected package version.
 */
describe('kici-admin --version', () => {
  it('reports CLI_VERSION rather than a literal placeholder', () => {
    expect(buildProgram().version()).toBe(CLI_VERSION);
  });

  it('does not pass a bare version literal to Commander', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, 'kici-admin.ts'), 'utf-8');
    // Positive control: the registration this assertion is about is present,
    // so an empty match below means "no literal", not "file not read".
    expect(src).toMatch(/\.version\(/);
    expect(src).not.toMatch(/\.version\(\s*['"]/);
  });
});

/**
 * The root version flag is `-V, --cli-version`, because Commander matches a
 * program option anywhere in argv and `orchestrator upgrade` / `agent upgrade`
 * own `--version <version>`. `--version` must still print the CLI version when
 * it comes before any command, without taking the subcommands' option away.
 */
describe('kici-admin root version flags', () => {
  interface Parsed {
    /** Stdout Commander wrote (the version line, when one was printed). */
    out: string;
    /** Commander's exit code, or null when the parse ran to an action. */
    exitCode: number | null;
    /** The options the stubbed upgrade action received. */
    upgradeOpts: Record<string, unknown> | null;
    program: ReturnType<typeof buildProgram>;
  }

  /** Parse `args` in-process with every upgrade action replaced by a recorder. */
  async function parse(args: string[]): Promise<Parsed> {
    const program = buildProgram();
    let out = '';
    let upgradeOpts: Record<string, unknown> | null = null;
    program.exitOverride();
    program.configureOutput({ writeOut: (s) => (out += s), writeErr: () => {} });
    for (const group of ['orchestrator', 'agent']) {
      const upgrade = program.commands
        .find((c) => c.name() === group)
        ?.commands.find((c) => c.name() === 'upgrade');
      // Positive control: the subcommand whose `--version` is under test exists.
      expect(upgrade, `${group} upgrade is registered`).toBeDefined();
      upgrade!.exitOverride().action((opts: Record<string, unknown>) => {
        upgradeOpts = opts;
      });
    }
    let exitCode: number | null = null;
    try {
      await program.parseAsync(args, { from: 'user' });
    } catch (err) {
      exitCode = (err as { exitCode?: number }).exitCode ?? -1;
    }
    return { out, exitCode, upgradeOpts, program };
  }

  // fails-when: the root registers only `-V, --cli-version` and no leading
  // `--version` handling — Commander exits 1 with "unknown option '--version'".
  it('prints the CLI version for a bare --version and exits 0', async () => {
    const r = await parse(['--version']);
    expect(r.exitCode).toBe(0);
    expect(r.out).toBe(`${CLI_VERSION}\n`);
  });

  it('prints the CLI version for --version after leading global options', async () => {
    const r = await parse(['-u', 'http://x', '--url=http://y', '-t', 'tok', '--version']);
    expect(r.exitCode).toBe(0);
    expect(r.out).toBe(`${CLI_VERSION}\n`);
  });

  // breaks-if-wrong: the existing spellings keep printing the version.
  it.each([['-V'], ['--cli-version']])('still prints the CLI version for %s', async (flag) => {
    const r = await parse([flag]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toBe(`${CLI_VERSION}\n`);
  });

  // `-V` and `--cli-version` are registered root options, so they print the
  // version after a command name too, as they always have.
  it.each([['-V'], ['--cli-version']])(
    'still prints the CLI version for %s after a command',
    async (flag) => {
      const r = await parse(['orchestrator', 'upgrade', flag]);
      expect(r.exitCode).toBe(0);
      expect(r.out).toBe(`${CLI_VERSION}\n`);
      expect(r.upgradeOpts).toBeNull();
    },
  );

  // breaks-if-wrong: a subcommand's own `--version <version>` keeps its value.
  it.each([['orchestrator'], ['agent']])(
    '%s upgrade --version 1.2.3 passes 1.2.3 to the upgrade',
    async (group) => {
      const r = await parse([group, 'upgrade', '--version', '1.2.3']);
      expect(r.exitCode).toBeNull();
      expect(r.out).toBe('');
      expect(r.upgradeOpts?.version).toBe('1.2.3');
    },
  );

  // breaks-if-wrong: global options keep parsing after a subcommand, and a
  // value-taking global option before the command still consumes its value.
  it('keeps parsing global options placed after the subcommand', async () => {
    const r = await parse([
      'orchestrator',
      'upgrade',
      '--version',
      '1.2.3',
      '-u',
      'http://after',
      '-t',
      'tok-after',
    ]);
    expect(r.exitCode).toBeNull();
    expect(r.upgradeOpts?.version).toBe('1.2.3');
    expect(r.program.opts()).toMatchObject({ url: 'http://after', token: 'tok-after' });
  });

  it('keeps parsing global options placed before the subcommand', async () => {
    const r = await parse(['-u', 'http://before', 'orchestrator', 'upgrade', '--version', '9.9.9']);
    expect(r.exitCode).toBeNull();
    expect(r.upgradeOpts?.version).toBe('9.9.9');
    expect(r.program.opts()).toMatchObject({ url: 'http://before' });
  });

  it('treats --version as the value of a global option that takes one', async () => {
    // `-u --version`: Commander reads `--version` as the URL, as it always has.
    const r = await parse(['-u', '--version', 'orchestrator', 'upgrade']);
    expect(r.exitCode).toBeNull();
    expect(r.out).toBe('');
    expect(r.program.opts()).toMatchObject({ url: '--version' });
  });
});

/**
 * Commander matches a root option anywhere in argv, so on its own the root
 * would take the value of a command option declared under a root flag
 * (`-u, --url`, `-t, --token`, `-V, --cli-version`). After the command's name
 * such a flag belongs to the command; every other root flag parses in any
 * position.
 */
describe('kici-admin command options that share a root flag', () => {
  function findCommand(program: Command, names: readonly string[]): Command {
    let cmd = program;
    for (const name of names) {
      const sub = cmd.commands.find((c) => c.name() === name);
      expect(sub, `kici-admin ${names.join(' ')} is registered`).toBeDefined();
      cmd = sub!;
    }
    return cmd;
  }

  /** Every `<command path> <flag>` whose flag is also a root option's flag. */
  function sharedFlags(program: Command): string[] {
    const rootFlags = new Set(
      program.options.flatMap((o) => [o.short, o.long]).filter((f): f is string => !!f),
    );
    const found: string[] = [];
    const walk = (cmd: Command, path: string[]): void => {
      for (const sub of cmd.commands) {
        const subPath = [...path, sub.name()];
        for (const o of sub.options) {
          for (const flag of [o.short, o.long]) {
            if (flag && rootFlags.has(flag)) found.push(`${subPath.join(' ')} ${flag}`);
          }
        }
        walk(sub, subPath);
      }
    };
    walk(program, []);
    return found.sort();
  }

  /** Parse with the target command's action stubbed; return both option sets. */
  async function run(
    commandPath: readonly string[],
    args: string[],
  ): Promise<{ root: Record<string, unknown>; command: Record<string, unknown> }> {
    const program = buildProgram();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    const target = findCommand(program, commandPath);
    target.exitOverride().action(() => {});
    await program.parseAsync(args, { from: 'user' });
    return { root: program.opts(), command: target.opts() };
  }

  const defaults = buildProgram().opts<{ url: string; token?: string }>();

  // The list is literal: a new command option under a root flag must be added
  // here, and gets a parse case below.
  it('pins every command option that shares a flag with a root option', () => {
    expect(sharedFlags(buildProgram())).toEqual([
      'agent install --token',
      'agent upgrade --url',
      'backend add --token',
      'backend test --token',
      'join --token',
      'orchestrator upgrade --url',
    ]);
  });

  // fails-when: the root's parseOptions consumes the flag wherever it appears —
  // the command option stays unset and the root option takes the value.
  // breaks-if-wrong: the root option keeps its default, so a command that
  // calls the admin API still authenticates with the global token.
  it.each<[string[], string[], 'url' | 'token']>([
    [['orchestrator', 'upgrade'], ['--url', 'https://dl.example/o.tgz'], 'url'],
    [['agent', 'upgrade'], ['--url', 'https://dl.example/a.tgz'], 'url'],
    [['agent', 'install'], ['--token', 'tok-agent'], 'token'],
    [['backend', 'add'], ['vault1', '--type', 'vault', '--token', 'tok-vault'], 'token'],
    [['backend', 'test'], ['vault1', '--token', 'tok-vault'], 'token'],
    [['join'], ['--token', 'kici_join_v1.a.b'], 'token'],
  ])('kici-admin %j %j gives --%s to the command', async (path, rest, key) => {
    const value = rest[rest.indexOf(`--${key}`) + 1];
    const r = await run(path, [...path, ...rest]);
    expect(r.command[key]).toBe(value);
    expect(r.root[key]).toBe(defaults[key]);
  });

  it('gives an inline --url=<value> to the command', async () => {
    const r = await run(
      ['orchestrator', 'upgrade'],
      ['orchestrator', 'upgrade', '--url=https://x/o.tgz'],
    );
    expect(r.command.url).toBe('https://x/o.tgz');
    expect(r.root.url).toBe(defaults.url);
  });

  // breaks-if-wrong: a global option before the command, and a global short
  // flag after it, still set the global option next to the command's own.
  it('keeps the root option before the command and the short flag after it', async () => {
    const r = await run(
      ['orchestrator', 'upgrade'],
      ['-u', 'http://orch', 'orchestrator', 'upgrade', '--url', 'https://x/o.tgz', '-t', 'adm'],
    );
    expect(r.command.url).toBe('https://x/o.tgz');
    expect(r.root).toMatchObject({ url: 'http://orch', token: 'adm' });

    const j = await run(['join'], ['join', '--token', 'kici_join_v1.a.b', '-t', 'adm']);
    expect(j.command.token).toBe('kici_join_v1.a.b');
    expect(j.root.token).toBe('adm');
  });

  // breaks-if-wrong: a command that does not declare --url / --token leaves both
  // to the root, in any position, as before.
  it('gives --url and --token after a command without them to the root', async () => {
    const r = await run(
      ['secret', 'list'],
      ['secret', 'list', 'org-1', 'repo', '--url', 'http://orch', '--token', 'adm'],
    );
    expect(r.root).toMatchObject({ url: 'http://orch', token: 'adm' });
    expect(r.command.url).toBeUndefined();
  });

  // fails-when: the root reads `-uP4ss` as `-u P4ss`; --password is then missing.
  // breaks-if-wrong: a root flag after the value still sets the global option.
  it('gives an option-shaped value to the command option that takes it', async () => {
    const r = await run(
      ['db', 'create-role'],
      ['db', 'create-role', '--user', 'kici', '--password', '-uP4ss', '-t', 'adm'],
    );
    expect(r.command.password).toBe('-uP4ss');
    expect(r.root).toMatchObject({ url: defaults.url, token: 'adm' });
  });

  // A flag before the command that declares it is the root's.
  it('gives --url before the declaring command to the root', async () => {
    const r = await run(
      ['orchestrator', 'upgrade'],
      ['orchestrator', '--url', 'http://orch', 'upgrade'],
    );
    expect(r.root.url).toBe('http://orch');
    expect(r.command.url).toBeUndefined();
  });
});
