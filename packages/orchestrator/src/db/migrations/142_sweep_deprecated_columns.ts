import { type Kysely, sql } from 'kysely';

/**
 * Sweep the columns and stored values that no code path reads or writes any
 * more.
 *
 * Data first, then schema:
 *
 *   - `execution_runs.trust_tier = 'known'` becomes `unknown`. The tier
 *     vocabulary is `trusted | unknown`; a `known` contributor was one the
 *     resolver recognised but did not trust, which is what `unknown` means now.
 *     Batched, because `execution_runs` grows with run volume.
 *   - `org_trust_policy.fork_policy = 'reject'` becomes `ignore` — the same
 *     rewrite the Platform applied to its own table. A rejected fork event
 *     created no run and posted nothing, which is the `ignore` verdict.
 *   - `contexts.minimum_trust = 'known'` becomes NULL. That floor admitted every
 *     recognised contributor, and the store already reads it as no requirement;
 *     rewriting it to `trusted` would hold runs the context never held.
 *   - `org_settings.global_workflow_elevated_repos`,
 *     `cluster_settings.contributor_cache_ttl_ms`,
 *     `org_trust_policy.unknown_contributor_policy`,
 *     `org_trust_policy.workflow_change_policy` and
 *     `dispatch_queue.source_tar_hash` are dropped. Each backed a feature that
 *     has been removed: the elevated-repo list, the contributor cache TTL, the
 *     two non-fork trust-policy arms, and the workflow content hash the source
 *     digest replaced.
 *
 * `down` is a no-op: the dropped values are not recoverable, and none of the
 * rewritten values is one any reader still accepts.
 *
 * Idempotent: every UPDATE matches nothing on a second run and every DROP is
 * guarded by IF EXISTS.
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
