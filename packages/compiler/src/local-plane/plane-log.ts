import fs from 'node:fs';

/**
 * Rotation threshold, checked at plane start. The orchestrator writes a line per
 * request and per scheduled tick and nothing truncates between boots. 50 MB is
 * roughly 200k lines, more than a local debugging session reads.
 */
export const PLANE_LOG_MAX_BYTES = 50 * 1024 * 1024;

/** For messages that name the cap. */
export const PLANE_LOG_MAX_MB = PLANE_LOG_MAX_BYTES / (1024 * 1024);

/**
 * Rotate `file` to `<file>.1` at `PLANE_LOG_MAX_BYTES`, discarding any previous `.1`.
 *
 * Call it only where nothing holds the file open: a live writer would keep
 * appending to the renamed inode, leaving the live log empty.
 *
 * Failures are swallowed on purpose: `startPlanePostgres` would read a throw as
 * "embedded Postgres unavailable" and fall back to Podman, and
 * `spawnOrchestratorProcess` would fail the boot. An unrotatable log must not
 * cost the user their plane.
 */
export function rotatePlaneLogIfOversized(file: string): void {
  try {
    if (fs.statSync(file).size < PLANE_LOG_MAX_BYTES) return;
    fs.rmSync(`${file}.1`, { force: true });
    fs.renameSync(file, `${file}.1`);
  } catch {
    // No log yet, or not renamable: keep booting.
  }
}
