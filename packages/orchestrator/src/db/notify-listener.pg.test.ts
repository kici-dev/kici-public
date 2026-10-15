import { afterAll, beforeAll, expect, it } from 'vitest';
import pg from 'pg';
import { createPool } from './client.js';
import { NotifyListener } from './notify-listener.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';

const CHANNEL = 'notify_listener_drill';

/** Wait for `predicate`, polling, up to `timeoutMs`. */
async function until(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Real-Postgres proof that a LISTEN subscription survives losing its backend. Only a live
// server exercises pg's actual error and release semantics (notify-listener.test.ts uses a
// fake client); in production a Patroni switchover terminates these idle backends.
// Gated on KICI_TEST_ADMIN_DATABASE_URL.
describeWithTestDb(
  'NotifyListener reconnect (real Postgres)',
  { prefix: 'kici_notify_listener_test' },
  (getDb) => {
    let url: string;
    let pool: pg.Pool;

    beforeAll(() => {
      ({ url } = getDb());
      pool = createPool(url, { config: { max: 4 } });
    });

    afterAll(async () => {
      await pool?.end();
    });

    it('re-listens after pg_terminate_backend and fires onReconnect exactly once', async () => {
      const received: string[] = [];
      let reconnects = 0;

      const listener = new NotifyListener({
        pool,
        channel: CHANNEL,
        onNotification: (msg) => received.push(msg.payload ?? ''),
        onReconnect: () => {
          reconnects += 1;
        },
        baseBackoffMs: 100,
      });
      await listener.start();

      // Baseline: the subscription works before anything is killed.
      const notifier = new pg.Pool({ connectionString: url });
      try {
        await notifier.query(`NOTIFY ${CHANNEL}, 'before'`);
        await until(() => received.includes('before'));

        // The switchover-shaped kill: terminate every backend but our own
        // notifier, which is what takes an idle LISTEN session down.
        await notifier.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [getDb().name],
        );

        await until(() => listener.connected && reconnects === 1);

        // The real assertion: a NOTIFY sent after the kill is delivered.
        await notifier.query(`NOTIFY ${CHANNEL}, 'after'`);
        await until(() => received.includes('after'));

        expect(reconnects).toBe(1);
      } finally {
        await notifier.end();
        await listener.stop();
      }
    }, 60_000);
  },
);
