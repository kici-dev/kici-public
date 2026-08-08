import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../db/types.js';

/**
 * Durable accumulator backing the `workflowsFailedBatch` trigger.
 *
 * A failed `workflow_complete` event that matches a `workflowsFailedBatch`
 * registration is buffered into a per-(registration, window) row instead of
 * dispatching now. The first failure opens the window; the Raft-leader-only
 * scanner sweeps windows past `expires_at`, emits one `__workflows_failed_batch`
 * event, and deletes the window (cascading its items). The state lives in
 * Postgres (not an in-memory Map) so a node restart mid-window loses nothing.
 */

/** A failed run buffered into a batch window. */
export interface BatchAccumulatorRun {
  runId: string;
  repoIdentifier: string;
  workflowName: string;
  failureClass?: string | null;
  senderUsername?: string | null;
}

/** A window swept past its deadline, with the runs it accumulated. */
export interface SweptBatchWindow {
  windowId: string;
  customerId: string;
  registrationId: string;
  routingKey: string;
  repoIdentifier: string;
  runs: BatchAccumulatorRun[];
}

export interface OpenBatchWindowInput {
  registrationId: string;
  customerId: string;
  routingKey: string;
  repoIdentifier: string;
  accumulateForMs: number;
}

/**
 * Open the accumulation window for a registration, or return the existing open
 * one. `opened` is true only for the caller that created the window (the first
 * failure of the burst) so exactly one caller schedules nothing beyond the DB
 * row — the leader scanner owns the flush.
 *
 * Uses `INSERT ... ON CONFLICT (registration_id) DO NOTHING RETURNING id` for an
 * atomic open-once: concurrent failures append to the same window rather than
 * racing to open N windows.
 */
export async function openOrGetBatchWindow(
  db: Kysely<Database>,
  input: OpenBatchWindowInput,
): Promise<{ windowId: string; opened: boolean }> {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + input.accumulateForMs);

  const inserted = await db
    .insertInto('batch_accumulation_windows')
    .values({
      id,
      customer_id: input.customerId,
      registration_id: input.registrationId,
      routing_key: input.routingKey,
      repo_identifier: input.repoIdentifier,
      accumulate_for_ms: input.accumulateForMs,
      expires_at: expiresAt,
    })
    .onConflict((oc) => oc.column('registration_id').doNothing())
    .returning('id')
    .executeTakeFirst();

  if (inserted) {
    return { windowId: inserted.id, opened: true };
  }

  const existing = await db
    .selectFrom('batch_accumulation_windows')
    .select('id')
    .where('registration_id', '=', input.registrationId)
    .executeTakeFirstOrThrow();
  return { windowId: existing.id, opened: false };
}

/** Append one failed run to an open window. */
export async function appendBatchItem(
  db: Kysely<Database>,
  input: { windowId: string; run: BatchAccumulatorRun },
): Promise<void> {
  await db
    .insertInto('batch_accumulation_items')
    .values({
      id: randomUUID(),
      window_id: input.windowId,
      run_id: input.run.runId,
      repo_identifier: input.run.repoIdentifier,
      workflow_name: input.run.workflowName,
      failure_class: input.run.failureClass ?? null,
      sender_username: input.run.senderUsername ?? null,
    })
    .execute();
}

/**
 * Sweep every window whose `expires_at <= now`. For each, in a transaction, load
 * its items, delete the window (cascading the items), and return the runs. Only
 * the Raft leader calls this. Windows with no items (a run that was excluded
 * after opening) still emit — the caller decides whether to skip an empty batch.
 */
export async function sweepExpiredBatchWindows(
  db: Kysely<Database>,
  now: Date,
): Promise<SweptBatchWindow[]> {
  const expired = await db
    .selectFrom('batch_accumulation_windows')
    .select(['id', 'customer_id', 'registration_id', 'routing_key', 'repo_identifier'])
    .where('expires_at', '<=', now)
    .orderBy('expires_at', 'asc')
    .execute();

  const swept: SweptBatchWindow[] = [];
  for (const win of expired) {
    const result = await db.transaction().execute(async (tx) => {
      // Re-check the window still exists inside the tx (another leader tick could
      // have swept it); a row-lock avoids a double-sweep race.
      const locked = await sql<{ id: string }>`
        SELECT id FROM public.batch_accumulation_windows
         WHERE id = ${win.id}
         FOR UPDATE SKIP LOCKED
      `.execute(tx);
      if (locked.rows.length === 0) return null;

      const items = await tx
        .selectFrom('batch_accumulation_items')
        .select(['run_id', 'repo_identifier', 'workflow_name', 'failure_class', 'sender_username'])
        .where('window_id', '=', win.id)
        .orderBy('created_at', 'asc')
        .execute();

      await tx.deleteFrom('batch_accumulation_windows').where('id', '=', win.id).execute();

      return items.map((it) => ({
        runId: it.run_id,
        repoIdentifier: it.repo_identifier,
        workflowName: it.workflow_name,
        failureClass: it.failure_class,
        senderUsername: it.sender_username,
      }));
    });

    if (result === null) continue;
    swept.push({
      windowId: win.id,
      customerId: win.customer_id,
      registrationId: win.registration_id,
      routingKey: win.routing_key,
      repoIdentifier: win.repo_identifier,
      runs: result,
    });
  }
  return swept;
}
