/**
 * Comparing a self-reported agent version against a feature's minimum.
 *
 * An agent reports its own package version in `agent.register`
 * (`agentRegisterSchema.version`), and the field is optional — an agent old
 * enough to omit it predates every feature this module gates on. The
 * orchestrator and the agent are deployed and upgraded independently
 * (`.claude/rules/compatibility.md`), so a feature the orchestrator ships is
 * routinely dispatched to a fleet that cannot run it, and the version is the
 * only fact the orchestrator has about what the fleet understands.
 */

/** A version's release triple, with any prerelease suffix dropped. */
type VersionBase = [number, number, number];

/**
 * Parse `MAJOR.MINOR.PATCH`, ignoring any `-prerelease` suffix, or `null` when
 * the string is not a version at all.
 *
 * The prerelease suffix is dropped rather than ordered because the suffixes in
 * play are build counters from the dev registry (`0.5.0-9159`), not semver
 * release candidates. Strict semver orders those BELOW `0.5.0`, which would
 * read every staging agent as too old for a feature it in fact carries.
 */
export function parseVersionBase(version: string): VersionBase | null {
  const parts = version.trim().split('-')[0].split('.');
  if (parts.length !== 3) return null;
  const nums = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  if (nums.some((n) => Number.isNaN(n))) return null;
  return [nums[0], nums[1], nums[2]];
}

/**
 * True when `version` is at least `minimum`, comparing release bases only.
 *
 * An absent or unparseable version returns `false`: the orchestrator learns
 * nothing from it, and a feature that needs a specific agent build must not
 * treat "we cannot tell" as "yes". Callers decide what an all-unknown fleet
 * means for them — this function only reports what the version proves.
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
