import { beforeAll, expect, it } from 'vitest';
import { type Kysely, sql } from 'kysely';
import { migrateToOwnMigration, migrateToPreviousMigration } from '../migration-test-harness.js';
import { down, up } from './162_sources_github_url.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';

/**
 * Real-Postgres test for migration 162. Seeds source rows BEFORE the migration,
 * the way an upgraded database carries them, then asserts the new column is
 * NULL for every row and no `config` changed. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
describeWithTestDb<unknown>(
  'migration 162_sources_github_url',
  { prefix: 'kici_mig162_test' },
  (getDb) => {
    let db: Kysely<unknown>;
    let configBefore: Array<{ routing_key: string; config: string }>;

    const rows = async () =>
      (
        await sql<{ routing_key: string; config: string; github_url: string | null }>`
          SELECT routing_key, config::text AS config, github_url
            FROM public.sources ORDER BY routing_key
        `.execute(db)
      ).rows;

    beforeAll(async () => {
      db = getDb().db;
      const before = await migrateToPreviousMigration(db, import.meta.url);
      if (before.error) throw before.error;
      // A row carrying `config.githubUrl`, the way an earlier peer's generic
      // config update could leave one.
      await sql`
        INSERT INTO public.sources (provider, name, routing_key, config) VALUES
          ('github', 'planted', 'github:1621', ${JSON.stringify({ appId: '1621', githubUrl: 'https://ghe.corp.example' })}::jsonb),
          ('github', 'plain', 'github:1622', ${JSON.stringify({ appId: '1622' })}::jsonb)
      `.execute(db);
      configBefore = (
        await sql<{ routing_key: string; config: string }>`
          SELECT routing_key, config::text AS config FROM public.sources ORDER BY routing_key
        `.execute(db)
      ).rows;
      const after = await migrateToOwnMigration(db, import.meta.url);
      if (after.error) throw after.error;
    }, 60_000);

    it('adds a nullable github_url and copies nothing from config', async () => {
      // fails-when: the migration copies config.githubUrl into the column, so a
      //   value a scoped token stored becomes the App's server
      expect((await rows()).map((r) => [r.routing_key, r.github_url])).toEqual([
        ['github:1621', null],
        ['github:1622', null],
      ]);
      // breaks-if-wrong: the upgrade must not rewrite any source's config
      expect((await rows()).map(({ routing_key, config }) => ({ routing_key, config }))).toEqual(
        configBefore,
      );
    });

    it('is idempotent', async () => {
      await up(db);
      expect((await rows()).every((r) => r.github_url === null)).toBe(true);
    });

    it('down drops the column', async () => {
      await down(db);
      const columns = await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'sources' AND column_name = 'github_url'
      `.execute(db);
      expect(columns.rows).toEqual([]);
      await up(db);
    });
  },
);
