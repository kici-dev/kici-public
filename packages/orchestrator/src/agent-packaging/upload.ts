import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AgentPlatform } from '@kici-dev/shared';

/** Minimal storage surface — satisfied by the orchestrator S3 cache storage client. */
export interface AgentPackageStorage {
  put(key: string, data: Buffer | string): Promise<void>;
}

/** The cache-bucket sub-prefix under which all version-keyed payloads live. */
export const AGENT_PACKAGES_PREFIX = 'agent-packages/';

/** Cache-bucket key for a version-keyed agent payload. */
export function agentPackageKey(version: string, platform: AgentPlatform): string {
  return `${AGENT_PACKAGES_PREFIX}${version}/kici-agent-${platform}.tar.gz`;
}

/**
 * Parse an `agent-packages/<version>/kici-agent-<platform>.tar.gz` key back into
 * its version + platform, or null when the key is not a payload tarball (e.g. a
 * `.sha256` sidecar or an unrelated key). Used to discover the fleet's platform
 * set from the store on upgrade.
 */
export function parseAgentPackageKey(
  key: string,
): { version: string; platform: AgentPlatform } | null {
  const match = /^agent-packages\/([^/]+)\/kici-agent-([^/]+)\.tar\.gz$/.exec(key);
  if (!match) return null;
  const platform = AgentPlatform.safeParse(match[2]);
  if (!platform.success) return null;
  return { version: match[1]!, platform: platform.data };
}

/** Upload a produced payload + its sha256 sidecar to the cache bucket. */
export async function uploadAgentPackage(
  storage: AgentPackageStorage,
  version: string,
  platform: AgentPlatform,
  tarballPath: string,
  sha256: string,
): Promise<{ key: string }> {
  const key = agentPackageKey(version, platform);
  await storage.put(key, readFileSync(tarballPath));
  await storage.put(`${key}.sha256`, `${sha256}  ${path.basename(tarballPath)}\n`);
  return { key };
}
