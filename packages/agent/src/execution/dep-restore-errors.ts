/**
 * Errors a dependency restore rejects with. Each carries the report of the
 * restore that failed, so a caller can log it without re-deriving anything.
 *
 * Kept apart from `dep-restore.ts` so a test that mocks the restore still gets
 * the real classes, and `instanceof` keeps meaning the same thing.
 */

import type { DepRestoreReport } from './dep-restore-report.js';

export class DepRestoreError extends Error {
  readonly report: DepRestoreReport;
  constructor(message: string, report: DepRestoreReport, cause?: unknown) {
    super(message, { cause });
    this.name = 'DepRestoreError';
    this.report = report;
  }
}

/**
 * The tarball's SHA-256 is not the one the orchestrator dispatched. Terminal:
 * the key is content-addressed, so a second download reads the same bytes, and
 * every job kind fails rather than installing over a corrupted cache entry.
 */
export class DepTarballHashMismatchError extends DepRestoreError {
  constructor(expected: string, actual: string, report: DepRestoreReport) {
    super(`Dep tarball hash mismatch: expected ${expected}, got ${actual}`, report);
    this.name = 'DepTarballHashMismatchError';
  }
}
