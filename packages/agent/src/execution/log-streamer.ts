import type { AgentLogChunk } from '@kici-dev/engine';
import {
  logBackpressureActive,
  logBackpressureEventsTotal,
  logBytesTotal,
  logLinesDroppedTotal,
} from '../metrics/prometheus.js';

interface LogStreamerOptions {
  /** Callback to send log.chunk messages */
  send: (msg: AgentLogChunk) => void;
  /** Run ID for log.chunk messages */
  runId: string;
  /** Job ID for log.chunk messages */
  jobId: string;
  /** Step index for log.chunk messages */
  stepIndex: number;
  /** Max log bytes per step (default: 10MB). Truncates after this limit. */
  maxLogSizeBytes?: number;
  /** Flush interval in ms (default: 100ms) */
  flushIntervalMs?: number;
  /** Flush line threshold (default: 50 lines) */
  flushLineThreshold?: number;

  // --- Backpressure options ---

  /** Get current WS send buffer size in bytes. When provided, enables backpressure. */
  getBufferedAmount?: () => number;
  /** Backpressure mode: 'pause' stops the source stream, 'drop' discards lines. Default: 'pause'. */
  backpressureMode?: 'pause' | 'drop';
  /** Callback invoked when backpressure is detected (pause mode) -- caller should pause child stdout. */
  onBackpressure?: () => void;
  /** Callback invoked when backpressure clears (pause mode) -- caller should resume child stdout. */
  onBackpressureClear?: () => void;
  /** Register a one-time drain event listener on the WS. */
  onWsDrain?: (callback: () => void) => void;
}

const DEFAULT_MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_FLUSH_INTERVAL_MS = 100;
const DEFAULT_FLUSH_LINE_THRESHOLD = 50;

/** WS send buffer threshold in bytes before backpressure kicks in (1MB). */
export const BACKPRESSURE_THRESHOLD = 1_048_576;

/** Safety timeout for pause mode: switch to drop mode temporarily if drain hasn't fired. */
const PAUSE_SAFETY_TIMEOUT_MS = 30_000;

/**
 * Batches step output lines and flushes them as log.chunk messages.
 *
 * Optimizes WS delivery by collecting lines and flushing either:
 * - When the line count reaches the flush threshold (default: 50 lines)
 * - After a timer fires (default: 100ms)
 *
 * Enforces a maximum total log size per step. After exceeding the limit,
 * a truncation notice is sent and further lines are silently dropped.
 *
 * Supports sender-side backpressure with two modes:
 * - **pause**: Pauses the child process stdout via callback, resumes on WS drain event.
 *   Includes a 30s safety timeout that temporarily switches to drop mode to prevent deadlocks.
 * - **drop**: Discards buffered lines when backpressure is detected, emits a count marker on resume.
 */
export class LogStreamer {
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private totalBytes = 0;
  private truncated = false;

  /** Number of lines dropped due to backpressure (drop mode). */
  private droppedCount = 0;
  /** Whether we are currently in a backpressured state (pause mode). */
  private paused = false;
  /** Whether drop mode is currently shedding lines. Tracked separately from
   *  `paused` so the Prometheus `kici_agent_log_backpressure_active` gauge
   *  reflects the actual shedding state (not just pause mode). */
  private dropping = false;
  /** Safety timeout timer for pause mode. */
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
   * Add a line to the buffer. Triggers flush if threshold reached,
   * otherwise schedules a timer-based flush.
   */
  addLine(line: string): void {
    if (this.truncated) {
      return;
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
   * Flush buffered lines as a log.chunk message.
   * No-op if buffer is empty.
   *
   * When backpressure is enabled (getBufferedAmount provided), checks the WS
   * send buffer before sending:
   * - **drop mode**: Discards buffered lines and increments droppedCount.
   * - **pause mode**: Signals the caller to pause the child process, registers
   *   a drain listener to resume, and sets a 30s safety timeout.
   */
  flush(): void {
    if (this.buffer.length === 0) {
      return;
    }

    this.clearTimer();

    // Check backpressure before sending
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

      // Pause mode: signal caller to pause child stdout
      if (!this.paused) {
        this.paused = true;
        logBackpressureEventsTotal.add(1, { mode: 'pause' });
        logBackpressureActive.add(1, { mode: 'pause' });
        this.onBackpressure?.();
        this.registerDrainResume();
      }
      // Don't send -- buffer stays until drain fires
      return;
    }

    // Prepend drop marker if we previously dropped lines
    const lines = this.buildLinesWithDropMarker();

    this.send({
      type: 'log.chunk',
      messageId: crypto.randomUUID(),
      runId: this.runId,
      jobId: this.jobId,
      stepIndex: this.stepIndex,
      lines,
      timestamp: Date.now(),
    });
  }

  /**
   * Flush remaining buffer and clean up. Call at end of step.
   */
  destroy(): void {
    // Force flush regardless of backpressure (step is ending)
    this.forceSend();
    this.clearTimer();
    this.clearPauseSafetyTimer();
  }

  /**
   * Total bytes tracked across all lines added.
   */
  getTotalBytes(): number {
    return this.totalBytes;
  }

  /**
   * Number of lines dropped due to backpressure.
   * Exposed for testing.
   */
  getDroppedCount(): number {
    return this.droppedCount;
  }

  /**
   * Whether backpressure pause is currently active.
   * Exposed for testing.
   */
  isPaused(): boolean {
    return this.paused;
  }

  // --- Private helpers ---

  /**
   * Build the lines array, prepending a drop marker if lines were dropped.
   */
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

  /**
   * Force send all buffered lines, bypassing backpressure checks.
   * Used during destroy() to ensure remaining data is sent.
   */
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
    });
  }

  /**
   * Register a WS drain listener that resumes sending after backpressure clears.
   * Includes a 30s safety timeout that temporarily switches to drop mode.
   */
  private registerDrainResume(): void {
    const resume = () => {
      this.clearPauseSafetyTimer();
      if (this.paused) {
        this.paused = false;
        logBackpressureActive.add(-1, { mode: 'pause' });
      }
      this.onBackpressureClear?.();
      // Retry flushing now that backpressure has cleared
      this.flush();
    };

    // Register drain callback
    this.onWsDrain?.(resume);

    // Safety timeout: if drain hasn't fired in 30s, drop buffered lines and resume
    this.pauseSafetyTimer = setTimeout(() => {
      this.pauseSafetyTimer = null;
      if (this.paused) {
        // Switch to temporary drop: discard buffer and resume
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
