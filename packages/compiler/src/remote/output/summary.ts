import pc from 'picocolors';
import { formatDuration } from '@kici-dev/core';
import {
  ExecutionJobStatus,
  ExecutionRunStatus,
  toCanonicalStatus,
  type CanonicalStatus,
} from '@kici-dev/engine';

/** One job of a fixture's result. */
export interface RunJobResult {
  name: string;
  status: string;
  durationMs?: number;
  /** The workflow that defines the job, when the server named it. */
  workflowName?: string;
}

/** One run of a fixture: a fixture that matches several workflows creates one run per workflow. */
interface FixtureRunResult {
  runId: string;
  workflowName?: string;
  status: string;
  jobs: RunJobResult[];
}

export interface RunResult {
  fixtureId: string;
  /** The first run's id. */
  runId: string;
  /** The combined result: `success` only when every run succeeded. */
  status: 'success' | 'failed' | 'cancelled';
  totalDurationMs: number;
  /** Every run's jobs. */
  jobs: RunJobResult[];
  /** Each run the fixture created; absent when the result predates it. */
  runs?: FixtureRunResult[];
}

/** True when the jobs come from more than one workflow, so a bare job name is ambiguous. */
export function spansWorkflows(jobs: readonly RunJobResult[]): boolean {
  return new Set(jobs.map((j) => j.workflowName).filter((w) => w !== undefined)).size > 1;
}

/** `<workflow> / <job>` when the result spans workflows, else the job name. */
export function jobLabel(job: RunJobResult, labelWorkflow: boolean): string {
  return labelWorkflow && job.workflowName ? `${job.workflowName} / ${job.name}` : job.name;
}

export function formatSummary(result: RunResult): string {
  const labelWorkflow = spansWorkflows(result.jobs);
  const rows = result.jobs.map((job) => ({
    name: jobLabel(job, labelWorkflow),
    status: formatJobStatus(job.status),
    statusRaw: job.status,
    duration: job.durationMs !== undefined ? formatDuration(job.durationMs) : '-',
  }));

  // Widths from raw text, not ANSI-colored text.
  const nameWidth = Math.max(3, ...rows.map((r) => r.name.length));
  const statusRawWidth = Math.max(6, ...rows.map((r) => statusTextLength(r.statusRaw)));
  const durationWidth = Math.max(8, ...rows.map((r) => r.duration.length));

  const lines: string[] = [];

  lines.push(
    `\u250c${'\u2500'.repeat(nameWidth + 2)}\u252c${'\u2500'.repeat(statusRawWidth + 2)}\u252c${'\u2500'.repeat(durationWidth + 2)}\u2510`,
  );

  lines.push(
    `\u2502 ${'Job'.padEnd(nameWidth)} \u2502 ${'Status'.padEnd(statusRawWidth)} \u2502 ${'Duration'.padEnd(durationWidth)} \u2502`,
  );

  lines.push(
    `\u251c${'\u2500'.repeat(nameWidth + 2)}\u253c${'\u2500'.repeat(statusRawWidth + 2)}\u253c${'\u2500'.repeat(durationWidth + 2)}\u2524`,
  );

  for (const row of rows) {
    const statusPadding = statusRawWidth - statusTextLength(row.statusRaw);
    lines.push(
      `\u2502 ${row.name.padEnd(nameWidth)} \u2502 ${row.status}${' '.repeat(statusPadding)} \u2502 ${row.duration.padEnd(durationWidth)} \u2502`,
    );
  }

  lines.push(
    `\u2514${'\u2500'.repeat(nameWidth + 2)}\u2534${'\u2500'.repeat(statusRawWidth + 2)}\u2534${'\u2500'.repeat(durationWidth + 2)}\u2518`,
  );

  lines.push('');
  const resultText = result.status === 'success' ? pc.green('PASSED') : pc.red('FAILED');
  lines.push(`Result: ${resultText} (${formatDuration(result.totalDurationMs)})`);

  return lines.join('\n');
}

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

/**
 * Exhaustive by type: a new engine status breaks the typecheck rather than
 * printing an uncoloured raw spelling with no severity signal. One table, so
 * the padding width and the rendered icon column cannot disagree.
 */
const JOB_STATUS_DISPLAY: Readonly<
  Record<CanonicalStatus, { text: string; color: (s: string) => string }>
> = Object.freeze({
  [ExecutionRunStatus.enum.success]: { text: '\u2713 pass', color: pc.green },
  [ExecutionRunStatus.enum.failed]: { text: '\u2717 fail', color: pc.red },
  [ExecutionJobStatus.enum.timed_out_stale]: { text: '\u2717 timeout', color: pc.red },
  [ExecutionJobStatus.enum.drift_dropped]: { text: '\u2717 dropped', color: pc.red },
  [ExecutionJobStatus.enum.unroutable]: { text: '\u2717 unroutable', color: pc.red },
  [ExecutionRunStatus.enum.cancelled]: { text: '! cancel', color: pc.yellow },
  [ExecutionRunStatus.enum.cancelling]: { text: '! cancelling', color: pc.yellow },
  [ExecutionJobStatus.enum.recovering]: { text: '~ recovering', color: pc.yellow },
  [ExecutionRunStatus.enum.held]: { text: '~ held', color: pc.yellow },
  [ExecutionRunStatus.enum.running]: { text: '> running', color: pc.cyan },
  [ExecutionJobStatus.enum.queued]: { text: '- queued', color: pc.dim },
  [ExecutionRunStatus.enum.pending]: { text: '- pending', color: pc.dim },
  [ExecutionJobStatus.enum.skipped]: { text: '- skip', color: pc.dim },
});

function statusDisplayText(status: string): string {
  const canonical = toCanonicalStatus(status.toLowerCase());
  return canonical !== undefined ? JOB_STATUS_DISPLAY[canonical].text : status;
}

function formatJobStatus(status: string): string {
  const canonical = toCanonicalStatus(status.toLowerCase());
  if (canonical === undefined) return status;
  const { text, color } = JOB_STATUS_DISPLAY[canonical];
  return color(text);
}

function statusTextLength(status: string): number {
  return statusDisplayText(status).length;
}
