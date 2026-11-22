/**
 * File symlinks an overlay recreates in the repository.
 *
 * The uploader ships a tracked file symlink as a link entry whose checksum
 * covers its target, and the applier first writes a copy of that verified
 * target at the link's path. Once every file and directory symlink is in
 * place, each copy becomes a link with its shipped text again, so the
 * workspace holds a link where the developer's repository does.
 *
 * Two guarantees hold for the final workspace, with every recreated link in
 * place:
 *
 * - Confinement: no recreated link resolves outside the repository at any
 *   step, through any chain of other recreated links. Each text is walked
 *   with every other accepted link pending, and a refusal can change what
 *   the others resolve through, so the check repeats until nothing changes.
 * - Integrity: each link resolves to the in-repository file the overlay
 *   copied from the verified target, so it reads the bytes the checksum
 *   covered. After the links exist, each one's real path is compared with
 *   that file; a mismatch turns the link back into the copy.
 *
 * A link that fails either check stays a copy of its verified target.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { linkRefusal } from './overlay-symlinks.js';

const logger = createLogger({ prefix: 'overlay-file-links' });

/** A copied file symlink: where it is written, its shipped text and its verified target. */
export interface FileLinkCandidate {
  key: string;
  /** Real path of the copy in the repository. */
  dest: string;
  /** The verified target file inside the extraction, which the copy was taken from. */
  src: string;
  text: string;
  /** Real repo-relative path of the verified target, as the extraction resolved it. */
  target: string;
}

/**
 * The candidates whose text stays inside the repository with every other
 * accepted candidate present as a link. Refusing one changes what the others
 * resolve through, so the walk repeats until the accepted set is stable.
 */
export async function confineFileLinks(
  candidates: readonly FileLinkCandidate[],
  realRoot: string,
): Promise<FileLinkCandidate[]> {
  let accepted = [...candidates];
  for (;;) {
    const pending = new Map(accepted.map((c) => [path.relative(realRoot, c.dest), c.text]));
    const view = { realRoot, deleted: new Set<string>(), pending };
    const next: FileLinkCandidate[] = [];
    for (const candidate of accepted) {
      // fails-when: `a -> ../../b/../x` escapes only through the link `b -> .` the same overlay creates
      // breaks-if-wrong: an in-repository link to an in-repository file is still accepted
      const refused = await linkRefusal(candidate.dest, candidate.text, view);
      if (refused) keptAsCopy(candidate, refused);
      else next.push(candidate);
    }
    if (next.length === accepted.length) return next;
    accepted = next;
  }
}

function keptAsCopy(candidate: FileLinkCandidate, reason: string): void {
  logger.debug('File symlink kept as a copy of its target', { file: candidate.key, reason });
}

/**
 * Put what `make` writes at a temporary sibling of `dest` in place of `dest`.
 * `rename` replaces `dest` without following it.
 *
 * @returns false, with `dest` untouched, when `make` or the rename fails
 */
async function replaceWith(dest: string, make: (tmp: string) => Promise<void>): Promise<boolean> {
  const tmp = `${dest}.kici-link-${process.pid}`;
  let created = false;
  try {
    await make(tmp);
    created = true;
    await fs.rename(tmp, dest);
    return true;
  } catch (err) {
    if (created) await fs.unlink(tmp).catch(() => {});
    logger.debug('Overlay file symlink left as it was', { dest, reason: toErrorMessage(err) });
    return false;
  }
}

/**
 * Recreate each confined candidate as a link, then turn back into the copy
 * every link whose real path is not its verified target. Turning one back can
 * break a link that resolved through it, so the check repeats until stable.
 *
 * @param copied the extracted source of every file the overlay wrote, by its real path
 * @returns the number of links left in place
 */
export async function relinkFileSymlinks(
  candidates: readonly FileLinkCandidate[],
  realRoot: string,
  copied: ReadonlyMap<string, string>,
): Promise<number> {
  // The repository file at the link's target must be the one the overlay
  // wrote from this link's own verified source: another copy landing there
  // (through a clone symlink on its path) holds bytes this checksum never covered.
  const readsOwnSource = (candidate: FileLinkCandidate, real: string | undefined): boolean =>
    real === path.join(realRoot, candidate.target) && copied.get(real) === candidate.src;
  const confined = await confineFileLinks(candidates, realRoot);
  const linked: FileLinkCandidate[] = [];
  for (const candidate of confined) {
    // fails-when: only "some copy was written at the target" is checked, not that it came from this link's source
    if (!readsOwnSource(candidate, path.join(realRoot, candidate.target))) {
      keptAsCopy(candidate, 'its target is not the file this overlay wrote from its source');
      continue;
    }
    if (await replaceWith(candidate.dest, (tmp) => fs.symlink(candidate.text, tmp, 'file'))) {
      linked.push(candidate);
    }
  }

  let live = linked;
  for (;;) {
    const kept: FileLinkCandidate[] = [];
    for (const candidate of live) {
      const real = await fs.realpath(candidate.dest).catch(() => undefined);
      // fails-when: a link resolves to another file than the verified target its checksum covered
      if (readsOwnSource(candidate, real)) {
        kept.push(candidate);
        continue;
      }
      keptAsCopy(candidate, 'it does not resolve to its verified target');
      if (!(await replaceWith(candidate.dest, (tmp) => fs.copyFile(candidate.src, tmp)))) {
        throw new Error(
          `Overlay could not turn the symlink ${JSON.stringify(candidate.key)} back into a copy`,
        );
      }
    }
    if (kept.length === live.length) return kept.length;
    live = kept;
  }
}
