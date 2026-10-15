import { beforeAll, expect, it } from 'vitest';
import { createPool } from './client.js';
import { createMigrationPool } from './migrator.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';

// Real-Postgres proof that `statement_timeout: 0` reaches the connections a
// migration runs on; migrator.test.ts only checks the pool config. Gated on
// KICI_TEST_ADMIN_DATABASE_URL.
describeWithTestDb(
  'migration pool statement timeout (real Postgres)',
  { prefix: 'kici_migration_pool_test' },
  (getDb) => {
    let url: string;

    beforeAll(() => {
      ({ url } = getDb());
    });

    it('cancels a long statement on a hot-path pool', async () => {
      const hot = createPool(url, { config: { max: 1, statement_timeout: 1000 } });
      try {
        await expect(hot.query('SELECT pg_sleep(3)')).rejects.toThrow(/statement timeout/i);
      } finally {
        await hot.end();
      }
    }, 30_000);

    it('lets the same statement finish on the migration pool', async () => {
      const migration = createMigrationPool(url);
      try {
        const setting = await migration.query<{ statement_timeout: string }>(
          'SHOW statement_timeout',
        );
        expect(setting.rows[0]?.statement_timeout).toBe('0');

        const res = await migration.query('SELECT pg_sleep(3)');
        expect(res.rowCount).toBe(1);
      } finally {
        await migration.end();
      }
    }, 30_000);
  },
);
