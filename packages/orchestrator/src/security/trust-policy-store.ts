/**
 * Cache of the Platform-owned org trust policy.
 *
 * The Platform is the authority for a Platform-attached org and pushes the
 * policy on `trust_policy.update`; this store persists it so the policy survives
 * a restart instead of being unknown until the next push. In independent mode
 * there is no Platform, so the operator writes the same row via
 * `kici-admin trust-policy set` and `source` records which wrote it.
 */
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import { z } from 'zod';
import {
  DEFAULT_APPROVAL_EXPIRY_HOURS,
  DEFAULT_APPROVAL_EXPIRY_SECONDS,
  approvalExpiryHoursOf,
  approvalExpirySecondsOf,
} from '@kici-dev/engine';
import type { TrustPolicy } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import { DEFAULT_FORK_POLICY } from './trust-policy-gate.js';

/** Who wrote the cached policy row. */
export const TrustPolicySource = z.enum(['platform', 'local']);
export type TrustPolicySource = z.infer<typeof TrustPolicySource>;

/**
 * The strictest documented defaults. Used to fill gaps on a local merge; the
 * fail-closed policy an unknown org resolves to lives in `trust-policy-gate.ts`.
 *
 * `forkPolicy` reads that module's `DEFAULT_FORK_POLICY` so a partial local
 * merge and an absent row settle on the same fork switch.
 */
export const DEFAULT_TRUST_POLICY: TrustPolicy = {
  forkPolicy: DEFAULT_FORK_POLICY,
  unknownContributorPolicy: 'hold',
  workflowChangePolicy: 'hold',
  approvalExpiryHours: DEFAULT_APPROVAL_EXPIRY_HOURS,
  approvalExpirySeconds: DEFAULT_APPROVAL_EXPIRY_SECONDS,
};

/**
 * Resolve a local patch's approval-expiry window against what is already stored.
 *
 * One value is being set, spelled two ways, so the pair is merged as a unit and
 * always re-derived from the winning seconds value:
 *
 * - a patch naming `approvalExpirySeconds` sets the window, and the hours field
 *   is recomputed from it — a stale hours value left behind would be the coarse
 *   view of a window that is no longer stored;
 * - a patch naming only `approvalExpiryHours` sets the window too, and the
 *   seconds field is recomputed from it — keeping the old seconds value would
 *   let it out-rank the operator's explicit hours and silently discard the
 *   write;
 * - a patch naming both takes the seconds value, because it is the more
 *   specific of the two (`approvalExpirySecondsOf`);
 * - a patch naming neither leaves the stored window untouched.
 */
function mergedExpiry(
  patch: Partial<TrustPolicy>,
  existing: StoredTrustPolicy | null,
): Pick<TrustPolicy, 'approvalExpiryHours' | 'approvalExpirySeconds'> {
  const patched =
    patch.approvalExpirySeconds != null || patch.approvalExpiryHours != null
      ? approvalExpirySecondsOf(patch)
      : null;
  const seconds =
    patched ??
    existing?.approvalExpirySeconds ??
    DEFAULT_TRUST_POLICY.approvalExpirySeconds ??
    DEFAULT_APPROVAL_EXPIRY_SECONDS;
  return { approvalExpiryHours: approvalExpiryHoursOf(seconds), approvalExpirySeconds: seconds };
}

/**
 * Namespace for the per-org advisory lock taken by `upsertLocal`, so the key
 * cannot collide with another feature's advisory lock in the same database.
 */
const UPSERT_LOCK_NAMESPACE = 'org-trust-policy-upsert';

/** A policy as stored, with its provenance. */
export interface StoredTrustPolicy extends TrustPolicy {
  source: TrustPolicySource;
  updatedAt: Date;
}

export class TrustPolicyStore {
  constructor(private readonly db: Kysely<Database>) {}

