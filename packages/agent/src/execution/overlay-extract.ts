/**
 * Extracts an overlay tarball for the applier, and reads the agent's own
 * metadata back out of it.
 *
 * node-tar refuses a symlink entry whose target path passes through a symlink
 * it already extracted, so a chain of file links (`L -> M`, `M -> t`) would lose
 * `L` whenever `M` comes first in the tarball. Symlink entries are therefore set
 * aside during extraction and created afterwards, in tarball order. A later
 * entry of any other type at the same path drops the set-aside link, so the
 * last entry at a path wins, as in tar.
 *
 * Every symlink the extraction holds afterwards satisfies all of these:
 * - Its path is relative, has no `..` part, and every directory above it is a
 *   real directory, so no link is written through another link.
 * - Its text is relative and, resolved lexically from the link's directory,
 *   stays inside the root. This is node-tar's link-text rule, except that an
 *   absolute text is refused instead of made relative.
 * - Once every link is placed, it resolves on disk to a path inside the root.
 *   A link that escapes through another link (`b -> .`, `a -> b/../x`), dangles
 *   or loops is removed.
 *
 * Checksummed content is read through the applier's `resolveExtractedSource`,
 * which follows a link only to a regular file inside the root. The agent's own
 * metadata is read with `readExtractedRegularFile`, which follows no link.
 */

import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { x as tarExtract } from 'tar';

interface LinkEntry {
  parts: string[];
  linkpath: string;
}

/** A link the extraction created: its absolute path, and its entry path for reports. */
interface PlacedLink {
  dest: string;
  where: string;
}

/** A symlink entry the extraction did not create, and why. */
export interface SkippedLink {
  path: string;
  reason: string;
}

/**
 * Why `key` is missing from the extraction: each skipped link entry at it or
 * at a directory above it, or undefined when no skipped link explains it.
 */
export function skippedLinkNote(skipped: readonly SkippedLink[], key: string): string | undefined {
  const notes = skipped
    .filter((s) => s.path === key || key.startsWith(`${s.path}/`))
    .map((s) => `symlink entry ${s.path} not extracted: ${s.reason}`);
  return notes.length > 0 ? notes.join('; ') : undefined;
}

/** The result of reading one extracted file for the agent itself. */
export type ExtractedRead = { data: Buffer } | { missing: true } | { refused: string };

enum DirWalk {
  Real = 'real',
  Missing = 'missing',
  NotDirectory = 'not-directory',
}

/** Split a tar path; `\` is a separator only on Windows, as node-tar reads it. */
function splitTarPath(p: string): string[] {
  return (process.platform === 'win32' ? p.replace(/\\/g, '/') : p).split('/');
}

/** True when node-tar finds a root to strip: `/x`, `\x`, `C:x`, `//host/share/x`. */
function hasRoot(p: string): boolean {
  return path.win32.isAbsolute(p) || path.win32.parse(p).root !== '';
}

/** The entry path as safe relative parts, or undefined for a rooted, `..` or empty path. */
function safeParts(entryPath: string): string[] | undefined {
  if (hasRoot(entryPath)) return undefined;
  // node-tar reads `\` as a separator for its `..` test on every platform.
  if (entryPath.replace(/\\/g, '/').split('/').includes('..')) return undefined;
  const parts = splitTarPath(entryPath).filter((p) => p !== '' && p !== '.');
  return parts.length === 0 ? undefined : parts;
}

/** Why the link text `text` of a link at `parts` is refused, or undefined when it is accepted. */
function linkTextRefusal(parts: readonly string[], text: string): string | undefined {
  if (text === '' || text.includes('\0')) return 'the link text is empty or holds a NUL';
  if (hasRoot(text)) return 'the link text is absolute';
  // node-tar reads `\` as a separator here on every platform; on POSIX that refuses more.
  const resolved = path.posix.normalize(
    path.posix.join(...parts.slice(0, -1), text.replace(/\\/g, '/')),
  );
  if (resolved === '..' || resolved.startsWith('../')) {
    return 'the link text leaves the extraction directory';
  }
  return undefined;
}

/** Walk `dirs` beneath `root`, each a real directory; with `create`, a missing one is created. */
async function walkRealDirs(
  root: string,
  dirs: readonly string[],
  create: boolean,
): Promise<DirWalk> {
  let current = root;
  for (const part of dirs) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(() => undefined);
    if (!stat) {
      if (!create) return DirWalk.Missing;
      await fs.mkdir(current);
    } else if (!stat.isDirectory()) {
      return DirWalk.NotDirectory;
    }
  }
  return DirWalk.Real;
}

