import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { createHealthRoutes } from './health.js';

// A minimal Kysely stub whose `selectFrom(...).select(...).limit(...).execute()`
// resolves, so the readiness DB check passes and we isolate the warm bit.
function stubDbOk(): Kysely<Database> {
  const chain = {
    select: () => chain,
    limit: () => chain,
    execute: async () => [],
  };
  return { selectFrom: () => chain } as unknown as Kysely<Database>;
}

describe('orchestrator health routes — /ready warm gate', () => {
  it('returns 503 with checks.warm === false when isWarm() is false (DB ok)', async () => {
    const app = createHealthRoutes({ db: stubDbOk(), isWarm: () => false });
    const res = await app.request('/ready');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; checks: Record<string, boolean> };
    expect(body.checks.warm).toBe(false);
    expect(body.checks.database).toBe(true);
    expect(body.status).toBe('not ready');
  });

  it('returns 200 with checks.warm === true when isWarm() is true and DB check passes', async () => {
    const app = createHealthRoutes({ db: stubDbOk(), isWarm: () => true });
    const res = await app.request('/ready');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; checks: Record<string, boolean> };
    expect(body.checks.warm).toBe(true);
    expect(body.checks.database).toBe(true);
    expect(body.status).toBe('ready');
  });

  it('defaults warm to true when isWarm is omitted (unchanged behavior for callers without the latch)', async () => {
    const app = createHealthRoutes({ db: stubDbOk() });
    const res = await app.request('/ready');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checks: Record<string, boolean> };
    expect(body.checks.warm).toBe(true);
    expect(body.checks.database).toBe(true);
  });
});

/** A Kysely stub whose readiness query runs the given results in order, then succeeds. */
function stubDbSequence(failures: Error[]): { db: Kysely<Database>; calls: () => number } {
  let calls = 0;
  const chain = {
    select: () => chain,
    limit: () => chain,
    execute: async () => {
      const failure = failures[calls++];
      if (failure) throw failure;
      return [];
    },
  };
  return { db: { selectFrom: () => chain } as unknown as Kysely<Database>, calls: () => calls };
}

describe('orchestrator health routes — /ready after a switchover', () => {
  it('stays 200 when the first pooled connection was killed by the switchover', async () => {
    // fails-when: the readiness query is not retried — the dead connection reads as an outage (503).
    const { db, calls } = stubDbSequence([new Error('Connection terminated unexpectedly')]);
    const res = await createHealthRoutes({ db }).request('/ready');
    expect(res.status).toBe(200);
    expect(calls()).toBe(2);
  });

  it('still reports 503 on a real outage, without asking again', async () => {
    // breaks-if-wrong: an unreachable database must still fail readiness.
    const outage = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    const { db, calls } = stubDbSequence([outage, outage, outage]);
    const res = await createHealthRoutes({ db }).request('/ready');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { checks: Record<string, boolean> };
    expect(body.checks.database).toBe(false);
    expect(calls()).toBe(1);
  });
});

describe('orchestrator health routes — /health build identity', () => {
  const GLOBALS = { KICI_PKG_VERSION: '9.8.7', KICI_BUILD_COMMIT: 'c0ffee123' } as const;

  beforeEach(() => {
    for (const [key, value] of Object.entries(GLOBALS)) {
      (globalThis as Record<string, unknown>)[key] = value;
    }
  });

  afterEach(() => {
    for (const key of Object.keys(GLOBALS)) delete (globalThis as Record<string, unknown>)[key];
  });

  it('carries version and no buildCommit', async () => {
    // fails-when: buildCommit is still emitted, or a baked build commit leaks into the body.
    // breaks-if-wrong: version must still be reported.
    const res = await createHealthRoutes({ db: stubDbOk() }).request('/health');
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;

    expect(body.version).toBe(GLOBALS.KICI_PKG_VERSION);
    expect(body).not.toHaveProperty('buildCommit');
    expect(text).not.toContain(GLOBALS.KICI_BUILD_COMMIT);
  });
});
