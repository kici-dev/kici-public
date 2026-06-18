/**
 * Hand-maintained label-value policy on top of the auto-generated
 * `MetricLabels` / `MetricKind` allow-list in
 * `./metric-catalog.generated.ts`. Consumed by the Platform's
 * orchestrator-metrics filter (`packages/platform/src/ws/metrics-filter.ts`)
 * to harden the WS `orch.metrics` push path against pollution of the
 * monitoring system.
 *
 * Three layers compose:
 *
 *   1. `MetricNames` (auto) — every catalog metric name.
 *   2. `MetricLabels` (auto) — allow-list of label KEYS per metric.
 *   3. `METRIC_LABEL_POLICY` (here) — value constraints per (metric, key):
 *      either a closed enum (`values`) or a cardinality cap
 *      (`maxUniqueValues`). Labels without a policy entry pass through
 *      unconstrained — they were already on the auto allow-list, so
 *      the producer guarantees the value shape.
 *
 * Browser-safe: pure constants, no Node imports.
 */

import { MetricNames, MetricService, type MetricName } from './metric-catalog.generated.js';

/**
 * Per-label policy: enum-constrained values OR a cardinality cap.
 */
export interface LabelPolicy {
  /** Closed enum of acceptable label values. */
  values?: readonly string[];
  /**
   * Cap on distinct values per (orgId, routingKey, metric, labelKey)
   * tracked by the Platform-side cardinality tracker. Values beyond the
   * cap collapse to the literal `__overflow__` — total counts are
   * preserved, dimensionality is bounded.
   */
  maxUniqueValues?: number;
}

/** Literal value substituted for cap-exceeded label values. */
export const OVERFLOW_LABEL_VALUE = '__overflow__';

/**
 * Set of catalog metric names the orchestrator is allowed to push over
 * `orch.metrics`. Derived from `MetricService` so the membership stays
 * in lock-step with codegen: orchestrator owns its own `kici_orch_*`,
 * `kici_cross_source_*`, and `kici_universal_git_*` metrics, plus
 * `kici_agent_*` metrics forwarded by `AgentMetricsAggregator`. Every
 * `kici_platform_*` / `kici_org_*` / `kici_plan_*` / `kici_valkey_*` /
 * `kici_webhook*` / `kici_ws_*` / `kici_build_*` / `kici_cache_*` /
 * `kici_orgs_*` series is Platform-emitted locally and would be a
 * tenancy violation if accepted from the wire.
 *
 * The synthetic `runtime` service covers the Node.js runtime metrics
 * (`nodejs.*` / `v8js.*`) the orchestrator emits via
 * `RuntimeNodeInstrumentation`. They describe the orchestrator process,
 * so they are valid push payloads alongside `kici_orch_*`.
 */
export const ORCH_PUSHED_METRIC_NAMES: ReadonlySet<MetricName> = new Set(
  (Object.entries(MetricService) as Array<[keyof typeof MetricNames, string]>)
    .filter(([, svc]) => svc === 'orchestrator' || svc === 'agent' || svc === 'runtime')
    .map(([key]) => MetricNames[key]),
);

/** Closed enum of the four scaler-backend label values an agent can carry. */
const AGENT_SCALER_VALUES = ['stateful', 'container', 'firecracker', 'bare-metal'] as const;

/**
 * Closed enum of scaler values the orchestrator's own resource-usage
 * gauges emit. `__global__` is the orchestrator-wide rollup row; the
 * other four match `AGENT_SCALER_VALUES`.
 */
const ORCH_SCALER_VALUES = ['__global__', ...AGENT_SCALER_VALUES] as const;

/** Closed enum of the five scheduled jobs the orchestrator runs (mirrors `OrchestratorScheduledJobName`). */
const ORCH_JOB_VALUES = [
  'cleanup',
  'orphan-secret-cleanup',
  'token-cleanup',
  'cold-store-archive',
  'cold-store-purge',
] as const;

/**
 * Per-metric, per-label value policy. Missing entries (or missing label
 * keys within an entry) mean "no value-level constraint" — the label key
 * still has to appear in the auto-generated `MetricLabels[name]` allow
 * list to make it past the filter.
 *
 * User-controlled labels (the three flagged below) get a numeric cap
 * instead of an enum. Anything past the cap collapses to
 * `OVERFLOW_LABEL_VALUE` so dashboards keep their counts but cannot be
 * inflated past N+1 distinct series.
 */
export const METRIC_LABEL_POLICY: Partial<
  Record<MetricName, Partial<Record<string, LabelPolicy>>>
