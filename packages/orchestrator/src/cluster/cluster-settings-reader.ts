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
  /** @deprecated Readable, but no call site reads it. Removed at v1.0.0. */
  | 'contributor_cache_ttl_ms'
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
  | 'check_run_tracking_ttl_days'
  | 'concurrency_wait_timeout_ms'
  | 'agent_token_ttl_ms'
  | 'ownership_db_check_timeout_ms'
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
 * Ceiling for the three LRU entry-count knobs — `lockfile_cache_max`,
 * `content_cache_max`, and `global_eval_cache_max`.
 *
 * This is a boot-safety bound, not a policy preference. The underlying LRU
 * allocates its index arrays eagerly from `max` — several typed arrays plus the
 * TTL and size arrays the caches ask for — so the cost is paid at construction
 * with zero entries cached. Measured on the shipped version: an empty cache at
 * `max` 5,000,000 costs ~191 MB, and at 5,000,000,000 the constructor throws
 * `RangeError: Invalid array length`.
 *
 * That throw is what makes an unbounded knob dangerous rather than merely
 * wasteful. All three caches are built inside `bootstrapOrchestrator`, so a bad
 * stored value crashes the orchestrator before its admin API is listening —
 * and the admin API is the only way `kici-admin cluster-settings` can reach the
 * stored value. The knob would brick the very tool needed to un-brick it.
 *
 * 100,000 is 200x the shipped default of 500 and costs ~4 MB per empty cache,
 * so it is far above any plausible operator setting while keeping boot bounded.
 */
export const CACHE_MAX_ENTRIES_CEILING = 100_000;

/**
 * Bound a stored entry-count knob to something the LRU constructor survives.
 *
 * Applied at the read site rather than only at the write site, because the
 * write-side validation cannot reach a value that is already in the database —
 * set before the ceiling shipped, or written by any path other than the admin
 * route. Clamping here is what actually guarantees a stored value cannot
 * prevent boot.
 *
 * A value that is not a usable positive count (NaN, non-finite, below 1) falls
 * back to the configured default rather than clamping to 1: a 1-entry cache
 * thrashes silently, which is harder to diagnose than simply ignoring garbage.
 * The fallback is floored and bounded by the ceiling on the same path as the
 * stored value, so neither a fractional nor an above-ceiling configured default
 * can reach the LRU constructor as a non-integer or unclamped max — the
 * constructor rejects both, and either would prevent boot.
 */
export function clampCacheMaxEntries(value: number, fallback: number): number {
  const usable = !Number.isFinite(value) || value < 1 ? fallback : value;
  return Math.min(Math.floor(usable), CACHE_MAX_ENTRIES_CEILING);
}

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
   * Resolve a fleet-wide boolean knob without collapsing a read failure into a
   * default.
   *
   * There is deliberately no `getBoolean(column, fallback)` companion. The
   * security gate that consumes this must tell the reader's outcomes apart
   * itself: a stored `false` and a NULL both deny today, but they deny for
   * different reasons, and `{ ok: false }` must deny regardless of what the
   * configured default happens to be. A convenience wrapper that folded the
   * failure into the default would be safe only for as long as that default
   * stayed `false`. A caller that only needs a display value (the dashboard
   * status badge) folds `{ ok: false }` into the default explicitly at its own
   * site, where getting it wrong misreports a badge rather than opening a gate.
   */
  async tryGetBoolean(column: ClusterBooleanColumn): Promise<ClusterSettingRead<boolean>> {
    const { row, readable } = await this.loadSnapshot();
    if (!readable) return { ok: false };
    const value = row?.[column];
    return { ok: true, value: typeof value === 'boolean' ? value : null };
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
