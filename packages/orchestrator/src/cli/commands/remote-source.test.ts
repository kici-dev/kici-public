/**
 * Tests for `kici-admin remote-source` CLI subcommands.
 *
 * Verifies the command registers under the expected namespace and that the
 * missing-DB-URL path fails loudly before opening a pool. Real-DB row-printing
 * is covered by the store's integration test + the E2E suite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerRemoteSourceCommands } from './remote-source.js';

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
});
