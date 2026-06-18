import { describe, it, expect } from 'vitest';
import {
  jobsTotal,
  jobsActive,
  stepsTotal,
  stepDurationSeconds,
  cloneDurationSeconds,
  logBytesTotal,
  logBackpressureEventsTotal,
  logLinesDroppedTotal,
  logBackpressureActive,
  connectionStatus,
} from './prometheus.js';

describe('prometheus metrics', () => {
  it('exports all 6 expected metrics plus connectionStatus', () => {
    // All metrics should be defined (OTel instruments)
    expect(jobsTotal).toBeDefined();
    expect(jobsActive).toBeDefined();
    expect(stepsTotal).toBeDefined();
    expect(stepDurationSeconds).toBeDefined();
    expect(cloneDurationSeconds).toBeDefined();
    expect(logBytesTotal).toBeDefined();
    expect(connectionStatus).toBeDefined();
  });

  it('counters have add method (OTel Counter API)', () => {
    // OTel Counter uses .add() instead of prom-client .inc()
    expect(typeof jobsTotal.add).toBe('function');
    expect(typeof stepsTotal.add).toBe('function');
    expect(typeof logBytesTotal.add).toBe('function');
  });

  it('gauges have add method (OTel UpDownCounter API)', () => {
    // OTel UpDownCounter uses .add() for both inc and dec
    expect(typeof jobsActive.add).toBe('function');
    expect(typeof connectionStatus.add).toBe('function');
  });

  it('histograms have record method (OTel Histogram API)', () => {
    // OTel Histogram uses .record() instead of prom-client .observe()
    expect(typeof stepDurationSeconds.record).toBe('function');
    expect(typeof cloneDurationSeconds.record).toBe('function');
  });

  it('metric operations do not throw', () => {
    // Verify all metric instruments can be used without errors
    expect(() => jobsTotal.add(1, { status: 'success' })).not.toThrow();
    expect(() => stepsTotal.add(1, { status: 'success' })).not.toThrow();
    expect(() => logBytesTotal.add(1024)).not.toThrow();
    expect(() => jobsActive.add(1)).not.toThrow();
    expect(() => jobsActive.add(-1)).not.toThrow();
    expect(() => connectionStatus.add(1)).not.toThrow();
    expect(() => stepDurationSeconds.record(1.5)).not.toThrow();
    expect(() => cloneDurationSeconds.record(2.3)).not.toThrow();
  });

  it('exports the three log-streamer backpressure instruments', () => {
    expect(logBackpressureEventsTotal).toBeDefined();
    expect(logLinesDroppedTotal).toBeDefined();
    expect(logBackpressureActive).toBeDefined();
    expect(typeof logBackpressureEventsTotal.add).toBe('function');
    expect(typeof logLinesDroppedTotal.add).toBe('function');
    expect(typeof logBackpressureActive.add).toBe('function');
  });

  it('backpressure counters accept mode-labelled increments and magnitude drops', () => {
    expect(() => logBackpressureEventsTotal.add(1, { mode: 'pause' })).not.toThrow();
    expect(() => logBackpressureEventsTotal.add(1, { mode: 'drop' })).not.toThrow();
    expect(() => logLinesDroppedTotal.add(42)).not.toThrow();
    expect(() => logBackpressureActive.add(1, { mode: 'pause' })).not.toThrow();
    expect(() => logBackpressureActive.add(-1, { mode: 'pause' })).not.toThrow();
  });
});
