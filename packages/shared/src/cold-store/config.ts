/**
 * Cold-store configuration types.
 *
 * section 5. Per-table defaults in DEFAULT_TABLE_CONFIG mirror the
 * design doc's table.
 */
import type { SharedS3Config } from '../s3-client.js';

/**
 * Per-table archival tuning parameters.
 *
 * A table's effective config is the global default, overridden by any
 * values from the YAML/env config, overridden by any per-org values
 * (Platform only) from `cold_store_org_overrides`.
 */
export interface ColdStoreTableConfig {
  /** Minimum age (in days) before a row is eligible to archive. */
  warmTtlDays: number;
  /**
   * Floor for total warm bytes per tenant per table. Below this, no
   * archival happens — even if rows are old. Prevents thrashing on
   * low-traffic tenants.
   */
  minWarmTenantBytes: number;
  /** Floor for chunk size. Smaller eligible sets are deferred. */
  minChunkBytes: number;
  /** Ceiling for chunk size. Larger eligible sets are split. */
  maxChunkBytes: number;
  /** Hard cap on rows archived per (table, tenant) per cycle. */
  maxRowsPerCycle: number;
  /** Whether the table's archival is enabled (kill switch). */
  enabled: boolean;
}

/**
 * Reasonable defaults — matches the design doc's section 5 table.
 * Concrete adapters can override any subset of these.
 */
export const DEFAULT_TABLE_CONFIG: ColdStoreTableConfig = {
  warmTtlDays: 30,
  minWarmTenantBytes: 5 * 1024 * 1024,
  minChunkBytes: 1 * 1024 * 1024,
  maxChunkBytes: 50 * 1024 * 1024,
  maxRowsPerCycle: 50_000,
  enabled: true,
};

/**
 * Top-level cold-store configuration passed to `BaseColdStore`.
 */
export interface ColdStoreConfig {
  /**
   * S3-compatible storage config. The `prefix` defaults to
   * `'cold-store/'` when unset.
   */
  storage: SharedS3Config;
  /**
   * Per-table overrides keyed by table name; unset tables use
   * DEFAULT_TABLE_CONFIG.
   */
  tables: Record<string, Partial<ColdStoreTableConfig>>;
  /** Global concurrency cap on in-flight S3 PUTs. Default 4. */
  s3Concurrency: number;
  /** Master feature toggle; when false, cycles no-op fast. */
  enabled: boolean;
}

/**
 * Merge DEFAULT_TABLE_CONFIG with overrides to produce the effective
 * per-table config.
 */
export function resolveTableConfig(
  overrides: Partial<ColdStoreTableConfig> | undefined,
): ColdStoreTableConfig {
  return {
    ...DEFAULT_TABLE_CONFIG,
    ...(overrides ?? {}),
  };
}
