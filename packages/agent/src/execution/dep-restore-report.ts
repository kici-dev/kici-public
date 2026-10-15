/**
 * One dependency restore's outcome, shared by the run log (a line per failed
 * attempt and one at the end), the agent log (a structured `Dep restore
 * report` line), and the runner-to-agent IPC message.
 *
 * The runner child's logger never reaches the agent log (the fork runner
 * discards its stdout in `setupChildStdioCapture`; the container runner's
 * stdout is the IPC channel), so a job's restore reaches it only through
 * {@link createDepRestoreReportRelay} in the parent.
 */

import { z } from 'zod';
import { createLogger } from '@kici-dev/shared';
import type { DescribedError, DownloadAttempt, NextAttempt } from './resumable-download.js';

const logger = createLogger({ prefix: 'dep-restore' });

export const DepRestoreOutcome = z.enum([
  'restored',
  'download-failed',
  'hash-mismatch',
  'extract-failed',
  'unsupported-url',
]);
export type DepRestoreOutcome = z.infer<typeof DepRestoreOutcome>;

const MAX_TEXT = 500;

const describedErrorSchema = z.object({
  message: z.string().max(MAX_TEXT),
  code: z.string().max(64).optional(),
  causeCode: z.string().max(64).optional(),
  causeMessage: z.string().max(MAX_TEXT).optional(),
});

const attemptSchema = z.object({
  attempt: z.number().int().min(1).max(10),
  resumeFrom: z.number().int().min(0),
  status: z.number().int().optional(),
  bytesReceived: z.number().int().min(0),
  bytesOnDisk: z.number().int().min(0),
  expectedBytes: z.number().int().min(0).optional(),
  durationMs: z.number().min(0),
  error: describedErrorSchema.optional(),
});

export const depRestoreReportSchema = z.object({
  outcome: DepRestoreOutcome,
  /** The tarball URL without its query (see `redactUrl`). */
  source: z.string().max(1024),
  /** Whether the tarball's SHA-256 was checked against the dispatched hash. */
  verified: z.boolean(),
  tarballBytes: z.number().int().min(0).optional(),
  attempts: z.array(attemptSchema).max(10),
  downloadMs: z.number().min(0).optional(),
  verifyMs: z.number().min(0).optional(),
  extractMs: z.number().min(0).optional(),
  error: describedErrorSchema.optional(),
});
export type DepRestoreReport = z.infer<typeof depRestoreReportSchema>;

