import { z } from 'zod';
import type { LoopLagSource } from './loop-lag-source.js';

/**
 * Reasons a webhook-ingest admission is shed by the {@link IngestAdmissionController}.
 *
 * - `loop_overload` — the event-loop-lag gate is latched open (p99 delay above
 *   the shed threshold); admission sheds immediately, DB-free.
 * - `codel_drop`    — the CoDel controlled-delay queue is standing (minimum
 *   sojourn stayed above target for a full interval); the head is dropped.
 * - `queue_full`    — the bounded queue is at capacity, or the caller disallowed
 *   queueing (the WS relay path) and no slot was immediately available.
 * - `max_sojourn`   — a waiter exceeded the hard sojourn ceiling (< the Platform
 *   WS ack timeout) and is dropped so nothing waits past the caller's timeout.
 */
export const IngestShedReason = z.enum([
  'loop_overload',
  'codel_drop',
  'queue_full',
  'max_sojourn',
]);
export type IngestShedReason = z.infer<typeof IngestShedReason>;

export type AdmitResult =
  { admitted: true; release: () => void } | { admitted: false; reason: IngestShedReason };

/** Per-call admission options. */
export interface AdmitOptions {
  /**
   * When true (HTTP direct ingress), a request that cannot be admitted
   * immediately is enqueued on the CoDel queue. When false (Platform-WS relay,
   * whose ack the Platform awaits synchronously with a 5 s budget), no queueing
   * happens — the request is granted immediately or shed `queue_full` at once.
   */
  allowQueue?: boolean;
}

export interface IngestAdmissionConfig {
  maxConcurrency: number; // G — global in-flight backstop
  maxQueueDepth: number; // Q — queue length backstop
  codelTargetMs: number; // T — CoDel target sojourn
  codelIntervalMs: number; // I — CoDel interval
  queueMaxWaitMs: number; // W_max — hard sojourn ceiling
  loopLagShedMs: number; // L_shed — p99 delay shed threshold
  loopLagResumeMs: number; // L_resume — hysteresis re-open threshold
  loopLagSampleMs: number; // S — loop-lag sample + sweep interval
}

export interface IngestAdmissionSnapshot {
  inflight: number;
  queueDepth: number;
  sheddingActive: boolean;
  loopDelayP99Ms: number;
  loopDelayMaxMs: number;
}

export interface IngestAdmissionDeps {
  config: IngestAdmissionConfig;
  loopLag: LoopLagSource;
  /** injectable clock (default Date.now). */
  now?: () => number;
  /** durable-buffer seam (default no-op) — a future replay buffer plugs in here. */
  onShed?: (reason: IngestShedReason, key: string) => void;
  /** metric hook: shed counter increment (keeps the controller OTel-free). */
  onShedMetric?: (reason: IngestShedReason) => void;
  /** metric hook: admitted counter increment. */
  onAdmitMetric?: () => void;
  /** metric hook: state gauges refresh. */
  onStateChange?: (s: IngestAdmissionSnapshot) => void;
  /** start the real sweep timer (default true; unit tests pass false and drive tickQueue/sampleLoopLag). */
  startTimer?: boolean;
}

interface Waiter {
  key: string;
  orgCap: number;
  enqueuedAt: number;
  resolve: (r: AdmitResult) => void;
}

/**
 * Single-process admission controller for the webhook-ingest pipeline. Three
 * layers evaluated in order on {@link admit}: (1) an event-loop-lag gate (the
 * DB-free adaptive signal), (2) hard global + per-org caps (memory backstop +
 * fairness), (3) a CoDel controlled-delay queue (burst absorption without
 * bufferbloat). Shed is lossy — the caller redelivers.
 */
export class IngestAdmissionController {
  private readonly cfg: IngestAdmissionConfig;
  private readonly loopLag: LoopLagSource;
  private readonly now: () => number;
  private readonly onShedSeam: (reason: IngestShedReason, key: string) => void;
  private readonly onShedMetric?: (reason: IngestShedReason) => void;
  private readonly onAdmitMetric?: () => void;
  private readonly onStateChange?: (s: IngestAdmissionSnapshot) => void;

