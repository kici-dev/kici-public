import { createMeter } from '@kici-dev/shared';

// ── Lazy meter + instrument resolution ────────────────────────────
//
// `@opentelemetry/api` returns a no-op instrument if `createMeter()` /
// `createX()` runs BEFORE `initTelemetry()` has registered the global
// MeterProvider. Service entry points (server.ts, standalone.ts) call
// `initTelemetry()` first and then load the rest of the graph, but the
// bundler hoists some statically-imported modules' top-level code above
// that call — so a `const meter = createMeter(...)` at module scope here
// would bind to the no-op provider and its instruments would never reach
// the Prometheus exporter (the orchestrator /metrics scrape would be
// missing every `kici_orch_*` series defined in this file).
//
// We therefore resolve the meter on first use and build every instrument
// lazily: counters/histograms create their real instrument on the first
// `.add()` / `.record()` call (always at runtime, after telemetry is
// wired), and the observable gauges register inside
// `registerOrchestratorMetrics()`, which `createApp()` invokes once
// during bootstrap — after `initTelemetry()`. Same hazard, same fix as
// `@kici-dev/shared`'s cold-store metrics module.

type OrchMeter = ReturnType<typeof createMeter>;
type Counter = ReturnType<OrchMeter['createCounter']>;
type Histogram = ReturnType<OrchMeter['createHistogram']>;
type CounterOptions = Parameters<OrchMeter['createCounter']>[1];
type HistogramOptions = Parameters<OrchMeter['createHistogram']>[1];

let _meter: OrchMeter | undefined;
function meter(): OrchMeter {
  if (!_meter) _meter = createMeter('kici-orchestrator');
  return _meter;
}

/**
 * A counter whose real OTel instrument is created on first `.add()` — after
 * `initTelemetry()` has registered the global MeterProvider. The returned
 * value satisfies the OTel `Counter` interface, so call sites are unchanged.
 */
function lazyCounter(name: string, options: CounterOptions): Counter {
  let inst: Counter | undefined;
  const get = (): Counter => (inst ??= meter().createCounter(name, options));
  return {
    add: (...args: Parameters<Counter['add']>) => get().add(...args),
  } as Counter;
}

/**
 * A histogram whose real OTel instrument is created on first `.record()` —
 * after `initTelemetry()`. Satisfies the OTel `Histogram` interface.
 */
function lazyHistogram(name: string, options: HistogramOptions): Histogram {
  let inst: Histogram | undefined;
  const get = (): Histogram => (inst ??= meter().createHistogram(name, options));
  return {
    record: (...args: Parameters<Histogram['record']>) => get().record(...args),
  } as Histogram;
}

type ObservableGauge = ReturnType<OrchMeter['createObservableGauge']>;
type ObservableGaugeOptions = Parameters<OrchMeter['createObservableGauge']>[1];
type ObservableCallback = Parameters<ObservableGauge['addCallback']>[0];

// Deferred observable-gauge registrations. Each entry creates and registers
// its gauge on the real meter when registerOrchestratorMetrics() runs (after
// initTelemetry). Defining a gauge here only queues a thunk — it does not
// touch the meter at module-eval time.
const _observableGauges: Array<() => void> = [];

/**
 * Queue an observable gauge for registration. The gauge is created and its
 * callback attached lazily inside registerOrchestratorMetrics(), so the
 * instrument binds to the real MeterProvider rather than the no-op one.
 */
function defineObservableGauge(
  name: string,
  options: ObservableGaugeOptions,
  observe: ObservableCallback,
): void {
  _observableGauges.push(() => {
    meter().createObservableGauge(name, options).addCallback(observe);
  });
}

// ── Observable gauge state ──────────────────────────────────────────
//
// OTel ObservableGauges report values via a callback, not .set().
// We use module-level variables + setter functions so callers can
// update values imperatively. The callback reads the latest value
// on each Prometheus scrape. The gauges themselves register in
// registerOrchestratorMetrics() (called once after initTelemetry()).

let _agentsActiveValue = 0;

