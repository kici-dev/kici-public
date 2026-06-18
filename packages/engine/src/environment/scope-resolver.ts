import picomatch from 'picomatch';
import type { EnvironmentBinding, ScopedSecret } from './types.js';

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
 * Resolve secrets for an environment by matching bindings against scoped secrets.
 *
 * Takes already-filtered bindings (for the target environment). For each binding,
 * finds secrets whose scope matches the binding's scopePattern via picomatch.
 * When multiple scopes provide the same key, longest scope path wins (higher specificity).
 * Scope depth is computed AFTER stripping the backend prefix.
 *
 * @param bindings - Bindings already filtered for the target environment
 * @param allSecrets - All scoped secrets in the org
 * @param decryptFn - Pure decryption function (keeps this module crypto-free)
 * @returns Flat record of decrypted secret key-value pairs
 */
export function resolveSecretsForEnvironment(
  bindings: EnvironmentBinding[],
  allSecrets: ScopedSecret[],
  decryptFn: (s: ScopedSecret) => string,
): Record<string, string> {
  // Collect all matching secrets with their scope depth for precedence
  const candidates: Array<{ secret: ScopedSecret; scopeDepth: number }> = [];

  for (const binding of bindings) {
    for (const secret of allSecrets) {
      if (matchScopePattern(secret.scope, binding.scopePattern)) {
        // Scope depth uses path AFTER stripping backend prefix
        const scopePath = stripScopePrefix(secret.scope);
        candidates.push({
          secret,
          scopeDepth: scopePath.split('/').length,
        });
      }
    }
  }

  // Deduplicate by key — longest scope path wins (after prefix strip)
  const resolved = new Map<string, { secret: ScopedSecret; scopeDepth: number }>();

  for (const candidate of candidates) {
    const existing = resolved.get(candidate.secret.key);
    if (!existing || candidate.scopeDepth > existing.scopeDepth) {
      resolved.set(candidate.secret.key, candidate);
    }
  }

  // Decrypt and return flat record
  const result: Record<string, string> = {};
  for (const [key, { secret }] of resolved) {
    result[key] = decryptFn(secret);
  }

  return result;
}
