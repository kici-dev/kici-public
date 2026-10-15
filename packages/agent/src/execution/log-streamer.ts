import { LogStream, type AgentLogChunk } from '@kici-dev/engine';
import {
  logBackpressureActive,
  logBackpressureEventsTotal,
  logBytesTotal,
  logLinesDroppedTotal,
} from '../metrics/prometheus.js';

interface LogStreamerOptions {
  send: (msg: AgentLogChunk) => void;
  runId: string;
  jobId: string;
  stepIndex: number;
  /** Max log bytes per step (default: 10MB). Truncates after this limit. */
  maxLogSizeBytes?: number;
  /** Default: 100ms. */
  flushIntervalMs?: number;
  /** Default: 50 lines. */
  flushLineThreshold?: number;

  // --- Backpressure options ---

  /** Current WS send buffer size in bytes. When provided, enables backpressure. */
  getBufferedAmount?: () => number;
  /** 'pause' stops the source stream, 'drop' discards lines. Default: 'pause'. */
  backpressureMode?: 'pause' | 'drop';
  /** Pause mode: backpressure detected, caller should pause child stdout. */
  onBackpressure?: () => void;
  /** Pause mode: backpressure cleared, caller should resume child stdout. */
  onBackpressureClear?: () => void;
  /** Register a one-time drain event listener on the WS. */
  onWsDrain?: (callback: () => void) => void;
}

const DEFAULT_MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_FLUSH_INTERVAL_MS = 100;
const DEFAULT_FLUSH_LINE_THRESHOLD = 50;

/** WS send buffer bytes before backpressure kicks in (1MB). */
export const BACKPRESSURE_THRESHOLD = 1_048_576;

/** Pause mode: drop buffered lines and resume if drain hasn't fired by then. */
const PAUSE_SAFETY_TIMEOUT_MS = 30_000;

/**
 * Batches step output lines into log.chunk messages, flushing at the line
 * threshold or when the flush timer fires.
 *
 * Past the per-step size limit it sends a truncation notice and silently drops
 * further lines.
 *
 * Sender-side backpressure:
 * - **pause**: pauses child stdout via callback, resumes on WS drain. A 30s
 *   safety timeout drops the buffer and resumes, to prevent deadlocks.
 * - **drop**: discards buffered lines, emits a count marker on resume.
 */
export class LogStreamer {
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private totalBytes = 0;
  private truncated = false;

  /** Which stream the currently-buffered lines came from. */
  private bufferStream: LogStream = LogStream.enum.stdout;

  private droppedCount = 0;
  /** Pause-mode backpressure state. */
  private paused = false;
  /** Drop-mode shedding state, separate from `paused` so the
   *  `kici_agent_log_backpressure_active` gauge reflects actual shedding. */
  private dropping = false;
  private pauseSafetyTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly send: (msg: AgentLogChunk) => void;
  private readonly runId: string;
  private readonly jobId: string;
  private readonly stepIndex: number;
  private readonly maxLogSizeBytes: number;
  private readonly flushIntervalMs: number;
  private readonly flushLineThreshold: number;

  // Backpressure
  private readonly getBufferedAmount?: () => number;
  private readonly backpressureMode: 'pause' | 'drop';
  private readonly onBackpressure?: () => void;
  private readonly onBackpressureClear?: () => void;
  private readonly onWsDrain?: (callback: () => void) => void;

  constructor(options: LogStreamerOptions) {
    this.send = options.send;
    this.runId = options.runId;
    this.jobId = options.jobId;
    this.stepIndex = options.stepIndex;
    this.maxLogSizeBytes = options.maxLogSizeBytes ?? DEFAULT_MAX_LOG_SIZE_BYTES;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.flushLineThreshold = options.flushLineThreshold ?? DEFAULT_FLUSH_LINE_THRESHOLD;

    // Backpressure
    this.getBufferedAmount = options.getBufferedAmount;
    this.backpressureMode = options.backpressureMode ?? 'pause';
    this.onBackpressure = options.onBackpressure;
    this.onBackpressureClear = options.onBackpressureClear;
    this.onWsDrain = options.onWsDrain;
  }