/** Set the current number of active agents. */
export function setAgentsActive(value: number): void {
  _agentsActiveValue = value;
}

defineObservableGauge(
  'kici_orch_agents_active',
  { description: 'Current number of active agents connected' },
  (result) => result.observe(_agentsActiveValue),
);

let _configVersionValue = 0;

/** Set the current config version number. */
export function setConfigVersion(value: number): void {
  _configVersionValue = value;
}

defineObservableGauge(
  'kici_orch_config_version',
  { description: 'Current shared config version number' },
  (result) => result.observe(_configVersionValue),
);

let _declaredHostsUnreachableValue = 0;

/** Set the current number of declared (static) roster hosts that are unreachable. */
export function setDeclaredHostsUnreachable(value: number): void {
  _declaredHostsUnreachableValue = value;
}

defineObservableGauge(
  'kici_orch_declared_hosts_unreachable',
  { description: 'Number of declared (static) roster hosts currently unreachable' },
  (result) => result.observe(_declaredHostsUnreachableValue),
);

let _staleRunsCurrentValue = 0;

/** Set the current number of stale runs detected. */
export function setStaleRunsCurrent(value: number): void {
  _staleRunsCurrentValue = value;
}

defineObservableGauge(
  'kici_orch_stale_runs_current',
  { description: 'Current number of stale runs detected in last scan' },
  (result) => result.observe(_staleRunsCurrentValue),
);

// ── Scaler resource usage (observable gauges with labels) ────────
//
// One CPU and one memory gauge fan out per (scaler, machinePool) combination
// the manager has seen. Operators can dashboard "% utilization per scaler",
// alert on a scaler hovering near its cap, or correlate spawn refusals with
// remaining headroom. The breakdown also emits whole-orchestrator totals
// (scaler="__global__"), and rows for any pool the orchestrator participates
// in (machinePool="<pool>"). Pool rows reflect the file-backed ledger snapshot,
// not just this orchestrator's reservations, so they reveal cross-process
// usage too.

interface ScalerUsageRow {
  scaler: string;
  machinePool?: string;
  cpus: number;
  memBytes: number;
}

let _scalerUsageRows: ScalerUsageRow[] = [];

/**
 * Replace the current scaler-usage breakdown.
 *
 * Called by ScalerManager whenever a reservation lands or releases. Caller is
 * responsible for including a `scaler="__global__"` row for the orchestrator-wide
 * total and one row per active machine pool (with `machinePool` set) reflecting
 * the on-disk ledger snapshot. Per-scaler rows omit `machinePool`.
 */
export function setScalerUsageBreakdown(rows: ScalerUsageRow[]): void {
  _scalerUsageRows = rows;
}

/**
 * Current CPU reservations per scaler / machine pool.
 * Labels:
 * - scaler: __global__ | container | firecracker | bare-metal | stateful
 * - machinePool: optional pool name (operator-defined; capped at the Platform filter)
 */
defineObservableGauge(
  'kici_orch_scaler_cpus_used',
  {
    description:
      'Current CPU reservations summed by scaler / pool. scaler="__global__" is the orchestrator-wide total; machinePool="<name>" rows reflect the on-disk ledger.',
  },
  (result) => {
    for (const row of _scalerUsageRows) {
      const attrs: Record<string, string> = { scaler: row.scaler };
      if (row.machinePool) attrs.machinePool = row.machinePool;
      result.observe(row.cpus, attrs);
    }
  },
);

/**
 * Current memory reservations per scaler / machine pool.
 * Labels:
 * - scaler: __global__ | container | firecracker | bare-metal | stateful
 * - machinePool: optional pool name (operator-defined; capped at the Platform filter)
 */
defineObservableGauge(
  'kici_orch_scaler_memory_bytes_used',
  {
    description:
      'Current memory reservations (bytes) summed by scaler / pool. scaler="__global__" is the orchestrator-wide total; machinePool="<name>" rows reflect the on-disk ledger.',
  },
  (result) => {
    for (const row of _scalerUsageRows) {
      const attrs: Record<string, string> = { scaler: row.scaler };
      if (row.machinePool) attrs.machinePool = row.machinePool;
      result.observe(row.memBytes, attrs);
    }
  },
);

