/**
 * The single definition of what `contains` / `notContains` / `matches` /
 * `notMatches` mean.
 *
 * Two sites consume it: the Tier-0 `commitMessage` trigger filter (in
 * `matcher.ts`) and the Tier-1 `requires` content filter (in
 * `content-requirements.ts`). Sharing one function is what keeps them from
 * drifting into two dialects of the same vocabulary.
 *
 * Pure string logic — it imports only `safe-regex` and no Node built-in, so it
 * belongs in the browser-safe barrel rather than a subpath export.
 */
import safeRegex from 'safe-regex';
import type { LockTextMatch, TextMatch } from './types.js';

/** A definite verdict, or fail-visible indeterminate. Mirrors `ContentRequirementResult`. */
export interface TextMatchResult {
  readonly pass: boolean;
  /** Set (with `pass: false`) when the match could not be evaluated. */
  readonly indeterminate?: string;
}

/**
 * Compile a `/pattern/flags` (or bare-pattern) string, rejecting a ReDoS-prone
 * pattern. Returns `null` when the pattern is syntactically invalid or fails the
 * `safe-regex` star-height heuristic — callers treat `null` as indeterminate.
 *
 * Always compiles a FRESH RegExp. A `g`-flagged instance carries `lastIndex`
 * across `.test()` calls, so a cached one would return alternating verdicts for
 * the same input.
 */
export function compileSafeRegex(source: string): RegExp | null {
  const wrapped = /^\/(.+)\/([gimsuy]*)$/.exec(source);
  const pattern = wrapped ? wrapped[1] : source;
  const flags = wrapped ? wrapped[2] : '';
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    return null;
  }
  return safeRegex(re) ? re : null;
}

/** True when the matcher carries at least one populated query key. */
export function textMatchHasQuery(m: TextMatch | LockTextMatch): boolean {
  const populated = (v: unknown): boolean =>
    Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null;
  return (
    populated(m.contains) ||
    populated(m.notContains) ||
    populated(m.matches) ||
    populated(m.notMatches)
  );
}

/** Render the populated keys for a decision-trace `pattern` field. */
export function describeTextMatch(m: LockTextMatch): string {
  const parts: string[] = [];
  if (m.contains?.length) parts.push(`contains: [${m.contains.join(', ')}]`);
  if (m.notContains?.length) parts.push(`notContains: [${m.notContains.join(', ')}]`);
  if (m.matches?.length) parts.push(`matches: [${m.matches.join(', ')}]`);
  if (m.notMatches?.length) parts.push(`notMatches: [${m.notMatches.join(', ')}]`);
  if (m.ignoreCase) parts.push('ignoreCase');
  return parts.length > 0 ? parts.join('; ') : '(no query)';
}

/** Evaluate every regex in `sources`; `expectMatch` selects matches vs notMatches. */
function evaluateRegexes(
  text: string,
  sources: readonly string[],
  expectMatch: boolean,
): TextMatchResult {
  for (const source of sources) {
    const re = compileSafeRegex(source);
    if (!re) {
      return { pass: false, indeterminate: `unsafe or invalid regex: ${source}` };
    }
    if (re.test(text) !== expectMatch) return { pass: false };
  }
  return { pass: true };
}

/**
 * Evaluate a text match. Every entry in every list is a conjunct, and every
 * populated key ANDs with the others; an empty matcher passes.
 */
export function evaluateTextMatch(text: string, m: LockTextMatch): TextMatchResult {
  const fold = (s: string): string => (m.ignoreCase === true ? s.toLowerCase() : s);
  const haystack = fold(text);

  for (const needle of m.contains ?? []) {
    if (!haystack.includes(fold(needle))) return { pass: false };
  }
  for (const needle of m.notContains ?? []) {
    if (haystack.includes(fold(needle))) return { pass: false };
  }

  if (m.matches?.length) {
    const result = evaluateRegexes(text, m.matches, true);
    if (!result.pass) return result;
  }
  if (m.notMatches?.length) {
    const result = evaluateRegexes(text, m.notMatches, false);
    if (!result.pass) return result;
  }

  return { pass: true };
}
