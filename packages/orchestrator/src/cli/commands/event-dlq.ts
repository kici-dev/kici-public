/**
 * Event DLQ admin CLI commands for kici-admin.
 *
 *   event-dlq list     — list events in the DLQ
 *   event-dlq count    — total DLQ depth
 *   event-dlq retry <id>     — clear DLQ flag, schedule for retry, pg_notify
 *   event-dlq discard <id>   — permanently delete a DLQ event
 *
 * Operator dogfooding path for at-least-once event delivery (Phase 5 of the
 * event durability work). Customers should generally never see anything in
 * the DLQ — when something lands here it usually means a workflow handler is
 * consistently failing and should be fixed at its root cause. This CLI is the
 * triage surface: inspect last_error, retry once a fix is deployed, or discard
 * if the event is no longer relevant.
 */
import type { Command } from 'commander';
import { toErrorMessage } from '@kici-dev/shared';
import type { AdminApiClient } from '../api-client.js';

interface DlqEvent {
  id: string;
  eventName: string;
  payload: Record<string, unknown>;
  sourceRepo: string | null;
  sourceRoutingKey: string | null;
  sourceRunId: string | null;
  sourceJobId: string | null;
  chainDepth: number;
  createdAt: string;
  dlqAt: string | null;
  dlqReason: string | null;
  attempts: number;
  lastError: string | null;
}

interface ListResponse {
  events: DlqEvent[];
  limit: number;
  nextCursor: string | null;
}

interface CountResponse {
  total: number;
}

function truncate(s: string | null, max: number): string {
  if (s === null) return '';
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function registerEventDlqCommands(program: Command, getClient: () => AdminApiClient): void {
  const dlq = program
    .command('event-dlq')
    .description('Inspect / retry / discard events in the DLQ (at-least-once delivery)');

  // ── list ────────────────────────────────────────────────────────
  dlq
    .command('list')
    .description('List events currently in the DLQ (most recent first)')
    .option('--limit <n>', 'Max rows (default 50, max 200)', '50')
    .option('--before <iso>', 'Cursor: list events with dlq_at < this ISO timestamp')
    .option('--json', 'Print raw JSON instead of a formatted table', false)
    .action(async (opts: { limit: string; before?: string; json?: boolean }) => {
      try {
        const params = new URLSearchParams();
        if (opts.limit) params.set('limit', opts.limit);
        if (opts.before) params.set('before', opts.before);
        const qs = params.toString() ? `?${params.toString()}` : '';
        const res = await getClient().get<ListResponse>(`/api/v1/admin/event-dlq${qs}`);

        if (opts.json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }

        if (res.events.length === 0) {
          console.log('No events in DLQ.');
          return;
        }

        for (const e of res.events) {
          console.log('─'.repeat(72));
          console.log(`id:        ${e.id}`);
          console.log(`event:     ${e.eventName}`);
          console.log(`reason:    ${e.dlqReason ?? '(unknown)'}  attempts: ${e.attempts}`);
          console.log(`dlqAt:     ${e.dlqAt ?? '(unknown)'}`);
          console.log(`createdAt: ${e.createdAt}`);
          if (e.sourceRoutingKey) {
            console.log(`source:    repo=${e.sourceRepo ?? '-'}  routing=${e.sourceRoutingKey}`);
          }
          if (e.lastError) {
            console.log(`lastError: ${truncate(e.lastError, 240)}`);
          }
        }
        console.log('─'.repeat(72));
        console.log(`Total: ${res.events.length} event(s) shown (limit ${res.limit})`);
        if (res.nextCursor) {
          console.log(`Next page: --before "${res.nextCursor}"`);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── count ───────────────────────────────────────────────────────
  dlq
    .command('count')
    .description('Print the total number of events in the DLQ')
    .action(async () => {
      try {
        const res = await getClient().get<CountResponse>('/api/v1/admin/event-dlq/count');
        console.log(res.total);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── retry ───────────────────────────────────────────────────────
  dlq
    .command('retry <id>')
    .description('Clear the DLQ flag, reset attempts, and schedule the event for immediate retry')
    .action(async (id: string) => {
      try {
        await getClient().post<{ retried: boolean; id: string }>(
          `/api/v1/admin/event-dlq/${encodeURIComponent(id)}/retry`,
          {},
        );
        console.log(`Event ${id} reset for retry.`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // ── discard ─────────────────────────────────────────────────────
  dlq
    .command('discard <id>')
    .description('Permanently delete an event from the DLQ')
    .action(async (id: string) => {
      try {
        await getClient().delete<{ discarded: boolean; id: string }>(
          `/api/v1/admin/event-dlq/${encodeURIComponent(id)}`,
        );
        console.log(`Event ${id} discarded.`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