let _scalerSpawnRefusalsValue = 0;

/** Increment the spawn-refusal counter (called by ScalerManager when a request fails the cap check). */
export function incScalerSpawnRefusals(): void {
  _scalerSpawnRefusalsValue += 1;
}

defineObservableGauge(
  'kici_orch_scaler_spawn_refusals_total',
  {
    description:
      'Cumulative count of scaler spawn requests refused due to resource caps (maxAgents, resourceCap, globalResourceCap, machinePool).',
  },
  (result) => result.observe(_scalerSpawnRefusalsValue),
);

// ── Dispatch queue depth (observable gauges with labels) ──────────
//
// These two gauges expose the current dispatch_queue depth so operators can
// alert on queue growth without querying the DB directly. Both share a
// single breakdown state fed by the orchestrator's periodic refresher,
// which calls {@link setDispatchQueueDepthBreakdown} after refreshing the
// JobQueue cache. The callbacks are synchronous and MUST NOT perform I/O —
// they just read the last known breakdown.
//
// - `kici_orch_dispatch_queue_depth{status}` emits one series per known
//   non-terminal status (pending, dispatched). Empty queues emit explicit
//   zero-valued series so Grafana shows "0" instead of absent data.
// - `kici_orch_dispatch_queue_depth_by_label{status,label}` emits one
//   series per (status, label) combination. Once a label has been seen
//   this process, its series keeps reporting — dropping to an explicit
//   `0` when that label's queue drains — so the per-label panel resets to
//   `0` instead of freezing at the last non-zero value (an observable
//   gauge that stops reporting a series leaves the last sample frozen in
//   the TSDB). Multi-label jobs fan out across labels so `sum by (label)`
//   matches the "label pool" mental model. Only `status=pending` is
//   emitted today; dispatched jobs don't block new dispatch so their
//   per-label breakdown isn't operationally useful.

interface QueueDepthBreakdownSnapshot {
  /** Raw COUNT per non-terminal status. Always includes pending + dispatched. */
  byStatus: { pending: number; dispatched: number };
  /** Per-label fan-out of pending jobs (multi-label jobs contribute to each label). */
  byLabel: Record<string, number>;
}

let _queueDepthBreakdown: QueueDepthBreakdownSnapshot = {
  byStatus: { pending: 0, dispatched: 0 },
  byLabel: {},
};

// Tracks every runs_on label observed since process start so the by-label
// gauge can emit an explicit 0 for a label whose queue has drained — instead
// of dropping the series, which leaves the last value frozen in the TSDB and
// the by-label panel never resets. Mirrors the per-status gauge's explicit-zero
// behavior. Cardinality is bounded by the configured runs_on label pool
// (default/linux/container/...) and resets on restart.
const _everSeenQueueLabels = new Set<string>();

/**
 * Merge current per-label counts with explicit `0`s for previously-seen labels
 * whose queue has drained. Mutates `everSeen` to include the current labels.
 *
 * Exported for direct unit testing of the sticky-zero invariant: a label that
 * appears in one snapshot and is absent from the next must report `0` rather
 * than vanish, otherwise the by-label gauge series freezes at its last value.
 */
export function applyStickyQueueLabels(
  everSeen: Set<string>,
  byLabel: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [label, count] of Object.entries(byLabel)) {
    everSeen.add(label);
    out[label] = count;
  }
  for (const label of everSeen) {
    if (!(label in out)) out[label] = 0;
  }
  return out;
}

/**
 * Update the dispatch-queue depth breakdown used by the Prometheus gauges.
 *
 * Called by the orchestrator's periodic depth refresher after polling the
 * JobQueue. Normalizes the input so the gauge callback can emit explicit
 * zero series for known statuses even when the queue is empty, and keeps
 * emitting `0` for any per-label series whose queue has drained.
 */
