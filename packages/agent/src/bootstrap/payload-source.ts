/**
 * Agent payload source abstraction.
 *
 * A one-method plug so the place a self-contained agent+Node payload comes from
 * is swappable and overridable: the local-dir fallback here reads the tarballs
 * a `kici-admin agent package` producer wrote to disk; an S3-backed source
 * (fetching from the orchestrator cache bucket via presigned URL) plugs in the
 * same interface. Payloads are version-keyed and fail-fast — a missing version
 * throws loudly rather than silently staging stale bytes.
 */
import { access, readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentPlatform } from '@kici-dev/shared';

/** A staged payload ready to deliver: a local tarball path + its expected hash. */
export interface StagedPayload {
  tarballPath: string;
  /** The expected sha256 (hex), or `null` when the producer wrote no sidecar. */
  sha256: string | null;
}

/** Resolves the payload tarball for a given platform + version. */
export interface AgentPayloadSource {
  resolve(platform: AgentPlatform, version: string): Promise<StagedPayload>;
}

/** Filesystem boundary — injectable so unit tests need no real files. */
export interface PayloadFs {
  exists(filePath: string): Promise<boolean>;
  readFile(filePath: string): Promise<string>;
}

/** Default fs boundary backed by `node:fs/promises`. */
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

/** The payload tarball name for a platform (matches the producer's layout). */
function tarballName(platform: AgentPlatform): string {
  return `kici-agent-${platform}.tar.gz`;
}

/**
 * Reads version-keyed payloads from a local directory:
 * `<baseDir>/<version>/kici-agent-<platform>.tar.gz` with an optional
 * `.sha256` sidecar (the producer writes a `<hex>  <basename>` line — we parse
 * the leading hex token). Selected via `KICI_AGENT_PAYLOAD_DIR`; the air-gap /
 * offline fallback when no object-storage source is configured.
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

/** Extract the leading hex token from a `sha256sum`-style `<hex>  <name>` line. */
function parseSidecarHash(contents: string): string {
  const first = contents.trim().split(/\s+/)[0];
  if (!first) throw new Error('empty .sha256 sidecar');
  return first;
}
