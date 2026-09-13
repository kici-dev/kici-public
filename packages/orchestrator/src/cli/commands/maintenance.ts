/**
 * Maintenance CLI commands for kici-admin.
 *
 *   queue clear --confirm                          — TRUNCATE dispatch_queue
 *   execution purge-stale --routing-key --confirm  — drop non-current runs/jobs
 *   source purge-stale --routing-key [--dry-run]   — drop orphan sources/secrets
 *   secret purge --confirm [--org <id>]            — bulk-delete scoped secrets
 *
 * Each command supports two modes:
 *
 *   HTTP mode (default): requires `--url` + `--token`, routes through the
 *   orchestrator admin HTTP API. Preferred when the orchestrator is running
 *   — the service records structured logs and honors admin RBAC.
 *
 *   Direct-DB mode: activated when `--database-url` is passed (or
 *   KICI_DATABASE_URL / DATABASE_URL is set). Opens its own pool and runs the
 *   SQL directly. Used by e2e/helpers/deploy.ts during warm-start cleanup,
 *   when the orchestrator is deliberately stopped so a stale scoped-secret
 *   can't crash it on boot.
 */
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import {
  clearDispatchQueueDirect,
  purgeScopedSecretsDirect,
  purgeStaleExecutionDirect,
  purgeStaleSourcesDirect,
  toErrorMessage,
} from '@kici-dev/shared';
import type { AdminApiClient } from '../api-client.js';

function resolveDirectDbUrl(explicit?: string): string | null {
  return explicit ?? process.env.KICI_DATABASE_URL ?? null;
}

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
    .option('--database-url <url>', 'Use direct DB access instead of HTTP (offline mode)')
    .requiredOption('--confirm', 'Explicit confirmation flag')
    .option('--yes', 'Skip interactive confirmation prompt (for scripted use)')
    .action(async (opts: { databaseUrl?: string; yes?: boolean }) => {
      try {
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
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── execution ───────────────────────────────────────────────────────────
  const execution = program.command('execution').description('Execution data maintenance');
  execution
    .command('purge-stale')
    .description('DELETE execution_runs/jobs whose routing_key differs from the current cluster')
    .option('--database-url <url>', 'Use direct DB access instead of HTTP (offline mode)')
    .requiredOption('--routing-key <key>', 'Current routing key to preserve')
    .requiredOption('--confirm', 'Explicit confirmation flag')
    .action(async (opts: { databaseUrl?: string; routingKey: string }) => {
      try {
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
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── secret purge ────────────────────────────────────────────────────────
  // Attach the `purge` verb to the existing `secret` namespace (defined in
  // secret.ts). Commander lets multiple files add subcommands to the same
  // program.command('secret'); calling .command('secret') again looks up the
  // existing namespace if already created, else creates a new one — either
  // way this lands alongside scopes/list/set/delete.
  const existingSecret = program.commands.find((c) => c.name() === 'secret');
  const secret =
    existingSecret ?? program.command('secret').description('Scoped secret management');
  secret
    .command('purge')
    .description('Bulk-delete scoped_secrets. Irreversible — pair with rotate-key for recovery.')
    .option('--database-url <url>', 'Use direct DB access instead of HTTP (offline mode)')
    .requiredOption('--confirm', 'Explicit confirmation flag')
    .option('--org <orgId>', 'Restrict to a single org (defaults to ALL orgs)')
    .option('--yes', 'Skip interactive confirmation prompt (for scripted use)')
    .action(async (opts: { databaseUrl?: string; org?: string; yes?: boolean }) => {
      try {
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
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── source purge-stale ─────────────────────────────────────────────────
  const existingSource = program.commands.find((c) => c.name() === 'source');
  const source = existingSource ?? program.command('source').description('Source management');
  source
    .command('purge-stale')
    .description(
      'DELETE sources + scoped secrets whose routing_key differs from the current cluster',
    )
    .option('--database-url <url>', 'Use direct DB access instead of HTTP (offline mode)')
    .requiredOption('--routing-key <key>', 'Current routing key to preserve')
    .option('--dry-run', 'Count stale rows without deleting them', false)
    .option('--confirm', 'Explicit confirmation flag (required unless --dry-run)')
    .action(
      async (opts: {
        databaseUrl?: string;
        routingKey: string;
        dryRun?: boolean;
        confirm?: boolean;
      }) => {
        try {
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
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );
}
