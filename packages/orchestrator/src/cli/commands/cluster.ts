/**
 * Cluster recovery commands for kici-admin.
 *
 * Subcommand namespace: `kici-admin cluster reconcile-identity`.
 *
 * Reconciles the orchestrator's cluster identity between the DB
 * (`cluster_meta.cluster_id`) and the durable S3 sentinel
 * (`<prefix>/.kici-cluster-id`) when they diverge and the orchestrator refuses
 * to start with a "Cluster identity mismatch" error.
 *
 * DB + S3 direct (NOT the orchestrator HTTP admin API), so it works while the
 * orchestrator process is crash-looping — which is exactly when it is needed.
 * Default direction restores the DB FROM the durable sentinel (the
 * cross-restart / peer anchor); --adopt-db reverses it.
 */
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { toErrorMessage } from '@kici-dev/shared';
import { runIdempotentStep } from '@kici-dev/shared/idempotency';
import { DEFAULT_CACHE_STORAGE_S3_PREFIX } from '../../cluster/cluster-identity.js';
import {
  buildReconcileStep,
  type ReconcileDirection,
  type ReconcileS3Config,
} from '../../cluster/reconcile-identity.js';

interface ReconcileOpts {
  databaseUrl?: string;
  bucket?: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  adoptDb?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

function resolveDatabaseUrl(explicit?: string): string {
  const url = explicit ?? process.env.KICI_DATABASE_URL;
  if (!url) throw new Error('Database URL required. Pass --database-url or set KICI_DATABASE_URL.');
  return url;
}

function resolveS3(opts: ReconcileOpts): ReconcileS3Config {
  const bucket = opts.bucket ?? process.env.KICI_STORAGE_BUCKET;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!bucket) throw new Error('S3 bucket required. Pass --bucket or set KICI_STORAGE_BUCKET.');
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set for the S3 sentinel.');
  }
  return {
    bucket,
    prefix: opts.prefix ?? process.env.KICI_STORAGE_PREFIX ?? DEFAULT_CACHE_STORAGE_S3_PREFIX,
    region: opts.region ?? process.env.KICI_STORAGE_REGION,
    endpoint: opts.endpoint ?? process.env.KICI_STORAGE_ENDPOINT,
    forcePathStyle: opts.forcePathStyle ?? process.env.KICI_STORAGE_FORCE_PATH_STYLE === 'true',
    accessKeyId,
    secretAccessKey,
  };
}

async function cliConfirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${message}\nProceed? [y/N] `, resolve);
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export function registerClusterCommands(program: Command): void {
  const cluster = program
    .command('cluster')
    .description('Cluster identity recovery (DB <-> S3 sentinel reconcile).');

  cluster
    .command('reconcile-identity')
    .description(
      'Reconcile cluster_meta.cluster_id with the S3 sentinel. Default restores the DB from the sentinel.',
    )
    .option('--database-url <url>', 'Orchestrator DB URL (else KICI_DATABASE_URL)')
    .option('--bucket <bucket>', 'S3 bucket (else KICI_STORAGE_BUCKET)')
    .option(
      '--prefix <prefix>',
      'Storage prefix (else KICI_STORAGE_PREFIX, default empty = bucket root)',
    )
    .option('--region <region>', 'S3 region (else KICI_STORAGE_REGION)')
    .option('--endpoint <url>', 'S3 endpoint (else KICI_STORAGE_ENDPOINT)')
    .option('--force-path-style', 'Use S3 path-style addressing')
    .option('--adopt-db', 'Reverse direction: rewrite the sentinel from the DB cluster_id')
    .option('--dry-run', 'Report drift and exit without changing anything')
    .option('--yes', 'Skip confirmation and apply on drift')
    .action(async (opts: ReconcileOpts) => {
      try {
        const databaseUrl = resolveDatabaseUrl(opts.databaseUrl);
        const s3 = resolveS3(opts);
        const direction: ReconcileDirection = opts.adoptDb
          ? 'sentinel-from-db'
          : 'db-from-sentinel';
        const step = buildReconcileStep({ databaseUrl, s3, direction });
        const result = await runIdempotentStep(step, {
          confirm: cliConfirm,
          yes: opts.yes,
          dryRun: opts.dryRun,
          log: (line) => console.log(line),
        });
        if (result.outcome === 'applied') {
          console.log(
            'Cluster identity reconciled. Restart the orchestrator to verify it boots clean.',
          );
        } else if (result.outcome === 'declined') {
          console.log('No changes made (declined).');
          process.exit(1);
        }
      } catch (err) {
        console.error(`Error: ${toErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
