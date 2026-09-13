/**
 * `kici-admin orchestrator stop` command.
 *
 * Stops the orchestrator service. Target resolution goes through
 * resolveInstanceTarget — the same priority chain every lifecycle command uses
 * (--instance-dir > --name > CWD manifest > refusal with candidate list).
 * `--name` has no default; every invocation must resolve via one of the
 * above paths.
 */

import type { Command } from 'commander';
import {
  InstanceNotFoundError,
  kiciConfigRoot,
  resolveInstanceTarget,
  resolveUserLevel,
  DEFAULT_RESTART_POLICY,
} from '../../service/index.js';
import type { ServiceConfig, ServicePlatform } from '../../service/index.js';
import { toErrorMessage } from '@kici-dev/shared';

interface StopOptions {
  platform?: ServicePlatform;
  name?: string;
  instanceDir?: string;
  system?: boolean;
  userLevel?: boolean;
}

export function registerOrchestratorStop(orchestrator: Command): void {
  orchestrator
    .command('stop')
    .description('Stop the orchestrator service')
    .option(
      '--platform <type>',
      'Force the service platform (systemd, launchd, windows, compose). Default: the platform in the install manifest',
    )
    .option('--instance-dir <path>', 'Deploy folder of the instance to stop')
    .option('--name <name>', 'Service name (no default — must resolve via flag/CWD)')
    .option('--system', 'Operate against the system-level service (requires root)')
    .option('--user-level', 'Operate against the user-level service')
    .action(async (opts: StopOptions) => {
      try {
        const userLevel = resolveUserLevel(opts);
        const kiciRoot = kiciConfigRoot(userLevel);

        const { resolved, manager } = await resolveInstanceTarget({
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

        await manager.stop(config);
        console.log(`Orchestrator service "${config.name}" stopped.`);
      } catch (err) {
        if (err instanceof InstanceNotFoundError) {
          console.log(
            `Orchestrator service "${err.instanceName}" is not installed — nothing to stop.`,
          );
          return;
        }
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
