/**
 * Debug bundle writer.
 *
 * Creates a sanitized ZIP diagnostic bundle containing config (secrets redacted),
 * recent logs, system info, metrics, cluster state, and execution data.
 * This is the primary support tool -- operators run debug-bundle and share
 * the ZIP for troubleshooting.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ZipArchive } from 'archiver';
import { redactConfig, addLogsToArchive } from '@kici-dev/shared';
import type { DiagnosticDeps } from './types.js';
import { runDiagnostics } from './runner.js';

// Re-export the shared archive primitives so existing internal imports (the
// diagnostics barrel, the CLI's local bundle) keep resolving from here.
export { redactConfig, addLogsToArchive } from '@kici-dev/shared';

export interface BundleOptions {
  /** Where to write the ZIP. */
  outputPath: string;
  /** Orchestrator instance identifier. */
  orchestratorId: string;
  /** Raw orchestrator config (will be redacted). */
  config: Record<string, unknown>;
  /** Path to log files directory. */
  logDir?: string;
  /** Hours of logs to include (default: 4). */
  logWindow?: number;
  /** Dependencies for running diagnostic checks. */
  diagnosticDeps: DiagnosticDeps;
  /** URL for cluster health endpoint. */
  clusterHealthUrl?: string;
  /** URL for recent runs endpoint. */
  recentRunsUrl?: string;
}

/**
 * Create a debug bundle ZIP file.
 *
 * The bundle contains:
 * - manifest.json: version, timestamp, orchestrator ID
 * - config/config.json: redacted configuration
 * - system/info.json: OS, Node, CPU, memory info
 * - diagnostics/results.json: health check results
 * - logs/: recent log files (if logDir provided)
 * - logs/summary.json: log statistics
 */
export async function createDebugBundle(options: BundleOptions): Promise<string> {
  const {
    outputPath,
    orchestratorId,
    config,
    logDir,
    logWindow = 4,
    diagnosticDeps,
    clusterHealthUrl,
    recentRunsUrl,
  } = options;

  // Ensure output directory exists
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const output = fs.createWriteStream(outputPath);
  const archive = new ZipArchive({ zlib: { level: 6 } });

  const finalized = new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
  });

  archive.pipe(output);

  // 1. Manifest
  const manifest = {
    version: '1.0',
    generated_at: new Date().toISOString(),
    orchestrator_id: orchestratorId,
    node_version: process.version,
    platform: process.platform,
  };
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

  // 2. Redacted config
  const redacted = redactConfig(config);
  archive.append(JSON.stringify(redacted, null, 2), { name: 'config/config.json' });

  // 3. System info
  const systemInfo = {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    nodeVersion: process.version,
    cpuCount: os.cpus().length,
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    uptime: process.uptime(),
    hostname: os.hostname(),
  };
  archive.append(JSON.stringify(systemInfo, null, 2), { name: 'system/info.json' });

  // 4. Diagnostic results
  try {
    const results = await runDiagnostics(diagnosticDeps);
    archive.append(JSON.stringify(results, null, 2), { name: 'diagnostics/results.json' });
  } catch {
    archive.append(JSON.stringify([]), { name: 'diagnostics/results.json' });
  }

  // 5. Logs
  if (logDir && fs.existsSync(logDir)) {
    await addLogsToArchive(archive, logDir, logWindow);
  }

  // 6. Cluster health (optional, best-effort)
  if (clusterHealthUrl) {
    try {
      const res = await fetch(clusterHealthUrl);
      if (res.ok) {
        const data = await res.json();
        archive.append(JSON.stringify(data, null, 2), { name: 'cluster/health.json' });
      }
    } catch {
      // Skip if unavailable
    }
  }

  // 7. Recent runs (optional, best-effort)
  if (recentRunsUrl) {
    try {
      const res = await fetch(recentRunsUrl);
      if (res.ok) {
        const data = await res.json();
        archive.append(JSON.stringify(data, null, 2), { name: 'executions/recent.json' });
      }
    } catch {
      // Skip if unavailable
    }
  }

  await archive.finalize();
  await finalized;

  return outputPath;
}
