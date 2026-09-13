import type { HostFacts } from './host-match.js';

/** A substituted value must be a single literal path segment — no `/` or glob. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const PLACEHOLDER = /\$\{(agentId|host|label:[^}]+)\}/g;

/**
 * Substitute `${agentId}` / `${host}` / `${label:NAME}` placeholders in a
 * binding's `scope_pattern` with a fan-out child's identity, so one templated
 * binding selects each host's own subtree (`prod/hosts/${agentId}/**`).
 *
 * Returns the substituted pattern, or `null` when the binding must be **skipped
 * for this host** because either:
 * - a referenced variable is unresolved (a missing `${label:NAME}`), or
 * - a substituted value is unsafe — it contains anything outside
 *   `[A-Za-z0-9._-]` (a `/` path separator or a glob metacharacter), which
 *   could let a hostname/label value escape its segment or inject a pattern.
 *
 * A multi-valued label resolves to its lexicographic-first value
 * (deterministic). A pattern with no placeholders is returned unchanged.
 */
export function substituteScopePattern(pattern: string, facts: HostFacts): string | null {
  if (!pattern.includes('${')) return pattern;
  let unresolved = false;
  const out = pattern.replace(PLACEHOLDER, (_m, token: string) => {
    let value: string | undefined;
    if (token === 'agentId') value = facts.agentId;
    else if (token === 'host') value = facts.host;
    else {
      const name = token.slice('label:'.length);
      const prefix = `${name}:`;
      const hits = facts.labels
        .filter((l) => l.startsWith(prefix))
        .map((l) => l.slice(prefix.length))
        .sort();
      value = hits[0];
    }
    if (value === undefined || !SAFE_SEGMENT.test(value)) {
      unresolved = true;
      return '';
    }
    return value;
  });
  return unresolved ? null : out;
}
