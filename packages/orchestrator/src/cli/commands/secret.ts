/**
 * Secret management commands for kici-admin.
 *
 * Provides scoped secret operations:
 *   secret scopes, list, set, delete, fix-prefixed-scopes
 *
 * Secret values are write-only -- there is no "get value" command.
 */

import type { Command } from 'commander';
import type { Kysely } from 'kysely';
import type { AdminApiClient } from '../api-client.js';
import { setContextSecretDirect, toErrorMessage } from '@kici-dev/shared';
import { resolveSecretInput, fingerprintValue } from './shared/secret-input.js';
import { createPool, createDb } from '../../db/client.js';
import { PgSecretStore, SecretScopeExistsError } from '../../secrets/pg-secret-store.js';
import { AuditLogger } from '../../secrets/audit-logger.js';
import { loadSecretStoreConfig } from '../../secrets/config.js';
import { DEFAULT_BACKEND_NAME } from '../../secrets/scope-routing.js';

function resolveDirectDbUrl(explicit?: string): string | null {
  return explicit ?? process.env.KICI_DATABASE_URL ?? null;
}

/** One planned rename from a stored qualified scope to its bare path. */
export interface PrefixedScopeRename {
  from: string;
  to: string;
  backendName: string;
}

/** One stored scope that cannot be repaired automatically. */
export interface PrefixedScopeSkip {
  scope: string;
  reason: string;
}

/** Outcome of planning the repair of legacy qualifier-bearing scopes. */
export interface PrefixedScopeFixPlan {
  renames: PrefixedScopeRename[];
  skips: PrefixedScopeSkip[];
}

/**
 * Plan the repair of scopes stored with a `<backend>:` qualifier still attached.
 *
 * Before backend-qualified routing landed on the HTTP admin plane, a scope
 * written as `pg:production` was stored verbatim, so the stored name carries a
 * qualifier the resolver now strips before it reaches the store. Such a row is
 * unreachable: every read addresses the bare `production`.
 *
 * Only a `pg:` qualifier is repaired. The scopes handed in come out of the PG
 * store, so a row named `vault:foo` is a PG row wearing another backend's
 * name: renaming it to `foo` would turn it into a genuine PG secret, moving it
 * across a backend boundary and past a `pgCustomerSecrets: false` setting that
 * exists to keep customer secrets out of PG. That is the same cross-backend
 * move the rename route refuses, so it is reported as a skip instead.
 *
 * An unregistered head is left alone entirely -- it is an ordinary (if
 * unusual) scope path, not a stale qualifier.
 *
 * A repair whose bare target already exists is SKIPPED, never merged: merging
 * two scopes would silently overwrite whichever key the two share, and there
 * is no way to tell which value the operator meant to keep.
 *
 * Pure -- no I/O, so the decision table is unit-testable without a database.
 *
 * @param scopes - Scope names as currently stored in the PG backend.
 * @param backendNames - Names of the registered secret backends.
 */
export function planPrefixedScopeFixes(
  scopes: string[],
  backendNames: string[],
): PrefixedScopeFixPlan {
  const registered = new Set(backendNames);
  // Stored scopes are distinct and only the `pg:` head is stripped, so two
  // repairs can never claim the same destination -- the only collision
  // possible is with a scope that is ALREADY stored bare.
  const existing = new Set(scopes);
  const renames: PrefixedScopeRename[] = [];
  const skips: PrefixedScopeSkip[] = [];

  for (const scope of scopes) {
    const colonIdx = scope.indexOf(':');
    if (colonIdx <= 0) continue;
    const backendName = scope.slice(0, colonIdx);
    if (!registered.has(backendName)) continue;
    const target = scope.slice(colonIdx + 1);
    if (backendName !== DEFAULT_BACKEND_NAME) {
      skips.push({
        scope,
        reason:
          `stored in the PG backend under the '${backendName}' qualifier — repairing it here ` +
          `would move the secret into PG. Copy it into backend '${backendName}' by hand, ` +
          `then delete this scope`,
      });
      continue;
    }
    if (target.length === 0) {
      skips.push({ scope, reason: 'bare qualifier with an empty path — repair by hand' });
      continue;
    }
    if (existing.has(target)) {
      skips.push({
        scope,
        reason: `target scope '${target}' already exists — merge by hand, this command never merges`,
      });
      continue;
    }
    renames.push({ from: scope, to: target, backendName });
  }

  return { renames, skips };
}

/** Open a direct Kysely connection for a break-glass migration command. */
function openDirectDb(databaseUrl: string): Kysely<any> {
  return createDb(createPool(databaseUrl));
}

