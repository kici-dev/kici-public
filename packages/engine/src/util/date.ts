/**
 * ISO-8601 for a timestamp column that a Postgres driver returns as a `Date`
 * and a JSON round-trip or a mock returns as a string. A string passes through
 * unchanged (never re-parsed).
 */
export function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
