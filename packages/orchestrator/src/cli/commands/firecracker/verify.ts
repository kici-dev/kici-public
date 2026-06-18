import type { Command } from 'commander';
import { verifyBridge } from '../../../firecracker/host-network.js';
import { optionsToConfig, type ProvisionOptions } from './provision.js';

export function registerVerify(group: Command): void {
  group
    .command('verify')
    .description('Check a Firecracker host bridge is up with its addr + nft table')
    .requiredOption('--bridge <name>', 'bridge interface name')
    .requiredOption('--cidr <cidr>', 'gateway IP + prefix')
    .option('--table <name>', 'nft table name', 'kici')
    .option('--sudo', 'wrap privileged commands with sudo -n')
    .action(async (opts: ProvisionOptions) => {
      const cfg = optionsToConfig(opts);
      const h = await verifyBridge(cfg, { requireSudo: opts.sudo });
      if (h.healthy) {
        console.log(`OK: ${cfg.bridgeName} healthy (${cfg.bridgeCidr}, table ${cfg.table})`);
        return;
      }
      console.error(`UNHEALTHY: ${cfg.bridgeName}: ${h.detail}`);
      process.exit(1);
    });
}
