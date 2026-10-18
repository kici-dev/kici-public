/**
 * `kici-admin orchestrator upgrade`: versioned directory layout. The new version
 * is extracted beside the old ones (kept for rollback) and the symlink (Unix) or
 * service registration (Windows) is switched atomically.
 *
 * Targeting is folder-anchored, in priority order: `--instance-dir`, `--name`
 * (no default), the CWD manifest (`./.kici-orchestrator.json`); otherwise it
 * refuses with a candidate list.
 */

import type { Command } from 'commander';
import { toErrorMessage } from '@kici-dev/shared';
import { performVersionedUpgrade } from '../shared/versioned-upgrade.js';
import { buildUpgradeHooks } from '../shared/upgrade-hooks.js';
import type { AdminApiClient } from '../../api-client.js';
import { runAgentPackageRefresh, parsePlatforms, storageEnvFromEnvFile } from '../agent-package.js';
import type { ServicePlatform } from '../../service/index.js';

export function registerUpgradeCommand(
  parent: Command,
  tryGetClient: () => AdminApiClient | null,
): void {
  parent
    .command('upgrade')
    .description('Upgrade orchestrator to a new version using versioned directory layout')
    .option(
      '--platform <type>',
      'Force the service platform (systemd, launchd, windows, compose). Default: the platform in the install manifest',
    )
    .option('--instance-dir <path>', 'Deploy folder of the instance to upgrade')
    .option('--name <name>', 'Service name (no default — must resolve via flag/CWD)')
    .option('--from <path>', 'Path to package archive (.tar.gz or .zip)')
    .option('--url <url>', 'URL to download package archive from')
    .option('--version <version>', 'Target version string (e.g., 0.3.0)')
    .option('--yes', 'Skip confirmation prompt')
    .option('--force', 'Overwrite existing versioned directory')
    .option('--cleanup', 'Remove old versions (keeps current and previous)')
    .option('--rollback', 'Roll back to the previous version')
    .option('--pick', 'Interactively pick an installed version to activate')
    .option(
      '--restart-only',
      'Restart the already-installed package without installing (skip self-drive)',
    )
    .option(
      '--no-agent-packages',
      'Skip auto-producing + uploading the fleet agent payloads for the new version',
    )
    .option(
      '--agent-package-platforms <list>',
      'Override the fleet platform set to (re)package: single | CSV | all (default: discover from the cache bucket)',
    )
    .option('--skip-backup', 'Skip the pre-upgrade database dump (loud; no recovery path)')
    .option(
      '--backup-dir <path>',
      'Where the pre-upgrade dump goes (default <instanceDir>/backups)',
    )
    .option('--no-drain', 'Do not quiesce the coordinator first; in-flight jobs will fail')
    .option('--drain-timeout <seconds>', 'Seconds to wait for in-flight jobs to finish', '300')
    .option(
      '--migrate-down',
      "On a rollback whose database is ahead, revert the schema to the target version's " +
        'recorded head first, through the still-running newer service',
    )
    .option(
      '--skip-binary-path-check',
      'Upgrade even when a bare-metal scaler binaryPath is not an executable kici-agent (missing, not executable, or a version-manager shim); the restarted service will not start until it is fixed',
    )
    .option('--node-mirror <url>', 'nodejs.org mirror override for the agent package build')
    .option('--npm-registry <url>', 'npm registry override for the agent package build')
    .action(
      async (opts: {
        platform?: ServicePlatform;
        instanceDir?: string;
        name?: string;
        from?: string;
        url?: string;
        version?: string;
        yes?: boolean;
        force?: boolean;
        cleanup?: boolean;
        rollback?: boolean;
        pick?: boolean;
        restartOnly?: boolean;
        skipBackup?: boolean;
        backupDir?: string;
        drain?: boolean;
        drainTimeout?: string;
        migrateDown?: boolean;
        agentPackages?: boolean;
        agentPackagePlatforms?: string;
        nodeMirror?: string;
        npmRegistry?: string;
        skipBinaryPathCheck?: boolean;
      }) => {
        // Commander turns `--no-drain` into `drain: false`; the shared options take `noDrain`.
        const instance = await performVersionedUpgrade(
          'orchestrator',
          { ...opts, noDrain: opts.drain === false },
          buildUpgradeHooks(tryGetClient),
        );
        // A version-changing upgrade refreshes the fleet's agent payloads so the
        // convergence gate finds bytes for the new version. For --rollback,
        // --cleanup and --pick it is an idempotent no-op, so it always runs.
        // --no-agent-packages is for operators who publish payloads out-of-band.
        if (opts.agentPackages === false) return;
        // The storage config is the instance's own: the env file its service
        // runs with on every platform, not the shell that runs the upgrade.
        const { envFilePath } = instance.manifest;
        try {
          await runAgentPackageRefresh({
            storageEnv: storageEnvFromEnvFile(envFilePath),
            ...(opts.agentPackagePlatforms
              ? { platforms: parsePlatforms(opts.agentPackagePlatforms) }
              : {}),
            ...(opts.nodeMirror ? { nodeMirror: opts.nodeMirror } : {}),
            ...(opts.npmRegistry ? { npmRegistry: opts.npmRegistry } : {}),
          });
        } catch (err) {
          console.error(
            `[agent package refresh] failed (orchestrator upgrade itself succeeded): ${toErrorMessage(err)}`,
          );
          console.error(
            `Run \`kici-admin agent package --upload --env-file ${envFilePath}\` manually ` +
              'to refresh the fleet payloads.',
          );
          process.exitCode = 1;
        }
      },
    );
}
