/** `kici-admin secret`: scoped secrets. Values are write-only; there is no "get value" command. */

import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { resolveSecretInput, fingerprintValue } from './shared/secret-input.js';
import { warnIfContextUnbound } from './shared/unbound-context-warning.js';
import { confirmPrompt } from './shared/confirm.js';
import { cliAction, resolveDirectDbUrl } from './shared/cli-action.js';
import { ORG_ID_HELP, ORG_LIST_HINT } from './shared/org-id.js';
import {
  resolveDirectSecretSettings,
  secretEnvFromEnvFile,
  setSecretDirect,
  verifySecretsDirect,
  type DirectSecretSettings,
} from './shared/secret-direct.js';
import type { SecretLocation } from '../../secrets/pg-secret-store.js';

/** Help text of `--env-file` on the direct-database secret commands. */
const SECRET_ENV_FILE_HELP =
  'Direct-DB mode: read KICI_SECRET_KEY* and KICI_PG_CUSTOMER_SECRETS from this orchestrator ' +
  'env file instead of the shell';

/**
 * Refuse `--env-file` outside direct-database mode: the admin API reads no env file, so the
 * option would be ignored.
 */
function assertEnvFileNeedsDirectMode(envFile: string | undefined, dbUrl: string | null) {
  // fails-when: --env-file is silently ignored, so the operator believes its key was used
  if (envFile !== undefined && !dbUrl) {
    throw new Error(
      '--env-file is read only in direct-database mode: pass --database-url or set ' +
        "KICI_DATABASE_URL. The admin API uses the orchestrator's own key.",
    );
  }
}

/** The warning a direct write prints when no stored secret confirmed the master key. */
export const UNCONFIRMED_KEY_WARNING =
  'Warning: no secret stored in this database confirms the master key (none is encrypted yet). ' +
  'Once the orchestrator runs, check the write with "kici-admin secret verify" against its ' +
  'admin API (--url and --token, without --database-url): it lists every secret its key ' +
  'cannot decrypt.';

/** The direct-mode settings: from `--env-file` when given, else from the shell. */
function directSettings(envFile: string | undefined): DirectSecretSettings {
  return resolveDirectSecretSettings(envFile ? secretEnvFromEnvFile(envFile) : process.env);
}

