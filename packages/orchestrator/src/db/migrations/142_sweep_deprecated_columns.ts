import { type Kysely, sql } from 'kysely';

/**
 * Sweep the columns and stored values no code path reads or writes. Data first, then schema:
 *
 *   - `execution_runs.trust_tier = 'known'` becomes `unknown` (the vocabulary is
 *     `trusted | unknown`; `known` was recognised-but-untrusted). Batched, because
 *     `execution_runs` grows with run volume.
 *   - `org_trust_policy.fork_policy = 'reject'` becomes `ignore`, as on the Platform's table: a
 *     rejected fork event created no run and posted nothing.
 *   - `contexts.minimum_trust = 'known'` becomes NULL: the store already reads it as no
 *     requirement, and `trusted` would hold runs the context never held.
 *   - Dropped, each backing a removed feature: `org_settings.global_workflow_elevated_repos`
 *     (elevated-repo list), `cluster_settings.contributor_cache_ttl_ms` (contributor cache TTL),
 *     `org_trust_policy.unknown_contributor_policy` and `workflow_change_policy` (the non-fork
 *     trust-policy arms), `dispatch_queue.source_tar_hash` (replaced by the source digest).
 *
 * `down` is a no-op: dropped values are unrecoverable, and no reader accepts the rewritten ones.
 * Idempotent: every UPDATE matches nothing on a re-run and every DROP is IF EXISTS.
 */
const BATCH_SIZE = 5000;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (;;) {
    const result = await sql`
      UPDATE public.execution_runs
         SET trust_tier = 'unknown'
       WHERE id IN (
         SELECT id FROM public.execution_runs
          WHERE trust_tier = 'known'
          LIMIT ${sql.lit(BATCH_SIZE)}
       )
    `.execute(db);
    if ((result.numAffectedRows ?? 0n) === 0n) break;
  }

  await sql`
    UPDATE public.org_trust_policy
       SET fork_policy = 'ignore', updated_at = now()
     WHERE fork_policy = 'reject'
  `.execute(db);

  await sql`
    UPDATE public.contexts
       SET minimum_trust = NULL, updated_at = now()
     WHERE minimum_trust = 'known'
  `.execute(db);

  await sql`ALTER TABLE public.org_settings DROP COLUMN IF EXISTS global_workflow_elevated_repos`.execute(
    db,
  );
  await sql`ALTER TABLE public.cluster_settings DROP COLUMN IF EXISTS contributor_cache_ttl_ms`.execute(
    db,
  );
  await sql`ALTER TABLE public.org_trust_policy DROP COLUMN IF EXISTS unknown_contributor_policy`.execute(
    db,
  );
  await sql`ALTER TABLE public.org_trust_policy DROP COLUMN IF EXISTS workflow_change_policy`.execute(
    db,
  );
  await sql`ALTER TABLE public.dispatch_queue DROP COLUMN IF EXISTS source_tar_hash`.execute(db);
}

export async function down(): Promise<void> {}
