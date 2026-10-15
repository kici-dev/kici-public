/**
 * `kici-admin agent upgrade`: the versioned-directory upgrade
 * (`performVersionedUpgrade`), with no database migrations because agents are
 * stateless. `--name` has no default: the target resolves from
 * `--instance-dir`, `--name`, or the CWD `./.kici-agent.json`.
 */

import type { Command } from 'commander';
import { performVersionedUpgrade } from '../shared/versioned-upgrade.js';
import type { ServicePlatform } from '../../service/index.js';

export function registerAgentUpgradeCommand(parent: Command): void {
  parent
    .command('upgrade')
    .description('Upgrade agent to a new version using versioned directory layout')
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
      }) => {
        await performVersionedUpgrade('agent', opts);
      },
    );
}
