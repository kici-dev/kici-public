import type { Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { Database, ClusterSettings } from '../db/types.js';

const logger = createLogger({ prefix: 'orch:cluster-settings' });

/** Numeric columns on cluster_settings readable via {@link ClusterSettingsReader}. */
export type ClusterNumberColumn =
  | 'max_github_payload_bytes'
  | 'event_log_max_payload_bytes'
  | 'lock_file_max_bytes'
  | 'webhook_dedup_ttl_ms'
  | 'event_router_event_ttl_seconds'
  | 'event_router_max_dispatch_attempts'
  | 'queue_max_depth'
  | 'reroute_flap_grace_ms'
  | 'max_fanout_hosts'
  | 'event_router_rate_limit_per_workflow_per_minute'
  | 'cache_max_tarball_bytes'
  | 'cache_ttl_days'
  | 'lockfile_cache_max'
  | 'lockfile_cache_max_bytes'
  | 'lockfile_cache_ttl_ms'
  | 'content_cache_max'
  | 'content_cache_max_bytes'
  | 'content_cache_ttl_ms'
  | 'global_eval_round_timeout_ms'
  | 'global_eval_candidate_timeout_ms'
  | 'global_eval_cache_max'
  | 'global_eval_wait_timeout_ms'
  | 'firecracker_api_socket_wait_ms'
  | 'check_run_tracking_ttl_days'
  | 'run_retention_days'
  | 'audit_retention_days'
  | 'provenance_retention_days'
  | 'held_run_retention_days'
  | 'concurrency_wait_timeout_ms'
  | 'agent_token_ttl_ms'
  | 'ownership_db_check_timeout_ms'
  | 'sealed_secrets_retry_backoff_ms'
  | 'unroutable_grace_ms'
  | 'ingest_overflow_claim_timeout_ms'
  | 'scaler_reap_interval_ms'
  | 'scaler_reap_stranded_timeout_ms'
  | 'scaler_reap_reattempt_interval_ms'
  | 'scaler_claim_retention_ms'
  | 'scaler_provision_backoff_base_ms'
  | 'scaler_provision_backoff_max_ms'
  | 'scaler_provision_max_consecutive_failures';

/** Text columns on cluster_settings readable via {@link ClusterSettingsReader}. */
export type ClusterStringColumn = 'dashboard_verified_issuer';

/** Boolean columns on cluster_settings readable via {@link ClusterSettingsReader}. */
export type ClusterBooleanColumn = 'global_workflows_enabled';

/**
 * Boot-safety ceiling for `lockfile_cache_max`, `content_cache_max` and
 * `global_eval_cache_max`, not a policy preference.
 *
 * The LRU allocates its index, TTL and size arrays eagerly from `max`, so the
 * cost is paid with zero entries cached: `max` 5,000,000 costs ~191 MB empty,
 * and 5,000,000,000 throws `RangeError: Invalid array length`. All three caches
 * are built inside `bootstrapOrchestrator`, so a bad stored value crashes the
 * orchestrator before its admin API — the only way `kici-admin cluster-settings`
 * reaches the value — is listening.
 *
 * 100,000 is 200x the shipped default of 500 and costs ~4 MB per empty cache.
 */
export const CACHE_MAX_ENTRIES_CEILING = 100_000;

/**
 * Bound a stored entry-count knob to something the LRU constructor survives.
 *
 * Applied at the read site because write-side validation cannot reach a value
 * already in the database (set before the ceiling shipped, or by a path other
 * than the admin route).
 *
 * A non-usable count (NaN, non-finite, below 1) falls back to the configured
 * default rather than clamping to 1: a 1-entry cache thrashes silently. The
 * fallback is floored and clamped on the same path, because the constructor
 * rejects a non-integer or unclamped max and either would prevent boot.
 */
export function clampCacheMaxEntries(value: number, fallback: number): number {
  const usable = !Number.isFinite(value) || value < 1 ? fallback : value;
  return Math.min(Math.floor(usable), CACHE_MAX_ENTRIES_CEILING);
}

/**
 * A knob read that keeps "never set" separate from "could not read".
 *
 * `{ ok: true, value: null }` is a genuine unset (missing row, null column,
 * cleared string). `{ ok: false }` means the query failed: most knobs want
 * their cluster default, but one whose default is a weaker trust tier must
 * hold its last known value instead.
 */
export type ClusterSettingRead<T> = { ok: true; value: T | null } | { ok: false };

const DEFAULT_CACHE_TTL_MS = 10_000;

/**
 * Reads the single cluster_settings row (id='default') once per short TTL
 * window and serves every fleet-wide knob from that whole-row snapshot.
 * `getNumber` and `getString` degrade to the caller's `fallback` (the config.ts
 * cluster default) on no-db / missing row / null column / DB error, so a
 * hot-path read never blocks on a sick DB. {@link ClusterSettingsReader.tryGetString}
 * instead reports a failed query as `{ ok: false }`, for the caller whose
 * default would be a weaker trust tier.
 *
 * There is exactly one row, so a whole-row cache is simpler than a per-column
 * one: one DB hit per TTL window serves every column and every read-site.
 */
export class ClusterSettingsReader {
  private cache: {
    row: ClusterSettings | undefined;
    /** False when this entry came from a failed query rather than a real read. */
    readable: boolean;
    expiresAt: number;
  } | null = null;

  constructor(
    private readonly db: Kysely<Database> | undefined,
    private readonly cacheTtlMs: number = DEFAULT_CACHE_TTL_MS,
  ) {}

  /**
   * `readable` lives on the cache entry, not around the query, because the
   * negative cache serves reads 2..N of a TTL window without touching the DB;
   * deriving it from the catch alone would report those reads as a genuine unset.
   */
  private async loadSnapshot(): Promise<{ row: ClusterSettings | undefined; readable: boolean }> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return { row: this.cache.row, readable: this.cache.readable };
    }
    if (!this.db) {
      // No cluster_settings to read at all, so unset IS the truth here; calling
      // it unreadable would make a holding caller hold its value forever.
      this.cache = { row: undefined, readable: true, expiresAt: now + this.cacheTtlMs };
      return { row: undefined, readable: true };
    }
    try {
      const row = await this.db
        .selectFrom('cluster_settings')
        .selectAll()
        .where('id', '=', 'default')
        .executeTakeFirst();
      this.cache = { row, readable: true, expiresAt: now + this.cacheTtlMs };
      return { row, readable: true };
    } catch (err) {
      logger.warn('Failed to read cluster_settings, using cluster defaults', {
        error: toErrorMessage(err),
      });
      // Negative-cache to avoid hammering a sick DB within the window.
      this.cache = { row: undefined, readable: false, expiresAt: now + this.cacheTtlMs };
      return { row: undefined, readable: false };
    }
  }

  private async loadRow(): Promise<ClusterSettings | undefined> {
    return (await this.loadSnapshot()).row;
  }

  /**
   * The whole row from one read (undefined on no row or a failed read), for a
   * caller needing columns that agree, such as a value and its row version.
   */
  async getRow(): Promise<ClusterSettings | undefined> {
    return this.loadRow();
  }

  /** Resolve a fleet-wide numeric knob; `fallback` is the config.ts cluster default. */
  async getNumber(column: ClusterNumberColumn, fallback: number): Promise<number> {
    const row = await this.loadRow();
    const value = row?.[column];
    return value != null ? Number(value) : fallback;
  }

  /**
   * `fallback` is the config.ts cluster default (may be null). An empty stored
   * string is unset, so clearing the knob via the admin API behaves like a NULL.
   */
  async getString(column: ClusterStringColumn, fallback: string | null): Promise<string | null> {
    const row = await this.loadRow();
    const value = row?.[column];
    return typeof value === 'string' && value.length > 0 ? value : fallback;
  }

  /**
   * Resolve a text knob without collapsing a read failure into a default:
   * deliberately no `fallback`, so the caller decides what an unreadable knob
   * means. An empty stored string is unset, matching {@link getString}.
   */
  async tryGetString(column: ClusterStringColumn): Promise<ClusterSettingRead<string>> {
    const { row, readable } = await this.loadSnapshot();
    if (!readable) return { ok: false };
    const value = row?.[column];
    return { ok: true, value: typeof value === 'string' && value.length > 0 ? value : null };
  }

  /**
   * Resolve a boolean knob without collapsing a read failure into a default.
   *
   * Deliberately no `getBoolean(column, fallback)` companion: the consuming
   * security gate must deny on `{ ok: false }` whatever the configured default
   * is, and a wrapper folding failure into the default is safe only while that
   * default stays `false`. A display-only caller (the dashboard status badge)
   * folds `{ ok: false }` into the default at its own site, where a mistake
   * misreports a badge rather than opening a gate.
   */
  async tryGetBoolean(column: ClusterBooleanColumn): Promise<ClusterSettingRead<boolean>> {
    const { row, readable } = await this.loadSnapshot();
    if (!readable) return { ok: false };
    const value = row?.[column];
    return { ok: true, value: typeof value === 'boolean' ? value : null };
  }

  /**
   * The row version last seen in the cache (0 if never loaded).
   *
   * Synchronous, so the heartbeat timer can advertise it to workers. A cold or
   * expired cache kicks a non-blocking refresh, so the advertised version
   * self-heals within a TTL window without a `getNumber()` call; this call
   * returns the last-loaded value.
   */
  getCachedVersion(): number {
    if (this.db && (!this.cache || this.cache.expiresAt <= Date.now())) {
      void this.loadRow().catch(() => {});
    }
    const v = this.cache?.row?.version;
    return v != null ? Number(v) : 0;
  }
}
