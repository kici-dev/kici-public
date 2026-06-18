/**
 * Cold-store domain metrics.
 *
 * These are the "how much data moved through cold-store" metrics;
 * complements (but does not overlap with) the scheduler-layer
 * metrics (`kici_{platform,orch}_job_*`) owned by the scheduled-job
 * wrappers.
 *
 * `cold_store_archive_cycles_total` is always-non-zero — incremented
 * on every `runArchiveCycle()` call with a `result` label — so the
 * meter scope + instrument metadata always surface on /metrics.
 * This is the counterpart to the design doc's original "zero-add
 * trick": `@opentelemetry/exporter-prometheus` 0.213.0 filters out
 * counters whose only observations are `.add(0)`, so we need a
 * guaranteed-non-zero counter to keep the series visible.
 *
 * `cold_store_archive_rows_total` stays dormant (hidden) until a
 * Phase B+ `TableAdapter` actually archives rows — at which point
 * its samples appear naturally.
 *
 * Lazy meter initialization: the `@kici-dev/shared` barrel is imported
 * statically at the top of service entry points (server.ts, worker.ts),
 * which evaluates this module BEFORE `initTelemetry()` sets the global
 * MeterProvider. If we call `createMeter('kici-cold-store')` at module
 * load time, the returned ProxyMeter binds to the no-op provider and
 * its instruments never reach the Prometheus exporter. Resolving the
 * meter + instruments on first access (inside `getCold...()` getters)
 * guarantees we resolve AFTER telemetry is wired up.
 */
import type { Counter, Histogram, Meter } from '@opentelemetry/api';
import { createMeter } from '../telemetry/metrics.js';

let _meter: Meter | undefined;
function meter(): Meter {
  if (!_meter) _meter = createMeter('kici-cold-store');
  return _meter;
}

let _archiveCyclesTotal: Counter | undefined;
let _archiveRowsTotal: Counter | undefined;
let _archiveBytesTotal: Counter | undefined;
let _archiveDurationSeconds: Histogram | undefined;
let _rehydrateRequestsTotal: Counter | undefined;
let _rehydrateBytesTotal: Counter | undefined;
let _rehydrateDurationSeconds: Histogram | undefined;
let _verifyFailuresTotal: Counter | undefined;
let _replayRowsTotal: Counter | undefined;
let _replayDurationSeconds: Histogram | undefined;
let _purgeChunksTotal: Counter | undefined;
let _purgeBytesTotal: Counter | undefined;
let _purgeDurationSeconds: Histogram | undefined;

/**
 * Cycles that `runArchiveCycle()` has completed, labeled by outcome.
 * Always incremented by 1 on every tick — guaranteed-visible proof
 * that the cold-store subsystem is registered and running.
 *
 * `result` ∈ `no_tables` | `disabled` | `success` | `failure`.
 */
export function coldStoreArchiveCyclesTotal(): Counter {
  if (!_archiveCyclesTotal) {
    _archiveCyclesTotal = meter().createCounter('cold_store_archive_cycles_total', {
      description: 'Completed archive cycles by db and outcome',
    });
  }
  return _archiveCyclesTotal;
}

/**
 * Total rows archived, by db / table / outcome.
 * `result` ∈ success | failure | skipped_min_chunk | skipped_min_warm.
 *
 * Hidden from /metrics until the first Phase B+ TableAdapter moves
 * a row; the visible proof that the subsystem is wired is
 * `cold_store_archive_cycles_total`, not this counter.
 */
export function coldStoreArchiveRowsTotal(): Counter {
  if (!_archiveRowsTotal) {
    _archiveRowsTotal = meter().createCounter('cold_store_archive_rows_total', {
      description: 'Rows archived into cold storage by db, table, and outcome',
    });
  }
  return _archiveRowsTotal;
}

/**
 * Total bytes archived, by kind ∈ raw | gzipped. Lets us compute the
 * ongoing compression ratio.
 */
export function coldStoreArchiveBytesTotal(): Counter {
  if (!_archiveBytesTotal) {
    _archiveBytesTotal = meter().createCounter('cold_store_archive_bytes_total', {
      description: 'Bytes archived (raw vs gzipped) by db and table',
    });
  }
  return _archiveBytesTotal;
}

/**
 * Per-chunk archive duration histogram.
 * Buckets: 10ms, 100ms, 500ms, 1s, 5s, 30s, 120s.
 */
export function coldStoreArchiveDurationSeconds(): Histogram {
  if (!_archiveDurationSeconds) {
    _archiveDurationSeconds = meter().createHistogram('cold_store_archive_duration_seconds', {
      description: 'Archive duration per chunk, seconds',
      advice: { explicitBucketBoundaries: [0.01, 0.1, 0.5, 1, 5, 30, 120] },
    });
  }
  return _archiveDurationSeconds;
}

/**
 * Rehydrate requests (cache hit vs miss). Incremented by the
 * read-through layer (Phase B+) when it serves a range query from
 * cold storage.
 */
