/**
 * Hand-maintained label-value policy on top of the generated
 * `MetricLabels` / `MetricKind` allow-list (`./metric-catalog.generated.ts`).
 * The Platform's orchestrator-metrics filter uses it to keep the WS
 * `orch.metrics` push path from polluting the monitoring system.
 *
 * Layers: `MetricNames` (generated: every metric name), `MetricLabels`
 * (generated: allowed label KEYS per metric), and `METRIC_LABEL_POLICY` (here:
 * per (metric, key) a closed enum `values` or a cap `maxUniqueValues`). A label
 * with no policy entry passes unconstrained: it is on the allow-list, so the
 * producer guarantees the value shape.
 *
 * Browser-safe: pure constants, no Node imports.
 */

import { MetricNames, MetricService, type MetricName } from './metric-catalog.generated.js';
import { ExecutionRunStatus } from '../protocol/messages/execution-status.js';
import { ScalerBackendType } from '../scaler/scaler-backend-type.js';

/** Per-label policy: enum-constrained values OR a cardinality cap. */
export interface LabelPolicy {
  values?: readonly string[];
  /**
   * Cap on distinct values per (orgId, routingKey, metric, labelKey), tracked
   * by the Platform. Values beyond it collapse to `__overflow__`: totals are
   * preserved, dimensionality is bounded.
   */
  maxUniqueValues?: number;
}

/** Literal value substituted for cap-exceeded label values. */
export const OVERFLOW_LABEL_VALUE = '__overflow__';

/**
 * Catalog metric names the orchestrator may push over `orch.metrics`, derived
 * from `MetricService` to stay in lock-step with codegen: its own
 * `kici_orch_*`, `kici_cross_source_*` and `kici_universal_git_*`, the
 * `kici_agent_*` series `AgentMetricsAggregator` forwards, and the `runtime`
 * service's Node.js metrics (`nodejs.*` / `v8js.*`, from
 * `RuntimeNodeInstrumentation`, describing the orchestrator process). Every
 * `kici_platform_*` / `kici_org_*` / `kici_plan_*` / `kici_valkey_*` /
 * `kici_webhook*` / `kici_ws_*` / `kici_build_*` / `kici_cache_*` /
 * `kici_orgs_*` series is Platform-emitted; accepting one from the wire would
 * be a tenancy violation.
 */
export const ORCH_PUSHED_METRIC_NAMES: ReadonlySet<MetricName> = new Set(
  (Object.entries(MetricService) as Array<[keyof typeof MetricNames, string]>)
    .filter(([, svc]) => svc === 'orchestrator' || svc === 'agent' || svc === 'runtime')
    .map(([key]) => MetricNames[key]),
);

/**
 * The `scaler` label values an agent can carry: every scaler backend type, plus
 * `stateful` for a static agent no scaler manages (the
 * `AgentMetricsAggregator.resolveScalerLabel` fallback when the lookup returns
 * null). Derived from `ScalerBackendType`, so a new backend's `kici_agent_*`
 * series are not silently dropped as `bad_label_value`.
 */
const AGENT_SCALER_VALUES = ['stateful', ...ScalerBackendType.options] as const;

/**
 * The `scalerType` rollup label values on the orchestrator's resource-usage
 * gauges: `__global__` (the orchestrator-wide row) plus `ScalerBackendType`,
 * since every other value comes from `ScalerManager`'s `backends` map. NOT
 * `AGENT_SCALER_VALUES`, which adds the agent-only `stateful`. Exported for
 * the policy tests.
 */
export const ORCH_SCALER_VALUES = ['__global__', ...ScalerBackendType.options] as const;

/**
 * The orchestrator's scheduled jobs. MUST mirror `OrchestratorScheduledJobName`
 * (`packages/orchestrator/src/queue/scheduled-job.ts`) exactly: the Platform
 * filter drops a missing job's whole `kici_orch_job_*` series as
 * `reason="bad_label_value"`. The engine cannot import the orchestrator, so the
 * parity assertion lives in the orchestrator's `scheduled-job.test.ts`, which
 * imports this.
 */
