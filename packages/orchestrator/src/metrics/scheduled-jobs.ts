/**
 * Scheduled-job observability metrics for the orchestrator.
 *
 * Mirrors the 5-metric surface exposed by other KiCI services'
 * scheduled-job wrappers, with names prefixed `kici_orch_` so
 * Prometheus can address multiple KiCI services from one dashboard.
 * The orchestrator runs setInterval-driven schedulers (no pg-boss
 * dependency) but the outward observability shape is identical.
 *
 * Lazy meter + instrument initialization: the `@kici-dev/shared` barrel
 * is imported statically at the top of the orchestrator entry points
 * (server.ts, standalone.ts), which evaluates this module BEFORE
 * `initTelemetry()` sets the global MeterProvider. Creating the meter or
 * any instrument at module-eval time would bind it to the no-op provider,
 * so its samples never reach the Prometheus exporter (the `/metrics`
 * scrape) or the Platform push. We therefore resolve the meter and every
 * instrument on first use — counters/histograms on first `.add()` /
 * `.record()`, observable gauges on first `.set()` — all of which happen
 * at job-run time, long after telemetry is wired up. Same hazard, same
 * fix as `prometheus.ts` and `@kici-dev/shared`'s cold-store metrics
 * module.
 */
import { createMeter } from '@kici-dev/shared';

type OrchMeter = ReturnType<typeof createMeter>;
type Counter = ReturnType<OrchMeter['createCounter']>;
type Histogram = ReturnType<OrchMeter['createHistogram']>;
type ObservableGauge = ReturnType<OrchMeter['createObservableGauge']>;
type ObservableResult = Parameters<Parameters<ObservableGauge['addCallback']>[0]>[0];

let _meter: OrchMeter | undefined;
function meter(): OrchMeter {
  if (!_meter) _meter = createMeter('kici-orchestrator');
  return _meter;
}

/**
 * A counter whose real OTel instrument is created on first `.add()` —
 * after `initTelemetry()` has registered the global MeterProvider. The
 * returned value satisfies the OTel `Counter` interface, so call sites
 * are unchanged.
 */
function lazyCounter(name: string, description: string): Pick<Counter, 'add'> {
  let inst: Counter | undefined;
  const get = (): Counter => (inst ??= meter().createCounter(name, { description }));
  return { add: (...args: Parameters<Counter['add']>) => get().add(...args) };
}

/**
 * A histogram whose real OTel instrument is created on first `.record()` —
 * after `initTelemetry()`. Satisfies the OTel `Histogram` interface.
 */
function lazyHistogram(
  name: string,
  description: string,
  explicitBucketBoundaries: number[],
): Pick<Histogram, 'record'> {
  let inst: Histogram | undefined;
  const get = (): Histogram =>
    (inst ??= meter().createHistogram(name, { description, advice: { explicitBucketBoundaries } }));
  return { record: (...args: Parameters<Histogram['record']>) => get().record(...args) };
}

/**
 * An observable gauge backed by per-label state. The underlying OTel
 * instrument + scrape callback are created on first `.set()`, so the
 * gauge binds to the real MeterProvider rather than the no-op one. The
 * callback reads the latest per-label value on each Prometheus scrape.
 */
function createGaugeWithState(name: string, description: string) {
  const state = new Map<string, { attributes: Record<string, string>; value: number }>();
  let registered = false;

  function ensureRegistered(): void {
    if (registered) return;
    registered = true;
    meter()
      .createObservableGauge(name, { description })
      .addCallback((result: ObservableResult) => {
        for (const entry of state.values()) {
          result.observe(entry.value, entry.attributes);
        }
      });
  }

  return {
    set(labels: Record<string, string>, value: number): void {
      ensureRegistered();
      const key = JSON.stringify(labels);
      state.set(key, { attributes: labels, value });
    },
    reset(): void {
      state.clear();
    },
  };
}

/**
 * Success/failure counter for each tick of each scheduled job.
 * Labels:
 * - job: scheduled-job name (one of `OrchestratorScheduledJobName`)
 * - result: success | failure
 */
export const jobRunsTotal = lazyCounter(
  'kici_orch_job_runs_total',
  'Scheduled job run outcomes, by job and result (success/failure)',
);

/**
 * Histogram of per-tick duration, seconds.
 * Labels:
 * - job: scheduled-job name (one of `OrchestratorScheduledJobName`)
 */
export const jobDurationSeconds = lazyHistogram(
  'kici_orch_job_duration_seconds',
  'Scheduled job tick duration in seconds',
  [0.01, 0.05, 0.1, 0.5, 1, 5, 30, 120, 600],
);

/**
 * Unix timestamp (seconds) of the most recent successful tick.
 * Labels:
 * - job: scheduled-job name (one of `OrchestratorScheduledJobName`)
 */
export const jobLastSuccessTimestamp = createGaugeWithState(
  'kici_orch_job_last_success_timestamp_seconds',
  'Unix timestamp of the most recent successful scheduled job tick',
);

/**
 * Unix timestamp (seconds) of the most recent failed tick.
 * Labels:
 * - job: scheduled-job name (one of `OrchestratorScheduledJobName`)
 */
export const jobLastFailureTimestamp = createGaugeWithState(
  'kici_orch_job_last_failure_timestamp_seconds',
  'Unix timestamp of the most recent failed scheduled job tick',
);

/**
 * Count of consecutive failures since last success. Resets to 0 on success.
 * Labels:
 * - job: scheduled-job name (one of `OrchestratorScheduledJobName`)
 */
export const jobConsecutiveFailures = createGaugeWithState(
  'kici_orch_job_consecutive_failures',
  'Consecutive failures for each scheduled job since its last success',
);
