/**
 * The options `kici-admin orchestrator upgrade` and `kici-admin agent upgrade`
 * share, in the order `--help` lists them. Each command adds its own after
 * these.
 */

import type { Command } from 'commander';
import { NODE_OPTION_DESCRIPTION } from './node-runtime.js';
import type { ServicePlatform } from '../../service/index.js';

/** The parsed form of {@link addSharedUpgradeOptions}. */
export interface SharedUpgradeCliOptions {
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
  node?: string;
}

/** Add the shared upgrade options to `cmd` and return it for chaining. */
export function addSharedUpgradeOptions(cmd: Command): Command {
  return cmd
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
    .option('--node <path>', NODE_OPTION_DESCRIPTION);
}
