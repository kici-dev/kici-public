/**
 * `kici-admin orchestrator status` command.
 *
 * Shows OS-level service status (state, PID, uptime) and queries
 * the running orchestrator's health API for KiCI-specific info
 * (mode, DB connectivity, agents, jobs, scaler).
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
import { composeFilePath } from '../../service/compose-path.js';
import { readEnvValue } from '../../service/backup-timer.js';
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

/** Read the env file, or empty content when it is missing or unreadable. */
function readEnvContent(envFilePath: string): string {
  try {
    return fs.existsSync(envFilePath) ? fs.readFileSync(envFilePath, 'utf-8') : '';
  } catch {
    return '';
  }
}

/** Read the port from the service's env file (path from the manifest). */
function readPortFromEnvFile(envFilePath: string): number {
  const value = readEnvValue(readEnvContent(envFilePath), 'KICI_PORT');
  const parsed = value === undefined ? NaN : parseInt(value, 10);
  return isNaN(parsed) ? 4000 : parsed;
}

/** The scaler config the env file names, by path first and directory second. */
function readScalerConfig(envContent: string): string | undefined {
  return (
    readEnvValue(envContent, 'KICI_SCALER_CONFIG_PATH') ??
    readEnvValue(envContent, 'KICI_SCALER_CONFIG_DIR')
  );
}

/**
 * The config files this install owns, for an operator who wants to inspect
 * them. Derived from the instance manifest and the env file on disk, not from
 * the running service, so it answers just as well for a stopped one.
 *
 * No path is checked for existence: on bare metal such a check would pass, but
 * a compose install names host paths the check would have to run against a
 * container, blanking the answer for the shape that needs it most.
 */
export function formatConfigPaths(args: {
  platform: ServicePlatform;
  serviceName: string;
  envFilePath: string;
  envContent: string;
}): string[] {
  const lines = ['--- Config files ---', `Env file:      ${args.envFilePath}`];
  const scaler = readScalerConfig(args.envContent);
  if (scaler) lines.push(`Scaler config: ${scaler}`);
  if (args.platform === 'compose') {
    lines.push(`Compose file:  ${composeFilePath(args.envFilePath, args.serviceName)}`);
  }
  return lines;
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
  configPaths: Record<string, string>,
): Record<string, unknown> {
  return {
    service: serviceName,
    ...serviceStatus,
    configPaths,
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
    .option(
      '--platform <type>',
      'Force the service platform (systemd, launchd, windows, compose). Default: the platform in the install manifest',
    )
    .option('--instance-dir <path>', 'Deploy folder of the instance to inspect')
    .option('--name <name>', 'Service name (no default — must resolve via flag/CWD)')
    .option('--system', 'Operate against the system-level service (requires root)')
    .option('--user-level', 'Operate against the user-level service')
    .option('--json', 'Output as JSON')
    .action(async (opts: StatusOptions) => {
      try {
        const userLevel = resolveUserLevel(opts);
        const kiciRoot = kiciConfigRoot(userLevel);

        // `platform` is the one the seam already resolved — `--platform` when
        // given, otherwise the manifest's. It is the platform `manager` speaks,
        // so reporting the config paths off it keeps the two consistent:
        // re-deriving from the manifest would name a compose file under
        // `--platform systemd`, describing an install the driver being reported
        // on is not operating. Neither is the host's own platform, which
        // `detectPlatform` would answer with systemd for any systemd Linux,
        // including one whose orchestrator is a compose install.
        const {
          resolved,
          manager,
          platform: installPlatform,
        } = await resolveInstanceTarget({
          component: 'orchestrator',
          opts: { instanceDir: opts.instanceDir, name: opts.name },
          cwd: process.cwd(),
          kiciRoot,
          platformOverride: opts.platform,
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

        const envContent = readEnvContent(config.envFilePath);
        const configPathLines = formatConfigPaths({
          platform: installPlatform,
          serviceName: config.name,
          envFilePath: config.envFilePath,
          envContent,
        });

        // Only query health API if service is running
        let health: HealthData | null = null;
        if (serviceStatus.state === 'running') {
          const port = readPortFromEnvFile(config.envFilePath);
          health = await queryHealth(port);
        }

        const jsonConfigPaths: Record<string, string> = { envFile: config.envFilePath };
        const scalerPath = readScalerConfig(envContent);
        if (scalerPath) jsonConfigPaths.scalerConfig = scalerPath;
        if (installPlatform === 'compose') {
          jsonConfigPaths.composeFile = composeFilePath(config.envFilePath, config.name);
        }

        if (opts.json) {
          console.log(
            JSON.stringify(
              buildJsonOutput(serviceStatus, health, config.name, jsonConfigPaths),
              null,
              2,
            ),
          );
        } else {
          console.log(formatStatus(serviceStatus, health, config.name));
          console.log('');
          console.log(configPathLines.join('\n'));
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
