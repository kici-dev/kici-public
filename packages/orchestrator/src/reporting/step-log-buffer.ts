/**
 * Ring buffer of the last N ANSI-stripped log lines per step, for check run summaries.
 * Keyed by `{runId}:{jobId}:{stepIndex}`; past maxLines the oldest lines are evicted.
 * `totalCount` counts every line added, which drives the "showing last 20 of N lines"
 * truncation indicator.
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

  private buildKey(key: { runId: string; jobId: string; stepIndex: number }): string {
    return `${key.runId}:${key.jobId}:${key.stepIndex}`;
  }

  /** Add log lines for a step, ANSI-stripped; past maxLines the oldest are evicted. */
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

      if (entry.lines.length > this.maxLines) {
        entry.lines.shift();
      }
    }
  }

  /** The last N lines and total count for a step; undefined when it has none. */
  getLastLines(key: { runId: string; jobId: string; stepIndex: number }): StepLogEntry | undefined {
    const compositeKey = this.buildKey(key);
    const entry = this.entries.get(compositeKey);
    if (!entry) return undefined;
    return { lines: [...entry.lines], totalCount: entry.totalCount };
  }

  /** Remove a run's entries; called when the execution tracker prunes it from memory. */
  cleanup(runId: string): void {
    const prefix = `${runId}:`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }
}
