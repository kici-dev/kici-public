import { describe, it, expect, vi, afterEach } from 'vitest';
import { IngestAdmissionController, type IngestAdmissionConfig } from './ingest-admission.js';
import { FakeLoopLagSource } from './loop-lag-source.js';
import {
  getIngestMetricState,
  setIngestAdmissionState,
  resetIngestMetricState,
} from '../metrics/prometheus.js';

const cfg = (o: Partial<IngestAdmissionConfig> = {}): IngestAdmissionConfig => ({
  maxConcurrency: 2,
  maxQueueDepth: 2,
  codelTargetMs: 50,
  codelIntervalMs: 100,
  queueMaxWaitMs: 1000,
  loopLagShedMs: 200,
  loopLagResumeMs: 150,
  loopLagSampleMs: 100,
  ...o,
});

const mkClock = (): { now: () => number; advance: (ms: number) => number } => {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

const controllers: IngestAdmissionController[] = [];
const mk = (
  deps: Omit<ConstructorParameters<typeof IngestAdmissionController>[0], 'startTimer'>,
) => {
  const c = new IngestAdmissionController({ ...deps, startTimer: false });
  controllers.push(c);
  return c;
};
afterEach(() => {
  for (const c of controllers.splice(0)) c.stop();
});

describe('IngestAdmissionController — caps & fairness', () => {
  it('admits immediately under the global and per-org caps', async () => {
    const c = mk({ config: cfg(), loopLag: new FakeLoopLagSource() });
    const r = await c.admit('org-a', 5);
    expect(r.admitted).toBe(true);
    expect(c.snapshot().inflight).toBe(1);
  });

  it('sheds with loop_overload when p99 exceeds L_shed (latched gate)', async () => {
    const lag = new FakeLoopLagSource();
    const c = mk({ config: cfg(), loopLag: lag });
    lag.setP99(250);
    c.sampleLoopLag();
    const r = await c.admit('org-a', 5);
    expect(r).toEqual({ admitted: false, reason: 'loop_overload' });
    expect(c.isShedding()).toBe(true);
  });

  it('hysteresis: gate stays open between resume and shed thresholds, closes below resume', async () => {
    const lag = new FakeLoopLagSource();
    const c = mk({ config: cfg(), loopLag: lag });
    lag.setP99(250);
    c.sampleLoopLag(); // open
    expect(c.isShedding()).toBe(true);
    lag.setP99(180); // between resume(150) and shed(200) -> stays open
    c.sampleLoopLag();
    expect(c.isShedding()).toBe(true);
    lag.setP99(140); // below resume -> closes
    c.sampleLoopLag();
    expect(c.isShedding()).toBe(false);
  });

  it('queues when the global cap is full, admits on release', async () => {
    const clock = mkClock();
    const c = mk({
      config: cfg({ maxConcurrency: 1 }),
      loopLag: new FakeLoopLagSource(),
      now: clock.now,
    });
    const a = await c.admit('org-a', 5);
    expect(a.admitted).toBe(true);
    const bP = c.admit('org-b', 5); // queued
    expect(c.snapshot().queueDepth).toBe(1);
    if (a.admitted) a.release();
    const b = await bP;
    expect(b.admitted).toBe(true);
  });

  it('per-org cap: a maxed org does not block another org behind it', async () => {
    const c = mk({ config: cfg({ maxConcurrency: 3 }), loopLag: new FakeLoopLagSource() });
    const a1 = await c.admit('org-a', 1); // org-a at its cap of 1
    const aQueued = c.admit('org-a', 1); // org-a over cap -> queued
    const b1 = await c.admit('org-b', 1); // org-b under global (2<3) and its own cap -> admitted
    expect(a1.admitted).toBe(true);
    expect(b1.admitted).toBe(true);
    expect(c.snapshot().queueDepth).toBe(1);
    if (a1.admitted) a1.release();
    expect((await aQueued).admitted).toBe(true);
  });

  it('sheds queue_full when the queue is at capacity', async () => {
    const c = mk({
      config: cfg({ maxConcurrency: 1, maxQueueDepth: 1 }),
      loopLag: new FakeLoopLagSource(),
    });
    await c.admit('a', 5); // inflight full
    void c.admit('b', 5); // queued (depth 1)
    const r = await c.admit('c', 5); // queue full -> shed
    expect(r).toEqual({ admitted: false, reason: 'queue_full' });
  });

  it('sheds queue_full immediately for a non-queueing caller (WS relay path)', async () => {
    const c = mk({
      config: cfg({ maxConcurrency: 1, maxQueueDepth: 100 }),
      loopLag: new FakeLoopLagSource(),
    });
    await c.admit('a', 5, { allowQueue: true }); // inflight full
    const r = await c.admit('b', 5, { allowQueue: false }); // no queue -> immediate shed
    expect(r).toEqual({ admitted: false, reason: 'queue_full' });
    expect(c.snapshot().queueDepth).toBe(0);
  });

  it('sheds max_sojourn when a waiter exceeds queueMaxWaitMs', async () => {
    const clock = mkClock();
    const onShed = vi.fn();
    const c = mk({
      config: cfg({ maxConcurrency: 1, queueMaxWaitMs: 100 }),
      loopLag: new FakeLoopLagSource(),
      now: clock.now,
      onShed,
    });
    await c.admit('a', 5);
    const qP = c.admit('b', 5);
    clock.advance(150);
    c.tickQueue();
    const r = await qP;
    expect(r).toEqual({ admitted: false, reason: 'max_sojourn' });
    expect(onShed).toHaveBeenCalledWith('max_sojourn', 'b');
  });

  it('stop() drains the queue, resolving every waiter as shed', async () => {
    const c = mk({ config: cfg({ maxConcurrency: 1 }), loopLag: new FakeLoopLagSource() });
    await c.admit('a', 5);
    const qP = c.admit('b', 5);
    c.stop();
    const r = await qP;
    expect(r.admitted).toBe(false);
  });
});

describe('IngestAdmissionController — CoDel', () => {
  it('a transient burst drains with no codel drops', async () => {
    const clock = mkClock();
    const c = mk({
      config: cfg({
        maxConcurrency: 1,
        maxQueueDepth: 10,
        codelTargetMs: 50,
        codelIntervalMs: 100,
        queueMaxWaitMs: 100000,
      }),
      loopLag: new FakeLoopLagSource(),
      now: clock.now,
    });
    const a = await c.admit('a', 10);
    const qP = c.admit('a', 10); // queued
    clock.advance(10); // head sojourn 10ms < target -> not standing
    c.tickQueue();
    if (a.admitted) a.release(); // drains
    const r = await qP;
    expect(r.admitted).toBe(true);
  });

  it('a standing queue sheds codel_drop after the interval', async () => {
    const clock = mkClock();
    const c = mk({
      config: cfg({
        maxConcurrency: 1,
        maxQueueDepth: 10,
        codelTargetMs: 50,
        codelIntervalMs: 100,
        queueMaxWaitMs: 100000,
      }),
      loopLag: new FakeLoopLagSource(),
      now: clock.now,
    });
    await c.admit('a', 10); // inflight full, never released (standing)
    const qP = c.admit('b', 10); // queued at t=0
    clock.advance(60);
    c.tickQueue(); // t=60: head sojourn 60 >= target(50) -> codelAboveSince=60, no drop yet
    expect(c.isShedding()).toBe(false);
    clock.advance(110);
    c.tickQueue(); // t=170: standingFor = 170-60 = 110 >= interval(100) -> drop head
    const r = await qP;
    expect(r).toEqual({ admitted: false, reason: 'codel_drop' });
    expect(c.isShedding()).toBe(true);
  });
});

describe('IngestAdmissionController — metric correspondence', () => {
  it('emits controller state to the metric sink and drives the admit/shed counters', async () => {
    resetIngestMetricState();
    const shedReasons: string[] = [];
    let admits = 0;
    const c = mk({
      config: cfg({ maxConcurrency: 1, maxQueueDepth: 0 }),
      loopLag: new FakeLoopLagSource(),
      onStateChange: setIngestAdmissionState,
      onShedMetric: (r) => shedReasons.push(r),
      onAdmitMetric: () => {
        admits++;
      },
    });
    const a = await c.admit('a', 5);
    expect(getIngestMetricState().inflight).toBe(1);
    expect(admits).toBe(1);
    const r = await c.admit('b', 5); // queue depth 0 -> shed queue_full
    expect(r).toEqual({ admitted: false, reason: 'queue_full' });
    expect(shedReasons).toEqual(['queue_full']);
    if (a.admitted) a.release();
    expect(getIngestMetricState().inflight).toBe(0);
  });
});
