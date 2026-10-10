/**
 * Stat and readdir caches that make node-tar pack hard-linked files as plain
 * files.
 *
 * node-tar (7.5.22 and every release before a fix for isaacs/node-tar#460)
 * defers each file whose link count is above 1 until another entry for the
 * same inode is written. Entries read ahead of the deferred one can then fill
 * every job slot while the deferred entry sits at the head of the queue: no
 * slot frees, no I/O is left, and the pack never ends. `tar.create` returns a
 * stream or promise that never settles, and a process with nothing else
 * pending exits 0 halfway through.
 *
 * pnpm hard-links identical files to each other and to its store, so any
 * `node_modules` it installed can trigger this. Handing node-tar the caches
 * built here sets every link count to 1: each hard-linked path then ships as
 * its own regular file entry (its content repeats in the archive), and the
 * deferral never runs.
 *
 * Node-API module (filesystem): exported via the `@kici-dev/core/tar-single-link`
 * subpath, NOT the package barrel, so browser consumers never pull in `node:fs`.
 */
import { lstat, readdir, type Stats } from 'node:fs';
import path from 'node:path';

/** The node-tar `create` options this module fills; spread them into the call. */
export interface SingleLinkTarCaches {
  statCache: Map<string, Stats>;
  readdirCache: Map<string, string[]>;
}

export interface SingleLinkTarCachesOptions {
  /**
   * The same `filter` passed to node-tar. A directory it rejects is not
   * walked, so a large excluded subtree costs one `lstat`.
   */
  filter?: (entryPath: string, stat: Stats) => boolean;
}

/** Concurrent filesystem calls; libuv runs 4 threads by default. */
const WALK_CONCURRENCY = 16;

/** node-tar's cache key: the absolute path, with `/` separators on Windows. */
function cacheKey(absolute: string): string {
  return process.platform === 'win32' ? absolute.replace(/\\/g, '/') : absolute;
}

/** The path node-tar gives a directory child, built the way its packer builds it. */
function childEntryPath(parent: string, name: string): string {
  const base = parent === './' ? '' : parent.replace(/\/*$/, '/');
  return base + name;
}

interface WalkItem {
  /** The entry path as node-tar reports it to `filter` (relative to `cwd`). */
  entryPath: string;
  absolute: string;
}

/**
 * Walk `paths` under `cwd` the way node-tar does with `follow: false` (the
 * default): `lstat` every entry, never follow a symbolic link, and descend into
 * each directory. Returns node-tar `statCache` and `readdirCache` options with
 * every link count set to 1.
 *
 * Pass the result to `tar.create` beside the same `cwd`, `paths` and `filter`.
 * Do not combine it with `follow: true`, which `stat`s through links. An entry
 * created after the walk is invisible to the pack, because node-tar lists each
 * directory from `readdirCache`; one removed after the walk fails the pack, as
 * it would without the caches.
 */
export async function singleLinkTarCaches(
  cwd: string,
  paths: readonly string[],
  options: SingleLinkTarCachesOptions = {},
): Promise<SingleLinkTarCaches> {
  const statCache = new Map<string, Stats>();
  const readdirCache = new Map<string, string[]>();
  const pending: WalkItem[] = paths.map((p) => ({
    entryPath: p,
    absolute: path.resolve(cwd, p),
  }));

  // Callback fs with a fixed number of calls in flight: on a pnpm tree it walks
  // several times faster than awaiting the promise API per entry.
  await new Promise<void>((resolve, reject) => {
    let active = 0;
    let failed = false;
    const fail = (err: Error): void => {
      failed = true;
      reject(err);
    };
    const settle = (): void => {
      active -= 1;
      pump();
    };
    const visit = ({ entryPath, absolute }: WalkItem): void => {
      const key = cacheKey(absolute);
      if (statCache.has(key)) return settle();
      lstat(absolute, (statErr, stat) => {
        if (failed) return;
        if (statErr) return fail(statErr);
        stat.nlink = 1;
        statCache.set(key, stat);
        if (!stat.isDirectory() || (options.filter && !options.filter(entryPath, stat))) {
          return settle();
        }
        readdir(absolute, (readErr, names) => {
          if (failed) return;
          if (readErr) return fail(readErr);
          readdirCache.set(key, names);
          for (const name of names) {
            pending.push({
              entryPath: childEntryPath(entryPath, name),
              absolute: path.join(absolute, name),
            });
          }
          settle();
        });
      });
    };
    const pump = (): void => {
      if (pending.length === 0 && active === 0) return resolve();
      for (let item = pending.pop(); item; item = pending.pop()) {
        active += 1;
        visit(item);
        if (active >= WALK_CONCURRENCY) return;
      }
    };
    pump();
  });
  return { statCache, readdirCache };
}
