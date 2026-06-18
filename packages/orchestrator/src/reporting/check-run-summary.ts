/**
 * Check run summary, annotation, and progress text builders.
 *
 * These are pure functions that produce markdown and annotation objects
 * for the GitHub Checks API. No side effects, no API calls -- just data
 * transformation from step results + log buffers to GitHub-ready output.
 *
 * Per locked decisions:
 * - Summary headline: "Job '{jobName}' failed (N/M steps passed)" or success equivalent
 * - Step table with Status | Step | Duration columns
 * - Failed steps: error + last 20 log lines in code blocks
 * - Annotations: failure/warning level, capped at 50
 * - Progress: checklist-style with emoji prefixes
 * - Size safety: 65535 byte limit with progressive truncation
 */

import { formatDuration } from '@kici-dev/shared';
import type { StepLogBuffer } from './step-log-buffer.js';

// ---------------------------------------------------------------------------
// Data interfaces
// ---------------------------------------------------------------------------

/** Step result data as sent by the agent in job.status data.stepResults. */
export interface StepResultData {
  name: string;
  status: 'success' | 'failed' | 'error' | 'skipped' | 'cancelled';
  durationMs?: number;
  error?: string;
  exitCode?: number;
  timedOut?: boolean;
  continueOnError?: boolean;
}

/** Source location data from the lock file for annotation linking. */
export interface SourceLocationData {
  file: string;
  line: number;
  column: number;
}

/** A GitHub Check annotation object. */
export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'failure' | 'warning' | 'notice';
  message: string;
  title: string;
  raw_details?: string;
}

