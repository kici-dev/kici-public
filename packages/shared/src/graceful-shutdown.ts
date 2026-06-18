import { toErrorMessage } from '@kici-dev/core';

/**
 * A single teardown step in the graceful shutdown sequence.
 */
export interface ShutdownStep {
  /** Human-readable name logged before/after execution. */
  name: string;
  /** Teardown function. Runs sequentially; errors are caught per-step. */
  fn: () => Promise<void> | void;
}

/**
 * Logger interface accepted by {@link setupGracefulShutdown}.
 * Compatible with Winston and any logger that exposes `info`, `warn`, and `error`
 * with a structured-metadata second argument.
 */
export interface ShutdownLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface GracefulShutdownOptions {
  /** Logger used for all shutdown messages. */
  logger: ShutdownLogger;
  /** Ordered list of teardown steps executed sequentially. */
  steps: ShutdownStep[];
  /** Force-exit timeout in milliseconds (default: 30 000). */
  timeoutMs?: number;
  /**
   * Optional callback invoked when the force-exit timeout fires.
   * If the callback returns `true`, the default `process.exit(1)` is
   * suppressed — the callback is responsible for exiting the process.
   * Use this for last-resort cleanup (e.g., killing child processes
   * and deferring exit to let abort handlers run).
   */
  onForceExit?: () => boolean | void;
  /**
   * If `true`, `uncaughtException` and `unhandledRejection` handlers
   * are NOT registered. Useful when the caller manages those separately.
   * Default: `false` (handlers are registered).
   */
  skipErrorHandlers?: boolean;
}

/**
 * Return value from {@link setupGracefulShutdown} so callers can
 * trigger shutdown programmatically (e.g., from SIGUSR1 drain handlers).
 */
export interface ShutdownHandle {
  /** Trigger shutdown with the given reason string. */
  shutdown(signal: string): Promise<void>;
}

/**
 * Wire up SIGTERM / SIGINT (and optionally uncaughtException /
 * unhandledRejection) handlers that execute the provided teardown
 * steps sequentially, then exit.
 *
 * Exit codes: signal-triggered and programmatic shutdowns exit 0;
 * shutdowns triggered by uncaughtException / unhandledRejection exit 1 so
 * `Restart=on-failure`-style supervisor policies and exit-code alerting
 * see the fatal cause. Escalation is sticky — a fatal trigger arriving
 * while a clean shutdown is already in progress still raises the final
 * exit code to 1.
 *
 * A force-exit timer ensures the process terminates even if a step hangs.
 * The force-exit honors the same sticky exit code as a clean completion: a
 * slow SIGTERM/SIGINT stop that merely overran the grace period still exits 0,
 * so systemd records an intentional stop rather than marking the unit `failed`
 * (which would break `systemctl restart` recovery). Only a fatal trigger
 * (uncaughtException / unhandledRejection) raises the force-exit code to 1.
 */
export function setupGracefulShutdown(options: GracefulShutdownOptions): ShutdownHandle {
  const { logger, steps, timeoutMs = 30_000, onForceExit, skipErrorHandlers = false } = options;

  let isShuttingDown = false;
  let exitCode = 0;

  async function gracefulShutdown(signal: string, code = 0): Promise<void> {
    // Sticky escalation: raised on EVERY trigger — including duplicates that
    // are otherwise ignored — so a fatal error arriving mid-shutdown still
    // turns the final exit non-zero.
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
        // Honor the sticky exitCode (0 for an intentional SIGTERM/SIGINT stop,
        // 1 for a fatal trigger) rather than a blanket 1 — a slow-but-clean
        // stop must not surface to systemd as exit-code FAILURE, which marks
        // the unit `failed` and breaks `systemctl restart` recovery.
        process.exit(exitCode);
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
      process.exit(exitCode);
    } catch (error) {
      logger.error('Error during graceful shutdown', {
        error: toErrorMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      clearTimeout(forceExitTimeout);
      process.exit(1);
    }
  }

  // Signal handlers
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // Uncaught error handlers (unless caller opts out)
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

  // The public handle is for intentional shutdowns (drain handlers, tests) —
  // always the clean exit code.
  return { shutdown: (signal: string) => gracefulShutdown(signal) };
}
