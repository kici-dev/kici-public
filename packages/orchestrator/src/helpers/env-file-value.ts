/**
 * Checks for a value an orchestrator writes into an env file.
 */

/**
 * Whether a value written into an env file would start a second line there.
 * Shared by every writer that puts an operator-supplied value into one.
 */
export function containsLineBreak(value: string): boolean {
  return /[\r\n]/.test(value);
}
