import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../db/types.js';

/**
 * Atomically claim a run-minting request by its Platform `requestId`, returning
 * the run id to use. `claimed: false` means an earlier delivery of the same
 * request owns it (a relay failover re-send to a sibling coordinator, or a
 * Platform retry that reuses the request id of an unconfirmed start): the caller
 * MUST return `{ newRunId, alreadyAccepted: true }` WITHOUT creating or
 * dispatching a run, so one click yields exactly one run.
 *
 * Used by `run.rerun.request` and `run.manual_schedule.request`, which both mint
 * a run and ride the Platform's timeout-driven failover. HA siblings share one
 * orchestrator DB, so `INSERT … ON CONFLICT (request_id) DO NOTHING` is the
 * single arbiter; the loser reads back the winner's `new_run_id`.
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
  // A row comes back only when the INSERT landed. Return `candidate` itself so
  // the result does not depend on the driver echoing the RETURNING row.
  if (inserted) return { newRunId: candidate, claimed: true };
  const existing = await db
    .selectFrom('request_idempotency')
    .select('new_run_id')
    .where('request_id', '=', requestId)
    .executeTakeFirstOrThrow();
  return { newRunId: existing.new_run_id, claimed: false };
}

/** The answer to a run-minting request; `alreadyAccepted` marks a run an earlier delivery started. */
export interface RunStartAnswer {
  newRunId: string;
  alreadyAccepted?: true;
}

/**
 * Prune `request_idempotency` rows older than 1h: the Platform re-sends a
 * requestId for at most 30 minutes (its run-start intent window), so no claimed
 * requestId is re-sent after an hour, and the table stays bounded.
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
