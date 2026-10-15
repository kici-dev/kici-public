/**
 * Real-time log streaming for the CLI observer: per-job colored prefixes, step
 * transition headers, and an in-place elapsed-time line.
 */

import pc from 'picocolors';
import { formatDuration } from '@kici-dev/core';

const COLOR_PALETTE: Array<(text: string) => string> = [
  pc.blue,
  pc.green,
  pc.yellow,
  pc.magenta,
  pc.cyan,
];

/**
 * The `msg` of a stored log line. The orchestrator stores each step log line as
 * a JSON envelope (`{"ts":…,"level":"stdout","msg":"…","meta":{}}`) and the
 * Platform relays it verbatim, so the terminal unwraps it as the dashboard does.
 * A non-envelope line (a phase marker, a plain line from an older store) passes
 * through unchanged.
 */
export function unwrapStoredLogLine(line: string): string {
  if (!line.startsWith('{')) return line;
  try {
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { msg?: unknown }).msg === 'string'
    ) {
      return (parsed as { msg: string }).msg;
    }
  } catch {
    // A plain line.
  }
  return line;
}

export class StreamingFormatter {
  private readonly jobColors = new Map<string, (text: string) => string>();
  private colorIndex = 0;

  /** Per job, to detect step transitions. */
  private readonly currentStep = new Map<string, string>();

  private startTime: number = Date.now();

  private elapsedTimer: ReturnType<typeof setInterval> | null = null;

  /** Suppresses all streaming output. */
  isQuiet = false;

  private getColor(jobName: string): (text: string) => string {
    let color = this.jobColors.get(jobName);
    if (!color) {
      color = COLOR_PALETTE[this.colorIndex % COLOR_PALETTE.length];
      this.colorIndex++;
      this.jobColors.set(jobName, color);
    }
    return color;
  }

  /** Prefixes a step header when the job's step changed. Empty when quiet. */
  formatLogLine(jobName: string, stepName: string, line: string): string {
    if (this.isQuiet) return '';

    const color = this.getColor(jobName);
    const prefix = color(`[${jobName}]`);
    let output = '';

    const currentStep = this.currentStep.get(jobName);
    if (currentStep !== stepName) {
      this.currentStep.set(jobName, stepName);
      output += `${prefix} ${pc.dim(`── Step: ${stepName} ──`)}\n`;
    }

    output += `${prefix} ${line}\n`;
    return output;
  }

  /** Empty when quiet. */
  formatStepChange(jobName: string, stepName: string, state: string, durationMs?: number): string {
    if (this.isQuiet) return '';

    const color = this.getColor(jobName);
    const prefix = color(`[${jobName}]`);
    const duration = durationMs !== undefined ? ` (${formatDuration(durationMs)})` : '';

    // Deliberately narrow: any other state, including one newer than this
    // build, prints verbatim so it never reads as a benign one.
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

  /** Empty when quiet. */
  formatStatusChange(status: string, jobName?: string): string {
    if (this.isQuiet) return '';

    // Narrow by design, as in `formatStepChange`: an unknown status prints verbatim.
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

  /** Rewrites the stderr status line in place with `\r`. */
  startElapsedTimer(): void {
    if (this.isQuiet) return;
    this.startTime = Date.now();

    this.elapsedTimer = setInterval(() => {
      const elapsed = Date.now() - this.startTime;
      process.stderr.write(`\r${pc.dim(`Elapsed: ${formatDuration(elapsed)}`)}`);
    }, 1000);
  }

  /** Also clears the status line. */
  stopElapsedTimer(): void {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
      process.stderr.write('\r\x1b[K');
    }
  }
}
