/**
 * Age-based garbage collection for KiCI-owned temp directories.
 *
 * Work directories under the temp root normally remove themselves (job
 * runners clean up in `finally`), but two paths legitimately outlive their
 * creator: `kici run local` checkouts retained for inspection after a failed
 * run, and any workdir whose process died hard (SIGKILL, OOM) before its
 * cleanup ran. Without a collector they accumulate node_modules-sized trees
 * until the temp filesystem runs out of inodes. Callers invoke this at a
 * natural moment (next run, process startup) with a pattern matching ONLY
 * the directory family they own.
 *
 * Node-API module (filesystem): exported via the `@kici-dev/core/tmp-gc`
 * subpath, NOT the package barrel, so browser consumers of the barrel never
 * pull in `node:fs`.
 */

import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export interface GcStaleTmpDirsOptions {
  /** Directory whose immediate children are candidates (non-recursive). */
  base: string;
  /** Basename pattern; only matching child DIRECTORIES are eligible. */
  pattern: RegExp;
  /** Children with mtime older than this are removed. */
  maxAgeMs: number;
  /** Optional per-removal / per-failure logger. */
  log?: (message: string) => void;
}

/**
 * Remove stale matching directories under `base`. Never throws: a missing
 * base is a no-op and per-directory failures are logged and skipped — GC
 * must never break the caller's actual work. Returns the removed paths.
 */
export async function gcStaleTmpDirs(opts: GcStaleTmpDirsOptions): Promise<string[]> {
  const { base, pattern, maxAgeMs, log } = opts;
  const cutoff = Date.now() - maxAgeMs;
  const removed: string[] = [];
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return removed; // missing or unreadable base — nothing to collect
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !pattern.test(entry.name)) continue;
    const dir = path.join(base, entry.name);
    try {
      const s = await stat(dir);
      if (s.mtimeMs >= cutoff) continue;
      await rm(dir, { recursive: true, force: true });
      removed.push(dir);
      log?.(`removed stale temp dir ${dir}`);
    } catch (e) {
      log?.(`failed to gc ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return removed;
}
