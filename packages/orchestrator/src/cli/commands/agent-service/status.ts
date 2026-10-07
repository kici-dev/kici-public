/**
 * `kici-admin agent status` command.
 *
 * Shows OS-level service status (state, PID, uptime) and queries the
 * running agent's `/health` endpoint for its ID, orchestrator connection,
 * active job count, version, build fingerprint and uptime.
 *
 * Target resolution goes through resolveInstanceTarget — the same priority chain
 * every lifecycle command uses (--instance-dir > --name > CWD manifest >
 * refusal with candidate list).
 */

import type { Command } from 'commander';
import {
  kiciConfigRoot,
  resolveInstanceTarget,
  resolveUserLevel,
  DEFAULT_RESTART_POLICY,
  type ServiceConfig,
  type ServicePlatform,
  type ServiceStatus,
} from '../../service/index.js';
import { AGENT_DEFAULT_PORT } from '@kici-dev/shared/env';
import { formatUptime, type AgentLivenessInfo, type LivenessResponse } from '@kici-dev/shared';
import {
  buildInfoRows,
  fetchLocalJson,
  formatHealthSection,
  readEnvContent,
  readLocalEndpoint,
  type StatusRow,
} from '../service-health.js';
import { cliAction } from '../shared/cli-action.js';

/** Column the values of the agent section start at. */
const VALUE_COLUMN = 14;

/**
 * A `/health` body. Every field is optional: an agent older than this CLI may
 * report fewer of them.
 */
type AgentHealth = Partial<LivenessResponse<AgentLivenessInfo>>;

function formatStatus(
  serviceStatus: ServiceStatus,
  health: AgentHealth | null,
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
    const rows: StatusRow[] = [];
    if (health.agentId) rows.push(['Agent ID', health.agentId]);
    if (typeof health.connected === 'boolean') {
      rows.push(['Orchestrator', health.connected ? 'connected' : 'disconnected']);
    }
    if (typeof health.activeJobs === 'number') {
      rows.push(['Active jobs', String(health.activeJobs)]);
    }
    rows.push(...buildInfoRows(health));
    lines.push(...formatHealthSection('--- KiCI agent ---', rows, VALUE_COLUMN));
  } else if (serviceStatus.state === 'running') {
    lines.push('');
    lines.push('(Could not reach agent health API)');
  }

  return lines.join('\n');
}

function buildJsonOutput(
  serviceStatus: ServiceStatus,
  health: AgentHealth | null,
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
    .option(
      '--platform <type>',
      'Force the service platform (systemd, launchd, windows, compose). Default: the platform in the install manifest',
    )
    .option('--instance-dir <path>', 'Deploy folder of the instance to inspect')
    .option('--name <name>', 'Service name (no default — must resolve via flag/CWD)')
    .option('--system', 'Operate against the system-level service (requires root)')
    .option('--user-level', 'Operate against the user-level service')
    .option('--json', 'Output as JSON')
    .action(
      cliAction(async (opts: StatusOptions) => {
        const userLevel = resolveUserLevel(opts);
        const kiciRoot = kiciConfigRoot(userLevel);

        const { resolved, manager } = await resolveInstanceTarget({
          component: 'agent',
          opts: { instanceDir: opts.instanceDir, name: opts.name },
          cwd: process.cwd(),
          kiciRoot,
          platformOverride: opts.platform,
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

        let health: AgentHealth | null = null;
        if (serviceStatus.state === 'running') {
          const endpoint = readLocalEndpoint(
            readEnvContent(config.envFilePath),
            AGENT_DEFAULT_PORT,
          );
          health = await fetchLocalJson<AgentHealth>(endpoint, '/health');
        }

        if (opts.json) {
          console.log(JSON.stringify(buildJsonOutput(serviceStatus, health, config.name), null, 2));
        } else {
          console.log(formatStatus(serviceStatus, health, config.name));
        }
      }),
    );
}
