/**
 * `kici-admin firecracker`: provisions, verifies and tears down the Firecracker
 * scaler's per-coordinator bridge and nft table (--persist survives reboots).
 * Runs on the host with privileged `ip`/`nft`/`systemctl`, NOT the admin HTTP client.
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
