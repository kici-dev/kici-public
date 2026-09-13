/** Filesystem case-sensitivity probe for a target output directory. */
import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/**
 * Report whether `dir` lives on a filesystem that ignores case in path lookups.
 *
 * Case sensitivity is a property of the mounted filesystem, not of the platform
 * — a Linux host can mount a case-insensitive volume and macOS can format a
 * case-sensitive one — so it is measured rather than inferred: an empty file is
 * written under a random name and the same name is stat'd upper-cased. The
 * directory is created if it is missing, and the probe file is removed on every
 * path, including a throw.
 *
 * Rejects whenever the probe cannot produce an answer: the probe file cannot be
 * written, or the twin lookup fails for any reason other than the twin's
 * absence. Only `ENOENT` means "case-sensitive" — a permission or I/O error says
 * nothing about case folding, and reporting it as case-sensitive would let a
 * colliding set overwrite itself, so it is surfaced to the caller instead.
 *
 * It is its own module so callers can be tested against both answers with a
 * cross-module spy, rather than against whatever filesystem the test runs on.
 */
export async function isCaseInsensitiveDir(dir: string): Promise<boolean> {
  await mkdir(dir, { recursive: true });
  const probe = `.kici-case-probe-${randomUUID()}`;
  const twin = probe.toUpperCase();
  const probePath = join(dir, probe);
  await writeFile(probePath, '');
  try {
    await stat(join(dir, twin));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false;
    throw err;
  } finally {
    await rm(probePath, { force: true });
  }
}
