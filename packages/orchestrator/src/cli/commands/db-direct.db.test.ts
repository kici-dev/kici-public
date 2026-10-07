/**
 * `kici-admin db migrate --database-url` against a real PostgreSQL database.
 * Nothing here is mocked: the command runs in-process end to end.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { sql } from 'kysely';
import { registerDbCommands } from './db.js';
import { createMigrationProvider } from '../../db/migration-provider.js';
import { ledgerNames, scratchDbFactory } from '../../__test-helpers__/scratch-db.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;

async function runDb(
  args: string[],
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    stdout += a.join(' ') + '\n';
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    stderr += a.join(' ') + '\n';
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`EXIT:${code}`);
  }) as never);
  const program = new Command();
  registerDbCommands(program, () => {
    throw new Error('the direct form never reaches the HTTP client');
  });
  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (err) {
    if (!String((err as Error).message).startsWith('EXIT:')) throw err;
  }
  return { exitCode, stdout, stderr };
}

describeDb('kici-admin db migrate --database-url', () => {
  const dbs = scratchDbFactory(ADMIN_URL ?? '');
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => dbs.cleanup(), 120_000);

  // fails-when: --database-url still routes over HTTP (the client factory throws),
  // or the run writes no db.migrate access-log row
  it('migrates an empty database directly and records the access-log row', async () => {
    const h = await dbs.freshDb('migrate');
    const expected = Object.keys(await createMigrationProvider().getMigrations()).sort();
    const out = await runDb(['db', 'migrate', '--database-url', h.url]);
    expect(out.exitCode).toBeNull();
    expect(out.stdout).toContain(`Applied ${expected.length} migration(s).`);
    expect(await ledgerNames(h.db)).toEqual(expected);
    const audit = await sql<{ action: string }>`
      SELECT action FROM access_log WHERE action = 'db.migrate'`.execute(h.db);
    expect(audit.rows).toHaveLength(1);
    const again = await runDb(['db', 'migrate', '--database-url', h.url]);
    expect(again.stdout).toContain('Database schema is up to date.');
  }, 180_000);

  it('db migrate refuses --database-url combined with --to', async () => {
    const out = await runDb([
      'db',
      'migrate',
      '--database-url',
      'postgresql://u:p@127.0.0.1:1/none',
      '--to',
      '001_initial',
    ]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toMatch(/--database-url cannot be combined with --to or --status/);
  });
});
