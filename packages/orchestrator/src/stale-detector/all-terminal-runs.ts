import { sql, type Kysely, type SqlBool } from 'kysely';
import { ExecutionRunStatus, TERMINAL_JOB_STATES } from '@kici-dev/engine';
import { liveInstanceIds } from '../cluster/instance-heartbeat.js';
import type { Database } from '../db/types.js';

/**
 * Runs whose every job row is terminal while the run row is not.
 *
 * Every coordinator finalizes a run from its own in-memory view when the
 * last job it hears about finishes, and defers while a sibling still has a
 * registration window open on the run. So one shape reaches no finalizer at
 * all: the coordinator that saw the last job deferred to a live window holder,
 * and that holder then died before releasing it — its stale id reads as no
 * window, but nothing re-drives the check on the coordinator that deferred.
 * The same shape appears when a coordinator dies between its jobs going
 * terminal and its own finalization.
 *
 * This sweep is the backstop: every job row terminal, the run row still
 * `pending` or `running`, the last completion older than the stale threshold
 * (so a normal completion in flight is not raced), and no LIVE registration
 * window holder. The caller finishes each candidate through the tracker's
 * DB-fallback completion, which is clobber-guarded and computes the status
 * from the rows — so a run a coordinator finishes in the meantime is left as
 * that coordinator wrote it.
 */
export async function selectAllTerminalRunCandidates(
  db: Kysely<Database>,
  opts: {
    /** Runs whose last job completed before this instant qualify. */
    threshold: Date;
    /** Runs started before this instant are out of scope (ancient history). */
    timeBound: Date;
    /** How stale a `cluster_instances` heartbeat may be and still read as live. */
    livenessGraceMs: number;
  },
): Promise<string[]> {
  const terminal = [...TERMINAL_JOB_STATES];
  const rows = await db
    .selectFrom('execution_runs as er')
    .select(['er.run_id', 'er.registration_window_instance_id'])
    .where('er.status', 'in', [ExecutionRunStatus.enum.pending, ExecutionRunStatus.enum.running])
    .where('er.started_at', '>', opts.timeBound)
    .where(sql<SqlBool>`EXISTS (SELECT 1 FROM execution_jobs ej WHERE ej.run_id = er.run_id)`)
    .where(
      sql<SqlBool>`NOT EXISTS (
        SELECT 1 FROM execution_jobs ej
         WHERE ej.run_id = er.run_id
           AND ej.status NOT IN (${sql.join(terminal.map((s) => sql`${s}`))})
      )`,
    )
    .where(
      sql<SqlBool>`(
        SELECT COALESCE(MAX(ej.completed_at), er.started_at) FROM execution_jobs ej
         WHERE ej.run_id = er.run_id
      ) < ${opts.threshold}`,
    )
    .execute();
  if (rows.length === 0) return [];

  const holders = rows
    .map((r) => r.registration_window_instance_id)
    .filter((h): h is string => typeof h === 'string' && h.length > 0);
  const live = await liveInstanceIds(db, holders, opts.livenessGraceMs);
  return rows
    .filter((r) => {
      const holder = r.registration_window_instance_id;
      return typeof holder !== 'string' || holder.length === 0 || !live.has(holder);
    })
    .map((r) => r.run_id);
}
