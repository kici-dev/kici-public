import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import { down, up } from './037_generic_sources_provider_type_local.js';

/**
 * Real-Postgres test for migration 037.
 *
 * Creates a throwaway database, runs every migration up to latest via the
 * production provider, and asserts the provider_type CHECK constraint now
 * permits 'local' and rejects 'internal'. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig037_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

/**
 * Minimal valid generic_webhook_sources row for a given provider_type.
 *
 * `id` is a uuid column, so callers pass a logical `tag` used to build a stable
 * deterministic UUID (and the routing_key / name), keeping rows addressable by
 * tag without inserting an invalid uuid literal.
 */
function tagToUuid(tag: string): string {
  // Deterministic v4-shaped uuid from the tag — pad/truncate the tag's hex.
  const hex = Buffer.from(tag).toString('hex').padEnd(32, '0').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function insertSource(
  db: Kysely<unknown>,
  tag: string,
  providerType: string,
  gitConfig: string | null,
): Promise<void> {
  const id = tagToUuid(tag);
  await sql`
    INSERT INTO public.generic_webhook_sources
      (id, customer_id, name, routing_key, verification_method, verification_config,
       strip_headers, provider_type, git_config)
    VALUES (${id}, 'org-037', ${`src-${tag}`}, ${`generic:org-037:${tag}`}, 'none', '{}',
            '[]', ${providerType}, ${gitConfig})
  `.execute(db);
}

/** SELECT a source's provider_type by its logical tag (via the deterministic uuid). */
async function providerTypeByTag(db: Kysely<unknown>, tag: string): Promise<string | undefined> {
  const rows = await sql<{ provider_type: string }>`
    SELECT provider_type FROM public.generic_webhook_sources WHERE id = ${tagToUuid(tag)}
  `.execute(db);
  return rows.rows[0]?.provider_type;
}

describeDb('migration 037_generic_sources_provider_type_local', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }

    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });

    const migrator = new Migrator({ db, provider: createMigrationProvider() });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error;
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});

    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEST_DB],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  it("permits provider_type='local'", async () => {
    await insertSource(db, 'local-ok', 'local', JSON.stringify({ repoBasePath: '/srv/repo' }));
    expect(await providerTypeByTag(db, 'local-ok')).toBe('local');
  });

  it("permits provider_type='generic'", async () => {
    await insertSource(db, 'generic-ok', 'generic', null);
    expect(await providerTypeByTag(db, 'generic-ok')).toBe('generic');
  });

  it("rejects the retired provider_type='internal'", async () => {
    await expect(insertSource(db, 'internal-bad', 'internal', null)).rejects.toThrow(
      /provider_type_check/,
    );
  });

  it("up() migrates carried-over 'internal' rows to 'local' (down/up round-trip)", async () => {
    // down() restores the old constraint + flips local→internal, letting us seed
    // an 'internal' row the way a pre-rename deploy would have.
    await down(db);
    await insertSource(
      db,
      'carryover',
      'internal',
      JSON.stringify({ repoBasePath: '/srv/carryover' }),
    );
    // up() backfills internal→local before swapping the constraint.
    await up(db);
    await up(db); // idempotent
    expect(await providerTypeByTag(db, 'carryover')).toBe('local');
  });
});
