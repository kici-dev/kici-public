import type { Command } from 'commander';
import { teardownBridge } from '../../../firecracker/host-network.js';
import { optionsToConfig, type ProvisionOptions } from './provision.js';

export function registerTeardown(group: Command): void {
  group
    .command('teardown')
    .description('Remove a Firecracker host bridge + its nft table (leaves NM conf in place)')
    .requiredOption('--bridge <name>', 'bridge interface name')
    .option('--cidr <cidr>', 'gateway IP + prefix (unused but accepted for symmetry)', '0.0.0.0/0')
    .option('--table <name>', 'nft table name', 'kici')
    .option('--sudo', 'wrap privileged commands with sudo -n')
    .action(async (opts: ProvisionOptions) => {
      await teardownBridge(optionsToConfig(opts), { requireSudo: opts.sudo });
      console.log(`Firecracker bridge ${opts.bridge} torn down.`);
    });
}