/** Create each set-aside link where its entry names, replacing a link or file but never a directory. */
async function placeLinks(
  root: string,
  links: Iterable<LinkEntry>,
  skipped: SkippedLink[],
): Promise<Array<PlacedLink>> {
  const placed: Array<PlacedLink> = [];
  for (const { parts, linkpath } of links) {
    const where = parts.join('/');
    // fails-when: an absolute link text, or one climbing out of the root, is written as given
    // breaks-if-wrong: an in-root relative text such as `../docs/b.yaml` is still placed
    const refusal = linkTextRefusal(parts, linkpath);
    if (refusal) {
      skipped.push({ path: where, reason: refusal });
      continue;
    }
    // fails-when: a link entry beneath another link entry is written through it
    if ((await walkRealDirs(root, parts.slice(0, -1), true)) !== DirWalk.Real) {
      skipped.push({ path: where, reason: 'a directory above it is a symlink or a file' });
      continue;
    }
    const dest = path.join(root, ...parts);
    const existing = await fs.lstat(dest).catch(() => undefined);
    if (existing?.isDirectory()) {
      skipped.push({ path: where, reason: 'a directory is at its path' });
      continue;
    }
    if (existing) await fs.unlink(dest);
    await fs.symlink(linkpath, dest);
    placed.push({ dest, where });
  }
  return placed;
}

/**
 * Remove every placed link that does not resolve to a path inside the root.
 * A removal only makes other resolutions fail, so the pass repeats until it
 * removes nothing and every remaining link resolves inside the root.
 */
async function dropUnconfined(
  root: string,
  placed: ReadonlyArray<PlacedLink>,
  skipped: SkippedLink[],
): Promise<void> {
  const realRoot = await fs.realpath(root);
  let remaining = placed;
  for (;;) {
    const kept: Array<PlacedLink> = [];
    for (const link of remaining) {
      const real = await fs.realpath(link.dest).catch(() => undefined);
      // fails-when: a link that is lexically inside but escapes through another link is kept
      // breaks-if-wrong: a chain of in-root links through a directory link still resolves and stays
      if (real === realRoot || real?.startsWith(realRoot + path.sep)) {
        kept.push(link);
        continue;
      }
      await fs.unlink(link.dest);
      skipped.push({
        path: link.where,
        reason:
          real === undefined
            ? 'its target was not shipped in the overlay'
            : 'the link resolves outside the extraction directory',
      });
    }
    if (kept.length === remaining.length) return;
    remaining = kept;
  }
}

/**
 * Extract `data` (a gzipped tarball) into `extractDir`. Returns the symlink
 * entries it did not create, for the caller to report.
 */
export async function extractOverlay(
  data: Buffer,
  extractDir: string,
): Promise<{ skippedLinks: SkippedLink[] }> {
  // Keyed by the normalized path; a re-insert moves an entry to the end, so
  // iteration order is the tarball order of each path's last link entry.
  const links = new Map<string, LinkEntry>();
  const skippedLinks: SkippedLink[] = [];
  await new Promise<void>((resolve, reject) => {
    Readable.from(data)
      .pipe(
        tarExtract({
          cwd: extractDir,
          gzip: true,
          filter: (entryPath, entry) => {
            const parts = safeParts(entryPath);
            const key = parts?.join('/');
            if (key !== undefined) links.delete(key);
            if (!('type' in entry) || entry.type !== 'SymbolicLink') return true;
            if (parts && key !== undefined) {
              links.set(key, { parts, linkpath: String(entry.linkpath ?? '') });
            } else {
              skippedLinks.push({
                path: entryPath,
                reason: 'the entry path is not a safe relative path',
              });
            }
            return false;
          },
        }),
      )
      .on('finish', resolve)
      .on('error', reject);
  });
  const placed = await placeLinks(extractDir, links.values(), skippedLinks);
  await dropUnconfined(extractDir, placed, skippedLinks);
  return { skippedLinks };
}

/**
 * Read `parts` beneath `root` as a regular file, following no symlink: every
 * directory on the way must be a real directory and the file itself a regular
 * file. For metadata the agent reads for itself, never for checksummed content.
 */
export async function readExtractedRegularFile(
  root: string,
  parts: readonly string[],
): Promise<ExtractedRead> {
  // fails-when: a symlinked directory above the file is followed out of the root
  const walk = await walkRealDirs(root, parts.slice(0, -1), false);
  if (walk === DirWalk.Missing) return { missing: true };
  if (walk === DirWalk.NotDirectory)
    return { refused: 'a directory above it is a symlink or a file' };
  const file = path.join(root, ...parts);
  const stat = await fs.lstat(file).catch(() => undefined);
  if (!stat) return { missing: true };
  // fails-when: a symlink, a FIFO or a device at the path is opened and read
  // breaks-if-wrong: a regular file at the path is still read
  if (!stat.isFile()) {
    return { refused: stat.isSymbolicLink() ? 'it is a symlink' : 'it is not a regular file' };
  }
  // O_NOFOLLOW and the fstat below hold even if the path changed after the
  // lstat; O_NONBLOCK keeps an open of a FIFO from waiting for a writer.
  const flags =
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, flags);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') return { refused: 'it is a symlink' };
    throw err;
  }
  try {
    if (!(await handle.stat()).isFile()) return { refused: 'it is not a regular file' };
    return { data: await handle.readFile() };
  } finally {
    await handle.close();
  }
}
