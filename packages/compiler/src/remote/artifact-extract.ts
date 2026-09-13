/**
 * CLI-side artifact extraction.
 *
 * Artifact tarballs are packed by the cache packer, so entries are anchored as
 * `__repo__/<rel>` (repo-root-relative) and `__home__/<rel>` (home-relative).
 * The in-workflow extractor restores those groups to the real repo root / home
 * dir; a CLI must NOT — that would scatter files across the user's filesystem.
 * This helper lands everything under a single destination dir instead:
 *
 *   `__repo__/<rel>` -> `<destDir>/<rel>`
 *   `__home__/<rel>` -> `<destDir>/~home/<rel>`  (kept separate so a
 *                       home-anchored file cannot clobber a repo-anchored one)
 *
 * Extraction goes through a scratch dir first and only relocates on success, so
 * a failed extraction never leaves a half-written output directory.
 */
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { cp, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { x as tarExtract } from 'tar';
import { makeTempDir } from '@kici-dev/core/tmp';
import { REPO_ANCHOR, HOME_ANCHOR } from '@kici-dev/core';

/** Sub-directory of the destination that home-anchored entries land under. */
export const HOME_SUBDIR = '~home';

/**
 * Extract an artifact tarball under `destDir`, relocating the anchor groups so
 * nothing escapes the destination.
 */
export async function extractArtifactTarball(tarball: Buffer, destDir: string): Promise<void> {
  const scratch = await makeTempDir('artifact-extract');
  try {
    await pipeline(Readable.from(tarball), tarExtract({ cwd: scratch.path, gzip: true }));
    await mkdir(destDir, { recursive: true });
    for (const top of await readdir(scratch.path)) {
      const from = join(scratch.path, top);
      if (top === REPO_ANCHOR) {
        await relocateGroup(from, destDir);
      } else if (top === HOME_ANCHOR) {
        await relocateGroup(from, join(destDir, HOME_SUBDIR));
      } else {
        // Unanchored top-level entry (defensive): keep it verbatim.
        await cp(from, join(destDir, top), { recursive: true });
      }
    }
  } finally {
    await scratch.cleanup();
  }
}

/** Copy the contents of an anchor group dir into `into`, merging trees. */
async function relocateGroup(groupDir: string, into: string): Promise<void> {
  await mkdir(into, { recursive: true });
  for (const entry of await readdir(groupDir)) {
    await cp(join(groupDir, entry), join(into, entry), { recursive: true });
  }
}
