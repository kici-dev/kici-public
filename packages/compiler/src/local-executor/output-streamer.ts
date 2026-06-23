/**
 * Output formatting for local execution: tree summary, JSON, JUnit XML.
 *
 * - displayLocalSummary: tree-format summary with per-step timing
 * - formatLocalJsonResult: structured JSON output
 * - formatLocalJunitResult: JUnit XML for CI integration
 */

import pc from 'picocolors';
import { logger } from '@kici-dev/core';
import type { WorkflowExecutionResult, LocalJobResult } from './types.js';

/**
 * Display tree-format execution summary to the console.
 *
 * Shows per-workflow, per-job, per-step timing and status.
 * Matrix values appear in the job name.
 */
export function displayLocalSummary(results: WorkflowExecutionResult[]): void {
  const hasFailure = results.some((r) => r.status === 'failure');
  const allSkipped = results.every((r) => r.status === 'skipped');

  logger.info('');
  logger.info(pc.bold('=== EXECUTION SUMMARY ==='));
  logger.info('');

  const overallStatus = hasFailure
    ? pc.red('FAILED')
    : allSkipped
      ? pc.yellow('SKIPPED')
      : pc.green('SUCCESS');

  logger.info(`Status: ${overallStatus}`);
  logger.info('');

  for (const workflow of results) {
    logger.info(`Workflow: ${pc.bold(workflow.name)} (${workflow.durationMs}ms)`);

    for (const job of workflow.jobs) {
      const jobLabel = formatJobLabel(job);
      const jobIcon = statusIcon(job.status);
      logger.info(`  ${jobIcon} ${jobLabel} (${job.durationMs}ms)`);

      // Show rule results
      if (job.ruleResults && job.ruleResults.length > 0) {
        for (const rule of job.ruleResults) {
          const rIcon = rule.passed ? pc.green('[ok]') : pc.red('[fail]');
          logger.info(pc.gray(`    ${rIcon} rule: ${rule.label}`));
        }
      }

      // Show steps
      for (const step of job.steps) {
        const sIcon = step.status === 'success' ? pc.green('[ok]') : pc.red('[fail]');
        logger.info(`    ${sIcon} ${step.name} (${step.durationMs}ms)`);

        if (step.error) {
          logger.info(pc.red(`      Error: ${step.error.message}`));
        }
      }

      // Show cancellation/skip reason
      if (job.status === 'cancelled') {
        logger.info(pc.yellow('    (cancelled)'));
      } else if (job.status === 'skipped') {
        logger.info(pc.yellow('    (skipped: dependency failed)'));
      }
    }

    logger.info('');
  }

  // Total duration
  const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);
  logger.info(pc.gray(`Total duration: ${totalDuration}ms`));
}

/**
 * Format job label including matrix values if present.
 * e.g., "test (node18, ubuntu)" or just "lint"
 */
function formatJobLabel(job: LocalJobResult): string {
  if (job.matrixValues && Object.keys(job.matrixValues).length > 0) {
    const vals = Object.values(job.matrixValues).join(', ');
    // If job name already contains the matrix suffix, use as-is
    if (job.name.includes('(')) {
      return job.name;
    }
    return `${job.name} (${vals})`;
  }
  return job.name;
}

/**
 * Get colored status icon for a job status.
 */
function statusIcon(status: string): string {
  switch (status) {
    case 'success':
      return pc.green('[ok]');
    case 'failure':
      return pc.red('[fail]');
    case 'skipped':
      return pc.yellow('[skip]');
    case 'cancelled':
      return pc.yellow('[cancel]');
    default:
      return pc.gray('[?]');
  }
}

// --- JSON output ---

/** Structured JSON output format for local execution. */
interface LocalJsonOutput {
  workflows: Array<{
    name: string;
    status: string;
    durationMs: number;
    jobs: Array<{
      name: string;
      status: string;
      durationMs: number;
      matrixValues?: Record<string, unknown>;
      steps: Array<{
        name: string;
        status: string;
        durationMs: number;
        error?: string;
        checkOutcome?: string;
        driftSummary?: string;
      }>;
      ruleResults?: Array<{
        label: string;
        passed: boolean;
        durationMs: number;
      }>;
      error?: string;
    }>;
  }>;
  summary: {
    totalWorkflows: number;
    passed: number;
    failed: number;
    skipped: number;
    totalDurationMs: number;
  };
}

