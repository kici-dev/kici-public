/**
 * `kici-admin orchestrator logs` command.
 *
 * Tails and follows service logs with filtering by time, level,
 * and output format. Delegates to the platform-specific service
 * manager's logs() method.
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
  type LogOptions,
  type ServiceConfig,
  type ServicePlatform,
} from '../../service/index.js';
import { toErrorMessage } from '@kici-dev/shared';

interface LogsActionOptions {
  platform?: ServicePlatform;
  name?: string;
  instanceDir?: string;
  system?: boolean;
  userLevel?: boolean;
  since?: string;
  level?: string;
  json?: boolean;
  follow: boolean;
}

export function registerLogsCommand(parent: Command): void {
  parent
    .command('logs')
    .description('Tail and follow orchestrator service logs')
    .option('--platform <type>', 'Service platform (systemd|launchd|windows|compose)')
    .option('--instance-dir <path>', 'Deploy folder of the instance whose logs to read')
    .option('--name <name>', 'Service name (no default — must resolve via flag/CWD)')
    .option('--system', 'Operate against the system-level service (requires root)')
    .option('--user-level', 'Operate against the user-level service')
    .option('--since <duration>', 'Show logs since duration (e.g. 1h, 30m)')
    .option('--level <level>', 'Filter by log level (error|warn|info)')
    .option('--json', 'Output as structured JSON')
    .option('--no-follow', 'Snapshot mode (do not tail)')
    .action(async (opts: LogsActionOptions) => {
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

        const logOptions: LogOptions = {
          since: opts.since,
          level: opts.level as LogOptions['level'],
          json: opts.json,
          follow: opts.follow,
        };

        await manager.logs(config, logOptions);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
