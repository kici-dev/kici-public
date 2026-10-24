/**
 * `kici-admin agent upgrade`: the versioned-directory upgrade
 * (`performVersionedUpgrade`), with no database migrations because agents are
 * stateless. `--name` has no default: the target resolves from
 * `--instance-dir`, `--name`, or the CWD `./.kici-agent.json`.
 */

import type { Command } from 'commander';
import { performVersionedUpgrade } from '../shared/versioned-upgrade.js';
import {
  addSharedUpgradeOptions,
  type SharedUpgradeCliOptions,
} from '../shared/upgrade-command-options.js';

export function registerAgentUpgradeCommand(parent: Command): void {
  addSharedUpgradeOptions(
    parent
      .command('upgrade')
      .description('Upgrade agent to a new version using versioned directory layout'),
  ).action(async (opts: SharedUpgradeCliOptions) => {
    await performVersionedUpgrade('agent', opts);
  });
}
