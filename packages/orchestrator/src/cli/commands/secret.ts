/**
 * Secret management commands for kici-admin.
 *
 * Provides scoped secret operations:
 *   secret scopes, list, set, delete
 *   secret scope create|rename|delete
 *
 * Secret values are write-only -- there is no "get value" command.
 */

import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { setContextSecretDirect } from '@kici-dev/shared';
import { assertValidSecretKey } from '@kici-dev/engine';
import { resolveSecretInput, fingerprintValue } from './shared/secret-input.js';
import { warnIfContextUnbound } from './shared/unbound-context-warning.js';
import { confirmPrompt } from './shared/confirm.js';
import { cliAction, resolveDirectDbUrl } from './shared/cli-action.js';
import { ORG_ID_HELP, ORG_LIST_HINT } from './shared/org-id.js';

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
      'Direct-DB mode: write encrypted_value verbatim to scoped_secrets (offline; skips HTTP + encryption)',
    )
    .action(
      cliAction(
        async (
          posOrgId: string | undefined,
          posScope: string | undefined,
          posKey: string | undefined,
          opts: {
            value?: string;
            databaseUrl?: string;
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
          // Resolve (orgId, scope, key) from positional OR sugar form.
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
          if (dbUrl) {
            // The direct-DB branch writes the row itself, bypassing the admin
            // route, the dashboard handler and PgSecretStore — so it needs its
            // own guard against a key that would make the at-rest AAD
            // ambiguous. The HTTP branch below is covered by the route.
            assertValidSecretKey(key);
            await setContextSecretDirect(dbUrl, {
              orgId,
              context: scope,
              key,
              encryptedValue: value,
            });
            console.log(`Secret '${key}' set in scope '${scope}' for org ${orgId} (direct).`);
          } else {
            await getClient().setSecret(orgId, scope, key, value);
            console.log(`Secret '${key}' set in scope '${scope}' for org ${orgId}.`);
          }
          // A scope named after a context is how that context's secrets are
          // written (the --context sugar form sets scope = context name).
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

  registerSecretScopeCommands(sec, getClient);
}

/**
 * `secret scope create|rename|delete` — the operator path for the dashboard's
 * scope writes (`secrets.scope.*` in the dashboard-write policy). HTTP only,
 * like `secret scopes`: each verb calls the orchestrator admin API.
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