> = {
  kici_orch_dispatch_queue_depth: {
    status: { values: ['pending', 'dispatched'] },
  },
  kici_orch_dispatch_queue_depth_by_label: {
    status: { values: ['pending'] },
    // User-controlled: workflow `runs_on` label string.
    label: { maxUniqueValues: 200 },
  },
  kici_orch_webhooks_received_total: {
    source: { values: ['relay', 'pipeline', 'generic', 'direct'] },
    // User-controlled: webhook event name (bounded ~30 for GitHub, more for generic).
    event: { maxUniqueValues: 50 },
  },
  kici_orch_webhooks_processed_total: {
    result: { values: ['matched', 'skipped', 'error', 'handled', 'dispatched'] },
  },
  kici_orch_executions_total: {
    status: { values: ['running', 'success', 'failed', 'cancelled'] },
  },
  kici_orch_steps_total: {
    status: { values: ['running', 'success', 'failed', 'skipped'] },
  },
  kici_orch_github_check_run_total: {
    operation: { values: ['create', 'update', 'stale_cleanup'] },
  },
  kici_orch_scaler_config_reloads_total: {
    result: { values: ['attempted', 'success', 'failed'] },
  },
  kici_orch_config_reload_total: {
    result: { values: ['attempted', 'success', 'failed'] },
    source: { values: ['sighup', 'http', 'cluster', 'cli'] },
  },
  kici_orch_scaler_cpus_used: {
    scaler: { values: ORCH_SCALER_VALUES },
    machinePool: { maxUniqueValues: 50 },
  },
  kici_orch_scaler_memory_bytes_used: {
    scaler: { values: ORCH_SCALER_VALUES },
    machinePool: { maxUniqueValues: 50 },
  },
  kici_orch_install_secrets_decisions_total: {
    // `hold` covers the workflow-scoped held-run path: a protection gate that
    // returns hold / wait / queue collapses to a single `hold` decision in the
    // resolver (the gate action is carried on the structured result, not this
    // label). `pass` / `reject` are the terminal decisions.
    decision: { values: ['pass', 'reject', 'hold'] },
    reason: {
      values: [
        'ok',
        'malformed_ref',
        'invalid_url_scheme',
        'missing_env_store',
        'missing_secret_resolver',
        'env_not_found',
        'protection_rule_block',
        'missing_token',
        'missing_install_env',
        // Emitted alongside `decision="hold"` when a gate held the install.
        'held',
      ],
    },
  },
  kici_orch_install_secrets_npm_registry_used_total: {
    channel: { values: ['registries', 'install_env'] },
    provider: { values: ['static'] },
    // User-controlled: npm scope (`@my-org`, etc).
    scope: { maxUniqueValues: 100 },
  },
  kici_orch_install_secrets_contributor_stripped_total: {
    trust_tier: { values: ['unknown', 'known'] },
  },
  kici_orch_install_secrets_token_resolution_duration_seconds: {
    // Per-org environment count typically <10; cap allows pathological churn without exhausting cardinality.
    environment: { maxUniqueValues: 50 },
  },
  kici_cross_source_errors_total: {
    reason: { values: ['clone_token', 'bundle_missing'] },
  },
  kici_cross_source_fanout_size: {
    // User-controlled: webhook event name (mirrors kici_orch_webhooks_received_total.event).
    event: { maxUniqueValues: 50 },
  },
  kici_universal_git_registration_errors_total: {
    reason: {
      values: ['invalid_config', 'bundle_build', 'registration', 'no_secret_resolver'],
    },
  },
  kici_orch_trust_match_refused_no_id_total: {
    reason: { values: ['event_missing', 'link_missing', 'id_mismatch'] },
  },
  kici_orch_event_dispatch_success_total: {
    // User-controlled: internal event name (GitHub types + synthetic events).
    event_name: { maxUniqueValues: 50 },
  },
  kici_orch_event_retry_total: {
    event_name: { maxUniqueValues: 50 },
  },
  kici_orch_event_dlq_total: {
    event_name: { maxUniqueValues: 50 },
    reason: { values: ['exhausted_retries'] },
  },
  kici_orch_event_attempts: {
    event_name: { maxUniqueValues: 50 },
    result: { values: ['success', 'dlq'] },
  },
  kici_platform_cross_tenant_rejections_total: {
    reason: {
      values: [
        'join_token_org_mismatch',
        'wire_orgid_label_strip',
        'dashboard_relay_source_mismatch',
        'dashboard_relay_org_mismatch',
        'response_source_mismatch',
        'payload_stream_source_mismatch',
        'ack_source_mismatch',
      ],
    },
  },
  kici_platform_orch_metrics_filtered_total: {
    // Mirrors the FilterReason const in packages/platform/src/ws/metrics-filter.ts.
    reason: {
      values: [
        'unknown_metric',
        'type_mismatch',
        'unexpected_label',
        'bad_label_value',
        'cardinality_cap_overflow',
      ],
    },
    // The offending metric name; bounded by catalog size (~100 metrics today).
    metric: { maxUniqueValues: 200 },
  },
  kici_platform_metrics_query_rate_limited_total: {
    // User-controlled: tenant org id; cap matches other high-card user/id labels.
    org_id: { maxUniqueValues: 200 },
  },
  kici_orch_job_runs_total: {
    job: { values: ORCH_JOB_VALUES },
    result: { values: ['success', 'failure'] },
  },
  kici_orch_job_duration_seconds: { job: { values: ORCH_JOB_VALUES } },
  kici_orch_job_last_success_timestamp_seconds: { job: { values: ORCH_JOB_VALUES } },
  kici_orch_job_last_failure_timestamp_seconds: { job: { values: ORCH_JOB_VALUES } },
  kici_orch_job_consecutive_failures: { job: { values: ORCH_JOB_VALUES } },
  kici_agent_jobs_total: {
    status: { values: ['success', 'failed', 'cancelled'] },
    scaler: { values: AGENT_SCALER_VALUES },
  },
  kici_agent_jobs_active: { scaler: { values: AGENT_SCALER_VALUES } },
  kici_agent_steps_total: {
    status: { values: ['success', 'failed', 'skipped'] },
    scaler: { values: AGENT_SCALER_VALUES },
  },
  kici_agent_step_duration_seconds: { scaler: { values: AGENT_SCALER_VALUES } },
  kici_agent_clone_duration_seconds: { scaler: { values: AGENT_SCALER_VALUES } },
  kici_agent_log_bytes_total: { scaler: { values: AGENT_SCALER_VALUES } },
  kici_agent_log_backpressure_events_total: {
    mode: { values: ['pause', 'drop'] },
    scaler: { values: AGENT_SCALER_VALUES },
  },
  kici_agent_log_lines_dropped_total: { scaler: { values: AGENT_SCALER_VALUES } },
  kici_agent_log_backpressure_active: {
    mode: { values: ['pause', 'drop'] },
    scaler: { values: AGENT_SCALER_VALUES },
  },
  kici_agent_connection_status: { scaler: { values: AGENT_SCALER_VALUES } },
  // Node.js runtime metrics (RuntimeNodeInstrumentation). Their attribute
  // keys are the dotted OTel names the filter sees on the wire. The
  // instrument labels are low-cardinality and bounded by V8/libuv internals,
  // but a cap keeps a buggy instrumentation version from inflating series
  // counts. The `scaler` label appears only on the agent-forwarded variant
  // (the AgentMetricsAggregator stamps it); the orchestrator's own runtime
  // metrics omit it, so the enum constraint fires only when present.
  'nodejs.eventloop.delay.max': { scaler: { values: AGENT_SCALER_VALUES } },
  'nodejs.eventloop.delay.mean': { scaler: { values: AGENT_SCALER_VALUES } },
  'nodejs.eventloop.delay.min': { scaler: { values: AGENT_SCALER_VALUES } },
  'nodejs.eventloop.delay.p50': { scaler: { values: AGENT_SCALER_VALUES } },
  'nodejs.eventloop.delay.p90': { scaler: { values: AGENT_SCALER_VALUES } },
  'nodejs.eventloop.delay.p99': { scaler: { values: AGENT_SCALER_VALUES } },
  'nodejs.eventloop.delay.stddev': { scaler: { values: AGENT_SCALER_VALUES } },
  'nodejs.eventloop.utilization': { scaler: { values: AGENT_SCALER_VALUES } },
  'nodejs.eventloop.time': {
    'nodejs.eventloop.state': { maxUniqueValues: 4 },
    scaler: { values: AGENT_SCALER_VALUES },
  },
  'v8js.gc.duration': {
    'v8js.gc.type': { maxUniqueValues: 6 },
    scaler: { values: AGENT_SCALER_VALUES },
  },
  'v8js.memory.heap.limit': {
    'v8js.heap.space.name': { maxUniqueValues: 20 },
    scaler: { values: AGENT_SCALER_VALUES },
  },
  'v8js.memory.heap.used': {
    'v8js.heap.space.name': { maxUniqueValues: 20 },
    scaler: { values: AGENT_SCALER_VALUES },
  },
  'v8js.memory.heap.space.available_size': {
    'v8js.heap.space.name': { maxUniqueValues: 20 },
    scaler: { values: AGENT_SCALER_VALUES },
  },
  'v8js.memory.heap.space.physical_size': {
    'v8js.heap.space.name': { maxUniqueValues: 20 },
    scaler: { values: AGENT_SCALER_VALUES },
  },
};
