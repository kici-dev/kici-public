import { type Kysely, sql } from 'kysely';

/**
 * HA ownership for event-scaler provisions.
 *
 * - `scaler_pending_claims` — the pending provisioning claim, moved out of the
 *   per-process map in `ClaimStore` so any coordinator can redeem a code. Single
 *   use is enforced by `consumed_at`, set by a conditional UPDATE.
 * - `scaler_spawning_agents.*` — `owner_instance_id` scopes recovery and the
 *   per-instance reaper; `adopted_by` / `adopted_at` record which coordinator the
 *   agent actually reached; `mandatory_labels` / `provisioning_targets` / `roles`
 *   / `backend_type` make the row self-describing, so a coordinator with no
 *   matching scaler entry can still stamp the taint and emit the teardown.
 * - `scaler_reservations.owner_instance_id` — same scoping for reservations.
 *
 * All columns are nullable and backfill as NULL. A NULL `owner_instance_id`
 * reads as "unknown owner", never as "not mine".
 *
 * Idempotent: guarded on each object's existence.
 */
async function tableExists(db: Kysely<unknown>, name: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ${name}
    ) AS exists
  `.execute(db);
  return result.rows[0]?.exists ?? false;
}

async function colExists(db: Kysely<unknown>, table: string, name: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND column_name = ${name}
    ) AS exists
  `.execute(db);
  return result.rows[0]?.exists ?? false;
}

const SPAWNING_COLUMNS: Array<[string, string]> = [
  ['owner_instance_id', 'TEXT'],
  ['adopted_by', 'TEXT'],
  ['adopted_at', 'TIMESTAMPTZ'],
  ['mandatory_labels', 'JSONB'],
  ['provisioning_targets', 'JSONB'],
  ['roles', 'JSONB'],
  ['backend_type', 'TEXT'],
];

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await tableExists(db, 'scaler_pending_claims'))) {
    await sql`
      CREATE TABLE public.scaler_pending_claims (
        claim_hash          TEXT PRIMARY KEY,
        claim_prefix        TEXT NOT NULL,
        agent_id            TEXT NOT NULL,
        scaler_name         TEXT NOT NULL,
        labels              JSONB NOT NULL,
        agent_token_ttl_ms  BIGINT NOT NULL,
        orchestrator_url    TEXT NOT NULL,
        expires_at          TIMESTAMPTZ NOT NULL,
        consumed_at         TIMESTAMPTZ,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.execute(db);
    // Lookup by the agent the claim provisions.
    await sql`
      CREATE INDEX idx_scaler_pending_claims_agent_id
        ON public.scaler_pending_claims (agent_id)
    `.execute(db);
    // Sweep of expired, never-redeemed claims.
    await sql`
      CREATE INDEX idx_scaler_pending_claims_expires_at
        ON public.scaler_pending_claims (expires_at)
    `.execute(db);
  }

  for (const [name, type] of SPAWNING_COLUMNS) {
    if (!(await colExists(db, 'scaler_spawning_agents', name))) {
      await sql`
        ALTER TABLE public.scaler_spawning_agents
          ADD COLUMN ${sql.raw(name)} ${sql.raw(type)}
      `.execute(db);
    }
  }

  // Owner-scoped recovery and per-instance reaping.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_scaler_spawning_agents_owner
      ON public.scaler_spawning_agents (owner_instance_id)
  `.execute(db);
  // Per-scaler lookup when a coordinator resolves a spawning row to its scaler.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_scaler_spawning_agents_scaler_name
      ON public.scaler_spawning_agents (scaler_name)
  `.execute(db);

  if (!(await colExists(db, 'scaler_reservations', 'owner_instance_id'))) {
    await sql`
      ALTER TABLE public.scaler_reservations
        ADD COLUMN owner_instance_id TEXT
    `.execute(db);
  }
  await sql`
    CREATE INDEX IF NOT EXISTS idx_scaler_reservations_owner
      ON public.scaler_reservations (owner_instance_id)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.scaler_pending_claims`.execute(db);
  // Dropping a column drops its indexes, which covers every index this migration
  // adds except this one: `scaler_name` pre-dates 119 (migration 022), so the
  // index survives the column-drop loop below and has to go explicitly.
  await sql`DROP INDEX IF EXISTS public.idx_scaler_spawning_agents_scaler_name`.execute(db);
  for (const [name] of SPAWNING_COLUMNS) {
    await sql`
      ALTER TABLE public.scaler_spawning_agents DROP COLUMN IF EXISTS ${sql.raw(name)}
    `.execute(db);
  }
  await sql`
    ALTER TABLE public.scaler_reservations DROP COLUMN IF EXISTS owner_instance_id
  `.execute(db);
}
