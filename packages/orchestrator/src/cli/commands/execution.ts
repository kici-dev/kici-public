/**
 * Execution read CLI commands for kici-admin.
 *
 *   execution list [--routing-key <k>] [--status <s>] [--workflow-name <n>] [--limit <n>]
 *   execution show <runId>
 *
 * READ-ONLY — mutations (purge-stale) live in `maintenance.ts` instead.
 * Dual-mode: HTTP (via AdminApiClient) or `--database-url` (direct DB).
 *
 * supersedes the original `cache list|show` framing: the real tables
 * the E2E call sites touch are execution_runs / execution_jobs, not
 * dedup_cache.
 */
import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import {
  listExecutionRunsDirect,
  showExecutionRunDirect,
  toErrorMessage,
  type ExecutionJobRow,
  type ExecutionRunRow,
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

function printRunsTable(runs: ExecutionRunRow[]): void {
  if (runs.length === 0) {
    console.log('No execution runs found.');
    return;
  }
  const header = ['RUN_ID', 'WORKFLOW', 'STATUS', 'ROUTING', 'ENV', 'CREATED'];
  const rows = runs.map((r) => [
    r.run_id.slice(0, 8),
    r.workflow_name,
    r.status,
    r.routing_key ?? '-',
    r.environment ?? '-',
    String(r.created_at),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  console.log(header.map((h, i) => pad(h, widths[i])).join('  '));
  for (const r of rows) console.log(r.map((c, i) => pad(c, widths[i])).join('  '));
}

function printRunShow(run: ExecutionRunRow, jobs: ExecutionJobRow[]): void {
  console.log(`run_id:     ${run.run_id}`);
  console.log(`workflow:   ${run.workflow_name}`);
  console.log(`status:     ${run.status}`);
  console.log(`provider:   ${run.provider}`);
  console.log(`repo:       ${run.repo_identifier}`);
  console.log(`ref:        ${run.ref}`);
  console.log(`sha:        ${run.sha}`);
  console.log(`routing:    ${run.routing_key ?? '-'}`);
  console.log(`env:        ${run.environment ?? '-'}`);
  console.log(`created_at: ${run.created_at}`);
  if (run.completed_at) console.log(`completed:  ${run.completed_at}`);
  if (run.duration_ms !== null) console.log(`duration:   ${run.duration_ms}ms`);
  if (jobs.length === 0) {
    console.log('jobs: none');
    return;
  }
  console.log(`jobs (${jobs.length}):`);
  for (const j of jobs) {
    console.log(`  ${j.job_name} — status=${j.status} agent=${j.agent_id ?? '-'}`);
  }
}

export function registerExecutionCommands(program: Command, getClient: () => AdminApiClient): void {
  // Re-use the `execution` namespace if maintenance.ts already created it
  // (for `execution purge-stale`), otherwise create a fresh one.
  const existing = program.commands.find((c) => c.name() === 'execution');
  const exec = existing ?? program.command('execution').description('Execution read + maintenance');

  exec
    .command('list')
    .description('List execution_runs (read-only)')
    .option('--routing-key <k>', 'Filter by routing_key')
    .option('--status <s>', 'Filter by status')
    .option('--workflow-name <n>', 'Filter by workflow_name')
    .option('--limit <n>', 'Max rows to return (default 100, max 1000)')
    .option('--database-url <url>', 'Use direct DB access instead of HTTP (offline mode)')
    .option('--json', 'Emit JSON output')
    .action(async (opts) => {
      try {
        const limit = parseIntOption(opts.limit, '--limit');
        const query = {
          routingKey: opts.routingKey,
          status: opts.status,
          workflowName: opts.workflowName,
          limit,
        };
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        if (dbUrl) {
          const result = await listExecutionRunsDirect(dbUrl, query);
          if (opts.json) console.log(JSON.stringify(result));
          else printRunsTable(result.runs);
        } else {
          const params = new URLSearchParams();
          if (opts.routingKey) params.set('routingKey', opts.routingKey);
          if (opts.status) params.set('status', opts.status);
          if (opts.workflowName) params.set('workflowName', opts.workflowName);
          if (limit !== undefined) params.set('limit', String(limit));
          const qs = params.toString();
          const result = await getClient().get<{ runs: ExecutionRunRow[] }>(
            `/api/v1/admin/executions${qs ? `?${qs}` : ''}`,
          );
          if (opts.json) console.log(JSON.stringify(result));
          else printRunsTable(result.runs);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  exec
    .command('show <runId>')
    .description('Show one run + its jobs (by run_id)')
    .option('--database-url <url>', 'Use direct DB access instead of HTTP (offline mode)')
    .option('--json', 'Emit JSON output')
    .action(async (runId: string, opts) => {
      try {
        const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
        const result = dbUrl
          ? await showExecutionRunDirect(dbUrl, { runId })
          : await getClient().get<{ run: ExecutionRunRow; jobs: ExecutionJobRow[] }>(
              `/api/v1/admin/executions/${encodeURIComponent(runId)}`,
            );
        if (opts.json) console.log(JSON.stringify(result));
        else printRunShow(result.run, result.jobs);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
