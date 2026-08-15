/**
 * Bounded memo for compiled trigger matchers. Regex and glob compilation is
 * pure and deterministic per pattern string, so we compile each distinct
 * pattern once and reuse it across every match call. Insertion-ordered Map
 * with oldest-eviction keeps the memo bounded without a new dependency, and
 * keeps the engine barrel browser-safe (no node:* imports).
 */
import picomatch from 'picomatch';
import { assertSafeRegex } from '../safe-regex.js';

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
const repoGlobCache = new Map<string, (s: string) => boolean>();

/**
 * Return a memoized RegExp for the given pattern + flags. The key encodes the
 * flags first with a space separator; regex flags are restricted to
 * `[gimsuydv]`, so the separator can never collide with a pattern that starts
 * with a space.
 *
 * Every pattern reaching here is author-supplied (branch/tag/repo patterns and
 * comment `bodyMatch`), so it is ReDoS-checked before compiling. The guard runs
 * inside the memo factory, so a benign pattern pays the check once (on cache
 * miss) and a catastrophic one throws — and, being unsafe, is never cached, so
 * it is rejected on every attempt. `ctx` names the dialect in the thrown error.
 */
export function getCompiledRegex(pattern: string, flags?: string, ctx = 'trigger pattern'): RegExp {
  return boundedGet(regexCache, `${flags ?? ''} ${pattern}`, () => {
    assertSafeRegex(pattern, flags ?? '', ctx);
    return new RegExp(pattern, flags);
  });
}

/**
 * Return a memoized picomatch matcher function for the given glob pattern.
 * `getGlobMatcher(pattern)(str)` is equivalent to `picomatch.isMatch(str, pattern)`.
 */
export function getGlobMatcher(pattern: string): (s: string) => boolean {
  return boundedGet(globCache, pattern, () => picomatch(pattern));
}

/**
 * Repo-identifier matcher. Identical to {@link getGlobMatcher} except it sets
 * picomatch's `dot: true`, so a dot-prefixed identifier (`.hidden/repo`) is
 * matched by `**` — `repos: ['**']` is documented as "every repo in the org",
 * and silently excluding a whole class of identifier contradicts that.
 *
 * Deliberately NOT the shared matcher: `dot: true` on path globs would make
 * `paths: ['**']` start matching `.github/**` for every existing workflow, a
 * semantics change this does not intend.
 *
 * Note a bare `.` still does not match, in either mode — picomatch will not
 * match a lone `.`. That is upstream behavior, not something this option fixes.
 */
export function getRepoGlobMatcher(pattern: string): (s: string) => boolean {
  return boundedGet(repoGlobCache, pattern, () => picomatch(pattern, { dot: true }));
}
