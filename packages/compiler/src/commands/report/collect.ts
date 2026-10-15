/**
 * Build the `kici report` bundle: the orchestrator debug bundle's archive layout
 * (so `kici-admin inspect-bundle` reads either), collected from the workflow
 * author's side — their config, project and reported run.
 *
 * `runCollector` turns a throw into a recorded `error` entry, so one broken
 * collector still yields a shareable report, and the manifest's
 * `collectionReport` tells the reader which sections are trustworthy.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ZipArchive } from 'archiver';
import { z } from 'zod';
import { scrubText } from '@kici-dev/core/diagnostics-redaction';
import { lookupTarget, redactCliConfig, withLookupTarget } from './cli-config.js';
import { collectIdentity, type ReportIdentity } from './identity.js';
import type { ProbeOutcome } from '../doctor.js';

export const CollectionStatus = z.enum(['ok', 'empty', 'error', 'skipped']);
export type CollectionStatus = z.infer<typeof CollectionStatus>;

export interface CollectionEntry {
  collector: string;
  status: CollectionStatus;
  note?: string;
}

/** Bumped when the archive layout changes. */
export const REPORT_BUNDLE_VERSION = '1.0';

export interface ReportManifest {
  version: string;
  generated_at: string;
  bundle_id: string;
  node_version: string;
  platform: string;
  metadata: Record<string, string>;
  redacted: boolean;
  collectionReport: CollectionEntry[];
}

export interface RunMaterial {
  detail: unknown;
  logs: string;
}

/** Injectable seams, mirroring `DoctorDeps`, so every path is unit-testable without real IO. */
export interface ReportBundleDeps {
  loadConfig: () => Promise<Record<string, unknown>>;
  probe: () => Promise<ProbeOutcome | null>;
  readProject: (kiciDir: string) => Promise<Record<string, unknown>>;
  fetchRun: (runId: string) => Promise<RunMaterial>;
  now: () => Date;
}

export interface ReportBundleOptions {
  outputPath: string;
  kiciDir: string;
  runId?: string;
  metadata: Record<string, string>;
  /** When false the bundle is assembled without scrubbing free text. */
  redact: boolean;
  deps?: Partial<ReportBundleDeps>;
}

export interface ReportBundleResult {
  path: string;
  sha256: string;
  bundleId: string;
  fileCount: number;
  collectionReport: CollectionEntry[];
}

/**
 * Workflow names and lock-file metadata only: the workflow source is the
 * customer's code, and a diagnostic bundle should not ship it.
 */
async function defaultReadProject(kiciDir: string): Promise<Record<string, unknown>> {
  const workflowsDir = path.join(kiciDir, 'workflows');
  const workflows = fs.existsSync(workflowsDir) ? fs.readdirSync(workflowsDir).sort() : [];

  const lockPath = path.join(kiciDir, 'kici.lock.json');
  let lock: Record<string, unknown> | null = null;
  if (fs.existsSync(lockPath)) {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as Record<string, unknown>;
    lock = {
      schemaVersion: parsed.schemaVersion ?? null,
      generatedAt: parsed.generatedAt ?? null,
      workflowCount: Array.isArray(parsed.workflows) ? parsed.workflows.length : null,
    };
  }

  return { kiciDir, exists: fs.existsSync(kiciDir), workflows, lock };
}

const DEFAULT_DEPS: ReportBundleDeps = {
  loadConfig: async () => {
    const { loadGlobalConfig } = await import('../../remote/config.js');
    return (await loadGlobalConfig()) as unknown as Record<string, unknown>;
  },
  probe: async () => {
    const { loadGlobalConfig } = await import('../../remote/config.js');
    const { DashboardClient, DashboardClientError } =
      await import('../../remote/dashboard-client.js');
    const config = await loadGlobalConfig();
    if (!config.activeOrgId || !config.pat) return null;
    try {
      const client = DashboardClient.fromConfig(config);
      return { ok: true, infra: await client.getInfrastructure() };
    } catch (err) {
      if (err instanceof DashboardClientError) {
        return { ok: false, kind: err.kind, message: err.message };
      }
      throw err;
    }
  },
  readProject: defaultReadProject,
  fetchRun: async (runId: string) => {
    const { loadGlobalConfig } = await import('../../remote/config.js');
    const { DashboardClient } = await import('../../remote/dashboard-client.js');
    const client = DashboardClient.fromConfig(await loadGlobalConfig());
    const detail = await client.getRunDetail(runId);
    return { detail, logs: JSON.stringify(detail, null, 2) };
  },
  now: () => new Date(),
};

/**
 * Record a collector's outcome instead of aborting the bundle. The dev-side gap
 * filer reads `empty` and `error`.
 */