/** Clip every free-text field to the schema's bound, so a real report always parses. */
export function clipDescribedError(e: DescribedError): DescribedError {
  const clip = (s: string | undefined, n: number) => (s === undefined ? undefined : s.slice(0, n));
  return {
    message: clip(e.message, MAX_TEXT)!,
    ...(e.code !== undefined && { code: clip(e.code, 64) }),
    ...(e.causeCode !== undefined && { causeCode: clip(e.causeCode, 64) }),
    ...(e.causeMessage !== undefined && { causeMessage: clip(e.causeMessage, MAX_TEXT) }),
  };
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** `terminated (UND_ERR_SOCKET: other side closed)` — the message and its cause. */
export function formatError(e: DescribedError): string {
  const cause = [e.causeCode ?? e.code, e.causeMessage].filter(Boolean).join(': ');
  return cause ? `${e.message} (${cause})` : e.message;
}

/** The run-log line for one failed download attempt. */
export function formatAttemptFailure(
  a: DownloadAttempt,
  maxAttempts: number,
  next: NextAttempt | undefined,
): string {
  const disk =
    a.expectedBytes !== undefined
      ? `${mb(a.bytesOnDisk)} of ${mb(a.expectedBytes)} MB on disk`
      : `${mb(a.bytesOnDisk)} MB on disk`;
  const then = !next
    ? 'giving up'
    : next.resumeFrom > 0
      ? `resuming from byte ${next.resumeFrom} in ${seconds(next.delayMs)}`
      : `retrying from the start in ${seconds(next.delayMs)}`;
  const what = a.error ? formatError(a.error) : 'failed';
  return `Dep tarball download attempt ${a.attempt}/${maxAttempts} failed after ${seconds(a.durationMs)}: ${what}; ${disk}; ${then}`;
}

/** The run-log line for a restore that succeeded. */
export function formatRestoredLine(r: DepRestoreReport): string {
  const parts: string[] = [];
  if (r.tarballBytes !== undefined && r.downloadMs !== undefined) {
    const n = r.attempts.length;
    const resumed = r.attempts.some((a) => a.resumeFrom > 0) ? ', resumed' : '';
    const how = n === 0 ? 'read locally' : `${n} attempt${n === 1 ? '' : 's'}${resumed}`;
    parts.push(`${mb(r.tarballBytes)} MB downloaded in ${seconds(r.downloadMs)} (${how})`);
  }
  if (r.verifyMs !== undefined) parts.push(`verified in ${seconds(r.verifyMs)}`);
  if (r.extractMs !== undefined) parts.push(`extracted in ${seconds(r.extractMs)}`);
  return `Deps restored from cache: ${parts.join(', ')}`;
}

/** To the agent log. */
export function logDepRestoreReport(
  report: DepRestoreReport,
  context: Record<string, string> = {},
): void {
  const fields = {
    ...context,
    outcome: report.outcome,
    source: report.source,
    verified: report.verified,
    tarballBytes: report.tarballBytes,
    attempts: report.attempts.length,
    downloadMs: report.downloadMs,
    verifyMs: report.verifyMs,
    extractMs: report.extractMs,
    ...(report.error && { error: formatError(report.error) }),
    attemptErrors: report.attempts
      .filter((a) => a.error)
      .map((a) => ({
        attempt: a.attempt,
        resumeFrom: a.resumeFrom,
        status: a.status,
        bytesReceived: a.bytesReceived,
        bytesOnDisk: a.bytesOnDisk,
        expectedBytes: a.expectedBytes,
        durationMs: a.durationMs,
        error: formatError(a.error!),
      })),
  };
  if (report.outcome === DepRestoreOutcome.enum.restored) {
    logger.info('Dep restore report', fields);
  } else {
    logger.warn('Dep restore report', fields);
  }
}

/**
 * Run setup, then send the one `dep-restore.report` that closes the agent's
 * relay — carrying no report when no restore ran (no `depsUrl`, no
 * `.kici/package.json`, a cleanup-only run). Sent even when setup throws, and
 * before the workflow module loads, so workflow code never runs while the
 * relay is open.
 */
export async function runSetupThenSendDepRestoreReport(
  setup: (onReport: (report: DepRestoreReport) => void) => Promise<void>,
  send: (report: DepRestoreReport | undefined) => void,
): Promise<void> {
  let report: DepRestoreReport | undefined;
  try {
    await setup((r) => {
      report = r;
    });
  } finally {
    send(report);
  }
}

/**
 * Relay a runner child's `dep-restore.report` into the agent log.
 *
 * Workflow code in the child (module load, pre-step evaluations, steps) can
 * call `process.send`, and the agent log reaches journald and Loki without the
 * run log's `runs:read` check, so the relay accepts only the restore's own
 * message: the first `dep-restore.report` (sent before the workflow module
 * loads, {@link runSetupThenSendDepRestoreReport}) closes it whatever it
 * carries, as does a `step.start`. The report is logged only when it parses
 * against {@link depRestoreReportSchema}.
 */
export interface DepRestoreReportRelay {
  onStepStarted(): void;
  /** Takes the `report` field of a `dep-restore.report` message; `undefined` when it carried none. */
  relay(raw: unknown): void;
}

export function createDepRestoreReportRelay(
  jobId: string,
  sink: (report: DepRestoreReport, context: Record<string, string>) => void = logDepRestoreReport,
): DepRestoreReportRelay {
  let closed = false;
  return {
    onStepStarted() {
      closed = true;
    },
    relay(raw) {
      if (closed) {
        logger.warn('Ignored a dep-restore report sent outside job setup', { jobId });
        return;
      }
      closed = true;
      if (raw === undefined) return;
      const parsed = depRestoreReportSchema.safeParse(raw);
      if (!parsed.success) {
        logger.warn('Ignored a malformed dep-restore report', { jobId });
        return;
      }
      sink(parsed.data, { jobId, via: 'runner' });
    },
  };
}
