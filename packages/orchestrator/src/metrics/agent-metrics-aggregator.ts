/**
 * In-memory aggregator for agent-pushed metrics.
 *
 * Agents push their OTel metrics snapshots via the WS `agent.metrics` message.
 * This aggregator stores the latest snapshot per agent and produces a
 * cardinality-bounded view by **collapsing all agents within the same
 * scaler pool into one series per (metric, labels, scaler)**. The
 * `agent_id` label is intentionally NOT emitted — including it would
 * make Mimir cardinality grow with the number of agents that have ever
 * existed (every ephemeral firecracker microVM minted a fresh ID), which
 * is unbounded. The caller-side dashboard filters by `scaler` instead,
 * which has a fixed enum of values (`stateful` / `container` /
 * `firecracker` / `bare-metal`).
 *
 * Aggregation rules per metric kind:
 *   - counter / upDownCounter / gauge → SUM across agents in the pool
 *   - histogram → bucket-by-bucket SUM, plus summed `_count` / `_sum`
 *
 * Trade-off: counter rates are approximate during agent churn. If
 * agent A reports `100` at t1 and disconnects, then agent B starts
 * fresh at `0` for t2, the combined series steps 100 → 0 — which
 * Prometheus interprets as a reset and `rate()` handles correctly.
 * Over a longer window though (e.g. a day with many ephemeral agents
 * appearing + disappearing), the integrated count can under-count.
 * The orchestrator-side counters (`kici_orch_*`) are the canonical
 * source for absolute totals; the agent counters here are for live
 * "what's happening right now" panels.
 *
 * Cleanup: after an agent disconnects, its snapshot is retained for one
 * configurable retention period (default 30s, ~2x scrape interval) so
 * Prometheus can scrape it at least once before it disappears.
 */

/** Shape of a single metric data point pushed by the agent. */
export interface MetricSnapshot {
  name: string;
  type: 'counter' | 'histogram' | 'gauge' | 'upDownCounter';
  value?: number;
  labels?: Record<string, string>;
  buckets?: Array<{ le: number; count: number }>;
  count?: number;
  sum?: number;
}

interface AgentEntry {
  metrics: MetricSnapshot[];
  updatedAt: number;
  disconnectedAt?: number;
}

export class AgentMetricsAggregator {
  private store = new Map<string, AgentEntry>();
  private defaultRetentionMs: number;
  /**
   * Optional lookup: agentId → scaler backend name (e.g. `container`,
   * `firecracker`, `bare-metal`). Returning null marks the agent as
   * static / stateful — we then stamp the `scaler` label as `'stateful'`.
   * Wired from ScalerManager.getBackendName in production. Tests can
   * leave it undefined; in that case the `scaler` label is omitted.
   */
  private readonly getScalerForAgent?: (agentId: string) => string | null;

  constructor(opts?: {
    retentionMs?: number;
    getScalerForAgent?: (agentId: string) => string | null;
  }) {
    this.defaultRetentionMs = opts?.retentionMs ?? 30_000;
    this.getScalerForAgent = opts?.getScalerForAgent;
  }

  /**
   * Resolve the `scaler` label for one agentId. Centralized so both the
   * structured snapshot (Mimir push) and the Prometheus text
   * exporter (HTTP /metrics) stamp identical values.
   */
  private resolveScalerLabel(agentId: string): string | undefined {
    if (!this.getScalerForAgent) return undefined;
    const backend = this.getScalerForAgent(agentId);
    return backend ?? 'stateful';
  }

  /** Store or replace metrics for an agent. */
  update(agentId: string, metrics: MetricSnapshot[]): void {
    this.store.set(agentId, {
      metrics,
      updatedAt: Date.now(),
      // Clear disconnectedAt if agent is sending metrics again (reconnected)
      disconnectedAt: undefined,
    });
  }

  /** Mark an agent as disconnected (start the retention countdown). */
  markDisconnected(agentId: string): void {
    const entry = this.store.get(agentId);
    if (entry) {
      entry.disconnectedAt = Date.now();
    }
  }

