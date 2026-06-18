import { describe, it, expect, beforeAll } from 'vitest';
import { initTelemetry } from '@kici-dev/shared';

// Initialize OTel SDK before importing metrics (mirrors real startup order:
// initTelemetry() wires the global MeterProvider before any instrument is used).
beforeAll(() => {
  initTelemetry({
    serviceName: 'kici-orchestrator-test',
    metricPrefix: 'kici_orch_',
  });
});

describe('orchestrator scheduled-job metrics', () => {
  it('exposes counter / histogram / gauge instruments with the OTel method surface', async () => {
    const m = await import('./scheduled-jobs.js');
    expect(m.jobRunsTotal.add).toBeTypeOf('function');
    expect(m.jobDurationSeconds.record).toBeTypeOf('function');
    expect(m.jobLastSuccessTimestamp.set).toBeTypeOf('function');
    expect(m.jobLastFailureTimestamp.set).toBeTypeOf('function');
    expect(m.jobConsecutiveFailures.set).toBeTypeOf('function');
  });

  // Regression guard for the no-op-provider bug: the meter and every
  // instrument in scheduled-jobs.ts MUST be resolved lazily (on first use),
  // not at module-eval time. The `@kici-dev/shared` barrel is imported
  // statically at the top of the orchestrator entry points, which evaluates
  // this module before initTelemetry() sets the global MeterProvider — so a
  // module-eval instrument binds to the no-op provider and never reaches the
  // Prometheus exporter (the cold-store-framework-smoke E2E caught exactly
  // this: kici_orch_job_last_success_timestamp_seconds stayed absent after a
  // successful cold-store-archive tick).
  it('records reach the Prometheus exporter after a job tick', async () => {
    const { getPrometheusExporter } = await import('@kici-dev/shared');
    const m = await import('./scheduled-jobs.js');

    // Drive each instrument the way the scheduled-job wrapper does on a
    // successful tick.
    m.jobRunsTotal.add(1, { job: 'cold-store-archive', result: 'success' });
    m.jobDurationSeconds.record(0.02, { job: 'cold-store-archive' });
    m.jobLastSuccessTimestamp.set({ job: 'cold-store-archive' }, Math.floor(Date.now() / 1000));
    m.jobConsecutiveFailures.set({ job: 'cold-store-archive' }, 0);

    const exporter = getPrometheusExporter();
    expect(exporter).toBeDefined();
    const { resourceMetrics } = await exporter!.collect();
    const names = resourceMetrics.scopeMetrics.flatMap((sm) =>
      sm.metrics.map((metric) => (metric as { descriptor: { name: string } }).descriptor.name),
    );

    // Suffix match: beforeAll inits telemetry with a kici_orch_ prefix.
    expect(names.some((n) => n.includes('job_runs_total'))).toBe(true);
    expect(names.some((n) => n.includes('job_duration_seconds'))).toBe(true);
    expect(names.some((n) => n.includes('job_last_success_timestamp_seconds'))).toBe(true);
    expect(names.some((n) => n.includes('job_consecutive_failures'))).toBe(true);
  });
});
