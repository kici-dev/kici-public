/**
 * Access log commands for kici-admin.
 *
 * Operator-facing read access to the orchestrator's access_log table
 * (read + mutation attribution with ActorPrincipal). Dogfood replacement
 * for raw psql when an operator asks "who read this run's payload last
 * Tuesday" or "show me everything a platform_operator actor did".
 *
 *   access-log list   List access-log rows with filters (cursor-paginated)
 *   access-log show   Show a single entry by id
 *
 * Filter flags for `list`:
 *   --org-id          -> ?orgId=
 *   --actor-type      -> ?actorType=
 *   --actor-id        -> ?actorId=
 *   --action          -> ?action=
 *   --source          -> ?source=
 *   --outcome         -> ?outcome=
 *   --target-type     -> ?targetType=
 *   --target-id       -> ?targetId=
 *   --from / --to     -> ?from= / ?to= (ISO timestamps)
 *   --q               -> ?q= (substring of error_message, trigram-indexed)
 *   --limit           -> ?limit= (default 50, max 200)
 *   --cursor          -> ?cursor=
 *   --json            Emit raw JSON
 */

import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { toErrorMessage } from '@kici-dev/shared';

interface AccessLogItem {
  id: string;
  orgId: string | null;
  routingKey: string | null;
  actorType: string;
  actorId: string;
  actorMeta: Record<string, unknown> | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  requestId: string | null;
  source: string;
  outcome: string;
  errorMessage: string | null;
  createdAt: string;
}

interface ListResponse {
  items: AccessLogItem[];
  nextCursor: string | null;
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmtRow = (cells: string[]) =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  const lines: string[] = [];
  lines.push(fmtRow(headers));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) lines.push(fmtRow(r));
  return lines.join('\n');
}

export function registerAccessLogCommands(program: Command, getClient: () => AdminApiClient): void {
  const accessLog = program
    .command('access-log')
    .description('Inspect the read / admin-mutation access log');

  accessLog
    .command('list')
    .description('List access-log rows (dogfooded via /api/v1/admin/access-log)')
    .option('--org-id <orgId>', 'Filter by org/tenant ID')
    .option(
      '--actor-type <t>',
      'Filter by actor type (user|api_key|service_account|platform_operator|system)',
    )
    .option('--actor-id <id>', 'Filter by actor id (zsub, keyId, service_account id, ...)')
    .option('--action <action>', 'Filter by dotted action (e.g. run.detail.read, run.cancel)')
    .option('--source <s>', 'Filter by source (platform_proxy|admin_http|admin_cli)')
    .option('--outcome <o>', 'Filter by outcome (allowed|denied|error)')
    .option('--target-type <t>', 'Filter by target type (run|step|event_log|secret_scope|...)')
    .option('--target-id <id>', 'Filter by target id')
    .option('--from <ts>', 'ISO timestamp lower bound (inclusive)')
    .option('--to <ts>', 'ISO timestamp upper bound (exclusive)')
    .option('--q <text>', 'Filter by substring of error_message (trigram-indexed full-text search)')
    .option('--limit <n>', 'Max results (default 50, max 200)', '50')
    .option('--cursor <c>', 'Opaque cursor from a previous nextCursor')
    .option('--json', 'Emit raw JSON instead of a table')
    .action(async (opts) => {
      try {
        const response = (await getClient().listAccessLog({
          orgId: opts.orgId,
          actorType: opts.actorType,
          actorId: opts.actorId,
          action: opts.action,
          source: opts.source,
          outcome: opts.outcome,
          targetType: opts.targetType,
          targetId: opts.targetId,
          from: opts.from,
          to: opts.to,
          q: opts.q,
          limit: parseInt(opts.limit, 10),
          cursor: opts.cursor,
        })) as unknown as ListResponse;

        if (opts.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }

        if (response.items.length === 0) {
          console.log('No access-log rows found.');
          return;
        }

        const headers = [
          'created_at',
          'actor',
          'action',
          'source',
          'outcome',
          'target',
          'request_id',
        ];
        const rows = response.items.map((r) => [
          r.createdAt,
          `${r.actorType}:${r.actorId}`,
          r.action,
          r.source,
          r.outcome,
          r.targetType ? `${r.targetType}:${r.targetId ?? '_'}` : '',
          r.requestId ?? '',
        ]);
        console.log(renderTable(headers, rows));
        console.log('');
        console.log(
          `Showing ${response.items.length} row(s)${response.nextCursor ? `; next cursor: ${response.nextCursor}` : ''}`,
        );
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  accessLog
    .command('show <id>')
    .description('Show a single access-log entry by id')
    .option(
      '--org-id <orgId>',
      'Tenant scope for cold-store fallback when the row is archived (>30d old). ' +
        'Without this hint, only the synthetic __orchestrator__ tenant is scanned, ' +
        "so a row whose org_id is set won't be found. Single-tenant cold scans " +
        'typically take seconds-to-minutes for one-shot operator queries.',
    )
    .option('--json', 'Emit raw JSON instead of formatted output')
    .action(async (id: string, opts) => {
      try {
        const response = (await getClient().getAccessLogEntry(id, {
          orgId: opts.orgId,
        })) as unknown as AccessLogItem;
        if (opts.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }
        console.log(`Entry: ${response.id}`);
        console.log(`  Created at:    ${response.createdAt}`);
        console.log(`  Org:           ${response.orgId ?? '(none)'}`);
        if (response.routingKey) console.log(`  Routing key:   ${response.routingKey}`);
        console.log(`  Actor:         ${response.actorType}:${response.actorId}`);
        if (response.actorMeta) {
          console.log(`  Actor meta:    ${JSON.stringify(response.actorMeta)}`);
        }
        console.log(`  Action:        ${response.action}`);
        console.log(`  Source:        ${response.source}`);
        console.log(`  Outcome:       ${response.outcome}`);
        if (response.targetType) {
          console.log(`  Target:        ${response.targetType}:${response.targetId ?? '_'}`);
        }
        if (response.requestId) console.log(`  Request ID:    ${response.requestId}`);
        if (response.errorMessage) console.log(`  Error:         ${response.errorMessage}`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
