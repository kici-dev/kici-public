/**
 * Check-run read CLI command for kici-admin.
 *
 *   check-run list --sha <sha> [--check-name <name>] [--limit <n>] [--json]
 *
 * READ-ONLY. Answers "did we post that check run?" — the question that
 * previously needed raw SQL against `check_run_tracking`.
 *
 * Each column answers a different half of it:
 *   - CHECK_RUN_ID   the check run was created at the provider.
 *   - CREATE_STATE   stamped `pending` BEFORE the create and never reset on
 *                    failure, so `pending` distinguishes an in-flight create
 *                    from a missing one — it does not prove success.
 *   - TERMINAL_SENT  the terminal `completed` update was accepted by the
 *                    provider.
 *
 * Every write on this table is best-effort, so an em dash is "no record", never
 * proof that the call failed.
 *
 * Direct-DB only: there is no admin HTTP route for check-run tracking, so this
 * requires `--database-url` (or `KICI_DATABASE_URL`) the same way `attestations`,
 * `cluster` and `cold-store` do.
 */
import type { Command } from 'commander';
import {
  listCheckRunTrackingDirect,
  toErrorMessage,
  type CheckRunTrackingDirectRow,
} from '@kici-dev/shared';

function requireDbUrl(explicit?: string): string {
  const url = explicit ?? process.env.KICI_DATABASE_URL;
  if (!url) throw new Error('Database URL required. Pass --database-url or set KICI_DATABASE_URL.');
  return url;
}

function parseIntOption(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.floor(n) !== n) {
    throw new Error(`${label}: must be an integer (got "${raw}")`);
  }
  return n;
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
    // An em dash means no id was recorded. That is not proof the create
    // failed: the write is best-effort and falls back to cache-only on a DB
    // error, so the check run may exist at the provider anyway.
    r.check_run_id ?? '—',
    r.build_creation_state ?? '—',
    // Set means the provider accepted the terminal `completed` update. Em dash
    // means we have no record of sending it — same best-effort caveat.
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
    .action(async (opts) => {
      try {
        const limit = parseIntOption(opts.limit, '--limit');
        const dbUrl = requireDbUrl(opts.databaseUrl);
        const result = await listCheckRunTrackingDirect(dbUrl, {
          sha: opts.sha,
          checkName: opts.checkName,
          limit,
        });
        if (opts.json) console.log(JSON.stringify(result));
        else printTrackingTable(result.rows);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
