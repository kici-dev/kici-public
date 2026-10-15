/**
 * `kici-admin check-run list` (read-only): did we post that check run?
 *   - CHECK_RUN_ID   the check run was created at the provider.
 *   - CREATE_STATE   stamped `pending` BEFORE the create and never reset on
 *                    failure: it tells an in-flight create from a missing one,
 *                    and does not prove success.
 *   - TERMINAL_SENT  the provider accepted the terminal `completed` update.
 * Every write on the table is best-effort, so an em dash means "no record",
 * never proof the call failed.
 *
 * Direct-DB only (no admin HTTP route), like `attestations`, `cluster` and `cold-store`.
 */
import type { Command } from 'commander';
import { listCheckRunTrackingDirect, type CheckRunTrackingDirectRow } from '@kici-dev/shared';
import { cliAction, parseIntOption, printJsonOr } from './shared/cli-action.js';

function requireDbUrl(explicit?: string): string {
  const url = explicit ?? process.env.KICI_DATABASE_URL;
  if (!url) throw new Error('Database URL required. Pass --database-url or set KICI_DATABASE_URL.');
  return url;
}

function printTrackingTable(rows: CheckRunTrackingDirectRow[]): void {
  if (rows.length === 0) {
    console.log('No check-run tracking rows found.');
    return;
  }
  const header = [
    'CHECK_NAME',
    'CHECK_RUN_ID',
    'CREATE_STATE',
    'TERMINAL_SENT',
    'RUN_ID',
    'IN_PROGRESS_SENT_AT',
  ];
  const table = rows.map((r) => [
    r.check_name,
    // No id recorded is not proof the create failed: the write falls back to
    // cache-only on a DB error, so the check run may exist anyway.
    r.check_run_id ?? '—',
    r.build_creation_state ?? '—',
    r.terminal_sent_at ? new Date(r.terminal_sent_at).toISOString() : '—',
    r.run_id ?? '—',
    r.in_progress_sent_at ? new Date(r.in_progress_sent_at).toISOString() : '—',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  console.log(header.map((h, i) => pad(h, widths[i])).join('  '));
  for (const r of table) console.log(r.map((c, i) => pad(c, widths[i])).join('  '));
}

export function registerCheckRunCommands(program: Command): void {
  const checkRun = program.command('check-run').description('Check-run tracking reads (read-only)');

  checkRun
    .command('list')
    .description('List the check runs the orchestrator recorded for a commit')
    .requiredOption('--sha <sha>', 'Commit SHA to look up')
    .option('--check-name <name>', 'Filter by check name (e.g. kici/e2e-test)')
    .option('--limit <n>', 'Max rows to return (default 50, max 1000)')
    .option('--database-url <url>', 'Orchestrator DB URL (else KICI_DATABASE_URL)')
    .option('--json', 'Emit JSON output')
    .action(
      cliAction(async (opts) => {
        const limit = parseIntOption(opts.limit, '--limit');
        const dbUrl = requireDbUrl(opts.databaseUrl);
        const result = await listCheckRunTrackingDirect(dbUrl, {
          sha: opts.sha,
          checkName: opts.checkName,
          limit,
        });
        printJsonOr(opts.json, result, (r) => printTrackingTable(r.rows));
      }),
    );
}
