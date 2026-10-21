import { afterEach, beforeAll, expect, it } from 'vitest';
import { type Kysely, sql } from 'kysely';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { hasOtherLiveInstance } from './instance-heartbeat.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import { insertClusterHeartbeat } from '../__test-helpers__/cluster-heartbeat.js';

const MINUTE = 60_000;
const GRACE_MS = 2 * MINUTE;

describeWithTestDb<Database>(
  'hasOtherLiveInstance (real Postgres)',
  {
    prefix: 'kici_other_live_instance_test',
    provider: createMigrationProvider(),
    timeoutMs: 120_000,
  },
  (getDb) => {
    let db: Kysely<Database>;

    const heartbeat = (instanceId: string, minutesAgo: number): Promise<void> =>
      insertClusterHeartbeat(db, instanceId, minutesAgo);

    beforeAll(() => {
      ({ db } = getDb());
    });

    afterEach(async () => {
      await sql`DELETE FROM cluster_instances`.execute(db);
    });

    it('is false with only this instance', async () => {
      await heartbeat('self', 0);
      expect(await hasOtherLiveInstance(db, 'self', GRACE_MS)).toBe(false);
    });

    // fails-when: the query counts this instance's own row, or ignores siblings —
    // the dispatch gate would then refuse runs a sibling's agents could serve
    it('is true with a fresh sibling heartbeat', async () => {
      await heartbeat('self', 0);
      await heartbeat('sibling', 0);
      expect(await hasOtherLiveInstance(db, 'self', GRACE_MS)).toBe(true);
    });

    it('is false with a sibling past the grace', async () => {
      await heartbeat('self', 0);
      await heartbeat('sibling', 10);
      expect(await hasOtherLiveInstance(db, 'self', GRACE_MS)).toBe(false);
    });
  },
);
