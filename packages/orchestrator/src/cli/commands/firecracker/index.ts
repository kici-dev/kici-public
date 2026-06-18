/**
 * `kici-admin firecracker` command group.
 *
 * Local host-networking ops for the orchestrator's Firecracker scaler:
 * provision/verify/teardown the per-coordinator bridge + nft table, with
 * --persist for reboot survival. These run directly on the host (privileged
 * `ip`/`nft`/`systemctl`) and do NOT use the admin HTTP client.
 */
import type { Command } from 'commander';
import { registerProvision } from './provision.js';
import { registerVerify } from './verify.js';
import { registerTeardown } from './teardown.js';

export function registerFirecrackerCommands(program: Command): void {
  const group = program
    .command('firecracker')
    .description('Provision and verify Firecracker host networking');
  registerProvision(group);
  registerVerify(group);
  registerTeardown(group);
}
