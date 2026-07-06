import { describe, expect, it } from 'vitest';
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
