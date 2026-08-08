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
import { toErrorMessage } from '@kici-dev/shared';
import { performVersionedUpgrade } from '../shared/versioned-upgrade.js';
import { runAgentPackageRefresh, parsePlatforms } from '../agent-package.js';
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
        agentPackages?: boolean;
        agentPackagePlatforms?: string;
        nodeMirror?: string;
        npmRegistry?: string;
      }) => {
        await performVersionedUpgrade('orchestrator', opts);
        // Auto-package hook (C9): a version-changing upgrade must refresh the
        // fleet's available agent payloads so the convergence gate finds bytes
        // for the new version. --rollback/--cleanup/--pick don't advance the
        // running version, so packaging then is an idempotent no-op (the version
        // is already present) — safe to always attempt. --no-agent-packages
        // opts out for operators who publish payloads out-of-band.
        if (opts.agentPackages === false) return;
        try {
          await runAgentPackageRefresh({
            ...(opts.agentPackagePlatforms
              ? { platforms: parsePlatforms(opts.agentPackagePlatforms) }
              : {}),
            ...(opts.nodeMirror ? { nodeMirror: opts.nodeMirror } : {}),
            ...(opts.npmRegistry ? { npmRegistry: opts.npmRegistry } : {}),
          });
        } catch (err) {
          // Non-fatal to the (already-completed) orchestrator upgrade.
          console.error(
            `[agent package refresh] failed (orchestrator upgrade itself succeeded): ${toErrorMessage(err)}`,
          );
          console.error(
            'Run `kici-admin agent package --upload` manually to refresh the fleet payloads.',
          );
          process.exitCode = 1;
        }
      },
    );
}
