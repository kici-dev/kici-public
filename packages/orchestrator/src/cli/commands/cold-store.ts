/**
 * Cold-store commands for kici-admin (orchestrator side).
 *
 * Phase C: every subcommand has a real implementation that builds an
 * `OrchestratorColdStore` against the orchestrator Postgres + S3 and
 * delegates to the helpers in `cold-store-impl.ts`. Mirrors
 * `kici-platform-admin cold-store …` on the Platform side.
 *
 *   cold-store archive-now <table>       Run one cycle for a single adapter
 *   cold-store dry-run-archive <table>   Show what would be archived
 *   cold-store list-chunks <table>       List chunks for a table
 *   cold-store verify-chunk <chunkId>    Recompute contentHash for a chunk
 *   cold-store replay-chunk <chunkId>    Re-run UPDATE+DELETE for a stuck chunk
 *   cold-store reconcile <table>         Rebuild orphaned manifests from data
 *   cold-store peek-chunk <chunkId>      Stream the first N rows of a chunk
 *
 * The CLI talks **directly** to the orchestrator Postgres (and the same
 * S3 bucket the running process uses). It does not go through the
 * orchestrator HTTP admin API — every operation here is a break-glass
 * inspection of bytes that don't belong to the running process.
 */

import type { Command } from 'commander';
import type { AdminApiClient } from '../api-client.js';

interface CommonOpts {
  databaseUrl?: string;
}

function resolveDatabaseUrl(opts: CommonOpts): string {
  const url = opts.databaseUrl ?? process.env.KICI_DATABASE_URL;
  if (!url) {
    throw new Error('Database URL required. Pass --database-url or set KICI_DATABASE_URL.');
  }
  return url;
}

/**
 * @param _getClient unused — cold-store commands talk to the DB + S3
 *   directly. Retained for signature consistency with other command
 *   group registrations.
 */
