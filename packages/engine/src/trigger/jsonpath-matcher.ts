/**
 * JSONPath payload matching for `kici_event` and `generic_webhook` triggers.
 */
import { JSONPath } from 'jsonpath-plus';
import { assertSafeRegex } from '../safe-regex.js';

/**
 * True when every JSONPath key in `match` (e.g. `$.env`) resolves in `payload`
 * to the expected value: an exact value, a regex string (`/.../` or
 * `/.../flags`), or an array of acceptable values. A path that resolves to
 * nothing fails. An empty `match` matches everything.
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
      return false;
    }

    if (!matchValue(results, expected)) {
      return false;
    }
  }

  return true;
}

/**
 * Negative filter: true when NONE of the `not` expressions match `payload`. A
 * path that resolves to nothing does not match. Undefined or empty `not` passes.
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
      continue;
    }

    if (matchValue(results, expected)) {
      return false;
    }
  }

  return true;
}

/** True when any result equals `expected`, or any of its values when it is an array. */
function matchValue(results: unknown[], expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return results.some((r) => expected.some((e) => valueEquals(r, e)));
  }

  return results.some((r) => valueEquals(r, expected));
}

/**
 * Strict equality, except that a `/.../` or `/.../flags` string compared with a
 * string result is a regex test.
 */
function valueEquals(result: unknown, expected: unknown): boolean {
  if (typeof expected === 'string' && typeof result === 'string') {
    const regexMatch = /^\/(.+)\/([gimsuy]*)$/.exec(expected);
    if (regexMatch) {
      // Author-supplied `/re/flags` from lock-file data — ReDoS-check before
      // compiling so a catastrophic pattern is rejected, never silently run.
      assertSafeRegex(regexMatch[1], regexMatch[2], 'jsonpath match');
      const regex = new RegExp(regexMatch[1], regexMatch[2]);
      return regex.test(result);
    }
    return result === expected;
  }

  return result === expected;
}
