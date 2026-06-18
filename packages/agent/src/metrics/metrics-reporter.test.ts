import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentMetrics } from '@kici-dev/engine';

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
          | { buckets: { boundaries: number[]; counts: number[] }; count: number; sum: number };
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

  it('collectSnapshot() returns array of MetricSnapshot objects', async () => {
    const mockExporter = createMockExporter([
      {
        name: 'kici_agent_jobs_total',
        dataPointType: DataPointType.SUM,
        isMonotonic: true,
        dataPoints: [{ value: 5, attributes: { status: 'success' } }],
      },
    ]);
    getPrometheusExporter.mockReturnValue(mockExporter);

    const sent: AgentMetrics[] = [];
    const reporter = new MetricsReporter({
      agentId: 'agent-1',
      send: (msg) => sent.push(msg),
    });

    const snapshot = await reporter.collectSnapshot();
    expect(snapshot.length).toBeGreaterThan(0);
    expect(snapshot[0]!.name).toBe('kici_agent_jobs_total');
    expect(snapshot[0]!.type).toBe('counter');
    expect(snapshot[0]!.value).toBe(5);
    expect(snapshot[0]!.labels).toEqual({ status: 'success' });
  });

  it('collectSnapshot() returns empty array when exporter is undefined', async () => {
    getPrometheusExporter.mockReturnValue(undefined);

    const reporter = new MetricsReporter({
      agentId: 'agent-1',
      send: () => {},
    });

    const snapshot = await reporter.collectSnapshot();
    expect(snapshot).toEqual([]);
  });

  it('collectAndSend() sends agent.metrics message', async () => {
    const mockExporter = createMockExporter([
      {
        name: 'kici_agent_jobs_total',
        dataPointType: DataPointType.SUM,
        dataPoints: [{ value: 3 }],
      },
    ]);
    getPrometheusExporter.mockReturnValue(mockExporter);

    const sent: AgentMetrics[] = [];
    const reporter = new MetricsReporter({
      agentId: 'agent-1',
      send: (msg) => sent.push(msg),
    });

    await reporter.collectAndSend();
    expect(sent.length).toBe(1);
    expect(sent[0]!.type).toBe('agent.metrics');
    expect(sent[0]!.agentId).toBe('agent-1');
    expect(sent[0]!.metrics.length).toBeGreaterThan(0);
  });

  it('collectAndSend() does not send when no metrics exist', async () => {
    const mockExporter = createMockExporter([]);
    getPrometheusExporter.mockReturnValue(mockExporter);

    const sent: AgentMetrics[] = [];
    const reporter = new MetricsReporter({
      agentId: 'agent-1',
      send: (msg) => sent.push(msg),
    });

    await reporter.collectAndSend();
    expect(sent.length).toBe(0);
  });

  it('start() begins periodic reporting at default ~30s interval', async () => {
    const mockExporter = createMockExporter([
      {
        name: 'kici_agent_jobs_total',
        dataPointType: DataPointType.SUM,
        dataPoints: [{ value: 1 }],
      },
    ]);
    getPrometheusExporter.mockReturnValue(mockExporter);

    const sent: AgentMetrics[] = [];
    const reporter = new MetricsReporter({
      agentId: 'agent-1',
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
        name: 'kici_agent_jobs_total',
        dataPointType: DataPointType.SUM,
        dataPoints: [{ value: 1 }],
      },
    ]);
    getPrometheusExporter.mockReturnValue(mockExporter);

    const sent: AgentMetrics[] = [];
    const reporter = new MetricsReporter({
      agentId: 'agent-1',
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
        name: 'kici_agent_step_duration_seconds',
        dataPointType: DataPointType.HISTOGRAM,
        dataPoints: [
          {
            value: {
              buckets: {
                boundaries: [0.1, 1, 5],
                counts: [2, 3, 3, 2], // n+1 counts for n boundaries
              },
              count: 10,
              sum: 23.5,
            },
          },
        ],
      },
    ]);
    getPrometheusExporter.mockReturnValue(mockExporter);

    const sent: AgentMetrics[] = [];
    const reporter = new MetricsReporter({
      agentId: 'agent-1',
      send: (msg) => sent.push(msg),
    });

    await reporter.collectAndSend();
    expect(sent.length).toBe(1);

    const histMetric = sent[0]!.metrics.find((m) => m.name === 'kici_agent_step_duration_seconds');
    expect(histMetric).toBeDefined();
    expect(histMetric!.type).toBe('histogram');
    expect(histMetric!.buckets).toHaveLength(3);
    expect(histMetric!.buckets![0]).toEqual({ le: 0.1, count: 2 });
    expect(histMetric!.buckets![1]).toEqual({ le: 1, count: 5 }); // cumulative: 2+3
    expect(histMetric!.buckets![2]).toEqual({ le: 5, count: 8 }); // cumulative: 2+3+3
    expect(histMetric!.count).toBe(10);
    expect(histMetric!.sum).toBe(23.5);
  });

  it('maps gauge dataPointType correctly', async () => {
    const mockExporter = createMockExporter([
      {
        name: 'kici_agent_connection_status',
        dataPointType: DataPointType.GAUGE,
        dataPoints: [{ value: 1 }],
      },
    ]);
    getPrometheusExporter.mockReturnValue(mockExporter);

    const reporter = new MetricsReporter({
      agentId: 'agent-1',
      send: () => {},
    });

    const snapshot = await reporter.collectSnapshot();
    expect(snapshot[0]!.type).toBe('gauge');
  });

  it('maps non-monotonic SUM as upDownCounter', async () => {
    const mockExporter = createMockExporter([
      {
        name: 'kici_agent_jobs_active',
        dataPointType: DataPointType.SUM,
        isMonotonic: false,
        dataPoints: [{ value: 2 }],
      },
    ]);
    getPrometheusExporter.mockReturnValue(mockExporter);

    const reporter = new MetricsReporter({
      agentId: 'agent-1',
      send: () => {},
    });

    const snapshot = await reporter.collectSnapshot();
    expect(snapshot[0]!.type).toBe('upDownCounter');
  });
});