/**
 * Format workflow execution results as structured JSON.
 *
 * @returns JSON string with 2-space indentation.
 */
export function formatLocalJsonResult(results: WorkflowExecutionResult[]): string {
  const passed = results.filter((r) => r.status === 'success').length;
  const failed = results.filter((r) => r.status === 'failure').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const totalDurationMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  const output: LocalJsonOutput = {
    workflows: results.map((wf) => ({
      name: wf.name,
      status: wf.status,
      durationMs: wf.durationMs,
      jobs: wf.jobs.map((job) => ({
        name: job.name,
        status: job.status,
        durationMs: job.durationMs,
        ...(job.matrixValues &&
          Object.keys(job.matrixValues).length > 0 && { matrixValues: job.matrixValues }),
        steps: job.steps.map((step) => ({
          name: step.name,
          status: step.status,
          durationMs: step.durationMs,
          ...(step.error && { error: step.error.message }),
          ...(step.checkOutcome && { checkOutcome: step.checkOutcome }),
          ...(step.driftSummary && { driftSummary: step.driftSummary }),
        })),
        ...(job.ruleResults &&
          job.ruleResults.length > 0 && {
            ruleResults: job.ruleResults.map((r) => ({
              label: r.label,
              passed: r.passed,
              durationMs: r.durationMs,
            })),
          }),
        ...(job.error && { error: job.error.message }),
      })),
    })),
    summary: {
      totalWorkflows: results.length,
      passed,
      failed,
      skipped,
      totalDurationMs,
    },
  };

  return JSON.stringify(output, null, 2);
}

// --- JUnit XML output ---

/**
 * Format workflow execution results as JUnit XML.
 *
 * Each workflow maps to a <testsuite>, each job maps to a <testcase>.
 * Failed jobs include failure message. Skipped/cancelled jobs use <skipped />.
 *
 * @returns Valid JUnit XML string.
 */
export function formatLocalJunitResult(results: WorkflowExecutionResult[]): string {
  const totalTests = results.reduce((sum, r) => sum + r.jobs.length, 0);
  const totalFailures = results.reduce(
    (sum, r) => sum + r.jobs.filter((j) => j.status === 'failure').length,
    0,
  );
  const totalTimeSeconds = results.reduce((sum, r) => sum + r.durationMs / 1000, 0);

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<testsuites name="kici-local" tests="${totalTests}" failures="${totalFailures}" time="${totalTimeSeconds.toFixed(3)}">`,
  );

  for (const workflow of results) {
    const suiteTests = workflow.jobs.length;
    const suiteFailures = workflow.jobs.filter((j) => j.status === 'failure').length;
    const suiteTimeSeconds = workflow.durationMs / 1000;

    lines.push(
      `  <testsuite name="${escapeXml(workflow.name)}" tests="${suiteTests}" failures="${suiteFailures}" time="${suiteTimeSeconds.toFixed(3)}">`,
    );

    for (const job of workflow.jobs) {
      const jobTimeSeconds = job.durationMs / 1000;
      const jobName = formatJobLabel(job);

      if (job.status === 'failure') {
        const errorMsg = job.error?.message ?? 'Job failed';
        lines.push(
          `    <testcase name="${escapeXml(jobName)}" classname="${escapeXml(workflow.name)}" time="${jobTimeSeconds.toFixed(3)}">`,
        );
        lines.push(
          `      <failure message="${escapeXml(errorMsg)}">${escapeXml(errorMsg)}</failure>`,
        );
        lines.push('    </testcase>');
      } else if (job.status === 'skipped' || job.status === 'cancelled') {
        lines.push(
          `    <testcase name="${escapeXml(jobName)}" classname="${escapeXml(workflow.name)}" time="${jobTimeSeconds.toFixed(3)}">`,
        );
        lines.push('      <skipped />');
        lines.push('    </testcase>');
      } else {
        lines.push(
          `    <testcase name="${escapeXml(jobName)}" classname="${escapeXml(workflow.name)}" time="${jobTimeSeconds.toFixed(3)}" />`,
        );
      }
    }

    lines.push('  </testsuite>');
  }

  lines.push('</testsuites>');

  return lines.join('\n');
}

/**
 * Escape special XML characters in a string.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