  private globalInflight = 0;
  private readonly perKeyInflight = new Map<string, number>();
  private readonly queue: Waiter[] = [];
  private loopP99 = 0;
  private loopMax = 0;

  /** Hysteresis latch for the loop-lag gate (open = shedding). */
  private loopGateOpen = false;
  /** CoDel: timestamp the head sojourn first rose above target; undefined when below. */
  private codelAboveSince: number | undefined = undefined;
  private codelDropping = false;

  private readonly sweepTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(deps: IngestAdmissionDeps) {
    this.cfg = deps.config;
    this.loopLag = deps.loopLag;
    this.now = deps.now ?? Date.now;
    this.onShedSeam = deps.onShed ?? ((): void => {});
    this.onShedMetric = deps.onShedMetric;
    this.onAdmitMetric = deps.onAdmitMetric;
    this.onStateChange = deps.onStateChange;

    // The sweep period must be <= the CoDel interval so T/I are honored in
    // production (min-sojourn resolution ≈ the sweep period).
    if (this.cfg.loopLagSampleMs > this.cfg.codelIntervalMs) {
      throw new Error(
        `ingest admission: loopLagSampleMs (${this.cfg.loopLagSampleMs}) must be <= codelIntervalMs (${this.cfg.codelIntervalMs})`,
      );
    }

    if (deps.startTimer ?? true) {
      this.sweepTimer = setInterval(() => {
        this.sampleLoopLag();
        this.tickQueue();
      }, this.cfg.loopLagSampleMs);
      this.sweepTimer.unref?.();
    }
  }

  private keyInflight(key: string): number {
    return this.perKeyInflight.get(key) ?? 0;
  }
  private incKey(key: string): void {
    this.perKeyInflight.set(key, this.keyInflight(key) + 1);
  }
  private decKey(key: string): void {
    const n = this.keyInflight(key) - 1;
    if (n <= 0) this.perKeyInflight.delete(key);
    else this.perKeyInflight.set(key, n);
  }

  isShedding(): boolean {
    return this.loopGateOpen || this.codelDropping;
  }

  snapshot(): IngestAdmissionSnapshot {
    return {
      inflight: this.globalInflight,
      queueDepth: this.queue.length,
      sheddingActive: this.isShedding(),
      loopDelayP99Ms: this.loopP99,
      loopDelayMaxMs: this.loopMax,
    };
  }

  private emit(): void {
    this.onStateChange?.(this.snapshot());
  }

  /**
   * Sample the loop-lag source into the snapshot and update the hysteresis
   * latch. Called on the sweep interval (production) or directly (tests).
   */
  sampleLoopLag(): void {
    this.loopP99 = this.loopLag.p99();
    this.loopMax = this.loopLag.max();
    this.loopLag.reset();
    // Schmitt trigger: open above L_shed, close only below L_resume.
    if (this.loopP99 > this.cfg.loopLagShedMs) this.loopGateOpen = true;
    else if (this.loopP99 < this.cfg.loopLagResumeMs) this.loopGateOpen = false;
    this.emit();
  }

  private canAdmit(key: string, orgCap: number): boolean {
    return this.globalInflight < this.cfg.maxConcurrency && this.keyInflight(key) < orgCap;
  }

