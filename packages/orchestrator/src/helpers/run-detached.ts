/**
 * Running work that nothing awaits.
 *
 * A promise that nobody awaits and nobody catches becomes an unhandled
 * rejection when it fails, and the orchestrator's shutdown hook treats an
 * unhandled rejection as fatal: one failed query in a timer tick or a message
 * handler would stop the whole process. `runDetached` runs such work and logs
 * its failure instead. ESLint's `no-floating-promises` (with `ignoreVoid:
 * false`) refuses a bare or `void`-ed promise anywhere in this package, so
 * detached work runs through here or carries its own `.catch`.
 */
import { toErrorMessage } from '@kici-dev/shared';

/** The part of a logger that `runDetached` writes a failure to. */
export interface DetachedFailureLogger {
  error(message: string, meta?: Record<string, unknown>): unknown;
}

/**
 * Run `work` without waiting for it. A throw, or a rejection of the promise it
 * returns, is logged at error level as `<task> failed` with `context` and the
 * error message, and goes no further. `context` is read when the failure is
 * logged, so the work may fill it in while it runs.
 */
export function runDetached(
  logger: DetachedFailureLogger,
  task: string,
  work: () => unknown,
  context: Record<string, unknown> = {},
): void {
  const fail = (err: unknown): void => {
    logger.error(`${task} failed`, { ...context, error: toErrorMessage(err) });
  };
  let outcome: unknown;
  try {
    outcome = work();
  } catch (err) {
    fail(err);
    return;
  }
  Promise.resolve(outcome).catch(fail);
}
