/**
 * Event emission CLI commands for kici-admin (phase 28.10 plan 03 artifact).
 *
 *   event emit <name> --payload-file <path> [--source-routing-key <k>] [--source-repo <r>]
 *                     [--database-url] [--json]
 *
 * Dogfooded landing pad for `e2e/helpers/internal-webhook.ts` emitInternalEvent()
 * — simulates what `agent ctx.emit()` does from within a step execution by
 * inserting a row into `kici_events` and firing `pg_notify('kici_event_channel',
 * <id>)` so the orchestrator EventRouter picks it up immediately.
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

export function registerEventCommands(program: Command, getClient: () => AdminApiClient): void {
  const event = program.command('event').description('Internal event emission (kici_events)');

  event
    .command('emit <name>')
    .description(
      'INSERT a row into kici_events and fire pg_notify — simulates agent ctx.emit() for e2e tests',
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
}
