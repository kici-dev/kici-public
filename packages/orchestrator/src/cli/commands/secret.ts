/**
 * Secret management commands for kici-admin.
 *
 * Provides scoped secret operations:
 *   secret scopes, list, set, delete
 *
 * Secret values are write-only -- there is no "get value" command.
 */

import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { setEnvironmentSecretDirect, toErrorMessage } from '@kici-dev/shared';
import { resolveSecretInput, fingerprintValue } from './shared/secret-input.js';

function resolveDirectDbUrl(explicit?: string): string | null {
  return explicit ?? process.env.KICI_DATABASE_URL ?? null;
}

export function registerSecretCommands(program: Command, getClient: () => AdminApiClient): void {
  const sec = program.command('secret').description('Manage scoped secrets');

  sec
    .command('scopes <orgId>')
    .description('List secret scopes for an organization')
    .action(async (orgId: string) => {
      try {
        const { scopes } = await getClient().listScopes(orgId);
        if (scopes.length === 0) {
          console.log('No scopes found.');
          return;
        }
        for (const scope of scopes) {
          console.log(`  - ${scope}`);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  sec
    .command('list <orgId> <scope>')
    .description('List secret key names in a scope (values are never shown)')
    .action(async (orgId: string, scope: string) => {
      try {
        const { keys } = await getClient().listKeys(orgId, scope);
        if (keys.length === 0) {
          console.log('No secrets found in this scope.');
          return;
        }
        for (const key of keys) {
          console.log(`  - ${key}`);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  sec
    .command('set [orgId] [scope] [key]')
    .description(
      'Set a secret value. Positional form: "set <orgId> <scope> <key>". ' +
        'Sugar form (environment scope): "set --org <id> --environment <env> --key <k>". ' +
        'Value comes from one of: --prompt (default on TTY), --from-stdin (default on pipe), ' +
        '--from-file <path>, --from-env <VAR>, --value <plaintext> (discouraged).',
    )
    .option('--value <value>', 'Secret value via argv (visible in shell history; prefer --prompt)')
    .option(
      '--org <orgId>',
      'Org ID (use with --environment + --key; mutually exclusive with positional form)',
    )
    .option(
      '--environment <name>',
      'Environment scope — sugar for positional <scope>. Requires --org and --key.',
    )
    .option('--key <key>', 'Secret key name (use with --org + --environment)')
    .option('--prompt', 'Interactive no-echo prompt (requires TTY)')
    .option('--from-stdin', 'Read value from piped stdin until EOF')
    .option('--from-file <path>', 'Read value from a file (trailing newline trimmed)')
    .option('--from-env <var>', 'Read value from a named environment variable')
    .option('--no-trim', 'When reading --from-file, keep the trailing newline (default: trim once)')
    .option(
      '--confirm-fingerprint <sha256hex>',
      'Refuse the write unless SHA-256(value) matches this 64-hex string',
    )
    .option('--dry-run', 'Parse + validate the value, print fingerprint + length, do not write')
    .option(
      '--database-url <url>',
      'Direct-DB mode: write encrypted_value verbatim to scoped_secrets (offline; skips HTTP + encryption)',
    )
    .action(
      async (
        posOrgId: string | undefined,
        posScope: string | undefined,
        posKey: string | undefined,
        opts: {
          value?: string;
          databaseUrl?: string;
          org?: string;
          environment?: string;
          key?: string;
          prompt?: boolean;
          fromStdin?: boolean;
          fromFile?: string;
          fromEnv?: string;
          trim?: boolean;
          confirmFingerprint?: string;
          dryRun?: boolean;
        },
      ) => {
        try {
          // Resolve (orgId, scope, key) from positional OR sugar form.
          const hasPositional = Boolean(posOrgId || posScope || posKey);
          const hasSugar = Boolean(opts.org || opts.environment || opts.key);
          if (hasPositional && hasSugar) {
            throw new Error(
              'Cannot mix positional <orgId> <scope> <key> form with --org/--environment/--key flags. Pick one.',
            );
          }
          let orgId: string;
          let scope: string;
          let key: string;
          if (hasSugar) {
            if (!opts.org) throw new Error('--org is required when using --environment sugar form');
            if (!opts.environment) {
              throw new Error('--environment is required in sugar form (use --environment <name>)');
            }
            if (!opts.key) throw new Error('--key is required when using --environment sugar form');
            orgId = opts.org;
            scope = opts.environment;
            key = opts.key;
          } else {
            if (!posOrgId || !posScope || !posKey) {
              throw new Error(
                'Missing arguments: supply either <orgId> <scope> <key> positionally, or --org + --environment + --key.',
              );
            }
            orgId = posOrgId;
            scope = posScope;
            key = posKey;
          }

          const { value, source } = await resolveSecretInput(opts);

          if (opts.dryRun) {
            console.log(
              `[dry-run] would set secret '${key}' in scope '${scope}' for org ${orgId} ` +
                `(${value.length} chars, source=${source}, sha256=${fingerprintValue(value)})`,
            );
            return;
          }

          const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
          if (dbUrl) {
            await setEnvironmentSecretDirect(dbUrl, {
              orgId,
              environment: scope,
              key,
              encryptedValue: value,
            });
            console.log(`Secret '${key}' set in scope '${scope}' for org ${orgId} (direct).`);
          } else {
            await getClient().setSecret(orgId, scope, key, value);
            console.log(`Secret '${key}' set in scope '${scope}' for org ${orgId}.`);
          }
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );

  sec
    .command('delete <orgId> <scope> <key>')
    .description('Delete a secret')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (orgId: string, scope: string, key: string, opts: { yes?: boolean }) => {
      try {
        if (!opts.yes) {
          const confirmed = await confirm(
            `Are you sure you want to delete secret '${key}' from scope '${scope}'?`,
          );
          if (!confirmed) {
            console.log('Aborted.');
            return;
          }
        }
        await getClient().deleteSecret(orgId, scope, key);
        console.log(`Secret '${key}' deleted from scope '${scope}' for org ${orgId}.`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

async function confirm(message: string): Promise<boolean> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}
