import picomatch from 'picomatch';
import type { ContextBinding, ScopedSecret } from './types.js';
import { hostSpecificity, matchHostPattern, type HostFacts } from './host-match.js';
import { substituteScopePattern } from './scope-template.js';

export type { HostFacts } from './host-match.js';

/**
 * Check whether a scope string matches a pattern: exact match or a picomatch
 * glob over '/'-separated paths (e.g., 'aws/prod/db').
 *
 * For a prefixed scope and pattern (e.g., 'pg:aws/prod' and 'pg:**'), the
 * backend prefix must match exactly and the path is globbed separately, because
 * picomatch's '**' needs '/' separators and would not match across the colon.
 */
export function matchScopePattern(scope: string, pattern: string): boolean {
  if (scope === pattern) return true;

  const scopeColon = scope.indexOf(':');
  const patternColon = pattern.indexOf(':');

  if (scopeColon >= 0 && patternColon >= 0) {
    const scopePrefix = scope.slice(0, scopeColon);
    const patternPrefix = pattern.slice(0, patternColon);

    if (scopePrefix !== patternPrefix) return false;

    const scopePath = scope.slice(scopeColon + 1);
    const patternPath = pattern.slice(patternColon + 1);

    if (scopePath === patternPath) return true;
    return picomatch.isMatch(scopePath, patternPath);
  }

  // Binding patterns are stored unprefixed ("test-pg") but collectAllSecrets
  // prefixes secrets ("pg:test-pg"), so match the scope's path portion.
  if (scopeColon >= 0 && patternColon < 0) {
    const scopePath = scope.slice(scopeColon + 1);
    if (scopePath === pattern) return true;
    return picomatch.isMatch(scopePath, pattern);
  }

  return picomatch.isMatch(scope, pattern);
}

/**
 * Strip the backend prefix ("backendName:path", e.g. "pg:aws/prod") from a scope:
 * returns the path after the first colon, or the full scope if no prefix.
 */
export function stripScopePrefix(scope: string): string {
  const colonIdx = scope.indexOf(':');
  return colonIdx >= 0 ? scope.slice(colonIdx + 1) : scope;
}

/**
 * The (possibly substituted) scope pattern a binding contributes for a host, or
 * `null` when it contributes nothing:
 * - With `hostFacts`: null when `host_pattern` doesn't match, or a templated
 *   `scope_pattern` can't be substituted (missing label / unsafe value).
 * - Without `hostFacts` (workflow-level caller): only `'**'`/NULL host
 *   bindings contribute, and templated scope patterns are skipped.
 */
function bindingScopeForHost(
  binding: ContextBinding,
  hostFacts: HostFacts | undefined,
): string | null {
  if (hostFacts) {
    if (!matchHostPattern(hostFacts, binding.hostPattern)) return null;
    return substituteScopePattern(binding.scopePattern, hostFacts);
  }
  if (binding.hostPattern !== '**' && binding.hostPattern !== '') return null;
  return binding.scopePattern.includes('${') ? null : binding.scopePattern;
}

/** The winning scoped secret for a key, with the precedence tuple that selected it. */
export interface ResolvedSecretCandidate {
  secret: ScopedSecret;
  scopeDepth: number;
  hostSpec: number;
}

/** Higher `(hostSpec, scopeDepth)` wins; ties keep the first-encountered. */
function candidateWins(
  c: ResolvedSecretCandidate,
  existing: ResolvedSecretCandidate | undefined,
): boolean {
  if (!existing) return true;
  if (c.hostSpec !== existing.hostSpec) return c.hostSpec > existing.hostSpec;
  return c.scopeDepth > existing.scopeDepth;
}

/**
 * Resolve the winning secret per key by matching bindings against scoped secrets,
 * WITHOUT decrypting, so this module stays crypto-free. This is the single source
 * of truth for scope precedence; `resolveSecretsForContext` adds the decrypt step.
 *
 * Each binding (already filtered for the target context) selects the secrets whose
 * scope its (substituted) scopePattern matches via picomatch. When several scopes
 * provide the same key, precedence is `(host specificity, scope depth)`: a per-host
 * binding (exact host) overrides a fleet-wide one, then the longest scope path wins.
 * Scope depth is computed AFTER stripping the backend prefix.
 *
 * With `hostFacts` (a fan-out child's identity), each binding is gated by its
 * `host_pattern` and its `scope_pattern` is templated per child
 * (`${agentId}`/`${host}`/`${label:NAME}`). Without it, only fleet-wide (`'**'`/NULL)
 * non-templated bindings contribute — the workflow-level (no-host) behaviour.
 *
 * @param allSecrets - All scoped secrets in the org
 * @returns Map of secret key → winning candidate (secret + precedence tuple)
 */
export function resolveSecretsWithProvenance(
  bindings: ContextBinding[],
  allSecrets: ScopedSecret[],
  hostFacts?: HostFacts,
): Map<string, ResolvedSecretCandidate> {
  const resolved = new Map<string, ResolvedSecretCandidate>();

  for (const binding of bindings) {
    const scopePattern = bindingScopeForHost(binding, hostFacts);
    if (scopePattern === null) continue;
    const hostSpec = hostSpecificity(binding.hostPattern);
    for (const secret of allSecrets) {
      if (!matchScopePattern(secret.scope, scopePattern)) continue;
      const scopeDepth = stripScopePrefix(secret.scope).split('/').length;
      const candidate: ResolvedSecretCandidate = { secret, scopeDepth, hostSpec };
      if (candidateWins(candidate, resolved.get(secret.key))) {
        resolved.set(secret.key, candidate);
      }
    }
  }

  return resolved;
}

/**
 * Resolve secrets for a context: the matching, host gating and
 * `(host specificity, scope depth)` precedence of `resolveSecretsWithProvenance`,
 * then `decryptFn` applied to each winning secret.
 *
 * @param decryptFn - Pure decryption function (keeps this module crypto-free)
 * @returns Flat record of decrypted secret key-value pairs
 */
export function resolveSecretsForContext(
  bindings: ContextBinding[],
  allSecrets: ScopedSecret[],
  decryptFn: (s: ScopedSecret) => string,
  hostFacts?: HostFacts,
): Record<string, string> {
  const resolved = resolveSecretsWithProvenance(bindings, allSecrets, hostFacts);
  const result: Record<string, string> = {};
  for (const [key, { secret }] of resolved) {
    result[key] = decryptFn(secret);
  }
  return result;
}
