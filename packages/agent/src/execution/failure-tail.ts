/**
 * The bounded failure text a job reports.
 *
 * A failed command's output can be megabytes, and a progress bar writes the
 * same line hundreds of times with carriage returns. The job error carries
 * what a reader needs: what the terminal shows of the last lines, capped. The
 * full output stays in the step's log.
 */
import { stripVTControlCharacters } from 'node:util';
import {
  truncateReasonText,
  truncateReasonTextKeepEnd,
  type TimeoutReason,
} from '@kici-dev/engine';
import { toErrorMessage } from '@kici-dev/shared';

/** Lines of output a job error keeps: the last ones, where a command's cause usually is. */
export const FAILURE_TAIL_MAX_LINES = 20;
/** Characters a job error keeps. */
export const FAILURE_TAIL_MAX_CHARS = 1500;

export interface FailureTailOptions {
  /**
   * Masks secrets in one line. Applied to whole lines before any cut, because
   * a cut inside a secret leaves a fragment the masker no longer matches.
   */
  mask?: (line: string) => string;
}

/**
 * The lines a terminal shows for `text`: ANSI escape codes removed, and each
 * line reduced to the text after its last carriage return, which is the final
 * state of a progress bar that redraws one line.
 */
export function visibleLines(text: string): string[] {
  return stripVTControlCharacters(text)
    .split('\n')
    .map((line) => {
      const body = line.endsWith('\r') ? line.slice(0, -1) : line;
      return body.slice(body.lastIndexOf('\r') + 1);
    });
}

/**
 * Bound output to what a job error carries: the last
 * {@link FAILURE_TAIL_MAX_LINES} visible lines, without blank lines at either
 * edge, capped at {@link FAILURE_TAIL_MAX_CHARS}. Several lines keep their end
 * (a command's cause is at the bottom); a single line keeps its start (an error
 * message states its cause first). Applying it twice gives the same text.
 */
export function formatFailureTail(text: string, opts: FailureTailOptions = {}): string {
  const lines = visibleLines(text).map((line) => (opts.mask ? opts.mask(line) : line));
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  let start = Math.max(0, end - FAILURE_TAIL_MAX_LINES);
  while (start < end && lines[start].trim() === '') start++;
  const kept = lines.slice(start, end);
  const joined = kept.join('\n');
  return kept.length > 1
    ? truncateReasonTextKeepEnd(joined, FAILURE_TAIL_MAX_CHARS)
    : truncateReasonText(joined, FAILURE_TAIL_MAX_CHARS);
}

/** The bounded output a failure left: stderr, else stdout, else the error message. */
export function failureDetail(error: unknown, opts: FailureTailOptions = {}): string {
  if (error && typeof error === 'object') {
    for (const stream of ['stderr', 'stdout'] as const) {
      const text = stream in error ? (error as Record<string, unknown>)[stream] : undefined;
      if (typeof text !== 'string') continue;
      const tail = formatFailureTail(text, opts);
      if (tail !== '') return tail;
    }
  }
  return formatFailureTail(toErrorMessage(error), opts);
}

/**
 * The job error for a failed init: `init[<n>] failed (exit <code>): <detail>`,
 * or `init[<n>] <reason>: <detail>` for a timeout. The detail is cut so the
 * whole message stays within {@link FAILURE_TAIL_MAX_CHARS}, the way
 * {@link formatFailureTail} cuts (several lines keep their end, one line keeps
 * its start), and the job-runner bound then leaves it unchanged.
 */
export function formatInitFailureMessage(f: {
  index: number;
  detail: string;
  exitCode?: number;
  reason?: TimeoutReason;
}): string {
  const head =
    f.reason !== undefined
      ? `init[${f.index}] ${f.reason}`
      : f.exitCode !== undefined
        ? `init[${f.index}] failed (exit ${f.exitCode})`
        : `init[${f.index}] failed`;
  if (f.detail === '') return head;
  const budget = FAILURE_TAIL_MAX_CHARS - head.length - 2;
  const detail = f.detail.includes('\n')
    ? truncateReasonTextKeepEnd(f.detail, budget)
    : truncateReasonText(f.detail, budget);
  return `${head}: ${detail}`;
}

/**
 * A job status payload with its failure text bounded: `error` and
 * `initFailure.message` go through {@link formatFailureTail}. Every other field
 * is kept as it is. Text that is already bounded passes through unchanged.
 */
export function boundJobFailureData(data: Record<string, unknown>): Record<string, unknown> {
  const bounded = { ...data };
  if (typeof bounded.error === 'string') bounded.error = formatFailureTail(bounded.error);
  const initFailure = bounded.initFailure;
  if (
    initFailure !== null &&
    typeof initFailure === 'object' &&
    typeof (initFailure as { message?: unknown }).message === 'string'
  ) {
    bounded.initFailure = {
      ...initFailure,
      message: formatFailureTail((initFailure as { message: string }).message),
    };
  }
  return bounded;
}
