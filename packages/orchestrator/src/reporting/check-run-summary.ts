/**
 * Pure builders for GitHub Checks API summaries, annotations and progress text, from step
 * results and log buffers. No side effects, no API calls.
 *
 * Output contract:
 * - Summary headline: "Job '{jobName}' failed (N/M steps passed)" or success equivalent
 * - Step table with Step | Status | Duration columns
 * - Failed steps: error + last 20 log lines in code blocks
 * - Annotations: failure/warning level, capped at 50
 * - Progress: checklist-style with emoji prefixes
 * - Size safety: 65535 byte limit with progressive truncation
 */

import { formatDuration } from '@kici-dev/shared';
import { compareStepsByPhase } from '@kici-dev/engine';
import type { StepLogBuffer } from './step-log-buffer.js';

// ---------------------------------------------------------------------------
// Data interfaces
// ---------------------------------------------------------------------------

/** Step result data as sent by the agent in job.status data.stepResults. */
export interface StepResultData {
  name: string;
  status: 'success' | 'failed' | 'skipped' | 'cancelled';
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
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled';
  durationMs?: number;
  /** The step's stored index. An entry without one is read by its position (defensive). */
  stepIndex?: number;
  /** The step's `step_type`; places setup and init pseudo-steps first. */
  stepType?: string;
}

/**
 * Record one step's progress: replace the entry for its index, or add it in display
 * order. Pseudo-steps have high indices (init at 1_000_000 + n), so the list is keyed
 * by index rather than position; a positional list would pad every gap up to it.
 */
export function applyStepProgress(
  steps: StepProgressEntry[],
  entry: StepProgressEntry & { stepIndex: number },
): StepProgressEntry[] {
  const indexed = steps.map((s, position) => ({ ...s, stepIndex: s.stepIndex ?? position }));
  const rest = indexed.filter((s) => s.stepIndex !== entry.stepIndex);
  return [...rest, entry].sort(compareStepsByPhase);
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
  /** Milliseconds. */
  jobDurationMs?: number;
  /**
   * Bytes the caller adds around the summary (the prepended reduced-privilege note, the
   * appended annotation-count line), subtracted from the byte budget. Without it the caller's
   * bytes push the string over the API cap, which rejects the whole update and leaves the
   * check run unresolved; reserving drops one more log tier instead.
   */
  reservedBytes?: number;
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
export const SUMMARY_BYTE_LIMIT = 65_535;

/**
 * Cut `summary` to fit the API's cap, whatever a caller wrapped around it. The last line of
 * defence: `reservedBytes` keeps a summary readable by dropping log tiers first.
 */
export function clampSummaryToLimit(summary: string, limit = SUMMARY_BYTE_LIMIT): string {
  const buf = Buffer.from(summary, 'utf-8');
  if (buf.byteLength <= limit) return summary;
  const notice = '\n\n_Summary truncated due to size limits._';
  const noticeBytes = Buffer.byteLength(notice, 'utf-8');
  // A limit too small for the notice drops it, so the result never overshoots the limit
  // (unreachable from the default cap).
  const keep = limit >= noticeBytes ? limit - noticeBytes : limit;
  const tail = limit >= noticeBytes ? notice : '';
  // A slice ending mid-UTF-8-sequence decodes to replacement characters wider than the
  // orphaned bytes, which can push the result back over the cap. Trim them.
  const head = buf.subarray(0, keep).toString('utf-8');
  return `${head.replace(/\uFFFD+$/, '')}${tail}`;
}

/** Maximum annotations per GitHub Checks API request. */
const MAX_ANNOTATIONS = 50;

/** Log lines per failed step, tried in order until the summary fits. */
const LOG_LINE_TIERS = [20, 10, 5, 0] as const;

export { formatDuration } from '@kici-dev/shared';

// ---------------------------------------------------------------------------
// Status emoji helpers
// ---------------------------------------------------------------------------

function statusEmoji(status: string): string {
  switch (status) {
    case 'success':
      return '\u2714'; // heavy check mark
    case 'failed':
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
 * Markdown for a check run's output.summary: headline, step table, failure details with log
 * context, trace footer. Fits 65535 bytes minus `reservedBytes` by progressive log truncation.
 */
export function buildCheckRunSummary(opts: BuildCheckRunSummaryOptions): string {
  const { stepResults, logBuffer, runId, jobId, traceIds, jobName } = opts;

  const passed = stepResults.filter((s) => s.status === 'success').length;
  const total = stepResults.length;
  const allPassed = passed === total;
  const budget = SUMMARY_BYTE_LIMIT - (opts.reservedBytes ?? 0);

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

    if (Buffer.byteLength(summary, 'utf-8') <= budget) {
      return summary;
    }
  }

  // Minimal fallback (should always fit).
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

  if (allPassed) {
    parts.push(`**Job '${jobName}' passed** (${passed}/${total} steps passed)`);
  } else {
    parts.push(`**Job '${jobName}' failed** (${passed}/${total} steps passed)`);
  }

  parts.push('');

  parts.push('| Step | Status | Duration |');
  parts.push('|------|--------|----------|');

  for (const step of stepResults) {
    const emoji = statusEmoji(step.status);
    const duration = step.durationMs !== undefined ? formatDuration(step.durationMs) : '-';
    parts.push(`| ${step.name} | ${emoji} ${step.status} | ${duration} |`);
  }

  if (jobDurationMs !== undefined) {
    parts.push('');
    parts.push(`**Total duration:** ${formatDuration(jobDurationMs)}`);
  }

  const failedSteps = stepResults.filter((s) => s.status === 'failed');

  if (failedSteps.length > 0 && maxLogLines >= 0) {
    for (let i = 0; i < stepResults.length; i++) {
      const step = stepResults[i];
      if (step.status !== 'failed') continue;

      parts.push('');
      parts.push(`### ${statusEmoji(step.status)} ${step.name}`);
      parts.push('');

      if (step.timedOut) {
        const timeoutSec =
          step.durationMs !== undefined ? (step.durationMs / 1000).toFixed(0) : '?';
        parts.push(`**Step timed out after ${timeoutSec}s**`);
        parts.push('');
      }

      if (step.error) {
        parts.push(`**Error:** ${step.error}`);
        parts.push('');
      }

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
          const linesToShow = logEntry.lines.slice(-maxLogLines);
          parts.push(linesToShow.join('\n'));
          parts.push('```');
        }
      }

      if (step.exitCode !== undefined) {
        parts.push('');
        parts.push(`Exit code: ${step.exitCode}`);
      }
    }
  }

  parts.push('');
  parts.push(`Trace: ${traceIds.requestId} | Run: ${traceIds.runId}`);

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// buildAnnotations
// ---------------------------------------------------------------------------

/**
 * Annotations for failed steps with a source location, capped at 50; `remainingCount` is how
 * many did not fit.
 */
export function buildAnnotations(opts: BuildAnnotationsOptions): {
  annotations: CheckAnnotation[];
  remainingCount: number;
} {
  const { stepResults, sourceLocations } = opts;
  const allAnnotations: CheckAnnotation[] = [];

  for (let i = 0; i < stepResults.length; i++) {
    const step = stepResults[i];

    if (step.status !== 'failed') continue;

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
 * Checklist-style markdown for live check run updates, for example:
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
