/**
 * `kici-admin attestations list`: a read-only projection of the `attestations`
 * table into a `runs list --json`-shaped envelope. The DB read is injected so
 * the mapping is testable without Postgres (mirrors attestations-retry.ts's
 * injected-transport pattern).
 */
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';

export interface AttestationListDbRow {
  id: string;
  run_id: string;
  job_id: string;
  subject_name: string;
  verify_status: string;
  created_at: Date;
}

export interface AttestationListItem {
  id: string;
  runId: string;
  jobId: string;
  subjectName: string;
  verifyStatus: string;
  createdAt: string;
}

/** The read fn applies the filters. */
export interface AttestationListOptions {
  limit: number;
  runId?: string;
  jobId?: string;
}

/** The `--json` envelope (mirrors `runs list --json`'s `{ runs: [...] }`). */
export interface AttestationListResult {
  attestations: AttestationListItem[];
}

/** `read` honours the options; this owns only the row→envelope projection. */
export async function runAttestationList(
  read: (opts: AttestationListOptions) => Promise<AttestationListDbRow[]>,
  opts: AttestationListOptions,
): Promise<AttestationListResult> {
  const rows = await read(opts);
  return {
    attestations: rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      jobId: r.job_id,
      subjectName: r.subject_name,
      verifyStatus: r.verify_status,
      createdAt: r.created_at.toISOString(),
    })),
  };
}

/** The real read, newest first. */
export function readAttestations(
  db: Kysely<Database>,
): (opts: AttestationListOptions) => Promise<AttestationListDbRow[]> {
  return async ({ limit, runId, jobId }) => {
    let query = db
      .selectFrom('attestations')
      .select(['id', 'run_id', 'job_id', 'subject_name', 'verify_status', 'created_at'])
      .orderBy('created_at', 'desc')
      .limit(limit);
    if (runId) query = query.where('run_id', '=', runId);
    if (jobId) query = query.where('job_id', '=', jobId);
    return query.execute();
  };
}
