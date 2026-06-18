/**
 * Periodic metrics reporter that collects OTel metrics and pushes them
 * to the orchestrator via WebSocket as `agent.metrics` messages.
 *
 * The orchestrator aggregates these metrics from all agents and exposes
 * them on its `/metrics` endpoint for Prometheus scraping.
 */

import { randomUUID } from 'node:crypto';
import { getPrometheusExporter } from '@kici-dev/shared';
import type { AgentMetrics } from '@kici-dev/engine';

/**
 * OTel DataPointType enum values (from @opentelemetry/sdk-metrics).
 * We duplicate them here to avoid a direct runtime dependency on sdk-metrics.
 */
const DataPointType = { HISTOGRAM: 0, GAUGE: 2, SUM: 3 } as const;

export class MetricsReporter {
  private timer?: ReturnType<typeof setInterval>;
  private readonly agentId: string;
  private readonly send: (msg: AgentMetrics) => void;
  private readonly intervalMs: number;

  constructor(opts: { agentId: string; send: (msg: AgentMetrics) => void; intervalMs?: number }) {
    this.agentId = opts.agentId;
    this.send = opts.send;
    this.intervalMs = opts.intervalMs ?? 30_000;
  }

  /** Start periodic metric collection and push. */
  start(): void {
    this.timer = setInterval(() => {
      this.collectAndSend().catch(() => {
        // Silently swallow collection errors to avoid disrupting agent operation
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

  /** Collect current metrics and send as agent.metrics message. */
  async collectAndSend(): Promise<void> {
    const metrics = await this.collectSnapshot();
    if (metrics.length === 0) return;
    this.send({
      type: 'agent.metrics',
      messageId: randomUUID(),
      agentId: this.agentId,
      metrics,
      timestamp: Date.now(),
    });
  }

  /** Collect a snapshot of all current OTel metrics. */
  async collectSnapshot(): Promise<AgentMetrics['metrics']> {
    const exporter = getPrometheusExporter();
    if (!exporter) return [];

    const { resourceMetrics } = await exporter.collect();
    const result: AgentMetrics['metrics'] = [];

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

    return result;
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
