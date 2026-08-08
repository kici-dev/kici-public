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

/** One instrument's identity plus the descriptor facts that decide its wire kind. */
export interface RuntimeMetricDescriptor {
  name: string;
  dataPointType: number;
  isMonotonic?: boolean;
}

/**
 * Boot `RuntimeNodeInstrumentation` standalone, exercise the event loop and
 * garbage collector, collect once, and return one descriptor per instrument it
 * emitted. It deliberately does NOT touch the singleton `_prometheusExporter` —
 * it spins up an isolated SDK so it can be called from tooling without
 * affecting a running service's telemetry.
 */
async function probeRuntimeInstruments(): Promise<RuntimeMetricDescriptor[]> {
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

  const descriptors: RuntimeMetricDescriptor[] = [];
  const { resourceMetrics } = await exporter.collect();
  for (const scopeMetrics of resourceMetrics.scopeMetrics) {
    for (const metric of scopeMetrics.metrics) {
      const m = metric as {
        descriptor: { name: string };
        dataPointType: number;
        isMonotonic?: boolean;
      };
      descriptors.push({
        name: m.descriptor.name,
        dataPointType: m.dataPointType,
        ...(m.isMonotonic === undefined ? {} : { isMonotonic: m.isMonotonic }),
      });
    }
  }
  await sdk.shutdown();
  return descriptors;
}

/**
 * The sorted set of dotted instrument names `RuntimeNodeInstrumentation`
 * emits. This is the ground truth for the curated runtime-metrics catalog
 * drift guard (`scripts/generate-prometheus.ts`).
 */
export async function collectRuntimeMetricNames(): Promise<string[]> {
  const descriptors = await probeRuntimeInstruments();
  return [...new Set(descriptors.map((d) => d.name))].sort();
}

/**
 * Like `collectRuntimeMetricNames`, but also returns each instrument's
 * descriptor type and monotonicity — the facts that decide the wire kind the
 * Platform admits it as. Ground truth for the drift guard's kind check.
 *
 * Deliberately not exported from the package barrel: it is tooling ground truth,
 * and `@kici-dev/shared` is a published surface.
 */
export async function collectRuntimeMetricDescriptors(): Promise<RuntimeMetricDescriptor[]> {
  const descriptors = await probeRuntimeInstruments();
  return descriptors.sort((a, b) => a.name.localeCompare(b.name));
}
