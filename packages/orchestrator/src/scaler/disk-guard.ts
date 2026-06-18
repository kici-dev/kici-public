/**
 * Startup disk-space guard for Firecracker nodes.
 *
 * When the data disk hits 100%, the orchestrator can no longer write its
 * log/DB files and crash-loops on ENOSPC at startup — so the in-process orphan
 * sweep that would free space never runs (bootstrap deadlock). This guard runs
 * BEFORE the heavy startup writes: if free space on the chroot volume is below
 * a threshold, it reaps orphan FC chroots inline (liveness-driven, safe) and
 * lets startup proceed only if enough space was freed. Logs to stderr because
 * the file logger may itself be unable to write.
 */
import { statfs } from 'node:fs/promises';
import { reapFirecrackerOrphans, type ReapCounts } from './reap-orphans.js';
import type { ScalerConfig } from './index.js';

/** Default minimum free space before startup is allowed to proceed: 1 GiB. */
export const DEFAULT_DISK_GUARD_THRESHOLD_BYTES = 1024 * 1024 * 1024;

export interface DiskGuardResult {
  reaped: boolean;
  recovered: boolean;
  freeBytesAfter: number;
}

interface DiskGuardOpts {
  scalerConfig: ScalerConfig;
  thresholdBytes?: number;
  /** Injectable for tests. */
  statfsFn?: (path: string) => Promise<{ bavail: bigint; bsize: number }>;
  reapFn?: (cfg: ScalerConfig) => Promise<ReapCounts>;
}

/** Resolve the FC chroot volume to statfs from the first firecracker scaler. */
function chrootVolume(scalerConfig: ScalerConfig): string | null {
  const fc = scalerConfig.scalers.find((s) => s.type === 'firecracker');
  if (!fc) return null;
  return (fc as { chrootBaseDir?: string }).chrootBaseDir ?? '/srv/jailer';
}

async function freeBytes(
  path: string,
  statfsFn: NonNullable<DiskGuardOpts['statfsFn']>,
): Promise<number> {
  const s = await statfsFn(path);
  return Number(s.bavail) * s.bsize;
}

/**
 * Run the disk guard. Returns reaped/recovered status; the caller decides
 * whether to proceed or exit with backoff. No-ops (recovered=true) when there
 * is no FC scaler or free space is already above threshold.
 */
export async function runDiskGuard(opts: DiskGuardOpts): Promise<DiskGuardResult> {
  const threshold = opts.thresholdBytes ?? DEFAULT_DISK_GUARD_THRESHOLD_BYTES;
  const statfsFn = opts.statfsFn ?? (statfs as unknown as NonNullable<DiskGuardOpts['statfsFn']>);
  const reapFn = opts.reapFn ?? reapFirecrackerOrphans;

  const vol = chrootVolume(opts.scalerConfig);
  if (!vol) return { reaped: false, recovered: true, freeBytesAfter: Number.MAX_SAFE_INTEGER };

  const before = await freeBytes(vol, statfsFn);
  if (before >= threshold) {
    return { reaped: false, recovered: true, freeBytesAfter: before };
  }

  process.stderr.write(
    `[disk-guard] free space ${before}B on ${vol} below threshold ${threshold}B — reaping FC orphans\n`,
  );
  const counts = await reapFn(opts.scalerConfig);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const after = await freeBytes(vol, statfsFn);
  process.stderr.write(`[disk-guard] reaped ${total} FC orphan(s); free space now ${after}B\n`);

  return { reaped: true, recovered: after >= threshold, freeBytesAfter: after };
}
