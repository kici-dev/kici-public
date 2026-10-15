/**
 * Where a self-contained agent+Node payload comes from: the local dir of
 * `kici-admin agent package` tarballs here, or an S3 source (orchestrator cache
 * bucket, presigned URL) behind the same interface. Payloads are version-keyed,
 * and a missing version throws rather than staging stale bytes.
 */
import { access, readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentPlatform } from '@kici-dev/shared';

export interface StagedPayload {
  tarballPath: string;
  /** Hex; `null` when the producer wrote no sidecar. */
  sha256: string | null;
}

export interface AgentPayloadSource {
  resolve(platform: AgentPlatform, version: string): Promise<StagedPayload>;
}

/** Injectable so unit tests need no real files. */
export interface PayloadFs {
  exists(filePath: string): Promise<boolean>;
  readFile(filePath: string): Promise<string>;
}

export const defaultPayloadFs: PayloadFs = {
  exists: async (filePath) => {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  },
  readFile: (filePath) => fsReadFile(filePath, 'utf8'),
};

/** Matches the producer's layout. */
function tarballName(platform: AgentPlatform): string {
  return `kici-agent-${platform}.tar.gz`;
}

/**
 * `<baseDir>/<version>/kici-agent-<platform>.tar.gz` plus an optional `.sha256`
 * sidecar. Selected by `KICI_AGENT_PAYLOAD_DIR`: the air-gap / offline fallback
 * when no object-storage source is configured.
 */
export class LocalDirPayloadSource implements AgentPayloadSource {
  constructor(
    private readonly baseDir: string,
    private readonly fs: PayloadFs = defaultPayloadFs,
  ) {}

  async resolve(platform: AgentPlatform, version: string): Promise<StagedPayload> {
    const tarballPath = path.join(this.baseDir, version, tarballName(platform));
    if (!(await this.fs.exists(tarballPath))) {
      throw new Error(
        `no agent payload for version ${version} (${platform}) at ${tarballPath} — ` +
          `run \`kici-admin agent package --platform ${platform} --out ${this.baseDir}\``,
      );
    }
    const sidecarPath = `${tarballPath}.sha256`;
    const sha256 = (await this.fs.exists(sidecarPath))
      ? parseSidecarHash(await this.fs.readFile(sidecarPath))
      : null;
    return { tarballPath, sha256 };
  }
}

/** Leading hex token of a `sha256sum`-style `<hex>  <name>` line. */
function parseSidecarHash(contents: string): string {
  const first = contents.trim().split(/\s+/)[0];
  if (!first) throw new Error('empty .sha256 sidecar');
  return first;
}