export function setDispatchQueueDepthBreakdown(snapshot: {
  byStatus: Partial<Record<'pending' | 'dispatched', number>>;
  byLabel: Record<string, number>;
}): void {
  _queueDepthBreakdown = {
    byStatus: {
      pending: snapshot.byStatus.pending ?? 0,
      dispatched: snapshot.byStatus.dispatched ?? 0,
    },
    byLabel: applyStickyQueueLabels(_everSeenQueueLabels, snapshot.byLabel),
  };
}

/**
 * Dispatch queue depth per non-terminal status.
 * Labels:
 * - status: pending | dispatched
 */
defineObservableGauge(
  'kici_orch_dispatch_queue_depth',
  { description: 'Current dispatch_queue depth per status (pending, dispatched)' },
  (result) => {
    result.observe(_queueDepthBreakdown.byStatus.pending, { status: 'pending' });
    result.observe(_queueDepthBreakdown.byStatus.dispatched, { status: 'dispatched' });
  },
);

/**
 * Dispatch queue depth fanned out per runs_on label (pending only).
 * Labels:
 * - status: pending (only emitted status)
 * - label: a runs_on label string from the workflow's runtime config
 */
defineObservableGauge(
  'kici_orch_dispatch_queue_depth_by_label',
  {
    description:
      'Current pending dispatch_queue depth per runs_on label (multi-label jobs fan out)',
  },
  (result) => {
    for (const [label, count] of Object.entries(_queueDepthBreakdown.byLabel)) {
      result.observe(count, { status: 'pending', label });
    }
  },
);

// ── Webhook reception ─────────────────────────────────────────────

/**
 * Total webhooks received by the orchestrator.
 * Labels:
 * - source: relay (from Platform) | direct (webhook endpoint)
 * - event: GitHub event type (push, pull_request, etc.)
 */
export const webhooksReceivedTotal = lazyCounter('kici_orch_webhooks_received_total', {
  description: 'Total number of webhooks received',
});

/**
 * Total webhooks processed with outcome.
 * Labels:
 * - result: matched (triggered workflow) | skipped (no match) | error (processing failure)
 */
export const webhooksProcessedTotal = lazyCounter('kici_orch_webhooks_processed_total', {
  description: 'Total number of webhooks processed',
});

// ── Trigger matching ──────────────────────────────────────────────

/**
 * Duration of trigger matching operations (lock file evaluation).
 * Buckets: 1ms to 5s covering fast rejects through complex evaluations.
 */
export const triggerMatchDurationSeconds = lazyHistogram(
  'kici_orch_trigger_match_duration_seconds',
  {
    description: 'Duration of trigger matching operations in seconds',
    advice: { explicitBucketBoundaries: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5] },
  },
);

// ── Deduplication ─────────────────────────────────────────────────

/**
 * Total deduplication cache hits (duplicate webhooks rejected).
 */
export const dedupHitsTotal = lazyCounter('kici_orch_dedup_hits_total', {
  description: 'Total number of deduplication cache hits',
});

// ── pg pool resilience ────────────────────────────────────────────

/**
 * pg connection errors absorbed by the pool error handlers instead of
 * crashing the process (e.g. a database failover terminating idle pooled
 * backends).
 * Labels:
 * - source: idle-pool | client
 */
export const pgPoolClientErrorsTotal = lazyCounter('kici_orch_pg_pool_client_errors_total', {
  description: 'Total pg connection errors absorbed without a process restart',
});

// ── Bundle cache ──────────────────────────────────────────────────

/**
 * Total source cache hits (`.kici/` source tarball found for content hash).
 */
export const sourceCacheHitsTotal = lazyCounter('kici_orch_source_cache_hits_total', {
  description: 'Total number of source tarball cache hits',
});

/**
 * Total source cache misses (no source tarball cached for content hash).
 */
export const sourceCacheMissesTotal = lazyCounter('kici_orch_source_cache_misses_total', {
  description: 'Total number of source tarball cache misses',
});

// ── Dep cache ─────────────────────────────────────────────────────

/**
 * Total dep cache hits (dependency tarball found for lockfile hash).
 */
export const depCacheHitsTotal = lazyCounter('kici_orch_dep_cache_hits_total', {
  description: 'Total number of dep cache hits',
});

