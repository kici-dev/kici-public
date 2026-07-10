import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../db/types.js';

/**
 * Atomically claim a run-minting request by its Platform `requestId`. Returns
 * the run id to use. `claimed: false` means a sibling coordinator already owns
 * this requestId (a relay failover re-sent the same request): the caller MUST
 * return `{ newRunId }` WITHOUT creating or dispatching a run, so one user
 * click yields exactly one run.
 *
 * Shared by `run.rerun.request` and `run.manual_schedule.request` — both mint a
 * fresh run and both ride the Platform's timeout-driven failover path. HA
 * coordinator siblings share one orchestrator DB, so the `INSERT … ON CONFLICT
 * (request_id) DO NOTHING` is the single point of arbitration: exactly one hop
 * inserts and wins; the loser reads back the winner's `new_run_id`.
 */
export async function claimRequestId(
  db: Kysely<Database>,
  requestId: string,
): Promise<{ newRunId: string; claimed: boolean }> {
  const candidate = randomUUID();
  const inserted = await db
    .insertInto('request_idempotency')
    .values({ request_id: requestId, new_run_id: candidate })
    .onConflict((oc) => oc.column('request_id').doNothing())
    .returning('new_run_id')
    .executeTakeFirst();
  // A row came back only when our INSERT actually landed (no conflict). The
  // returned id equals `candidate`; return `candidate` directly so the result
  // does not depend on the driver echoing the RETURNING row.
  if (inserted) return { newRunId: candidate, claimed: true };
  const existing = await db
    .selectFrom('request_idempotency')
    .select('new_run_id')
    .where('request_id', '=', requestId)
    .executeTakeFirstOrThrow();
  return { newRunId: existing.new_run_id, claimed: false };
}

/**
 * Prune `request_idempotency` rows older than 1h. The request budget is ~10s,
 * so a claimed requestId is never re-sent after an hour; keeping the table
 * bounded avoids unbounded growth on a long-lived coordinator.
 *
 * @returns the number of rows deleted.
 */
export async function pruneRequestIdempotency(db: Kysely<Database>): Promise<number> {
  const result = await db
    .deleteFrom('request_idempotency')
    .where('created_at', '<', sql<Date>`now() - interval '1 hour'`)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0n);
}
