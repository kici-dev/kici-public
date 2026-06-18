/**
 * JSONPath payload matching utility for trigger evaluation.
 *
 * Evaluates JSONPath expressions against webhook/event payloads for
 * kici_event and generic_webhook trigger types.
 *
 * Uses jsonpath-plus for JSONPath evaluation.
 */
import { JSONPath } from 'jsonpath-plus';

/**
 * Match all JSONPath expressions in `match` against `payload`.
 *
 * Each key in `match` is a JSONPath expression (e.g. `$.env`).
 * Each value is the expected match: exact value, regex string (wrapped in /.../ or /..../flags),
 * or array of acceptable values.
 *
 * ALL expressions must match for the overall result to be true.
 * An empty `match` object matches everything.
 *
 * @param payload - The event payload to match against
 * @param match - Map of JSONPath expressions to expected values
 * @returns true if all expressions match
 */
export function matchJsonPath(
  payload: Record<string, unknown>,
  match: Record<string, unknown>,
): boolean {
  const entries = Object.entries(match);
  if (entries.length === 0) return true;

  for (const [path, expected] of entries) {
    const results = JSONPath({ path, json: payload, wrap: true }) as unknown[];

    if (results.length === 0) {
      // Path not found in payload -- no match
      return false;
    }

    if (!matchValue(results, expected)) {
      return false;
    }
  }

  return true;
}

/**
 * Negative JSONPath filter.
 *
 * Returns true if NONE of the `not` expressions match against `payload`.
 * If `not` is undefined or empty, returns true (no negative filter = pass).
 *
 * @param payload - The event payload to match against
 * @param not - Map of JSONPath expressions that should NOT match
 * @returns true if none of the expressions match
 */
export function matchJsonPathNot(
  payload: Record<string, unknown>,
  not: Record<string, unknown> | undefined,
): boolean {
  if (!not) return true;

  const entries = Object.entries(not);
  if (entries.length === 0) return true;

  for (const [path, expected] of entries) {
    const results = JSONPath({ path, json: payload, wrap: true }) as unknown[];

    if (results.length === 0) {
      // Path not found -- not-expression doesn't match, continue
      continue;
    }

    if (matchValue(results, expected)) {
      // A not-expression matched -- fail
      return false;
    }
  }

  return true;
}

/**
 * Check if any element in JSONPath results matches the expected value.
 *
 * Supports:
 * - Exact value comparison (primitives)
 * - Array of acceptable values (any match = pass)
 * - Regex string matching (for string results, wrapped in /pattern/ or /pattern/flags)
 */
function matchValue(results: unknown[], expected: unknown): boolean {
  // Array of acceptable values: any result matching any acceptable value = pass
  if (Array.isArray(expected)) {
    return results.some((r) => expected.some((e) => valueEquals(r, e)));
  }

  // Single expected value: any result matching = pass
  return results.some((r) => valueEquals(r, expected));
}

/**
 * Compare a single result to an expected value.
 * For string expected values, supports regex patterns wrapped in /.../ or /.../flags.
 */
function valueEquals(result: unknown, expected: unknown): boolean {
  // String comparison with optional regex support
  if (typeof expected === 'string' && typeof result === 'string') {
    // Check for regex pattern: /pattern/ or /pattern/flags
    const regexMatch = /^\/(.+)\/([gimsuy]*)$/.exec(expected);
    if (regexMatch) {
      const regex = new RegExp(regexMatch[1], regexMatch[2]);
      return regex.test(result);
    }
    return result === expected;
  }

  // Primitive comparison (number, boolean, null)
  return result === expected;
}
