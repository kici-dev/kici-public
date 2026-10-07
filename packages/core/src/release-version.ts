/** Prerelease identifiers use the semver charset only, so a version never carries shell syntax. */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const ALL_DIGITS_RE = /^\d+$/;

/** Two all-digit identifiers compare numerically (semver); anything else compares as strings. */
function comparePrerelease(a: string, b: string): number {
  if (ALL_DIGITS_RE.test(a) && ALL_DIGITS_RE.test(b)) return Number(a) - Number(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Numeric MAJOR.MINOR.PATCH order; a prerelease sorts below its own base, and
 * all-digit prerelease identifiers sort numerically (`-9700` < `-10000`).
 */
export function compareReleaseVersions(a: string, b: string): number {
  const ma = a.match(VERSION_RE);
  const mb = b.match(VERSION_RE);
  if (!ma || !mb) throw new Error(`not a version: ${!ma ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d;
  }
  const pa = ma[4];
  const pb = mb[4];
  if (pa === undefined && pb === undefined) return 0;
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  return comparePrerelease(pa, pb);
}
