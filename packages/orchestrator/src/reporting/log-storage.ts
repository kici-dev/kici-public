/**
 * Log storage abstraction for the orchestrator.
 *
 * Provides a pluggable backend interface for persisting execution logs.
 * Retention on the S3 backend is bounded by the orchestrator cleanup sweep
 * (`KICI_STEP_LOG_TTL_DAYS`, default 90; 0 disables it); the filesystem backend
 * leaves lifecycle to the operator.
 *
 * Backends: FilesystemLogStorage, S3LogStorage
 *
 * Log file layout: executions/{runId}/job-{name}/step-{index}.log
 * Format: JSONL (one JSON object per line with timestamp, level, message, metadata)
 */

import { isAbsolute } from 'node:path';
import { FilesystemLogStorage } from './fs-log-storage.js';
import { S3LogStorage } from './s3-log-storage.js';

/**
 * Assert that a logical log path is safe to hand to a storage backend.
 *
 * The invariant every backend relies on: a log path is relative, contains no
 * `..` segment, and carries no NUL byte. Both backends call this at their own
 * boundary, so a malformed key is refused identically whichever backend the
 * operator configured, and a new caller is guarded on arrival rather than by
 * remembering to validate.
 *
 * The `..` test is per-segment, not a substring match: a job name such as
 * `job-a..b` is legitimate and is accepted.
 *
 * `FilesystemLogStorage.fullPath()` re-states the same invariant physically,
 * comparing the resolved absolute path against the resolved root. Both checks
 * are lexical: neither resolves symlinks, so a symlink planted inside the log
 * root still redirects a logically-clean path through it.
 */
export function assertSafeLogPath(path: string): void {
  // NUL first: every message below interpolates `path`, and an error string
  // carrying a raw NUL poisons whatever log line it lands in.
  if (path.includes('\u0000')) {
    throw new Error('log path contains a NUL byte');
  }
  if (isAbsolute(path) || path.startsWith('/') || path.startsWith('\\')) {
    throw new Error(`log path must be relative: ${path}`);
  }
  // Split on both separators: a Windows-style `..\` escapes just as well as
  // `../`, and the wire fields feeding these paths are unconstrained strings.
  if (path.split(/[/\\]/).includes('..')) {
    throw new Error(`log path contains a '..' segment: ${path}`);
  }
}

/**
 * Read result from LogStorage.read().
 * Supports cursor-based pagination for large log files.
 */
export interface LogReadResult {
  /** The log content for this page */
  data: string;
  /** Byte offset cursor for the next read (pass to options.cursor) */
  cursor: number;
  /** True if the entire file has been read (cursor >= file size) */
  complete: boolean;
}

/**
 * Options for LogStorage.read().
 */
export interface LogReadOptions {
  /** Byte offset to start reading from (0-based). Default: 0 */
  cursor?: number;
  /** Maximum number of bytes to read. Default: read all remaining */
  limit?: number;
}

/**
 * Pluggable log storage interface.
 *
 * All operations are async. Retention is enforced by the cleanup sweep on the
 * S3 backend (see `pruneExpiredLogs`); the filesystem backend is operator-managed.
 */
export interface LogStorage {
  /**
   * Append lines to a log file, immediately durable. Creates the file (and
   * directories) if it doesn't exist. Used by single-shot writers (webhook
   * payloads, rerun payloads, orchestration logs) that write once and expect
   * the content to be readable without any subsequent finalize call.
   */
  append(path: string, data: string): Promise<void>;

  /**
   * High-frequency append-only log write. Durability is guaranteed by a
   * subsequent finalize(path) (called at run completion). S3 buffers per key
   * and seals immutable segments on a size/time threshold; the filesystem
   * appends immediately (appendFile is already durable).
   */
  appendStreaming(path: string, data: string): Promise<void>;

  /**
   * Seal any buffered-but-unwritten content for a path. S3 flushes its current
   * tail segment; the filesystem is a no-op. Safe on any path — a no-op when
   * nothing is buffered.
   */
  finalize(path: string): Promise<void>;

  /** Read log file content. Returns { data, cursor, complete } for pagination. */
  read(path: string, options?: LogReadOptions): Promise<LogReadResult>;

  /** Check if a log file exists. */
  exists(path: string): Promise<boolean>;

  /** List files matching a prefix (directory listing). */
  list(prefix: string): Promise<string[]>;

  /**
   * List every physical object under a prefix with its last-modified time,
   * `path` relative to the storage prefix. Unlike {@link LogStorage.list} this
   * does NOT collapse S3 segment objects (`.../seg-NNNNNN`) to their logical
   * step path — the retention sweep must see and delete each physical object,
   * and each segment carries its own last-modified time. Step-log objects are
   * write-once, so last-modified is the correct expiry basis.
   */
  listWithMetadata(prefix: string): Promise<Array<{ path: string; lastModified: Date }>>;

  /**
   * Bulk-delete objects by their storage-relative path (as returned by
   * {@link LogStorage.listWithMetadata}). S3 uses `DeleteObjects` (≤1000
   * keys/call, chunked); missing keys are no-ops. Returns the count deleted.
   */
  deleteMany(paths: string[]): Promise<number>;
}

/**
 * Configuration for creating a log storage backend.
 */
type LogStorageConfig =
  | { type: 'filesystem'; basePath: string }
  | {
      type: 's3';
      bucket: string;
      prefix: string;
      region?: string;
      /** Custom endpoint URL for S3-compatible services (e.g., SeaweedFS, LocalStack) */
      endpoint?: string;
      /** Use path-style access instead of virtual-hosted-style (required for most S3-compatible services) */
      forcePathStyle?: boolean;
      /** Seal a step-log segment once the in-memory buffer reaches this many bytes. */
      segmentFlushBytes: number;
      /** Seal a step-log segment once the oldest buffered byte reaches this age (ms). */
      segmentFlushMs: number;
    };

/**
 * Factory function to create the appropriate LogStorage backend.
 */
export function createLogStorage(config: LogStorageConfig): LogStorage {
  switch (config.type) {
    case 'filesystem':
      return new FilesystemLogStorage({ basePath: config.basePath });
    case 's3':
      return new S3LogStorage({
        bucket: config.bucket,
        prefix: config.prefix,
        region: config.region,
        endpoint: config.endpoint,
        forcePathStyle: config.forcePathStyle,
        segmentFlushBytes: config.segmentFlushBytes,
        segmentFlushMs: config.segmentFlushMs,
      });
  }
}