/**
 * Total dep cache misses (no dependency tarball for lockfile hash).
 */
export const depCacheMissesTotal = lazyCounter('kici_orch_dep_cache_misses_total', {
  description: 'Total number of dep cache misses',
});

/**
 * Duration of build agent operations in seconds.
 * Tracks how long it takes to compile a workflow bundle via a build agent.
 * Buckets: 1s to 10min covering fast to slow compilations.
 */
export const buildDurationSeconds = lazyHistogram('kici_orch_build_duration_seconds', {
  description: 'Duration of build agent operations in seconds',
  advice: { explicitBucketBoundaries: [1, 5, 10, 30, 60, 120, 300, 600] },
});

// ── Execution reporting ──────────────────────────────────────────

/**
 * Total execution runs tracked.
 * Labels:
 * - status: running | success | failed | cancelled
 */
export const executionsTotal = lazyCounter('kici_orch_executions_total', {
  description: 'Total number of execution runs',
});

/**
 * Duration of execution runs in seconds.
 * Buckets: 1s to 30min covering fast to long pipelines.
 */
export const executionDurationSeconds = lazyHistogram('kici_orch_execution_duration_seconds', {
  description: 'Duration of execution runs in seconds',
  advice: { explicitBucketBoundaries: [1, 5, 10, 30, 60, 120, 300, 600, 1800] },
});

/**
 * Total steps executed.
 * Labels:
 * - status: running | success | failed | skipped
 */
export const stepsTotal = lazyCounter('kici_orch_steps_total', {
  description: 'Total number of steps executed',
});

/**
 * Total GitHub check run API calls (create + update + stale_cleanup).
 * Labels:
 * - operation: create | update | stale_cleanup
 */
export const githubCheckRunTotal = lazyCounter('kici_orch_github_check_run_total', {
  description: 'Total number of GitHub check run API calls',
});

/**
 * Total log chunks received from agents.
 */
export const logChunksReceivedTotal = lazyCounter('kici_orch_log_chunks_received_total', {
  description: 'Total number of log chunks received from agents',
});

/**
 * Total log bytes written to storage backend.
 */
export const logBytesStoredTotal = lazyCounter('kici_orch_log_bytes_stored_total', {
  description: 'Total bytes of log data written to storage',
});

// ── Scaler ────────────────────────────────────────────────────────

/**
 * Total number of scaler config reload operations.
 * Labels:
 * - result: attempted | success | failed
 */
export const scalerConfigReloadsTotal = lazyCounter('kici_orch_scaler_config_reloads_total', {
  description: 'Total number of scaler config reload operations',
});

/**
 * `bound` label for `kici_orch_scaler_spawn_failures_total`.
 * - `true`  — the failed spawn was bound to a queued job (a run is affected).
 * - `false` — a warm-pool / unbound pre-spawn (no run impact yet; fleet-health signal).
 */
export const ScalerSpawnFailureBound = {
  Bound: 'true',
  Unbound: 'false',
} as const;
export type ScalerSpawnFailureBound =
  (typeof ScalerSpawnFailureBound)[keyof typeof ScalerSpawnFailureBound];

/**
 * Total scaler agent spawn failures.
 * Labels:
 * - backend: scaler backend type (bare-metal | container | firecracker | unknown)
 * - bound: true (job-bound spawn) | false (warm-pool/unbound)
 */
export const scalerSpawnFailuresTotal = lazyCounter('kici_orch_scaler_spawn_failures_total', {
  description: 'Total scaler agent spawn failures (job-bound and warm-pool)',
});

// ── Config reload ────────────────────────────────────────────────

/**
 * Total number of config reload operations.
 * Labels:
 * - result: success | failed | attempted
 * - source: sighup | http | cluster | cli
 */
export const configReloadTotal = lazyCounter('kici_orch_config_reload_total', {
  description: 'Total number of config reload operations',
});

// ── Stale detection ──────────────────────────────────────────────

/**
 * Total number of stale runs detected and marked as failed.
 */
