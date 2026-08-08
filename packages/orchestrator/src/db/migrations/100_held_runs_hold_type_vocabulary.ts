import { type Kysely, sql } from 'kysely';

/**
 * Realign `held_runs.hold_type` onto the engine's `HoldType` vocabulary.
 *
 * The column carries two spellings the gates never emit: `approval` for a
 * reviewer hold and `wait_timer` for a workflow-install wait hold. The
 * dashboard switches on the gate vocabulary, so both fall through to the gray
 * unknown-type badge — and two semantically identical wait holds render
 * differently depending on which gate produced them.
 *
 * Writers emit the gate vocabulary; this backfills the history. The read path
 * also normalizes (`normalizePersistedHoldType`) and the wait-hold release
 * sweep matches both spellings, so a row written by an un-upgraded
 * orchestrator behaves correctly whether or not this has run — the two sides
 * deploy independently.
 *
 * Idempotent: a second run matches no rows.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`UPDATE public.held_runs SET hold_type = 'reviewer' WHERE hold_type = 'approval'`.execute(
    db,
  );
  await sql`UPDATE public.held_runs SET hold_type = 'timer' WHERE hold_type = 'wait_timer'`.execute(
    db,
  );
}

/**
 * Rewrite the gate vocabulary back to the legacy spellings.
 *
 * Deliberately asymmetric: it rewrites *every* `reviewer` / `timer` row,
 * including rows that were always written that way (a dispatch-gate wait hold
 * has persisted as `timer` all along). That is the right trade for a rollback —
 * an orchestrator running the older code matches its wait-hold release sweep on
 * `wait_timer` alone, so leaving those rows spelled `timer` would strand them
 * in the expire-and-fail path.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`UPDATE public.held_runs SET hold_type = 'approval' WHERE hold_type = 'reviewer'`.execute(
    db,
  );
  await sql`UPDATE public.held_runs SET hold_type = 'wait_timer' WHERE hold_type = 'timer'`.execute(
    db,
  );
}
