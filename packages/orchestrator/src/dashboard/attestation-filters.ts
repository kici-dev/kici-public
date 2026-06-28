import { type Kysely, sql } from 'kysely';
import type { AttestationListFilters } from '@kici-dev/engine';
import type { Database } from '../db/types.js';

/**
 * The org-wide attestations base query: joins `attestations` to `execution_jobs`
 * (for the job name) and `execution_runs` (for repository / workflow context).
 *
 * `attestations.run_id` / `job_id` are TEXT (P1.5 schema) while the
 * `execution_*` keys are `uuid`; Postgres won't compare `uuid = text` implicitly,
 * so the join casts the uuid side to text — mirroring `resolveAttestationsForRun`.
 * The `execution_runs` join is a LEFT join so a row with no matching run still
 * lists (repository / workflow come back null).
 */
export function baseAttestationsQuery(db: Kysely<Database>) {
  return db
    .selectFrom('attestations')
    .innerJoin('execution_jobs', (join) =>
      join
        .on(sql`execution_jobs.job_id::text`, '=', sql.ref('attestations.job_id'))
        .on(sql`execution_jobs.run_id::text`, '=', sql.ref('attestations.run_id')),
    )
    .leftJoin('execution_runs', (join) =>
      join.on(sql`execution_runs.run_id::text`, '=', sql.ref('attestations.run_id')),
    );
}

export type AttestationsBaseQuery = ReturnType<typeof baseAttestationsQuery>;

/**
 * Apply org-wide attestation filters to the base query. Digest is exact-match;
 * name is an ILIKE substring; status / repository / workflow / job are equality;
 * created_at gets `>=` / `<=` bounds for the date range. Absent filters are
 * skipped.
 */
export function applyAttestationFilters(
  qb: AttestationsBaseQuery,
  filters: AttestationListFilters,
): AttestationsBaseQuery {
  let q = qb;
  if (filters.digest) q = q.where('attestations.subject_digest', '=', filters.digest);
  if (filters.name) q = q.where('attestations.subject_name', 'ilike', `%${filters.name}%`);
  if (filters.status) q = q.where('attestations.verify_status', '=', filters.status);
  if (filters.repository) q = q.where('execution_runs.repo_identifier', '=', filters.repository);
  if (filters.workflow) q = q.where('execution_runs.workflow_name', '=', filters.workflow);
  if (filters.job) q = q.where('execution_jobs.job_name', '=', filters.job);
  if (filters.createdAfter) {
    q = q.where('attestations.created_at', '>=', new Date(filters.createdAfter));
  }
  if (filters.createdBefore) {
    q = q.where('attestations.created_at', '<=', new Date(filters.createdBefore));
  }
  return q;
}
