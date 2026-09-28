import { Kysely, PostgresDialect, sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { closeDatabase } from './db.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface FakeClient {
  processID: number;
  query: () => Promise<{ rows: never[]; command: string; rowCount: number }>;
  release: () => void;
}

/**
 * The slice of pg.Pool that Kysely's PostgresDriver and closeDatabase use,
 * with pg-pool 3's bookkeeping. An acquire while a client is idle is queued
 * and served on the next tick; with no idle client and room left, a new client
 * connects after `acquireMs`; at `max` clients an acquire queues until a
 * client is released. A released client goes idle and serves the queue first.
 * totalCount holds connecting, checked-out and idle clients. end() drops the
 * idle clients, answers no queued acquire, and resolves once every client
 * handed out has come back.
 */
function fakePool(opts: { acquireMs?: number; max?: number } = {}) {
  const acquireMs = opts.acquireMs ?? 20;
  const max = opts.max ?? 10;
  const idle: FakeClient[] = [];
  const waiters: Array<(client: FakeClient) => void> = [];
  let connecting = 0;
  let checkedOut = 0;
  let nextId = 1;
  let ending = false;
  let ended: (() => void) | null = null;
  const total = () => connecting + checkedOut + idle.length;
  const settle = () => {
    if (ending && connecting + checkedOut === 0) ended?.();
  };
  const newClient = (): FakeClient => ({
    processID: nextId++,
    query: async () => ({ rows: [], command: 'SELECT', rowCount: 0 }),
    release() {
      checkedOut--;
      if (!ending) idle.push(this);
      pulse();
    },
  });
  const connectNew = (resolve: (client: FakeClient) => void) => {
    connecting++;
    setTimeout(() => {
      connecting--;
      checkedOut++;
      resolve(newClient());
    }, acquireMs);
  };
  // pg-pool's _pulseQueue: serve one queued acquire from an idle client, or
  // with a new client while there is room.
  const pulse = () => {
    if (ending) {
      idle.length = 0;
      settle();
      return;
    }
    const waiter =
      waiters.length > 0 && (idle.length > 0 || total() < max) ? waiters.shift() : undefined;
    if (!waiter) return;
    const reused = idle.pop();
    if (reused) {
      checkedOut++;
      waiter(reused);
      return;
    }
    connectNew(waiter);
  };
  const pool = {
    Client: class {},
    options: {},
    get idleCount() {
      return idle.length;
    },
    get waitingCount() {
      return waiters.length;
    },
    get totalCount() {
      return total();
    },
    on: () => pool,
    connect: () =>
      new Promise<FakeClient>((resolve) => {
        if (idle.length > 0 || total() >= max) {
          if (idle.length > 0) process.nextTick(pulse);
          waiters.push(resolve);
          return;
        }
        connectNew(resolve);
      }),
    end: () =>
      new Promise<void>((resolve) => {
        ending = true;
        ended = resolve;
        pulse();
      }),
    /** Drop the idle clients, as pg-pool does once their idle timeout passes. */
    expireIdle: () => {
      idle.length = 0;
    },
    /** A client that is taken and never given back: a stuck query. */
    leakOne: () => {
      checkedOut++;
    },
  };
  return pool;
}

function dbOver(pool: ReturnType<typeof fakePool>) {
  return new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({ pool: pool as never }),
  });
}

