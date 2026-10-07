import { sql, type Kysely } from 'kysely';
import type { ColdStoreTableConfig } from './config.js';

/**
 * Plumbing shared by the Postgres-backed cold-store table adapters: the
 * config merge, the per-partition advisory lock, and the date coercion
 * `decodeRow` applies after a JSON round-trip. Per-table SQL stays in each
 * subclass.
 */
export abstract class PgTableAdapterBase<DB> {
  readonly config: ColdStoreTableConfig;

  /**
   * `lockNamespace` is `cold-store|<db>|<table>`. It is part of the lock
   * identity every archiver replica computes, so changing it lets two
   * replicas archive the same partition during a rolling deploy.
   */
  protected constructor(
    protected readonly kdb: Kysely<DB>,
    private readonly lockNamespace: string,
    defaults: ColdStoreTableConfig,
    overrides: Partial<ColdStoreTableConfig> = {},
  ) {
    this.config = { ...defaults, ...overrides };
  }

  /**
   * Run `fn` while holding a session advisory lock on one dedicated pooled
   * connection, keyed by `hashtext('<lockNamespace>|<tenantId>|<partitionDate>')`,
   * so the lock and the unlock land on the same backend. Returns `null`
   * without running `fn` when another session holds the lock. `fn` runs its
   * own queries on the pool: the lock only serializes archivers, and the
   * eligibility predicate and DELETE are per-partition.
   */
  async withPartitionLock<T>(
    args: { tenantId: string; partitionDate: string },
    fn: () => Promise<T>,
  ): Promise<T | null> {
    const key = `${this.lockNamespace}|${args.tenantId}|${args.partitionDate}`;
    return await this.kdb.connection().execute(async (conn) => {
      const lockRes = await sql<{ locked: boolean }>`
        SELECT pg_try_advisory_lock(hashtext(${key})) AS locked
      `.execute(conn);
      const locked = lockRes.rows[0]?.locked === true;
      if (!locked) return null;
      try {
        return await fn();
      } finally {
        await sql`SELECT pg_advisory_unlock(hashtext(${key}))`.execute(conn).catch(() => undefined);
      }
    });
  }

  /** A JSON round-trip turns timestamp columns into ISO strings; restore `field` to a Date in place. */
  protected static coerceDate<T>(parsed: T, field: keyof T): void {
    const v = (parsed as unknown as Record<string, unknown>)[field as string];
    if (typeof v === 'string') {
      (parsed as unknown as Record<string, unknown>)[field as string] = new Date(v);
    }
  }
}
