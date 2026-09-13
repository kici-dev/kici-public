/**
 * Filesystem-backed log storage.
 *
 * Stores execution logs as files on disk. Lifecycle is operator-managed (the
 * cleanup retention sweep runs on the S3 backend only). Supports append-only
 * writes (JSONL accumulation) and cursor-based pagination.
 *
 * File layout:
 *   {basePath}/executions/{runId}/job-{name}/step-{index}.log
 */

import { appendFile, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { assertSafeLogPath } from './log-storage.js';
import type { LogReadOptions, LogReadResult, LogStorage } from './log-storage.js';

interface FilesystemLogStorageOptions {
  basePath: string;
}

export class FilesystemLogStorage implements LogStorage {
  private readonly basePath: string;

  constructor(options: FilesystemLogStorageOptions) {
    this.basePath = resolve(options.basePath);
  }

  // -- Paths --

  /**
   * Resolve a logical log path to an absolute filesystem path, refusing
   * anything that would address a file outside the storage root.
   *
   * Two checks, deliberately both. `assertSafeLogPath` is the effective gate on
   * POSIX: once a path is relative and carries no `..` segment, `resolve()`
   * cannot produce anything outside the root, so the comparison below is
   * unreachable there. It is kept as a second, independent statement of the
   * same invariant — it is what catches a resolver with extra escape hatches
   * (win32 resolves a drive-relative `C:foo` against that drive's own cwd, not
   * against the root), and it means relaxing the logical check cannot silently
   * reopen an escape.
   *
   * Both checks are lexical — neither resolves symlinks. A symlink planted
   * inside the log root still redirects a logically-clean path outside it;
   * containing that would need a `realpath` on every call, and the log root is
   * the orchestrator user's own directory.
   *
   * Every verb on this class funnels through here, so a new caller is
   * contained on arrival.
   */
  private fullPath(path: string): string {
    assertSafeLogPath(path);
    const full = resolve(this.basePath, path);
    // The equality arm lets an empty / `.` prefix address the root itself.
    if (full !== this.basePath && !full.startsWith(this.basePath + sep)) {
      throw new Error(`log path escapes the storage root: ${path}`);
    }
    return full;
  }

  // -- Helpers --

  /**
   * Ensure the directory for a given file path exists.
   */
  private async ensureDir(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
  }

  /**
   * Check if a file exists on disk.
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  /**
   * Get the size of a file in bytes. Returns 0 if the file doesn't exist.
   */
  private async fileSize(filePath: string): Promise<number> {
    try {
      const s = await stat(filePath);
      return s.size;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
  }

  /**
   * Recursively list all files under a directory, returning paths relative
   * to the base path.
   */
  private async listRecursive(dirPath: string): Promise<string[]> {
    const results: string[] = [];

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
          const nested = await this.listRecursive(entryPath);
          results.push(...nested);
        } else {
          results.push(relative(this.basePath, entryPath));
        }
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    return results.sort();
  }

  // -- LogStorage interface --

  async append(path: string, data: string): Promise<void> {
    const filePath = this.fullPath(path);
    await this.ensureDir(filePath);
    await appendFile(filePath, data, 'utf-8');
  }

  async appendStreaming(path: string, data: string): Promise<void> {
    // appendFile is already atomic + durable, so a step log needs no buffering
    // on the filesystem backend.
    await this.append(path, data);
  }

  async finalize(_path: string): Promise<void> {
    // No-op: appendFile writes are already durable.
  }

  async read(path: string, options?: LogReadOptions): Promise<LogReadResult> {
    const filePath = this.fullPath(path);
    const cursor = options?.cursor ?? 0;
    const limit = options?.limit;

    try {
      const content = await readFile(filePath);
      const totalSize = content.length;

      if (cursor >= totalSize) {
        return { data: '', cursor: totalSize, complete: true };
      }

      const end = limit !== undefined ? Math.min(cursor + limit, totalSize) : totalSize;
      const slice = content.subarray(cursor, end);
      const newCursor = cursor + slice.length;

      return {
        data: slice.toString('utf-8'),
        cursor: newCursor,
        complete: newCursor >= totalSize,
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { data: '', cursor: 0, complete: true };
      }
      throw err;
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.fileExists(this.fullPath(path));
  }

  async list(prefix: string): Promise<string[]> {
    const dirPath = this.fullPath(prefix);
    return this.listRecursive(dirPath);
  }

  async listWithMetadata(prefix: string): Promise<Array<{ path: string; lastModified: Date }>> {
    const paths = await this.list(prefix); // relative paths, one per file
    const out: Array<{ path: string; lastModified: Date }> = [];
    for (const p of paths) {
      try {
        const s = await stat(this.fullPath(p));
        out.push({ path: p, lastModified: s.mtime });
      } catch (err: unknown) {
        // A file that vanished between listing and stat is simply not returned.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    return out;
  }

  async deleteMany(paths: string[]): Promise<number> {
    let deleted = 0;
    for (const p of paths) {
      try {
        await unlink(this.fullPath(p));
        deleted += 1;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    return deleted;
  }
}
