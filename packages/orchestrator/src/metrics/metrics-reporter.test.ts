import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OrchMetrics } from '@kici-dev/engine';

// Mock getPrometheusExporter before importing the module under test
vi.mock('@kici-dev/shared', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getPrometheusExporter: vi.fn(),
  };
});

/**
 * OTel DataPointType enum values (from @opentelemetry/sdk-metrics):
 * HISTOGRAM = 0, EXPONENTIAL_HISTOGRAM = 1, GAUGE = 2, SUM = 3
 */
const DataPointType = { HISTOGRAM: 0, GAUGE: 2, SUM: 3 } as const;

describe('MetricsReporter', () => {
  let MetricsReporter: typeof import('./metrics-reporter.js').MetricsReporter;
  let getPrometheusExporter: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    const shared = await import('@kici-dev/shared');
    getPrometheusExporter = shared.getPrometheusExporter as ReturnType<typeof vi.fn>;
    const mod = await import('./metrics-reporter.js');
    MetricsReporter = mod.MetricsReporter;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Build a mock exporter that returns OTel CollectionResult. */
  function createMockExporter(
    metrics: Array<{
      name: string;
      dataPointType: number;
      isMonotonic?: boolean;
      dataPoints: Array<{
        value:
          | number
          | {
              buckets: { boundaries: number[]; counts: number[] };
              count: number;
              sum: number;
            };
        attributes?: Record<string, string>;
      }>;
    }>,
  ) {
    return {
      collect: vi.fn().mockResolvedValue({
        resourceMetrics: {
          scopeMetrics: [
            {
              metrics: metrics.map((m) => ({
                descriptor: { name: m.name },
                dataPointType: m.dataPointType,
                isMonotonic: m.isMonotonic ?? true,
                dataPoints: m.dataPoints.map((dp) => ({
                  value: dp.value,
                  attributes: dp.attributes ?? {},
                })),
              })),
            },
          ],
        },
        errors: [],
      }),
    };
  }

  it('collectAndSend() sends orch.metrics message with correct shape', async () => {
    const mockExporter = createMockExporter([
      {
        name: 'kici_orch_agents_active',
        dataPointType: DataPointType.GAUGE,
        dataPoints: [{ value: 3 }],
      },
    ]);
    getPrometheusExporter.mockReturnValue(mockExporter);

    const sent: OrchMetrics[] = [];
    const reporter = new MetricsReporter({
      send: (msg) => sent.push(msg),
    });

    await reporter.collectAndSend();
    expect(sent.length).toBe(1);
    expect(sent[0]!.type).toBe('orch.metrics');
    expect(sent[0]!.messageId).toBeDefined();
    expect(sent[0]!.timestamp).toBeGreaterThan(0);
    expect(sent[0]!.metrics.length).toBeGreaterThan(0);
    expect(sent[0]!.metrics[0]!.name).toBe('kici_orch_agents_active');
    expect(sent[0]!.metrics[0]!.type).toBe('gauge');
    expect(sent[0]!.metrics[0]!.value).toBe(3);
  });

  it('collectAndSend() does not send when no metrics exist', async () => {
    const mockExporter = createMockExporter([]);
    getPrometheusExporter.mockReturnValue(mockExporter);

    const sent: OrchMetrics[] = [];
    const reporter = new MetricsReporter({
      send: (msg) => sent.push(msg),
    });

    await reporter.collectAndSend();
    expect(sent.length).toBe(0);
  });

  it('collectSnapshot() returns empty array when exporter is undefined', async () => {
    getPrometheusExporter.mockReturnValue(undefined);

    const reporter = new MetricsReporter({
      send: () => {},
    });

    const snapshot = await reporter.collectSnapshot();
    expect(snapshot).toEqual([]);
  });

  it('start() begins periodic reporting at default ~30s interval', async () => {
    const mockExporter = createMockExporter([
      {
        name: 'kici_orch_agents_active',
        dataPointType: DataPointType.GAUGE,
        dataPoints: [{ value: 1 }],
      },
    ]);
    getPrometheusExporter.mockReturnValue(mockExporter);

    const sent: OrchMetrics[] = [];
    const reporter = new MetricsReporter({
      send: (msg) => sent.push(msg),
    });

    reporter.start();

    // Advance past 30s
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent.length).toBe(1);

    // Advance another 30s
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent.length).toBe(2);

    reporter.stop();
  });

  it('stop() clears interval', async () => {
    const mockExporter = createMockExporter([
      {
        name: 'kici_orch_agents_active',
        dataPointType: DataPointType.GAUGE,
        dataPoints: [{ value: 1 }],
      },
    ]);
    getPrometheusExporter.mockReturnValue(mockExporter);

    const sent: OrchMetrics[] = [];
    const reporter = new MetricsReporter({
      send: (msg) => sent.push(msg),
    });

    reporter.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent.length).toBe(1);

    reporter.stop();

    await vi.advanceTimersByTimeAsync(60_000);
    // No additional sends after stop
    expect(sent.length).toBe(1);
  });

  it('handles histogram metrics correctly', async () => {
    const mockExporter = createMockExporter([
      {
        name: 'kici_orch_trigger_match_duration_seconds',
        dataPointType: DataPointType.HISTOGRAM,
        dataPoints: [
          {
            value: {
              buckets: {
                boundaries: [0.01, 0.1, 1],
                counts: [2, 3, 3, 2], // n+1 counts for n boundaries
              },
              count: 10,
              sum: 2.5,
            },
          },
        ],
      },
    ]);
    getPrometheusExporter.mockReturnValue(mockExporter);

    const sent: OrchMetrics[] = [];
    const reporter = new MetricsReporter({
      send: (msg) => sent.push(msg),
    });

    await reporter.collectAndSend();
    expect(sent.length).toBe(1);

    const histMetric = sent[0]!.metrics.find(
      (m) => m.name === 'kici_orch_trigger_match_duration_seconds',
    );
    expect(histMetric).toBeDefined();
    expect(histMetric!.type).toBe('histogram');
    expect(histMetric!.buckets).toHaveLength(3);
    expect(histMetric!.buckets![0]).toEqual({ le: 0.01, count: 2 });
    expect(histMetric!.buckets![1]).toEqual({ le: 0.1, count: 5 }); // cumulative: 2+3
    expect(histMetric!.buckets![2]).toEqual({ le: 1, count: 8 }); // cumulative: 2+3+3
    expect(histMetric!.count).toBe(10);
    expect(histMetric!.sum).toBe(2.5);
  });

  it('includes labels in metrics', async () => {
    const mockExporter = createMockExporter([
      {
        name: 'kici_orch_dedup_hits_total',
        dataPointType: DataPointType.SUM,
        isMonotonic: true,
        dataPoints: [{ value: 5, attributes: { result: 'hit' } }],
      },
    ]);
    getPrometheusExporter.mockReturnValue(mockExporter);

    const sent: OrchMetrics[] = [];
    const reporter = new MetricsReporter({
      send: (msg) => sent.push(msg),
    });

    await reporter.collectAndSend();
    expect(sent[0]!.metrics[0]!.labels).toEqual({ result: 'hit' });
  });

  it('maps non-monotonic SUM as upDownCounter', async () => {
    const mockExporter = createMockExporter([
      {
        name: 'kici_orch_agents_active',
        dataPointType: DataPointType.SUM,
        isMonotonic: false,
        dataPoints: [{ value: 2 }],
      },
    ]);
    getPrometheusExporter.mockReturnValue(mockExporter);

    const reporter = new MetricsReporter({
      send: () => {},
    });

    const snapshot = await reporter.collectSnapshot();
    expect(snapshot[0]!.type).toBe('upDownCounter');
  });

  it('concatenates the agent metrics aggregator snapshot onto the orch snapshot', async () => {
    const mockExporter = createMockExporter([
      {
        name: 'kici_orch_agents_active',
        dataPointType: DataPointType.GAUGE,
        dataPoints: [{ value: 2 }],
      },
    ]);
    getPrometheusExporter.mockReturnValue(mockExporter);

    // Real aggregator — pushes a snapshot for two agents in the same scaler
    // pool. The aggregator deliberately collapses agent_id (cardinality
    // bound), so two agents in the same pool emit ONE summed series.
    const { AgentMetricsAggregator } = await import('./agent-metrics-aggregator.js');
    const aggregator = new AgentMetricsAggregator({ getScalerForAgent: () => 'firecracker' });
    aggregator.update('agent-aaa', [
      { name: 'kici_agent_jobs_total', type: 'counter', value: 7 },
      {
        name: 'kici_agent_step_duration_seconds',
        type: 'histogram',
        buckets: [
          { le: 1, count: 3 },
          { le: 5, count: 5 },
        ],
        count: 5,
        sum: 12.5,
      },
    ]);
    aggregator.update('agent-bbb', [{ name: 'kici_agent_jobs_total', type: 'counter', value: 2 }]);

    const sent: OrchMetrics[] = [];
    const reporter = new MetricsReporter({
      send: (msg) => sent.push(msg),
      agentMetricsAggregator: aggregator,
    });

    await reporter.collectAndSend();

    expect(sent.length).toBe(1);
    const all = sent[0]!.metrics;
    // Orchestrator's own metric is present.
    expect(all.find((m) => m.name === 'kici_orch_agents_active')?.value).toBe(2);
    // Agent counters from both agents collapse into one summed series
    // labeled only by `scaler` — never `agent_id`.
    const agentJobs = all.filter((m) => m.name === 'kici_agent_jobs_total');
    expect(agentJobs).toHaveLength(1);
    expect(agentJobs[0]!.labels).toEqual({ scaler: 'firecracker' });
    expect(agentJobs[0]!.value).toBe(9); // 7 + 2
    expect(agentJobs[0]!.labels?.agent_id).toBeUndefined();
    // Histogram structure preserved (only one agent emitted it, so no merging).
    const stepHist = all.find((m) => m.name === 'kici_agent_step_duration_seconds');
    expect(stepHist?.type).toBe('histogram');
    expect(stepHist?.labels).toEqual({ scaler: 'firecracker' });
    expect(stepHist?.labels?.agent_id).toBeUndefined();
    expect(stepHist?.count).toBe(5);
    expect(stepHist?.sum).toBe(12.5);
  });

  it('pre-filters non-catalog meta-series (target_info / otel_scope_info) at the source', async () => {
    const mockExporter = createMockExporter([
      {
        name: 'kici_orch_agents_active',
        dataPointType: DataPointType.GAUGE,
        dataPoints: [{ value: 1 }],
      },
      { name: 'target_info', dataPointType: DataPointType.GAUGE, dataPoints: [{ value: 1 }] },
      { name: 'otel_scope_info', dataPointType: DataPointType.GAUGE, dataPoints: [{ value: 1 }] },
    ]);
    getPrometheusExporter.mockReturnValue(mockExporter);

    const reporter = new MetricsReporter({ send: () => {} });
    const snapshot = await reporter.collectSnapshot();
    const names = snapshot.map((m) => m.name);
    expect(names).toContain('kici_orch_agents_active');
    expect(names).not.toContain('target_info');
    expect(names).not.toContain('otel_scope_info');
  });

  it('keeps Node runtime metrics (nodejs.* / v8js.*) through the pre-filter', async () => {
    const mockExporter = createMockExporter([
      {
        name: 'nodejs.eventloop.utilization',
        dataPointType: DataPointType.GAUGE,
        dataPoints: [{ value: 0.3 }],
      },
      {
        name: 'v8js.memory.heap.used',
        dataPointType: DataPointType.GAUGE,
        dataPoints: [{ value: 12345, attributes: { 'v8js.heap.space.name': 'old_space' } }],
      },
    ]);
    getPrometheusExporter.mockReturnValue(mockExporter);

    const reporter = new MetricsReporter({ send: () => {} });
    const names = (await reporter.collectSnapshot()).map((m) => m.name);
    expect(names).toContain('nodejs.eventloop.utilization');
    expect(names).toContain('v8js.memory.heap.used');
  });

  it('still sends when only the agent aggregator has data (orch snapshot empty)', async () => {
    const mockExporter = createMockExporter([]);
    getPrometheusExporter.mockReturnValue(mockExporter);

    const { AgentMetricsAggregator } = await import('./agent-metrics-aggregator.js');
    const aggregator = new AgentMetricsAggregator({ getScalerForAgent: () => null });
    aggregator.update('agent-only', [{ name: 'kici_agent_jobs_active', type: 'gauge', value: 1 }]);

    const sent: OrchMetrics[] = [];
    const reporter = new MetricsReporter({
      send: (msg) => sent.push(msg),
      agentMetricsAggregator: aggregator,
    });

    await reporter.collectAndSend();
    expect(sent.length).toBe(1);
    expect(sent[0]!.metrics).toHaveLength(1);
    expect(sent[0]!.metrics[0]!.name).toBe('kici_agent_jobs_active');
    // No scaler binding ⇒ `'stateful'` synthetic label, not agent_id.
    expect(sent[0]!.metrics[0]!.labels).toEqual({ scaler: 'stateful' });
  });
});
