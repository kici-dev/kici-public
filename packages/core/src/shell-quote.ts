/**
 * Single-quote a value for a POSIX shell. Always quotes, even a value with no
 * special characters; an embedded `'` becomes `'\''`.
 */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