export const staleRunsDetectedTotal = lazyCounter('kici_orch_stale_runs_detected_total', {
  description: 'Total number of stale runs detected and marked as failed',
});

/**
 * Time between job becoming stale and detection (seconds).
 * Buckets: 10s to 10min covering typical scan intervals.
 */
export const staleDetectionDurationSeconds = lazyHistogram(
  'kici_orch_stale_detection_duration_seconds',
  {
    description: 'Time between job becoming stale and detection (seconds)',
    advice: { explicitBucketBoundaries: [10, 30, 60, 120, 300, 600] },
  },
);

// ── Cross-source webhook dispatch ────────────────────────────────

/**
 * Number of webhook-trigger registrations matched when an inbound generic
 * webhook fans out across sources in the same org.
 *
 * Recorded once per inbound webhook on the cross-source dispatch path
 * (including zero-match cases). The label carries the inbound event name
 * (NOT the literal 'generic_webhook').
 *
 * Buckets cover small fan-outs (1-2 typical) through large org-wide fan-outs.
 *
 * Labels:
 * - event: inbound event name (GitHub event type or generic webhook event)
 */
export const crossSourceFanoutSize = lazyHistogram('kici_cross_source_fanout_size', {
  description:
    'Number of webhook-trigger registrations matched when an inbound generic webhook fans out across sources in the same org',
  advice: { explicitBucketBoundaries: [0, 1, 2, 5, 10, 25, 50, 100] },
});

/**
 * Errors encountered during cross-source webhook dispatch.
 *
 * Labels:
 * - reason: 'clone_token' (issuance failed) | 'bundle_missing' (registration's
 *   provider bundle not found in registry)
 *
 * NOTE: dashboard panel for `kici_cross_source_errors_total` not yet added —
 * follow-up per .claude/rules/monitoring.md (out of scope for plan 28.4-02).
 */
export const crossSourceErrorsTotal = lazyCounter('kici_cross_source_errors_total', {
  description: 'Errors encountered during cross-source webhook dispatch',
});

/**
 * Counter for universal-git source registration errors at orchestrator
 * startup or config reload. A non-zero rate indicates at least one
 * `generic_webhook_sources` row with a non-null `git_config` could not be
 * promoted to a provider bundle — the row stays in the DB but its routing
 * key has no bundle, so webhooks for it will fall through to the generic
 * bundle's payload-only path.
 *
 * Labels:
 * - reason: 'invalid_config' (Zod parse failed) | 'bundle_build' (factory
 *   threw) | 'registration' (providerRegistry.registerByRoutingKey threw)
 */
export const universalGitRegistrationErrorsTotal = lazyCounter(
  'kici_universal_git_registration_errors_total',
  { description: 'Errors encountered while registering universal-git provider bundles' },
);

/**
 * Counter for trust-resolution paths that were refused because the
 * numeric provider id was absent (on either side) or did not match an
 * identity link. Under the strict policy these refusals resolve the
 * contributor to `unknown` regardless of username overlap.
 *
 * Labels:
 * - reason: 'event_missing' (webhook payload had no sender.id) |
 *   'link_missing' (a username-matched link has provider_user_id NULL) |
 *   'id_mismatch' (a username-matched link has a different provider_user_id)
 */
export const trustMatchRefusedNoIdTotal = lazyCounter('kici_orch_trust_match_refused_no_id_total', {
  description:
    'Trust-resolution attempts refused because the provider numeric id was missing or did not match',
});

// ── Event delivery (lease + retry + DLQ) ──────────────────────────
//
// Counters and a gauge covering the at-least-once event delivery pipeline.
// Operators alert on dlqTotal > 0 (a dispatch is permanently failing) and
// on leaseExpirationsTotal rate > 0 (a node is dying mid-dispatch). The
// dlqDepth gauge is refreshed every retry-scanner tick.

/**
 * Internal events delivered to all matching workflows successfully (after the
 * lease commits processed=true).
 * Labels:
 * - event_name: the internal event name (GitHub event type or synthetic, e.g. workflow.rerun)
 */
