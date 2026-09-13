import { sql, type Kysely } from 'kysely';
import type { AttestationOrigin } from '@kici-dev/engine';
import type { Database, PendingAttestationRow } from '../db/types.js';

/** The non-`live` AttestationOrigin values a pending row can carry. */
export type PendingAttestationOrigin = Exclude<AttestationOrigin, 'live'>;

export interface PendingAttestationInput {
  id: string;
  runId: string;
  jobId: string;
  subjectName: string;
  subjectDigest: string;
  audience: string;
  dsseEnvelope: unknown;
  publicKey: unknown;
  mediaType: string;
  statementHash: string;
  originKind: PendingAttestationOrigin;
}

export type { PendingAttestationRow } from '../db/types.js';

/** Typed CRUD over the deferred-attestation outbox (shared orchestrator DB). */
export class PendingAttestationsRepo {
  constructor(private readonly db: Kysely<Database>) {}

  /** Insert a pending row; re-deferring the same subject is a no-op. */
  async insert(row: PendingAttestationInput): Promise<void> {
    await this.db
      .insertInto('pending_attestations')
      .values({
        id: row.id,
        run_id: row.runId,
        job_id: row.jobId,
        subject_name: row.subjectName,
        subject_digest: row.subjectDigest,
        audience: row.audience,
        dsse_envelope: JSON.stringify(row.dsseEnvelope),
        public_key: JSON.stringify(row.publicKey),
        media_type: row.mediaType,
        statement_hash: row.statementHash,
        origin_kind: row.originKind,
      })
      .onConflict((oc) => oc.columns(['run_id', 'job_id', 'subject_digest']).doNothing())
      .execute();
  }

  /**
   * List pending rows oldest-first, optionally scoped to a run. Terminally
   * rejected rows (`rejected_at IS NOT NULL`) are excluded — the retrier never
   * re-picks a row the Platform definitively cannot mint.
   */
  async list(opts: { runId?: string; limit?: number } = {}): Promise<PendingAttestationRow[]> {
    let q = this.db
      .selectFrom('pending_attestations')
      .selectAll()
      .where('rejected_at', 'is', null)
      .orderBy('created_at', 'asc');
    if (opts.runId) q = q.where('run_id', '=', opts.runId);
    if (opts.limit) q = q.limit(opts.limit);
    return (await q.execute()) as unknown as PendingAttestationRow[];
  }

  /** Bump the attempt counter + record the last error on a still-failing retry. */
  async recordAttempt(id: string, lastError: string | null): Promise<void> {
    await this.db
      .updateTable('pending_attestations')
      .set({
        attempt_count: sql`attempt_count + 1`,
        last_attempt_at: new Date(),
        last_error: lastError,
      })
      .where('id', '=', id)
      .execute();
  }

  /** Remove a fulfilled pending row. */
  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('pending_attestations').where('id', '=', id).execute();
  }

  /**
   * Outbox depth + oldest entry, feeding the metrics gauges. Terminally rejected
   * rows are excluded so the pending gauge reflects only truly-pending rows.
   */
  async countAndOldest(): Promise<{ count: number; oldestCreatedAt: Date | null }> {
    const row = await this.db
      .selectFrom('pending_attestations')
      .where('rejected_at', 'is', null)
      .select((eb) => [eb.fn.countAll<string>().as('count'), eb.fn.min('created_at').as('oldest')])
      .executeTakeFirst();
    return {
      count: Number(row?.count ?? 0),
      oldestCreatedAt: (row?.oldest as Date | null) ?? null,
    };
  }

  /**
   * Terminally reject a pending row: the Platform definitively cannot mint it
   * (run/job absent). Stamps rejected_at, records the reason, and bumps the
   * attempt counter. The row stays for audit but is skipped by list()/counts.
   */
  async markRejected(id: string, reason: string): Promise<void> {
    await this.db
      .updateTable('pending_attestations')
      .set({
        rejected_at: new Date(),
        last_attempt_at: new Date(),
        last_error: reason,
        attempt_count: sql`attempt_count + 1`,
      })
      .where('id', '=', id)
      .execute();
  }

  /** Count terminally-rejected rows (feeds the rejected-attestations gauge). */
  async countRejected(): Promise<number> {
    const row = await this.db
      .selectFrom('pending_attestations')
      .where('rejected_at', 'is not', null)
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  /**
   * Re-arm terminally-rejected rows so the next drain re-attempts them (used
   * after an operator fixes the Platform-side run/job). Scoped to a run when
   * runId is given, else clears every rejected row. Returns the count re-armed.
   */
  async clearRejected(opts: { runId?: string } = {}): Promise<number> {
    let q = this.db
      .updateTable('pending_attestations')
      .set({ rejected_at: null })
      .where('rejected_at', 'is not', null);
    if (opts.runId) q = q.where('run_id', '=', opts.runId);
    const res = await q.executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0);
  }
}
