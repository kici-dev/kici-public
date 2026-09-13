/**
 * Database-side retention for the tables that scale with run volume.
 *
 * The cold store is the other half of this: its archivers do
 * archive-then-delete inside one transaction and own the four tables they
 * register. But the cold store needs `KICI_COLD_STORE_ENABLED=true` and a
 * bucket, and with neither — the default, and the quickstart path — nothing
 * aged at all, so `execution_steps`, `event_log` and `access_log` grew without
 * bound on the operator's own disk.
 *
 * Two rules keep the tiers from fighting:
 *
 *   - When the cold store is on, this tier skips every table an archiver
 *     registers. Two owners deleting the same rows would race the archiver's
 *     FK guard and could delete a parent whose archive chunk was never
 *     written. One owner per table.
 *   - Nothing is deleted on the first pass. The first pass with a non-zero
 *     window stamps `cluster_settings.retention_announced_at` and reports what
 *     it would remove; deletion begins a week later. An upgrade that silently
 *     deleted an operator's history on its first night would be a behaviour
 *     change nobody was warned about.
 *
 * Every delete is batched — select ids under a `LIMIT`, then delete by id,
 * looping until a pass comes back short. One unbounded `DELETE` over a table
 * holding millions of rows holds locks for as long as it runs.
 */
