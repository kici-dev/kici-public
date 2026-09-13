import type { Command } from 'commander';
import {
  provisionBridge,
  type FirecrackerBridgeConfig,
} from '../../../firecracker/host-network.js';
import { installPersist } from '../../../firecracker/persist.js';
import { toErrorMessage } from '@kici-dev/shared';

export interface ProvisionOptions {
  bridge: string;
  cidr?: string;
  table?: string;
  hostIface?: string;
  persist?: boolean;
  sudo?: boolean;
}

export function optionsToConfig(opts: ProvisionOptions): FirecrackerBridgeConfig {
  if (!opts.cidr) throw new Error('--cidr <gateway/prefix> is required');
  return {
    bridgeName: opts.bridge,
    bridgeCidr: opts.cidr,
    table: opts.table ?? 'kici',
    hostIface: opts.hostIface,
  };
}

export function registerProvision(group: Command): void {
  group
    .command('provision')
    .description('Create/heal a Firecracker host bridge (NAT + egress isolation)')
    .requiredOption('--bridge <name>', 'bridge interface name (e.g. kici-br0)')
    .requiredOption('--cidr <cidr>', 'gateway IP + prefix (e.g. 10.0.0.1/24)')
    .option('--table <name>', 'nft table name', 'kici')
    .option('--host-iface <iface>', 'NAT egress interface (auto-detected if omitted)')
    .option('--persist', 'install a systemd oneshot so the bridge survives reboot')
    .option('--sudo', 'wrap privileged commands with sudo -n (non-root host)')
    .action(async (opts: ProvisionOptions) => {
      try {
        const cfg = optionsToConfig(opts);
        await provisionBridge(cfg, { requireSudo: opts.sudo });
        if (opts.persist) await installPersist(cfg, { requireSudo: opts.sudo });
        console.log(
          `Firecracker bridge ${cfg.bridgeName} provisioned${opts.persist ? ' + persisted' : ''}.`,
        );
      } catch (err) {
        console.error(`firecracker provision failed: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
