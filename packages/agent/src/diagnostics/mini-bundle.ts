/**
 * In-memory ZIP of the agent's recent logs, system info, redacted config and
 * Prometheus metrics, streamed to the orchestrator on a fleet.logs.request: a
 * lean subset of the orchestrator's createDebugBundle, as the agent has no
 * diagnostics runner.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import { ZipArchive } from 'archiver';
import { addLogsToArchive, redactConfig } from '@kici-dev/shared';

export interface AgentMiniBundleOptions {
  agentId: string;
  logDir?: string;
  logWindowHours: number;
  config: Record<string, unknown>;
  metricsText?: string;
}

export async function buildAgentMiniBundle(opts: AgentMiniBundleOptions): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  archive.on('data', (d: Buffer) => chunks.push(d));
  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', resolve);
    archive.on('error', reject);
  });

  archive.append(
    JSON.stringify(
      { kind: 'agent', agentId: opts.agentId, generatedAt: new Date().toISOString() },
      null,
      2,
    ),
    { name: 'manifest.json' },
  );
  archive.append(JSON.stringify(redactConfig(opts.config), null, 2), {
    name: 'config/config.json',
  });
  archive.append(
    JSON.stringify(
      {
        hostname: os.hostname(),
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        cpus: os.cpus().length,
        totalmem: os.totalmem(),
        freemem: os.freemem(),
        uptime: os.uptime(),
      },
      null,
      2,
    ),
    { name: 'system/info.json' },
  );
  if (opts.metricsText) archive.append(opts.metricsText, { name: 'system/metrics.txt' });
  // As in createDebugBundle: a set-but-missing KICI_LOG_DIR would throw in
  // addLogsToArchive and turn the whole bundle into a fleet.bundle.error.
  if (opts.logDir && fs.existsSync(opts.logDir)) {
    await addLogsToArchive(archive, opts.logDir, opts.logWindowHours);
  }

  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}