export function registerColdStoreCommands(
  program: Command,
  _getClient: () => AdminApiClient,
): void {
  const coldStore = program
    .command('cold-store')
    .description('Inspect and operate the orchestrator-side cold-storage archival');

  coldStore
    .command('archive-now <table>')
    .description('Run one archive cycle synchronously for a single registered adapter')
    .option('--database-url <url>', 'Orchestrator Postgres URL (else KICI_DATABASE_URL)')
    .action(async (table: string, opts: CommonOpts) => {
      try {
        const databaseUrl = resolveDatabaseUrl(opts);
        const { archiveNow } = await import('./cold-store-impl.js');
        await archiveNow({ databaseUrl, table });
      } catch (err) {
        console.error((err as Error).message);
        process.exit(2);
      }
    });

  coldStore
    .command('dry-run-archive <table>')
    .description('Show what would be archived (no S3 writes, no PG writes)')
    .option('--database-url <url>', 'Orchestrator Postgres URL (else KICI_DATABASE_URL)')
    .option('--tenant <rk>', 'Scope to a single routing key')
    .option('--from <date>', 'Lower bound on partition column (ISO date)')
    .option('--to <date>', 'Upper bound on partition column (ISO date)')
    .action(
      async (table: string, opts: CommonOpts & { tenant?: string; from?: string; to?: string }) => {
        try {
          const databaseUrl = resolveDatabaseUrl(opts);
          const { dryRunArchive } = await import('./cold-store-impl.js');
          await dryRunArchive({
            databaseUrl,
            table,
            tenant: opts.tenant,
            from: opts.from,
            to: opts.to,
          });
        } catch (err) {
          console.error((err as Error).message);
          process.exit(2);
        }
      },
    );

  coldStore
    .command('list-chunks <table>')
    .description('List archived chunks (one JSON object per line) for a table')
    .option('--database-url <url>', 'Orchestrator Postgres URL (else KICI_DATABASE_URL)')
    .option('--missing-data', 'Only list chunks whose data file is missing in object storage')
    .option('--missing-manifest', 'Only list chunks whose manifest is missing in object storage')
    .option('--tenant <rk>', 'Scope to a single routing key')
    .option('--from <date>', 'Lower bound on partition column (ISO date)')
    .option('--to <date>', 'Upper bound on partition column (ISO date)')
    .action(
      async (
        table: string,
        opts: CommonOpts & {
          tenant?: string;
          missingData?: boolean;
          missingManifest?: boolean;
          from?: string;
          to?: string;
        },
      ) => {
        try {
          const databaseUrl = resolveDatabaseUrl(opts);
          const { listChunks } = await import('./cold-store-impl.js');
          await listChunks({
            databaseUrl,
            table,
            tenant: opts.tenant,
            missingData: opts.missingData,
            missingManifest: opts.missingManifest,
            from: opts.from,
            to: opts.to,
          });
        } catch (err) {
          console.error((err as Error).message);
          process.exit(2);
        }
      },
    );

  coldStore
    .command('verify-chunk <chunkId>')
    .description('Recompute the gzipped contentHash for a chunk and compare to its manifest')
    .option('--database-url <url>', 'Orchestrator Postgres URL (else KICI_DATABASE_URL)')
    .requiredOption('--table <table>', 'Adapter table name (chunkId is unique within table)')
    .requiredOption('--tenant <rk>', 'Routing key for the chunk (from list-chunks output)')
    .requiredOption('--partition-date <YYYY-MM-DD>', 'Partition date (from list-chunks output)')
    .action(
      async (
        chunkId: string,
        opts: CommonOpts & { table: string; tenant: string; partitionDate: string },
      ) => {
        try {
          const databaseUrl = resolveDatabaseUrl(opts);
          const { verifyChunk } = await import('./cold-store-impl.js');
          const result = await verifyChunk({
            databaseUrl,
            chunkId,
            table: opts.table,
            tenant: opts.tenant,
            partitionDate: opts.partitionDate,
          });
          if (result === 'mismatch') process.exit(1);
        } catch (err) {
          console.error((err as Error).message);
          process.exit(2);
        }
      },
    );

  coldStore
    .command('replay-chunk <chunkId>')
    .description('Re-run UPDATE+DELETE+audit for a chunk that landed in S3 but not in PG')
    .option('--database-url <url>', 'Orchestrator Postgres URL (else KICI_DATABASE_URL)')
    .requiredOption('--table <table>', 'Adapter table name')
    .requiredOption('--tenant <rk>', 'Routing key for the chunk')
    .requiredOption('--partition-date <YYYY-MM-DD>', 'Partition date for the chunk')
    .action(
      async (
        chunkId: string,
        opts: CommonOpts & { table: string; tenant: string; partitionDate: string },
      ) => {
        try {
          const databaseUrl = resolveDatabaseUrl(opts);
          const { replayChunk } = await import('./cold-store-impl.js');
          await replayChunk({
            databaseUrl,
            chunkId,
            table: opts.table,
            tenant: opts.tenant,
            partitionDate: opts.partitionDate,
          });
        } catch (err) {
          console.error((err as Error).message);
          process.exit(2);
        }
      },
    );

  coldStore
    .command('replay-into-pg <chunkId>')
    .description(
      'Phase F: promote every row in a chunk BACK into orchestrator PG (clear archived_at, write replay audit)',
    )
    .option('--database-url <url>', 'Orchestrator Postgres URL (else KICI_DATABASE_URL)')
    .requiredOption('--table <table>', 'Adapter table name (currently: execution_runs)')
    .requiredOption('--tenant <rk>', 'Routing key for the chunk')
    .requiredOption('--partition-date <YYYY-MM-DD>', 'Partition date for the chunk')
    .action(
      async (
        chunkId: string,
        opts: CommonOpts & { table: string; tenant: string; partitionDate: string },
      ) => {
        try {
          const databaseUrl = resolveDatabaseUrl(opts);
          const { replayIntoPg } = await import('./cold-store-impl.js');
          await replayIntoPg({
            databaseUrl,
            chunkId,
            table: opts.table,
            tenant: opts.tenant,
            partitionDate: opts.partitionDate,
          });
        } catch (err) {
          console.error((err as Error).message);
          process.exit(2);
        }
      },
    );

  coldStore
    .command('reconcile <table>')
    .description('Walk S3 prefix and rebuild missing manifests from data files')
    .option('--database-url <url>', 'Orchestrator Postgres URL (else KICI_DATABASE_URL)')
    .option('--tenant <rk>', 'Scope to a single routing key')
    .option('--confirm-cleanup', 'Also delete chunk_counts rows whose S3 objects are gone')
    .action(
      async (table: string, opts: CommonOpts & { tenant?: string; confirmCleanup?: boolean }) => {
        try {
          const databaseUrl = resolveDatabaseUrl(opts);
          const { reconcile } = await import('./cold-store-impl.js');
          await reconcile({
            databaseUrl,
            table,
            tenant: opts.tenant,
            confirmCleanup: opts.confirmCleanup,
          });
        } catch (err) {
          console.error((err as Error).message);
          process.exit(2);
        }
      },
    );

  coldStore
    .command('list-purgeable')
    .description('Phase 2: list chunks past their cold-retention horizon (read-only)')
    .option('--database-url <url>', 'Orchestrator Postgres URL (else KICI_DATABASE_URL)')
    .option('--table <table>', 'Filter to a single adapter table (else all)')
    .option('--bucket <bucket>', 'Filter to a single cold-bucket (30d / 180d / 1y / 2y)')
    .option('--limit <n>', 'Max candidates to inspect', '1000')
    .action(async (opts: CommonOpts & { table?: string; bucket?: string; limit?: string }) => {
      try {
        const databaseUrl = resolveDatabaseUrl(opts);
        const { listPurgeable } = await import('./cold-store-impl.js');
        await listPurgeable({
          databaseUrl,
          table: opts.table,
          bucket: opts.bucket,
          limit: opts.limit !== undefined ? Number.parseInt(opts.limit, 10) : undefined,
        });
      } catch (err) {
        console.error((err as Error).message);
        process.exit(2);
      }
    });

  coldStore
    .command('purge-now')
    .description(
      'Phase 2: purge expired chunks from S3 + PG bookkeeping. DRY-RUN by default — pass --apply to actually delete.',
    )
    .option('--database-url <url>', 'Orchestrator Postgres URL (else KICI_DATABASE_URL)')
    .option('--table <table>', 'Filter to a single adapter table (else all)')
    .option('--bucket <bucket>', 'Filter to a single cold-bucket (30d / 180d / 1y / 2y)')
    .option('--limit <n>', 'Max candidates to process', '1000')
    .option('--apply', 'Actually delete (default is dry-run)')
    .action(
      async (
        opts: CommonOpts & {
          table?: string;
          bucket?: string;
          limit?: string;
          apply?: boolean;
        },
      ) => {
        try {
          const databaseUrl = resolveDatabaseUrl(opts);
          const { purgeNow } = await import('./cold-store-impl.js');
          await purgeNow({
            databaseUrl,
            table: opts.table,
            bucket: opts.bucket,
            limit: opts.limit !== undefined ? Number.parseInt(opts.limit, 10) : undefined,
            apply: opts.apply,
          });
        } catch (err) {
          console.error((err as Error).message);
          process.exit(2);
        }
      },
    );

  coldStore
    .command('peek-chunk <chunkId>')
    .description('Stream the first N rows of a chunk to stdout (for debugging)')
    .option('--database-url <url>', 'Orchestrator Postgres URL (else KICI_DATABASE_URL)')
    .requiredOption('--table <table>', 'Adapter table name')
    .requiredOption('--tenant <rk>', 'Routing key for the chunk')
    .requiredOption('--partition-date <YYYY-MM-DD>', 'Partition date for the chunk')
    .option('--limit <n>', 'Number of rows to print', '10')
    .action(
      async (
        chunkId: string,
        opts: CommonOpts & {
          table: string;
          tenant: string;
          partitionDate: string;
          limit: string;
        },
      ) => {
        try {
          const databaseUrl = resolveDatabaseUrl(opts);
          const { peekChunk } = await import('./cold-store-impl.js');
          await peekChunk({
            databaseUrl,
            chunkId,
            table: opts.table,
            tenant: opts.tenant,
            partitionDate: opts.partitionDate,
            limit: Number.parseInt(opts.limit, 10),
          });
        } catch (err) {
          console.error((err as Error).message);
          process.exit(2);
        }
      },
    );
}