  /** `executor` lets a caller read inside its own transaction. */
  async get(
    orgId: string,
    executor: Kysely<Database> | Transaction<Database> = this.db,
  ): Promise<StoredTrustPolicy | null> {
    const row = await executor
      .selectFrom('org_trust_policy')
      .selectAll()
      .where('customer_id', '=', orgId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      forkPolicy: row.fork_policy as TrustPolicy['forkPolicy'],
      unknownContributorPolicy:
        row.unknown_contributor_policy as TrustPolicy['unknownContributorPolicy'],
      workflowChangePolicy: row.workflow_change_policy as TrustPolicy['workflowChangePolicy'],
      // The seconds column is authoritative; a NULL one means the row predates
      // it (or an older build wrote it), so the hours column supplies the
      // window instead. Resolved here, once, so no caller has to know the rule.
      approvalExpiryHours: Number(row.approval_expiry_hours),
      approvalExpirySeconds: approvalExpirySecondsOf({
        approvalExpiryHours: Number(row.approval_expiry_hours),
        approvalExpirySeconds:
          row.approval_expiry_seconds == null ? null : Number(row.approval_expiry_seconds),
      }),
      source: row.source as TrustPolicySource,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Needs no lock, unlike `upsertLocal`: a push carries every field, so there
   * is no read-merge to lose and concurrent pushes correctly settle on the
   * last one. The two writers also never overlap — `upsertLocal` is reachable
   * only in independent mode, where no Platform pushes.
   */
  async upsertFromPlatform(orgId: string, policy: TrustPolicy): Promise<void> {
    await this.write(orgId, policy, TrustPolicySource.enum.platform);
  }

  /**
   * Write an operator-supplied policy. Only reachable in independent mode — the
   * admin route refuses on a Platform-attached orchestrator, because the next
   * push would clobber the write.
   *
   * The read-merge-write is serialised per org by a transaction-scoped
   * advisory lock. The transaction alone would NOT give that: under READ
   * COMMITTED two concurrent PATCHes both read the pre-existing row, and the
   * second `ON CONFLICT DO UPDATE` then overwrites every column from its own
   * stale merge — silently dropping the first operator's change (a tightened
   * `unknownContributorPolicy` reverting to whatever the second caller last
   * saw). The lock releases on commit or rollback, so there is no unlock to
   * leak.
   *
   * `onWrite` receives the same transaction and the merged result, so an audit
   * row written there commits or rolls back with the policy itself — a
   * loosened `forkPolicy` can never land unattributed.
   *
   * Returns the merged policy so the caller does not need a second read (which
   * would be outside the transaction and could observe a later write).
   */
  async upsertLocal(
    orgId: string,
    patch: Partial<TrustPolicy>,
    onWrite?: (trx: Transaction<Database>, merged: TrustPolicy) => Promise<void>,
  ): Promise<TrustPolicy> {
    return await this.db.transaction().execute(async (trx) => {
      // Must precede the read: the lock is what orders this merge against a
      // concurrent one, so taking it after the SELECT would order nothing.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`${UPSERT_LOCK_NAMESPACE}|${orgId}`}))`.execute(
        trx,
      );
      const existing = await this.get(orgId, trx);
      const merged: TrustPolicy = {
        forkPolicy: patch.forkPolicy ?? existing?.forkPolicy ?? DEFAULT_TRUST_POLICY.forkPolicy,
        unknownContributorPolicy:
          patch.unknownContributorPolicy ??
          existing?.unknownContributorPolicy ??
          DEFAULT_TRUST_POLICY.unknownContributorPolicy,
        workflowChangePolicy:
          patch.workflowChangePolicy ??
          existing?.workflowChangePolicy ??
          DEFAULT_TRUST_POLICY.workflowChangePolicy,
        // Resolved from the patch as a WHOLE, not field-by-field: a patch
        // naming only seconds must not keep a stale hours value beside it, and
        // a patch naming only hours must not keep a stale seconds value that
        // would then out-rank it. Merging the two fields independently is
        // exactly how the coarse and fine spellings come to disagree.
        ...mergedExpiry(patch, existing),
      };
      await this.write(orgId, merged, TrustPolicySource.enum.local, trx);
      await onWrite?.(trx, merged);
      return merged;
    });
  }

  private async write(
    orgId: string,
    policy: TrustPolicy,
    source: TrustPolicySource,
    executor: Kysely<Database> | Transaction<Database> = this.db,
  ): Promise<void> {
    // One window, written to both columns from the same resolved value. The
    // hours column is derived rather than copied through, so a policy that
    // arrived with only seconds can never leave a stale hours value behind for
    // an older build to read — and the two columns cannot disagree.
    const seconds = approvalExpirySecondsOf(policy);
    const columns = {
      fork_policy: policy.forkPolicy,
      unknown_contributor_policy: policy.unknownContributorPolicy,
      workflow_change_policy: policy.workflowChangePolicy,
      approval_expiry_hours: approvalExpiryHoursOf(seconds),
      approval_expiry_seconds: seconds,
      source,
      updated_at: sql<Date>`now()`,
    };
    await executor
      .insertInto('org_trust_policy')
      .values({ customer_id: orgId, ...columns })
      .onConflict((oc) => oc.column('customer_id').doUpdateSet(columns))
      .execute();
  }
}

/**
 * Build a TrustPolicyStore backed by its own connection pool to the given
 * orchestrator database URL. Mirrors `createHeldRunStoreFromUrl`; consumed by
 * E2E tests that assert the pushed policy is persisted in the real deployed
 * orchestrator DB rather than held in process memory.
 */
export function createTrustPolicyStoreFromUrl(
  databaseUrl: string,
  opts?: { maxConnections?: number },
): { store: TrustPolicyStore; dispose: () => Promise<void> } {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: opts?.maxConnections ?? 3 });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return {
    store: new TrustPolicyStore(db),
    dispose: async () => {
      await db.destroy();
    },
  };
}
