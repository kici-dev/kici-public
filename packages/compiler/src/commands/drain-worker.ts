/**
 * kici admin drain-worker command
 *
 * Sends POST /drain to a worker instance to trigger graceful drain.
 * Part of the three drain mechanisms: SIGTERM, POST /drain, admin CLI.
 */

import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';

/** Options for the drain-worker command */
export interface DrainWorkerOptions {
  /** Worker URL (e.g., http://worker-host:<port>) */
  url: string;
}

/**
 * Send a drain request to a worker instance.
 *
 * @param options - Drain worker options
 * @returns true on success, false on error
 */
export async function drainWorkerCommand(options: DrainWorkerOptions): Promise<boolean> {
  const { url } = options;

  if (!url) {
    logger.error(
      pc.red('--url is required. Specify the worker URL (e.g., http://worker-host:<port>).'),
    );
    return false;
  }

  try {
    const drainUrl = `${url.replace(/\/$/, '')}/drain`;
    const response = await fetch(drainUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      logger.error(pc.red(`Drain request failed: ${response.status} ${response.statusText}`));
      return false;
    }

    const data = (await response.json()) as { draining: boolean; activeJobs: number };
    logger.info(pc.green(`Worker draining. Active jobs: ${data.activeJobs}`));
    return true;
  } catch (error) {
    const message = toErrorMessage(error);
    logger.error(pc.red(`Failed to connect to worker at ${url}: ${message}`));
    return false;
  }
}
