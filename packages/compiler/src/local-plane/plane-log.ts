import fs from 'node:fs';

/**
 * Size at which a local dev plane log is rotated on the next plane start.
 *
 * The plane's orchestrator writes one JSON line per request and per
 * scheduled-job tick, and nothing truncates the file between boots, so an
 * unrotated log grows without bound. 50 MB is roughly 200k lines — more history
 * than a local debugging session reads.
 */
export const PLANE_LOG_MAX_BYTES = 50 * 1024 * 1024;

/** The cap expressed in whole megabytes, for the messages that name it. */
export const PLANE_LOG_MAX_MB = PLANE_LOG_MAX_BYTES / (1024 * 1024);

/**
 * Rotate `file` to `<file>.1` once it reaches `PLANE_LOG_MAX_BYTES`, keeping two
 * generations: any previous `.1` is discarded.
 *
 * Call this only where nothing holds the file open. A rename under a live
 * writer leaves that writer appending to the renamed inode, so the live log
 * would stay empty for the rest of the process's life.
 *
 * Every failure is swallowed on purpose. Both callers are on a plane-boot path:
 * `startPlanePostgres` reads a throw as "embedded Postgres is unavailable" and
 * silently falls back to a Podman container, and `spawnOrchestratorProcess`
 * would fail the boot outright. A log that cannot be rotated must not cost the
 * user their plane.
 */
export function rotatePlaneLogIfOversized(file: string): void {
  try {
    if (fs.statSync(file).size < PLANE_LOG_MAX_BYTES) return;
    fs.rmSync(`${file}.1`, { force: true });
    fs.renameSync(file, `${file}.1`);
  } catch {
    // No log yet, or a path that cannot be renamed — keep booting.
  }
}