  /** Remove entries where disconnectedAt + retentionMs < now. */
  cleanup(retentionMs?: number): void {
    const retention = retentionMs ?? this.defaultRetentionMs;
    const now = Date.now();
    for (const [agentId, entry] of this.store) {
      if (entry.disconnectedAt && entry.disconnectedAt + retention < now) {
        this.store.delete(agentId);
      }
    }
  }

  /**
   * Build a stable string key for grouping metrics across agents. The
   * key encodes the metric name plus every label except `agent_id`
   * (which is dropped) and including the resolved `scaler`. Sorted so
   * insertion order can't sneak into the key.
   */
  private groupKey(name: string, labels: Record<string, string>): string {
    const entries = Object.entries(labels)
      .filter(([k]) => k !== 'agent_id')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `${name}|${entries.map(([k, v]) => `${k}=${v}`).join(',')}`;
  }

  /**
   * Walk every stored snapshot and bucket points into per-(metric, labels)
   * groups, summing counter / gauge values and merging histogram buckets
   * across all agents in each bucket. The bucketing key includes the
   * `scaler` label and excludes `agent_id`, so the output is one series
   * per (metric, labels-except-agent_id, scaler) combination.
   *
   * Returns one MetricSnapshot per group so both `getStructuredSnapshot`
   * and `getPrometheusText` can iterate the same shape.
   */
  private aggregateAcrossAgents(): MetricSnapshot[] {
    interface Acc {
      type: MetricSnapshot['type'];
      labels: Record<string, string>;
      // Counter / gauge / upDownCounter accumulator
      sumValue: number;
      // Histogram accumulators
      buckets: Map<number, number>;
      bucketCount: number;
      bucketSum: number;
    }

    const groups = new Map<string, Acc>();

    for (const [agentId, entry] of this.store) {
      const scaler = this.resolveScalerLabel(agentId);
      for (const metric of entry.metrics) {
        const labelsWithoutAgent: Record<string, string> = {};
        for (const [k, v] of Object.entries(metric.labels ?? {})) {
          if (k === 'agent_id') continue;
          labelsWithoutAgent[k] = v;
        }
        if (scaler) labelsWithoutAgent.scaler = scaler;

        const key = this.groupKey(metric.name + '__' + metric.type, labelsWithoutAgent);
        let acc = groups.get(key);
        if (!acc) {
          acc = {
            type: metric.type,
            labels: labelsWithoutAgent,
            sumValue: 0,
            buckets: new Map(),
            bucketCount: 0,
            bucketSum: 0,
          };
          groups.set(key, acc);
        }

        if (metric.type === 'histogram') {
          for (const b of metric.buckets ?? []) {
            acc.buckets.set(b.le, (acc.buckets.get(b.le) ?? 0) + b.count);
          }
          acc.bucketCount += metric.count ?? 0;
          acc.bucketSum += metric.sum ?? 0;
        } else {
          acc.sumValue += metric.value ?? 0;
        }
      }
    }

    const result: MetricSnapshot[] = [];
    for (const [key, acc] of groups) {
      // The key includes the metric name (before `__`); strip the type
      // suffix we appended to keep counter / gauge of the same name
      // separate (defensive, shouldn't happen in practice).
      const name = key.split('|', 1)[0]!.split('__')[0]!;
      if (acc.type === 'histogram') {
        const buckets = [...acc.buckets.entries()]
          .sort(([a], [b]) => a - b)
          .map(([le, count]) => ({ le, count }));
        result.push({
          name,
          type: 'histogram',
          labels: acc.labels,
          buckets,
          count: acc.bucketCount,
          sum: acc.bucketSum,
        });
      } else {
        result.push({
          name,
          type: acc.type,
          labels: acc.labels,
          value: acc.sumValue,
        });
      }
    }
    return result;
  }

