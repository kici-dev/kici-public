/**
 * `kici-admin attestations` — orchestrator-DB-direct provenance maintenance.
 *
 *   attestations reverify [--all]   Recompute stored verdicts (verify-at-ingest
 *                                   backfill). Default scope: pending /
 *                                   unverifiable rows; `--all` re-evaluates
 *                                   every row. Direct DB + object storage.
 *
 * Classified `kici-admin` (orchestrator DB plane) per .claude/rules/platform-admin.md.
 */
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { createLogger, createPool, toErrorMessage } from '@kici-dev/shared';
import { loadConfig } from '../../config.js';
import { createDb } from '../../db/client.js';
import { createCacheStorage } from '../../storage/index.js';
import type { CacheStorage } from '../../storage/types.js';
import { createProvenanceTrustRoot } from '../../provenance/trust-root.js';
import { reverifyAttestations } from './attestations-reverify.js';
import type { AdminApiClient } from '../api-client.js';
import { runAttestationRetry } from './attestations-retry.js';
import {
  runAttestationList,
  readAttestations,
  type AttestationListItem,
} from './attestations-list.js';

const logger = createLogger({ prefix: 'kici-admin-attestations' });

function resolveDatabaseUrl(explicit?: string): string {
  const url = explicit ?? process.env.KICI_DATABASE_URL;
  if (!url) {
    throw new Error('Database URL required. Pass --database-url or set KICI_DATABASE_URL.');
  }
  return url;
}

/** Build the provenance object-storage handle from config (s3 / filesystem). */
function buildStorage(config: ReturnType<typeof loadConfig>): CacheStorage | undefined {
  if (config.storage?.type === 's3') {
    return createCacheStorage({
      type: 's3',
      bucket: config.storage.bucket!,
      prefix: config.storage.prefix ?? '',
      ttlMs: config.cacheTtlDays * 86_400_000,
      region: config.storage.region,
      endpoint: config.storage.endpoint,
      externalEndpoint: config.storage.externalEndpoint,
      uploadEndpoint: config.storage.uploadEndpoint,
      forcePathStyle: config.storage.forcePathStyle,
    });
  }
  if (config.storage?.type === 'filesystem') {
    return createCacheStorage({
      type: 'filesystem',
      basePath: config.storage.fsBasePath!,
      ttlMs: config.cacheTtlDays * 86_400_000,
      baseUrl: config.storage.fsBaseUrl ?? `http://127.0.0.1:${config.port}`,
      signingSecret: 'kici-admin-reverify',
    });
  }
  return undefined;
}

async function confirmInteractive(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(prompt, resolve));
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

/** Render attestation rows as a compact human table (stderr note when empty). */
function printAttestationTable(rows: AttestationListItem[]): void {
  if (rows.length === 0) {
    process.stderr.write('No attestations found.\n');
    return;
  }
  for (const r of rows) {
    console.log(
      `${r.id}  ${r.verifyStatus.padEnd(12)}  run=${r.runId}  job=${r.jobId}  ${r.subjectName}  ${r.createdAt}`,
    );
  }
}

export function registerAttestationsCommands(
  program: Command,
  getClient: () => AdminApiClient,
): void {
  const attestations = program
    .command('attestations')
    .description('Provenance-attestation maintenance (orchestrator DB)');

  attestations
    .command('retry')
    .description('Mint deferred attestations now (drains the pending-attestations outbox)')
    .option('--run-id <id>', 'Scope to a single run (else drains every pending attestation)')
    .option('--all-pending', 'Drain every pending attestation (default when --run-id is absent)')
    .option(
      '--include-rejected',
      'Also re-attempt rows previously marked terminally rejected (re-arm)',
    )
    .action(async (opts: { runId?: string; allPending?: boolean; includeRejected?: boolean }) => {
      try {
        const result = await runAttestationRetry(
          (body) =>
            getClient().post<{ minted: number; stillPending: number; rejected: number }>(
              '/api/v1/admin/attestations/retry',
              body,
            ),
          { runId: opts.runId, allPending: opts.allPending, includeRejected: opts.includeRejected },
        );
        logger.info('attestations retry complete', result);
        process.stderr.write(
          `Minted ${result.minted} deferred attestation(s); ` +
            `${result.stillPending} still pending; ${result.rejected} rejected.\n`,
        );
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  attestations
    .command('reverify')
    .description('Recompute stored attestation verdicts (verify-at-ingest backfill)')
    .option('--all', 'Re-evaluate every attestation (default: only pending/unverifiable)')
    .option('--database-url <url>', 'Orchestrator DB URL (else KICI_DATABASE_URL)')
    .option('--yes', 'Skip the --all confirmation prompt')
    .action(async (opts: { all?: boolean; databaseUrl?: string; yes?: boolean }) => {
      try {
        const config = loadConfig();
        const url = resolveDatabaseUrl(opts.databaseUrl ?? (config.databaseUrl || undefined));
        if (opts.all && !opts.yes) {
          const ok = await confirmInteractive(
            'Re-evaluate the verdict of EVERY attestation (including already-verified)? [y/N] ',
          );
          if (!ok) {
            console.error('Aborted.');
            process.exit(1);
          }
        }
        const pool = createPool(url);
        const db = createDb(pool);
        const storage = buildStorage(config);
        const trustRoot = createProvenanceTrustRoot({ issuer: config.provenanceIssuer ?? null });
        try {
          const { updated, scanned } = await reverifyAttestations(db, trustRoot, storage, {
            all: !!opts.all,
          });
          logger.info('attestations reverify complete', { updated, scanned });
          process.stderr.write(`Reverified ${updated} of ${scanned} attestation(s).\n`);
        } finally {
          await db.destroy();
          await pool.end().catch(() => {});
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });

  attestations
    .command('list')
    .description('List provenance attestations from the orchestrator DB (newest first)')
    .option('--run-id <id>', 'Filter to a single run')
    .option('--job-id <id>', 'Filter to a single job')
    .option('--limit <n>', 'Max results (default 20, max 100)', '20')
    .option('--json', 'Emit the raw JSON envelope instead of a table')
    .option('--database-url <url>', 'Orchestrator DB URL (else KICI_DATABASE_URL)')
    .action(
      async (opts: {
        runId?: string;
        jobId?: string;
        limit: string;
        json?: boolean;
        databaseUrl?: string;
      }) => {
        try {
          // Pure DB read — no storage / trust-root config needed, so resolve the
          // URL directly from --database-url / KICI_DATABASE_URL (matching the
          // sibling `host list` / `environment list` reads) rather than through
          // loadConfig(), whose full validation would demand platform env vars.
          const url = resolveDatabaseUrl(opts.databaseUrl);
          const limit = Math.min(Math.max(Number.parseInt(opts.limit, 10) || 20, 1), 100);
          const pool = createPool(url);
          const db = createDb(pool);
          try {
            const result = await runAttestationList(readAttestations(db), {
              limit,
              runId: opts.runId,
              jobId: opts.jobId,
            });
            if (opts.json) {
              console.log(JSON.stringify(result, null, 2));
            } else {
              printAttestationTable(result.attestations);
            }
          } finally {
            await db.destroy();
            await pool.end().catch(() => {});
          }
        } catch (err) {
          console.error(`Error: ${toErrorMessage(err)}`);
          process.exit(1);
        }
      },
    );
}
