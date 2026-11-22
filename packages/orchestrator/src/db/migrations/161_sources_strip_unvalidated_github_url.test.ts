import { beforeAll, expect, it } from 'vitest';
import { type Kysely, sql } from 'kysely';
import { migrateToOwnMigration, migrateToPreviousMigration } from '../migration-test-harness.js';
import { down, up } from './161_sources_strip_unvalidated_github_url.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';

/**
 * Real-Postgres test for migration 161. Seeds source rows BEFORE the migration,
 * the way an upgraded database carries them: one with a planted `githubUrl`,
 * one without. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
describeWithTestDb<unknown>(
  'migration 161_sources_strip_unvalidated_github_url',
  { prefix: 'kici_mig161_test' },
  (getDb) => {
    let db: Kysely<unknown>;
    let siblingBefore: { config: string; updated_at: string };

    const configText = async (routingKey: string) =>
      (
        await sql<{ config: string; updated_at: string }>`
          SELECT config::text AS config, updated_at::text AS updated_at
            FROM public.sources WHERE routing_key = ${routingKey}
        `.execute(db)
      ).rows[0]!;

    beforeAll(async () => {
      db = getDb().db;
      const before = await migrateToPreviousMigration(db, import.meta.url);
      if (before.error) throw before.error;
      await sql`
        INSERT INTO public.sources (provider, name, routing_key, config) VALUES
          ('github', 'planted', 'github:161', ${JSON.stringify({ appId: '161', githubUrl: 'https://evil.example', label: 'x' })}::jsonb),
          ('github', 'sibling', 'github:162', ${JSON.stringify({ appId: '162', nested: { a: [1, 2] } })}::jsonb)
      `.execute(db);
      siblingBefore = await configText('github:162');
      const after = await migrateToOwnMigration(db, import.meta.url);
      if (after.error) throw after.error;
    }, 60_000);

    it('removes a planted githubUrl and keeps the other keys', async () => {
      // fails-when: an unvalidated server value stays stored after the upgrade
      expect(JSON.parse((await configText('github:161')).config)).toEqual({
        appId: '161',
        label: 'x',
      });
    });

    it('leaves a row without githubUrl byte-identical', async () => {
      // breaks-if-wrong: the upgrade must not rewrite a source that carries no server
      expect(await configText('github:162')).toEqual(siblingBefore);
    });

    it('is idempotent', async () => {
      await up(db);
      expect(JSON.parse((await configText('github:161')).config)).toEqual({
        appId: '161',
        label: 'x',
      });
      expect(await configText('github:162')).toEqual(siblingBefore);
    });

    it('down is a no-op: the removed server stays removed', async () => {
      await down();
      // breaks-if-wrong: a down that restored the value would restore the redirect
      expect(JSON.parse((await configText('github:161')).config)).not.toHaveProperty('githubUrl');
    });
  },
);
