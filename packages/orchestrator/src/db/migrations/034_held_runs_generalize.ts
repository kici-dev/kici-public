import { type Kysely, sql } from 'kysely';

/**
 * Generalize `held_runs` from an environment-only hold into the unified
 * "held element" model that backs per-element approvals, and add the
 * `held_run_approvals` table that records each approver's decision.
 *
 * New `held_runs` columns (all idempotent, column-exists guarded):
 * - `hold_scope text NOT NULL DEFAULT 'job'` — 'workflow' | 'job' | 'step'
 *   (engine `HoldScope`). Existing rows held a single job, so they default to
 *   'job'.
 * - `step_index integer` — nullable; set only for step-scoped holds.
 * - `trigger_source text NOT NULL DEFAULT 'environment'` — 'environment' |
 *   'explicit' (engine `TriggerSource`). Existing holds came from environment
 *   protection, so they default to 'environment'.
 * - `approval_requirement jsonb` — the normalized `ApprovalRequirement`
 *   (clauses + expiresAt + reason) the hold must satisfy. Nullable for legacy
 *   rows that predate the approval model.
 *
 * New `held_run_approvals` table: one row per approver decision, FK to
 * `held_runs.id` (uuid) with ON DELETE CASCADE.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const colExists = async (column: string): Promise<boolean> => {
    const res = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'held_runs'
           AND column_name = ${column}
      ) AS exists
    `.execute(db);
    return res.rows[0]?.exists ?? false;
  };

  if (!(await colExists('hold_scope'))) {
    await sql`ALTER TABLE public.held_runs ADD COLUMN hold_scope text NOT NULL DEFAULT 'job'`.execute(
      db,
    );
  }
  if (!(await colExists('step_index'))) {
    await sql`ALTER TABLE public.held_runs ADD COLUMN step_index integer`.execute(db);
  }
  if (!(await colExists('trigger_source'))) {
    await sql`ALTER TABLE public.held_runs ADD COLUMN trigger_source text NOT NULL DEFAULT 'environment'`.execute(
      db,
    );
  }
  if (!(await colExists('approval_requirement'))) {
    await sql`ALTER TABLE public.held_runs ADD COLUMN approval_requirement jsonb`.execute(db);
  }

  await sql`
    CREATE TABLE IF NOT EXISTS public.held_run_approvals (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      held_run_id uuid NOT NULL,
      approver_user_id text NOT NULL,
      decision text NOT NULL,
      clauses_satisfied jsonb,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT held_run_approvals_pkey PRIMARY KEY (id),
      CONSTRAINT held_run_approvals_held_run_id_fkey
        FOREIGN KEY (held_run_id) REFERENCES public.held_runs(id) ON DELETE CASCADE
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS held_run_approvals_held_run_id_idx
      ON public.held_run_approvals USING btree (held_run_id)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.held_run_approvals`.execute(db);
  await sql`ALTER TABLE public.held_runs DROP COLUMN IF EXISTS approval_requirement`.execute(db);
  await sql`ALTER TABLE public.held_runs DROP COLUMN IF EXISTS trigger_source`.execute(db);
  await sql`ALTER TABLE public.held_runs DROP COLUMN IF EXISTS step_index`.execute(db);
  await sql`ALTER TABLE public.held_runs DROP COLUMN IF EXISTS hold_scope`.execute(db);
}
