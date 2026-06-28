/** Postgres SQLSTATE for a unique-violation. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * True iff `err` is a Postgres unique-violation, optionally scoped to a named
 * constraint. Pure guard over `unknown` — no `pg` import — so callers in the
 * data layer can translate a raw driver error into a domain error, and it can
 * be unit-tested without a live database.
 */
export function isPgUniqueViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  if (e.code !== PG_UNIQUE_VIOLATION) return false;
  if (constraint !== undefined && e.constraint !== constraint) return false;
  return true;
}