export function registerSecretCommands(program: Command, getClient: () => AdminApiClient): void {
  const sec = program.command('secret').description('Manage scoped secrets');

  sec
    .command('scopes')
    .argument('<orgId>', ORG_ID_HELP)
    .description(
      'List secret scopes for an organization, from every registered backend, ' +
        'qualified as <backend>:<path>',
    )
    .action(
      cliAction(async (orgId: string) => {
        const { scopes } = await getClient().listScopes(orgId);
        if (scopes.length === 0) {
          console.log('No scopes found.');
          return;
        }
        for (const scope of scopes) {
          console.log(`  - ${scope}`);
        }
      }),
    );

  sec
    .command('list')
    .argument('<orgId>', ORG_ID_HELP)
    .argument('<scope>')
    .description('List secret key names in a scope (values are never shown)')
    .action(
      cliAction(async (orgId: string, scope: string) => {
        const { keys } = await getClient().listKeys(orgId, scope);
        if (keys.length === 0) {
          console.log('No secrets found in this scope.');
          return;
        }
        for (const key of keys) {
          console.log(`  - ${key}`);
        }
      }),
    );

  sec
    .command('set')
    .argument('[orgId]', ORG_ID_HELP)
    .argument('[scope]')
    .argument('[key]')
    .description(
      'Set a secret value. Positional form: "set <orgId> <scope> <key>". ' +
        'Sugar form (context scope): "set --org <id> --context <env> --key <k>". ' +
        'Value comes from one of: --prompt (default on TTY), --from-stdin (default on pipe), ' +
        '--from-file <path>, --from-env <VAR>, --value <plaintext> (discouraged).',
    )
    .option('--value <value>', 'Secret value via argv (visible in shell history; prefer --prompt)')
    .option(
      '--org <orgId>',
      `Org id (use with --context + --key; mutually exclusive with positional form; ${ORG_LIST_HINT})`,
    )
    .option(
      '--context <name>',
      'Context scope — sugar for positional <scope>. Requires --org and --key.',
    )
    .option('--key <key>', 'Secret key name (use with --org + --context)')
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
      'Direct-DB mode: encrypt under the orchestrator master key (KICI_SECRET_KEY / ' +
        'KICI_SECRET_KEY_FILE) and write to scoped_secrets (offline; skips HTTP)',
    )
    .option('--env-file <path>', SECRET_ENV_FILE_HELP)
    .action(
      cliAction(
        async (
          posOrgId: string | undefined,
          posScope: string | undefined,
          posKey: string | undefined,
          opts: {
            value?: string;
            databaseUrl?: string;
            envFile?: string;
            org?: string;
            context?: string;
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
          const hasPositional = Boolean(posOrgId || posScope || posKey);
          const hasSugar = Boolean(opts.org || opts.context || opts.key);
          if (hasPositional && hasSugar) {
            throw new Error(
              'Cannot mix positional <orgId> <scope> <key> form with --org/--context/--key flags. Pick one.',
            );
          }
          let orgId: string;
          let scope: string;
          let key: string;
          if (hasSugar) {
            if (!opts.org) throw new Error('--org is required when using --context sugar form');
            if (!opts.context) {
              throw new Error('--context is required in sugar form (use --context <name>)');
            }
            if (!opts.key) throw new Error('--key is required when using --context sugar form');
            orgId = opts.org;
            scope = opts.context;
            key = opts.key;
          } else {
            if (!posOrgId || !posScope || !posKey) {
              throw new Error(
                'Missing arguments: supply either <orgId> <scope> <key> positionally, or --org + --context + --key.',
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
          assertEnvFileNeedsDirectMode(opts.envFile, dbUrl);
          if (dbUrl) {
            // Encrypted under the master key by the orchestrator's own store, never stored
            // as given.
            const { keyConfirmed } = await setSecretDirect(
              dbUrl,
              { orgId, scope, key, value },
              directSettings(opts.envFile),
            );
            console.log(`Secret '${key}' set in scope '${scope}' for org ${orgId} (direct).`);
            if (!keyConfirmed) console.error(UNCONFIRMED_KEY_WARNING);
          } else {
            await getClient().setSecret(orgId, scope, key, value);
            console.log(`Secret '${key}' set in scope '${scope}' for org ${orgId}.`);
          }
          // A context's secrets live in the scope named after it (--context sets that scope).
          await warnIfContextUnbound({
            orgId,
            name: scope,
            dbUrl,
            client: dbUrl ? undefined : getClient(),
          });
        },
      ),
    );

  sec
    .command('delete')
    .argument('<orgId>', ORG_ID_HELP)
    .argument('<scope>')
    .argument('<key>')
    .description('Delete a secret')
    .option('--yes', 'Skip confirmation prompt')
    .action(
      cliAction(async (orgId: string, scope: string, key: string, opts: { yes?: boolean }) => {
        if (!opts.yes) {
          const confirmed = await confirmPrompt(
            `Are you sure you want to delete secret '${key}' from scope '${scope}'? [y/N] `,
          );
          if (!confirmed) {
            console.log('Aborted.');
            return;
          }
        }
        await getClient().deleteSecret(orgId, scope, key);
        console.log(`Secret '${key}' deleted from scope '${scope}' for org ${orgId}.`);
      }),
    );

  sec
    .command('verify')
    .description(
      'List every stored secret the orchestrator master key cannot decrypt (org, scope and key ' +
        'name, never a value), and exit 1 when there is one. Re-set each listed secret with ' +
        '"secret set".',
    )
    .option(
      '--database-url <url>',
      'Direct-DB mode: decrypt with the master key (KICI_SECRET_KEY / KICI_SECRET_KEY_FILE) ' +
        'instead of asking the admin API',
    )
    .option('--env-file <path>', SECRET_ENV_FILE_HELP)
    .option('--json', 'Emit JSON output')
    .action(
      cliAction(async (opts: { databaseUrl?: string; envFile?: string; json?: boolean }) => {
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        assertEnvFileNeedsDirectMode(opts.envFile, dbUrl);
        const undecryptable: SecretLocation[] = dbUrl
          ? await verifySecretsDirect(dbUrl, directSettings(opts.envFile))
          : (await getClient().verifySecrets()).undecryptable;
        if (opts.json) {
          console.log(JSON.stringify({ undecryptable }));
        } else if (undecryptable.length === 0) {
          console.log('Every stored secret decrypts with the orchestrator master key.');
        } else {
          console.log(
            `${undecryptable.length} stored secret(s) do not decrypt with the master key:`,
          );
          for (const s of undecryptable) {
            console.log(`  - org ${s.orgId}  scope ${s.scope}  key ${s.key}`);
          }
          console.log('Re-set each one with "kici-admin secret set <orgId> <scope> <key>".');
        }
        // fails-when: verify exits 0 while a row the orchestrator cannot read is stored
        if (undecryptable.length > 0) process.exit(1);
      }),
    );

  registerSecretScopeCommands(sec, getClient);
}

/**
 * `secret scope create|rename|delete`: the operator path for the dashboard's
 * `secrets.scope.*` writes. HTTP only, like `secret scopes`.
 */
function registerSecretScopeCommands(sec: Command, getClient: () => AdminApiClient): void {
  const scope = sec.command('scope').description('Create, rename or delete a secret scope');

  scope
    .command('create')
    .argument('<orgId>', ORG_ID_HELP)
    .argument('<scope>')
    .description(
      'Create an empty secret scope. A <backend>: qualifier selects the backend; an ' +
        'unqualified scope targets the PG backend. An existing scope stays unchanged.',
    )
    .option('--json', 'Emit JSON output')
    .action(
      cliAction(async (orgId: string, scopeName: string, opts: { json?: boolean }) => {
        const result = await getClient().createScope(orgId, scopeName);
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(`Secret scope '${scopeName}' created for org ${orgId}.`);
        }
      }),
    );

  scope
    .command('rename')
    .argument('<orgId>', ORG_ID_HELP)
    .argument('<oldScope>')
    .argument('<newScope>')
    .description(
      'Rename a secret scope inside its backend. Refuses a move between backends and a ' +
        'rename onto a scope that already exists.',
    )
    .option('--json', 'Emit JSON output')
    .action(
      cliAction(
        async (orgId: string, oldScope: string, newScope: string, opts: { json?: boolean }) => {
          const result = await getClient().renameScope(orgId, oldScope, newScope);
          if (opts.json) {
            console.log(JSON.stringify(result));
          } else {
            console.log(`Secret scope '${oldScope}' renamed to '${newScope}' for org ${orgId}.`);
          }
        },
      ),
    );

  scope
    .command('delete')
    .argument('<orgId>', ORG_ID_HELP)
    .argument('<scope>')
    .description('Delete a secret scope and every secret in it')
    .option('--yes', 'Skip confirmation prompt')
    .option('--json', 'Emit JSON output')
    .action(
      cliAction(
        async (orgId: string, scopeName: string, opts: { yes?: boolean; json?: boolean }) => {
          if (!opts.yes) {
            const confirmed = await confirmPrompt(
              `Are you sure you want to delete scope '${scopeName}' and every secret in it? [y/N] `,
            );
            if (!confirmed) {
              console.log('Aborted.');
              return;
            }
          }
          const result = await getClient().deleteScope(orgId, scopeName);
          if (opts.json) {
            console.log(JSON.stringify(result));
          } else {
            console.log(`Secret scope '${scopeName}' deleted for org ${orgId}.`);
          }
        },
      ),
    );
}
