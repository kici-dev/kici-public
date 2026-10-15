/**
 * Availability gate for version-keyed agent packages.
 *
 * Fleet auto-upgrade NEVER rolls a host to a version whose payload objects are
 * absent from the cache bucket: that stages stale or absent bytes, or leaves a
 * version skew. It never throws; the caller holds (convergence gate) or skips
 * re-producing (upgrade hook).
 */
import type { AgentPlatform } from '@kici-dev/shared';
import { agentPackageExists, type AgentPackageDownloadStorage } from './download.js';

/** Verdict of an availability check across a platform set for one version. */
export interface PayloadAvailability {
  /** True only when EVERY requested platform's payload object exists. */
  available: boolean;
  /** The platforms whose version-keyed payload object is absent. */
  missing: AgentPlatform[];
}

/**
 * Check that a version's agent payloads exist for every requested platform.
 * Fail-closed: an absent object lands in `missing`, so gating on `available`
 * never converges onto a version whose bytes are not present.
 */
export async function assertPayloadsAvailable(
  storage: AgentPackageDownloadStorage,
  version: string,
  platforms: AgentPlatform[],
): Promise<PayloadAvailability> {
  const missing: AgentPlatform[] = [];
  for (const platform of platforms) {
    if (!(await agentPackageExists(storage, version, platform))) {
      missing.push(platform);
    }
  }
  return { available: missing.length === 0, missing };
}
