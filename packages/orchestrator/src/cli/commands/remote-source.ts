/**
 * Remote-source inspection command for kici-admin.
 *
 * Subcommand namespace: `kici-admin remote-source show`.
 *
 * The remote-source anchor (`remote_sources` table) maps the deterministic
 * routing key `remote:<orgId>` to the orchestrator's canonical org id so a
 * Platform-relayed `kici run remote` resolves the real tenant. It is
 * auto-provisioned on Platform auth; this command lets an operator inspect or
 * confirm the row when debugging org-anchor issues on a hidden orchestrator.
 *
 * Reads the orchestrator DB directly (on-host operator inspection), so it stays
 * usable even when Platform is unreachable.
 */
import type { Command } from 'commander';
import { toErrorMessage } from '@kici-dev/shared';
import { createDb, createPool } from '../../db/client.js';
import { getRemoteSource } from '../../pipeline/remote-source-store.js';

function resolveDatabaseUrl(explicit?: string): string {
  const url = explicit ?? process.env.KICI_DATABASE_URL;
  if (!url) {
    throw new Error('Database URL required. Pass --database-url or set KICI_DATABASE_URL.');
  }
  return url;
}

export function registerRemoteSourceCommands(program: Command): void {
  const rs = program
    .command('remote-source')
    .description('Inspect the auto-provisioned remote-source org anchor');

  rs.command('show <orgId>')
    .description('Print the remote_sources anchor row for an org (routing key remote:<orgId>).')
    .option('--database-url <url>', 'Orchestrator DB URL (else KICI_DATABASE_URL)')
    .option('--format <format>', 'Output format: json|table', 'table')
    .action(async (orgId: string, opts: { databaseUrl?: string; format: string }) => {
      let url: string;
      try {
        url = resolveDatabaseUrl(opts.databaseUrl);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
        return;
      }
      const pool = createPool(url);
      const db = createDb(pool);
      try {
        const row = await getRemoteSource(db, orgId);
        if (!row) {
          console.error(`No remote_sources anchor found for org ${orgId}.`);
          process.exit(1);
          return;
        }
        if (opts.format === 'json') {
          console.log(JSON.stringify(row, null, 2));
          return;
        }
        console.log(`customer_id:  ${row.customer_id}`);
        console.log(`routing_key:  ${row.routing_key}`);
        console.log(`cluster_id:   ${row.cluster_id ?? '(none)'}`);
        console.log(`created_at:   ${new Date(row.created_at).toISOString()}`);
        console.log(`updated_at:   ${new Date(row.updated_at).toISOString()}`);
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      } finally {
        await db.destroy();
        await pool.end().catch(() => undefined);
      }
    });
}
