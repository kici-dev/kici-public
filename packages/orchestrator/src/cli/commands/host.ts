/**
 * Host roster management commands for kici-admin (orchestrator data plane).
 *
 *   host list      List all roster hosts with derived status
 *   host get       Show one roster host
 *   host declare   Pre-declare a static host before its agent connects
 *
 * Reads/writes the orchestrator DB directly (via withDb), so this lives in
 * kici-admin — never in the public `kici` or the Platform `kici-platform-admin`.
 */

import type { Command } from 'commander';
import type { Kysely } from 'kysely';
import { toErrorMessage } from '@kici-dev/shared';
import { parseHostPropertyAssignments } from '@kici-dev/engine';

import { withDb } from './shared/db.js';
import { deriveHostStatus, HostRosterStore } from '../../agent/host-roster.js';
import type { Database, HostRosterRow } from '../../db/types.js';

/** Collect a repeatable `--prop key=value` flag into an array. */
function collectProp(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * The CLI reads the roster DB directly (no full orchestrator config load), so
 * it sources the grace window from the same env var the orchestrator config
 * defaults from. Default mirrors `config.ts` rosterGraceMs (300_000).
 */
function rosterGraceMs(): number {
  const v = Number(process.env.KICI_ROSTER_GRACE_MS);
  return Number.isFinite(v) && v > 0 ? v : 300_000;
}

function formatHostTable(rows: HostRosterRow[]): string {
  if (rows.length === 0) return 'No hosts in the roster.';
  const header = 'Agent ID | Class | Status | Instance | Last Seen | Labels';
  const sep = '-'.repeat(header.length);
  const now = Date.now();
  const grace = rosterGraceMs();
  const body = rows.map((r) => {
    // SAME deriveHostStatus the store uses — no divergent inline logic.
    const status = deriveHostStatus(r, now, grace);
    const labels = (JSON.parse(r.labels) as string[]).join(',');
    return `${r.agent_id} | ${r.lifecycle_class} | ${status} | ${r.connected_instance_id ?? '-'} | ${new Date(r.last_seen).toISOString()} | ${labels}`;
  });
  return [header, sep, ...body].join('\n');
}

export function registerHostCommands(program: Command): void {
  const host = program.command('host').description('Inspect and declare the host roster');

  host
    .command('list')
    .description('List all roster hosts')
    .option('--json', 'Output JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const rows = await withDb((db) =>
          new HostRosterStore(db as unknown as Kysely<Database>).listAll(),
        );
        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        console.log(formatHostTable(rows));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  host
    .command('get')
    .description('Show one roster host')
    .requiredOption('--agent-id <id>', 'Agent id')
    .option('--json', 'Output JSON')
    .action(async (opts: { agentId: string; json?: boolean }) => {
      try {
        const row = await withDb((db) =>
          new HostRosterStore(db as unknown as Kysely<Database>).get(opts.agentId),
        );
        if (!row) {
          console.error(`No host found: ${opts.agentId}`);
          process.exit(1);
        }
        console.log(opts.json ? JSON.stringify(row, null, 2) : formatHostTable([row]));
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  host
    .command('declare')
    .description('Pre-declare a static host before it connects')
    .requiredOption('--agent-id <id>', 'Agent id the host will register as')
    .option('--labels <labels>', 'Comma-separated labels', '')
    .option('--hostname <name>', 'Hostname')
    .option(
      '--prop <key=value>',
      'Typed host property (repeatable; true/false ⇒ boolean, numeric ⇒ number)',
      collectProp,
      [],
    )
    .action(
      async (opts: { agentId: string; labels: string; hostname?: string; prop: string[] }) => {
        try {
          const labels = opts.labels
            ? String(opts.labels)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : [];
          const properties = parseHostPropertyAssignments(opts.prop);
          await withDb((db) =>
            new HostRosterStore(db as unknown as Kysely<Database>).declareStatic({
              agentId: opts.agentId,
              labels,
              hostname: opts.hostname,
              properties,
            }),
          );
          console.log(`Declared static host: ${opts.agentId}`);
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );
}
