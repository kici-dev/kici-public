/**
 * The outcome of one dependency restore, in a shape three readers share: the
 * run log (one human line per failed attempt and one at the end), the agent
 * log (a structured `Dep restore report` line), and the runner IPC message
 * that carries the report from the runner child to the agent process.
 *
 * The runner child's own logger output never reaches the agent log: the fork
 * runner discards the child's stdout (`fork-runner.ts`
 * `setupChildStdioCapture`), and the container runner's stdout carries the IPC
 * protocol. So an execution job's restore reaches the agent log only through
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

/** Write one report to the agent log. */
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
 * Run the runner's setup phases, then send the one `dep-restore.report`
 * message that closes the agent's relay: with the restore's report, or with
 * none when no restore ran (no `depsUrl`, no `.kici/package.json`, a
 * cleanup-only run). It is sent even when setup throws, and always before the
 * runner loads the workflow module, so workflow code never runs while the
 * relay is still open.
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
 * The runner child also runs workflow code — the module it loads, the
 * evaluations before the first step, and the steps — and that code can call
 * `process.send`. The agent log reaches journald and Loki without the run
 * log's `runs:read` check, so the relay takes only what the restore itself
 * sends. The runner sends exactly one `dep-restore.report` at the end of its
 * setup, before it loads the workflow module
 * ({@link runSetupThenSendDepRestoreReport}), so the first such message closes
 * the relay whatever it carries; a `step.start` closes it too. The report it
 * carries is logged only when it parses against {@link depRestoreReportSchema}.
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
      // Setup ended without a restore.
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