/** Read the names of every registered secret backend straight from the DB. */
async function listRegisteredBackendNames(db: Kysely<any>): Promise<string[]> {
  const rows = (await db.selectFrom('secret_backends').select('name').execute()) as Array<{
    name: string;
  }>;
  return rows.map((r) => r.name);
}

export function registerSecretCommands(program: Command, getClient: () => AdminApiClient): void {
  const sec = program.command('secret').description('Manage scoped secrets');

  sec
    .command('scopes <orgId>')
    .description('List secret scopes for an organization')
    .option(
      '--all-backends',
      'List scopes from every registered backend, qualified as <backend>:<path> ' +
        '(default today: the pg backend only, unqualified — this default flips at v1.0.0)',
    )
    .action(async (orgId: string, opts: { allBackends?: boolean }) => {
      try {
        const { scopes } = await getClient().listScopes(orgId, opts.allBackends === true);
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
        'Sugar form (context scope): "set --org <id> --context <env> --key <k>". ' +
        'Value comes from one of: --prompt (default on TTY), --from-stdin (default on pipe), ' +
        '--from-file <path>, --from-env <VAR>, --value <plaintext> (discouraged).',
    )
    .option('--value <value>', 'Secret value via argv (visible in shell history; prefer --prompt)')
    .option(
      '--org <orgId>',
      'Org ID (use with --context + --key; mutually exclusive with positional form)',
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
        try {
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

  sec
    .command('fix-prefixed-scopes <orgId>')
    .description(
      'Repair PG-backend secret scopes stored with a stale pg: qualifier (direct-DB). ' +
        'Each affected scope is renamed to its bare path, re-encrypting every secret ' +
        'under the corrected AAD. Exits 2 when any scope needs manual repair.',
    )
    .option('--dry-run', 'Print the plan and exit without writing')
    .option('--database-url <url>', 'Orchestrator DB URL (or KICI_DATABASE_URL)')
    .action(async (orgId: string, opts: { dryRun?: boolean; databaseUrl?: string }) => {
      const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
      if (!dbUrl) {
        console.error('Error: --database-url or KICI_DATABASE_URL is required (direct-DB only)');
        process.exit(1);
        return;
      }
      const db = openDirectDb(dbUrl);
      let skipped = 0;
      let failed = false;
      try {
        const backendNames = await listRegisteredBackendNames(db);
        const config = loadSecretStoreConfig();
        const store = await PgSecretStore.create(
          db,
          config.masterKey,
          new AuditLogger(db),
          config.oldMasterKey,
        );
        const plan = planPrefixedScopeFixes(await store.listScopes(orgId), backendNames);

        if (plan.renames.length === 0 && plan.skips.length === 0) {
          console.log(`No scopes carry a stale backend qualifier for org ${orgId}.`);
        } else {
          // The planner's occupancy check reads listScopes, which only sees
          // scopes holding secret rows -- a destination that exists solely as a
          // context binding is invisible to it, and the store refuses that
          // rename. Record it as one more manual-repair skip rather than
          // letting it abort the loop: one collision must not block every scope
          // queued behind it, and the operator would have no way to finish the
          // repair.
          const allSkips = [...plan.skips];
          let repaired = 0;
          for (const r of plan.renames) {
            console.log(
              opts.dryRun
                ? `[dry-run] would rename '${r.from}' -> '${r.to}' (backend '${r.backendName}')`
                : `Renaming '${r.from}' -> '${r.to}' (backend '${r.backendName}')`,
            );
            if (opts.dryRun) {
              repaired++;
              continue;
            }
            try {
              // renameScope re-encrypts every row: the AAD binds the scope name,
              // so a plain SQL UPDATE would leave the ciphertext undecryptable.
              await store.renameScope(orgId, r.from, r.to);
              repaired++;
            } catch (err) {
              if (!(err instanceof SecretScopeExistsError)) throw err;
              allSkips.push({
                scope: r.from,
                reason:
                  `target scope '${r.to}' already exists — merge by hand, ` +
                  `this command never merges`,
              });
            }
          }
          for (const s of allSkips) {
            console.error(`SKIPPED '${s.scope}': ${s.reason}`);
          }

          console.log(
            `${opts.dryRun ? '[dry-run] ' : ''}${repaired} scope(s) repaired, ` +
              `${allSkips.length} skipped.`,
          );
          skipped = allSkips.length;
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        failed = true;
      } finally {
        // Every exit path must close the pool: its idle client holds an open
        // socket, so an undestroyed pool keeps the event loop alive and the
        // command hangs instead of returning to the shell.
        await db.destroy();
      }
      if (failed) process.exit(1);
      // Exit 2 signals "some scopes still need a human" so a deploy script can
      // distinguish it from a hard failure (1) and from a clean repair (0).
      if (skipped > 0) process.exit(2);
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
