import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentMetricsAggregator } from './agent-metrics-aggregator.js';

describe('AgentMetricsAggregator', () => {
  let aggregator: AgentMetricsAggregator;

  beforeEach(() => {
    aggregator = new AgentMetricsAggregator();
  });

  // -- Schema validation (imported from engine) --

  it('agentMetricsSchema validates well-formed agent.metrics message', async () => {
    const { agentMetricsSchema } = await import('@kici-dev/engine');

    const valid = {
      type: 'agent.metrics',
      messageId: 'msg-1',
      agentId: 'agent-1',
      metrics: [{ name: 'kici_agent_jobs_total', type: 'counter', value: 5 }],
      timestamp: Date.now(),
    };
    const result = agentMetricsSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('agentMetricsSchema rejects missing required fields', async () => {
    const { agentMetricsSchema } = await import('@kici-dev/engine');

    const invalid = {
      type: 'agent.metrics',
      // missing messageId, agentId, metrics, timestamp
    };
    const result = agentMetricsSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  // -- Cardinality contract --
  //
  // The aggregator deliberately drops `agent_id` so Mimir cardinality
  // doesn't grow with the number of agents that have ever existed (the
  // ephemeral-firecracker-microVM problem). All output is collapsed to
  // one series per (metric, labels-except-agent_id, scaler).

  it('never emits agent_id in Prometheus text output', () => {
    aggregator.update('agent-aaa', [{ name: 'kici_agent_jobs_total', type: 'counter', value: 3 }]);
    aggregator.update('agent-bbb', [{ name: 'kici_agent_jobs_total', type: 'counter', value: 7 }]);

    const text = aggregator.getPrometheusText();
    expect(text).not.toContain('agent_id');
  });

  it('never emits agent_id in structured snapshot output', () => {
    aggregator.update('agent-aaa', [{ name: 'kici_agent_jobs_total', type: 'counter', value: 3 }]);
    aggregator.update('agent-bbb', [{ name: 'kici_agent_jobs_total', type: 'counter', value: 7 }]);

    const snap = aggregator.getStructuredSnapshot();
    for (const m of snap) {
      expect(Object.keys(m.labels ?? {})).not.toContain('agent_id');
    }
  });

  // -- Aggregation across agents --

  it('sums counter values across agents within the same scaler pool', () => {
    const scalerByAgent: Record<string, string> = {
      'agent-1': 'firecracker',
      'agent-2': 'firecracker',
    };
    const agg = new AgentMetricsAggregator({
      getScalerForAgent: (id) => scalerByAgent[id] ?? null,
    });

    agg.update('agent-1', [{ name: 'kici_agent_jobs_total', type: 'counter', value: 3 }]);
    agg.update('agent-2', [{ name: 'kici_agent_jobs_total', type: 'counter', value: 7 }]);

    const snap = agg.getStructuredSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.value).toBe(10);
    expect(snap[0]!.labels).toEqual({ scaler: 'firecracker' });
  });

  it('produces separate series per scaler when agents belong to different pools', () => {
    const scalerByAgent: Record<string, string> = {
      'agent-fc': 'firecracker',
      'agent-c': 'container',
    };
    const agg = new AgentMetricsAggregator({
      getScalerForAgent: (id) => scalerByAgent[id] ?? null,
    });

    agg.update('agent-fc', [{ name: 'kici_agent_jobs_active', type: 'gauge', value: 2 }]);
    agg.update('agent-c', [{ name: 'kici_agent_jobs_active', type: 'gauge', value: 5 }]);

    const snap = agg.getStructuredSnapshot();
    expect(snap).toHaveLength(2);
    const fc = snap.find((m) => m.labels?.scaler === 'firecracker');
    const c = snap.find((m) => m.labels?.scaler === 'container');
    expect(fc?.value).toBe(2);
    expect(c?.value).toBe(5);
  });

  it('preserves non-agent_id labels when summing (e.g. step_status)', () => {
    const agg = new AgentMetricsAggregator({ getScalerForAgent: () => 'firecracker' });
    agg.update('agent-1', [
      {
        name: 'kici_agent_steps_total',
        type: 'counter',
        value: 4,
        labels: { step_status: 'success' },
      },
      {
        name: 'kici_agent_steps_total',
        type: 'counter',
        value: 1,
        labels: { step_status: 'failed' },
      },
    ]);
    agg.update('agent-2', [
      {
        name: 'kici_agent_steps_total',
        type: 'counter',
        value: 2,
        labels: { step_status: 'success' },
      },
    ]);

    const snap = agg.getStructuredSnapshot();
    expect(snap).toHaveLength(2);
    const success = snap.find((m) => m.labels?.step_status === 'success');
    const failed = snap.find((m) => m.labels?.step_status === 'failed');
    expect(success?.value).toBe(6); // 4 + 2
    expect(success?.labels).toEqual({ step_status: 'success', scaler: 'firecracker' });
    expect(failed?.value).toBe(1);
    expect(failed?.labels).toEqual({ step_status: 'failed', scaler: 'firecracker' });
  });

  it('merges histogram buckets across agents within the same scaler', () => {
    const agg = new AgentMetricsAggregator({ getScalerForAgent: () => 'firecracker' });
    agg.update('agent-1', [
      {
        name: 'kici_agent_step_duration_seconds',
        type: 'histogram',
        buckets: [
          { le: 1, count: 2 },
          { le: 5, count: 5 },
        ],
        count: 5,
        sum: 8.25,
      },
    ]);
    agg.update('agent-2', [
      {
        name: 'kici_agent_step_duration_seconds',
        type: 'histogram',
        buckets: [
          { le: 1, count: 1 },
          { le: 5, count: 3 },
        ],
        count: 3,
        sum: 4.5,
      },
    ]);

    const snap = agg.getStructuredSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.type).toBe('histogram');
    expect(snap[0]!.buckets).toEqual([
      { le: 1, count: 3 }, // 2 + 1
      { le: 5, count: 8 }, // 5 + 3
    ]);
    expect(snap[0]!.count).toBe(8); // 5 + 3
    expect(snap[0]!.sum).toBeCloseTo(12.75); // 8.25 + 4.5
    expect(snap[0]!.labels).toEqual({ scaler: 'firecracker' });
  });

  it('emits "stateful" scaler label for agents with no scaler binding', () => {
    const agg = new AgentMetricsAggregator({ getScalerForAgent: () => null });
    agg.update('static-agent', [{ name: 'kici_agent_jobs_total', type: 'counter', value: 4 }]);

    const snap = agg.getStructuredSnapshot();
    expect(snap[0]!.labels).toEqual({ scaler: 'stateful' });
  });

  it('omits scaler label entirely when getScalerForAgent is not configured', () => {
    aggregator.update('agent-1', [{ name: 'kici_agent_jobs_total', type: 'counter', value: 5 }]);

    const snap = aggregator.getStructuredSnapshot();
    expect(snap[0]!.labels).toEqual({});
  });

  // -- Prometheus text format --

  it('produces valid Prometheus text format with TYPE directive and aggregated value', () => {
    aggregator.update('agent-1', [{ name: 'kici_agent_jobs_total', type: 'counter', value: 5 }]);

    const text = aggregator.getPrometheusText();
    expect(text).toContain('# TYPE kici_agent_jobs_total counter');
    expect(text).toContain('kici_agent_jobs_total{} 5');
  });

  it('handles counter, gauge, and upDownCounter types with correct TYPE directives', () => {
    aggregator.update('agent-1', [
      { name: 'kici_agent_jobs_total', type: 'counter', value: 10 },
      { name: 'kici_agent_jobs_active', type: 'upDownCounter', value: 2 },
      { name: 'kici_agent_connection_status', type: 'gauge', value: 1 },
    ]);

    const text = aggregator.getPrometheusText();
    expect(text).toContain('# TYPE kici_agent_jobs_total counter');
    expect(text).toContain('# TYPE kici_agent_jobs_active gauge');
    expect(text).toContain('# TYPE kici_agent_connection_status gauge');
    expect(text).toContain('kici_agent_jobs_total{} 10');
    expect(text).toContain('kici_agent_jobs_active{} 2');
    expect(text).toContain('kici_agent_connection_status{} 1');
  });

  it('includes extra labels (other than agent_id) in output', () => {
    aggregator.update('agent-1', [
      { name: 'kici_agent_jobs_total', type: 'counter', value: 5, labels: { status: 'success' } },
    ]);

    const text = aggregator.getPrometheusText();
    expect(text).toContain('kici_agent_jobs_total{status="success"} 5');
  });

  it('TYPE directive appears once per metric name and before any sample lines', () => {
    aggregator.update('agent-1', [{ name: 'kici_agent_jobs_total', type: 'counter', value: 3 }]);
    aggregator.update('agent-2', [{ name: 'kici_agent_jobs_total', type: 'counter', value: 7 }]);

    const text = aggregator.getPrometheusText();
    const lines = text.split('\n');
    const typeIdx = lines.findIndex((l) => l === '# TYPE kici_agent_jobs_total counter');
    const firstSampleIdx = lines.findIndex((l) => l.startsWith('kici_agent_jobs_total{'));
    expect(typeIdx).toBeGreaterThanOrEqual(0);
    expect(typeIdx).toBeLessThan(firstSampleIdx);
    const typeCount = lines.filter((l) => l === '# TYPE kici_agent_jobs_total counter').length;
    expect(typeCount).toBe(1);
    // Aggregation across two agents → one summed line, total = 10.
    expect(text).toContain('kici_agent_jobs_total{} 10');
  });

  it('histogram Prometheus output includes _bucket, _count, _sum lines without agent_id', () => {
    aggregator.update('agent-1', [
      {
        name: 'kici_agent_step_duration_seconds',
        type: 'histogram',
        buckets: [
          { le: 0.1, count: 2 },
          { le: 1, count: 5 },
          { le: 5, count: 8 },
        ],
        count: 10,
        sum: 23.5,
      },
    ]);

    const text = aggregator.getPrometheusText();
    expect(text).toContain('# TYPE kici_agent_step_duration_seconds histogram');
    expect(text).toContain('kici_agent_step_duration_seconds_bucket{le="0.1"} 2');
    expect(text).toContain('kici_agent_step_duration_seconds_bucket{le="1"} 5');
    expect(text).toContain('kici_agent_step_duration_seconds_bucket{le="5"} 8');
    expect(text).toContain('kici_agent_step_duration_seconds_bucket{le="+Inf"} 10');
    expect(text).toContain('kici_agent_step_duration_seconds_count{} 10');
    expect(text).toContain('kici_agent_step_duration_seconds_sum{} 23.5');
    expect(text).not.toContain('agent_id');
  });

  // -- Cleanup --

  it('cleans up agent metrics after retention period post-disconnect', () => {
    aggregator.update('agent-1', [{ name: 'kici_agent_jobs_total', type: 'counter', value: 5 }]);
    aggregator.markDisconnected('agent-1');

    vi.useFakeTimers();
    vi.advanceTimersByTime(60_000);
    aggregator.cleanup(30_000);
    const text = aggregator.getPrometheusText();
    expect(text).toBe('');
    vi.useRealTimers();
  });

  it('retains disconnected agent metrics within retention period', () => {
    aggregator.update('agent-1', [{ name: 'kici_agent_jobs_total', type: 'counter', value: 5 }]);
    aggregator.markDisconnected('agent-1');

    aggregator.cleanup(60_000);
    const text = aggregator.getPrometheusText();
    expect(text).toContain('kici_agent_jobs_total{} 5');
  });

  // -- Empty state --

  it('getPrometheusText() returns empty string when no agent metrics exist', () => {
    const text = aggregator.getPrometheusText();
    expect(text).toBe('');
  });

  it('clears disconnectedAt when agent sends new metrics (reconnection)', () => {
    aggregator.update('agent-1', [{ name: 'kici_agent_jobs_total', type: 'counter', value: 5 }]);
    aggregator.markDisconnected('agent-1');
    aggregator.update('agent-1', [{ name: 'kici_agent_jobs_total', type: 'counter', value: 8 }]);

    vi.useFakeTimers();
    vi.advanceTimersByTime(60_000);
    aggregator.cleanup(30_000);

    const text = aggregator.getPrometheusText();
    expect(text).toContain('kici_agent_jobs_total{} 8');
    vi.useRealTimers();
  });

  it('escapes special characters in label values per Prometheus exposition format', () => {
    aggregator.update('agent-1', [
      {
        name: 'kici_agent_jobs_total',
        type: 'counter',
        value: 1,
        labels: { desc: 'line1\nline2', path: 'C:\\Users\\test', quoted: 'say "hello"' },
      },
    ]);

    const text = aggregator.getPrometheusText();
    expect(text).toContain('desc="line1\\nline2"');
    expect(text).toContain('path="C:\\\\Users\\\\test"');
    expect(text).toContain('quoted="say \\"hello\\""');
  });

  it('replaces previous metrics on update', () => {
    aggregator.update('agent-1', [{ name: 'kici_agent_jobs_total', type: 'counter', value: 5 }]);
    aggregator.update('agent-1', [{ name: 'kici_agent_jobs_total', type: 'counter', value: 10 }]);

    const text = aggregator.getPrometheusText();
    expect(text).toContain('kici_agent_jobs_total{} 10');
    expect(text).not.toContain('} 5\n');
  });

  // -- getStructuredSnapshot (agent → orch → Mimir per-org) --

  it('getStructuredSnapshot() returns empty array when no agents have pushed', () => {
    expect(aggregator.getStructuredSnapshot()).toEqual([]);
  });

  it('getStructuredSnapshot() runs cleanup so disconnected-past-retention agents drop out', () => {
    vi.useFakeTimers();
    try {
      aggregator.update('agent-old', [
        { name: 'kici_agent_jobs_total', type: 'counter', value: 1 },
      ]);
      aggregator.markDisconnected('agent-old');
      vi.advanceTimersByTime(60_000);
      aggregator.update('agent-new', [
        { name: 'kici_agent_jobs_total', type: 'counter', value: 2 },
      ]);

      const snap = aggregator.getStructuredSnapshot();
      // After cleanup, only agent-new remains; aggregated total = 2.
      expect(snap).toHaveLength(1);
      expect(snap[0]!.value).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