  /**
   * A chunk carries a single stream, so a stream flip closes the pending chunk
   * first; in-order delivery preserves the stdout/stderr interleaving.
   *
   * `bufferStream` advances only once the buffer is empty. Under pause-mode
   * backpressure `flush()` keeps the buffer until the socket drains, so the
   * flip cannot close it, and advancing the tag would relabel the buffered
   * lines. A chunk assembled while backpressured therefore reports its first
   * lines' stream for lines from both — stderr under-reported as stdout.
   * Separating them needs a queue of pending per-stream chunks.
   */
  addLine(line: string, stream: LogStream = LogStream.enum.stdout): void {
    if (this.truncated) {
      return;
    }

    if (this.buffer.length > 0 && stream !== this.bufferStream) {
      this.flush();
    }
    if (this.buffer.length === 0) {
      this.bufferStream = stream;
    }

    if (this.totalBytes >= this.maxLogSizeBytes) {
      this.buffer.push(`[TRUNCATED: log output exceeded ${this.maxLogSizeBytes} bytes]`);
      this.truncated = true;
      this.flush();
      return;
    }

    this.buffer.push(line);
    const bytes = Buffer.byteLength(line, 'utf-8');
    this.totalBytes += bytes;
    logBytesTotal.add(bytes);

    if (this.buffer.length >= this.flushLineThreshold) {
      this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  /**
   * When the WS send buffer is over the threshold: drop mode discards the
   * buffer; pause mode signals the caller to pause, registers a drain listener
   * to resume, and arms the 30s safety timeout.
   */
  flush(): void {
    if (this.buffer.length === 0) {
      return;
    }

    this.clearTimer();

    if (this.getBufferedAmount && this.getBufferedAmount() > BACKPRESSURE_THRESHOLD) {
      if (this.backpressureMode === 'drop') {
        if (!this.dropping) {
          this.dropping = true;
          logBackpressureEventsTotal.add(1, { mode: 'drop' });
          logBackpressureActive.add(1, { mode: 'drop' });
        }
        this.droppedCount += this.buffer.length;
        this.buffer = [];
        return;
      }

      if (!this.paused) {
        this.paused = true;
        logBackpressureEventsTotal.add(1, { mode: 'pause' });
        logBackpressureActive.add(1, { mode: 'pause' });
        this.onBackpressure?.();
        this.registerDrainResume();
      }
      // Buffer stays until drain fires.
      return;
    }

    const lines = this.buildLinesWithDropMarker();

    this.send({
      type: 'log.chunk',
      messageId: crypto.randomUUID(),
      runId: this.runId,
      jobId: this.jobId,
      stepIndex: this.stepIndex,
      lines,
      timestamp: Date.now(),
      stream: this.bufferStream,
    });
  }

  /** Call at end of step: sends the remaining buffer regardless of backpressure. */
  destroy(): void {
    this.forceSend();
    this.clearTimer();
    this.clearPauseSafetyTimer();
  }

  getTotalBytes(): number {
    return this.totalBytes;
  }

  /** Exposed for testing. */
  getDroppedCount(): number {
    return this.droppedCount;
  }

  /** Exposed for testing. */
  isPaused(): boolean {
    return this.paused;
  }

  // --- Private helpers ---

  private buildLinesWithDropMarker(): string[] {
    const lines = this.buffer.splice(0);
    if (this.droppedCount > 0) {
      lines.unshift(`[${this.droppedCount} lines dropped due to backpressure]`);
      logLinesDroppedTotal.add(this.droppedCount);
      this.droppedCount = 0;
      if (this.dropping) {
        this.dropping = false;
        logBackpressureActive.add(-1, { mode: 'drop' });
      }
    }
    return lines;
  }

  private forceSend(): void {
    if (this.buffer.length === 0 && this.droppedCount === 0) {
      return;
    }

    const lines = this.buildLinesWithDropMarker();
    if (lines.length === 0) {
      return;
    }

    this.send({
      type: 'log.chunk',
      messageId: crypto.randomUUID(),
      runId: this.runId,
      jobId: this.jobId,
      stepIndex: this.stepIndex,
      lines,
      timestamp: Date.now(),
      stream: this.bufferStream,
    });
  }

  private registerDrainResume(): void {
    const resume = () => {
      this.clearPauseSafetyTimer();
      if (this.paused) {
        this.paused = false;
        logBackpressureActive.add(-1, { mode: 'pause' });
      }
      this.onBackpressureClear?.();
      this.flush();
    };

    this.onWsDrain?.(resume);

    // Safety timeout: if drain hasn't fired, drop buffered lines and resume.
    this.pauseSafetyTimer = setTimeout(() => {
      this.pauseSafetyTimer = null;
      if (this.paused) {
        this.droppedCount += this.buffer.length;
        this.buffer = [];
        this.paused = false;
        logBackpressureActive.add(-1, { mode: 'pause' });
        this.onBackpressureClear?.();
      }
    }, PAUSE_SAFETY_TIMEOUT_MS);
  }

  private clearPauseSafetyTimer(): void {
    if (this.pauseSafetyTimer !== null) {
      clearTimeout(this.pauseSafetyTimer);
      this.pauseSafetyTimer = null;
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, this.flushIntervalMs);
    }
  }

  private clearTimer(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
