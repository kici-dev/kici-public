/**
 * Cold-store data-volume metrics; they do not overlap the scheduler-layer
 * `kici_{platform,orch}_job_*` metrics.
 *
 * `cold_store_archive_cycles_total` increments on every `runArchiveCycle()`
 * so the meter always surfaces on /metrics: `@opentelemetry/exporter-prometheus`
 * 0.213.0 drops counters whose only observations are `.add(0)`. The other
 * counters stay hidden until their first real sample.
 *
 * Instruments resolve lazily on first access: the `@kici-dev/shared` barrel
 * loads this module before `initTelemetry()` sets the global MeterProvider, and
 * a meter created at load time binds to the no-op provider forever.
 */
import type { Counter, Histogram, Meter } from '@opentelemetry/api';
import { z } from 'zod';
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
 * The `result` label of {@link coldStoreArchiveCyclesTotal}. `disabled`: config
 * gate off. `no_tables`: nothing registered, or every adapter ran with no row to
 * move. `success`: at least one chunk written. `failure`: a row failed to archive.
 */
export const ColdStoreCycleResult = z.enum(['disabled', 'no_tables', 'success', 'failure']);
export type ColdStoreCycleResult = z.infer<typeof ColdStoreCycleResult>;

/**
 * Completed `runArchiveCycle()` ticks by {@link ColdStoreCycleResult}; +1 every
 * tick, so it is the always-visible proof the subsystem runs.
 */
export function coldStoreArchiveCyclesTotal(): Counter {
  if (!_archiveCyclesTotal) {
    _archiveCyclesTotal = meter().createCounter('cold_store_archive_cycles_total', {
      description: 'Completed archive cycles by db and outcome',
    });
  }
  return _archiveCyclesTotal;
}

/** `result` ∈ success | failure | skipped_min_chunk | skipped_min_warm. */
export function coldStoreArchiveRowsTotal(): Counter {
  if (!_archiveRowsTotal) {
    _archiveRowsTotal = meter().createCounter('cold_store_archive_rows_total', {
      description: 'Rows archived into cold storage by db, table, and outcome',
    });
  }
  return _archiveRowsTotal;
}

/** Bytes archived by kind ∈ raw | gzipped, for the compression ratio. */
export function coldStoreArchiveBytesTotal(): Counter {
  if (!_archiveBytesTotal) {
    _archiveBytesTotal = meter().createCounter('cold_store_archive_bytes_total', {
      description: 'Bytes archived (raw vs gzipped) by db and table',
    });
  }
  return _archiveBytesTotal;
}

export function coldStoreArchiveDurationSeconds(): Histogram {
  if (!_archiveDurationSeconds) {
    _archiveDurationSeconds = meter().createHistogram('cold_store_archive_duration_seconds', {
      description: 'Archive duration per chunk, seconds',
      advice: { explicitBucketBoundaries: [0.01, 0.1, 0.5, 1, 5, 30, 120] },
    });
  }
  return _archiveDurationSeconds;
}

/** Incremented by the read-through layer when it serves a range query from cold storage. */
export function coldStoreRehydrateRequestsTotal(): Counter {
  if (!_rehydrateRequestsTotal) {
    _rehydrateRequestsTotal = meter().createCounter('cold_store_rehydrate_requests_total', {
      description: 'Cold-store rehydrate requests by cache outcome',
    });
  }
  return _rehydrateRequestsTotal;
}

export function coldStoreRehydrateBytesTotal(): Counter {
  if (!_rehydrateBytesTotal) {
    _rehydrateBytesTotal = meter().createCounter('cold_store_rehydrate_bytes_total', {
      description: 'Bytes read from S3 on rehydrate cache miss, by db and table',
    });
  }
  return _rehydrateBytesTotal;
}

/** Covers S3 fetch + decode. */
export function coldStoreRehydrateDurationSeconds(): Histogram {
  if (!_rehydrateDurationSeconds) {
    _rehydrateDurationSeconds = meter().createHistogram('cold_store_rehydrate_duration_seconds', {
      description: 'Rehydrate duration per request, seconds',
      advice: { explicitBucketBoundaries: [0.01, 0.1, 0.5, 1, 5, 30] },
    });
  }
  return _rehydrateDurationSeconds;
}

export function coldStoreVerifyFailuresTotal(): Counter {
  if (!_verifyFailuresTotal) {
    _verifyFailuresTotal = meter().createCounter('cold_store_verify_failures_total', {
      description: 'Post-write contentHash mismatch count, by db and table',
    });
  }
  return _verifyFailuresTotal;
}

/**
 * Rows promoted back into PG via `replayChunk` / `replayRow`. `result` ∈
 * `success` | `failure` | `idempotent_skip` (row already present: ON CONFLICT no-op).
 */
export function coldStoreReplayRowsTotal(): Counter {
  if (!_replayRowsTotal) {
    _replayRowsTotal = meter().createCounter('cold_store_replay_rows_total', {
      description: 'Rows promoted back into PG by db, table, and outcome',
    });
  }
  return _replayRowsTotal;
}

/** Covers S3 GET + manifest scan + decode + INSERT. */
export function coldStoreReplayDurationSeconds(): Histogram {
  if (!_replayDurationSeconds) {
    _replayDurationSeconds = meter().createHistogram('cold_store_replay_duration_seconds', {
      description: 'Replay duration per chunk, seconds',
      advice: { explicitBucketBoundaries: [0.01, 0.1, 0.5, 1, 5, 30, 120] },
    });
  }
  return _replayDurationSeconds;
}

/** Chunks acted on by `purgeExpiredChunks`; `result` ∈ `purged` | `dry_run` | `skipped_locked` | `failure`. */
export function coldStorePurgeChunksTotal(): Counter {
  if (!_purgeChunksTotal) {
    _purgeChunksTotal = meter().createCounter('cold_store_purge_chunks_total', {
      description: 'Chunks processed by the purge sweep, by db, table, and outcome',
    });
  }
  return _purgeChunksTotal;
}

export function coldStorePurgeBytesTotal(): Counter {
  if (!_purgeBytesTotal) {
    _purgeBytesTotal = meter().createCounter('cold_store_purge_bytes_total', {
      description: 'Gzipped bytes deleted by the purge sweep, by db and table',
    });
  }
  return _purgeBytesTotal;
}

export function coldStorePurgeDurationSeconds(): Histogram {
  if (!_purgeDurationSeconds) {
    _purgeDurationSeconds = meter().createHistogram('cold_store_purge_duration_seconds', {
      description: 'Purge sweep duration per cycle, seconds',
      advice: { explicitBucketBoundaries: [0.01, 0.1, 0.5, 1, 5, 30, 120] },
    });
  }
  return _purgeDurationSeconds;
}
