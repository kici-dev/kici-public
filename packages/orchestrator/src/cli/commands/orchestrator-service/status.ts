/**
 * `kici-admin orchestrator status`: OS-level service state plus the running
 * orchestrator's `/health` and `/ready`, and, with an admin token (`--token` /
 * KICI_ADMIN_TOKEN), the Platform org from the instance's admin API. Targets
 * resolve through resolveInstanceTarget, like every lifecycle command.
 */

import type { Command } from 'commander';
import {
  kiciConfigRoot,
  resolveInstanceTarget,
  resolveUserLevel,
  DEFAULT_RESTART_POLICY,
  type LaunchSpec,
  type ServiceConfig,
  type ServicePlatform,
  type ServiceStatus,
} from '../../service/index.js';
import { agentBinaryFromLaunch, isExecutableFile } from '../../../scaler/agent-binary-location.js';
import { composeFilePath } from '../../service/compose-path.js';
import { readEnvValue } from '../../service/backup-timer.js';
import {
  formatUptime,
  ReadinessStatus,
  type LivenessResponse,
  type ReadinessResponse,
} from '@kici-dev/shared';
import { ORCHESTRATOR_DEFAULT_PORT } from '@kici-dev/shared/env';
import { DB_POOL_ACQUIRE_TIMEOUT_DEFAULT_MS } from '../../../config.js';
import type { OrchestratorLivenessInfo } from '../../../routes/health.js';
import {
  foreignSourceOrgs,
  ORG_LIST_PATH,
  PlatformAttachment,
  type OrgListResponse,
} from '../../../db/repos/org-ids-repo.js';
import {
  buildInfoRows,
  fetchLocalJson,
  formatHealthSection,
  readEnvContent,
  readLocalEndpoint,
  requestLocalJson,
  type LocalEndpoint,
  type StatusRow,
} from '../service-health.js';
import { cliAction } from '../shared/cli-action.js';

/** Time `/ready` gets beyond the database-pool acquire timeout, for its query and its response. */
const READINESS_MARGIN_MS = 3000;

/**
 * `/ready`'s database check waits up to the pool acquire timeout, so the wait
 * covers that plus a margin. An acquire timeout of 0 (unbounded) falls back to
 * the default.
 */
export function readinessTimeoutMs(envContent: string): number {
  const configured = Number(readEnvValue(envContent, 'KICI_DB_POOL_ACQUIRE_TIMEOUT_MS'));
  const acquire =
    Number.isFinite(configured) && configured > 0 ? configured : DB_POOL_ACQUIRE_TIMEOUT_DEFAULT_MS;
  return acquire + READINESS_MARGIN_MS;
}

/** Column the values of the orchestrator section start at. */
const VALUE_COLUMN = 12;

/** Every field is optional: an orchestrator older than this CLI may report fewer. */
type OrchestratorHealth = Partial<LivenessResponse<OrchestratorLivenessInfo>>;

/** A `/ready` body, which arrives with a 503 when a check fails. */
type OrchestratorReadiness = Partial<ReadinessResponse>;

/** By path first, directory second. */
function readScalerConfig(envContent: string): string | undefined {
  return (
    readEnvValue(envContent, 'KICI_SCALER_CONFIG_PATH') ??
    readEnvValue(envContent, 'KICI_SCALER_CONFIG_DIR')
  );
}

/**
 * The install's config files, from the manifest and env file on disk, so a
 * stopped service answers too. No existence check: for a compose install it
 * would have to run against the container, blanking the answer.
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

interface AgentBinary {
  path: string;
  installed: boolean;
}

/**
 * The `kici-agent` beside the launch command's runtime: the path for a
 * bare-metal scaler's `binaryPath`. Null without a `kici-admin` npm install
 * (an archive install or a standalone package).
 */
function resolveAgentBinary(spec: LaunchSpec | null, windows: boolean): AgentBinary | null {
  const agent = spec ? agentBinaryFromLaunch(spec, windows) : null;
  return agent ? { path: agent, installed: isExecutableFile(agent) } : null;
}

function formatAgentBinaryLine(agent: AgentBinary): string {
  return `Agent binary:  ${agent.path}${agent.installed ? '' : ' (not installed)'}`;
}

type StatusOrg =
  | {
      platformAttachment: PlatformAttachment;
      attachedOrgId: string | null;
      /** Orgs other than the attached one that hold a source; see {@link foreignSourceOrgs}. */
      foreignSourceOrgs: string[];
    }
  | { platformAttachment: 'unknown'; reason: string };

