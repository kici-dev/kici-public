import { type Kysely, sql } from 'kysely';

/**
 * Add a token-bound mandatory-label taint to agent tokens:
 *
 * - `agent_tokens.mandatory_labels text NULL` — a JSON-encoded `string[]` of
 *   Kubernetes-taint-style gate labels the token authorizes. When a static
 *   agent registers with this token, the set becomes the agent's registry-entry
 *   `mandatoryLabels`: the agent only accepts a job when every label here
 *   appears in the job's required labels. NULL = no taint (the default; the
 *   agent accepts any job its advertised labels match), so every existing token
 *   stays unconfined until re-minted.
 *
 * Idempotent (`ADD COLUMN IF NOT EXISTS`); additive, so staging data is
 * preserved.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.agent_tokens
    ADD COLUMN IF NOT EXISTS mandatory_labels text`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.agent_tokens
    DROP COLUMN IF EXISTS mandatory_labels`.execute(db);
}
