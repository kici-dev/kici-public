/**
 * Availability gate for version-keyed agent packages.
 *
 * The fleet auto-upgrade convergence NEVER rolls a host to a version whose
 * self-contained payload objects don't exist in the cache bucket — that would
 * stage stale/absent bytes (or leave the fleet at a version skew). This helper
 * `head`s each platform's payload object and reports which are missing, so the
 * caller can HOLD (the convergence gate) or skip re-producing (the upgrade
 * hook). It never throws — the caller decides hold-vs-alarm.
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
 * Fail-closed by construction: an absent object lands in `missing`, so a caller
 * that gates on `available` can never converge onto a version whose bytes are
 * not present.
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
