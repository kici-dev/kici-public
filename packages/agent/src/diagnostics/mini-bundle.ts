/**
 * Agent fleet mini-bundle assembler.
 *
 * Builds an in-memory ZIP of the agent's recent logs, system info, redacted
 * config, and current Prometheus metrics text, streamed to the orchestrator on
 * a fleet.logs.request. No diagnostics runner exists agent-side, so this is a
 * lean subset of the orchestrator's createDebugBundle.
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
  // Guard on existence (mirrors the orchestrator's createDebugBundle): a
  // set-but-missing KICI_LOG_DIR would otherwise make addLogsToArchive's
  // readdirSync throw and abort the whole bundle, so the operator would get a
  // fleet.bundle.error instead of the manifest/config/system/metrics already
  // collected — exactly when a diagnostics bundle is most needed.
  if (opts.logDir && fs.existsSync(opts.logDir)) {
    await addLogsToArchive(archive, opts.logDir, opts.logWindowHours);
  }

  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}
