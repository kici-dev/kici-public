/**
 * Disk space check on the root filesystem: warn < 1GB, fail < 100MB.
 *
 * Read with `statfs(2)` in-process, not `df`: the orchestrator image ships no `df`, so a check
 * that spawned it failed on every containerized orchestrator.
 */

import { statfs } from 'node:fs/promises';
import type { DiagnosticDeps, DiagnosticResult } from '../types.js';
import { toErrorMessage } from '@kici-dev/shared';

const WARN_THRESHOLD_BYTES = 1024 * 1024 * 1024; // 1GB
const FAIL_THRESHOLD_BYTES = 100 * 1024 * 1024; // 100MB

/** The bytes an unprivileged process can still write to the filesystem holding `path`. */
export type AvailableBytesReader = (path: string) => Promise<number>;

const readAvailableBytes: AvailableBytesReader = async (path) => {
  const stats = await statfs(path);
  return Number(stats.bavail) * Number(stats.bsize);
};

export async function checkDiskSpace(
  _deps: DiagnosticDeps,
  availableBytesOf: AvailableBytesReader = readAvailableBytes,
): Promise<DiagnosticResult> {
  const start = Date.now();

  try {
    const availableBytes = await availableBytesOf('/');
    const durationMs = Date.now() - start;
    const availableGb = (availableBytes / (1024 * 1024 * 1024)).toFixed(1);

    if (availableBytes < FAIL_THRESHOLD_BYTES) {
      return {
        name: 'Disk space',
        status: 'fail',
        message: `Critically low disk space: ${availableGb}GB available`,
        details: { availableBytes, availableGb },
        durationMs,
      };
    }

    if (availableBytes < WARN_THRESHOLD_BYTES) {
      return {
        name: 'Disk space',
        status: 'warn',
        message: `Low disk space: ${availableGb}GB available`,
        details: { availableBytes, availableGb },
        durationMs,
      };
    }

    return {
      name: 'Disk space',
      status: 'pass',
      message: `${availableGb}GB available`,
      details: { availableBytes, availableGb },
      durationMs,
    };
  } catch (err) {
    return {
      name: 'Disk space',
      status: 'fail',
      message: `Disk check failed: ${toErrorMessage(err)}`,
      durationMs: Date.now() - start,
    };
  }
}