export function coldStoreRehydrateRequestsTotal(): Counter {
  if (!_rehydrateRequestsTotal) {
    _rehydrateRequestsTotal = meter().createCounter('cold_store_rehydrate_requests_total', {
      description: 'Cold-store rehydrate requests by cache outcome',
    });
  }
  return _rehydrateRequestsTotal;
}

/** Bytes read from S3 on rehydrate cache miss. */
export function coldStoreRehydrateBytesTotal(): Counter {
  if (!_rehydrateBytesTotal) {
    _rehydrateBytesTotal = meter().createCounter('cold_store_rehydrate_bytes_total', {
      description: 'Bytes read from S3 on rehydrate cache miss, by db and table',
    });
  }
  return _rehydrateBytesTotal;
}

/** Rehydrate duration (S3 fetch + decode), seconds. */
export function coldStoreRehydrateDurationSeconds(): Histogram {
  if (!_rehydrateDurationSeconds) {
    _rehydrateDurationSeconds = meter().createHistogram('cold_store_rehydrate_duration_seconds', {
      description: 'Rehydrate duration per request, seconds',
      advice: { explicitBucketBoundaries: [0.01, 0.1, 0.5, 1, 5, 30] },
    });
  }
  return _rehydrateDurationSeconds;
}

/**
 * Verify-failure counter — bumped on the rare `contentHash` mismatch
 * path during post-write verification.
 */
export function coldStoreVerifyFailuresTotal(): Counter {
  if (!_verifyFailuresTotal) {
    _verifyFailuresTotal = meter().createCounter('cold_store_verify_failures_total', {
      description: 'Post-write contentHash mismatch count, by db and table',
    });
  }
  return _verifyFailuresTotal;
}

/**
 * Phase F — rows promoted back into PG via `replayChunk` / `replayRow`.
 * `result` ∈ `success` | `failure` | `idempotent_skip`. The
 * `idempotent_skip` bucket counts rows already present in PG (chunk
 * replayed twice — no-op via ON CONFLICT). Hidden until the first
 * replay runs; the visible proof of the subsystem is
 * `cold_store_archive_cycles_total`.
 */
export function coldStoreReplayRowsTotal(): Counter {
  if (!_replayRowsTotal) {
    _replayRowsTotal = meter().createCounter('cold_store_replay_rows_total', {
      description: 'Rows promoted back into PG by db, table, and outcome',
    });
  }
  return _replayRowsTotal;
}

/**
 * Phase F — replay duration (S3 GET + manifest scan + decode + INSERT),
 * seconds. Buckets mirror archive duration: 10ms, 100ms, 500ms, 1s, 5s,
 * 30s, 120s.
 */
export function coldStoreReplayDurationSeconds(): Histogram {
  if (!_replayDurationSeconds) {
    _replayDurationSeconds = meter().createHistogram('cold_store_replay_duration_seconds', {
      description: 'Replay duration per chunk, seconds',
      advice: { explicitBucketBoundaries: [0.01, 0.1, 0.5, 1, 5, 30, 120] },
    });
  }
  return _replayDurationSeconds;
}

/**
 * Phase 2 — chunks acted on by `purgeExpiredChunks`, labeled by db,
 * table, and outcome. `result` ∈ `purged` | `dry_run` | `skipped_locked`
 * | `failure`. Hidden until the first GC sweep finds candidates;
 * `cold_store_archive_cycles_total` remains the always-non-zero
 * heartbeat for the subsystem.
 */
export function coldStorePurgeChunksTotal(): Counter {
  if (!_purgeChunksTotal) {
    _purgeChunksTotal = meter().createCounter('cold_store_purge_chunks_total', {
      description: 'Chunks processed by the purge sweep, by db, table, and outcome',
    });
  }
  return _purgeChunksTotal;
}

/** Phase 2 — gzipped bytes deleted from S3 by the purge sweep. */
export function coldStorePurgeBytesTotal(): Counter {
  if (!_purgeBytesTotal) {
    _purgeBytesTotal = meter().createCounter('cold_store_purge_bytes_total', {
      description: 'Gzipped bytes deleted by the purge sweep, by db and table',
    });
  }
  return _purgeBytesTotal;
}

/**
 * Phase 2 — purge duration per sweep, seconds. Buckets mirror the
 * archive duration histogram: 10ms, 100ms, 500ms, 1s, 5s, 30s, 120s.
 */
export function coldStorePurgeDurationSeconds(): Histogram {
  if (!_purgeDurationSeconds) {
    _purgeDurationSeconds = meter().createHistogram('cold_store_purge_duration_seconds', {
      description: 'Purge sweep duration per cycle, seconds',
      advice: { explicitBucketBoundaries: [0.01, 0.1, 0.5, 1, 5, 30, 120] },
    });
  }
  return _purgeDurationSeconds;
}
