/**
 * Thrown by a LockFileFetcher when a lock file is present at the repo ref but
 * cannot be parsed or validated (empty content, invalid JSON, missing/invalid
 * schemaVersion). Distinct from "not found" (the fetcher returns null) and from
 * transient fetch errors (plain Error). The orchestrator routes this to a
 * `lock_resolution` init-failure run.
 */
export class LockFileParseError extends Error {
  readonly name = 'LockFileParseError';

  constructor(
    readonly repoIdentifier: string,
    readonly ref: string,
    message: string,
  ) {
    super(message);
    // Restore prototype chain for instanceof across the transpile boundary.
    Object.setPrototypeOf(this, LockFileParseError.prototype);
  }
}
