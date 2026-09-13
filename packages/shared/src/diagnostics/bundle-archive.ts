/**
 * Shared debug-bundle archive primitives.
 *
 * Windowed log-file archiving, used by the orchestrator's in-process bundle
 * writer, the kici-admin CLI's local bundle, and the agent's fleet mini-bundle
 * assembler. Keeping one copy means a node cannot drift from the archiving
 * posture of its peers.
 *
 * The redaction primitives it applies live in `@kici-dev/core` so the `kici`
 * CLI can reuse them without importing this package.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Archiver } from 'archiver';
import { scrubText } from '@kici-dev/core';

/** Maximum total log bytes to include in bundle (50MB). */
export const MAX_LOG_BYTES = 50 * 1024 * 1024;

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

    // Scrub before the content enters the archive: a bundle can be shared with
    // KiCI, so this is the last point at which a credential logged into a
    // message can be caught.
    const content = scrubText(fs.readFileSync(filePath, 'utf-8'));
    archive.append(content, { name: `logs/${entry}` });
    // Count what actually entered the archive, not what was on disk. A mask is
    // longer than most secrets it replaces, so charging `stat.size` lets a
    // heavily-redacted set overshoot the cap it exists to enforce.
    totalBytes += Buffer.byteLength(content, 'utf-8');

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
