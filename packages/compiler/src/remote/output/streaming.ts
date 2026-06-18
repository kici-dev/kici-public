/**
 * Real-time log streaming output formatter for CLI observer.
 *
 * Manages colored output for multi-job runs:
 * - Assigns distinct colors per job name (cycling through a palette)
 * - Formats log lines with colored job-name prefix
 * - Prints step transition headers
 * - Tracks elapsed time with in-place status updates
 */

import pc from 'picocolors';
import { formatDuration } from '@kici-dev/core';

/** Available color functions for job name assignment. */
const COLOR_PALETTE: Array<(text: string) => string> = [
  pc.blue,
  pc.green,
  pc.yellow,
  pc.magenta,
  pc.cyan,
];

export class StreamingFormatter {
  /** Color assignment per job name. */
  private readonly jobColors = new Map<string, (text: string) => string>();
  private colorIndex = 0;

  /** Track the current step per job to detect transitions. */
  private readonly currentStep = new Map<string, string>();

  /** Start timestamp for elapsed time tracking. */
  private startTime: number = Date.now();

  /** Elapsed timer interval reference. */
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;

  /** If true, suppress all streaming output. */
  isQuiet = false;

  /**
   * Get or assign a color function for a job name.
   */
  private getColor(jobName: string): (text: string) => string {
    let color = this.jobColors.get(jobName);
    if (!color) {
      color = COLOR_PALETTE[this.colorIndex % COLOR_PALETTE.length];
      this.colorIndex++;
      this.jobColors.set(jobName, color);
    }
    return color;
  }

  /**
   * Format a log line with colored job-name prefix.
   *
   * If the step has changed since the last log for this job,
   * a step header is emitted first.
   *
   * @returns The formatted line(s) to print, or empty string if quiet.
   */
  formatLogLine(jobName: string, stepName: string, line: string): string {
    if (this.isQuiet) return '';

    const color = this.getColor(jobName);
    const prefix = color(`[${jobName}]`);
    let output = '';

    // Check for step transition
    const currentStep = this.currentStep.get(jobName);
    if (currentStep !== stepName) {
      this.currentStep.set(jobName, stepName);
      output += `${prefix} ${pc.dim(`── Step: ${stepName} ──`)}\n`;
    }

    output += `${prefix} ${line}\n`;
    return output;
  }

  /**
   * Format a step lifecycle change.
   *
   * @returns The formatted status line, or empty string if quiet.
   */
  formatStepChange(jobName: string, stepName: string, state: string, durationMs?: number): string {
    if (this.isQuiet) return '';

    const color = this.getColor(jobName);
    const prefix = color(`[${jobName}]`);
    const duration = durationMs !== undefined ? ` (${formatDuration(durationMs)})` : '';

    switch (state) {
      case 'running':
        return `${prefix} ▶ Step '${stepName}' started\n`;
      case 'success':
        return `${prefix} ${pc.green(`✓ Step '${stepName}' completed${duration}`)}\n`;
      case 'failed':
        return `${prefix} ${pc.red(`✗ Step '${stepName}' failed${duration}`)}\n`;
      case 'skipped':
        return `${prefix} ${pc.dim(`- Step '${stepName}' skipped`)}\n`;
      default:
        return `${prefix} Step '${stepName}': ${state}${duration}\n`;
    }
  }

  /**
   * Format a run status change.
   *
   * @returns The formatted status line, or empty string if quiet.
   */
  formatStatusChange(status: string, jobName?: string): string {
    if (this.isQuiet) return '';

    switch (status) {
      case 'queued':
        return `${pc.dim('Queued...')}\n`;
      case 'running':
        return jobName ? `${pc.cyan(`Running: ${jobName}`)}\n` : `${pc.cyan('Running...')}\n`;
      case 'success':
        return `${pc.green('Run completed successfully')}\n`;
      case 'failed':
        return `${pc.red('Run failed')}\n`;
      case 'cancelled':
        return `${pc.yellow('Run cancelled')}\n`;
      default:
        return `Status: ${status}\n`;
    }
  }

  /**
   * Start the elapsed timer that updates a status line in-place.
   * Uses \\r to overwrite the current line.
   */
  startElapsedTimer(): void {
    if (this.isQuiet) return;
    this.startTime = Date.now();

    this.elapsedTimer = setInterval(() => {
      const elapsed = Date.now() - this.startTime;
      process.stderr.write(`\r${pc.dim(`Elapsed: ${formatDuration(elapsed)}`)}`);
    }, 1000);
  }

  /**
   * Stop the elapsed timer and clear the status line.
   */
  stopElapsedTimer(): void {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
      // Clear the elapsed line
      process.stderr.write('\r\x1b[K');
    }
  }
}
