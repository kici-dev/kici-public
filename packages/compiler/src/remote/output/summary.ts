/**
 * Completion summary output formatters.
 *
 * Renders summary tables, error highlights, and multi-fixture aggregates
 * for display after run completion.
 */

import pc from 'picocolors';
import { formatDuration } from '@kici-dev/core';

/** Result of a single run (fixture execution). */
export interface RunResult {
  fixtureId: string;
  runId: string;
  status: 'success' | 'failed' | 'cancelled';
  totalDurationMs: number;
  jobs: Array<{
    name: string;
    status: string;
    durationMs?: number;
  }>;
}

/**
 * Format a summary table for a single run result.
 *
 * Renders a box-drawn table with job name, status, and duration.
 * Status is colored: green for pass, red for fail, gray for skip.
 */
export function formatSummary(result: RunResult): string {
  const rows = result.jobs.map((job) => ({
    name: job.name,
    status: formatJobStatus(job.status),
    statusRaw: job.status,
    duration: job.durationMs !== undefined ? formatDuration(job.durationMs) : '-',
  }));

  // Calculate column widths (based on raw text, not ANSI-colored text)
  const nameWidth = Math.max(3, ...rows.map((r) => r.name.length));
  const statusRawWidth = Math.max(6, ...rows.map((r) => statusTextLength(r.statusRaw)));
  const durationWidth = Math.max(8, ...rows.map((r) => r.duration.length));

  const lines: string[] = [];

  // Top border
  lines.push(
    `\u250c${'\u2500'.repeat(nameWidth + 2)}\u252c${'\u2500'.repeat(statusRawWidth + 2)}\u252c${'\u2500'.repeat(durationWidth + 2)}\u2510`,
  );

  // Header
  lines.push(
    `\u2502 ${'Job'.padEnd(nameWidth)} \u2502 ${'Status'.padEnd(statusRawWidth)} \u2502 ${'Duration'.padEnd(durationWidth)} \u2502`,
  );

  // Separator
  lines.push(
    `\u251c${'\u2500'.repeat(nameWidth + 2)}\u253c${'\u2500'.repeat(statusRawWidth + 2)}\u253c${'\u2500'.repeat(durationWidth + 2)}\u2524`,
  );

  // Rows
  for (const row of rows) {
    const statusPadding = statusRawWidth - statusTextLength(row.statusRaw);
    lines.push(
      `\u2502 ${row.name.padEnd(nameWidth)} \u2502 ${row.status}${' '.repeat(statusPadding)} \u2502 ${row.duration.padEnd(durationWidth)} \u2502`,
    );
  }

  // Bottom border
  lines.push(
    `\u2514${'\u2500'.repeat(nameWidth + 2)}\u2534${'\u2500'.repeat(statusRawWidth + 2)}\u2534${'\u2500'.repeat(durationWidth + 2)}\u2518`,
  );

  // Overall result
  lines.push('');
  const resultText = result.status === 'success' ? pc.green('PASSED') : pc.red('FAILED');
  lines.push(`Result: ${resultText} (${formatDuration(result.totalDurationMs)})`);

  return lines.join('\n');
}

/**
 * Format an error highlight section showing the last lines of a failed step.
 *
 * @param failedJobName The name of the failed job.
 * @param lastLines The last N lines of the failed step's output.
 */
export function formatErrorHighlight(failedJobName: string, lastLines: string[]): string {
  const maxLines = 50;
  const truncated = lastLines.slice(-maxLines);
  const headerWidth = 40;
  const header = `── Error: ${failedJobName} `;
  const headerLine = pc.red(header + '\u2500'.repeat(Math.max(0, headerWidth - header.length)));
  const footerLine = pc.red('\u2500'.repeat(headerWidth));

  const lines: string[] = [];
  lines.push(headerLine);
  for (const line of truncated) {
    lines.push(line);
  }
  lines.push(footerLine);

  return lines.join('\n');
}

/**
 * Format a multi-fixture summary aggregate.
 *
 * Shows counts: "Fixtures: N passed, M failed, T total"
 */
export function formatMultiFixtureSummary(results: RunResult[]): string {
  const passed = results.filter((r) => r.status === 'success').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const cancelled = results.filter((r) => r.status === 'cancelled').length;
  const total = results.length;

  const parts: string[] = [];
  if (passed > 0) parts.push(pc.green(`${passed} passed`));
  if (failed > 0) parts.push(pc.red(`${failed} failed`));
  if (cancelled > 0) parts.push(pc.yellow(`${cancelled} cancelled`));
  parts.push(`${total} total`);

  return `Fixtures: ${parts.join(', ')}`;
}

// ── Helpers ────────────────────────────────────────────────

/** Format a job status with icon and color. */
function formatJobStatus(status: string): string {
  switch (status) {
    case 'success':
      return pc.green('\u2713 pass');
    case 'failed':
      return pc.red('\u2717 fail');
    case 'skipped':
      return pc.dim('- skip');
    case 'cancelled':
      return pc.yellow('! cancel');
    default:
      return status;
  }
}

/** Get the visual text length for a status (for padding). */
function statusTextLength(status: string): number {
  switch (status) {
    case 'success':
      return 6; // "V pass"
    case 'failed':
      return 6; // "X fail"
    case 'skipped':
      return 6; // "- skip"
    case 'cancelled':
      return 8; // "! cancel"
    default:
      return status.length;
  }
}
