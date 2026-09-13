import { canonicalizeLabel } from '../labels-canonical.js';
import { canonicalizeMatcher, matcherMatches, type LabelMatcher } from '../labels-match.js';
import { assertSafeRegex, toLabelMatcher } from '../labels/compile.js';

/**
 * Identity facts of a single fan-out child, matched against a binding's
 * `host_pattern`. `agentId` / `host` are the stable dispatch identity; `labels`
 * is the host's label set. All three are match targets, but not on the same
 * terms — see {@link matchHostPattern}.
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
 * against `agentId`, `host` and every label — true if any of them matches. The
 * three are NOT compared on the same terms:
 *
 * - **The agent id compares exactly.** A pattern bound to `prod-01` must never
 *   bind to an agent `PROD-01` — a scoped secret would reach a host it was not
 *   written for. An agent id is an opaque identifier with no case convention,
 *   so there is no case to fold away.
 * - **Hostnames and labels compare case-insensitively.** The roster stores
 *   both canonical, so the pattern is folded to meet them; without this a
 *   binding written as `host_pattern: 'Docker'` would silently stop matching a
 *   `docker` label, and one written as `'Build-Box-01'` would stop matching the
 *   hostname it names. Folding the host arm also settles an asymmetry: a
 *   hostname is already reachable case-insensitively through its derived
 *   `kici:host:<hostname>` label, so leaving the host arm exact made the same
 *   host match under one spelling of the pattern and not the other.
 *
 * The host arm carries one guard. `facts.host` is not reliably a hostname:
 * both callers fall back to the agent id when the roster row has no hostname
 * (`row.hostname ?? row.agent_id`, `mat.host ?? mat.pinnedAgentId`), so folding
 * it unconditionally would fold an identifier in disguise and let a binding on
 * `prod-01` reach an agent `PROD-01`. That fallback is redundant here — when
 * `facts.host` IS the agent id it was already compared exactly on the first arm
 * — so skipping the host arm in that case loses no match.
 */
export function matchHostPattern(facts: HostFacts, pattern: string): boolean {
  if (matchesAllHosts(pattern)) return true;
  const matcher = compileHostPattern(pattern);
  if (matcherMatches(matcher, facts.agentId)) return true;
  const labelMatcher = canonicalizeMatcher(matcher);
  if (facts.host !== facts.agentId && matcherMatches(labelMatcher, canonicalizeLabel(facts.host)))
    return true;
  return facts.labels.some((l) => matcherMatches(labelMatcher, canonicalizeLabel(l)));
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
