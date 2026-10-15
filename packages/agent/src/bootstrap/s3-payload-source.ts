/**
 * Object-storage agent payload source — the ops agent's primary source.
 *
 * Fetches the version-keyed agent+Node payload once into a local cache dir,
 * through a presigned GET URL the orchestrator mints
 * (`kici.presignAgentPackage`) for its own cache bucket. No standing S3
 * credential reaches the ops agent, only a time-limited presigned URL. A
 * missing object throws, naming the version and platform, rather than
 * staging stale bytes.
 *
 * It backs `ssh-push` (the box cannot reach object storage); under `s3-direct`
 * the box pulls the presigned URL itself. `LocalDirPayloadSource` is the
 * air-gap fallback.
 */
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { kiciTmpBase, type AgentPlatform } from '@kici-dev/shared';
import type { AgentPayloadSource, StagedPayload } from './payload-source.js';

/** What the orchestrator returns for a presign request. */
export interface PresignedPayload {
  url: string;
  /** The expected sha256 (hex), or null when the producer wrote no sidecar. */
  sha256: string | null;
}

export interface S3PayloadSourceDeps {
  /**
   * The `kici.presignAgentPackage` RPC over the agent WS; the orchestrator keys
   * the presign by its own version and the probed platform. Null when no
   * payload object exists for the version.
   */
  presign(platform: AgentPlatform, version: string): Promise<PresignedPayload | null>;
  /** Binary-safe. Injectable for tests. */
  fetchToFile(url: string, dest: string): Promise<void>;
  /** Local cache root; payloads land under `<cacheDir>/<version>/…` (cache-once). */
  cacheDir: string;
  /** The cache-once short-circuit. Injectable. */
  exists?(filePath: string): Promise<boolean>;
}

/** The payload tarball name for a platform (matches the producer's layout). */
function tarballName(platform: AgentPlatform): string {
  return `kici-agent-${platform}.tar.gz`;
}

export class S3PayloadSource implements AgentPayloadSource {
  constructor(private readonly deps: S3PayloadSourceDeps) {}

  async resolve(platform: AgentPlatform, version: string): Promise<StagedPayload> {
    const presigned = await this.deps.presign(platform, version);
    if (!presigned) {
      throw new Error(
        `no agent payload for version ${version} (${platform}) in the orchestrator cache bucket — ` +
          `run \`kici-admin agent package --platform ${platform} --upload\` to publish it`,
      );
    }
    const tarballPath = path.join(this.deps.cacheDir, version, tarballName(platform));
    const already = this.deps.exists ? await this.deps.exists(tarballPath) : false;
    if (!already) {
      await this.deps.fetchToFile(presigned.url, tarballPath);
    }
    return { tarballPath, sha256: presigned.sha256 };
  }
}

/** Default cache root the ops agent stores pulled payloads under (cache-once). */
export function defaultPayloadCacheDir(): string {
  return path.join(kiciTmpBase(), 'kici-agent-payloads');
}

export async function payloadFileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Streams without an in-memory buffer. */
export async function fetchUrlToFile(url: string, dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`fetch payload failed: HTTP ${res.status} ${res.statusText}`);
  }
  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(dest),
  );
}
