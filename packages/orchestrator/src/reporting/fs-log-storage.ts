/**
 * Filesystem-backed log storage: append-only JSONL files with cursor-based pagination.
 * Lifecycle is operator-managed (the retention sweep runs on the S3 backend only).
 *
 * Layout: {basePath}/executions/{runId}/job-{name}/step-{index}.log
 *
 * A logical key maps to the same relative path on disk, `/` separating directories. On a
 * Windows host, each character Windows refuses in a file name (`"`, `*`, `:`, `<`, `>`, `?`,
 * `|`, `\` and the control characters 1-31) is stored as the private-use character
 * U+F000 + its code, the mapping Cygwin uses for the same set. Every name Windows accepts maps
 * to itself, so the mapping moves no file a Windows host could already write, and `list()`
 * decodes the names back to logical keys.
 */

import { appendFile, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { assertSafeLogPath } from './log-storage.js';
import type { LogReadOptions, LogReadResult, LogStorage } from './log-storage.js';

interface FilesystemLogStorageOptions {
  basePath: string;
  /** Host platform; `win32` turns on the file-name mapping. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

/** Characters a Windows file name cannot hold. NUL never reaches here: `assertSafeLogPath` refuses it. */
const WIN32_RESERVED_CHAR_RE = /["*:<>?|\\\u0001-\u001f]/g;
/** The private-use characters `WIN32_RESERVED_CHAR_RE` maps onto. */
const WIN32_MAPPED_CHAR_RE = /[\uf001-\uf01f\uf022\uf02a\uf03a\uf03c\uf03e\uf03f\uf05c\uf07c]/g;
const WIN32_PRIVATE_USE_OFFSET = 0xf000;

/** Logical name segment → Windows-safe file name. */
function encodeWin32Segment(segment: string): string {
  return segment.replace(WIN32_RESERVED_CHAR_RE, (ch) =>
    String.fromCharCode(WIN32_PRIVATE_USE_OFFSET + ch.charCodeAt(0)),
  );
}

/** Windows file name → logical name segment. */
function decodeWin32Segment(name: string): string {
  return name.replace(WIN32_MAPPED_CHAR_RE, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - WIN32_PRIVATE_USE_OFFSET),
  );
}

export class FilesystemLogStorage implements LogStorage {
  private readonly basePath: string;
  private readonly mapWin32Names: boolean;

  constructor(options: FilesystemLogStorageOptions) {
    this.basePath = resolve(options.basePath);
    this.mapWin32Names = (options.platform ?? process.platform) === 'win32';
  }

  // -- Paths --

  /**
   * Resolve a logical log path to an absolute path, refusing anything outside the storage root.
   *
   * Two checks, deliberately. `assertSafeLogPath` is the effective gate on POSIX (a relative
   * path with no `..` cannot resolve outside the root), so the comparison below is unreachable
   * there. It stays as an independent statement of the invariant: it catches resolvers with
   * extra escape hatches (win32 resolves drive-relative `C:foo` against that drive's cwd, a form
   * the Windows name mapping already turns into a plain name), and relaxing the logical check
   * cannot silently reopen an escape.
   *
   * Both are lexical — neither resolves symlinks. A symlink planted inside the log root still
   * redirects a clean path outside it; containing that needs a `realpath` per call, and the log
   * root is the orchestrator user's own directory.
   *
   * Every verb funnels through here, so a new caller is contained on arrival.
   */
  private fullPath(path: string): string {
    assertSafeLogPath(path);
    const full = resolve(this.basePath, this.toDiskPath(path));
    // The equality arm lets an empty / `.` prefix address the root itself.
    if (full !== this.basePath && !full.startsWith(this.basePath + sep)) {
      throw new Error(`log path escapes the storage root: ${path}`);
    }
    return full;
  }

  /**
   * Logical key → relative on-disk path. Identity off Windows. On Windows a key that already
   * holds one of the mapped private-use characters is refused: `list()` would decode it to a
   * different key, so writing it would break the round trip.
   */
  private toDiskPath(path: string): string {
    if (!this.mapWin32Names) return path;
    if (path.search(WIN32_MAPPED_CHAR_RE) !== -1) {
      throw new Error(`log path holds a character reserved for Windows file-name mapping: ${path}`);
    }
    return path.split('/').map(encodeWin32Segment).join('/');
  }

  /** Path relative to the base path, as the host separates it → logical `/`-separated key. */
  private toLogicalKey(relativePath: string): string {
    const segments = relativePath.split(sep);
    return (this.mapWin32Names ? segments.map(decodeWin32Segment) : segments).join('/');
  }

  // -- Helpers --

  private async ensureDir(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  /** Bytes; 0 if the file doesn't exist. */
  private async fileSize(filePath: string): Promise<number> {
    try {
      const s = await stat(filePath);
      return s.size;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
  }

  /** Recursive; logical keys relative to the base path. */
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
          results.push(this.toLogicalKey(relative(this.basePath, entryPath)));
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
    // appendFile is already atomic + durable, so no buffering here.
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
        // A file that vanished between listing and stat is not returned.
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
