/**
 * Maintenance CLI commands for kici-admin.
 *
 *   queue clear --confirm                          — TRUNCATE dispatch_queue
 *   execution purge-stale --routing-key --confirm  — drop non-current runs/jobs
 *   source purge-stale --routing-key [--dry-run]   — drop orphan sources/secrets
 *   secret purge --confirm [--org <id>]            — bulk-delete scoped secrets
 *
 * HTTP mode (default, `--url` + `--token`) goes through the admin API:
 * preferred while the orchestrator runs, for its structured logs and admin RBAC.
 * Direct-DB mode (`--database-url`, or KICI_DATABASE_URL / DATABASE_URL) runs
 * the SQL on its own pool, for cleanup while the orchestrator is deliberately
 * stopped, so a stale scoped secret cannot crash it on boot.
 */
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import {
  clearDispatchQueueDirect,
  purgeScopedSecretsDirect,
  purgeStaleExecutionDirect,
  purgeStaleSourcesDirect,
} from '@kici-dev/shared';
import type { AdminApiClient } from '../api-client.js';
import {
  cliAction,
  resolveDirectDbUrl,
  DIRECT_DB_URL_FLAG,
  DIRECT_DB_URL_HELP,
} from './shared/cli-action.js';
import { ORG_LIST_HINT } from './shared/org-id.js';

async function confirmInteractive(prompt: string, expected: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stderr.write(prompt);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.once('line', resolve));
    return answer.trim() === expected;
  } finally {
    rl.close();
  }
}