export const ORCH_JOB_VALUES = [
  'cleanup',
  'orphan-secret-cleanup',
  'token-cleanup',
  'cold-store-archive',
  'cold-store-purge',
  'unroutable-probe',
] as const;

/**
 * Per-metric, per-label value policy. A missing entry or label key means no
 * value constraint; the key must still be in the generated `MetricLabels[name]`
 * allow-list to pass the filter.
 *
 * User-controlled labels (flagged below) get a numeric cap instead of an enum;
 * values past it collapse to `OVERFLOW_LABEL_VALUE`, so counts survive but a
 * label never exceeds N+1 distinct series.
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
    // Derived from ExecutionRunStatus so it never drifts from emitted statuses.
    status: { values: ExecutionRunStatus.options },
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
    // `scaler` is the free-form operator-chosen NAME (plus the `__global__`
    // rollup row), so it is capped like `machinePool`, not enum-constrained.
    scaler: { maxUniqueValues: 50 },
    scalerType: { values: ORCH_SCALER_VALUES },
    machinePool: { maxUniqueValues: 50 },
  },
  kici_orch_scaler_memory_bytes_used: {
    scaler: { maxUniqueValues: 50 },
    scalerType: { values: ORCH_SCALER_VALUES },
    machinePool: { maxUniqueValues: 50 },
  },
  // Warm-pool gauges fan out per (scaler, labelSet), both operator-chosen and
  // bounded by the scaler config, so both are capped rather than enum-constrained.
  kici_orch_scaler_warm_pool_target: {
    scaler: { maxUniqueValues: 50 },
    labelSet: { maxUniqueValues: 100 },
  },
  kici_orch_scaler_warm_pool_ready: {
    scaler: { maxUniqueValues: 50 },
    labelSet: { maxUniqueValues: 100 },
  },
  kici_orch_scaler_warm_pool_in_flight: {
    scaler: { maxUniqueValues: 50 },
    labelSet: { maxUniqueValues: 100 },
  },
  kici_orch_scaler_warm_pool_spawns_total: { scaler: { maxUniqueValues: 50 } },
  kici_orch_scaler_warm_pool_reaped_total: { scaler: { maxUniqueValues: 50 } },
  kici_orch_install_secrets_decisions_total: {
    // `hold` covers the workflow-scoped held-run path: a gate returning
    // hold / wait / queue collapses to one `hold` decision
    // (the gate action rides the structured result, not this label).
    // `pass` / `reject` are terminal.
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
  kici_orch_container_registry_auth_contributor_stripped_total: {
    trust_tier: { values: ['unknown'] },
  },
  kici_orch_install_secrets_contributor_stripped_total: {
    trust_tier: { values: ['unknown'] },
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
  kici_orch_event_unmatched_total: {
    event_name: { maxUniqueValues: 50 },
    reason: {
      values: [
        'buffered',
        'no-registration',
        'no-target-repo',
        'trust-blocked',
        'no-trigger-match',
      ],
    },
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
        'source_register_org_segment_mismatch',
        'source_register_unknown_prefix',
        'github_routing_key_multi_org_claim',
        'unverified_delivery_id_claim',
      ],
    },
  },
  kici_platform_orch_metrics_filtered_total: {
    // Mirrors the Platform metrics filter's reasons.
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
  // Node.js runtime metrics (RuntimeNodeInstrumentation), keyed by the dotted
  // OTel attribute names seen on the wire. Their labels are bounded by
  // V8/libuv internals; the caps guard against a buggy instrumentation version.
  // Only the agent-forwarded variant carries `scaler` (AgentMetricsAggregator
  // stamps it), so that constraint fires only when present.
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
  'v8js.resource.active': {
    'v8js.resource.type': { maxUniqueValues: 20 },
    scaler: { values: AGENT_SCALER_VALUES },
  },
};
