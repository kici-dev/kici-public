/**
 * Secret backend management commands for kici-admin.
 *
 * Provides subcommands for backend CRUD, connectivity testing, and sync:
 *   backend add <name>    Register a new secret backend
 *   backend remove <name> Remove a backend (with confirmation)
 *   backend list          List all registered backends
 *   backend test [name]   Test backend connectivity
 *   backend sync [name]   Trigger scope discovery sync
 *
 * Credentials are read from environment variables or files (not shell args)
 * per design decision.
 */

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { purgeSecretBackendsDirect, toErrorMessage } from '@kici-dev/shared';

function resolveDirectDbUrl(explicit?: string): string | null {
  return explicit ?? process.env.KICI_DATABASE_URL ?? null;
}

export function registerBackendCommands(program: Command, getClient: () => AdminApiClient): void {
  const backend = program.command('backend').description('Manage secret backends');

  // ── backend add <name> ────────────────────────────────────────────

  backend
    .command('add <name>')
    .description('Register a new secret backend')
    .requiredOption('--type <type>', 'Backend type: pg or vault')
    // Vault options
    .option('--vault-url <url>', 'Vault/OpenBao URL (env: KICI_BACKEND_VAULT_URL)')
    .option(
      '--auth-method <method>',
      'Vault auth method: approle or token (default: approle)',
      'approle',
    )
    .option('--role-id <id>', 'Vault AppRole role ID (env: KICI_BACKEND_ROLE_ID)')
    .option('--secret-id <id>', 'Vault AppRole secret ID (env: KICI_BACKEND_SECRET_ID)')
    .option('--secret-id-file <path>', 'Read Vault secret ID from file (avoids shell history)')
    .option('--token <token>', 'Vault token (env: KICI_BACKEND_TOKEN)')
    .option('--namespace <ns>', 'Vault namespace')
    .option('--mount-path <path>', 'Vault mount path (default: secret)', 'secret')
    .option('--base-path <path>', 'Vault base path for secrets')
    // PG options
    .option('--connection-string <url>', 'PG connection string (env: KICI_BACKEND_PG_URL)')
    // Common options
    .option('--scope-filter <pattern>', 'Scope filter glob pattern (default: **)', '**')
    .option('--sync-interval <ms>', 'Sync interval in milliseconds (default: 300000)', '300000')
    .action(async (name: string, opts) => {
      try {
        const backendType = opts.type;
        if (backendType !== 'pg' && backendType !== 'vault') {
          console.error('Error: --type must be "pg" or "vault"');
          process.exit(1);
        }

        let config: Record<string, unknown>;

        if (backendType === 'vault') {
          config = buildVaultConfig(opts);
        } else {
          config = buildPgConfig(opts);
        }

        const result = await getClient().addBackend({
          name,
          backendType,
          config,
          scopeFilter: opts.scopeFilter,
          syncIntervalMs: parseInt(opts.syncInterval, 10),
        });

        console.log('Backend registered:');
        printBackendSummary(result);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── backend remove <name> ─────────────────────────────────────────

  backend
    .command('remove <name>')
    .description('Remove a registered secret backend')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (name: string, opts) => {
      try {
        if (!opts.yes) {
          // Fetch backend to show scope count in confirmation
          let scopeInfo = '';
          try {
            const info = await getClient().getBackend(name);
            const scopeCount = (info as Record<string, unknown>).scopeCount ?? 0;
            scopeInfo = ` has ${scopeCount} discovered scopes -- they will become unavailable.`;
          } catch {
            // Backend might not exist; remove will 404
          }

          const confirmed = await confirm(`Backend "${name}"${scopeInfo} Continue? [y/N] `);
          if (!confirmed) {
            console.log('Aborted.');
            return;
          }
        }

        const result = await getClient().removeBackend(name);
        console.log(`Backend "${name}" removed (${result.scopeCount} scopes affected).`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── backend list ──────────────────────────────────────────────────

  backend
    .command('list')
    .description('List all registered secret backends')
    .action(async () => {
      try {
        const { backends } = await getClient().listBackends();
        if (backends.length === 0) {
          console.log('No backends registered.');
          return;
        }

        // Print formatted table
        const header = [
          'NAME'.padEnd(20),
          'TYPE'.padEnd(8),
          'HEALTH'.padEnd(14),
          'SCOPES'.padEnd(8),
          'LAST SYNC'.padEnd(22),
          'INTERVAL',
        ].join('  ');
        console.log(header);
        console.log('-'.repeat(header.length));

        for (const b of backends) {
          const lastSync = b.lastSyncAt
            ? new Date(b.lastSyncAt as string).toISOString().replace('T', ' ').slice(0, 19)
            : 'never';
          const intervalMin = Math.round(Number(b.syncIntervalMs) / 60000);
          console.log(
            [
              String(b.name).padEnd(20),
              String(b.backendType).padEnd(8),
              formatHealth(String(b.healthStatus)).padEnd(14),
              String(b.scopeCount).padEnd(8),
              lastSync.padEnd(22),
              `${intervalMin}m`,
            ].join('  '),
          );
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── backend test [name] ───────────────────────────────────────────

  backend
    .command('test [name]')
    .description('Test backend connectivity (by name or inline config)')
    // Same config options as add, for inline testing
    .option('--type <type>', 'Backend type: pg or vault')
    .option('--vault-url <url>', 'Vault/OpenBao URL (env: KICI_BACKEND_VAULT_URL)')
    .option('--auth-method <method>', 'Vault auth method: approle or token', 'approle')
    .option('--role-id <id>', 'Vault AppRole role ID (env: KICI_BACKEND_ROLE_ID)')
    .option('--secret-id <id>', 'Vault AppRole secret ID (env: KICI_BACKEND_SECRET_ID)')
    .option('--secret-id-file <path>', 'Read Vault secret ID from file')
    .option('--token <token>', 'Vault token (env: KICI_BACKEND_TOKEN)')
    .option('--namespace <ns>', 'Vault namespace')
    .option('--mount-path <path>', 'Vault mount path', 'secret')
    .option('--base-path <path>', 'Vault base path')
    .option('--connection-string <url>', 'PG connection string (env: KICI_BACKEND_PG_URL)')
    .action(async (name: string | undefined, opts) => {
      try {
        let result: { ok: boolean; error?: string; latencyMs: number };

        if (name && !opts.type) {
          // Test a named registered backend
          result = await getClient().testNamedBackend(name);
        } else if (opts.type) {
          // Test inline config
          const backendType = opts.type;
          if (backendType !== 'pg' && backendType !== 'vault') {
            console.error('Error: --type must be "pg" or "vault"');
            process.exit(1);
          }

          const config = backendType === 'vault' ? buildVaultConfig(opts) : buildPgConfig(opts);

          result = await getClient().testBackend({
            name: name ?? 'test',
            backendType,
            config,
          });
        } else {
          console.error('Error: provide a backend name or --type for inline testing');
          process.exit(1);
        }

        if (result.ok) {
          console.log(`Connection OK (${result.latencyMs}ms)`);
        } else {
          console.error(`Connection FAILED: ${result.error} (${result.latencyMs}ms)`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── backend purge-stale ───────────────────────────────────────────
  //
  // Direct-DB-only helper: removes backends whose encrypted config can no
  // longer be decrypted (e.g. warm-start E2E where KICI_SECRET_KEY rotated
  // between categories). The default `pg` backend is preserved — it's seeded
  // by the initial migration with config_encrypted = '' (sentinel), so it's
  // never the source of the decryption failure.
  //
  // This is a break-glass bootstrap command: it must run *before* the
  // orchestrator starts, because BackendRegistry.loadAllStores() crashes
  // orchestrator startup when the key rotated. That's why it has no HTTP mode.

  backend
    .command('purge-stale')
    .description(
      'Delete backends with encrypted config that can no longer be decrypted (direct-DB, pre-orchestrator)',
    )
    .option('--database-url <url>', 'Orchestrator DB URL (or KICI_DATABASE_URL / DATABASE_URL)')
    .option('--json', 'Emit JSON output')
    .action(async (opts) => {
      try {
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        if (!dbUrl) {
          console.error(
            'Error: --database-url or KICI_DATABASE_URL / DATABASE_URL is required (direct-DB only)',
          );
          process.exit(1);
        }
        const { deleted } = await purgeSecretBackendsDirect(dbUrl);
        if (opts.json) {
          console.log(JSON.stringify({ deleted }));
        } else {
          console.log(`backend purge-stale: deleted=${deleted} (direct)`);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── backend sync [name] ───────────────────────────────────────────

  backend
    .command('sync [name]')
    .description('Trigger scope discovery sync (all backends if name omitted)')
    .action(async (name?: string) => {
      try {
        if (name) {
          const result = await getClient().syncBackend(name);
          console.log(`Backend "${name}" synced: ${result.scopeCount} scopes discovered.`);
        } else {
          const { results } = await getClient().syncAllBackends();
          if (results.length === 0) {
            console.log('No backends to sync.');
            return;
          }

          console.log('Sync results:');
          for (const r of results) {
            if (r.error) {
              console.log(`  ${r.name}: ERROR - ${r.error}`);
            } else {
              console.log(`  ${r.name}: ${r.scopeCount} scopes`);
            }
          }
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Build Vault backend config from CLI options and env vars.
 */
function buildVaultConfig(opts: Record<string, string | undefined>): Record<string, unknown> {
  const vaultUrl = opts.vaultUrl ?? process.env.KICI_BACKEND_VAULT_URL;
  if (!vaultUrl) {
    console.error('Error: --vault-url or KICI_BACKEND_VAULT_URL is required for vault backends');
    process.exit(1);
  }

  const config: Record<string, unknown> = {
    vaultUrl,
    authMethod: opts.authMethod ?? 'approle',
    mountPath: opts.mountPath ?? 'secret',
  };

  if (opts.basePath) config.basePath = opts.basePath;
  if (opts.namespace) config.namespace = opts.namespace;

  const authMethod = config.authMethod as string;

  if (authMethod === 'approle') {
    const roleId = opts.roleId ?? process.env.KICI_BACKEND_ROLE_ID;
    if (!roleId) {
      console.error('Error: --role-id or KICI_BACKEND_ROLE_ID is required for approle auth');
      process.exit(1);
    }
    config.roleId = roleId;

    // Secret ID: prefer file, then flag, then env
    let secretId: string | undefined;
    if (opts.secretIdFile) {
      secretId = readFileSync(opts.secretIdFile, 'utf-8').trim();
    } else {
      secretId = opts.secretId ?? process.env.KICI_BACKEND_SECRET_ID;
    }
    if (!secretId) {
      console.error(
        'Error: --secret-id, --secret-id-file, or KICI_BACKEND_SECRET_ID is required for approle auth',
      );
      process.exit(1);
    }
    config.secretId = secretId;
  } else if (authMethod === 'token') {
    const token = opts.token ?? process.env.KICI_BACKEND_TOKEN;
    if (!token) {
      console.error('Error: --token or KICI_BACKEND_TOKEN is required for token auth');
      process.exit(1);
    }
    config.token = token;
  }

  return config;
}

/**
 * Build PG backend config from CLI options and env vars.
 */
function buildPgConfig(opts: Record<string, string | undefined>): Record<string, unknown> {
  const connectionString = opts.connectionString ?? process.env.KICI_BACKEND_PG_URL;
  if (!connectionString) {
    console.error('Error: --connection-string or KICI_BACKEND_PG_URL is required for pg backends');
    process.exit(1);
  }

  return { connectionString };
}

/**
 * Format health status for display.
 */
function formatHealth(status: string): string {
  switch (status) {
    case 'healthy':
      return 'healthy';
    case 'degraded':
      return 'DEGRADED';
    case 'unreachable':
      return 'UNREACHABLE';
    default:
      return status;
  }
}

/**
 * Print a backend summary after add/update.
 */
function printBackendSummary(b: Record<string, unknown>): void {
  console.log(`  Name:          ${b.name}`);
  console.log(`  Type:          ${b.backendType}`);
  console.log(`  Health:        ${b.healthStatus}`);
  console.log(`  Scope filter:  ${b.scopeFilter}`);
  console.log(`  Sync interval: ${Math.round(Number(b.syncIntervalMs) / 60000)}m`);
  console.log(`  Enabled:       ${b.enabled}`);
}

/**
 * Simple confirmation prompt.
 */
async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}
