/**
 * Ring buffer for per-step log line retention.
 *
 * Stores the last N ANSI-stripped log lines per step for use in check run
 * summaries. Log lines are keyed by `{runId}:{jobId}:{stepIndex}` so each
 * step gets its own independent buffer. When the buffer exceeds maxLines,
 * the oldest lines are evicted.
 *
 * The totalCount field tracks how many lines were added in total (not just
 * retained), enabling the truncation indicator: "showing last 20 of N lines".
 */

import stripAnsi from 'strip-ansi';

/** Entry stored per step in the buffer. */
export interface StepLogEntry {
  /** The retained (last N) log lines, ANSI-stripped. */
  lines: string[];
  /** Total number of lines added (including evicted ones). */
  totalCount: number;
}

export class StepLogBuffer {
  private readonly maxLines: number;
  private readonly entries = new Map<string, StepLogEntry>();

  constructor(opts?: { maxLines?: number }) {
    this.maxLines = opts?.maxLines ?? 20;
  }

  /**
   * Build the composite key for a step.
   */
  private buildKey(key: { runId: string; jobId: string; stepIndex: number }): string {
    return `${key.runId}:${key.jobId}:${key.stepIndex}`;
  }

  /**
   * Add log lines for a step.
   *
   * ANSI codes are stripped from each line before storage.
   * When the buffer exceeds maxLines, the oldest lines are evicted.
   */
  addLines(key: { runId: string; jobId: string; stepIndex: number }, rawLines: string[]): void {
    const compositeKey = this.buildKey(key);
    let entry = this.entries.get(compositeKey);
    if (!entry) {
      entry = { lines: [], totalCount: 0 };
      this.entries.set(compositeKey, entry);
    }

    for (const raw of rawLines) {
      const stripped = stripAnsi(raw);
      entry.lines.push(stripped);
      entry.totalCount++;

      // Evict oldest when exceeding maxLines
      if (entry.lines.length > this.maxLines) {
        entry.lines.shift();
      }
    }
  }

  /**
   * Get the last N lines and total count for a step.
   *
   * Returns undefined if no lines have been added for this step.
   */
  getLastLines(key: { runId: string; jobId: string; stepIndex: number }): StepLogEntry | undefined {
    const compositeKey = this.buildKey(key);
    const entry = this.entries.get(compositeKey);
    if (!entry) return undefined;
    return { lines: [...entry.lines], totalCount: entry.totalCount };
  }

  /**
   * Remove all entries for a given runId.
   *
   * Called when the execution tracker prunes a completed run from memory.
   */
  cleanup(runId: string): void {
    const prefix = `${runId}:`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }
}
