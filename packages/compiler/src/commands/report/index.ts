/**
 * `kici report`: a redacted diagnostic bundle, optionally uploaded privately to
 * KiCI. Writing and sending are separate acts: the default writes a local ZIP
 * to review, and `--upload` is the explicit second step.
 */

import * as path from 'node:path';
import pc from 'picocolors';
import { createLogger } from '@kici-dev/core';
import { DashboardClientError } from '../../remote/dashboard-client.js';
import { toErrorMessage } from '@kici-dev/core';
import { createReportBundle, type ReportBundleDeps } from './collect.js';
import { uploadReportBundle, type UploadDeps } from './upload.js';

const logger = createLogger({ prefix: 'report' });

export interface ReportOptions {
  output?: string;
  run?: string;
  /** Repeatable `key=value` pairs. */
  metadata: string[];
  redact: boolean;
  upload?: boolean;
  message?: string;
  email?: string;
  kiciDir: string;
  deps?: Partial<ReportBundleDeps>;
  uploadDeps?: UploadDeps;
}

export interface ReportListOptions {
  json?: boolean;
  deps?: { listIssueReports: () => Promise<{ reports: ReportRow[] }> };
}

export interface ReportRow {
  ref: string;
  bundleId: string;
  byteSize: number;
  status: string;
  createdAt: string;
  userId: string;
  message: string | null;
}

export interface ReportWithdrawOptions {
  ref: string;
  deps?: { withdrawIssueReport: (ref: string) => Promise<{ ref: string; deleted: boolean }> };
}

/**
 * The accumulator is null-prototyped so a `__proto__=x` pair is kept as an
 * ordinary key instead of silently vanishing from the bundle.
 */
export function parseMetadata(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new Error(`Invalid --metadata "${pair}": expected key=value.`);
    }
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return { ...out };
}

/** Timestamped, in the working directory. */
export function defaultOutputPath(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  return path.resolve(`./kici-report-${stamp}.zip`);
}

export async function reportCommand(options: ReportOptions): Promise<boolean> {
  try {
    const metadata = parseMetadata(options.metadata);
    const now = options.deps?.now?.() ?? new Date();
    const outputPath = options.output ? path.resolve(options.output) : defaultOutputPath(now);

    if (!options.redact && options.upload) {
      // No warning makes uploading plaintext secrets safe, so this is refused.
      throw new Error(
        '--no-redact cannot be combined with --upload: that would send unredacted ' +
          'secrets to KiCI. Write the bundle locally, review it, and share it yourself.',
      );
    }

    if (!options.redact) {
      // console.warn, not logger.warn: a raised log level must never hide this.
      console.warn(
        pc.yellow(
          'WARNING: --no-redact was given. This bundle keeps secrets in plain text. ' +
            'Review it carefully and do not share it unless you are certain.',
        ),
      );
    }

    const result = await createReportBundle({
      outputPath,
      kiciDir: options.kiciDir,
      runId: options.run,
      metadata,
      redact: options.redact,
      deps: options.deps,
    });

    const problems = result.collectionReport.filter(
      (e) => e.status === 'error' || e.status === 'empty',
    );

    console.log(`Report bundle written to ${result.path}`);
    console.log(`  sha256: ${result.sha256}`);
    console.log(`  ${result.fileCount} file(s) collected`);
    if (problems.length > 0) {
      // Named, not counted: the reader needs to know which section is thin.
      console.log(
        `  incomplete: ${problems.map((p) => `${p.collector} (${p.status})`).join(', ')}`,
      );
    }
    if (options.redact) {
      console.log(
        pc.dim(
          '  Redaction is best effort. Review the bundle before sharing it — ' +
            'unknown secret formats can survive.',
        ),
      );
    }

    if (options.upload) {
      const upload = await uploadReportBundle(
        result.path,
        { bundleId: result.bundleId, message: options.message, email: options.email },
        options.uploadDeps,
      );
      console.log('');
      console.log(`Report uploaded. Quote reference ${pc.bold(upload.ref)} to KiCI support.`);
    } else {
      console.log('');
      console.log(pc.dim('Send it with `kici report --upload`, or attach the file yourself.'));
    }

    return true;
  } catch (err) {
    logger.error(pc.red(err instanceof DashboardClientError ? err.message : toErrorMessage(err)));
    return false;
  }
}

export async function reportListCommand(options: ReportListOptions): Promise<boolean> {
  try {
    const list = options.deps
      ? await options.deps.listIssueReports()
      : await (async () => {
          const { DashboardClient } = await import('../../remote/dashboard-client.js');
          return (await DashboardClient.load()).listIssueReports();
        })();

    if (options.json) {
      console.log(JSON.stringify(list, null, 2));
      return true;
    }
    if (list.reports.length === 0) {
      console.log('No issue reports uploaded.');
      return true;
    }
    for (const r of list.reports) {
      console.log(
        `${r.ref}  ${r.status.padEnd(8)}  ${r.byteSize} bytes  ${r.createdAt}  ${r.bundleId}`,
      );
    }
    return true;
  } catch (err) {
    logger.error(pc.red(err instanceof DashboardClientError ? err.message : toErrorMessage(err)));
    return false;
  }
}

export async function reportWithdrawCommand(options: ReportWithdrawOptions): Promise<boolean> {
  try {
    const withdraw = options.deps
      ? options.deps.withdrawIssueReport
      : await (async () => {
          const { DashboardClient } = await import('../../remote/dashboard-client.js');
          const client = await DashboardClient.load();
          return client.withdrawIssueReport.bind(client);
        })();

    const result = await withdraw(options.ref);
    if (!result.deleted) {
      // Never claim a deletion the Platform did not report.
      logger.error(pc.red(`Report ${options.ref} was NOT deleted. Try again, or contact KiCI.`));
      return false;
    }
    console.log(`Report ${options.ref} withdrawn. The uploaded bundle has been deleted.`);
    return true;
  } catch (err) {
    logger.error(pc.red(err instanceof DashboardClientError ? err.message : toErrorMessage(err)));
    return false;
  }
}
