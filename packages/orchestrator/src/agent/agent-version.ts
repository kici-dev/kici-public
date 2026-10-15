/**
 * Compare a self-reported agent version against a feature's minimum.
 *
 * The version comes from `agent.register` (`agentRegisterSchema.version`) and
 * is optional; an agent that omits it predates every feature gated here.
 * Orchestrator and agent upgrade independently, so the version is the only
 * fact the orchestrator has about what the fleet can run.
 */

/** A version's release triple, with any prerelease suffix dropped. */
type VersionBase = [number, number, number];

/**
 * Parse `MAJOR.MINOR.PATCH`, or `null` for a non-version. The `-prerelease`
 * suffix is dropped rather than ordered: it is a build counter (`0.5.0-9159`),
 * and strict semver would order it BELOW `0.5.0`, reading every prerelease
 * agent as too old for a feature it carries.
 */
export function parseVersionBase(version: string): VersionBase | null {
  const parts = version.trim().split('-')[0].split('.');
  if (parts.length !== 3) return null;
  const nums = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  if (nums.some((n) => Number.isNaN(n))) return null;
  return [nums[0], nums[1], nums[2]];
}

/**
 * True when `version` is at least `minimum`, comparing release bases only. An
 * absent or unparseable version is `false`: "cannot tell" must not read as
 * "yes". Callers decide what an all-unknown fleet means.
 */
export function agentVersionAtLeast(version: string | null | undefined, minimum: string): boolean {
  if (typeof version !== 'string' || version.length === 0) return false;
  const actual = parseVersionBase(version);
  const required = parseVersionBase(minimum);
  if (actual === null || required === null) return false;
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== required[i]) return actual[i] > required[i];
  }
  return true;
}