export const eventDispatchSuccessTotal = lazyCounter('kici_orch_event_dispatch_success_total', {
  description:
    'Internal events delivered to all matching workflows successfully (after the lease commits processed=true)',
});

/**
 * Internal-event dispatch failures that triggered a retry (lease released,
 * next_retry_at scheduled).
 * Labels:
 * - event_name: the internal event name
 */
export const eventRetryTotal = lazyCounter('kici_orch_event_retry_total', {
  description:
    'Internal-event dispatch failures that triggered a retry (lease released, next_retry_at scheduled)',
});

/**
 * Internal events moved to the DLQ after exhausting retries.
 * Labels:
 * - event_name: the internal event name
 * - reason: why the event was DLQ'd (exhausted_retries)
 */
export const eventDlqTotal = lazyCounter('kici_orch_event_dlq_total', {
  description: 'Internal events moved to the DLQ after exhausting retries',
});

/**
 * Dispatch leases that timed out before the holding node finalised them
 * (signals a node crash mid-dispatch). Emits no labels.
 */
export const eventLeaseExpirationsTotal = lazyCounter('kici_orch_event_lease_expirations_total', {
  description:
    'Dispatch leases that timed out before the holding node finalised them (signals node crash mid-dispatch)',
});

/**
 * Distribution of dispatch attempts at terminal outcome (success or DLQ).
 * Labels:
 * - event_name: the internal event name
 * - result: terminal outcome of the dispatch (success | dlq)
 */
export const eventAttemptsHistogram = lazyHistogram('kici_orch_event_attempts', {
  description: 'Distribution of dispatch attempts at terminal outcome (success or DLQ)',
});

let _eventDlqDepthValue = 0;

/** Set the current DLQ depth gauge. Refreshed by the leader-only retry scanner each tick. */
export function setEventDlqDepth(value: number): void {
  _eventDlqDepthValue = value;
}

defineObservableGauge(
  'kici_orch_event_dlq_depth',
  { description: 'Current count of events sitting in the DLQ awaiting operator triage' },
  (result) => result.observe(_eventDlqDepthValue),
);

// ── Install-secrets resolution ────────────────────────────────────
//
// Counters + histogram covering the resolver in
// `pipeline/install-secrets-resolver.ts`, which evaluates a workflow's
// `registries:` block (Option A) and committed-`.npmrc` `installEnv:`
// entries (Option C) against the per-environment protection pipeline and
// secret resolver before each dispatch.
//
// These metrics let operators dashboard:
//   - Volume of install-secrets decisions (pass vs reject) and the reason
//     breakdown of rejects (URL scheme, malformed ref, env not found, …).
//   - Which channels and scopes installs actually use day-to-day.
//   - The defense-in-depth contributor-strip path (fork PRs from untrusted
//     contributors get no tokens; if a misconfigured env let them through
//     the protection gate, this counter fires).
//   - Token-resolution latency by environment, which surfaces slow Vault /
//     Postgres lookups before they bleed into dispatch latency.

/**
 * Reason values for the `kici_orch_install_secrets_decisions_total` counter.
 * The single source of truth — the resolver and tests both reference these
 * constants, so adding a new reject path requires extending the union here.
 */
export const InstallSecretsDecisionReason = {
  Ok: 'ok',
  MalformedRef: 'malformed_ref',
  InvalidUrlScheme: 'invalid_url_scheme',
  MissingEnvStore: 'missing_env_store',
  MissingSecretResolver: 'missing_secret_resolver',
  EnvNotFound: 'env_not_found',
  ProtectionRuleBlock: 'protection_rule_block',
  MissingToken: 'missing_token',
  MissingInstallEnv: 'missing_install_env',
  /** A protection gate held the workflow install (hold / wait / queue). */
  Held: 'held',
} as const;
export type InstallSecretsDecisionReason =
  (typeof InstallSecretsDecisionReason)[keyof typeof InstallSecretsDecisionReason];

/**
 * Channel label for `kici_orch_install_secrets_npm_registry_used_total`.
 * - `registries` is Option A (workflow-level `registries:` block).
 * - `install_env` is Option C (committed `.kici/.npmrc` + `installEnv:`).
 */
