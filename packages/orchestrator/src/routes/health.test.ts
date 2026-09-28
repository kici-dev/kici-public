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

  it('reports the release version in the deprecated buildCommit field, never a build commit', async () => {
    // fails-when: the route reads a baked build commit — the private repository's
    // commit ID then reaches every customer who reads /health.
    // breaks-if-wrong: the deprecated key stays present, as a string, for a
    // reader that still expects it.
    const res = await createHealthRoutes({ db: stubDbOk() }).request('/health');
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;

    expect(body.version).toBe(GLOBALS.KICI_PKG_VERSION);
    expect(body.buildCommit).toBe(GLOBALS.KICI_PKG_VERSION);
    expect(text).not.toContain(GLOBALS.KICI_BUILD_COMMIT);
  });
});
