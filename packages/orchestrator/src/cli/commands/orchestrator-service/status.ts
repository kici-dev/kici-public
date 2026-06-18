/**
 * `kici-admin orchestrator status` command.
 *
 * Shows OS-level service status (state, PID, uptime) and queries
 * the running orchestrator's health API for KiCI-specific info
 * (mode, DB connectivity, agents, jobs, scaler).
 *
 * Target resolution goes through resolveInstance — the same priority chain
 * every lifecycle command uses (--instance-dir > --name > CWD manifest >
 * refusal with candidate list).
 */

import type { Command } from 'commander';
import {
  createServiceManager,
  detectPlatform,
  kiciConfigRoot,
  resolveInstance,
  resolveUserLevel,
  DEFAULT_RESTART_POLICY,
  type ServiceConfig,
  type ServicePlatform,
  type ServiceStatus,
} from '../../service/index.js';
import { formatUptime } from '@kici-dev/shared';
import fs from 'node:fs';
import { toErrorMessage } from '@kici-dev/shared';

/** KiCI health response shape (from GET /health). */
interface HealthData {
  status?: string;
  mode?: string;
  port?: number;
  database?: string;
  platformRelay?: string;
  agents?: number;
  scaler?: { type?: string; warm?: number; max?: number };
  jobs?: { pending?: number; running?: number };
  uptime?: number;
}

/** Read the port from the service's env file (path from the manifest). */
function readPortFromEnvFile(envFilePath: string): number {
  if (!fs.existsSync(envFilePath)) return 4000;

  try {
    const content = fs.readFileSync(envFilePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const [key, ...rest] = trimmed.split('=');
      if (key?.trim() === 'KICI_PORT') {
        const val = rest
          .join('=')
          .trim()
          .replace(/^["']|["']$/g, '');
        const parsed = parseInt(val, 10);
        if (!isNaN(parsed)) return parsed;
      }
    }
  } catch {
    // Ignore read errors
  }
  return 4000;
}

/** Query orchestrator health API. */
async function queryHealth(port: number): Promise<HealthData | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return (await res.json()) as HealthData;
  } catch {
    return null;
  }
}

/** Format the status output as a readable table. */
function formatStatus(
  serviceStatus: ServiceStatus,
  health: HealthData | null,
  serviceName: string,
): string {
  const lines: string[] = [];
  lines.push(`Service: ${serviceName}`);
  lines.push(`State:   ${serviceStatus.state}`);

  if (serviceStatus.pid) {
    lines.push(`PID:     ${serviceStatus.pid}`);
  }
  if (serviceStatus.uptime != null) {
    lines.push(`Uptime:  ${formatUptime(serviceStatus.uptime)}`);
  }
  if (serviceStatus.startedAt) {
    lines.push(`Started: ${serviceStatus.startedAt}`);
  }

  if (health) {
    lines.push('');
    lines.push('--- KiCI orchestrator ---');
    if (health.mode) lines.push(`Mode:       ${health.mode}`);
    if (health.port) lines.push(`Port:       ${health.port}`);
    if (health.database) lines.push(`Database:   ${health.database}`);
    if (health.platformRelay) lines.push(`Platform relay: ${health.platformRelay}`);
    if (health.agents != null) lines.push(`Agents:     ${health.agents}`);
    if (health.scaler) {
      const s = health.scaler;
      lines.push(`Scaler:     ${s.type ?? 'none'} (warm: ${s.warm ?? 0}, max: ${s.max ?? 0})`);
    }
    if (health.jobs) {
      lines.push(
        `Jobs:       ${health.jobs.pending ?? 0} pending, ${health.jobs.running ?? 0} running`,
      );
    }
  } else if (serviceStatus.state === 'running') {
    lines.push('');
    lines.push('(Could not reach health API)');
  }

  return lines.join('\n');
}

/** Build JSON output combining service + health data. */
function buildJsonOutput(
  serviceStatus: ServiceStatus,
  health: HealthData | null,
  serviceName: string,
): Record<string, unknown> {
  return {
    service: serviceName,
    ...serviceStatus,
    health: health ?? undefined,
  };
}

interface StatusOptions {
  platform?: ServicePlatform;
  name?: string;
  instanceDir?: string;
  system?: boolean;
  userLevel?: boolean;
  json?: boolean;
}

export function registerStatusCommand(parent: Command): void {
  parent
    .command('status')
    .description('Show orchestrator service status and health information')
    .option('--platform <type>', 'Service platform (systemd|launchd|windows|compose)')
    .option('--instance-dir <path>', 'Deploy folder of the instance to inspect')
    .option('--name <name>', 'Service name (no default — must resolve via flag/CWD)')
    .option('--system', 'Operate against the system-level service (requires root)')
    .option('--user-level', 'Operate against the user-level service')
    .option('--json', 'Output as JSON')
    .action(async (opts: StatusOptions) => {
      try {
        const platform = detectPlatform(opts.platform as ServicePlatform | undefined);
        const userLevel = resolveUserLevel(opts);
        const manager = await createServiceManager(platform);
        const kiciRoot = kiciConfigRoot(userLevel);

        const resolved = await resolveInstance({
          component: 'orchestrator',
          opts: { instanceDir: opts.instanceDir, name: opts.name },
          cwd: process.cwd(),
          kiciRoot,
          manager,
          isUserLevel: userLevel,
        });

        const config: ServiceConfig = {
          name: resolved.manifest.name,
          displayName: 'KiCI Orchestrator',
          description: 'KiCI CI/CD workflow orchestrator service',
          executablePath: '',
          envFilePath: resolved.manifest.envFilePath,
          workingDirectory: resolved.manifest.configDir,
          isUserLevel: resolved.manifest.isUserLevel,
          restartPolicy: DEFAULT_RESTART_POLICY,
          component: 'orchestrator',
        };

        const serviceStatus = await manager.status(config);

        // Only query health API if service is running
        let health: HealthData | null = null;
        if (serviceStatus.state === 'running') {
          const port = readPortFromEnvFile(config.envFilePath);
          health = await queryHealth(port);
        }

        if (opts.json) {
          console.log(JSON.stringify(buildJsonOutput(serviceStatus, health, config.name), null, 2));
        } else {
          console.log(formatStatus(serviceStatus, health, config.name));
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