async function runCollector(
  report: CollectionEntry[],
  collector: string,
  fn: () => Promise<unknown>,
  scrub: (s: string) => string,
): Promise<unknown> {
  try {
    const value = await fn();
    const isEmpty =
      value === null ||
      value === undefined ||
      (Array.isArray(value) && value.length === 0) ||
      (typeof value === 'string' && value.length === 0);
    report.push({ collector, status: isEmpty ? 'empty' : 'ok' });
    return value;
  } catch (err) {
    // The message can carry a path, a URL, or a token from a failed request.
    report.push({
      collector,
      status: 'error',
      note: scrub(err instanceof Error ? err.message : String(err)),
    });
    return undefined;
  }
}

function systemInfo(): Record<string, unknown> {
  return {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    nodeVersion: process.version,
    cpuCount: os.cpus().length,
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    hostname: os.hostname(),
  };
}

/** sha256 over the finished file, so the customer can quote a digest. */
async function digestOf(file: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

/**
 * Each section is one `runCollector` call plus an append, so adding a collector
 * never grows the control flow.
 */
export async function createReportBundle(
  options: ReportBundleOptions,
): Promise<ReportBundleResult> {
  const deps: ReportBundleDeps = { ...DEFAULT_DEPS, ...options.deps };
  const scrub = options.redact ? scrubText : (s: string) => s;
  const report: CollectionEntry[] = [];
  const bundleId = randomUUID().replace(/-/g, '').slice(0, 24);

  const dir = path.dirname(options.outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const output = fs.createWriteStream(options.outputPath);
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const finalized = new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
    // Without this, an unwritable --output path (EACCES, EROFS, ENOSPC) becomes
    // an uncaught exception instead of reaching reportCommand's error path.
    output.on('error', reject);
  });
  archive.pipe(output);

  let fileCount = 0;
  const append = (body: unknown, name: string): void => {
    archive.append(scrub(JSON.stringify(body, null, 2)), { name });
    fileCount += 1;
  };

  // A null probe (not logged in / no active org) is the most common state for a
  // bug reporter; `empty` would read as a malfunction in the summary, so it is
  // recorded as `skipped`.
  let probe: ProbeOutcome | null | undefined;
  try {
    probe = await deps.probe();
    report.push(
      probe === null
        ? { collector: 'probe', status: 'skipped', note: 'not authenticated' }
        : { collector: 'probe', status: 'ok' },
    );
  } catch (err) {
    report.push({
      collector: 'probe',
      status: 'error',
      note: scrub(err instanceof Error ? err.message : String(err)),
    });
  }

  const identity = (await runCollector(
    report,
    'identity',
    () => Promise.resolve(collectIdentity(probe ?? null)),
    scrub,
  )) as ReportIdentity | undefined;
  if (identity) append(identity, 'identity.json');

  const config = (await runCollector(report, 'config', () => deps.loadConfig(), scrub)) as
    Record<string, unknown> | undefined;
  // Allowlist redaction, then free-text scrubbing: they catch different things.
  // Both are gated on `redact` (`--no-redact` promises an unredacted bundle).
  // The allowlist keeps the Platform and organization readable and masks every
  // credential.
  if (config !== undefined) {
    append(options.redact ? redactCliConfig(config) : config, 'config/config.json');
  }

  const project = await runCollector(
    report,
    'project',
    () => deps.readProject(options.kiciDir),
    scrub,
  );
  if (project !== undefined) append(project, 'project/project.json');

  const system = await runCollector(report, 'system', () => Promise.resolve(systemInfo()), scrub);
  if (system !== undefined) append(system, 'system/info.json');

  if (options.runId) {
    // A not-found note names where the CLI looked: a CLI logged in to another
    // Platform or organization is the common cause, indistinguishable from a
    // deleted run in the bare message.
    const target = lookupTarget(config);
    const runId = options.runId;
    const run = (await runCollector(
      report,
      'run',
      () =>
        deps.fetchRun(runId).catch((err: unknown) => {
          throw withLookupTarget(err, target);
        }),
      scrub,
    )) as RunMaterial | undefined;
    if (run !== undefined) {
      append(run.detail, `runs/${runId}/detail.json`);
      archive.append(scrub(run.logs), { name: `runs/${runId}/logs.txt` });
      fileCount += 1;
    }
  } else {
    report.push({ collector: 'run', status: 'skipped', note: 'no --run given' });
  }

  const manifest: ReportManifest = {
    version: REPORT_BUNDLE_VERSION,
    generated_at: deps.now().toISOString(),
    bundle_id: bundleId,
    node_version: process.version,
    platform: process.platform,
    metadata: options.metadata,
    redacted: options.redact,
    collectionReport: report,
  };
  // `metadata` is verbatim `--metadata k=v` input, so a secret-shaped value
  // would otherwise ride into the ZIP in plain text.
  archive.append(scrub(JSON.stringify(manifest, null, 2)), { name: 'manifest.json' });
  fileCount += 1;

  await archive.finalize();
  await finalized;

  return {
    path: options.outputPath,
    sha256: await digestOf(options.outputPath),
    bundleId,
    fileCount,
    collectionReport: report,
  };
}
