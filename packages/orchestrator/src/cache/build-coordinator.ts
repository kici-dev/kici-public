/**
 * Build coordinator for coalescing concurrent build requests.
 *
 * Ensures only one build runs per content hash. Subsequent requests
 * for the same hash coalesce on the same Promise, avoiding duplicate
 * compilation work.
 *
 * On success: all waiters resolve.
 * On failure: all waiters reject with the build error.
 * On timeout: all waiters reject with a timeout error.
 */

import { createLogger } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'build-coordinator' });

export class BuildCoordinator {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 600_000; // 10 min default
  }

  /**
   * Ensure a build is running for the given content hash.
   *
   * If already in-flight, returns the existing promise (coalescing).
   * If not, calls triggerBuild() and tracks the promise.
   *
   * @param contentHash - The content hash identifying the bundle to build
   * @param triggerBuild - Async function that performs the actual build
   */
  ensureBuild(contentHash: string, triggerBuild: () => Promise<void>): Promise<void> {
    // Coalesce: if a build is already in-flight, wait on it
    const existing = this.inFlight.get(contentHash);
    if (existing) {
      logger.debug(`ensureBuild(${contentHash}): coalescing on existing build`);
      return existing;
    }

    logger.info(`ensureBuild(${contentHash}): starting new build`);

    // Create a build promise with timeout
    const buildPromise = this.runWithTimeout(contentHash, triggerBuild);

    // Track in inFlight map
    this.inFlight.set(contentHash, buildPromise);

    // Ensure cleanup on completion (success or failure)
    // Use a separate .then/.catch so the returned promise isn't affected
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

  /**
   * Check if a build is currently in-flight for a content hash.
   */
  isBuilding(contentHash: string): boolean {
    return this.inFlight.has(contentHash);
  }

  /**
   * Get the number of in-flight builds (for metrics/debugging).
   */
  getInFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Run triggerBuild with a timeout. Rejects with a descriptive
   * error if the build exceeds timeoutMs.
   */
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
