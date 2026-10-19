import { describe, expect, it } from 'vitest';
import {
  AGENT_HELP_FIELDS,
  handleAgentCliArgs,
  makeIo,
  parseAgentArgs,
  renderAgentHelp,
  resolveAgentVersion,
  type CliIo,
} from './cli-args.js';
import { envDef } from './config.js';
import { readAgentVersion } from './version.js';

class ExitSentinel extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function fakeIo(): CliIo & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    stdout(text: string) {
      io.out += text;
    },
    stderr(text: string) {
      io.err += text;
    },
    exit(code: number): never {
      throw new ExitSentinel(code);
    },
  };
  return io;
}

function exitCodeOf(fn: () => void): number | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof ExitSentinel) return err.code;
    throw err;
  }
  return undefined;
}

describe('parseAgentArgs', () => {
  it('runs with no arguments', () => {
    expect(parseAgentArgs([])).toEqual({ kind: 'run' });
  });

  it.each([[['--help']], [['-h']], [['-V', '-h']]])('%j prints help', (args) => {
    expect(parseAgentArgs(args)).toEqual({ kind: 'help' });
  });

  it.each([[['--version']], [['-V']]])('%j prints the version', (args) => {
    expect(parseAgentArgs(args)).toEqual({ kind: 'version' });
  });

  // fails-when: unknown arguments are ignored, or a known flag is checked before them.
  it.each([
    [['-v'], '-v'],
    [['start'], 'start'],
    [['--help=x'], '--help=x'],
    [['--help', '--bogus'], '--bogus'],
  ])('%j is a usage error naming %s', (args, arg) => {
    expect(parseAgentArgs(args)).toEqual({ kind: 'usage-error', arg });
  });
});

describe('renderAgentHelp', () => {
  const specs = envDef.describe();
  const help = renderAgentHelp(specs);

  // fails-when: help is a hand-kept list missing a required variable the schema gained.
  it('help lists every required env var from the schema', () => {
    const required = specs.filter((spec) => spec.required);
    expect(required.length).toBeGreaterThan(0);
    for (const spec of required) expect(help).toContain(spec.envVar);
    expect(help).toContain('KICI_ORCHESTRATOR_URL');
  });

  it('every help row has a description', () => {
    const rows = [
      ...specs.filter((spec) => spec.required),
      ...AGENT_HELP_FIELDS.map((field) => specs.find((spec) => spec.fieldPath === field)),
    ];
    for (const spec of rows) {
      expect(spec, 'AGENT_HELP_FIELDS names a field the schema does not have').toBeDefined();
      expect(spec?.description, spec?.envVar).toBeTruthy();
      expect(help).toContain(spec?.envVar);
    }
  });

  it('help names the flags and the configuration docs page', () => {
    expect(help).toContain('-h, --help');
    expect(help).toContain('-V, --version');
    expect(help).toContain('https://docs.kici.dev/operator/agent/configuration/');
  });
});

describe('resolveAgentVersion', () => {
  it('prefers the installed manifest, then the baked value', () => {
    expect(resolveAgentVersion('0.24.0-10400', '0.24.0')).toBe('0.24.0-10400');
    expect(resolveAgentVersion(null, '0.24.0')).toBe('0.24.0');
    expect(resolveAgentVersion(null, undefined)).toBe('unknown');
  });
});

describe('handleAgentCliArgs', () => {
  // breaks-if-wrong: every scaler, service and container launch passes no arguments.
  it('returns and writes nothing with no arguments', () => {
    const io = fakeIo();
    expect(exitCodeOf(() => handleAgentCliArgs([], io))).toBeUndefined();
    expect(io.out).toBe('');
    expect(io.err).toBe('');
  });

  it('--version writes the version to stdout and exits 0', () => {
    const io = fakeIo();
    expect(exitCodeOf(() => handleAgentCliArgs(['--version'], io))).toBe(0);
    expect(io.out).toBe(`${resolveAgentVersion(readAgentVersion(), undefined)}\n`);
    expect(io.out).toMatch(/^\d+\.\d+\.\d+/);
    expect(io.err).toBe('');
  });

  it('--help writes help to stdout and exits 0', () => {
    const io = fakeIo();
    expect(exitCodeOf(() => handleAgentCliArgs(['--help'], io))).toBe(0);
    expect(io.out).toContain('Required environment variables:');
    expect(io.err).toBe('');
  });

  it('an unknown argument writes usage to stderr and exits 2', () => {
    const io = fakeIo();
    expect(exitCodeOf(() => handleAgentCliArgs(['--bogus'], io))).toBe(2);
    expect(io.err).toContain('unknown argument "--bogus"');
    expect(io.err).toContain('--help');
    expect(io.out).toBe('');
  });
});

describe('makeIo', () => {
  // fails-when: the writer lets EPIPE escape (`kici-agent --help | head -1` would crash).
  it('ignores EPIPE on write', () => {
    const io = makeIo(() => {
      throw Object.assign(new Error('pipe'), { code: 'EPIPE' });
    });
    expect(() => io.stdout('x')).not.toThrow();
  });

  it('rethrows any other write error', () => {
    const io = makeIo(() => {
      throw Object.assign(new Error('bad fd'), { code: 'EBADF' });
    });
    expect(() => io.stderr('x')).toThrow('bad fd');
  });
});
