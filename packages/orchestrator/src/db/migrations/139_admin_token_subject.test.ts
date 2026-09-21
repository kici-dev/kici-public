import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './139_admin_token_subject.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';

/**
 * Real-Postgres test for migration 139: asserts `subject` exists on
 * `admin_tokens` as a nullable text column with no default, that up/down are
 * idempotent, and that the migration backfills nothing.
 *
 * The absence of a backfill is the load-bearing part. NULL is the `unlinked`
 * finding the RBAC drift report exists to surface — a token nobody can attach
 * to a person. Every token minted before this column existed genuinely has no
 * recorded holder, so filling one in would hide the exact condition an
 * operator needs to see.
 *
 * Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig139_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 139_admin_token_subject', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnState = async (): Promise<{
    exists: boolean;
    nullable: boolean;
    dataType: string;
    columnDefault: string | null;
  }> => {
    const r = await sql<{ is_nullable: string; data_type: string; column_default: string | null }>`
      SELECT is_nullable, data_type, column_default FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'admin_tokens'
         AND column_name = 'subject'
    `.execute(db);
    const row = r.rows[0];
    return {
      exists: row !== undefined,
      nullable: row?.is_nullable === 'YES',
      dataType: row?.data_type ?? '',
      columnDefault: row?.column_default ?? null,
    };
  };

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    await adminPool.end();
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await migrateToOwnMigration(db, import.meta.url);
    if (error) throw error;
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await terminateTestDbBackends(adminPool, TEST_DB);
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  it('adds subject as a nullable text column with no default', async () => {
    const state = await columnState();
    expect(state.exists).toBe(true);
    expect(state.dataType).toBe('text');
    expect(state.nullable).toBe(true);
    expect(state.columnDefault).toBeNull();
  });

  it('leaves a token minted without a subject NULL rather than inventing a holder', async () => {
    await sql`
      INSERT INTO public.admin_tokens (token_hash, label, role)
      VALUES ('mig139-hash-unlinked', 'mig139-unlinked', 'admin')
    `.execute(db);
    const r = await sql<{ subject: string | null }>`
      SELECT subject FROM public.admin_tokens WHERE label = 'mig139-unlinked'
    `.execute(db);
    expect(r.rows[0]?.subject).toBeNull();
  });

  it('stores a recorded holder alongside the role and routing-key scope', async () => {
    await sql`
      INSERT INTO public.admin_tokens (token_hash, label, role, routing_key, subject)
      VALUES ('mig139-hash-linked', 'mig139-linked', 'admin', 'github:42', 'alice@example.test')
    `.execute(db);
    const r = await sql<{ subject: string | null; routing_key: string | null; role: string }>`
      SELECT subject, routing_key, role FROM public.admin_tokens WHERE label = 'mig139-linked'
    `.execute(db);
    expect(r.rows[0]?.subject).toBe('alice@example.test');
    expect(r.rows[0]?.routing_key).toBe('github:42');
    expect(r.rows[0]?.role).toBe('admin');
  });

  it('down() drops the column and up() restores it, idempotently', async () => {
    await down(db);
    expect((await columnState()).exists).toBe(false);

    await up(db);
    await up(db); // idempotent
    expect((await columnState()).exists).toBe(true);
  });
});