/** Needs an admin token: the org is never read from the unauthenticated `/health`. */
async function readStatusOrg(
  endpoint: LocalEndpoint,
  token: string | undefined,
): Promise<StatusOrg> {
  if (!token) {
    return {
      platformAttachment: 'unknown',
      reason: 'pass --token or set KICI_ADMIN_TOKEN to read it',
    };
  }
  const result = await requestLocalJson<OrgListResponse>(endpoint, ORG_LIST_PATH, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (result.kind === 'no-answer') {
    return { platformAttachment: 'unknown', reason: 'the admin API did not answer' };
  }
  if (result.kind === 'http-error') {
    return {
      platformAttachment: 'unknown',
      reason:
        result.status === 404
          ? 'this orchestrator predates the org listing'
          : `the admin API answered HTTP ${result.status}`,
    };
  }
  const { platformAttachment, attachedOrgId } = result.body;
  if (!platformAttachment) {
    return { platformAttachment: 'unknown', reason: 'the admin API did not report an attachment' };
  }
  return {
    platformAttachment,
    attachedOrgId: attachedOrgId ?? null,
    foreignSourceOrgs: foreignSourceOrgs(result.body),
  };
}

/** The `Other orgs` row, printed only when a source sits outside the attached org. */
function formatSourceOrgsRow(org: StatusOrg): StatusRow | null {
  if (!('foreignSourceOrgs' in org) || org.foreignSourceOrgs.length === 0) return null;
  const one = org.foreignSourceOrgs.length === 1;
  return [
    'Other orgs',
    `${org.foreignSourceOrgs.join(', ')} also ${one ? 'holds' : 'hold'} sources; their runs ` +
      `use ${one ? "that org's" : "those orgs'"} contexts, secrets and trust policy ` +
      '(kici-admin source list)',
  ];
}

function formatOrgRow(org: StatusOrg): StatusRow {
  switch (org.platformAttachment) {
    case PlatformAttachment.enum.attached:
      return ['Org', `${org.attachedOrgId} (attached to the Platform)`];
    case PlatformAttachment.enum.pending:
      return ['Org', 'unknown (not yet authenticated with the Platform)'];
    case PlatformAttachment.enum.none:
      return ['Org', 'none (independent orchestrator; kici-admin org list shows its org ids)'];
    default:
      return ['Org', `unknown (${org.reason})`];
  }
}

/** `yes` when every readiness check passed, otherwise `no` and the failing checks. */
function formatReadiness(readiness: OrchestratorReadiness): string {
  if (readiness.status === ReadinessStatus.Ready) return 'yes';
  const failing = Object.entries(readiness.checks ?? {})
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return failing.length > 0 ? `no (failing: ${failing.join(', ')})` : 'no';
}

function formatStatus(
  serviceStatus: ServiceStatus,
  health: OrchestratorHealth | null,
  readiness: OrchestratorReadiness | null,
  org: StatusOrg | null,
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
    if (org) {
      rows.push(formatOrgRow(org));
      const sourceOrgs = formatSourceOrgsRow(org);
      if (sourceOrgs) rows.push(sourceOrgs);
    }
    rows.push(...buildInfoRows(health));
    lines.push(...formatHealthSection('--- KiCI orchestrator ---', rows, VALUE_COLUMN));
  } else if (serviceStatus.state === 'running') {
    lines.push('');
    lines.push('(Could not reach health API)');
  }

  return lines.join('\n');
}

function buildJsonOutput(
  serviceStatus: ServiceStatus,
  health: OrchestratorHealth | null,
  readiness: OrchestratorReadiness | null,
  org: StatusOrg | null,
  serviceName: string,
  configPaths: Record<string, string>,
  agentBinary: AgentBinary | null,
): Record<string, unknown> {
  return {
    service: serviceName,
    ...serviceStatus,
    configPaths,
    agentBinary: agentBinary ?? undefined,
    health: health ?? undefined,
    readiness: readiness ?? undefined,
    org: org ?? undefined,
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
    .action(
      cliAction(async (opts: StatusOptions, cmd: Command) => {
        const userLevel = resolveUserLevel(opts);
        const kiciRoot = kiciConfigRoot(userLevel);

        // Report paths off the seam's resolved platform (`--platform`, else the
        // manifest's), the one `manager` speaks. The manifest would name a
        // compose file under `--platform systemd`; the host's `detectPlatform`
        // says systemd on any systemd Linux, even for a compose install.
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

        // A compose service runs its agents from the image, not from a host runtime.
        const agentBinary =
          installPlatform === 'compose'
            ? null
            : resolveAgentBinary(
                await manager.readLaunchSpec(config).catch(() => null),
                installPlatform === 'windows',
              );

        let health: OrchestratorHealth | null = null;
        let readiness: OrchestratorReadiness | null = null;
        let org: StatusOrg | null = null;
        if (serviceStatus.state === 'running') {
          const endpoint = readLocalEndpoint(envContent, ORCHESTRATOR_DEFAULT_PORT);
          // The root --token / KICI_ADMIN_TOKEN goes only to this instance's
          // own endpoint, never to the global --url.
          const token = cmd.optsWithGlobals<{ token?: string }>().token;
          [health, readiness, org] = await Promise.all([
            fetchLocalJson<OrchestratorHealth>(endpoint, '/health'),
            fetchLocalJson<OrchestratorReadiness>(endpoint, '/ready', {
              acceptStatuses: [503],
              timeoutMs: readinessTimeoutMs(envContent),
            }),
            readStatusOrg(endpoint, token),
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
              buildJsonOutput(
                serviceStatus,
                health,
                readiness,
                org,
                config.name,
                jsonConfigPaths,
                agentBinary,
              ),
              null,
              2,
            ),
          );
        } else {
          console.log(formatStatus(serviceStatus, health, readiness, org, config.name));
          console.log('');
          console.log(configPathLines.join('\n'));
          if (agentBinary) console.log(formatAgentBinaryLine(agentBinary));
        }
      }),
    );
}