export function registerMaintenanceCommands(
  program: Command,
  getClient: () => AdminApiClient,
): void {
  // ── queue ───────────────────────────────────────────────────────────────
  const queue = program.command('queue').description('Dispatch queue maintenance');
  queue
    .command('clear')
    .description('TRUNCATE the dispatch_queue table (destructive)')
    .option(DIRECT_DB_URL_FLAG, DIRECT_DB_URL_HELP)
    .requiredOption('--confirm', 'Explicit confirmation flag')
    .option('--yes', 'Skip interactive confirmation prompt (for scripted use)')
    .action(
      cliAction(async (opts: { databaseUrl?: string; yes?: boolean }) => {
        if (!opts.yes) {
          const ok = await confirmInteractive('Type "clear" to TRUNCATE dispatch_queue: ', 'clear');
          if (!ok) {
            console.error('Aborted.');
            process.exit(1);
          }
        }
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        if (dbUrl) {
          await clearDispatchQueueDirect(dbUrl);
          console.log('queue clear: cleared=true (direct)');
        } else {
          const result = await getClient().post<{ cleared: boolean }>(
            '/api/v1/admin/queue/clear',
            {},
          );
          console.log(`queue clear: cleared=${result.cleared}`);
        }
      }),
    );

  // ── execution ───────────────────────────────────────────────────────────
  const execution = program.command('execution').description('Execution data maintenance');
  execution
    .command('purge-stale')
    .description('DELETE execution_runs/jobs whose routing_key differs from the current cluster')
    .option(DIRECT_DB_URL_FLAG, DIRECT_DB_URL_HELP)
    .requiredOption('--routing-key <key>', 'Current routing key to preserve')
    .requiredOption('--confirm', 'Explicit confirmation flag')
    .action(
      cliAction(async (opts: { databaseUrl?: string; routingKey: string }) => {
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        const result = dbUrl
          ? await purgeStaleExecutionDirect(dbUrl, opts.routingKey)
          : await getClient().post<{ runsDeleted: number; jobsDeleted: number }>(
              '/api/v1/admin/execution/purge-stale',
              { routingKey: opts.routingKey },
            );
        console.log(
          `execution purge-stale: runsDeleted=${result.runsDeleted} jobsDeleted=${result.jobsDeleted}${dbUrl ? ' (direct)' : ''}`,
        );
      }),
    );

  // ── secret purge ────────────────────────────────────────────────────────
  // Joins the `secret` namespace from secret.ts when it exists, else creates
  // it; either way `purge` lands beside scopes/list/set/delete.
  const existingSecret = program.commands.find((c) => c.name() === 'secret');
  const secret =
    existingSecret ?? program.command('secret').description('Scoped secret management');
  secret
    .command('purge')
    .description('Bulk-delete scoped_secrets. Irreversible — pair with rotate-key for recovery.')
    .option(DIRECT_DB_URL_FLAG, DIRECT_DB_URL_HELP)
    .requiredOption('--confirm', 'Explicit confirmation flag')
    .option('--org <orgId>', `Restrict to a single org (defaults to ALL orgs; ${ORG_LIST_HINT})`)
    .option('--yes', 'Skip interactive confirmation prompt (for scripted use)')
    .action(
      cliAction(async (opts: { databaseUrl?: string; org?: string; yes?: boolean }) => {
        const target = opts.org ?? '__ALL__';
        if (!opts.yes) {
          const ok = await confirmInteractive(
            `Type "${target}" to bulk-delete scoped_secrets (${target}): `,
            target,
          );
          if (!ok) {
            console.error('Aborted.');
            process.exit(1);
          }
        }
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        const result = dbUrl
          ? await purgeScopedSecretsDirect(dbUrl, opts.org)
          : await getClient().post<{ deleted: number }>('/api/v1/admin/secrets/purge', {
              ...(opts.org ? { orgId: opts.org } : {}),
            });
        console.log(
          `secret purge: deleted=${result.deleted} (${target})${dbUrl ? ' (direct)' : ''}`,
        );
      }),
    );

  // ── source purge-stale ─────────────────────────────────────────────────
  const existingSource = program.commands.find((c) => c.name() === 'source');
  const source = existingSource ?? program.command('source').description('Source management');
  source
    .command('purge-stale')
    .description(
      'DELETE sources + scoped secrets whose routing_key differs from the current cluster',
    )
    .option(DIRECT_DB_URL_FLAG, DIRECT_DB_URL_HELP)
    .requiredOption('--routing-key <key>', 'Current routing key to preserve')
    .option('--dry-run', 'Count stale rows without deleting them', false)
    .option('--confirm', 'Explicit confirmation flag (required unless --dry-run)')
    .action(
      cliAction(
        async (opts: {
          databaseUrl?: string;
          routingKey: string;
          dryRun?: boolean;
          confirm?: boolean;
        }) => {
          if (!opts.dryRun && !opts.confirm) {
            console.error('Error: --confirm is required unless --dry-run is set');
            process.exit(1);
          }
          const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
          const result = dbUrl
            ? await purgeStaleSourcesDirect(dbUrl, opts.routingKey, !!opts.dryRun)
            : await getClient().post<{
                dryRun?: boolean;
                staleSecrets?: number;
                staleSources?: number;
                genericSources?: number;
                orphanRegistrations?: number;
                secretsDeleted?: number;
                sourcesDeleted?: number;
                genericDeleted?: number;
                registrationsDeleted?: number;
              }>('/api/v1/admin/sources/purge-stale', {
                routingKey: opts.routingKey,
                dryRun: !!opts.dryRun,
              });
          if (result.dryRun) {
            console.log(
              `source purge-stale (dry-run): staleSecrets=${result.staleSecrets} ` +
                `staleSources=${result.staleSources} genericSources=${result.genericSources} ` +
                `orphanRegistrations=${result.orphanRegistrations}` +
                (dbUrl ? ' (direct)' : ''),
            );
          } else {
            console.log(
              `source purge-stale: secretsDeleted=${result.secretsDeleted} ` +
                `sourcesDeleted=${result.sourcesDeleted} genericDeleted=${result.genericDeleted} ` +
                `registrationsDeleted=${result.registrationsDeleted}` +
                (dbUrl ? ' (direct)' : ''),
            );
          }
        },
      ),
    );
}
