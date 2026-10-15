/**
 * Bounded memo for compiled trigger matchers: compilation is pure per pattern
 * string, so each distinct pattern compiles once. An insertion-ordered Map with
 * oldest-eviction bounds it without a new dependency and keeps the engine
 * barrel browser-safe (no node:* imports).
 */
import picomatch from 'picomatch';
import { assertSafeRegex } from '../safe-regex.js';
import { stripStatefulRegexFlags } from '../regex-flags.js';

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
 * Return a memoized RegExp. The key is the flags, a space, then the pattern;
 * flags are restricted to `[dimsuv]` once the stateful ones are stripped, so
 * the separator never collides with a pattern that starts with a space.
 *
 * `g` and `y` are dropped before compiling AND before building the key
 * (`stripStatefulRegexFlags`): they make the instance carry `lastIndex` between
 * calls, which turns a memoized `.test()` into alternating verdicts. Stripping
 * here, not only at the producers, keeps a lock file from an older compiler
 * safe — that format is compat-protected, so `flags: 'g'` entries keep arriving
 * for the whole 0.x line.
 *
 * Every pattern here is author-supplied (branch/tag/repo patterns and comment
 * `bodyMatch`), so it is ReDoS-checked inside the memo factory: a benign
 * pattern pays the check once, and a catastrophic one throws and is never
 * cached, so it is rejected on every attempt. `ctx` names the dialect in the
 * thrown error.
 */
export function getCompiledRegex(pattern: string, flags?: string, ctx = 'trigger pattern'): RegExp {
  const safeFlags = stripStatefulRegexFlags(flags);
  return boundedGet(regexCache, `${safeFlags} ${pattern}`, () => {
    assertSafeRegex(pattern, safeFlags, ctx);
    return new RegExp(pattern, safeFlags);
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
 * Repo-identifier matcher: {@link getGlobMatcher} with picomatch's
 * `dot: true`, so `**` matches a dot-prefixed identifier (`.hidden/repo`) —
 * `repos: ['**']` is documented as "every repo in the org".
 *
 * Deliberately NOT the shared matcher: `dot: true` on path globs would make
 * `paths: ['**']` match `.github/**` for every existing workflow.
 *
 * A bare `.` matches in neither mode; that is upstream picomatch behavior.
 */
export function getRepoGlobMatcher(pattern: string): (s: string) => boolean {
  return boundedGet(repoGlobCache, pattern, () => picomatch(pattern, { dot: true }));
}
