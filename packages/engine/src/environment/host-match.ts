import { matcherMatches, type LabelMatcher } from '../labels-match.js';
import { assertSafeRegex, toLabelMatcher } from '../labels/compile.js';

/**
 * Identity facts of a single fan-out child, matched against a binding's
 * `host_pattern`. `agentId` / `host` are the stable dispatch identity; `labels`
 * is the host's label set. The union of all three is the match target.
 */
export interface HostFacts {
  agentId: string;
  host: string;
  labels: readonly string[];
}

/** `'**'`, empty, or absent means "matches every host". */
function matchesAllHosts(pattern: string): boolean {
  return pattern === '' || pattern === '**';
}

/** True when `pattern` is the `/source/flags` regex-string convention. */
function asRegexString(pattern: string): { source: string; flags: string } | null {
  if (pattern.length < 2 || !pattern.startsWith('/')) return null;
  const lastSlash = pattern.lastIndexOf('/');
  if (lastSlash === 0) return null;
  return { source: pattern.slice(1, lastSlash), flags: pattern.slice(lastSlash + 1) };
}

/**
 * Compile a `host_pattern` string into a `LabelMatcher`.
 *
 * - `/source/flags` → regex matcher (ReDoS-gated).
 * - a glob (picomatch-detected) → regex matcher.
 * - any other string → exact matcher.
 */
function compileHostPattern(pattern: string): LabelMatcher {
  const re = asRegexString(pattern);
  if (re) {
    assertSafeRegex(re.source, re.flags, `host_pattern /${re.source}/${re.flags}`);
    return { kind: 'regex', source: re.source, flags: re.flags };
  }
  return toLabelMatcher(pattern, `host_pattern '${pattern}'`);
}

/**
 * Whether a fan-out child's identity facts satisfy a binding's `host_pattern`.
 *
 * `'**'` / empty matches every host. Otherwise the pattern is compiled once
 * (exact / glob / regex, same selector grammar as `runsOnAll`) and tested
 * against the union `[agentId, host, ...labels]` — true if any element matches.
 */
export function matchHostPattern(facts: HostFacts, pattern: string): boolean {
  if (matchesAllHosts(pattern)) return true;
  const matcher = compileHostPattern(pattern);
  const candidates = [facts.agentId, facts.host, ...facts.labels];
  return candidates.some((c) => matcherMatches(matcher, c));
}

/**
 * Rank a `host_pattern` by specificity for precedence: an exact literal (2)
 * beats a glob/regex (1), which beats `'**'`/empty (0). Used to let a per-host
 * binding override a fleet-wide one on a key collision.
 */
export function hostSpecificity(pattern: string): number {
  if (matchesAllHosts(pattern)) return 0;
  if (asRegexString(pattern)) return 1;
  return toLabelMatcher(pattern, `host_pattern '${pattern}'`).kind === 'regex' ? 1 : 2;
}
