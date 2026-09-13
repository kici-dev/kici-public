/**
 * Key rotation command for kici-admin.
 *
 * Re-encrypts every master-key-wrapped store with the current master key.
 */

import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { toErrorMessage } from '@kici-dev/shared';

/** Every store `rotate-key` sweeps, in the order the summary reports them. */
const STORES: ReadonlyArray<{
  label: string;
  reEncrypted: (r: RotateKeyResult) => number;
  skipped: (r: RotateKeyResult) => number;
}> = [
  { label: 'secrets', reEncrypted: (r) => r.reEncrypted, skipped: () => 0 },
  {
    label: 'config versions',
    reEncrypted: (r) => r.reEncryptedConfigs,
    skipped: (r) => r.skippedConfigs,
  },
  {
    label: 'secret backend configs',
    reEncrypted: (r) => r.reEncryptedBackends,
    skipped: (r) => r.skippedBackends,
  },
  {
    label: 'provenance signing keys',
    reEncrypted: (r) => r.reEncryptedSigningKeys,
    skipped: (r) => r.skippedSigningKeys,
  },
  {
    label: 'dashboard encryption keys',
    reEncrypted: (r) => r.reEncryptedDashboardKeys,
    skipped: (r) => r.skippedDashboardKeys,
  },
  {
    label: 'run ephemeral keys',
    reEncrypted: (r) => r.reEncryptedEphemeralKeys,
    skipped: (r) => r.skippedEphemeralKeys,
  },
  {
    label: 'run secret outputs',
    reEncrypted: (r) => r.reEncryptedSecretOutputs,
    skipped: (r) => r.skippedSecretOutputs,
  },
];

type RotateKeyResult = Awaited<ReturnType<AdminApiClient['rotateKey']>>;

export function registerRotateCommand(program: Command, getClient: () => AdminApiClient): void {
  program
    .command('rotate-key')
    .description(
      'Rotate the master encryption key (re-encrypts every master-key-wrapped store: ' +
        'scoped_secrets, config_versions, secret_backends, orchestrator_signing_keys, ' +
        'dashboard_encryption_keys, run_ephemeral_keys and run_secret_outputs)',
    )
    .action(async () => {
      try {
        const result = await getClient().rotateKey();
        for (const store of STORES) {
          console.log(`Re-encrypted ${store.reEncrypted(result)} ${store.label}.`);
        }
        // A non-zero skip is the operator's signal that a row opened under
        // neither key: it is still sealed under a generation nobody supplied,
        // and dropping the old key now would lose it for good.
        const skipped = STORES.filter((s) => s.skipped(result) > 0);
        for (const store of skipped) {
          console.log(
            `Skipped ${store.skipped(result)} undecryptable ${store.label} — check orchestrator logs.`,
          );
        }
        if (skipped.length > 0) {
          console.log(
            'Do NOT drop KICI_SECRET_KEY_OLD while any store reports a skip: those rows are ' +
              'sealed under a key that is no longer configured.',
          );
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
