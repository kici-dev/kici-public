/**
 * Raft-leader-only fulfilment of deferred attestations. For each pending row
 * (oldest-first) it optionally backfills the run/job rows the Platform's mint
 * needs (offline-backfill), mints the deferred token bound to the frozen
 * statement hash, attaches it to the frozen DSSE envelope, uploads the bundle,
 * records one `attestations` row (idempotent across the cluster), and drains the
 * pending row. A transiently-failing mint leaves the row with a bumped attempt
 * count and a `last_error` — never silently dropped. A definitive Platform
 * rejection (run/job absent) is terminal: the row is stamped `rejected_at`,
 * skipped by future drains, and re-armed only via
 * `kici-admin attestations retry --include-rejected`.
 *
 * Lifecycle mirrors `StaleRunDetector`: a timer runs only while this instance is
 * the Raft leader (so each pending attestation mints exactly once cluster-wide),
 * plus an on-reconnect `triggerNow()` when the Platform WS re-authenticates.
 */
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type {
  PendingAttestationsRepo,
  PendingAttestationRow,
} from './pending-attestations-repo.js';

const logger = createLogger({ prefix: 'attestation-retrier' });

/** A minted token, a still-transient deferral, or a terminal rejection. */
export type RetrierMintResult =
  | { token: string; expiresIn: number; jti: string }
  | { deferred: true; code: string }
  | { rejected: true; reason: string };

export interface AttestationRetrierDeps {
  repo: PendingAttestationsRepo;
  /** Mint the deferred token (the OIDC relay with deferred params, Task 5). */
  requestMint: (args: {
    orchestratorId: string;
    runId: string;
    jobId: string;
    audience: string;
    deferred: { statementHash: string; origin: 'deferred' | 'offline-backfill' };
  }) => Promise<RetrierMintResult>;
  /** Assemble + upload the bundle to object storage (initMeta included). */
  uploadBundle: (args: {
    runId: string;
    jobId: string;
    subjectDigest: string;
    bundle: Record<string, unknown>;
    storageKey: string;
  }) => Promise<void>;
  computeVerdict: (storageKey: string) => Promise<{
    verifyStatus: string;
    verifyReason: string | null;
    verifiedAt: Date | null;
  }>;
  recordAttestation: (args: {
    runId: string;
    jobId: string;
    subjectName: string;
    subjectDigest: string;
    storageKey: string;
    mediaType: string;
    verifyStatus: string;
    verifyReason: string | null;
    verifiedAt: Date | null;
  }) => Promise<void>;
  /** Replay the run/job rows the Platform missed (offline-backfill only). */
  backfillRun: (runId: string) => Promise<void>;
  setMetrics: (count: number, oldestCreatedAt: Date | null, rejected: number) => void;
  isLeader: () => boolean;
  orchestratorId: string;
  intervalMs: number;
  provenanceStorageKey: (runId: string, jobId: string, subjectDigest: string) => string;
}

export class AttestationRetrier {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  constructor(private readonly deps: AttestationRetrierDeps) {}

  /**
   * Start the periodic timer. Each tick self-gates on `isLeader()`, so it is
   * safe to start on every instance — only the current Raft leader acts, and
   * the `attestations` unique index makes fulfilment idempotent regardless.
   */
  start(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(() => {
      void this.tick();
    }, this.deps.intervalMs);
    void this.tick();
  }

  onBecomeLeader(): void {
    if (this.interval) clearInterval(this.interval);
    logger.info('Became leader, starting attestation retrier');
    this.interval = setInterval(() => {
      void this.tick();
    }, this.deps.intervalMs);
    void this.tick();
  }

