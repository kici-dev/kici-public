/**
 * Audit logger for secrets management operations.
 *
 * Records all secret access/denial events to the secret_audit_log table
 * for compliance and security monitoring.
 *
 * Phase D: query() supports cold-store read-through via the optional
 * `coldStore` constructor argument and an `includeArchived` query
 * filter. Hot-only behavior is unchanged when neither is supplied.
 */
import type { Kysely } from 'kysely';
import type { ColdStore } from '@kici-dev/shared';
import type { Database, SecretAuditLogRow } from '../db/types.js';
import { shouldRecordSecretResolve, type AuditEntry } from '@kici-dev/engine';
import { loadSecretAuditLogRange } from '../cold-store/load-secret-audit-log-range.js';

/**
 * Audit logger that writes secret operation events to PostgreSQL.
 */
export class AuditLogger {
  private coldStore: ColdStore | undefined;

  constructor(
    private readonly db: Kysely<Database>,
    coldStore?: ColdStore,
  ) {
    this.coldStore = coldStore;
  }

  /**
   * Late-binding setter so the orchestrator-core wiring can build the
   * AuditLogger before the cold-store singleton (which depends on env
   * + S3 client init) and attach it later.
   */
  setColdStore(coldStore: ColdStore | null): void {
    this.coldStore = coldStore ?? undefined;
  }

  /**
   * Log a secret operation event.
   *
   * `resolve` / `resolve_named` allowed entries are sampled at 1% (per the
   * engine's `shouldRecordSecretResolve` helper) since they're written
   * once per JOB-step secret resolution and dwarf every other action's
   * volume. Denied resolves and every other action (`setSecret`,
   * `deleteSecret`, `rotateKey`, `secret-outputs.reveal`) bypass the
   * sampler — they are transactional with the mutation and must always
   * land.
   *
   * @param entry - The audit entry to record.
   */
  async log(entry: AuditEntry): Promise<void> {
    if (entry.action === 'resolve' || entry.action === 'resolve_named') {
      if (
        !shouldRecordSecretResolve({
          outcome: entry.outcome,
          runId: entry.runId,
          jobId: entry.jobId,
          userId: entry.userId,
          role: entry.role,
        })
      ) {
        return;
      }
    }
    await this.db
      .insertInto('secret_audit_log')
      .values({
        action: entry.action,
        context_name: entry.contextName,
        routing_key: entry.routingKey ?? null,
        secret_keys: entry.secretKeys ? JSON.stringify(entry.secretKeys) : null,
        outcome: entry.outcome,
        run_id: entry.runId ?? null,
        job_id: entry.jobId ?? null,
        user_id: entry.userId ?? null,
        role: entry.role ?? null,
        metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
      })
      .execute();
  }

  /**
   * Query audit log entries with optional filters.
   *
   * @param opts - Query filters and pagination.
   * @returns Matching audit log rows ordered by timestamp descending.
   */
  async query(opts: {
    contextName?: string;
    routingKey?: string;
    action?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
    /**
     * Phase D opt-in. When true, falls through to cold-store via
     * `loadSecretAuditLogRange` for any portion of the requested
     * window past the warm cutoff. Default false preserves the
     * original semantics.
     */
    includeArchived?: boolean;
  }): Promise<SecretAuditLogRow[]> {
    return loadSecretAuditLogRange({
      db: this.db,
      coldStore: this.coldStore,
      contextName: opts.contextName,
      routingKey: opts.routingKey,
      action: opts.action,
      fromTs: opts.from,
      toTs: opts.to,
      limit: opts.limit ?? 100,
      offset: opts.offset ?? 0,
      includeArchived: opts.includeArchived === true,
    });
  }
}
