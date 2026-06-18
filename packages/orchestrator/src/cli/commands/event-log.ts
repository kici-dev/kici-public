/**
 * Inbound webhook delivery log commands for kici-admin.
 *
 * Operator-facing read access to the orchestrator's event_log table via the
 * admin HTTP API. Dogfood replacement for raw psql / log-grep when an
 * operator asks "did delivery <id> arrive, and what did its payload look
 * like".
 *
 *   event-log list   List inbound deliveries with filters
 *   event-log show   Show a single delivery (optionally with payload)
 *
 * Filter flags for `list`:
 *   --org             -> ?orgId=
 *   --routing-key     -> ?routingKey=
 *   --event           -> ?event=
 *   --action          -> ?action=
 *   --status          -> ?status=
 *   --from            -> ?from= (ISO timestamp)
 *   --to              -> ?to=   (ISO timestamp)
 *   --delivery-id     -> ?deliveryId= (substring)
 *   --limit / --offset
 *   --json            Emit raw JSON
 */

import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { toErrorMessage } from '@kici-dev/shared';

interface DeliverySummary {
  orgId: string;
  deliveryId: string;
  routingKey: string;
  event: string;
  action: string | null;
  source: string;
  provider: string;
  status: string;
  matchedCount: number;
  runId: string | null;
  receivedAt: string;
  payloadOmitted: boolean;
  payloadSizeBytes: number;
}

interface ListResponse {
  deliveries: DeliverySummary[];
  total: number;
  limit: number;
  offset: number;
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

export function registerEventLogCommands(program: Command, getClient: () => AdminApiClient): void {
  const eventLog = program
    .command('event-log')
    .description('Inspect the inbound webhook delivery log');

  // ── event-log list ─────────────────────────────────────────────
  eventLog
    .command('list')
    .description('List inbound webhook deliveries (dogfooded via /api/v1/admin/event-log)')
    .option('--org <orgId>', 'Filter by org/tenant ID')
    .option('--routing-key <key>', 'Filter by routing key (e.g. github:42)')
    .option('--event <type>', 'Filter by event type (e.g. push, pull_request)')
    .option(
      '--action <action>',
      'Filter by event action (e.g. opened, closed, synchronize for pull_request)',
    )
    .option(
      '--status <s>',
      'Filter by outcome status (received|processed|duplicate|lockfile_missing|failed)',
    )
    .option('--from <ts>', 'ISO timestamp lower bound (inclusive)')
    .option('--to <ts>', 'ISO timestamp upper bound (exclusive)')
    .option('--delivery-id <substr>', 'Substring filter on delivery_id')
    .option('--limit <n>', 'Max results (default 50, max 200)', '50')
    .option('--offset <n>', 'Skip first N results', '0')
    .option(
      '--include-archived',
      'Merge cold-store archived rows into the result (requires --routing-key for cold scoping)',
    )
    .option('--json', 'Emit raw JSON instead of a table')
    .action(async (opts) => {
      try {
        const response = (await getClient().listEventLog({
          orgId: opts.org,
          routingKey: opts.routingKey,
          event: opts.event,
          action: opts.action,
          status: opts.status,
          from: opts.from,
          to: opts.to,
          deliveryId: opts.deliveryId,
          limit: parseInt(opts.limit, 10),
          offset: parseInt(opts.offset, 10),
          includeArchived: !!opts.includeArchived,
        })) as unknown as ListResponse;

        if (opts.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }

        if (response.deliveries.length === 0) {
          console.log('No deliveries found.');
          return;
        }

        const headers = [
          'received_at',
          'delivery_id',
          'routing_key',
          'event',
          'source',
          'status',
          'matched',
          'size',
        ];
        const rows = response.deliveries.map((d) => [
          d.receivedAt,
          d.deliveryId,
          d.routingKey,
          d.action ? `${d.event}:${d.action}` : d.event,
          d.source,
          d.payloadOmitted ? `${d.status} (omitted)` : d.status,
          String(d.matchedCount),
          formatBytes(d.payloadSizeBytes),
        ]);
        console.log(renderTable(headers, rows));
        console.log('');
        console.log(
          `Showing ${response.deliveries.length} of ${response.total} (offset ${response.offset}, limit ${response.limit})`,
        );
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── event-log show <deliveryId> ────────────────────────────────
  eventLog
    .command('show <deliveryId>')
    .description('Show a single delivery (optionally including the payload body)')
    .requiredOption('--org <orgId>', 'Org/tenant ID for the delivery')
    .option('--include-payload', 'Also fetch the payload body (requires event_log.read_payload)')
    .option(
      '--routing-key <key>',
      'Routing key hint for cold-store fallback (scopes the cold scan)',
    )
    .option('--json', 'Emit raw JSON instead of formatted output')
    .action(async (deliveryId: string, opts) => {
      try {
        const response = (await getClient().getEventLog(deliveryId, {
          orgId: opts.org,
          includePayload: !!opts.includePayload,
          routingKey: opts.routingKey,
        })) as Record<string, unknown>;

        if (opts.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }

        const r = response;
        console.log(`Delivery: ${r.deliveryId}`);
        console.log(`  Org:           ${r.orgId}`);
        console.log(`  Routing key:   ${r.routingKey}`);
        console.log(`  Event:         ${r.event}${r.action ? ` (${r.action})` : ''}`);
        console.log(`  Source:        ${r.source}`);
        console.log(`  Provider:      ${r.provider}`);
        if (r.repoIdentifier) console.log(`  Repo:          ${r.repoIdentifier}`);
        if (r.ref) console.log(`  Ref:           ${r.ref}`);
        console.log(`  Status:        ${r.status}`);
        console.log(`  Matched:       ${r.matchedCount}`);
        if (r.runId) console.log(`  First run:     ${r.runId}`);
        if (r.errorMessage) console.log(`  Error:         ${r.errorMessage}`);
        console.log(`  Received at:   ${r.receivedAt}`);
        if (r.archivedAt) console.log(`  Archived at:   ${r.archivedAt}`);
        console.log(
          `  Payload:       ${r.payloadOmitted ? `omitted (${r.payloadOmittedReason})` : 'stored'} -- ${formatBytes(r.payloadSizeBytes as number)}`,
        );
        console.log(`  Payload hash:  ${r.payloadHash}`);
        if (r.payload !== undefined) {
          console.log('');
          console.log('Payload:');
          console.log(JSON.stringify(r.payload, null, 2));
        } else if (r.payloadReadError) {
          console.log('');
          console.log(`Payload read error: ${r.payloadReadError}`);
        } else if (opts.includePayload && r.payloadOmitted) {
          console.log('');
          console.log(`Payload was omitted at ingress; reason: ${r.payloadOmittedReason}`);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}