export const InstallSecretsChannel = {
  Registries: 'registries',
  InstallEnv: 'install_env',
} as const;
export type InstallSecretsChannel =
  (typeof InstallSecretsChannel)[keyof typeof InstallSecretsChannel];

/**
 * Total install-secrets resolution decisions.
 *
 * Labels:
 * - decision: pass | reject | hold
 * - reason: ok (only with `pass`), held (only with `hold`), or one of the reject reasons enumerated in `InstallSecretsDecisionReason`
 *
 * Pass series are emitted exactly once per resolver call that does any work
 * (workflows declaring neither `registries:` nor `installEnv:` are NOT
 * counted — that's the trivial early-return path and dashboard rates would
 * be dominated by it).
 */
export const installSecretsDecisionsTotal = lazyCounter(
  'kici_orch_install_secrets_decisions_total',
  {
    description: 'Total install-secrets resolution decisions (pass / reject / hold + reason)',
  },
);

/**
 * Total registry / installEnv entries that successfully resolved on a
 * passing dispatch. Each entry contributes one increment, so a workflow
 * with two `registries:` rows and one `installEnv:` entry adds three.
 *
 * Labels:
 * - channel: registries (Option A workflow block) | install_env (Option C committed .npmrc + installEnv:)
 * - provider: static today (long-lived `tokenSecret`); reserved for the typed RegistryProvider (aws-codeartifact, gcp-artifact-registry, …) when that lands
 * - scope: the npm scope string like `@my-org`, the literal `default` for a no-scope default registry, or `-` for install_env entries (no scope concept on Option C)
 */
export const installSecretsRegistryUsedTotal = lazyCounter(
  'kici_orch_install_secrets_npm_registry_used_total',
  {
    description:
      'Total registry / installEnv entries successfully resolved per channel / provider / scope',
  },
);

/**
 * Total dispatches where the orchestrator stripped registry tokens because
 * the resolved contributor trust tier was not `trusted` (fork PRs from
 * unknown contributors). Defense-in-depth: even if a misconfigured
 * environment lacks a `minimum_trust` rule, this strip prevents tokens
 * from leaving the orchestrator for those dispatches.
 *
 * Labels:
 * - trust_tier: unknown | known (the `trusted` tier does not strip and therefore never fires this counter)
 */
export const installSecretsContributorStrippedTotal = lazyCounter(
  'kici_orch_install_secrets_contributor_stripped_total',
  {
    description:
      'Dispatches where registry tokens were stripped because the contributor tier was not `trusted`',
  },
);

/**
 * Per-environment latency of `secretResolver.resolveForJob` calls in the
 * install-secrets path. Buckets mirror `triggerMatchDurationSeconds`:
 * 1ms → 5s covers fast Postgres reads through pathological Vault timeouts.
 *
 * Labels:
 * - environment: the environment name referenced in the qualified `<environment>:<secret>` ref (per-org count is typically <10)
 */
export const installSecretsTokenResolutionDurationSeconds = lazyHistogram(
  'kici_orch_install_secrets_token_resolution_duration_seconds',
  {
    description: 'Duration of per-environment secret resolution during install-secrets evaluation',
    advice: { explicitBucketBoundaries: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5] },
  },
);

// ── Observable gauge registration ─────────────────────────────────

let _observableGaugesRegistered = false;

/**
 * Register every queued orchestrator observable gauge on the real meter.
 *
 * Must run AFTER `initTelemetry()` has wired the global MeterProvider —
 * `createApp()` calls it once during bootstrap. Registering the gauges at
 * module-eval time instead would bind them to the no-op provider (the
 * bundler hoists some module init above the entry's `initTelemetry()` call),
 * leaving every `kici_orch_*` gauge absent from the /metrics scrape and the
 * Platform push. Idempotent: repeat calls are no-ops.
 */
export function registerOrchestratorMetrics(): void {
  if (_observableGaugesRegistered) return;
  _observableGaugesRegistered = true;
  for (const register of _observableGauges) register();
}
