import pc from 'picocolors';
import { logger } from '@kici-dev/core';
import type { RuleResult } from '@kici-dev/sdk';

const JOB_COLORS = [pc.cyan, pc.green, pc.yellow, pc.magenta, pc.blue] as const;

type ColorFn = (text: string) => string;

/**
 * Output formatter that prefixes messages with colored job labels.
 */
class OutputFormatter {
  private jobIndex = 0;
  private colorMap = new Map<string, ColorFn>();

  /**
   * Get consistent color for a job name.
   */
  getJobColor(jobName: string): ColorFn {
    if (!this.colorMap.has(jobName)) {
      const color = JOB_COLORS[this.jobIndex % JOB_COLORS.length];
      this.colorMap.set(jobName, color);
      this.jobIndex++;
    }
    return this.colorMap.get(jobName)!;
  }

  /**
   * Log a message with job prefix.
   */
  logJobLine(jobName: string, message: string): void {
    const color = this.getJobColor(jobName);
    const prefix = color(`[${jobName}]`);

    // Split multi-line messages and prefix each line
    const lines = message.split('\n');
    for (const line of lines) {
      if (line.trim()) {
        logger.info(`${prefix} ${line}`);
      }
    }
  }

  /**
   * Log step start.
   */
  logStepStart(jobName: string, stepName: string): void {
    const color = this.getJobColor(jobName);
    logger.info(color(`[${jobName}]`) + pc.gray(` -> ${stepName}`));
  }

  /**
   * Log step completion.
   */
  logStepComplete(jobName: string, stepName: string, durationMs: number): void {
    const color = this.getJobColor(jobName);
    logger.info(color(`[${jobName}]`) + pc.green(` ✓ ${stepName}`) + pc.gray(` (${durationMs}ms)`));
  }

  /**
   * Log step error.
   */
  logStepError(jobName: string, stepName: string, error: Error): void {
    const color = this.getJobColor(jobName);
    logger.error(color(`[${jobName}]`) + pc.red(` ✗ ${stepName}: ${error.message}`));
  }

  /**
   * Log job start.
   */
  logJobStart(jobName: string): void {
    const color = this.getJobColor(jobName);
    logger.info(color(`[${jobName}]`) + pc.bold(' Starting...'));
  }

  /**
   * Log job complete.
   */
  logJobComplete(jobName: string, durationMs: number): void {
    const color = this.getJobColor(jobName);
    logger.info(color(`[${jobName}]`) + pc.green(' ✓ Complete') + pc.gray(` (${durationMs}ms)`));
  }

  /**
   * Log job failure.
   */
  logJobFailure(jobName: string, durationMs: number, error: Error): void {
    const color = this.getJobColor(jobName);
    logger.error(
      color(`[${jobName}]`) + pc.red(` ✗ Failed: ${error.message}`) + pc.gray(` (${durationMs}ms)`),
    );
  }

  /**
   * Log rule evaluation. A rule whose `check()` threw carries an `error`; it
   * prints `✗ errored: <message>` so the author sees the crash reason instead of
   * a bare `✗ failed`. A clean pass/false prints `✓ passed` / `✗ failed`.
   */
  logRuleResult(jobName: string, result: RuleResult): void {
    const color = this.getJobColor(jobName);
    const status = result.error
      ? pc.red(`✗ errored: ${result.error}`)
      : result.passed
        ? pc.green('✓ passed')
        : pc.red('✗ failed');
    logger.info(color(`[${jobName}]`) + pc.gray(` rule "${result.label}": `) + status);
  }
}

// Singleton formatter for consistent colors
export const formatter = new OutputFormatter();