import { sql, type Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { TERMINAL_RUN_STATES } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import { HeldRunStatus } from '../contexts/held-runs.js';
import { retentionRowsDeletedTotal } from '../metrics/prometheus.js';

const logger = createLogger({ prefix: 'retention' });

/** Rows selected, and deleted, per statement. */
export const RETENTION_BATCH_SIZE = 5000;

/** Days between the announce stamp and the first deletion. */
export const RETENTION_ANNOUNCE_DAYS = 7;

/** Terminal run statuses. A run still queued, running, held or cancelling is
 *  live work whatever its age. */
export const TERMINAL_RUN_STATUS_LIST: readonly string[] = [...TERMINAL_RUN_STATES];

/** Terminal held-run statuses. A pending hold is never pruned. */
export const TERMINAL_HELD_RUN_STATUSES: readonly string[] = [
  HeldRunStatus.Approved,
  HeldRunStatus.Rejected,
  HeldRunStatus.Expired,
  HeldRunStatus.Released,
];

/**
 * Tables the cold-store archivers register. When the cold store is on these
 * are theirs alone — including the `execution_jobs` / `execution_steps`
 * children, which the run archiver removes with their parent.
 */
export const COLD_STORE_OWNED_TABLES: readonly string[] = [
  'execution_runs',
  'execution_jobs',
  'execution_steps',
  'access_log',
  'secret_audit_log',
  'event_log',
];

/** The `cluster_settings` columns this module reads. */
export type ClusterRetentionColumn =
  | 'run_retention_days'
  | 'audit_retention_days'
  | 'provenance_retention_days'
  | 'held_run_retention_days';

export interface RetentionWindows {
  /** Terminal runs, and the jobs and steps beneath them. 0 disables. */
  runRetentionDays: number;
  /** access_log, secret_audit_log, event_log. 0 disables. */
  auditRetentionDays: number;
  /** attestations, pending_attestations. 0 disables. */
  provenanceRetentionDays: number;
  /** Terminal held_runs. 0 disables. */
  heldRunRetentionDays: number;
}

export interface PruneExpiredHistoryDeps {
  db: Kysely<Database>;
  windows: RetentionWindows;
  /** True when the cold store is configured and owns its tables. */
  coldStoreEnabled: boolean;
  now?: () => Date;
  batchSize?: number;
}

export interface RetentionSummary {
  /** Rows deleted, per table. */
  deleted: Record<string, number>;
  /** Rows that WOULD have been deleted, while the announce window runs. */
  pending: Record<string, number>;
  /** True while the announce window has not elapsed, so nothing was deleted. */
  announcing: boolean;
}

function cutoffFor(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** True when every window is 0, i.e. the operator disabled the whole tier. */
export function allWindowsDisabled(windows: RetentionWindows): boolean {
  return Object.values(windows).every((d) => d === 0);
}

/**
 * Delete rows in bounded batches, returning the total removed.
 *
 * The loop stops as soon as a pass comes back short, which is what bounds it
 * on a table that is still being written to.
 */
export async function deleteInBatches(
  table: string,
  selectIds: (limit: number) => Promise<string[]>,
  deleteIds: (ids: string[]) => Promise<void>,
  batchSize: number,
): Promise<number> {
  let total = 0;
  for (;;) {
    const ids = await selectIds(batchSize);
    if (ids.length === 0) break;
    await deleteIds(ids);
    total += ids.length;
    retentionRowsDeletedTotal.add(ids.length, { table });
    if (ids.length < batchSize) break;
  }
  return total;
}

/** Count rows a window would remove, without removing them. */
async function countOlderThan(
  db: Kysely<Database>,
  table: 'event_log' | 'access_log' | 'secret_audit_log' | 'attestations',
  column: string,
  cutoff: Date,
): Promise<number> {
  const r = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM public.${sql.raw(table)}
     WHERE ${sql.raw(column)} < ${cutoff}
  `.execute(db);
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * Prune one time-keyed table by id.
 *
 * Kysely's typed builder cannot express a table name chosen at runtime, so the
 * id selection is raw SQL over an allow-listed table/column pair — every
 * caller below passes a literal, never anything derived from input.
 */
async function pruneByAge(
  db: Kysely<Database>,
  table: string,
  column: string,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  return deleteInBatches(
    table,
    async (limit) => {
      const r = await sql<{ id: string }>`
        SELECT id::text AS id FROM public.${sql.raw(table)}
         WHERE ${sql.raw(column)} < ${cutoff}
         LIMIT ${limit}
      `.execute(db);
      return r.rows.map((row) => row.id);
    },
    async (ids) => {
      await sql`DELETE FROM public.${sql.raw(table)} WHERE id::text = ANY(${ids})`.execute(db);
    },
    batchSize,
  );
}

/**
 * Delete terminal runs past the cutoff, children before parents.
 *
 * The batch is chosen from `execution_runs`, then the jobs and steps beneath
 * exactly those run ids are removed first — so a run is never left with
 * orphaned children, and a run still holding live children is never chosen
 * (its own status would not be terminal).
 *
 * A rerun records `parent_run_id`, and that column carries a self-referencing
 * foreign key with no `ON DELETE` action. So a run whose rerun child is newer
 * than the cutoff, still running, or merely in a later batch would abort the
 * `DELETE` — and the whole sweep with it, leaving every table after this one
 * unpruned. The `NOT EXISTS` guard skips such a parent; it becomes eligible on
 * a later pass, once its own children have aged out. This mirrors the
 * cold-store run adapter's `execution_jobs` FK guard.
 */
async function pruneRuns(
  db: Kysely<Database>,
  cutoff: Date,
  batchSize: number,
  deleted: Record<string, number>,
): Promise<void> {
  for (;;) {
    const batch = await db
      .selectFrom('execution_runs as r')
      .select('r.run_id')
      .where('r.created_at', '<', cutoff)
      .where('r.status', 'in', TERMINAL_RUN_STATUS_LIST)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('execution_runs as child')
              .select('child.run_id')
              .whereRef('child.parent_run_id', '=', 'r.run_id'),
          ),
        ),
      )
      .limit(batchSize)
      .execute();
    if (batch.length === 0) break;
    const runIds = batch.map((r) => r.run_id);

    const steps = await db.deleteFrom('execution_steps').where('run_id', 'in', runIds).execute();
    const jobs = await db.deleteFrom('execution_jobs').where('run_id', 'in', runIds).execute();
    const runs = await db.deleteFrom('execution_runs').where('run_id', 'in', runIds).execute();

    const stepN = Number(steps[0]?.numDeletedRows ?? 0n);
    const jobN = Number(jobs[0]?.numDeletedRows ?? 0n);
    const runN = Number(runs[0]?.numDeletedRows ?? 0n);
    deleted.execution_steps = (deleted.execution_steps ?? 0) + stepN;
    deleted.execution_jobs = (deleted.execution_jobs ?? 0) + jobN;
    deleted.execution_runs = (deleted.execution_runs ?? 0) + runN;
    retentionRowsDeletedTotal.add(stepN, { table: 'execution_steps' });
    retentionRowsDeletedTotal.add(jobN, { table: 'execution_jobs' });
    retentionRowsDeletedTotal.add(runN, { table: 'execution_runs' });

    if (batch.length < batchSize) break;
  }
}

/** Delete terminal held_runs past the cutoff. */
async function pruneHeldRuns(
  db: Kysely<Database>,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  return deleteInBatches(
    'held_runs',
    async (limit) => {
      const rows = await db
        .selectFrom('held_runs')
        .select('id')
        .where('created_at', '<', cutoff)
        .where('status', 'in', TERMINAL_HELD_RUN_STATUSES)
        .limit(limit)
        .execute();
      return rows.map((r) => String(r.id));
    },
    async (ids) => {
      await db.deleteFrom('held_runs').where('id', 'in', ids).execute();
    },
    batchSize,
  );
}

/**
 * Read the announce stamp, setting it on the first pass that has work to do.
 *
 * Returns true once the window has elapsed and deletion may begin.
 */
export async function announceGatePassed(
  db: Kysely<Database>,
  now: Date,
  announceDays = RETENTION_ANNOUNCE_DAYS,
): Promise<boolean> {
  const row = await db
    .selectFrom('cluster_settings')
    .select('retention_announced_at')
    .where('id', '=', 'default')
    .executeTakeFirst();

  const stamped = row?.retention_announced_at ?? null;
  if (stamped === null) {
    await db
      .insertInto('cluster_settings')
      .values({ id: 'default', retention_announced_at: now } as never)
      .onConflict((oc) => oc.column('id').doUpdateSet({ retention_announced_at: now } as never))
      .execute();
    return false;
  }
  return now.getTime() - new Date(stamped).getTime() >= announceDays * 24 * 60 * 60 * 1000;
}

/**
 * Prune every table this tier owns, honouring the windows, the cold-store
 * ownership split, and the announce gate.
 */
export async function pruneExpiredHistory(
  deps: PruneExpiredHistoryDeps,
): Promise<RetentionSummary> {
  const { db, windows, coldStoreEnabled } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const batchSize = deps.batchSize ?? RETENTION_BATCH_SIZE;
  const summary: RetentionSummary = { deleted: {}, pending: {}, announcing: false };

  if (allWindowsDisabled(windows)) return summary;

  const owns = (table: string): boolean =>
    !(coldStoreEnabled && COLD_STORE_OWNED_TABLES.includes(table));

  const mayDelete = await announceGatePassed(db, now);
  if (!mayDelete) {
    summary.announcing = true;
    // Report the volume rather than removing it, so the operator sees the size
    // of what is about to age out with a week to disable it.
    if (windows.auditRetentionDays > 0) {
      const cutoff = cutoffFor(now, windows.auditRetentionDays);
      if (owns('event_log')) {
        summary.pending.event_log = await countOlderThan(db, 'event_log', 'received_at', cutoff);
      }
      if (owns('access_log')) {
        summary.pending.access_log = await countOlderThan(db, 'access_log', 'created_at', cutoff);
      }
    }
    if (windows.runRetentionDays > 0 && owns('execution_runs')) {
      const cutoff = cutoffFor(now, windows.runRetentionDays);
      const r = await db
        .selectFrom('execution_runs')
        .select(({ fn }) => fn.countAll().as('n'))
        .where('created_at', '<', cutoff)
        .where('status', 'in', TERMINAL_RUN_STATUS_LIST)
        .executeTakeFirst();
      summary.pending.execution_runs = Number(r?.n ?? 0);
    }
    logger.warn(
      'Database retention is announced but not yet deleting; the first deletion runs ' +
        `${RETENTION_ANNOUNCE_DAYS} days after the announce stamp. Set ` +
        'KICI_RUN_RETENTION_DAYS / KICI_AUDIT_RETENTION_DAYS / ' +
        'KICI_PROVENANCE_RETENTION_DAYS / KICI_HELD_RUN_RETENTION_DAYS to 0 to disable.',
      { windows, wouldDelete: summary.pending },
    );
    return summary;
  }

  if (windows.runRetentionDays > 0 && owns('execution_runs')) {
    await pruneRuns(db, cutoffFor(now, windows.runRetentionDays), batchSize, summary.deleted);
  }

  if (windows.auditRetentionDays > 0) {
    const cutoff = cutoffFor(now, windows.auditRetentionDays);
    if (owns('event_log')) {
      summary.deleted.event_log = await pruneByAge(
        db,
        'event_log',
        'received_at',
        cutoff,
        batchSize,
      );
    }
    if (owns('access_log')) {
      summary.deleted.access_log = await pruneByAge(
        db,
        'access_log',
        'created_at',
        cutoff,
        batchSize,
      );
    }
    if (owns('secret_audit_log')) {
      summary.deleted.secret_audit_log = await pruneByAge(
        db,
        'secret_audit_log',
        'timestamp',
        cutoff,
        batchSize,
      );
    }
  }

  if (windows.provenanceRetentionDays > 0) {
    const cutoff = cutoffFor(now, windows.provenanceRetentionDays);
    summary.deleted.attestations = await pruneByAge(
      db,
      'attestations',
      'created_at',
      cutoff,
      batchSize,
    );
    summary.deleted.pending_attestations = await pruneByAge(
      db,
      'pending_attestations',
      'created_at',
      cutoff,
      batchSize,
    );
  }

  if (windows.heldRunRetentionDays > 0) {
    summary.deleted.held_runs = await pruneHeldRuns(
      db,
      cutoffFor(now, windows.heldRunRetentionDays),
      batchSize,
    );
  }

  const total = Object.values(summary.deleted).reduce((a, b) => a + b, 0);
  if (total > 0) logger.info('Pruned expired history', { deleted: summary.deleted, windows });
  return summary;
}

/**
 * Resolve the effective windows: a live `cluster_settings` value wins over the
 * configured default.
 *
 * `getNumber` returns a genuine 0 when the operator set the knob to 0, which is
 * the documented way to disable a window — so this stays a fallback-on-null
 * read, never `||`.
 */
export async function resolveRetentionWindows(
  defaults: RetentionWindows,
  clusterSettings?: {
    getNumber(column: ClusterRetentionColumn, fallback: number): Promise<number>;
  },
): Promise<RetentionWindows> {
  if (!clusterSettings) return defaults;
  return {
    runRetentionDays: await clusterSettings.getNumber(
      'run_retention_days',
      defaults.runRetentionDays,
    ),
    auditRetentionDays: await clusterSettings.getNumber(
      'audit_retention_days',
      defaults.auditRetentionDays,
    ),
    provenanceRetentionDays: await clusterSettings.getNumber(
      'provenance_retention_days',
      defaults.provenanceRetentionDays,
    ),
    heldRunRetentionDays: await clusterSettings.getNumber(
      'held_run_retention_days',
      defaults.heldRunRetentionDays,
    ),
  };
}

/** Wrap {@link pruneExpiredHistory} so a failure never aborts the sweep. */
export async function pruneExpiredHistorySafely(
  deps: PruneExpiredHistoryDeps,
): Promise<RetentionSummary> {
  try {
    return await pruneExpiredHistory(deps);
  } catch (err) {
    logger.error('Failed to prune expired history', { error: toErrorMessage(err) });
    return { deleted: {}, pending: {}, announcing: false };
  }
}
