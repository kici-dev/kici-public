const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Page size from a `?limit=` query: a missing, non-numeric or non-positive value is 50; the cap is 200. */
export function clampLimit(raw: string | undefined): number {
  const parsed = parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}
