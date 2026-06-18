/**
 * `kici-admin agent status` command.
 *
 * Shows OS-level service status (state, PID, uptime) and queries
 * the running agent's health API for agent-specific info (labels,
 * orchestrator connection, current job).
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

/** Agent health response shape. */
interface AgentHealthData {
  status?: string;
  labels?: string[];
  orchestratorConnection?: string;
  currentJob?: { id?: string; workflow?: string; startedAt?: string } | null;
  uptime?: number;
}

/** Read the port from the agent's env file (path from the manifest). */
function readPortFromEnvFile(envFilePath: string): number {
  if (!fs.existsSync(envFilePath)) return 4001;

  try {
    const content = fs.readFileSync(envFilePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const [key, ...rest] = trimmed.split('=');
      if (key?.trim() === 'KICI_AGENT_PORT' || key?.trim() === 'KICI_PORT') {
        const val = rest
          .join('=')
          .trim()
          .replace(/^["']|["']$/g, '');
        const parsed = parseInt(val, 10);
        if (!isNaN(parsed)) return parsed;
      }
    }
  } catch {
    // Ignore
  }
  return 4001;
}

/** Query agent health API. */
async function queryHealth(port: number): Promise<AgentHealthData | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return (await res.json()) as AgentHealthData;
  } catch {
    return null;
  }
}

function formatStatus(
  serviceStatus: ServiceStatus,
  health: AgentHealthData | null,
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
    lines.push('--- KiCI agent ---');
    if (health.labels && health.labels.length > 0) {
      lines.push(`Labels:       ${health.labels.join(', ')}`);
    } else {
      lines.push('Labels:       (none - accepts all jobs)');
    }
    if (health.orchestratorConnection) {
      lines.push(`Orchestrator: ${health.orchestratorConnection}`);
    }
    if (health.currentJob) {
      lines.push(
        `Current job:  ${health.currentJob.id ?? 'unknown'} (${health.currentJob.workflow ?? ''})`,
      );
    } else {
      lines.push('Current job:  idle');
    }
  } else if (serviceStatus.state === 'running') {
    lines.push('');
    lines.push('(Could not reach agent health API)');
  }

  return lines.join('\n');
}

function buildJsonOutput(
  serviceStatus: ServiceStatus,
  health: AgentHealthData | null,
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

export function registerAgentStatusCommand(parent: Command): void {
  parent
    .command('status')
    .description('Show agent service status and health information')
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
          component: 'agent',
          opts: { instanceDir: opts.instanceDir, name: opts.name },
          cwd: process.cwd(),
          kiciRoot,
          manager,
          isUserLevel: userLevel,
        });

        const config: ServiceConfig = {
          name: resolved.manifest.name,
          displayName: 'KiCI Agent',
          description: 'KiCI CI/CD workflow execution agent service',
          executablePath: '',
          envFilePath: resolved.manifest.envFilePath,
          workingDirectory: resolved.manifest.configDir,
          isUserLevel: resolved.manifest.isUserLevel,
          restartPolicy: DEFAULT_RESTART_POLICY,
          component: 'agent',
        };

        const serviceStatus = await manager.status(config);

        let health: AgentHealthData | null = null;
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
