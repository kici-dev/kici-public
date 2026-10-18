import type { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import {
  AgentPlatform,
  toErrorMessage,
  type AgentPlatform as AgentPlatformType,
  type S3StaticCredentials,
} from '@kici-dev/shared';
import {
  buildSelfContainedAgentPackage,
  refreshAgentPackages,
  uploadAgentPackage,
  type AgentPackageStorage,
  type RefreshStorage,
} from '../../agent-packaging/index.js';
import { readKiciVersion } from '../service/instance/manifest.js';
import { readEnvValues } from '../service/backup-timer.js';
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
  envFile?: string;
  nodeMirror?: string;
  npmRegistry?: string;
  nodeVersion?: string;
}

/**
 * The variables a packaging run reads its cache storage config and S3
 * credentials from, and a name for that source in messages.
 */
export interface StorageEnvSource {
  env: NodeJS.ProcessEnv;
  origin: string;
}

/** The env-file variables that configure the cache storage and its S3 credentials. */
const STORAGE_ENV_PREFIXES = ['KICI_STORAGE_', 'AWS_'];

/** The environment of the shell that runs the CLI. */
export function shellStorageEnv(): StorageEnvSource {
  return { env: process.env, origin: 'the environment of this shell' };
}

/**
 * The `KICI_STORAGE_*` and `AWS_*` variables of a service env file: the
 * storage config the service runs with. No other variable is read, so an
 * unrelated setting in the file cannot fail the packaging run. Throws when the
 * file cannot be read; the message names the path, never the content.
 */
export function storageEnvFromEnvFile(
  envFilePath: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf-8'),
): StorageEnvSource {
  let content: string;
  try {
    content = readFile(envFilePath);
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code ?? toErrorMessage(err);
    throw new Error(`cannot read the env file ${envFilePath} (${reason})`, { cause: err });
  }
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of readEnvValues(content)) {
    if (STORAGE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) env[key] = value;
  }
  return { env, origin: `the env file ${envFilePath}` };
}

/** The S3 client options the `AWS_*` variables of `env` set. */
export interface S3CredentialOptions {
  credentials?: S3StaticCredentials;
  profile?: string;
  region?: string;
}

/**
 * Static keys when `env` holds both `AWS_ACCESS_KEY_ID` and
 * `AWS_SECRET_ACCESS_KEY` (with `AWS_SESSION_TOKEN` when set), else its
 * `AWS_PROFILE`. Neither set leaves the SDK default credential chain. The
 * region is `AWS_REGION`, else `AWS_DEFAULT_REGION`.
 */
export function s3CredentialOptions(env: NodeJS.ProcessEnv): S3CredentialOptions {
  const out: S3CredentialOptions = {};
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (accessKeyId && secretAccessKey) {
    out.credentials = {
      accessKeyId,
      secretAccessKey,
      ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
    };
  } else if (env.AWS_PROFILE) {
    out.profile = env.AWS_PROFILE;
  }
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;
  if (region) out.region = region;
  return out;
}

/** The cache-bucket storage client `source` configures, or null when it sets no S3 backend. */
export function cacheBucketStorage(source: StorageEnvSource): AgentPackageStorage | null {
  // Packaging scope reads only the object-storage config, so it does not
  // require the coordinator/platform env an operator's upgrade shell lacks.
  const config = loadConfig('packaging', source.env);
  if (config.storage?.type !== 's3') return null;
  const aws = s3CredentialOptions(source.env);
  return createCacheStorage({
    type: 's3',
    bucket: config.storage.bucket!,
    prefix: config.storage.prefix ?? '',
    ttlMs: config.cacheTtlDays * 86_400_000,
    region: config.storage.region ?? aws.region,
    endpoint: config.storage.endpoint,
    externalEndpoint: config.storage.externalEndpoint,
    uploadEndpoint: config.storage.uploadEndpoint,
    forcePathStyle: config.storage.forcePathStyle,
    credentials: aws.credentials,
    profile: aws.profile,
  });
}

/** The cache-bucket storage client (S3 only). */
export function resolveUploadStorage(
  source: StorageEnvSource = shellStorageEnv(),
): AgentPackageStorage {
  const storage = cacheBucketStorage(source);
  if (!storage) {
    throw new Error(
      `--upload requires an S3 cache storage backend, and ${source.origin} sets none ` +
        '(set KICI_STORAGE_TYPE=s3 and the other KICI_STORAGE_* variables)',
    );
  }
  return storage;
}

export interface AgentPackageRefreshOptions {
  platforms?: AgentPlatformType[];
  /** Where the storage config comes from. Default: {@link shellStorageEnv}. */
  storageEnv?: StorageEnvSource;
  nodeMirror?: string;
  npmRegistry?: string;
  nodeVersion?: string;
}

/**
 * Produce and upload the agent payloads for the current version after a
 * versioned upgrade. The storage config comes from `opts.storageEnv`; the
 * upgrade passes the instance env file. A source with no S3 bucket (a
 * filesystem cache, or none) logs and skips; a produce/upload error throws, and
 * the caller reports it without failing the already-completed upgrade.
 * Idempotent. Returns true when a refresh ran, false when skipped.
 */
export async function runAgentPackageRefresh(
  opts: AgentPackageRefreshOptions = {},
): Promise<boolean> {
  const source = opts.storageEnv ?? shellStorageEnv();
  const bucket = cacheBucketStorage(source);
  if (!bucket) {
    console.log(
      `[agent package refresh] ${source.origin} configures no S3 cache storage ` +
        '— skipping (payloads are served from the cache bucket)',
    );
    return false;
  }
  console.log(`[agent package refresh] cache storage from ${source.origin}`);
  const storage = bucket as unknown as RefreshStorage;
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
    .option(
      '--env-file <path>',
      'With --upload: read the cache storage config from this service env file instead of the shell',
    )
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
        if (opts.envFile && !opts.upload) {
          throw new Error('--env-file applies only with --upload');
        }
        // Up front, so a misconfiguration fails before the slow package build.
        const storage = opts.upload
          ? resolveUploadStorage(
              opts.envFile ? storageEnvFromEnvFile(opts.envFile) : shellStorageEnv(),
            )
          : undefined;
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
