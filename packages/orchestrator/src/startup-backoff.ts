/**
 * Backoff-before-exit for deterministic fatal startup errors.
 *
 * When the orchestrator detects a config error that will fail identically on an
 * immediate restart (required-tools validation, label-set overlaps), exiting
 * straight away lets the service supervisor (launchd KeepAlive, systemd
 * Restart=on-failure) respawn at ~1 Hz, flooding logs. Sleeping first throttles
 * the loop at the source on every platform.
 */

import { logger } from '@kici-dev/shared';

/** Default sleep before exiting on a fatal startup error. */
export const STARTUP_BACKOFF_MS = 30_000;

export interface StartupBackoffDeps {
  /** Sleep duration in ms (defaults to {@link STARTUP_BACKOFF_MS}). */
  backoffMs?: number;
  /** Sleep implementation (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Exit implementation (injectable for tests). */
  exit?: (code: number) => never;
}

/**
 * Log the error, sleep the backoff, then exit(1). Never returns.
 */
export async function exitWithStartupBackoff(
  message: string,
  deps: StartupBackoffDeps = {},
): Promise<never> {
  const backoffMs = deps.backoffMs ?? STARTUP_BACKOFF_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  logger.error(
    `Fatal startup error — sleeping ${backoffMs}ms before exit to avoid a tight crash loop`,
    { message },
  );
  await sleep(backoffMs);
  return exit(1);
}
