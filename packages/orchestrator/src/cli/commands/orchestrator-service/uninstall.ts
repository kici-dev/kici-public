/**
 * `kici-admin orchestrator uninstall` command.
 *
 * Removes the orchestrator service registration. Target resolution goes
 * through resolveInstance — the same priority chain every lifecycle command
 * uses (--instance-dir > --name > CWD manifest > refusal with candidate list).
 * The manifest stays on disk so subsequent commands can still reference the
 * deploy folder; the host-wide index entry is dropped unconditionally so a
 * stale row never lingers after the unit is gone.
 */

import type { Command } from 'commander';
import {
  createServiceManager,
  detectPlatform,
  kiciConfigRoot,
  removeIndexEntry,
  resolveInstance,
  resolveUserLevel,
  DEFAULT_RESTART_POLICY,
} from '../../service/index.js';
import type { ServiceConfig, ServicePlatform } from '../../service/index.js';
import { toErrorMessage } from '@kici-dev/shared';

interface UninstallOptions {
  platform?: ServicePlatform;
  name?: string;
  instanceDir?: string;
  system?: boolean;
  userLevel?: boolean;
}

export function registerOrchestratorUninstall(orchestrator: Command): void {
  orchestrator
    .command('uninstall')
    .description('Remove the orchestrator service registration')
    .option('--platform <type>', 'Service platform (systemd, launchd, windows, compose)')
    .option('--instance-dir <path>', 'Deploy folder of the instance to uninstall')
    .option('--name <name>', 'Service name (no default — must resolve via flag/CWD)')
    .option('--system', 'Operate against the system-level service (requires root)')
    .option('--user-level', 'Operate against the user-level service')
    .action(async (opts: UninstallOptions) => {
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

        const installed = await manager.isInstalled(config);
        if (!installed) {
          console.log(`Service "${config.name}" is not installed.`);
        } else {
          try {
            const status = await manager.status(config);
            if (status.state === 'running') {
              console.log(`Stopping service "${config.name}"...`);
              await manager.stop(config);
            }
          } catch {
            // proceed with uninstall even if status/stop failed
          }
          await manager.uninstall(config);
        }

        // Always drop the index entry — even for already-uninstalled services.
        removeIndexEntry(kiciRoot, { component: 'orchestrator', name: config.name });

        console.log(`\nOrchestrator service "${config.name}" uninstalled.`);
        console.log(
          `Manifest preserved at ${resolved.manifestPath} — delete manually if no longer needed.`,
        );
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
