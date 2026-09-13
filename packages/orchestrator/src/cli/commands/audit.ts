/**
 * Audit log query command for kici-admin.
 *
 * Queries the secrets audit log with optional filters.
 */

import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { toErrorMessage } from '@kici-dev/shared';

/**
 * Format audit entries as a table.
 */
function formatAuditTable(entries: any[]): string {
  if (entries.length === 0) return 'No audit entries found.';

  const header = 'Timestamp | Action | Context | Outcome | JobID | User | Keys';
  const sep = '-'.repeat(header.length);
  const rows = entries.map((e: any) => {
    const ts = e.timestamp ?? e.created_at ?? '-';
    const action = e.action ?? '-';
    const ctx = e.contextName ?? e.context_name ?? '-';
    const outcome = e.outcome ?? '-';
    const jobId = e.jobId ?? e.job_id ?? '-';
    const user = e.userId ?? e.user_id ?? '-';
    const keys = Array.isArray(e.keys) ? e.keys.join(', ') : (e.keys ?? '-');
    return `${ts} | ${action} | ${ctx} | ${outcome} | ${jobId} | ${user} | ${keys}`;
  });
  return [header, sep, ...rows].join('\n');
}

export function registerAuditCommands(program: Command, getClient: () => AdminApiClient): void {
  program
    .command('audit')
    .description('Query the secrets audit log')
    .option('--context <name>', 'Filter by context name')
    .option('--routing-key <rk>', 'Filter by routing key (required for cold-store scan)')
    .option('--action <action>', 'Filter by action type')
    .option('--from <date>', 'From date (ISO 8601)')
    .option('--to <date>', 'To date (ISO 8601)')
    .option('--limit <n>', 'Max entries to return', '100')
    .option('--offset <n>', 'Offset for pagination')
    .option('--include-archived', 'Include rows from cold storage (Phase D)', false)
    .action(
      async (opts: {
        context?: string;
        routingKey?: string;
        action?: string;
        from?: string;
        to?: string;
        limit: string;
        offset?: string;
        includeArchived?: boolean;
      }) => {
        try {
          const entries = await getClient().queryAudit({
            contextName: opts.context,
            routingKey: opts.routingKey,
            action: opts.action,
            from: opts.from,
            to: opts.to,
            limit: parseInt(opts.limit, 10),
            offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
            includeArchived: opts.includeArchived === true,
          });
          console.log(formatAuditTable(entries));
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );
}
