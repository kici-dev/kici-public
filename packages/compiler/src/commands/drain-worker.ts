/**
 * `kici admin drain-worker`: POST /drain to a worker for a graceful drain. The
 * other drain mechanisms are SIGTERM and calling POST /drain directly.
 */

import pc from 'picocolors';
import { logger, toErrorMessage } from '@kici-dev/core';

export interface DrainWorkerOptions {
  /** e.g. http://worker-host:<port> */
  url: string;
}

/** @returns true on success, false on error */
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