  private makeRelease(key: string): () => void {
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      this.globalInflight--;
      this.decKey(key);
      this.tickQueue(); // release-driven dequeue + CoDel eval
    };
  }

  private grant(key: string): AdmitResult {
    this.globalInflight++;
    this.incKey(key);
    this.onAdmitMetric?.();
    this.emit();
    return { admitted: true, release: this.makeRelease(key) };
  }

  private shed(reason: IngestShedReason, key: string): AdmitResult {
    this.onShedSeam(reason, key);
    this.onShedMetric?.(reason);
    this.emit();
    return { admitted: false, reason };
  }

  /**
   * @param key    fairness key — org id (preferred) or routing key (DB-degraded fallback).
   * @param orgCap per-key concurrency cap P (from the cached settings reader).
   */
  admit(key: string, orgCap: number, opts?: AdmitOptions): Promise<AdmitResult> {
    const allowQueue = opts?.allowQueue ?? true;
    // Layer 1: loop-lag gate (DB-free adaptive signal).
    if (this.loopGateOpen) {
      return Promise.resolve(this.shed('loop_overload', key));
    }
    // Layer 2: hard caps + per-key fairness.
    if (this.canAdmit(key, orgCap)) {
      return Promise.resolve(this.grant(key));
    }
    // Non-queueing caller (WS relay): shed immediately, never enqueue.
    if (!allowQueue) {
      return Promise.resolve(this.shed('queue_full', key));
    }
    // Layer 3: bounded CoDel queue.
    if (this.queue.length >= this.cfg.maxQueueDepth) {
      return Promise.resolve(this.shed('queue_full', key));
    }
    return new Promise<AdmitResult>((resolve) => {
      this.queue.push({ key, orgCap, enqueuedAt: this.now(), resolve });
      this.emit();
    });
  }

  /**
   * Drive the queue: admit admissible waiters (fair skip of maxed keys), sweep
   * the hard sojourn ceiling, then evaluate CoDel on the head. Called on every
   * release and on the sweep interval; also test-drivable with the injected clock.
   */
  tickQueue(): void {
    const nowT = this.now();
    this.admitWaiters();
    this.sweepMaxSojourn(nowT);
    this.codelEval(nowT);
    this.emit();
  }

  /** Release-driven fair dequeue: admit the first admissible waiter, skip maxed keys. */
  private admitWaiters(): void {
    for (let i = 0; i < this.queue.length;) {
      if (this.globalInflight >= this.cfg.maxConcurrency) break;
      const w = this.queue[i]!;
      if (this.keyInflight(w.key) < w.orgCap) {
        this.queue.splice(i, 1);
        w.resolve(this.grant(w.key));
      } else {
        i++; // this key is maxed; skip it, try the next waiter
      }
    }
  }

  /** Hard sojourn ceiling: shed any waiter that waited past W_max. */
  private sweepMaxSojourn(nowT: number): void {
    for (let i = 0; i < this.queue.length;) {
      const w = this.queue[i]!;
      if (nowT - w.enqueuedAt >= this.cfg.queueMaxWaitMs) {
        this.queue.splice(i, 1);
        w.resolve(this.shed('max_sojourn', w.key));
      } else {
        i++;
      }
    }
  }

  /**
   * CoDel head evaluation. While the head sojourn is below target, reset the
   * dropping state (a transient burst drains cleanly). Once the head has stayed
   * at/above target continuously for a full interval, enter the dropping state
   * and shed the head each sweep until sojourn recovers below target.
   */
  private codelEval(nowT: number): void {
    const head = this.queue[0];
    if (!head) {
      this.codelAboveSince = undefined;
      this.codelDropping = false;
      return;
    }
    const sojourn = nowT - head.enqueuedAt;
    if (sojourn < this.cfg.codelTargetMs) {
      this.codelAboveSince = undefined;
      this.codelDropping = false;
      return;
    }
    if (this.codelAboveSince === undefined) this.codelAboveSince = nowT;
    const standingFor = nowT - this.codelAboveSince;
    if (this.codelDropping || standingFor >= this.cfg.codelIntervalMs) {
      this.codelDropping = true;
      this.queue.shift();
      head.resolve(this.shed('codel_drop', head.key));
    }
  }

  /** Stop the sweep timer and drain the queue (every waiter resolves as shed). */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const w of this.queue.splice(0)) {
      w.resolve(this.shed('queue_full', w.key));
    }
    this.loopLag.stop();
  }
}
