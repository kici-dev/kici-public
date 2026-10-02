/**
 * Internal event CLI commands for kici-admin.
 *
 *   event emit <name> --payload-file <path> [--source-routing-key <k>] [--source-repo <r>]
 *                     [--database-url] [--json]
 *   event list [--name <n>] [--outcome <o>] [--since <iso>] [--before <cursor>] [--limit <n>] [--json]
 *   event show <eventId> [--json]
 *
 * `list` and `show` are HTTP-only (`GET /api/v1/admin/events[/:id]`): each
 * event's dispatch state, how the router resolved it (`matched`, or why
 * nothing matched), and for `show` the redacted payload and the runs the
 * event dispatched.
 *
 * Landing pad for manually emitting an internal event (mirrors what
 * `agent ctx.emit()` does from within a step execution) by inserting a row into
 * `kici_events` and firing `pg_notify('kici_event_channel', <id>)` so the
 * orchestrator EventRouter picks it up immediately.
 *
 * Dual-mode: HTTP (`POST /api/v1/admin/events/emit`) or `--database-url`
 * (direct DB via `emitKiciEventDirect` from `@kici-dev/shared`).
 */
import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';
import { emitKiciEventDirect, toErrorMessage } from '@kici-dev/shared';

function resolveDirectDbUrl(explicit?: string): string | null {
  return explicit ?? process.env.KICI_DATABASE_URL ?? null;
}

interface EmitResult {
  eventId: string;
}

interface EventRow {
  id: string;
  eventName: string;
  createdAt: string;
  state: string;
  matchOutcome: string | null;
  matchedCount: number | null;
  attempts: number;
  sourceRepo: string | null;
  sourceRoutingKey: string | null;
  targetRepos: string[];
}

