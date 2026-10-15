import type { Command } from 'commander';
import path from 'node:path';
import {
  AgentPlatform,
  toErrorMessage,
  type AgentPlatform as AgentPlatformType,
} from '@kici-dev/shared';
import {
  buildSelfContainedAgentPackage,
  refreshAgentPackages,
  uploadAgentPackage,
  type AgentPackageStorage,
  type RefreshStorage,
} from '../../agent-packaging/index.js';
import { readKiciVersion } from '../service/instance/manifest.js';
import { loadConfig } from '../../config.js';
import { createCacheStorage } from '../../storage/index.js';

// Baked in at build time (scripts/build-service.mjs). readKiciVersion() resolves
// correctly only from source (tsx): in the single-file bundle its relative
// package.json offset overshoots, so the define is authoritative there (the
// agent server's version-resolution pattern).
declare const KICI_PKG_VERSION: string;

const ALL_PLATFORMS: AgentPlatformType[] = AgentPlatform.options;

/** The orchestrator's own version (single-version invariant) = the packaged agent version. */
export function resolveKiciVersion(): string {
  return typeof KICI_PKG_VERSION !== 'undefined' ? KICI_PKG_VERSION : readKiciVersion();
}

/** Parse the --platform value: default set | single | CSV | `all`. */
export function parsePlatforms(raw: string | undefined): AgentPlatformType[] {
  if (!raw || raw === 'all') return [...ALL_PLATFORMS];
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.map((p) => {
    const res = AgentPlatform.safeParse(p);
    if (!res.success) {
      throw new Error(`unsupported platform "${p}" (supported: ${ALL_PLATFORMS.join(', ')})`);
    }
    return res.data;
  });
}

interface PackageOptions {
  platform?: string;
  out?: string;
  upload?: boolean;
  nodeMirror?: string;
  npmRegistry?: string;
  nodeVersion?: string;
}

/** The cache-bucket storage client (S3 only). */
export function resolveUploadStorage(): AgentPackageStorage {
  // Packaging scope reads only the object-storage config, so it does not
  // require the coordinator/platform env an operator's upgrade shell lacks.
  const config = loadConfig('packaging');
  if (config.storage?.type !== 's3') {
    throw new Error(
      '--upload requires an S3 cache storage backend (configure storage.type=s3 / KICI_STORAGE_*)',
    );
  }
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

export interface AgentPackageRefreshOptions {
  platforms?: AgentPlatformType[];
  nodeMirror?: string;
  npmRegistry?: string;
  nodeVersion?: string;
}

/**
 * Produce and upload the agent payloads for the current version after a
 * versioned upgrade. Best-effort: a filesystem-cache orchestrator has no bucket,
 * so it logs and skips; a produce/upload error is reported but does not fail
 * the already-completed upgrade. Idempotent. Returns true when a refresh ran
 * (S3 configured), false when skipped.
 */
export async function runAgentPackageRefresh(
  opts: AgentPackageRefreshOptions = {},
): Promise<boolean> {
  // Packaging scope: see resolveUploadStorage — only the storage config is read.
  const config = loadConfig('packaging');
  if (config.storage?.type !== 's3') {
    console.log(
      '[agent package refresh] no S3 cache storage configured — skipping (payloads are served from the cache bucket)',
    );
    return false;
  }
  const storage = resolveUploadStorage() as unknown as RefreshStorage;
  const version = resolveKiciVersion();
  const nodeVersion = opts.nodeVersion ?? process.version.replace(/^v/, '');
  const outDir = path.resolve('dist/agent-packages');
  await refreshAgentPackages(
    storage,
    version,
    { ...(opts.platforms ? { platforms: opts.platforms } : {}) },
    {
      log: (msg) => console.log(msg),
      build: (platform, ver) =>
        buildSelfContainedAgentPackage({
          platform,
          version: ver,
          nodeVersion,
          outDir,
          nodeMirror: opts.nodeMirror,
          npmRegistry: opts.npmRegistry,
        }),
    },
  );
  return true;
}

/** Must run after registerAgentCommands, which creates the `agent` group. */
export function registerAgentPackage(program: Command): void {
  const agent = program.commands.find((cmd) => cmd.name() === 'agent');
  if (!agent) {
    throw new Error(
      'agent command group not found. registerAgentPackage must be called after registerAgentCommands.',
    );
  }
  agent
    .command('package')
    .description('Produce a self-contained agent + Node payload for fresh-box bootstrap')
    .option(
      '--platform <list>',
      'Target platform(s): single | CSV | all (default: linux-x64,linux-arm64)',
    )
    .option('--out <dir>', 'Output directory', 'dist/agent-packages')
    .option('--upload', 'Presign-upload each payload to the orchestrator cache bucket')
    .option('--node-mirror <url>', 'nodejs.org mirror override')
    .option('--npm-registry <url>', 'npm registry override')
    .option(
      '--node-version <ver>',
      'Vendored Node version (default: the Node version running this CLI)',
    )
    .action(async (opts: PackageOptions) => {
      try {
        const platforms = parsePlatforms(opts.platform);
        const version = resolveKiciVersion();
        const nodeVersion = opts.nodeVersion ?? process.version.replace(/^v/, '');
        const outDir = path.resolve(opts.out ?? 'dist/agent-packages');
        // Up front, so a misconfiguration fails before the slow package build.
        const storage = opts.upload ? resolveUploadStorage() : undefined;
        for (const platform of platforms) {
          console.log(`[agent package] ${platform} @ ${version} (node ${nodeVersion})`);
          const res = await buildSelfContainedAgentPackage({
            platform,
            version,
            nodeVersion,
            outDir,
            nodeMirror: opts.nodeMirror,
            npmRegistry: opts.npmRegistry,
          });
          console.log(`  → ${res.tarballPath} (${res.sha256.slice(0, 16)}…)`);
          if (storage) {
            const { key } = await uploadAgentPackage(
              storage,
              version,
              platform,
              res.tarballPath,
              res.sha256,
            );
            console.log(`  ↑ uploaded to ${key}`);
          }
        }
      } catch (err) {
        console.error(`agent package failed: ${toErrorMessage(err)}`);
        process.exitCode = 1;
      }
    });
}
