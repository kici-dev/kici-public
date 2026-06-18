/**
 * Log storage abstraction for the orchestrator.
 *
 * Provides a pluggable backend interface for persisting execution logs.
 * Unlike CacheStorage, log storage has NO TTL semantics -- logs persist
 * indefinitely and the customer manages their own storage lifecycle.
 *
 * Backends: FilesystemLogStorage, S3LogStorage
 *
 * Log file layout: executions/{runId}/job-{name}/step-{index}.log
 * Format: JSONL (one JSON object per line with timestamp, level, message, metadata)
 */

import { FilesystemLogStorage } from './fs-log-storage.js';
import { S3LogStorage } from './s3-log-storage.js';

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
 * All operations are async. No TTL -- logs persist indefinitely.
 */
export interface LogStorage {
  /** Append lines to a log file. Creates the file (and directories) if it doesn't exist. */
  append(path: string, data: string): Promise<void>;

  /** Read log file content. Returns { data, cursor, complete } for pagination. */
  read(path: string, options?: LogReadOptions): Promise<LogReadResult>;

  /** Check if a log file exists. */
  exists(path: string): Promise<boolean>;

  /** List files matching a prefix (directory listing). */
  list(prefix: string): Promise<string[]>;
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
      });
  }
}
