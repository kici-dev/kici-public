/**
 * Pushes OTel metrics to the Platform over WebSocket as `orch.metrics` messages; the Platform
 * aggregates all orchestrators and exposes them on `/metrics` for Prometheus.
 */

import { randomUUID } from 'node:crypto';
import { getPrometheusExporter } from '@kici-dev/shared';
import type { OrchMetrics } from '@kici-dev/engine';
import {
  OTEL_DATA_POINT_TYPE,
  mapDataPointTypeToWireKind,
  type WireMetricKind,
} from '@kici-dev/engine/metrics/metric-kind-compat';
import { ORCH_PUSHED_METRIC_NAMES } from '@kici-dev/engine/metrics/catalog-policy';
import { type MetricName } from '@kici-dev/engine/metrics/catalog';
import type { AgentMetricsAggregator } from './agent-metrics-aggregator.js';

export class MetricsReporter {
  private timer?: ReturnType<typeof setInterval>;
  private readonly send: (msg: OrchMetrics) => void;
  private readonly intervalMs: number;
  private readonly agentMetricsAggregator?: AgentMetricsAggregator;

  constructor(opts: {
    send: (msg: OrchMetrics) => void;
    intervalMs?: number;
    /**
     * If provided, the reporter concatenates the aggregator's structured
     * snapshot onto its own snapshot before sending — so agent metrics
     * (`kici_agent_*`) land in Mimir per-org alongside `kici_orch_*`.
     * The aggregator sums each agent metric across agents and drops the
     * `agent_id` label.
     */
    agentMetricsAggregator?: AgentMetricsAggregator;
  }) {
    this.send = opts.send;
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.agentMetricsAggregator = opts.agentMetricsAggregator;
  }

  start(): void {
    this.timer = setInterval(() => {
      this.collectAndSend().catch(() => {
        // Swallowed so a collection error never disrupts the orchestrator.
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async collectAndSend(): Promise<void> {
    const orchMetrics = await this.collectSnapshot();
    const agentMetrics = this.agentMetricsAggregator?.getStructuredSnapshot() ?? [];
    const metrics = orchMetrics.concat(
      // MetricSnapshot is structurally identical to OrchMetrics['metrics'][number]; the cast
      // keeps the engine type out of the aggregator.
      agentMetrics as OrchMetrics['metrics'],
    );
    if (metrics.length === 0) return;
    this.send({
      type: 'orch.metrics',
      messageId: randomUUID(),
      metrics,
      timestamp: Date.now(),
    });
  }

  async collectSnapshot(): Promise<OrchMetrics['metrics']> {
    const exporter = getPrometheusExporter();
    if (!exporter) return [];

    const { resourceMetrics } = await exporter.collect();
    const result: OrchMetrics['metrics'] = [];

    for (const scopeMetrics of resourceMetrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        const metricData = metric as {
          descriptor: { name: string };
          dataPointType: number;
          isMonotonic?: boolean;
          dataPoints: Array<{
            value: unknown;
            attributes: Record<string, unknown>;
          }>;
        };

        const name = metricData.descriptor.name;
        const wireType = this.mapDataPointType(metricData.dataPointType, metricData.isMonotonic);

        for (const dp of metricData.dataPoints) {
          const labels = this.extractLabels(dp.attributes);

          if (metricData.dataPointType === OTEL_DATA_POINT_TYPE.HISTOGRAM) {
            const histValue = dp.value as {
              buckets: { boundaries: number[]; counts: number[] };
              count: number;
              sum: number;
            };

            // OTel per-bucket counts → cumulative Prometheus buckets.
            const boundaries = histValue.buckets.boundaries;
            const counts = histValue.buckets.counts;
            const buckets: Array<{ le: number; count: number }> = [];
            let cumulative = 0;
            for (let i = 0; i < boundaries.length; i++) {
              cumulative += counts[i]!;
              buckets.push({ le: boundaries[i]!, count: cumulative });
            }

            result.push({
              name,
              type: 'histogram',
              ...(Object.keys(labels).length > 0 ? { labels } : {}),
              buckets,
              count: histValue.count,
              sum: histValue.sum,
            });
          } else {
            // SUM (counter/upDownCounter) or GAUGE
            result.push({
              name,
              type: wireType,
              value: dp.value as number,
              ...(Object.keys(labels).length > 0 ? { labels } : {}),
            });
          }
        }
      }
    }

    // Keep only the catalog's pushable set (`kici_orch_*`, forwarded `kici_agent_*`,
    // `nodejs.*` / `v8js.*`). Dropping meta-series such as `target_info` / `otel_scope_info`
    // here stops the Platform-side filter (the security boundary) bumping `unknown_metric`.
    return result.filter((m) => ORCH_PUSHED_METRIC_NAMES.has(m.name as MetricName));
  }

  private mapDataPointType(dataPointType: number, isMonotonic?: boolean): WireMetricKind {
    return mapDataPointTypeToWireKind(dataPointType, isMonotonic);
  }

  private extractLabels(attributes: Record<string, unknown>): Record<string, string> {
    const labels: Record<string, string> = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (typeof value === 'string') {
        labels[key] = value;
      } else if (value !== undefined && value !== null) {
        labels[key] = String(value);
      }
    }
    return labels;
  }
}