/** Step progress entry for live updates. */
export interface StepProgressEntry {
  name: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'error' | 'skipped' | 'cancelled';
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Options interfaces
// ---------------------------------------------------------------------------

interface BuildCheckRunSummaryOptions {
  jobName: string;
  stepResults: StepResultData[];
  logBuffer: StepLogBuffer;
  runId: string;
  jobId: string;
  traceIds: { requestId: string; runId: string };
  /** Total job duration in milliseconds. */
  jobDurationMs?: number;
}

interface BuildAnnotationsOptions {
  stepResults: StepResultData[];
  /** Source locations indexed by step index. Missing entries are skipped. */
  sourceLocations: Map<number, SourceLocationData>;
}

interface BuildProgressTextOptions {
  steps: StepProgressEntry[];
  traceIds: { requestId: string; runId: string };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** GitHub Checks API output.summary byte limit. */
const SUMMARY_BYTE_LIMIT = 65_535;

/** Maximum annotations per GitHub Checks API request. */
const MAX_ANNOTATIONS = 50;

/** Progressive log line counts for truncation when summary too large. */
const LOG_LINE_TIERS = [20, 10, 5, 0] as const;

// Re-export for consumers that import from this module.
export { formatDuration } from '@kici-dev/shared';

// ---------------------------------------------------------------------------
// Status emoji helpers
// ---------------------------------------------------------------------------

function statusEmoji(status: string): string {
  switch (status) {
    case 'success':
      return '\u2714'; // heavy check mark
    case 'failed':
    case 'error':
      return '\u2716'; // heavy multiplication X
    case 'skipped':
      return '\u23ED'; // next track
    case 'cancelled':
      return '\u2716'; // heavy multiplication X
    default:
      return '\u2753'; // question mark
  }
}

function progressEmoji(status: string): string {
  switch (status) {
    case 'success':
      return '\u2714';
    case 'failed':
    case 'error':
      return '\u2716';
    case 'skipped':
      return '\u23ED';
    case 'cancelled':
      return '\u2716';
    case 'running':
      return '\u231B'; // hourglass
    default:
      return '\u25CB'; // white circle (pending)
  }
}

// ---------------------------------------------------------------------------
// buildCheckRunSummary
// ---------------------------------------------------------------------------

/**
 * Build a rich markdown summary for a GitHub Check run output.summary field.
 *
 * Includes: headline, step table, failure details with log context, trace footer.
 * Respects the 65535 byte limit with progressive log truncation.
 */
export function buildCheckRunSummary(opts: BuildCheckRunSummaryOptions): string {
  const { stepResults, logBuffer, runId, jobId, traceIds, jobName } = opts;

  const passed = stepResults.filter((s) => s.status === 'success').length;
  const total = stepResults.length;
  const allPassed = passed === total;

  // Try building with progressively fewer log lines until under byte limit
  for (const maxLogLines of LOG_LINE_TIERS) {
    const summary = buildSummaryWithLogLimit(
      jobName,
      stepResults,
      logBuffer,
      runId,
      jobId,
      traceIds,
      opts.jobDurationMs,
      passed,
      total,
      allPassed,
      maxLogLines,
    );

    if (Buffer.byteLength(summary, 'utf-8') <= SUMMARY_BYTE_LIMIT) {
      return summary;
    }
  }

  // Final fallback: minimal summary (should always fit)
  const headline = allPassed
    ? `**Job '${jobName}' passed** (${passed}/${total} steps passed)`
    : `**Job '${jobName}' failed** (${passed}/${total} steps passed)`;

  return `${headline}\n\n_Summary truncated due to size limits._\n\nTrace: ${traceIds.requestId} | Run: ${traceIds.runId}`;
}

function buildSummaryWithLogLimit(
  jobName: string,
  stepResults: StepResultData[],
  logBuffer: StepLogBuffer,
  runId: string,
  jobId: string,
  traceIds: { requestId: string; runId: string },
  jobDurationMs: number | undefined,
  passed: number,
  total: number,
  allPassed: boolean,
  maxLogLines: number,
): string {
  const parts: string[] = [];

  // Headline
  if (allPassed) {
    parts.push(`**Job '${jobName}' passed** (${passed}/${total} steps passed)`);
  } else {
    parts.push(`**Job '${jobName}' failed** (${passed}/${total} steps passed)`);
  }

  parts.push('');

  // Step table
  parts.push('| Step | Status | Duration |');
  parts.push('|------|--------|----------|');

  for (const step of stepResults) {
    const emoji = statusEmoji(step.status);
    const duration = step.durationMs !== undefined ? formatDuration(step.durationMs) : '-';
    parts.push(`| ${step.name} | ${emoji} ${step.status} | ${duration} |`);
  }

  // Job total duration
  if (jobDurationMs !== undefined) {
    parts.push('');
    parts.push(`**Total duration:** ${formatDuration(jobDurationMs)}`);
  }

  // Failed step details
  const failedSteps = stepResults.filter((s) => s.status === 'failed' || s.status === 'error');

  if (failedSteps.length > 0 && maxLogLines >= 0) {
    for (let i = 0; i < stepResults.length; i++) {
      const step = stepResults[i];
      if (step.status !== 'failed' && step.status !== 'error') continue;

      parts.push('');
      parts.push(`### ${statusEmoji(step.status)} ${step.name}`);
      parts.push('');

      // Timeout message
      if (step.timedOut) {
        const timeoutSec =
          step.durationMs !== undefined ? (step.durationMs / 1000).toFixed(0) : '?';
        parts.push(`**Step timed out after ${timeoutSec}s**`);
        parts.push('');
      }

      // Error message
      if (step.error) {
        parts.push(`**Error:** ${step.error}`);
        parts.push('');
      }

      // Log lines
      if (maxLogLines > 0) {
        const logEntry = logBuffer.getLastLines({
          runId,
          jobId,
          stepIndex: i,
        });

        if (logEntry && logEntry.lines.length > 0) {
          if (logEntry.totalCount > maxLogLines) {
            parts.push(`... (showing last ${maxLogLines} of ${logEntry.totalCount} lines)`);
          }
          parts.push('```');
          // Only take up to maxLogLines from the entry
          const linesToShow = logEntry.lines.slice(-maxLogLines);
          parts.push(linesToShow.join('\n'));
          parts.push('```');
        }
      }

      // Exit code
      if (step.exitCode !== undefined) {
        parts.push('');
        parts.push(`Exit code: ${step.exitCode}`);
      }
    }
  }

  // Trace footer
  parts.push('');
  parts.push(`Trace: ${traceIds.requestId} | Run: ${traceIds.runId}`);

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// buildAnnotations
// ---------------------------------------------------------------------------

/**
 * Build GitHub Check annotation objects from step results and source locations.
 *
 * Returns an object with the annotations array (capped at 50) and the count
 * of remaining annotations that could not be included.
 */
export function buildAnnotations(opts: BuildAnnotationsOptions): {
  annotations: CheckAnnotation[];
  remainingCount: number;
} {
  const { stepResults, sourceLocations } = opts;
  const allAnnotations: CheckAnnotation[] = [];

  for (let i = 0; i < stepResults.length; i++) {
    const step = stepResults[i];

    // Only annotate failed/error steps
    if (step.status !== 'failed' && step.status !== 'error') continue;

    // Skip steps without source location
    const loc = sourceLocations.get(i);
    if (!loc) continue;

    const level: 'failure' | 'warning' = step.continueOnError ? 'warning' : 'failure';

    const messageParts: string[] = [`Step '${step.name}'`];
    if (step.error) {
      messageParts.push(step.error);
    }

    const title = step.continueOnError ? `Warning: ${step.name}` : `Failed: ${step.name}`;

    const rawDetailsParts: string[] = [];
    if (step.error) rawDetailsParts.push(step.error);
    if (step.exitCode !== undefined) rawDetailsParts.push(`Exit code: ${step.exitCode}`);
    if (step.timedOut) rawDetailsParts.push('Step timed out');

    allAnnotations.push({
      path: loc.file,
      start_line: loc.line,
      end_line: loc.line,
      annotation_level: level,
      message: messageParts.join(': '),
      title,
      raw_details: rawDetailsParts.length > 0 ? rawDetailsParts.join('\n') : undefined,
    });
  }

  // Cap at MAX_ANNOTATIONS
  if (allAnnotations.length <= MAX_ANNOTATIONS) {
    return { annotations: allAnnotations, remainingCount: 0 };
  }

  return {
    annotations: allAnnotations.slice(0, MAX_ANNOTATIONS),
    remainingCount: allAnnotations.length - MAX_ANNOTATIONS,
  };
}

// ---------------------------------------------------------------------------
// buildProgressText
// ---------------------------------------------------------------------------

/**
 * Build a checklist-style markdown string for live check run updates.
 *
 * Example:
 *   checkmark Install deps (1.2s)
 *   checkmark Build (3.4s)
 *   hourglass Run tests...
 *   (not yet started) Deploy
 */
export function buildProgressText(opts: BuildProgressTextOptions): string {
  const { steps, traceIds } = opts;
  const lines: string[] = [];

  for (const step of steps) {
    const emoji = progressEmoji(step.status);

    if (step.status === 'running') {
      lines.push(`${emoji} ${step.name}...`);
    } else if (step.status === 'pending') {
      lines.push(`${emoji} ${step.name}`);
    } else if (step.durationMs !== undefined) {
      lines.push(`${emoji} ${step.name} (${formatDuration(step.durationMs)})`);
    } else {
      lines.push(`${emoji} ${step.name}`);
    }
  }

  lines.push('');
  lines.push(`Trace: ${traceIds.requestId} | Run: ${traceIds.runId}`);

  return lines.join('\n');
}
