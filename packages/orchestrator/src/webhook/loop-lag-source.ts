import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

/**
 * Event-loop delay source for the ingest admission controller's adaptive gate.
 *
 * The controller reads p99/max loop delay on a short interval to decide whether
 * to shed. Hiding the real `perf_hooks` primitive behind this interface lets the
 * gate decision logic and the real sampler be tested separately: the controller
 * unit tests drive a {@link FakeLoopLagSource} with caller-controlled values, and
 * {@link RealLoopLagSource} has its own busy-spin detection test.
 */
export interface LoopLagSource {
  /** p99 event-loop delay in ms over the current window. */
  p99(): number;
  /** max event-loop delay in ms over the current window. */
  max(): number;
  /** reset the window's histogram (start a fresh measurement window). */
  reset(): void;
  /** stop the underlying monitor (real source only; no-op on the fake). */
  stop(): void;
}

const nsToMs = (ns: number): number => (Number.isFinite(ns) ? ns / 1e6 : 0);

/** Real source backed by `perf_hooks.monitorEventLoopDelay`. */
export class RealLoopLagSource implements LoopLagSource {
  private readonly h: IntervalHistogram;
  constructor(resolutionMs = 10) {
    this.h = monitorEventLoopDelay({ resolution: resolutionMs });
    this.h.enable();
  }
  p99(): number {
    return nsToMs(this.h.percentile(99));
  }
  max(): number {
    return nsToMs(this.h.max);
  }
  reset(): void {
    this.h.reset();
  }
  stop(): void {
    this.h.disable();
  }
}

/** Deterministic test double returning caller-controlled p99/max values. */
export class FakeLoopLagSource implements LoopLagSource {
  private _p99 = 0;
  private _max = 0;
  setP99(v: number): void {
    this._p99 = v;
  }
  setMax(v: number): void {
    this._max = v;
  }
  p99(): number {
    return this._p99;
  }
  max(): number {
    return this._max;
  }
  reset(): void {
    this._p99 = 0;
    this._max = 0;
  }
  stop(): void {
    /* no-op */
  }
}
