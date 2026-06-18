/**
 * Shared debug-bundle archive primitives.
 *
 * Allowlist config redaction and windowed log-file archiving, used by the
 * orchestrator's in-process bundle writer, the kici-admin CLI's local bundle,
 * and the agent's fleet mini-bundle assembler. Keeping one copy means a node
 * cannot drift from the redaction posture of its peers.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Archiver } from 'archiver';

/** Maximum total log bytes to include in bundle (50MB). */
export const MAX_LOG_BYTES = 50 * 1024 * 1024;

/**
 * Config field names that are safe to include unredacted.
 * Everything else gets replaced with "****".
 */
const SAFE_CONFIG_KEYS = new Set([
  'mode',
  'host',
  'port',
  'logLevel',
  'region',
  'environment',
  'name',
  'label',
  'labels',
  'enabled',
  'disabled',
  'timeout',
  'interval',
  'maxRetries',
  'retries',
  'workers',
  'concurrency',
  'maxConcurrency',
  'batchSize',
  'bufferSize',
  'warmPool',
  'cooldown',
  'type',
  'provider',
  'scaler',
  'driver',
  'backend',
  'protocol',
  'scheme',
  'path',
  'basePath',
  'metricsPath',
  'healthPath',
  'logFormat',
  'logFile',
  'logDir',
  'dataDir',
  'version',
  'debug',
  'verbose',
  'quiet',
  'tls',
  'cors',
  'rateLimiting',
  'maxConnections',
  'poolSize',
  'minPool',
  'maxPool',
  'idleTimeout',
  'connectTimeout',
  'requestTimeout',
  'shutdownTimeout',
  'gracefulShutdown',
]);

/**
 * Redact config values using allowlist approach.
 * Only known-safe fields are preserved; everything else becomes "****".
 */
export function redactConfig(obj: unknown, parentKey?: string): unknown {
  if (obj === null || obj === undefined) return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => redactConfig(item, parentKey));
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = redactConfig(value, key);
    }
    return result;
  }

  // Primitive values: check if the key is safe
  if (typeof obj === 'string' && parentKey && !SAFE_CONFIG_KEYS.has(parentKey)) {
    return '****';
  }

  // Numbers, booleans are always safe
  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return obj;
  }

  // String with a safe key
  if (typeof obj === 'string' && parentKey && SAFE_CONFIG_KEYS.has(parentKey)) {
    return obj;
  }

  // Top-level string with no parent key -- redact
  if (typeof obj === 'string') {
    return '****';
  }

  return obj;
}

/**
 * Add log files from logDir to the archive, respecting MAX_LOG_BYTES cap
 * and the logWindow time filter. Matches any `*.log` file in the directory,
 * so the per-instance filename pattern produced by
 * `buildLogFilename()` is picked up without additional configuration.
 *
 * Exported for reuse by the `kici-admin debug-bundle` CLI command, which
 * runs outside the orchestrator process but still needs to include the
 * same log files in its locally-assembled bundle.
 */
export async function addLogsToArchive(
  archive: Archiver,
  logDir: string,
  logWindowHours: number,
): Promise<void> {
  const cutoff = Date.now() - logWindowHours * 60 * 60 * 1000;
  const entries = fs.readdirSync(logDir).filter((f) => {
    if (!f.endsWith('.log')) return false;
    const stat = fs.statSync(path.join(logDir, f));
    return stat.mtimeMs >= cutoff;
  });

  // Sort by modification time descending so the most recent logs are included first
  // when the MAX_LOG_BYTES cap is reached
  entries.sort((a, b) => {
    const aStat = fs.statSync(path.join(logDir, a));
    const bStat = fs.statSync(path.join(logDir, b));
    return bStat.mtimeMs - aStat.mtimeMs;
  });

  let totalBytes = 0;
  let totalLines = 0;
  let errors = 0;
  let warnings = 0;

  for (const entry of entries) {
    const filePath = path.join(logDir, entry);
    const stat = fs.statSync(filePath);

    if (totalBytes + stat.size > MAX_LOG_BYTES) {
      // Skip remaining files to stay under cap
      break;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    archive.append(content, { name: `logs/${entry}` });
    totalBytes += stat.size;

    // Count lines and patterns
    const lines = content.split('\n');
    totalLines += lines.length;
    for (const line of lines) {
      if (/\berror\b/i.test(line)) errors++;
      if (/\bwarn(ing)?\b/i.test(line)) warnings++;
    }
  }

  // Log summary
  const summary = { totalLines, errors, warnings, totalBytes };
  archive.append(JSON.stringify(summary, null, 2), { name: 'logs/summary.json' });
}
