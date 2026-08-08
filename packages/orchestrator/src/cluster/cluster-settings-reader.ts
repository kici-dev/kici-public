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
  | 'contributor_cache_ttl_ms'
  | 'event_router_event_ttl_seconds'
  | 'event_router_max_dispatch_attempts'
  | 'queue_max_depth'
  | 'reroute_flap_grace_ms'
  | 'max_fanout_hosts'
  | 'event_router_rate_limit_per_workflow_per_minute'
  | 'cache_max_tarball_bytes'
  | 'cache_ttl_days'
  | 'check_run_tracking_ttl_days'
  | 'concurrency_wait_timeout_ms'
  | 'agent_token_ttl_ms'
  | 'ownership_db_check_timeout_ms';

/** Text columns on cluster_settings readable via {@link ClusterSettingsReader}. */
export type ClusterStringColumn = 'dashboard_verified_issuer';

/**
 * A knob read that keeps "the operator never set this" separate from "we could
 * not read it".
 *
 * `{ ok: true, value: null }` is a genuine unset — a missing row, a null
 * column, or a cleared (empty) string. `{ ok: false }` means the query failed,
 * so the caller decides: most knobs want their cluster default, but one whose
 * default is a weaker trust tier must hold its last known value instead.
 */
export type ClusterSettingRead<T> = { ok: true; value: T | null } | { ok: false };

const DEFAULT_CACHE_TTL_MS = 10_000;

/**
 * Reads the single cluster_settings row (id='default') once per short TTL
 * window and serves every fleet-wide knob from that snapshot. `getNumber` and
 * `getString` degrade to the caller's `fallback` (the config.ts cluster
 * default) on no-db / missing row / null column / DB error, so a hot-path read
 * never blocks on a sick DB. {@link ClusterSettingsReader.tryGetString} is the
 * one exception: it reports a failed query as `{ ok: false }` rather than a
 * default, for the caller whose default would be a weaker trust tier.
 *
 * There is exactly one row, so a whole-row cache is strictly simpler than a
 * per-column cache: one DB hit per TTL window serves every column and every
 * read-site.
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
   * The cached row plus whether it reflects a successful read.
   *
   * `readable` lives on the cache entry, not around the query, because the
   * negative cache serves reads 2..N of a TTL window without touching the DB:
   * deriving "unreadable" from the catch alone would report those reads as a
   * genuine unset.
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

  /** Resolve a fleet-wide numeric knob; `fallback` is the config.ts cluster default. */
  async getNumber(column: ClusterNumberColumn, fallback: number): Promise<number> {
    const row = await this.loadRow();
    const value = row?.[column];
    return value != null ? Number(value) : fallback;
  }

  /**
   * Resolve a fleet-wide text knob; `fallback` is the config.ts cluster default
   * (which may itself be null). An empty stored string is treated as unset so an
   * operator clearing the knob via the admin API behaves like a NULL.
   */
  async getString(column: ClusterStringColumn, fallback: string | null): Promise<string | null> {
    const row = await this.loadRow();
    const value = row?.[column];
    return typeof value === 'string' && value.length > 0 ? value : fallback;
  }

  /**
   * Resolve a fleet-wide text knob without collapsing a read failure into a
   * default.
   *
   * There is deliberately no `fallback` parameter: the point of this variant is
   * that the caller — not the reader — decides what an unreadable knob means.
   * An empty stored string is unset, matching {@link getString}.
   */
  async tryGetString(column: ClusterStringColumn): Promise<ClusterSettingRead<string>> {
    const { row, readable } = await this.loadSnapshot();
    if (!readable) return { ok: false };
    const value = row?.[column];
    return { ok: true, value: typeof value === 'string' && value.length > 0 ? value : null };
  }

  /**
   * The cluster_settings row version last seen in the cache (0 if never loaded).
   *
   * Synchronous — never awaits a DB read — so the heartbeat timer can read it
   * safely and advertise it to workers. When the cache is cold or expired it
   * kicks a non-blocking refresh so the advertised version self-heals within a
   * cache-TTL window without depending on a `getNumber()` call, then returns
   * the last-loaded value.
   */
  getCachedVersion(): number {
    if (this.db && (!this.cache || this.cache.expiresAt <= Date.now())) {
      void this.loadRow().catch(() => {});
    }
    const v = this.cache?.row?.version;
    return v != null ? Number(v) : 0;
  }
}
