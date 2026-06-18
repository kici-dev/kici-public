/**
 * `kici-admin orchestrator upgrade` command.
 *
 * Upgrades the orchestrator using the versioned directory layout:
 * - Extracts new version alongside old versions
 * - Updates symlink (Unix) or service registration (Windows) atomically
 * - Preserves old versions for rollback
 * - Supports --cleanup and --rollback flags
 *
 * Targeting is folder-anchored: the resolution priority is
 *   1. `--instance-dir <path>`
 *   2. `--name <name>`
 *   3. CWD manifest (`./.kici-orchestrator.json`)
 *   4. otherwise refuses with a candidate-list error.
 *
 * `--name` no longer has a default — every invocation must resolve via one
 * of the above paths.
 */

import type { Command } from 'commander';
import { performVersionedUpgrade } from '../shared/versioned-upgrade.js';
import type { ServicePlatform } from '../../service/index.js';

export function registerUpgradeCommand(parent: Command): void {
  parent
    .command('upgrade')
    .description('Upgrade orchestrator to a new version using versioned directory layout')
    .option('--platform <type>', 'Service platform (systemd|launchd|windows|compose)')
    .option('--instance-dir <path>', 'Deploy folder of the instance to upgrade')
    .option('--name <name>', 'Service name (no default — must resolve via flag/CWD)')
    .option('--from <path>', 'Path to package archive (.tar.gz or .zip)')
    .option('--url <url>', 'URL to download package archive from')
    .option('--version <version>', 'Target version string (e.g., 0.3.0)')
    .option('--yes', 'Skip confirmation prompt')
    .option('--force', 'Overwrite existing versioned directory')
    .option('--cleanup', 'Remove old versions (keeps current and previous)')
    .option('--rollback', 'Roll back to the previous version')
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
      }) => {
        await performVersionedUpgrade('orchestrator', opts);
      },
    );
}
