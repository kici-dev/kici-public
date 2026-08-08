/**
 * Tests for `kici-admin remote-source` CLI subcommands.
 *
 * Verifies the command registers under the expected namespace and that the
 * missing-DB-URL path fails loudly before opening a pool. Real-DB row-printing
 * is covered by the store's integration test + the E2E suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

// Lock the read-only invariant: remote-source has no mutating subcommand, so it
// never records an access-log row. The mock is never triggered because
// remote-source.ts does not import the helper — that absence is exactly what we
// assert. If a mutating remote-source subcommand is ever added, its author must
// wire the recorder and this guard turns into a positive assertion.
const mockRecordOnDb = vi.fn();
const mockRecord = vi.fn();
vi.mock('./shared/admin-cli-access-log.js', () => ({
  recordAdminCliAccessOnDb: (...a: unknown[]) => mockRecordOnDb(...a),
  recordAdminCliAccess: (...a: unknown[]) => mockRecord(...a),
}));

const { registerRemoteSourceCommands } = await import('./remote-source.js');

describe('kici-admin remote-source', () => {
  let savedUrl: string | undefined;
  let savedDatabaseUrl: string | undefined;

  beforeEach(() => {
    savedUrl = process.env.KICI_DATABASE_URL;
    savedDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.KICI_DATABASE_URL;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.KICI_DATABASE_URL;
    else process.env.KICI_DATABASE_URL = savedUrl;
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
  });

  it('registers the remote-source show subcommand', () => {
    const program = new Command();
    registerRemoteSourceCommands(program);
    const rs = program.commands.find((c) => c.name() === 'remote-source');
    expect(rs).toBeDefined();
    const show = rs!.commands.find((c) => c.name() === 'show');
    expect(show).toBeDefined();
  });

  it('errors when no database URL is configured', async () => {
    const program = new Command();
    program.exitOverride();
    registerRemoteSourceCommands(program);

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => errors.push(a.join(' '));
    const origExit = process.exit;
    let exitCode: number | null = null;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`EXIT:${code}`);
    }) as never;

    try {
      await program.parseAsync(['node', 'kici-admin', 'remote-source', 'show', 'org_abc']);
    } catch {
      // expected: process.exit override throws
    } finally {
      console.error = origError;
      process.exit = origExit;
    }

    expect(exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/Database URL required/);
  });

  it('remote-source show writes no access-log row (read-only invariant)', async () => {
    mockRecordOnDb.mockClear();
    mockRecord.mockClear();
    const program = new Command();
    program.exitOverride();
    registerRemoteSourceCommands(program);

    const origError = console.error;
    console.error = () => undefined;
    const origExit = process.exit;
    process.exit = (() => {
      throw new Error('EXIT');
    }) as never;

    try {
      // Runs with no DB URL configured (beforeEach clears both); the command
      // exits before opening a pool. Either way, no access-log row is written.
      await program.parseAsync(['node', 'kici-admin', 'remote-source', 'show', 'org_abc']);
    } catch {
      // expected: process.exit override throws
    } finally {
      console.error = origError;
      process.exit = origExit;
    }

    expect(mockRecordOnDb).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
