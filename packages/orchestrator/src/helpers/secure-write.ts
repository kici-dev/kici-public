/**
 * Writing a credential file without ever exposing it.
 *
 * `writeFile(path, content, { mode })` applies the mode only when it *creates*
 * the file: writing over a destination that already sits at 0644 leaves the
 * secret world-readable for as long as it takes the following `chmod` to run.
 * `copyFile` is worse — it reproduces the source file's mode, so a 0644 source
 * yields a 0644 destination.
 *
 * These helpers write a sibling temporary file at the target mode and rename it
 * over the destination. `rename(2)` is atomic within a directory and carries
 * the temporary file's mode with it, so the destination never exists with
 * permissions looser than the content requires — not for a window, not at all.
 *
 * A mode is only ever narrowed by the process umask, so the created file is at
 * most as permissive as `mode`; the explicit `chmod` on the temporary file then
 * restores exactly `mode` under an unusually restrictive umask.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { chmod, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Sibling path a secure write stages through, in the destination's directory. */
function tempPathFor(filePath: string): string {
  const suffix = randomBytes(6).toString('hex');
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${suffix}.tmp`);
}

/**
 * Write `content` to `filePath` at `mode`, atomically and never more permissive.
 *
 * `wx` refuses a pre-existing temporary path, so a planted file or symlink at
 * the staging name is an error rather than a write through it.
 */
export function writeFileSecurelySync(filePath: string, content: string, mode: number): void {
  const tmp = tempPathFor(filePath);
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode, flag: 'wx' });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Promise-returning {@link writeFileSecurelySync}. */
export async function writeFileSecurely(
  filePath: string,
  content: string,
  mode: number,
): Promise<void> {
  const tmp = tempPathFor(filePath);
  try {
    await writeFile(tmp, content, { encoding: 'utf-8', mode, flag: 'wx' });
    await chmod(tmp, mode);
    await rename(tmp, filePath);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Copy `sourcePath` to `filePath` at `mode`, never inheriting the source's.
 *
 * Reads the source into memory: an env file is a handful of lines, and the
 * alternative (copy then chmod) is the window this module exists to close.
 */
export function copyFileSecurelySync(sourcePath: string, filePath: string, mode: number): void {
  writeFileSecurelySync(filePath, fs.readFileSync(sourcePath, 'utf-8'), mode);
}