  onLoseLeadership(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    logger.info('Lost leadership, stopped attestation retrier');
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  /** On-reconnect trigger (Platform WS re-authenticated). Leader-gated inside tick. */
  triggerNow(): void {
    void this.tick();
  }

  async tick(): Promise<void> {
    if (!this.deps.isLeader() || this.running) return;
    this.running = true;
    try {
      const pending = await this.deps.repo.list({ limit: 50 });
      for (const row of pending) {
        if (!this.deps.isLeader()) break;
        try {
          await this.fulfilOne(row);
        } catch (err) {
          logger.error('Attestation fulfilment error', { id: row.id, error: toErrorMessage(err) });
        }
      }
      const { count, oldestCreatedAt } = await this.deps.repo.countAndOldest();
      const rejected = await this.deps.repo.countRejected();
      this.deps.setMetrics(count, oldestCreatedAt, rejected);
    } finally {
      this.running = false;
    }
  }

  /**
   * Fulfil the targeted pending rows once and report counts. Used by the manual
   * `kici-admin attestations retry` path (via the orchestrator admin API): the
   * operator explicitly requested a drain, so this is NOT leader-gated — the
   * `attestations` unique index keeps a concurrent leader tick idempotent.
   */
  async runOnce(
    opts: { runId?: string; includeRejected?: boolean } = {},
  ): Promise<{ minted: number; stillPending: number; rejected: number }> {
    if (opts.includeRejected) {
      // Re-arm previously-rejected rows so this pass re-attempts them.
      await this.deps.repo.clearRejected(opts.runId ? { runId: opts.runId } : {});
    }
    const rows = await this.deps.repo.list(opts.runId ? { runId: opts.runId } : {});
    let minted = 0;
    let stillPending = 0;
    let rejected = 0;
    for (const row of rows) {
      const outcome = await this.fulfilOne(row);
      if (outcome === 'minted') minted += 1;
      else if (outcome === 'rejected') rejected += 1;
      else stillPending += 1;
    }
    const { count, oldestCreatedAt } = await this.deps.repo.countAndOldest();
    const rejectedCount = await this.deps.repo.countRejected();
    this.deps.setMetrics(count, oldestCreatedAt, rejectedCount);
    return { minted, stillPending, rejected };
  }

  async fulfilOne(row: PendingAttestationRow): Promise<'minted' | 'rejected' | 'deferred'> {
    try {
      if (row.origin_kind === 'offline-backfill') {
        // Backfill -> then mint (ordered): the Platform learns the run/job rows
        // its mint reads before we ask it to mint.
        await this.deps.backfillRun(row.run_id);
      }
      const minted = await this.deps.requestMint({
        orchestratorId: this.deps.orchestratorId,
        runId: row.run_id,
        jobId: row.job_id,
        audience: row.audience,
        deferred: {
          statementHash: row.statement_hash,
          origin: row.origin_kind as 'deferred' | 'offline-backfill',
        },
      });
      if ('rejected' in minted) {
        // The Platform definitively cannot mint this row (run/job absent). This
        // is a terminal answer, not a transient blip: park the row so the
        // retrier stops re-attempting it and the pending gauge drains.
        await this.deps.repo.markRejected(row.id, minted.reason);
        logger.warn('Deferred attestation permanently rejected; will not retry', {
          id: row.id,
          runId: row.run_id,
          reason: minted.reason,
        });
        return 'rejected';
      }
      if ('deferred' in minted) {
        await this.deps.repo.recordAttempt(row.id, `mint still ${minted.code}`);
        return 'deferred';
      }
      const storageKey = this.deps.provenanceStorageKey(row.run_id, row.job_id, row.subject_digest);
      const bundle = {
        mediaType: row.media_type,
        dsseEnvelope: row.dsse_envelope,
        verificationMaterial: { publicKey: row.public_key, identityToken: minted.token },
      } as Record<string, unknown>;
      await this.deps.uploadBundle({
        runId: row.run_id,
        jobId: row.job_id,
        subjectDigest: row.subject_digest,
        bundle,
        storageKey,
      });
      const verdict = await this.deps.computeVerdict(storageKey);
      await this.deps.recordAttestation({
        runId: row.run_id,
        jobId: row.job_id,
        subjectName: row.subject_name,
        subjectDigest: row.subject_digest,
        storageKey,
        mediaType: row.media_type,
        verifyStatus: verdict.verifyStatus,
        verifyReason: verdict.verifyReason,
        verifiedAt: verdict.verifiedAt,
      });
      await this.deps.repo.delete(row.id);
      logger.info('Deferred attestation minted + recorded', { id: row.id, runId: row.run_id });
      return 'minted';
    } catch (err) {
      await this.deps.repo.recordAttempt(row.id, toErrorMessage(err));
      logger.warn('Deferred attestation still failing; left in queue', {
        id: row.id,
        attempt: row.attempt_count + 1,
        error: toErrorMessage(err),
      });
      return 'deferred';
    }
  }
}
