import { NodeSDK } from '@opentelemetry/sdk-node';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';

export interface TelemetryConfig {
  serviceName: string;
  serviceVersion?: string;
  /** OTLP endpoint URL. If not set, OTLP trace export is disabled. */
  otlpEndpoint?: string;
  /** Metric prefix to match existing prom-client metrics (e.g., 'kici_', 'kici_orch_') */
  metricPrefix?: string;
}

let _prometheusExporter: PrometheusExporter | undefined;

/**
 * Initialize the OpenTelemetry SDK with Prometheus metrics and optional OTLP trace export.
 *
 * Call once at service startup. The Prometheus exporter is configured with
 * preventServerStart: true -- metrics are served via the existing /metrics route.
 */
export function initTelemetry(config: TelemetryConfig): NodeSDK {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion ?? '0.0.0',
  });

  const prometheusExporter = new PrometheusExporter({
    preventServerStart: true,
    prefix: config.metricPrefix,
  });
  _prometheusExporter = prometheusExporter;

  const traceExporter = config.otlpEndpoint
    ? new OTLPTraceExporter({ url: `${config.otlpEndpoint}/v1/traces` })
    : undefined;

  const sdk = new NodeSDK({
    resource,
    metricReader: prometheusExporter,
    traceExporter,
    instrumentations: [new RuntimeNodeInstrumentation()],
  });

  sdk.start();
  return sdk;
}

/** Get the PrometheusExporter instance created by initTelemetry(). */
export function getPrometheusExporter(): PrometheusExporter | undefined {
  return _prometheusExporter;
}

/**
 * Boot `RuntimeNodeInstrumentation` standalone, exercise the event loop and
 * garbage collector, collect once, and return the set of dotted instrument
 * names it emitted. This is the ground truth for the curated runtime-metrics
 * catalog drift guard (`scripts/generate-prometheus.ts`). It deliberately
 * does NOT touch the singleton `_prometheusExporter` — it spins up an
 * isolated SDK so it can be called from tooling without affecting a running
 * service's telemetry.
 */
export async function collectRuntimeMetricNames(): Promise<string[]> {
  const exporter = new PrometheusExporter({ preventServerStart: true });
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'runtime-metrics-drift-guard' }),
    metricReader: exporter,
    instrumentations: [new RuntimeNodeInstrumentation({ monitoringPrecision: 100 })],
  });
  sdk.start();

  // Generate event-loop activity and garbage so every gauge/counter/histogram
  // the instrumentation tracks registers at least one data point.
  for (let round = 0; round < 5; round++) {
    const junk: number[][] = [];
    for (let i = 0; i < 100; i++) junk.push(new Array(10_000).fill(i));
    void junk.length;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (typeof global.gc === 'function') global.gc();
  await new Promise((r) => setTimeout(r, 500));

  const names = new Set<string>();
  const { resourceMetrics } = await exporter.collect();
  for (const scopeMetrics of resourceMetrics.scopeMetrics) {
    for (const metric of scopeMetrics.metrics) {
      names.add((metric as { descriptor: { name: string } }).descriptor.name);
    }
  }
  await sdk.shutdown();
  return [...names].sort();
}