  /**
   * Produce a structured snapshot of all stored agent metrics in the
   * `OrchMetrics['metrics']` wire shape — same format the orchestrator's
   * own `MetricsReporter` produces from its OTel exporter. Used by the
   * Platform-bound Mimir push pipeline so agent metrics land in Mimir
   * per-org alongside `kici_orch_*` .
   *
   * Output is **already aggregated across agents per scaler** — see the
   * class docstring for the cardinality rationale and counter trade-off.
   *
   * Runs `cleanup()` first so disconnected agents past their retention
   * window stop being emitted.
   */
  getStructuredSnapshot(): MetricSnapshot[] {
    this.cleanup();
    if (this.store.size === 0) return [];
    return this.aggregateAcrossAgents();
  }

  /**
   * Produce Prometheus exposition text for all stored agent metrics,
   * aggregated across agents per scaler. See `getStructuredSnapshot` for
   * the aggregation rules. Runs auto-cleanup before generating output.
   *
   * Groups metrics by name and emits `# TYPE` directives so Prometheus
   * correctly interprets histograms, counters, and gauges.
   */
  getPrometheusText(): string {
    this.cleanup();
    if (this.store.size === 0) return '';

    const aggregated = this.aggregateAcrossAgents();

    // Group by metric name so we emit one `# TYPE` directive per name.
    const byName = new Map<string, { type: MetricSnapshot['type']; entries: MetricSnapshot[] }>();
    for (const m of aggregated) {
      let g = byName.get(m.name);
      if (!g) {
        g = { type: m.type, entries: [] };
        byName.set(m.name, g);
      }
      g.entries.push(m);
    }

    const lines: string[] = [];
    for (const [name, group] of byName) {
      // Prometheus requires underscores, not dots, in metric names
      const safeName = name.replace(/\./g, '_');
      lines.push(`# TYPE ${safeName} ${mapPrometheusType(group.type)}`);

      for (const metric of group.entries) {
        // Sanitize label names (dots → underscores).
        const safeLabels: Record<string, string> = {};
        for (const [k, v] of Object.entries(metric.labels ?? {})) {
          safeLabels[k.replace(/\./g, '_')] = v;
        }
        if (metric.type === 'histogram') {
          this.formatHistogram(lines, metric, safeLabels, safeName);
        } else {
          const labelStr = formatLabels(safeLabels);
          lines.push(`${safeName}{${labelStr}} ${metric.value ?? 0}`);
        }
      }
    }

    return lines.join('\n');
  }

  private formatHistogram(
    lines: string[],
    metric: MetricSnapshot,
    baseLabels: Record<string, string>,
    safeName?: string,
  ): void {
    const name = safeName ?? metric.name.replace(/\./g, '_');
    const buckets = metric.buckets ?? [];
    const totalCount = metric.count ?? 0;

    for (const bucket of buckets) {
      const bucketLabels = { ...baseLabels, le: String(bucket.le) };
      lines.push(`${name}_bucket{${formatLabels(bucketLabels)}} ${bucket.count}`);
    }

    // +Inf bucket
    const infLabels = { ...baseLabels, le: '+Inf' };
    lines.push(`${name}_bucket{${formatLabels(infLabels)}} ${totalCount}`);

    // _count and _sum
    const labelStr = formatLabels(baseLabels);
    lines.push(`${name}_count{${labelStr}} ${totalCount}`);
    lines.push(`${name}_sum{${labelStr}} ${metric.sum ?? 0}`);
  }
}

/** Map internal metric type to Prometheus exposition type keyword. */
function mapPrometheusType(type: MetricSnapshot['type']): string {
  switch (type) {
    case 'counter':
      return 'counter';
    case 'histogram':
      return 'histogram';
    case 'gauge':
    case 'upDownCounter':
      return 'gauge';
  }
}

/** Escape a label value per Prometheus exposition format (backslash, double-quote, newline). */
function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Format a labels object as Prometheus label string: key1="val1",key2="val2" */
function formatLabels(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(',');
}
