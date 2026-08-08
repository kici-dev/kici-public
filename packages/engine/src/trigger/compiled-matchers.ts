/**
 * Bounded memo for compiled trigger matchers. Regex and glob compilation is
 * pure and deterministic per pattern string, so we compile each distinct
 * pattern once and reuse it across every match call. Insertion-ordered Map
 * with oldest-eviction keeps the memo bounded without a new dependency, and
 * keeps the engine barrel browser-safe (no node:* imports).
 */
import picomatch from 'picomatch';

const MAX_COMPILED = 5000;

function boundedGet<V>(cache: Map<string, V>, key: string, make: () => V): V {
  const existing = cache.get(key);
  if (existing !== undefined) return existing;
  const value = make();
  cache.set(key, value);
  if (cache.size > MAX_COMPILED) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value;
}

const regexCache = new Map<string, RegExp>();
const globCache = new Map<string, (s: string) => boolean>();

/**
 * Return a memoized RegExp for the given pattern + flags. The key encodes the
 * flags first with a space separator; regex flags are restricted to
 * `[gimsuydv]`, so the separator can never collide with a pattern that starts
 * with a space.
 */
export function getCompiledRegex(pattern: string, flags?: string): RegExp {
  return boundedGet(regexCache, `${flags ?? ''} ${pattern}`, () => new RegExp(pattern, flags));
}

/**
 * Return a memoized picomatch matcher function for the given glob pattern.
 * `getGlobMatcher(pattern)(str)` is equivalent to `picomatch.isMatch(str, pattern)`.
 */
export function getGlobMatcher(pattern: string): (s: string) => boolean {
  return boundedGet(globCache, pattern, () => picomatch(pattern));
}
