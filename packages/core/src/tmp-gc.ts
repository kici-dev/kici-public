/**
 * Age-based GC for KiCI-owned temp directories. Two kinds outlive their
 * creator's `finally` cleanup: `kici run --local` checkouts kept after a failed
 * run, and workdirs of a process that died hard (SIGKILL, OOM). Uncollected,
 * their node_modules-sized trees exhaust the temp filesystem's inodes. Callers
 * run this at a natural moment (next run, startup) with a pattern matching ONLY
 * the directory family they own.
 *
 * Exported via the `@kici-dev/core/tmp-gc` subpath, NOT the barrel, so browser
 * consumers never pull in `node:fs`.
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
  /**
   * Basenames NEVER removed, so a broad pattern can coexist with persistent
   * caches whose names collide with it.
   */
  exclude?: ReadonlySet<string>;
  /** Per-removal / per-failure logger. */
  log?: (message: string) => void;
}

/**
 * Returns the removed paths. Never throws: GC must never break the caller's
 * work, so a missing base is a no-op and per-directory failures are logged.
 */
export async function gcStaleTmpDirs(opts: GcStaleTmpDirsOptions): Promise<string[]> {
  const { base, pattern, maxAgeMs, exclude, log } = opts;
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
    if (exclude?.has(entry.name)) continue;
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
