import type { AgentPlatform } from '@kici-dev/shared';
import { agentPackageKey } from './upload.js';

/**
 * Read side of the cache-bucket agent-package store: mint a box-routable
 * presigned GET URL and read the payload's sha256 sidecar. Satisfied by the
 * orchestrator S3 cache storage client (`getUrl` presigns against the external,
 * container-routable endpoint; `get` reads the `.sha256` object).
 */
export interface AgentPackageDownloadStorage {
  getUrl(key: string): Promise<string | null>;
  get(key: string): Promise<Buffer | null>;
  has(key: string): Promise<boolean>;
}

/** Cache-bucket key for a payload's sha256 sidecar (mirrors the upload layout). */
export function agentPackageHashKey(version: string, platform: AgentPlatform): string {
  return `${agentPackageKey(version, platform)}.sha256`;
}

/** Parse a `sha256sum`-style `<hex>  <name>` sidecar into the leading hex token. */
export function parseSha256Sidecar(contents: string): string | null {
  const first = contents.trim().split(/\s+/)[0];
  return first && /^[0-9a-f]{64}$/i.test(first) ? first : null;
}

/**
 * Mint a presigned GET URL for a version-keyed agent payload and read its
 * sha256 sidecar. Returns null when the payload object is absent (an
 * unresolvable version) so the caller fails fast with a clear error rather than
 * staging stale bytes. The URL is box-routable (external endpoint); no standing
 * S3 credential ever leaves the orchestrator.
 */
export async function presignAgentPackageDownload(
  storage: AgentPackageDownloadStorage,
  version: string,
  platform: AgentPlatform,
): Promise<{ url: string; sha256: string | null } | null> {
  const url = await storage.getUrl(agentPackageKey(version, platform));
  if (!url) return null;
  const hashBuf = await storage.get(agentPackageHashKey(version, platform));
  const sha256 = hashBuf ? parseSha256Sidecar(hashBuf.toString('utf8')) : null;
  return { url, sha256 };
}

/** True when a version-keyed payload object exists (backs the availability gate). */
export function agentPackageExists(
  storage: AgentPackageDownloadStorage,
  version: string,
  platform: AgentPlatform,
): Promise<boolean> {
  return storage.has(agentPackageKey(version, platform));
}
