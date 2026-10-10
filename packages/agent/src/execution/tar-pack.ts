/**
 * The gzip tarball both cache packers upload: the dependency closure
 * (`dep-packer.ts`) and the `.kici/` source (`source-packer.ts`).
 */

import { c as tarCreate } from 'tar';
import { singleLinkTarCaches } from '@kici-dev/core/tar-single-link';
import { sha256 } from '@kici-dev/shared';

/**
 * Pack `entries` (relative to `cwd`) into an in-memory gzip tarball and return
 * it with its SHA-256.
 *
 * - `portable` strips the system-specific metadata (uid/gid/uname/gname, dev,
 *   ino, nlink, atime/ctime). It keeps each entry's mtime, so two packs of the
 *   same content made at different times differ byte for byte.
 * - Symbolic links stay links (node-tar's default `follow: false`), so a pnpm
 *   link graph restores intact.
 * - A hard-linked file packs as a regular file with its own content (the
 *   single-link caches), so node-tar never stalls on a pnpm tree.
 * - `filter` receives node-tar's entry path; the walk skips a directory it
 *   rejects.
 */
export async function packGzipTarball(
  cwd: string,
  entries: string[],
  filter?: (entryPath: string) => boolean,
): Promise<{ tarball: Buffer; hash: string }> {
  const stream = tarCreate(
    {
      gzip: true,
      cwd,
      portable: true,
      ...(filter ? { filter } : {}),
      ...(await singleLinkTarCaches(cwd, entries, { filter })),
    },
    entries,
  );
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  const tarball = Buffer.concat(chunks);
  return { tarball, hash: sha256(tarball) };
}
