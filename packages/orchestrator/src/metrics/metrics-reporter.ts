/**
 * Periodic metrics reporter that collects OTel metrics and pushes them
 * to the Platform via WebSocket as `orch.metrics` messages.
 *
 * The Platform aggregates these metrics from all orchestrators and exposes
 * them on its `/metrics` endpoint for Prometheus scraping.
 */

import { randomUUID } from 'node:crypto';
import { getPrometheusExporter } from '@kici-dev/shared';
import type { OrchMetrics } from '@kici-dev/engine';
import { ORCH_PUSHED_METRIC_NAMES } from '@kici-dev/engine/metrics/catalog-policy';
import { type MetricName } from '@kici-dev/engine/metrics/catalog';
import type { AgentMetricsAggregator } from './agent-metrics-aggregator.js';

/**
 * OTel DataPointType enum values (from @opentelemetry/sdk-metrics).
 * We duplicate them here to avoid a direct runtime dependency on sdk-metrics.
 */
const DataPointType = { HISTOGRAM: 0, GAUGE: 2, SUM: 3 } as const;

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
     * Each agent metric carries an `agent_id` label injected by the
     * aggregator. See the metrics enforcement plan.
     */
    agentMetricsAggregator?: AgentMetricsAggregator;
  }) {
    this.send = opts.send;
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.agentMetricsAggregator = opts.agentMetricsAggregator;
  }

  /** Start periodic metric collection and push. */
  start(): void {
    this.timer = setInterval(() => {
      this.collectAndSend().catch(() => {
        // Silently swallow collection errors to avoid disrupting orchestrator operation
      });
    }, this.intervalMs);
  }

  /** Stop the periodic reporter. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Collect current metrics and send as orch.metrics message. */
  async collectAndSend(): Promise<void> {
    const orchMetrics = await this.collectSnapshot();
    const agentMetrics = this.agentMetricsAggregator?.getStructuredSnapshot() ?? [];
    const metrics = orchMetrics.concat(
      // The aggregator returns its local MetricSnapshot type; the wire
      // shape is structurally identical to OrchMetrics['metrics'][number]
      // (same fields, same enum). Cast keeps both sides honest without
      // dragging the engine type into the aggregator.
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

  /** Collect a snapshot of all current OTel metrics. */
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

          if (metricData.dataPointType === DataPointType.HISTOGRAM) {
            const histValue = dp.value as {
              buckets: { boundaries: number[]; counts: number[] };
              count: number;
              sum: number;
            };

            // Convert OTel per-bucket counts to cumulative Prometheus-style buckets
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

    // Pre-filter to the catalog's pushable set before sending. The OTel
    // exporter registry also carries `target_info` / `otel_scope_info` and
    // any other meta-series we never want in tenant Mimir; dropping them
    // here means the Platform-side filter (the security boundary) stops
    // bumping `unknown_metric` for our own junk. Catalog metrics — the
    // orchestrator's `kici_orch_*`, forwarded `kici_agent_*`, and the
    // Node runtime `nodejs.*` / `v8js.*` series — pass through.
    return result.filter((m) => ORCH_PUSHED_METRIC_NAMES.has(m.name as MetricName));
  }

  /** Map OTel DataPointType to wire format type string. */
  private mapDataPointType(
    dataPointType: number,
    isMonotonic?: boolean,
  ): 'counter' | 'histogram' | 'gauge' | 'upDownCounter' {
    switch (dataPointType) {
      case DataPointType.HISTOGRAM:
        return 'histogram';
      case DataPointType.GAUGE:
        return 'gauge';
      case DataPointType.SUM:
        return isMonotonic === false ? 'upDownCounter' : 'counter';
      default:
        return 'gauge';
    }
  }

  /** Extract string labels from OTel Attributes. */
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
