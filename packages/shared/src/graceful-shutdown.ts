import { flushLogFiles, toErrorMessage } from '@kici-dev/core';

/**
 * How long an exit waits for the log files to take their last lines. The
 * forced path adds it to the shutdown ceiling, inside the init system's stop
 * grace (`shutdown-grace.ts` in the orchestrator's service CLI).
 */
const LOG_FLUSH_TIMEOUT_MS = 2_000;

/**
 * Exit once the rotated log files hold every line logged so far. A flush that
 * fails does not keep the process from exiting. The exit code is read after
 * the flush, so a fatal trigger that lands while it runs still raises it.
 */
async function exitAfterLogFlush(code: () => number): Promise<void> {
  await flushLogFiles(LOG_FLUSH_TIMEOUT_MS).catch(() => {});
  process.exit(code());
}

export interface ShutdownStep {
  /** Logged before and after the step runs. */
  name: string;
  /** Steps run sequentially; a step's error is caught and logged, and the next step runs. */
  fn: () => Promise<void> | void;
}

/** Satisfied by Winston, or any logger whose `info` / `warn` / `error` take structured metadata second. */
export interface ShutdownLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface GracefulShutdownOptions {
  logger: ShutdownLogger;
  steps: ShutdownStep[];
  /** Force-exit timeout in ms (default: 30 000). */
  timeoutMs?: number;
  /**
   * Runs when the force-exit timeout fires, for last-resort cleanup (e.g.
   * killing child processes). Returning `true` suppresses the default exit, and
   * the callback must then exit the process itself.
   */
  onForceExit?: () => boolean | void;
  /** `true` skips registering the `uncaughtException` / `unhandledRejection` handlers (default `false`). */
  skipErrorHandlers?: boolean;
}

/** Lets callers trigger shutdown programmatically (e.g. from a SIGUSR1 drain handler). */
export interface ShutdownHandle {
  /**
   * Pass a non-zero `code` for a deliberate-but-failed stop (e.g. a one-shot
   * agent whose self-bootstrap claim was rejected); omit it for a clean stop.
   */
  shutdown(signal: string, code?: number): Promise<void>;
}

/**
 * On SIGTERM / SIGINT (and, unless skipped, uncaughtException /
 * unhandledRejection), run the steps sequentially, then exit.
 *
 * Signal and programmatic shutdowns exit 0 unless the caller passes a code;
 * the fatal triggers exit 1, so `Restart=on-failure` supervisors and exit-code
 * alerting see the cause. Escalation is sticky: a fatal trigger during a clean
 * shutdown still raises the final code to 1.
 *
 * Every exit first waits (up to 2 s) for the rotated log files to take the
 * lines logged so far, then closes them, so after a completed shutdown a file
 * ends with the same line as stdout. On the forced path a file stops at the
 * lines logged when the timer fired, and an `onForceExit` that exits by itself
 * gets no flush.
 *
 * A force-exit timer ends a hung step. It uses the same sticky code, so a slow
 * SIGTERM/SIGINT stop still exits 0: systemd marking the unit `failed` would
 * break `systemctl restart` recovery.
 */
export function setupGracefulShutdown(options: GracefulShutdownOptions): ShutdownHandle {
  const { logger, steps, timeoutMs = 30_000, onForceExit, skipErrorHandlers = false } = options;

  let isShuttingDown = false;
  let exitCode = 0;

  async function gracefulShutdown(signal: string, code = 0): Promise<void> {
    // Raised on EVERY trigger, ignored duplicates included, so a fatal error
    // mid-shutdown still makes the final exit non-zero.
    exitCode = Math.max(exitCode, code);

    if (isShuttingDown) {
      logger.warn('Shutdown already in progress, ignoring signal', { signal });
      return;
    }

    isShuttingDown = true;
    logger.info(`Received ${signal}, starting graceful shutdown...`);

    const forceExitTimeout = setTimeout(() => {
      logger.error(`Graceful shutdown timed out after ${timeoutMs / 1000}s, forcing exit`, {
        exitCode,
      });
      const handled = onForceExit?.();
      if (handled !== true) {
        // The sticky code, not a blanket 1: a slow clean stop must not mark the
        // systemd unit `failed`.
        void exitAfterLogFlush(() => exitCode);
      }
    }, timeoutMs);

    try {
      for (const step of steps) {
        try {
          logger.info(`${step.name}...`);
          await step.fn();
          logger.info(`${step.name} done`);
        } catch (stepError) {
          logger.error(`${step.name} failed`, {
            error: toErrorMessage(stepError),
            stack: stepError instanceof Error ? stepError.stack : undefined,
          });
        }
      }

      clearTimeout(forceExitTimeout);
      logger.info('Graceful shutdown complete', { exitCode });
      await exitAfterLogFlush(() => exitCode);
    } catch (error) {
      logger.error('Error during graceful shutdown', {
        error: toErrorMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      clearTimeout(forceExitTimeout);
      await exitAfterLogFlush(() => Math.max(exitCode, 1));
    }
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  if (!skipErrorHandlers) {
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception', {
        error: error.message,
        stack: error.stack,
      });
      gracefulShutdown('uncaughtException', 1);
    });

    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled rejection', {
        reason: toErrorMessage(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      });
      gracefulShutdown('unhandledRejection', 1);
    });
  }

  // For intentional shutdowns (drain handlers, tests).
  return { shutdown: (signal: string, code = 0) => gracefulShutdown(signal, code) };
}
