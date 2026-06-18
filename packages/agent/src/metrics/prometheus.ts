import { createMeter } from '@kici-dev/shared';

/**
 * OTel meter for kici agent metrics.
 *
 * Metric names use kici_agent_ prefix. The prefix is applied by the
 * PrometheusExporter configured in initTelemetry() with metricPrefix.
 * Instrument names here omit the prefix since the exporter adds it.
 *
 * Note: OTel PrometheusExporter prepends the configured prefix to all
 * metric names. We use the full name here because the prefix is set
 * at the SDK level (metricPrefix: 'kici_agent_').
 */
const meter = createMeter('kici-agent');

// -- Job execution -----------------------------------------------------------

/**
 * Total completed jobs.
 * Labels:
 * - status: success | failed | cancelled
 * - scaler: injected by orch-side AgentMetricsAggregator (Phase 5b); `stateful` for static agents, backend name (`container` / `firecracker` / `bare-metal`) for scaler-managed
 */
export const jobsTotal = meter.createCounter('kici_agent_jobs_total', {
  description: 'Total number of completed jobs',
});

/**
 * Currently running jobs.
 * Labels:
 * - scaler: injected by orch-side AgentMetricsAggregator (Phase 5b); `stateful` for static agents, backend name (`container` / `firecracker` / `bare-metal`) for scaler-managed
 */
export const jobsActive = meter.createUpDownCounter('kici_agent_jobs_active', {
  description: 'Number of currently running jobs',
});

// -- Step execution ----------------------------------------------------------

/**
 * Total completed steps.
 * Labels:
 * - status: success | failed | skipped
 * - scaler: injected by orch-side AgentMetricsAggregator (Phase 5b); `stateful` for static agents, backend name (`container` / `firecracker` / `bare-metal`) for scaler-managed
 */
export const stepsTotal = meter.createCounter('kici_agent_steps_total', {
  description: 'Total number of completed steps',
});

/**
 * Step execution duration in seconds.
 * Advisory boundaries cover sub-second steps through 30-minute long-running steps.
 * Labels:
 * - scaler: injected by orch-side AgentMetricsAggregator (Phase 5b); `stateful` for static agents, backend name (`container` / `firecracker` / `bare-metal`) for scaler-managed
 */
export const stepDurationSeconds = meter.createHistogram('kici_agent_step_duration_seconds', {
  description: 'Step execution duration in seconds',
  advice: {
    explicitBucketBoundaries: [0.1, 1, 5, 30, 60, 300, 600, 1800],
  },
});

// -- Git clone ---------------------------------------------------------------

/**
 * Git clone duration in seconds.
 * Advisory boundaries cover fast shallow clones through large repo clones.
 * Labels:
 * - scaler: injected by orch-side AgentMetricsAggregator (Phase 5b); `stateful` for static agents, backend name (`container` / `firecracker` / `bare-metal`) for scaler-managed
 */
export const cloneDurationSeconds = meter.createHistogram('kici_agent_clone_duration_seconds', {
  description: 'Git clone duration in seconds',
  advice: {
    explicitBucketBoundaries: [0.5, 1, 5, 10, 30, 60],
  },
});

// -- Log streaming -----------------------------------------------------------

/**
 * Total log bytes streamed back to orchestrator.
 * Labels:
 * - scaler: injected by orch-side AgentMetricsAggregator (Phase 5b); `stateful` for static agents, backend name (`container` / `firecracker` / `bare-metal`) for scaler-managed
 */
export const logBytesTotal = meter.createCounter('kici_agent_log_bytes_total', {
  description: 'Total log bytes streamed',
});

/**
 * Rising-edge counter for log-streaming backpressure events.
 *
 * Incremented once each time a LogStreamer transitions from "normal" into
 * a backpressured state. Not incremented again until the streamer
 * recovers and trips again, so the series measures how often operators
 * saw pressure — not how long it lasted. Pair with
 * {@link logBackpressureActive} (current state) and
 * {@link logLinesDroppedTotal} (cumulative loss) for a complete picture.
 *
 * Labels:
 * - mode: `pause` (producer paused, no data loss) | `drop` (lines
 *   discarded with a `[N lines dropped due to backpressure]` marker)
 * - scaler: injected by orch-side AgentMetricsAggregator (Phase 5b); `stateful` for static agents, backend name (`container` / `firecracker` / `bare-metal`) for scaler-managed
 */
export const logBackpressureEventsTotal = meter.createCounter(
  'kici_agent_log_backpressure_events_total',
  {
    description: 'Total log-streamer backpressure rising-edge events',
  },
);

/**
 * Cumulative log lines dropped by the backpressure "drop" mode.
 *
 * Incremented in batches by the LogStreamer whenever it emits the
 * `[N lines dropped due to backpressure]` marker. Never decremented.
 * A non-zero rate on this series means operators are losing real log
 * content and should either expand the streamer's buffer or shrink the
 * producer.
 *
 * Labels:
 * - scaler: injected by orch-side AgentMetricsAggregator (Phase 5b); `stateful` for static agents, backend name (`container` / `firecracker` / `bare-metal`) for scaler-managed
 */
export const logLinesDroppedTotal = meter.createCounter('kici_agent_log_lines_dropped_total', {
  description: 'Total log lines dropped due to backpressure',
});

/**
 * Current backpressure state as a 0/1 up/down counter.
 *
 * Toggles to 1 when a LogStreamer enters backpressure and back to 0 on
 * recovery. Exposed as an up/down counter (not an observable gauge) so
 * the existing LogStreamer callbacks can update it imperatively from
 * both the single-job and step-streamer wiring paths.
 *
 * Grafana treats this as a step function: the area under the curve is
 * the total time spent backpressured. Labelled with `mode` so dashboards
 * can distinguish pause-mode from drop-mode pressure.
 *
 * Labels:
 * - mode: `pause` | `drop`
 * - scaler: injected by orch-side AgentMetricsAggregator (Phase 5b); `stateful` for static agents, backend name (`container` / `firecracker` / `bare-metal`) for scaler-managed
 */
export const logBackpressureActive = meter.createUpDownCounter(
  'kici_agent_log_backpressure_active',
  {
    description: 'Current log-streamer backpressure state (0=normal, 1=active)',
  },
);

// -- Connection status -------------------------------------------------------

/**
 * Orchestrator WebSocket connection status.
 * Use add(1) for connected, add(-1) for disconnected.
 *
 * Labels:
 * - scaler: injected by orch-side AgentMetricsAggregator (Phase 5b); `stateful` for static agents, backend name (`container` / `firecracker` / `bare-metal`) for scaler-managed
 */
export const connectionStatus = meter.createUpDownCounter('kici_agent_connection_status', {
  description: 'Orchestrator WebSocket connection status (0=disconnected, 1=connected)',
});
