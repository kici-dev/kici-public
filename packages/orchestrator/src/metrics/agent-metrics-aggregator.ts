/**
 * In-memory aggregator for the OTel snapshots agents push via the WS `agent.metrics` message.
 * Keeps the latest snapshot per agent and **collapses each scaler pool into one series per
 * (metric, labels, scaler)**. `agent_id` is NOT emitted: every ephemeral firecracker microVM
 * mints a fresh ID, so Mimir cardinality would grow without bound. Dashboards filter by
 * `scaler` instead, a fixed enum (`stateful` plus every `ScalerBackendType`).
 *
 * Aggregation rules per metric kind:
 *   - counter / upDownCounter / gauge → SUM across agents in the pool
 *   - histogram → bucket-by-bucket SUM, plus summed `_count` / `_sum`
 *
 * Trade-off: counter rates are approximate during agent churn. A series stepping 100 → 0
 * when one agent leaves and a fresh one starts is a reset `rate()` handles, but over a long
 * window with many ephemeral agents the integrated count can under-count. `kici_orch_*`
 * counters are the canonical absolute totals; these feed live "right now" panels.
 *
 * A disconnected agent's snapshot is kept for one retention period (default 30s, ~2x scrape
 * interval) so Prometheus scrapes it at least once.
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
   * agentId → scaler backend type (e.g. `container`, `firecracker`, `bare-metal`); null
   * stamps `scaler="stateful"`. Wired from ScalerManager.getBackendType; when undefined
   * (tests), the `scaler` label is omitted.
   */
  private readonly getScalerForAgent?: (agentId: string) => string | null;

  constructor(opts?: {
    retentionMs?: number;
    getScalerForAgent?: (agentId: string) => string | null;
  }) {
    this.defaultRetentionMs = opts?.retentionMs ?? 30_000;
    this.getScalerForAgent = opts?.getScalerForAgent;
  }

  /** Shared so the Mimir push and the HTTP /metrics exporter stamp identical values. */
  private resolveScalerLabel(agentId: string): string | undefined {
    if (!this.getScalerForAgent) return undefined;
    const backend = this.getScalerForAgent(agentId);
    return backend ?? 'stateful';
  }

  update(agentId: string, metrics: MetricSnapshot[]): void {
    this.store.set(agentId, {
      metrics,
      updatedAt: Date.now(),
      // A reporting agent has reconnected.
      disconnectedAt: undefined,
    });
  }

  /** Starts the retention countdown. */
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

  /** Grouping key: the name plus every label except `agent_id`, sorted so order is irrelevant. */
  private groupKey(name: string, labels: Record<string, string>): string {
    const entries = Object.entries(labels)
      .filter(([k]) => k !== 'agent_id')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `${name}|${entries.map(([k, v]) => `${k}=${v}`).join(',')}`;
  }

  /**
   * One summed MetricSnapshot per (metric, labels-except-agent_id, scaler), the shape both
   * `getStructuredSnapshot` and `getPrometheusText` iterate.
   */
  private aggregateAcrossAgents(): MetricSnapshot[] {
    interface Acc {
      type: MetricSnapshot['type'];
      labels: Record<string, string>;
      sumValue: number;
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
      // Strip the `__<type>` suffix that keeps a same-named counter and gauge apart (defensive).
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
   * Agent metrics in the `OrchMetrics['metrics']` wire shape (as `MetricsReporter` produces),
   * for the Platform-bound Mimir push, so they land per-org alongside `kici_orch_*`. Already
   * aggregated per scaler (see the class docstring). Runs `cleanup()` first.
   */
  getStructuredSnapshot(): MetricSnapshot[] {
    this.cleanup();
    if (this.store.size === 0) return [];
    return this.aggregateAcrossAgents();
  }

  /**
   * Prometheus exposition text, aggregated per scaler, with one `# TYPE` directive per name.
   * Runs `cleanup()` first.
   */
  getPrometheusText(): string {
    this.cleanup();
    if (this.store.size === 0) return '';

    const aggregated = this.aggregateAcrossAgents();

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
      // Prometheus names and label names allow no dots.
      const safeName = name.replace(/\./g, '_');
      lines.push(`# TYPE ${safeName} ${mapPrometheusType(group.type)}`);

      for (const metric of group.entries) {
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

    const infLabels = { ...baseLabels, le: '+Inf' };
    lines.push(`${name}_bucket{${formatLabels(infLabels)}} ${totalCount}`);

    const labelStr = formatLabels(baseLabels);
    lines.push(`${name}_count{${labelStr}} ${totalCount}`);
    lines.push(`${name}_sum{${labelStr}} ${metric.sum ?? 0}`);
  }
}

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

/** `key1="val1",key2="val2"` */
function formatLabels(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(',');
}
