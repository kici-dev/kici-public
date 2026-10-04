/**
 * The messages the workflow runner sends when its job lifecycle throws.
 *
 * A fatal error carries whatever the failing phase put in its message: for a
 * failed dependency install that is the installer's stderr, stdout and npm's
 * debug log, which can echo a job secret. The report therefore goes through
 * the job's secret masker, the same as every other runner output. The masker
 * exists once the execute request is received, which is the first point the
 * job's secrets are known; an error thrown before then has no job secret to
 * mask, so the report is sent as it is.
 */

import { ExecutionJobStatus } from '@kici-dev/engine';
import { toErrorMessage } from '@kici-dev/shared';
import type { RunnerToAgentMessage } from './ipc-protocol.js';
import { maskMessageText, type LogMasker } from './log-masker.js';

/** The runner's report of a fatal error, masked when a masker is known. */
export interface FatalReport {
  /** Text for the runner's own stderr (the container log in stdio mode). */
  stderr: string;
  /** The log line, then the terminal `job.complete`, to send to the agent. */
  messages: RunnerToAgentMessage[];
}

/** Build the fatal-error report for `error`, masked by `masker` when given. */
export function buildFatalReport(error: unknown, masker: LogMasker | null): FatalReport {
  const mask = (text: string): string => (masker?.hasSecrets() ? masker.mask(text) : text);
  const message = toErrorMessage(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const stderr =
    `[workflow-runner] Fatal error: ${mask(message)}\n` +
    (stack ? `[workflow-runner] Stack: ${mask(stack)}\n` : '');
  const messages: RunnerToAgentMessage[] = [
    { type: 'log.line', stepIndex: -1, line: `[workflow-runner] [error] Fatal: ${message}` },
    {
      type: 'job.complete',
      status: ExecutionJobStatus.enum.failed,
      stepResults: [],
      error: message,
    },
  ];
  return {
    stderr,
    messages: masker ? messages.map((m) => maskMessageText(m, masker)) : messages,
  };
}
