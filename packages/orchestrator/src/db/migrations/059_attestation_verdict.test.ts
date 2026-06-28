import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import { down, up } from './059_attestation_verdict.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig059_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 059_attestation_verdict', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const column = async (
    table: string,
    name: string,
  ): Promise<{ data_type: string; is_nullable: string } | null> => {
    const r = await sql<{ data_type: string; is_nullable: string }>`
      SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name=${table} AND column_name=${name}`.execute(db);
    return r.rows[0] ?? null;
  };

  const indexExists = async (name: string): Promise<boolean> => {
    const r = await sql<{ exists: boolean }>`
      SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=${name}) AS exists`.execute(
      db,
    );
    return r.rows[0]?.exists ?? false;
  };

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await new Migrator({
      db,
      provider: createMigrationProvider(),
    }).migrateToLatest();
    if (error) throw error;
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
        [TEST_DB],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('adds the three verdict columns with the right shape', async () => {
    const status = await column('attestations', 'verify_status');
    expect(status?.data_type).toBe('text');
    expect(status?.is_nullable).toBe('NO');

    const reason = await column('attestations', 'verify_reason');
    expect(reason?.data_type).toBe('text');
    expect(reason?.is_nullable).toBe('YES');

    const verifiedAt = await column('attestations', 'verified_at');
    expect(verifiedAt?.data_type).toBe('timestamp with time zone');
    expect(verifiedAt?.is_nullable).toBe('YES');
  });

  it('defaults verify_status to pending and persists an explicit verdict', async () => {
    await sql`INSERT INTO public.attestations
        (id, run_id, job_id, subject_name, subject_digest, storage_key, mode, media_type)
        VALUES ('mig059-pending', 'r1', 'j1', 'pkg', 'sha256:a', 'k1', 'kici', 'application/json')`.execute(
      db,
    );
    const pending = await sql<{ verify_status: string; verify_reason: string | null }>`
      SELECT verify_status, verify_reason FROM public.attestations WHERE id='mig059-pending'`.execute(
      db,
    );
    expect(pending.rows[0]).toEqual({ verify_status: 'pending', verify_reason: null });

    await sql`INSERT INTO public.attestations
        (id, run_id, job_id, subject_name, subject_digest, storage_key, mode, media_type, verify_status, verify_reason, verified_at)
        VALUES ('mig059-verified', 'r1', 'j2', 'pkg', 'sha256:b', 'k2', 'kici', 'application/json', 'verified', NULL, NOW())`.execute(
      db,
    );
    const verified = await sql<{ verify_status: string }>`
      SELECT verify_status FROM public.attestations WHERE id='mig059-verified'`.execute(db);
    expect(verified.rows[0]?.verify_status).toBe('verified');
  });

  it('creates the lookup indexes', async () => {
    expect(await indexExists('idx_attestations_subject_digest')).toBe(true);
    expect(await indexExists('idx_attestations_subject_name')).toBe(true);
    expect(await indexExists('idx_attestations_verify_status')).toBe(true);
    expect(await indexExists('idx_attestations_created_at')).toBe(true);
  });

  it('down() drops and up() re-adds idempotently', async () => {
    await down(db);
    expect(await column('attestations', 'verify_status')).toBeNull();
    expect(await indexExists('idx_attestations_subject_digest')).toBe(false);
    await up(db);
    await up(db); // second call is a no-op
    expect(await column('attestations', 'verify_status')).not.toBeNull();
    expect(await indexExists('idx_attestations_verify_status')).toBe(true);
  });
});
