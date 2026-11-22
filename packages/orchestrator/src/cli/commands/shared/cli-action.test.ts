import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cliAction,
  parseIntOption,
  printJsonOr,
  requireDbOnlyUrl,
  resolveDatabaseUrl,
  resolveDbOnlyUrl,
  resolveDirectDbUrl,
  setAdminUrlOnCommandLine,
} from './cli-action.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.KICI_DATABASE_URL;
  setAdminUrlOnCommandLine(false);
});

describe('cliAction', () => {
  // fails-when: the wrapper swallows the error without exiting 1
  it('prints Error: <message> and exits 1 on throw', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await cliAction(async () => {
      throw new Error('boom');
    })();
    expect(err).toHaveBeenCalledWith('Error: boom');
    expect(exit).toHaveBeenCalledWith(1);
  });

  // breaks-if-wrong: a successful action must not exit
  it('passes arguments through and does not exit on success', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const seen: unknown[] = [];
    await cliAction(async (a: string, b: number) => {
      seen.push(a, b);
    })('x', 2);
    expect(seen).toEqual(['x', 2]);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('db url resolution', () => {
  it('prefers the explicit flag, then the env var, then null', () => {
    process.env.KICI_DATABASE_URL = 'postgres://env';
    expect(resolveDirectDbUrl('postgres://a')).toBe('postgres://a');
    expect(resolveDirectDbUrl()).toBe('postgres://env');
    delete process.env.KICI_DATABASE_URL;
    expect(resolveDirectDbUrl()).toBeNull();
  });

  it('lets an explicit --url win over the env var, but not over --database-url', () => {
    process.env.KICI_DATABASE_URL = 'postgres://env';
    setAdminUrlOnCommandLine(true);
    // fails-when: the orchestrator host's KICI_DATABASE_URL overrides an explicit --url
    expect(resolveDirectDbUrl()).toBeNull();
    // breaks-if-wrong: an explicit --database-url still selects the database
    expect(resolveDirectDbUrl('postgres://a')).toBe('postgres://a');
  });

  it('resolves a database-only command from the env var even with an explicit --url', () => {
    process.env.KICI_DATABASE_URL = 'postgres://env';
    setAdminUrlOnCommandLine(true);
    // fails-when: an explicit --url hides KICI_DATABASE_URL from a command with no admin API mode
    expect(resolveDbOnlyUrl()).toBe('postgres://env');
    expect(resolveDatabaseUrl()).toBe('postgres://env');
    expect(resolveDbOnlyUrl('postgres://a')).toBe('postgres://a');
    delete process.env.KICI_DATABASE_URL;
    expect(resolveDbOnlyUrl()).toBeNull();
  });

  // fails-when: the required variant returns '' instead of throwing
  it('resolveDatabaseUrl throws the documented message when unset', () => {
    expect(() => resolveDatabaseUrl()).toThrow(
      'Database URL required. Pass --database-url or set KICI_DATABASE_URL.',
    );
    process.env.KICI_DATABASE_URL = 'postgres://env';
    expect(resolveDatabaseUrl()).toBe('postgres://env');
  });
});

describe('requireDbOnlyUrl', () => {
  it('refuses naming KICI_DATABASE_URL, the only variable it reads', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    requireDbOnlyUrl(undefined);
    // fails-when: the refusal names DATABASE_URL or another variable kici-admin never reads
    expect(err).toHaveBeenCalledWith(
      'Error: --database-url or KICI_DATABASE_URL is required (direct-DB only)',
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('returns the URL from KICI_DATABASE_URL without refusing', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    process.env.KICI_DATABASE_URL = 'postgres://from-env';
    // breaks-if-wrong: the variable the message names is the one that is read
    expect(requireDbOnlyUrl(undefined)).toBe('postgres://from-env');
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('parseIntOption', () => {
  it('parses integers and passes undefined through', () => {
    expect(parseIntOption('42', '--limit')).toBe(42);
    expect(parseIntOption(undefined, '--limit')).toBeUndefined();
  });

  // fails-when: 1.5 or "abc" is accepted
  it('rejects non-integers naming the flag', () => {
    expect(() => parseIntOption('1.5', '--limit')).toThrow(
      '--limit: must be an integer (got "1.5")',
    );
    expect(() => parseIntOption('abc', '--limit')).toThrow('--limit: must be an integer');
  });
});

describe('printJsonOr', () => {
  // fails-when: --json output is pretty-printed or the renderer also runs
  it('prints one JSON line when json is set, else renders', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const render = vi.fn();
    printJsonOr(true, { a: 1 }, render);
    expect(log).toHaveBeenCalledWith('{"a":1}');
    expect(render).not.toHaveBeenCalled();
    printJsonOr(undefined, { a: 1 }, render);
    expect(render).toHaveBeenCalledWith({ a: 1 });
    expect(log).toHaveBeenCalledTimes(1);
  });
});