describe('closeDatabase', () => {
  // Positive control: the defect this guards. A plain destroy() while a new
  // connection is still being acquired leaks that client and never finishes.
  it('a raw destroy() during an acquire never finishes', async () => {
    const pool = fakePool();
    const db = dbOver(pool);
    await sql`select 1`.execute(db);
    // With no idle client left, the next query connects a new one.
    pool.expireIdle();
    const query = sql`select 1`.execute(db).catch((err: unknown) => err);
    const outcome = await Promise.race([
      db.destroy().then(() => 'destroyed'),
      sleep(500).then(() => 'hung'),
    ]);
    expect(outcome).toBe('hung');
    expect(await query).toBeInstanceOf(TypeError);
  });

  // fails-when: the close destroys the database while a new connection for a
  // query is still being made.
  it('lets an acquire that is still connecting finish, then closes', async () => {
    const pool = fakePool();
    const db = dbOver(pool);
    await sql`select 1`.execute(db);
    pool.expireIdle();
    const query = sql`select 1`.execute(db);
    const result = await closeDatabase(db, pool as never, { drainTimeoutMs: 2_000 });
    await expect(query).resolves.toBeDefined();
    expect(result.busyAtDeadline).toBe(0);
  });

  // breaks-if-wrong: several queries in flight, on an idle client and on new
  // ones, all finish before the close.
  it('lets in-flight acquires finish, then closes', async () => {
    const pool = fakePool();
    const db = dbOver(pool);
    await sql`select 1`.execute(db);
    const first = sql`select 1`.execute(db);
    const second = sql`select 1`.execute(db);
    const result = await closeDatabase(db, pool as never, { drainTimeoutMs: 2_000 });
    await expect(first).resolves.toBeDefined();
    await expect(second).resolves.toBeDefined();
    expect(result.busyAtDeadline).toBe(0);
  });

  // breaks-if-wrong: an acquire queued behind a full pool is served before the close.
  it('lets an acquire queued at the pool limit finish, then closes', async () => {
    const pool = fakePool({ max: 1 });
    const db = dbOver(pool);
    await sql`select 1`.execute(db);
    const first = sql`select 1`.execute(db);
    const second = sql`select 1`.execute(db);
    const result = await closeDatabase(db, pool as never, { drainTimeoutMs: 2_000 });
    await expect(first).resolves.toBeDefined();
    await expect(second).resolves.toBeDefined();
    expect(result.busyAtDeadline).toBe(0);
  });

  // fails-when: an acquire queued for an idle client is not counted as busy, so
  // the close ends the pool before the queue is served and the query never
  // settles. The shutdown runs its close inside a promise continuation, where
  // the pool's next-tick hand-off comes after the whole destroy chain.
  it('lets an acquire queued for an idle client finish, then closes', async () => {
    const pool = fakePool();
    const db = dbOver(pool);
    await sql`select 1`.execute(db);
    let query!: Promise<unknown>;
    let closing!: Promise<unknown>;
    await Promise.resolve().then(() => {
      query = sql`select 1`.execute(db);
      // Control: the acquire waits in the queue while its client is still idle.
      expect(pool.waitingCount).toBe(1);
      expect(pool.idleCount).toBe(1);
      closing = closeDatabase(db, pool as never, { drainTimeoutMs: 2_000 });
    });
    const outcome = await Promise.race([
      query.then(() => 'resolved'),
      sleep(1_000).then(() => 'never settled'),
    ]);
    expect(outcome).toBe('resolved');
    await expect(closing).resolves.toEqual({ busyAtDeadline: 0 });
  });

  // fails-when: an acquire that starts after the close began reaches the pool.
  it('refuses an acquire that starts after the close began', async () => {
    const pool = fakePool();
    const db = dbOver(pool);
    await sql`select 1`.execute(db);
    const closing = closeDatabase(db, pool as never, { drainTimeoutMs: 2_000 });
    await expect(sql`select 1`.execute(db)).rejects.toThrow(/database is closing|destroyed/);
    await expect(closing).resolves.toEqual({ busyAtDeadline: 0 });
  });

  // breaks-if-wrong: a stuck query must not hold the shutdown past the drain window.
  it('returns within the drain window when a client is never released', async () => {
    const pool = fakePool();
    const db = dbOver(pool);
    await sql`select 1`.execute(db);
    pool.leakOne();
    const started = Date.now();
    const result = await closeDatabase(db, pool as never, { drainTimeoutMs: 200 });
    expect(result.busyAtDeadline).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  // fails-when: an idle pooled client is counted as busy, so every close waits
  // out the whole drain window.
  it('closes a database with only idle clients at once', async () => {
    const pool = fakePool();
    const db = dbOver(pool);
    await Promise.all([sql`select 1`.execute(db), sql`select 1`.execute(db)]);
    // Control: the pool holds idle clients, as a real one does between queries.
    expect(pool.idleCount).toBe(2);
    expect(pool.totalCount).toBe(2);
    const started = Date.now();
    await expect(closeDatabase(db, pool as never)).resolves.toEqual({ busyAtDeadline: 0 });
    expect(Date.now() - started).toBeLessThan(500);
  });
});
