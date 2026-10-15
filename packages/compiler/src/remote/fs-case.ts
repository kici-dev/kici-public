import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/**
 * Whether `dir` is on a filesystem that ignores case in path lookups. That is a
 * property of the mount, not the platform, so it is measured: a random-named
 * empty file is written and its upper-cased twin stat'd. Creates `dir` if
 * missing and always removes the probe file.
 *
 * Rejects when the probe cannot answer. Only `ENOENT` means case-sensitive: a
 * permission or I/O error says nothing about case folding, and reading it as
 * case-sensitive would let a colliding set overwrite itself.
 *
 * Its own module so callers can spy on both answers across modules.
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
