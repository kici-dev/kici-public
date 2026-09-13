import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPool } from './client.js';
import { NotifyListener } from './notify-listener.js';

// Real-Postgres proof that a LISTEN subscription survives losing its backend.
// The mocked suite in notify-listener.test.ts drives the reconnect through a
// fake client; only a live server proves the shape against pg's actual error
// and release semantics — which is the whole failure mode, since a Patroni
// switchover is what terminates these idle backends in production.
// Gated on KICI_TEST_ADMIN_DATABASE_URL.
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_notify_listener_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

const CHANNEL = 'notify_listener_drill';

/** Wait for `predicate`, polling, up to `timeoutMs`. */
async function until(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describeDb('NotifyListener reconnect (real Postgres)', () => {
  const adminUrl = ADMIN_URL!;
  let url: string;
  let pool: pg.Pool;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
    url = withDatabase(adminUrl, TEST_DB);
    pool = createPool(url, { config: { max: 4 } });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }, 60_000);

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
        [TEST_DB],
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
});
