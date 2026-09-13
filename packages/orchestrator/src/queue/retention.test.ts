import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import {
  RETENTION_ANNOUNCE_DAYS,
  TERMINAL_HELD_RUN_STATUSES,
  allWindowsDisabled,
  announceGatePassed,
  deleteInBatches,
  pruneExpiredHistory,
  resolveRetentionWindows,
  type RetentionWindows,
} from './retention.js';

describe('allWindowsDisabled', () => {
  it('is true only when every window is 0', () => {
    expect(
      allWindowsDisabled({
        runRetentionDays: 0,
        auditRetentionDays: 0,
        provenanceRetentionDays: 0,
        heldRunRetentionDays: 0,
      }),
    ).toBe(true);
    expect(
      allWindowsDisabled({
        runRetentionDays: 0,
        auditRetentionDays: 1,
        provenanceRetentionDays: 0,
        heldRunRetentionDays: 0,
      }),
    ).toBe(false);
  });
});

describe('resolveRetentionWindows', () => {
  const defaults: RetentionWindows = {
    runRetentionDays: 90,
    auditRetentionDays: 365,
    provenanceRetentionDays: 365,
    heldRunRetentionDays: 90,
  };

  it('returns the configured defaults when no reader is wired', async () => {
    expect(await resolveRetentionWindows(defaults)).toEqual(defaults);
  });

  it('lets a live cluster value win, including a genuine 0', async () => {
    const reader = {
      getNumber: async (column: string, fallback: number) =>
        column === 'run_retention_days' ? 0 : fallback,
    };
    const resolved = await resolveRetentionWindows(defaults, reader);
    // 0 is the documented way to disable a window — a `||` read would have
    // silently restored the 90-day default here.
    expect(resolved.runRetentionDays).toBe(0);
    expect(resolved.auditRetentionDays).toBe(365);
  });
});

