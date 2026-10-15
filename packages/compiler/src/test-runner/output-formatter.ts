import pc from 'picocolors';
import { logger } from '@kici-dev/core';
import type { RuleResult } from '@kici-dev/sdk';

const JOB_COLORS = [pc.cyan, pc.green, pc.yellow, pc.magenta, pc.blue] as const;

type ColorFn = (text: string) => string;

/** Prefixes messages with colored job labels. */
class OutputFormatter {
  private jobIndex = 0;
  private colorMap = new Map<string, ColorFn>();

  getJobColor(jobName: string): ColorFn {
    if (!this.colorMap.has(jobName)) {
      const color = JOB_COLORS[this.jobIndex % JOB_COLORS.length];
      this.colorMap.set(jobName, color);
      this.jobIndex++;
    }
    return this.colorMap.get(jobName)!;
  }

  logJobLine(jobName: string, message: string): void {
    const color = this.getJobColor(jobName);
    const prefix = color(`[${jobName}]`);

    const lines = message.split('\n');
    for (const line of lines) {
      if (line.trim()) {
        logger.info(`${prefix} ${line}`);
      }
    }
  }

  logStepStart(jobName: string, stepName: string): void {
    const color = this.getJobColor(jobName);
    logger.info(color(`[${jobName}]`) + pc.gray(` -> ${stepName}`));
  }

  logStepComplete(jobName: string, stepName: string, durationMs: number): void {
    const color = this.getJobColor(jobName);
    logger.info(color(`[${jobName}]`) + pc.green(` ✓ ${stepName}`) + pc.gray(` (${durationMs}ms)`));
  }

  logStepError(jobName: string, stepName: string, error: Error): void {
    const color = this.getJobColor(jobName);
    logger.error(color(`[${jobName}]`) + pc.red(` ✗ ${stepName}: ${error.message}`));
  }

  logJobStart(jobName: string): void {
    const color = this.getJobColor(jobName);
    logger.info(color(`[${jobName}]`) + pc.bold(' Starting...'));
  }

  logJobComplete(jobName: string, durationMs: number): void {
    const color = this.getJobColor(jobName);
    logger.info(color(`[${jobName}]`) + pc.green(' ✓ Complete') + pc.gray(` (${durationMs}ms)`));
  }

  logJobFailure(jobName: string, durationMs: number, error: Error): void {
    const color = this.getJobColor(jobName);
    logger.error(
      color(`[${jobName}]`) + pc.red(` ✗ Failed: ${error.message}`) + pc.gray(` (${durationMs}ms)`),
    );
  }

  /**
   * A rule whose `check()` threw carries an `error` and prints
   * `✗ errored: <message>`, so the author sees the crash reason instead of a
   * bare `✗ failed`.
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

// Singleton, so job colors stay consistent.
export const formatter = new OutputFormatter();
