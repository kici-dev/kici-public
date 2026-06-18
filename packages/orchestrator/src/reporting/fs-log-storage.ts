/**
 * Filesystem-backed log storage.
 *
 * Stores execution logs as files on disk. No TTL -- logs persist indefinitely.
 * Supports append-only writes (JSONL accumulation) and cursor-based pagination.
 *
 * File layout:
 *   {basePath}/executions/{runId}/job-{name}/step-{index}.log
 */

import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
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

  private fullPath(path: string): string {
    return resolve(this.basePath, path);
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
}