describe('deleteInBatches', () => {
  it('loops until a pass comes back short', async () => {
    const pages = [['a', 'b'], ['c', 'd'], ['e']];
    const deleted: string[][] = [];
    const total = await deleteInBatches(
      'demo',
      async () => pages.shift() ?? [],
      async (ids) => {
        deleted.push(ids);
      },
      2,
    );
    expect(total).toBe(5);
    expect(deleted).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('deletes nothing when the first pass is empty', async () => {
    let calls = 0;
    const total = await deleteInBatches(
      'demo',
      async () => {
        calls += 1;
        return [];
      },
      async () => {
        throw new Error('must not delete');
      },
      100,
    );
    expect(total).toBe(0);
    expect(calls).toBe(1);
  });
});

// ── real Postgres ────────────────────────────────────────────────────
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_retention_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

const NOW = new Date('2026-09-04T00:00:00Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const WINDOWS: RetentionWindows = {
  runRetentionDays: 90,
  auditRetentionDays: 365,
  provenanceRetentionDays: 365,
  heldRunRetentionDays: 90,
};

describeDb('pruneExpiredHistory (real Postgres)', () => {
  let db: Kysely<Database>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await new Migrator({
      db,
      provider: createMigrationProvider(),
    }).migrateToLatest();
    if (error) throw error;
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEST_DB],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 120_000);

  /**
   * Seed one run + one job + one step at a given age and status.
   *
   * `run_id` is a uuid column, so the caller's label is hashed into a stable
   * uuid rather than used verbatim.
   */
  const runIds = new Map<string, string>();
  function runUuid(label: string): string {
    let id = runIds.get(label);
    if (!id) {
      id = randomUUID();
      runIds.set(label, id);
    }
    return id;
  }

  async function seedRun(label: string, ageDays: number, status: string): Promise<void> {
    const at = daysAgo(ageDays);
    const runId = runUuid(label);
    await sql`
      INSERT INTO public.execution_runs
        (run_id, status, created_at, routing_key, workflow_name, provider,
         repo_identifier, ref, sha)
      VALUES (${runId}, ${status}, ${at}, 'github:1', 'ci', 'github',
              'acme/app', 'refs/heads/main', 'deadbeef')
    `.execute(db);
    await sql`
      INSERT INTO public.execution_jobs (run_id, job_id, job_name, status, created_at)
      VALUES (${runId}, ${label + '-j'}, 'build', ${status}, ${at})
    `.execute(db);
    await sql`
      INSERT INTO public.execution_steps
        (run_id, job_id, step_index, step_name, status, created_at)
      VALUES (${runId}, ${label + '-j'}, 0, 'build', ${status}, ${at})
    `.execute(db);
  }

  async function count(table: string): Promise<number> {
    const r = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM public.${sql.raw(table)}
    `.execute(db);
    return Number(r.rows[0]?.n ?? 0);
  }

  beforeEach(async () => {
    for (const t of [
      'execution_steps',
      'execution_jobs',
      'execution_runs',
      'event_log',
      'access_log',
      'held_runs',
    ]) {
      await sql`DELETE FROM public.${sql.raw(t)}`.execute(db);
    }
    await sql`
      INSERT INTO public.cluster_settings (id, retention_announced_at)
      VALUES ('default', NULL)
      ON CONFLICT (id) DO UPDATE SET retention_announced_at = NULL
    `.execute(db);
  });

  it('deletes nothing on the first pass and stamps the announce date', async () => {
    await seedRun('old-1', 200, 'success');

    const summary = await pruneExpiredHistory({
      db,
      windows: WINDOWS,
      coldStoreEnabled: false,
      now: () => NOW,
    });

    expect(summary.announcing).toBe(true);
    expect(summary.deleted).toEqual({});
    expect(summary.pending.execution_runs).toBe(1);
    expect(await count('execution_runs')).toBe(1);

    const row = await db
      .selectFrom('cluster_settings')
      .select('retention_announced_at')
      .where('id', '=', 'default')
      .executeTakeFirst();
    expect(row?.retention_announced_at).not.toBeNull();
  });

  it('deletes once the announce window has elapsed', async () => {
    await seedRun('old-1', 200, 'success');
    await seedRun('fresh-1', 3, 'success');
    await announceGatePassed(db, daysAgo(RETENTION_ANNOUNCE_DAYS + 1));

    const summary = await pruneExpiredHistory({
      db,
      windows: WINDOWS,
      coldStoreEnabled: false,
      now: () => NOW,
    });

    expect(summary.announcing).toBe(false);
    expect(summary.deleted.execution_runs).toBe(1);
    expect(summary.deleted.execution_jobs).toBe(1);
    expect(summary.deleted.execution_steps).toBe(1);
    expect(await count('execution_runs')).toBe(1); // the fresh one survives
    expect(await count('execution_steps')).toBe(1);
  });

  it('never deletes a non-terminal run, however old', async () => {
    await seedRun('running-forever', 500, 'running');
    await seedRun('held-forever', 500, 'held');
    await announceGatePassed(db, daysAgo(RETENTION_ANNOUNCE_DAYS + 1));

    await pruneExpiredHistory({ db, windows: WINDOWS, coldStoreEnabled: false, now: () => NOW });

    expect(await count('execution_runs')).toBe(2);
  });

  it('skips a run whose rerun child is still present, then takes it once the child goes', async () => {
    // `execution_runs.parent_run_id` is a self-referencing FK with no ON
    // DELETE action, so deleting the parent while the child row exists aborts
    // the statement — and with it every table the sweep prunes after runs.
    await seedRun('parent', 200, 'success');
    await seedRun('child', 3, 'success');
    await sql`
      UPDATE public.execution_runs SET parent_run_id = ${runUuid('parent')}
       WHERE run_id = ${runUuid('child')}
    `.execute(db);
    await announceGatePassed(db, daysAgo(RETENTION_ANNOUNCE_DAYS + 1));

    const first = await pruneExpiredHistory({
      db,
      windows: WINDOWS,
      coldStoreEnabled: false,
      now: () => NOW,
    });
    // The parent is held back rather than throwing, and the audit sweep that
    // runs after it still reports.
    expect(first.deleted.execution_runs ?? 0).toBe(0);
    expect(await count('execution_runs')).toBe(2);
    expect(first.deleted).toHaveProperty('access_log');

    // Once the child has aged out, the parent is eligible again.
    await sql`
      UPDATE public.execution_runs SET created_at = ${daysAgo(200)}
       WHERE run_id = ${runUuid('child')}
    `.execute(db);
    const second = await pruneExpiredHistory({
      db,
      windows: WINDOWS,
      coldStoreEnabled: false,
      now: () => NOW,
    });
    expect(second.deleted.execution_runs).toBe(1);
    const third = await pruneExpiredHistory({
      db,
      windows: WINDOWS,
      coldStoreEnabled: false,
      now: () => NOW,
    });
    expect(third.deleted.execution_runs).toBe(1);
    expect(await count('execution_runs')).toBe(0);
  });

  it('leaves the cold store its tables when the cold store is on', async () => {
    await seedRun('old-1', 200, 'success');
    await announceGatePassed(db, daysAgo(RETENTION_ANNOUNCE_DAYS + 1));

    const summary = await pruneExpiredHistory({
      db,
      windows: WINDOWS,
      coldStoreEnabled: true,
      now: () => NOW,
    });

    expect(summary.deleted.execution_runs).toBeUndefined();
    expect(await count('execution_runs')).toBe(1);
    // The tables no archiver registers are still swept.
    expect(summary.deleted).toHaveProperty('attestations');
    expect(summary.deleted).toHaveProperty('held_runs');
  });

  it('does nothing at all when every window is disabled', async () => {
    await seedRun('old-1', 500, 'success');

    const summary = await pruneExpiredHistory({
      db,
      windows: {
        runRetentionDays: 0,
        auditRetentionDays: 0,
        provenanceRetentionDays: 0,
        heldRunRetentionDays: 0,
      },
      coldStoreEnabled: false,
      now: () => NOW,
    });

    expect(summary).toEqual({ deleted: {}, pending: {}, announcing: false });
    expect(await count('execution_runs')).toBe(1);
  });

  it('prunes audit rows on each side of the cutoff', async () => {
    await sql`
      INSERT INTO public.access_log
        (actor_id, actor_type, action, source, outcome, created_at)
      VALUES ('a', 'system', 'x', 'test', 'success', ${daysAgo(400)}),
             ('b', 'system', 'x', 'test', 'success', ${daysAgo(10)})
    `.execute(db);
    await announceGatePassed(db, daysAgo(RETENTION_ANNOUNCE_DAYS + 1));

    const summary = await pruneExpiredHistory({
      db,
      windows: WINDOWS,
      coldStoreEnabled: false,
      now: () => NOW,
    });

    expect(summary.deleted.access_log).toBe(1);
    expect(await count('access_log')).toBe(1);
  });

  it('keeps a pending held run and prunes a terminal one', async () => {
    const pendingId = randomUUID();
    const approvedId = randomUUID();
    for (const [id, status] of [
      [pendingId, 'pending'],
      [approvedId, TERMINAL_HELD_RUN_STATUSES[0]!],
    ] as const) {
      await sql`
        INSERT INTO public.held_runs
          (org_id, run_id, job_id, status, created_at, expires_at, hold_type)
        VALUES ('o', ${id}, ${id + '-j'}, ${status}, ${daysAgo(200)}, ${daysAgo(100)},
                'manual')
      `.execute(db);
    }
    await announceGatePassed(db, daysAgo(RETENTION_ANNOUNCE_DAYS + 1));

    const summary = await pruneExpiredHistory({
      db,
      windows: WINDOWS,
      coldStoreEnabled: false,
      now: () => NOW,
    });

    expect(summary.deleted.held_runs).toBe(1);
    const remaining = await db.selectFrom('held_runs').select('run_id').execute();
    expect(remaining.map((r) => r.run_id)).toEqual([pendingId]);
  });

  it('batches, so a run set larger than one batch still clears', async () => {
    for (let i = 0; i < 5; i++) await seedRun(`bulk-${i}`, 200, 'success');
    await announceGatePassed(db, daysAgo(RETENTION_ANNOUNCE_DAYS + 1));

    const summary = await pruneExpiredHistory({
      db,
      windows: WINDOWS,
      coldStoreEnabled: false,
      now: () => NOW,
      batchSize: 2,
    });

    expect(summary.deleted.execution_runs).toBe(5);
    expect(await count('execution_runs')).toBe(0);
    expect(await count('execution_steps')).toBe(0);
  });
});
