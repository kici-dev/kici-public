/**
 * `kici-admin agent stop` command.
 *
 * Stops the agent service. Target resolution goes through
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

export function registerAgentStop(agent: Command): void {
  agent
    .command('stop')
    .description('Stop the agent service')
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

        await manager.stop(config);
        console.log(`Agent service "${config.name}" stopped.`);
      } catch (err) {
        if (err instanceof InstanceNotFoundError) {
          console.log(`Agent service "${err.instanceName}" is not installed — nothing to stop.`);
          return;
        }
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
