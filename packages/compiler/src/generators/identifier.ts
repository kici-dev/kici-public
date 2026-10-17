/**
 * Identifier helpers for generated TypeScript source.
 */

/** Any character outside printable ASCII. */
const NON_ASCII = /[^ -~]/g;
const SEPARATORS = /[^A-Za-z0-9]+/;

/**
 * Whether `name` is an ASCII TypeScript identifier, usable unquoted as a
 * property name.
 */
export function isValidIdentifier(name: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name);
}

/**
 * Build an identifier from `prefix` and free text such as a git branch name.
 *
 * Accented letters fold to their ASCII base letter (NFKD), other non-ASCII
 * characters are dropped, and every run of characters outside `[A-Za-z0-9]`
 * separates words. Each word gets an upper-case first letter and is appended to
 * `prefix`: `toIdentifier('push', 'ci/kici')` is `pushCiKici`. When no word
 * survives, or the result cannot start an identifier, the result is
 * `prefix + 'Branch'`.
 */
export function toIdentifier(prefix: string, raw: string): string {
  const words = raw
    .normalize('NFKD')
    .replace(NON_ASCII, '')
    .split(SEPARATORS)
    .filter((word) => word !== '');
  const joined =
    prefix + words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
  if (words.length > 0 && isValidIdentifier(joined)) return joined;
  const fallback = `${prefix}Branch`;
  if (!isValidIdentifier(fallback)) {
    throw new Error(`toIdentifier: prefix ${JSON.stringify(prefix)} cannot start an identifier`);
  }
  return fallback;
}