interface EventDetail extends EventRow {
  /** Null for a role without `event_log.read_payload`. */
  payload: Record<string, unknown> | null;
  sourceRunId: string | null;
  sourceJobId: string | null;
  chainDepth: number;
  expiresAt: string;
  lastError: string | null;
  nextRetryAt: string | null;
  dlqAt: string | null;
  dlqReason: string | null;
  runs: Array<{ runId: string; workflowName: string; status: string; createdAt: string }>;
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmtRow = (cells: string[]) =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  return [fmtRow(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(fmtRow)].join(
    '\n',
  );
}

/**
 * Turn the bare 404 an orchestrator without these routes answers into an
 * upgrade hint. A known route's 404 carries a JSON `error`, which the client
 * surfaces verbatim, so only the router's default body matches here.
 */
function describeReadError(err: unknown, subcommand: string): string {
  const message = toErrorMessage(err);
  if (message === 'HTTP 404: 404 Not Found') {
    return `this orchestrator does not serve \`kici-admin event ${subcommand}\`; upgrade it`;
  }
  return message;
}

function printEventDetail(e: EventDetail): void {
  console.log(`Event: ${e.id}`);
  console.log(`  Name:          ${e.eventName}`);
  console.log(`  Created:       ${e.createdAt}`);
  console.log(`  State:         ${e.state}`);
  console.log(`  Outcome:       ${e.matchOutcome ?? '-'}`);
  console.log(`  Matched:       ${e.matchedCount ?? '-'}`);
  console.log(`  Attempts:      ${e.attempts}`);
  if (e.sourceRepo) console.log(`  Source repo:   ${e.sourceRepo}`);
  if (e.sourceRoutingKey) console.log(`  Routing key:   ${e.sourceRoutingKey}`);
  if (e.sourceRunId) console.log(`  Source run:    ${e.sourceRunId}`);
  if (e.targetRepos.length > 0) console.log(`  Target repos:  ${e.targetRepos.join(', ')}`);
  if (e.lastError) console.log(`  Last error:    ${e.lastError}`);
  if (e.nextRetryAt) console.log(`  Next retry:    ${e.nextRetryAt}`);
  if (e.dlqAt) console.log(`  DLQ:           ${e.dlqAt} (${e.dlqReason ?? 'unknown'})`);
  console.log('');
  if (e.payload === null) {
    console.log('Payload: hidden (needs event_log.read_payload)');
  } else {
    console.log('Payload:');
    console.log(JSON.stringify(e.payload, null, 2));
  }
  console.log('');
  if (e.runs.length === 0) {
    console.log('Runs: none');
    return;
  }
  console.log('Runs:');
  console.log(
    renderTable(
      ['RUN', 'WORKFLOW', 'STATUS', 'CREATED'],
      e.runs.map((r) => [r.runId, r.workflowName, r.status, r.createdAt]),
    ),
  );
}

function registerEventReadCommands(event: Command, getClient: () => AdminApiClient): void {
  event
    .command('list')
    .description(
      "List internal events, newest first, with each event's state and match outcome (admin API: /api/v1/admin/events)",
    )
    .option('--name <eventName>', 'Filter by event name (e.g. kici.scaler.scale-up)')
    .option(
      '--outcome <outcome>',
      'Filter by match outcome (matched|buffered|no-registration|no-target-repo|trust-blocked|no-trigger-match)',
    )
    .option('--since <iso>', 'Only events created at or after this ISO timestamp')
    .option(
      '--before <cursor>',
      'Only events after this cursor: the next-page cursor (an event id) or an ISO timestamp',
    )
    .option('--limit <n>', 'Max results (default 50, max 200)')
    .option('--json', 'Emit raw JSON instead of a table')
    .action(
      async (opts: {
        name?: string;
        outcome?: string;
        since?: string;
        before?: string;
        limit?: string;
        json?: boolean;
      }) => {
        try {
          const response = (await getClient().listEvents({
            ...(opts.name !== undefined && { name: opts.name }),
            ...(opts.outcome !== undefined && { outcome: opts.outcome }),
            ...(opts.since !== undefined && { since: opts.since }),
            ...(opts.before !== undefined && { before: opts.before }),
            ...(opts.limit !== undefined && { limit: parseInt(opts.limit, 10) }),
          })) as unknown as { events: EventRow[]; nextCursor: string | null };
          if (opts.json) {
            console.log(JSON.stringify(response, null, 2));
            return;
          }
          if (response.events.length === 0) {
            console.log('No events found.');
            return;
          }
          console.log(
            renderTable(
              ['ID', 'NAME', 'CREATED', 'STATE', 'OUTCOME', 'MATCHED', 'ATTEMPTS'],
              response.events.map((e) => [
                e.id,
                e.eventName,
                e.createdAt,
                e.state,
                e.matchOutcome ?? '-',
                e.matchedCount === null ? '-' : String(e.matchedCount),
                String(e.attempts),
              ]),
            ),
          );
          if (response.nextCursor) {
            console.log('');
            console.log(`Next page: --before ${response.nextCursor}`);
          }
        } catch (err) {
          console.error(`Error: ${describeReadError(err, 'list')}`);
          process.exit(1);
        }
      },
    );

  event
    .command('show <eventId>')
    .description(
      'Show one internal event: its state, match outcome, payload (claim codes redacted) and the runs it dispatched',
    )
    .option('--json', 'Emit raw JSON instead of formatted output')
    .action(async (eventId: string, opts: { json?: boolean }) => {
      try {
        const response = (await getClient().getEvent(eventId)) as unknown as EventDetail;
        if (opts.json) {
          console.log(JSON.stringify(response, null, 2));
          return;
        }
        printEventDetail(response);
      } catch (err) {
        console.error(`Error: ${describeReadError(err, 'show')}`);
        process.exit(1);
      }
    });
}

export function registerEventCommands(program: Command, getClient: () => AdminApiClient): void {
  const event = program
    .command('event')
    .description('Internal events (kici_events): emit, list, show');

  event
    .command('emit <name>')
    .description(
      'INSERT a row into kici_events and fire pg_notify — manually emit an internal event (mirrors agent ctx.emit())',
    )
    .requiredOption(
      '--payload-file <path>',
      'Path to JSON file whose contents become the event payload',
    )
    .option(
      '--source-routing-key <k>',
      'Source routing key for cross-repo event matching (default: empty)',
    )
    .option('--source-repo <r>', 'Source repo identifier for cross-repo matching (default: empty)')
    .option('--database-url <url>', 'Use direct DB access instead of HTTP (offline mode)')
    .option('--json', 'Emit JSON output { eventId } on stdout', false)
    .action(
      async (
        name: string,
        opts: {
          payloadFile: string;
          sourceRoutingKey?: string;
          sourceRepo?: string;
          databaseUrl?: string;
          json?: boolean;
        },
      ) => {
        try {
          // Read and parse the payload file. We do this client-side so both
          // dual-mode paths share the same validation surface and so ENOENT /
          // JSON-parse errors surface before any DB connection is opened.
          let payloadContents: string;
          try {
            payloadContents = readFileSync(opts.payloadFile, 'utf-8');
          } catch (err) {
            throw new Error(
              `--payload-file: could not read "${opts.payloadFile}": ${toErrorMessage(err)}`,
            );
          }
          let payload: Record<string, unknown>;
          try {
            const parsed = JSON.parse(payloadContents);
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new Error('payload must be a JSON object');
            }
            payload = parsed as Record<string, unknown>;
          } catch (err) {
            throw new Error(
              `--payload-file: invalid JSON in "${opts.payloadFile}": ${toErrorMessage(err)}`,
            );
          }

          const dbUrl = resolveDirectDbUrl(opts.databaseUrl);
          let result: EmitResult;
          if (dbUrl) {
            result = await emitKiciEventDirect(dbUrl, {
              eventName: name,
              payload,
              sourceRoutingKey: opts.sourceRoutingKey,
              sourceRepo: opts.sourceRepo,
            });
          } else {
            result = await getClient().post<EmitResult>('/api/v1/admin/events/emit', {
              eventName: name,
              payload,
              sourceRoutingKey: opts.sourceRoutingKey,
              sourceRepo: opts.sourceRepo,
            });
          }

          if (opts.json) {
            console.log(JSON.stringify(result));
          } else {
            console.log(`Event emitted: ${result.eventId}`);
          }
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );

  registerEventReadCommands(event, getClient);
}
