/**
 * Key rotation command for kici-admin.
 *
 * Re-encrypts all PG-stored secrets with the current master key.
 */

import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { toErrorMessage } from '@kici-dev/shared';

export function registerRotateCommand(program: Command, getClient: () => AdminApiClient): void {
  program
    .command('rotate-key')
    .description(
      'Rotate the master encryption key (re-encrypts scoped_secrets, config_versions, and secret_backends)',
    )
    .action(async () => {
      try {
        const result = await getClient().rotateKey();
        let msg =
          `Re-encrypted ${result.reEncrypted} secrets, ${result.reEncryptedConfigs} config versions, ` +
          `${result.reEncryptedBackends} secret backend configs.`;
        if (result.skippedConfigs > 0) {
          msg += ` Skipped ${result.skippedConfigs} undecryptable historical config version(s) — check orchestrator logs.`;
        }
        if (result.skippedBackends > 0) {
          msg += ` Skipped ${result.skippedBackends} undecryptable secret backend config(s) — check orchestrator logs.`;
        }
        console.log(msg);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
