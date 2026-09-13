/**
 * Disk space diagnostic check.
 *
 * Uses `df` command to check available disk space on the root partition.
 * Thresholds: warn < 1GB, fail < 100MB.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DiagnosticDeps, DiagnosticResult } from '../types.js';
import { toErrorMessage } from '@kici-dev/shared';

const execFileAsync = promisify(execFile);

const WARN_THRESHOLD_BYTES = 1024 * 1024 * 1024; // 1GB
const FAIL_THRESHOLD_BYTES = 100 * 1024 * 1024; // 100MB

export async function checkDiskSpace(_deps: DiagnosticDeps): Promise<DiagnosticResult> {
  const start = Date.now();

  try {
    // Use df to get available space on root partition (POSIX output, 1K blocks)
    const { stdout } = await execFileAsync('df', ['-Pk', '/']);
    const lines = stdout.trim().split('\n');

    if (lines.length < 2) {
      return {
        name: 'Disk space',
        status: 'fail',
        message: 'Unable to parse df output',
        durationMs: Date.now() - start,
      };
    }

    // Parse second line: filesystem 1K-blocks used available capacity mountpoint
    const parts = lines[1].split(/\s+/);
    const availableKb = parseInt(parts[3], 10);
    const availableBytes = availableKb * 1024;
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
