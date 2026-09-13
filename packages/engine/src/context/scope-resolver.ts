import picomatch from 'picomatch';
import type { ContextBinding, ScopedSecret } from './types.js';
import { hostSpecificity, matchHostPattern, type HostFacts } from './host-match.js';
import { substituteScopePattern } from './scope-template.js';

export type { HostFacts } from './host-match.js';

/**
 * Check whether a scope string matches a pattern.
 *
 * Supports exact match and glob patterns (via picomatch).
 * Scope paths use '/' as separator (e.g., 'aws/prod/db').
 *
 * For prefixed scopes (e.g., 'pg:aws/prod'), the pattern may be prefixed too
 * (e.g., 'pg:**'). In this case, the backend prefix must match exactly and
 * the path portion is matched separately against the glob. This is needed
 * because picomatch's '**' requires '/' separators — 'pg:**' wouldn't match
 * 'pg:aws/prod' without splitting on the colon.
 */
export function matchScopePattern(scope: string, pattern: string): boolean {
  if (scope === pattern) return true;

  // If both have a colon prefix, split and match separately
  const scopeColon = scope.indexOf(':');
  const patternColon = pattern.indexOf(':');

  if (scopeColon >= 0 && patternColon >= 0) {
    const scopePrefix = scope.slice(0, scopeColon);
    const patternPrefix = pattern.slice(0, patternColon);

    // Backend prefixes must match exactly
    if (scopePrefix !== patternPrefix) return false;

    const scopePath = scope.slice(scopeColon + 1);
    const patternPath = pattern.slice(patternColon + 1);

    if (scopePath === patternPath) return true;
    return picomatch.isMatch(scopePath, patternPath);
  }

  // Scope has backend prefix but pattern doesn't — strip prefix before matching.
  // Binding patterns are stored without prefix (e.g., "test-pg") but secrets are
  // prefixed by collectAllSecrets (e.g., "pg:test-pg"). Match against the path portion.
  if (scopeColon >= 0 && patternColon < 0) {
    const scopePath = scope.slice(scopeColon + 1);
    if (scopePath === pattern) return true;
    return picomatch.isMatch(scopePath, pattern);
  }

  return picomatch.isMatch(scope, pattern);
}

/**
 * Strip the backend prefix from a scope string.
 * Prefixed scopes have the form "backendName:path" (e.g., "pg:aws/prod").
 * Returns the path after the first colon, or the full scope if no prefix.
 */
export function stripScopePrefix(scope: string): string {
  const colonIdx = scope.indexOf(':');
  return colonIdx >= 0 ? scope.slice(colonIdx + 1) : scope;
}

/**
 * Resolve the effective scope pattern a binding contributes for a given host,
 * applying the host gate and per-child scope-pattern templating.
 *
 * Returns the (possibly substituted) scope pattern to glob-match secrets
 * against, or `null` when the binding contributes nothing for this host:
 * - With `hostFacts`: skipped when `host_pattern` doesn't match, or when a
 *   templated `scope_pattern` can't be substituted (missing label / unsafe
 *   value).
 * - Without `hostFacts` (workflow-level, no-host caller): only `'**'`/NULL
 *   host bindings contribute, and a templated `scope_pattern` is skipped (it
 *   cannot be substituted without facts).
 */
function bindingScopeForHost(
  binding: ContextBinding,
  hostFacts: HostFacts | undefined,
): string | null {
  if (hostFacts) {
    if (!matchHostPattern(hostFacts, binding.hostPattern)) return null;
    return substituteScopePattern(binding.scopePattern, hostFacts);
  }
  // No host facts: fleet-wide bindings only, and templated scopes are skipped.
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
 * applying the host gate and `(host specificity, scope depth)` precedence — WITHOUT
 * decrypting, keeping this module crypto-free. This is the single source of truth for
 * scope precedence; `resolveSecretsForContext` delegates to it and adds the decrypt step.
 *
 * Takes already-filtered bindings (for the target context). For each binding, finds
 * secrets whose (substituted) scope matches the binding's scopePattern via picomatch.
 * When multiple scopes provide the same key, precedence is the tuple
 * `(host specificity, scope depth)` — a per-host binding (exact host) overrides a
 * fleet-wide one, then longest scope path wins. Scope depth is computed AFTER stripping
 * the backend prefix.
 *
 * When `hostFacts` is supplied (a fan-out child's identity), each binding is gated by
 * its `host_pattern` and its `scope_pattern` is templated per-child
 * (`${agentId}`/`${host}`/`${label:NAME}`). When omitted, only fleet-wide (`'**'`/NULL)
 * non-templated bindings contribute — preserving the workflow-level (no-host) behaviour.
 *
 * @param bindings - Bindings already filtered for the target context
 * @param allSecrets - All scoped secrets in the org
 * @param hostFacts - Optional fan-out child identity for per-host resolution
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
 * Resolve secrets for a context by matching bindings against scoped secrets.
 *
 * Takes already-filtered bindings (for the target context). For each binding,
 * finds secrets whose (substituted) scope matches the binding's scopePattern via
 * picomatch. When multiple scopes provide the same key, precedence is the tuple
 * `(host specificity, scope depth)` — a per-host binding (exact host) overrides a
 * fleet-wide one, then longest scope path wins. Scope depth is computed AFTER
 * stripping the backend prefix.
 *
 * When `hostFacts` is supplied (a fan-out child's identity), each binding is
 * gated by its `host_pattern` and its `scope_pattern` is templated per-child
 * (`${agentId}`/`${host}`/`${label:NAME}`). When omitted, only fleet-wide
 * (`'**'`/NULL) non-templated bindings contribute — preserving the workflow-level
 * (no-host) behaviour.
 *
 * Delegates precedence to `resolveSecretsWithProvenance` and applies `decryptFn`
 * to each winning secret.
 *
 * @param bindings - Bindings already filtered for the target context
 * @param allSecrets - All scoped secrets in the org
 * @param decryptFn - Pure decryption function (keeps this module crypto-free)
 * @param hostFacts - Optional fan-out child identity for per-host resolution
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
