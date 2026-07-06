/**
 * `kici-admin attestations list` runner — a read-only projection of the
 * orchestrator `attestations` table into a JSON envelope mirroring
 * `runs list --json`'s shape. The DB read is injected so the row→envelope
 * mapping is unit-testable without a Postgres connection (mirrors
 * attestations-retry.ts's injected-transport pattern).
 */
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';

/** One attestation row as read from the orchestrator DB (snake_case columns). */
export interface AttestationListDbRow {
  id: string;
  run_id: string;
  job_id: string;
  subject_name: string;
  verify_status: string;
  created_at: Date;
}

/** One attestation as rendered in the CLI JSON envelope (camelCase). */
export interface AttestationListItem {
  id: string;
  runId: string;
  jobId: string;
  subjectName: string;
  verifyStatus: string;
  createdAt: string;
}

/** Scope + bound for a list read. Filters are applied by the read fn. */
export interface AttestationListOptions {
  limit: number;
  runId?: string;
  jobId?: string;
}

/** The `--json` envelope (mirrors `runs list --json`'s `{ runs: [...] }`). */
export interface AttestationListResult {
  attestations: AttestationListItem[];
}

/**
 * Map the injected DB read into the CLI envelope. `limit` / `runId` / `jobId`
 * are honored by the injected `read` fn (the real one is a Kysely query); this
 * runner owns only the row→envelope projection, so it stays pure and testable.
 */
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

/**
 * Build the real DB read: a Kysely query over `attestations`, newest first,
 * with optional run/job filters and a row cap.
 */
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
