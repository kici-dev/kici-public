import { type Kysely, sql } from 'kysely';

/**
 * `agent_tokens.mandatory_labels text NULL`: a JSON-encoded `string[]` of
 * Kubernetes-taint-style gate labels. A static agent registering with the
 * token gets them as its registry-entry `mandatoryLabels` and accepts a job
 * only when every one appears in the job's required labels. NULL = no taint,
 * so every existing token stays unconfined until re-minted.
 *
 * Idempotent and additive.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.agent_tokens
    ADD COLUMN IF NOT EXISTS mandatory_labels text`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.agent_tokens
    DROP COLUMN IF EXISTS mandatory_labels`.execute(db);
}
