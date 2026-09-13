/**
 * Queue read CLI commands for kici-admin.
 *
 *   queue list [--status <s>] [--job-name-prefix <p>] [--limit <n>]
 *   queue show <id>
 *
 * READ-ONLY — mutations live in `maintenance.ts` (queue clear) instead.
 * Dual-mode: HTTP (via AdminApiClient) or `--database-url` (direct DB).
 *
 * supersedes the original `cache list|show` framing — the E2E call
 * sites were actually querying dispatch_queue, not a dedup cache.
 */
import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import {
  listQueueDirect,
  showQueueEntryDirect,
  toErrorMessage,
  type DispatchQueueRow,
} from '@kici-dev/shared';

function resolveDirectDbUrl(explicit?: string): string | null {
  return explicit ?? process.env.KICI_DATABASE_URL ?? null;
}

function parseIntOption(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.floor(n) !== n) {
    throw new Error(`${label}: must be an integer (got "${raw}")`);
  }
  return n;
}

function printQueueTable(entries: DispatchQueueRow[]): void {
  if (entries.length === 0) {
    console.log('No queue entries found.');
    return;
  }
  const header = ['ID', 'RUN', 'WORKFLOW', 'JOB', 'STATUS', 'CREATED'];
  const rows = entries.map((e) => [
    e.id.slice(0, 8),
    e.run_id.slice(0, 8),
    e.workflow_name,
    e.job_name,
    e.status,
    String(e.created_at),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  console.log(header.map((h, i) => pad(h, widths[i])).join('  '));
  for (const r of rows) console.log(r.map((c, i) => pad(c, widths[i])).join('  '));
}

export function registerQueueCommands(program: Command, getClient: () => AdminApiClient): void {
  // Re-use the `queue` namespace already registered by maintenance.ts if
  // present, otherwise create a fresh one. This lets read verbs land
  // alongside `queue clear` in the same command group.
  const existing = program.commands.find((c) => c.name() === 'queue');
  const queue =
    existing ?? program.command('queue').description('Dispatch queue read + maintenance');

  queue
    .command('list')
    .description('List dispatch_queue entries (read-only)')
    .option('--status <s>', 'Filter by exact status (pending|dispatched|...)')
    .option(
      '--status-not-in <csv>',
      'Filter status NOT IN (CSV; e.g. "completed,failed,cancelled")',
    )
    .option('--job-name-prefix <p>', 'Filter by job_name prefix')
    .option('--job-name <name>', 'Filter by exact job_name match')
    .option('--job-name-not-like <pattern>', 'Exclude job_name LIKE pattern (e.g. "__build__%")')
    .option('--workflow-name <n>', 'Filter by exact workflow_name')
    .option('--created-after <iso>', 'Filter created_at > <ISO timestamp>')
    .option('--limit <n>', 'Max rows to return (default 100, max 1000)')
    .option('--database-url <url>', 'Use direct DB access instead of HTTP (offline mode)')
    .option('--json', 'Emit JSON output')
    .action(async (opts) => {
      try {
        const limit = parseIntOption(opts.limit, '--limit');
        const statusNotIn = opts.statusNotIn
          ? String(opts.statusNotIn)
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
          : undefined;
        const query = {
          status: opts.status,
          statusNotIn,
          jobNamePrefix: opts.jobNamePrefix,
          jobName: opts.jobName,
          jobNameNotLike: opts.jobNameNotLike,
          workflowName: opts.workflowName,
          createdAfter: opts.createdAfter,
          limit,
        };
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        if (dbUrl) {
          const result = await listQueueDirect(dbUrl, query);
          if (opts.json) console.log(JSON.stringify(result));
          else printQueueTable(result.entries);
        } else {
          const params = new URLSearchParams();
          if (opts.status) params.set('status', opts.status);
          if (statusNotIn) params.set('statusNotIn', statusNotIn.join(','));
          if (opts.jobNamePrefix) params.set('jobNamePrefix', opts.jobNamePrefix);
          if (opts.jobName) params.set('jobName', opts.jobName);
          if (opts.jobNameNotLike) params.set('jobNameNotLike', opts.jobNameNotLike);
          if (opts.workflowName) params.set('workflowName', opts.workflowName);
          if (opts.createdAfter) params.set('createdAfter', opts.createdAfter);
          if (limit !== undefined) params.set('limit', String(limit));
          const qs = params.toString();
          const result = await getClient().get<{ entries: DispatchQueueRow[] }>(
            `/api/v1/admin/queue${qs ? `?${qs}` : ''}`,
          );
          if (opts.json) console.log(JSON.stringify(result));
          else printQueueTable(result.entries);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  queue
    .command('show <id>')
    .description('Show a single dispatch_queue row by id')
    .option('--database-url <url>', 'Use direct DB access instead of HTTP (offline mode)')
    .option('--json', 'Emit JSON output')
    .action(async (id: string, opts) => {
      try {
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        const entry = dbUrl
          ? await showQueueEntryDirect(dbUrl, { id })
          : await getClient().get<DispatchQueueRow>(
              `/api/v1/admin/queue/${encodeURIComponent(id)}`,
            );
        if (opts.json) console.log(JSON.stringify(entry));
        else {
          for (const [k, v] of Object.entries(entry)) {
            console.log(`${k}: ${v === null ? '-' : String(v)}`);
          }
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
