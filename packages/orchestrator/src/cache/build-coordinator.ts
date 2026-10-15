/**
 * Coalesces concurrent build requests: one build per content hash, and later
 * requests for the hash share its Promise. Every waiter resolves on success
 * and rejects with the build error or the timeout error otherwise.
 */

import { createLogger } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'build-coordinator' });

export class BuildCoordinator {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 600_000; // 10 min default
  }

  /** Return the in-flight build for `contentHash`, or start one via triggerBuild. */
  ensureBuild(contentHash: string, triggerBuild: () => Promise<void>): Promise<void> {
    const existing = this.inFlight.get(contentHash);
    if (existing) {
      logger.debug(`ensureBuild(${contentHash}): coalescing on existing build`);
      return existing;
    }

    logger.info(`ensureBuild(${contentHash}): starting new build`);

    const buildPromise = this.runWithTimeout(contentHash, triggerBuild);

    this.inFlight.set(contentHash, buildPromise);

    // A separate .then so the returned promise is unaffected by the cleanup.
    buildPromise.then(
      () => {
        this.inFlight.delete(contentHash);
        logger.info(`ensureBuild(${contentHash}): build complete`);
      },
      () => {
        this.inFlight.delete(contentHash);
        logger.warn(`ensureBuild(${contentHash}): build failed`);
      },
    );

    return buildPromise;
  }

  isBuilding(contentHash: string): boolean {
    return this.inFlight.has(contentHash);
  }

  /** For metrics / debugging. */
  getInFlightCount(): number {
    return this.inFlight.size;
  }

  private runWithTimeout(contentHash: string, triggerBuild: () => Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Build timeout for content hash ${contentHash}: exceeded ${this.timeoutMs}ms`,
            ),
          ),
        this.timeoutMs,
      );
    });
    return Promise.race([triggerBuild(), timeout]).finally(() => clearTimeout(timer));
  }
}
