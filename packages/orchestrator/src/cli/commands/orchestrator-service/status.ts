/**
 * `kici-admin orchestrator status` command.
 *
 * Shows OS-level service status (state, PID, uptime) and queries the
 * running orchestrator's `/health` and `/ready` endpoints for its version,
 * build fingerprint, uptime and readiness (database reachable, boot finished).
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
import {
  formatUptime,
  ReadinessStatus,
  toErrorMessage,
  type LivenessResponse,
  type ReadinessResponse,
} from '@kici-dev/shared';
import { ORCHESTRATOR_DEFAULT_PORT } from '@kici-dev/shared/env';
import { DB_POOL_ACQUIRE_TIMEOUT_DEFAULT_MS } from '../../../config.js';
import type { OrchestratorLivenessInfo } from '../../../routes/health.js';
import {
  buildInfoRows,
  fetchLocalJson,
  formatHealthSection,
  hideBuildCommit,
  readEnvContent,
  readLocalEndpoint,
  type StatusRow,
} from '../service-health.js';

/** Time `/ready` gets beyond the database-pool acquire timeout, for its query and its response. */
const READINESS_MARGIN_MS = 3000;

/**
 * How long to wait for `/ready`. Its database check waits up to the pool's
 * acquire timeout before it reports `database: false`, so the wait covers that
 * timeout plus a margin. An acquire timeout of 0 lets the pool wait without
 * limit; the default then bounds the wait.
 */
export function readinessTimeoutMs(envContent: string): number {
  const configured = Number(readEnvValue(envContent, 'KICI_DB_POOL_ACQUIRE_TIMEOUT_MS'));
  const acquire =
    Number.isFinite(configured) && configured > 0 ? configured : DB_POOL_ACQUIRE_TIMEOUT_DEFAULT_MS;
  return acquire + READINESS_MARGIN_MS;
}

/** Column the values of the orchestrator section start at. */
const VALUE_COLUMN = 12;

/**
 * A `/health` body. Every field is optional: an orchestrator older than this
 * CLI may report fewer of them.
 */
type OrchestratorHealth = Partial<LivenessResponse<OrchestratorLivenessInfo>>;

/** A `/ready` body, which arrives with a 503 when a check fails. */
type OrchestratorReadiness = Partial<ReadinessResponse>;

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

/** `yes` when every readiness check passed, otherwise `no` and the failing checks. */
function formatReadiness(readiness: OrchestratorReadiness): string {
  if (readiness.status === ReadinessStatus.Ready) return 'yes';
  const failing = Object.entries(readiness.checks ?? {})
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return failing.length > 0 ? `no (failing: ${failing.join(', ')})` : 'no';
}

/** Format the status output as a readable table. */
function formatStatus(
  serviceStatus: ServiceStatus,
  health: OrchestratorHealth | null,
  readiness: OrchestratorReadiness | null,
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
    if (health.status) rows.push(['Health', health.status]);
    rows.push([
      'Ready',
      readiness ? formatReadiness(readiness) : 'unknown (/ready did not answer)',
    ]);
    rows.push(...buildInfoRows(health));
    lines.push(...formatHealthSection('--- KiCI orchestrator ---', rows, VALUE_COLUMN));
  } else if (serviceStatus.state === 'running') {
    lines.push('');
    lines.push('(Could not reach health API)');
  }

  return lines.join('\n');
}

/** Build JSON output combining service + health data. */
function buildJsonOutput(
  serviceStatus: ServiceStatus,
  health: OrchestratorHealth | null,
  readiness: OrchestratorReadiness | null,
  serviceName: string,
  configPaths: Record<string, string>,
): Record<string, unknown> {
  return {
    service: serviceName,
    ...serviceStatus,
    configPaths,
    health: health ? hideBuildCommit(health) : undefined,
    readiness: readiness ?? undefined,
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

        let health: OrchestratorHealth | null = null;
        let readiness: OrchestratorReadiness | null = null;
        if (serviceStatus.state === 'running') {
          const endpoint = readLocalEndpoint(envContent, ORCHESTRATOR_DEFAULT_PORT);
          [health, readiness] = await Promise.all([
            fetchLocalJson<OrchestratorHealth>(endpoint, '/health'),
            fetchLocalJson<OrchestratorReadiness>(endpoint, '/ready', {
              acceptStatuses: [503],
              timeoutMs: readinessTimeoutMs(envContent),
            }),
          ]);
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
              buildJsonOutput(serviceStatus, health, readiness, config.name, jsonConfigPaths),
              null,
              2,
            ),
          );
        } else {
          console.log(formatStatus(serviceStatus, health, readiness, config.name));
          console.log('');
          console.log(configPathLines.join('\n'));
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
