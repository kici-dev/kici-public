/**
 * Secret resolver for dispatch-time secret resolution.
 *
 * Uses context bindings + scope resolver to match secrets from multiple backends.
 * When a job dispatches with a context name, the resolver:
 * 1. Looks up the context by name
 * 2. Gets bindings for that context
 * 3. Queries ALL registered backend stores for secrets
 * 4. Prefixes each secret's scope with the backend name (e.g., pg:aws/prod)
 * 5. Uses resolveSecretsWithProvenance to match bindings against prefixed secrets
 * 6. Returns a flat decrypted key-value map
 *
 * unreachable backends cause job failure (not silent skip).
 * external (Vault) secrets are fetched real-time (no cache).
 * longest-path-wins uses scope path after stripping backend prefix.
 * audit log includes backend name.
 */
import {
  resolveSecretsWithProvenance,
  matchScopePattern,
  type ContextBinding,
  type HostFacts,
  type ScopedSecret,
} from '@kici-dev/engine';
import type { Logger } from '@kici-dev/shared';
import type { AuditLogger } from './audit-logger.js';

/**
 * Minimal context store interface (subset needed by resolver).
 */
export interface ContextStoreLike {
  getByName(
    orgId: string,
    name: string,
  ): Promise<{ id: string; name: string; orgId: string } | null>;
}

/**
 * Minimal binding store interface (subset needed by resolver).
 */
export interface BindingStoreLike {
  getByContextId(contextId: string): Promise<ContextBinding[]>;
}

/**
 * Minimal secret store interface (subset needed by resolver).
 * getAllSecrets returns raw encrypted secrets; decrypt decrypts a single secret.
 * getSecrets returns a decrypted key-value map for a single scope (used by
 * resolveNamed for source-scoped credential lookup).
 */
export interface SecretStoreLike {
  getAllSecrets(orgId: string): Promise<ScopedSecret[]>;
  decrypt(secret: ScopedSecret): string;
  getSecrets(orgId: string, scope: string): Promise<Record<string, string>>;
}

/**
 * Dependencies for the SecretResolver.
 */
export interface SecretResolverDeps {
  contextStore: ContextStoreLike;
  bindingStore: BindingStoreLike;
  /** Map of backend name to store. Replaces single secretStore. */
  backendStores: Map<string, SecretStoreLike>;
  auditLogger: AuditLogger;
  logger: Logger;
}

/** Metadata about a resolved secret. */
export interface ResolvedSecretMeta {
  value: string;
  backend: string;
  scope: string;
}

/**
 * The public secret-resolution surface consumed by the dispatch path and the
 * universal-git provider. `SecretResolver` implements this; the test adapter's
 * `DecoratingSecretResolver` (CLI-secret overlay) implements it too, so either
 * can flow through `ProcessingDeps.secretResolver`.
 */
export interface SecretResolverApi {
  resolveForJob(
    orgId: string,
    contextName: string,
    hostCtx?: HostFacts,
  ): Promise<Record<string, string>>;
  resolveNamed(
    orgId: string,
    scope: string,
    key: string,
    opts?: { store?: string; runId?: string; jobId?: string },
  ): Promise<string | null>;
  resolveForJobWithMeta(
    orgId: string,
    contextName: string,
    hostCtx?: HostFacts,
  ): Promise<Record<string, ResolvedSecretMeta>>;
}

/**
 * Resolves secrets for a job by matching context bindings against scoped secrets
 * from multiple backends.
 *
 * All backend stores are queried. Each secret's scope is prefixed with the backend
 * name (e.g., 'pg:aws/prod', 'vault-prod:databases/staging'). The prefixed scopes
 * are matched against binding patterns, and longest-path-wins uses the path AFTER
 * stripping the backend prefix.
 */
export class SecretResolver implements SecretResolverApi {
  private readonly contextStore: ContextStoreLike;
  private readonly bindingStore: BindingStoreLike;
  private readonly backendStores: Map<string, SecretStoreLike>;
  private readonly auditLogger: AuditLogger;
  private readonly logger: Logger;

  constructor(deps: SecretResolverDeps) {
    this.contextStore = deps.contextStore;
    this.bindingStore = deps.bindingStore;
    this.backendStores = deps.backendStores;
    this.auditLogger = deps.auditLogger;
    this.logger = deps.logger;
  }

  /**
   * Resolve secrets for a job dispatch.
   *
   * @param orgId - Organization ID
   * @param contextName - Context name to resolve secrets for
   * @param hostCtx - Optional fan-out child identity for per-host resolution.
   *   When supplied, each binding is gated by its `host_pattern` and its
   *   `scope_pattern` is templated per-child; when omitted, only fleet-wide
   *   (`'**'`) non-templated bindings contribute.
   * @returns Flat map of decrypted secret key-value pairs
   */
  async resolveForJob(
    orgId: string,
    contextName: string,
    hostCtx?: HostFacts,
  ): Promise<Record<string, string>> {
    // 1. Look up context by name
    const env = await this.contextStore.getByName(orgId, contextName);
    if (!env) {
      return {};
    }

    // 2. Get bindings for this context
    const bindings = await this.bindingStore.getByContextId(env.id);
    if (bindings.length === 0) {
      return {};
    }

    // 3. Query ALL backend stores and prefix scopes
    const { secrets: allPrefixedSecrets, failedBackends } = await this.collectAllSecrets(orgId);

    // 4. Scoped failure check: fail only when a failed backend
    //    could affect THIS job's bindings and no healthy backend satisfies them.
    if (failedBackends.size > 0) {
      this.checkScopedFailure(bindings, allPrefixedSecrets, failedBackends, contextName);
    }

    // 5. Build a decrypt function that dispatches to the correct backend
    const decryptFn = this.buildDecryptFn();

    // 6. Engine scope resolver is the single source of truth for precedence:
    //    winners per key (longest-path-wins after prefix strip, host-specificity-wins
    //    when a hostCtx is supplied). Decrypt each winner for the returned flat map.
    const provenance = resolveSecretsWithProvenance(bindings, allPrefixedSecrets, hostCtx);
    const resolved: Record<string, string> = {};
    for (const [key, { secret }] of provenance) {
      resolved[key] = decryptFn(secret);
    }

    // 7. Audit log the resolution (backends derived straight from the winning secrets).
    if (provenance.size > 0) {
      const backends = new Set<string>();
      for (const [, { secret }] of provenance) {
        const colonIdx = secret.scope.indexOf(':');
        if (colonIdx >= 0) backends.add(secret.scope.slice(0, colonIdx));
      }

      await this.auditLogger.log({
        action: 'resolve',
        contextName: contextName,
        routingKey: null,
        secretKeys: Object.keys(resolved),
        outcome: 'allowed',
        runId: null,
        jobId: null,
        userId: null,
        role: null,
        metadata: {
          orgId,
          backends: [...backends],
          secretCount: Object.keys(resolved).length,
          ...(failedBackends.size > 0 && {
            failedBackends: Object.fromEntries(failedBackends),
          }),
        },
      });
    }

    return resolved;
  }

  /**
   * Resolve a single named secret by (orgId, scope, key), optionally scoped to
   * a specific backend. Bypasses context bindings — this is a direct
   * lookup used for source-scoped credentials (e.g. universal-git PAT/SSH
   * keys stored under `__source__/<sourceId>`).
   *
   * When `store` is omitted, backends are tried in Map iteration order (the
   * order they were registered) and the first hit wins. An explicit `store`
   * restricts the lookup to that one backend and returns null on miss.
   *
   * Audit-log: writes one `resolve_named` entry on success. Throws when the
   * named store is requested but doesn't exist, mirroring `resolveForJob`'s
   * fail-fast policy — the caller asked for a specific backend and
   * it's gone.
   */
  async resolveNamed(
    orgId: string,
    scope: string,
    key: string,
    opts?: { store?: string; runId?: string; jobId?: string },
  ): Promise<string | null> {
    const preferredStore = opts?.store;

    if (preferredStore !== undefined) {
      const store = this.backendStores.get(preferredStore);
      if (!store) {
        throw new Error(
          `Secret backend '${preferredStore}' is not registered (resolveNamed orgId=${orgId} scope=${scope} key=${key})`,
        );
      }
      const secrets = await store.getSecrets(orgId, scope);
      const value = secrets[key];
      if (value === undefined) return null;

      await this.auditLogger.log({
        action: 'resolve_named',
        contextName: scope,
        routingKey: null,
        secretKeys: [key],
        outcome: 'allowed',
        runId: opts?.runId ?? null,
        jobId: opts?.jobId ?? null,
        userId: null,
        role: null,
        metadata: { orgId, backend: preferredStore },
      });

      return value;
    }

    // No preferred backend — scan backends in registration order.
    for (const [backendName, store] of this.backendStores) {
      let secrets: Record<string, string>;
      try {
        secrets = await store.getSecrets(orgId, scope);
      } catch (err) {
        // Skip unreachable backends — unlike resolveForJob, named lookups do
        // NOT cause job failure on a missed backend. The caller can re-ask
        // with an explicit `store` if they need to pin to one.
        this.logger.warn('Secret backend unreachable during resolveNamed', {
          backend: backendName,
          scope,
          key,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      const value = secrets[key];
      if (value !== undefined) {
        await this.auditLogger.log({
          action: 'resolve_named',
          contextName: scope,
          routingKey: null,
          secretKeys: [key],
          outcome: 'allowed',
          runId: opts?.runId ?? null,
          jobId: opts?.jobId ?? null,
          userId: null,
          role: null,
          metadata: { orgId, backend: backendName },
        });
        return value;
      }
    }

    return null;
  }

  /**
   * Resolve secrets with metadata (per, for secrets.getMeta).
   *
   * Returns the secret value along with which backend and scope provided it.
   */
  async resolveForJobWithMeta(
    orgId: string,
    contextName: string,
    hostCtx?: HostFacts,
  ): Promise<Record<string, ResolvedSecretMeta>> {
    const env = await this.contextStore.getByName(orgId, contextName);
    if (!env) return {};

    const bindings = await this.bindingStore.getByContextId(env.id);
    if (bindings.length === 0) return {};

    const { secrets: allPrefixedSecrets, failedBackends } = await this.collectAllSecrets(orgId);

    // Apply scoped failure check
    if (failedBackends.size > 0) {
      this.checkScopedFailure(bindings, allPrefixedSecrets, failedBackends, contextName);
    }

    const decryptFn = this.buildDecryptFn();

    // Engine provenance map is the single source of truth: winner per key.
    const provenance = resolveSecretsWithProvenance(bindings, allPrefixedSecrets, hostCtx);

    const meta: Record<string, ResolvedSecretMeta> = {};
    for (const [key, { secret }] of provenance) {
      const colonIdx = secret.scope.indexOf(':');
      meta[key] = {
        value: decryptFn(secret),
        backend: colonIdx >= 0 ? secret.scope.slice(0, colonIdx) : 'unknown',
        scope: secret.scope,
      };
    }

    return meta;
  }

  /**
   * Collect all secrets from all backend stores, prefixing scopes.
   * Per /: unreachable backends are tracked but not fatal here.
   * Callers apply scoped failure policy based on job bindings.
   */
  private async collectAllSecrets(
    orgId: string,
  ): Promise<{ secrets: ScopedSecret[]; failedBackends: Map<string, string> }> {
    const secrets: ScopedSecret[] = [];
    const failedBackends = new Map<string, string>();

    for (const [backendName, store] of this.backendStores) {
      try {
        const backendSecrets = await store.getAllSecrets(orgId);
        for (const secret of backendSecrets) {
          secrets.push({
            ...secret,
            scope: `${backendName}:${secret.scope}`,
          });
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        failedBackends.set(backendName, errMsg);
      }
    }

    if (failedBackends.size > 0) {
      // Log warnings for execution report visibility
      this.logger.warn('Secret backends unreachable during collection', {
        failedBackends: Object.fromEntries(failedBackends),
      });
    }

    return { secrets, failedBackends };
  }

  /**
   * Build a decrypt function that dispatches to the correct backend store.
   */
  private buildDecryptFn(): (secret: ScopedSecret) => string {
    return (secret: ScopedSecret): string => {
      const colonIdx = secret.scope.indexOf(':');
      const backendName = colonIdx >= 0 ? secret.scope.slice(0, colonIdx) : 'pg';
      const store = this.backendStores.get(backendName);
      if (!store) {
        throw new Error(`No store found for backend '${backendName}'`);
      }
      const unprefixedScope = colonIdx >= 0 ? secret.scope.slice(colonIdx + 1) : secret.scope;
      return store.decrypt({ ...secret, scope: unprefixedScope });
    };
  }

  /**
   * Check if any failed backend could affect the job's context bindings.
   * throw when a failed backend's scopes could match a binding and
   * no healthy backend already satisfies that binding.
   * jobs referencing only healthy backends succeed normally.
   */
  private checkScopedFailure(
    bindings: ContextBinding[],
    healthySecrets: ScopedSecret[],
    failedBackends: Map<string, string>,
    contextName: string,
  ): void {
    for (const [backendName, errorMsg] of failedBackends) {
      for (const binding of bindings) {
        // Check if this binding could reference the failed backend.
        // A binding with an explicit backend prefix (e.g., "vault-prod:**") only matches that backend.
        // A binding without a colon (e.g., "aws/prod/**") could match ANY backend
        // because matchScopePattern strips the backend prefix.
        const patternColon = binding.scopePattern.indexOf(':');
        const couldMatch =
          patternColon < 0 || binding.scopePattern.slice(0, patternColon) === backendName;

        if (couldMatch) {
          // Check if any secret from a HEALTHY backend satisfies this binding pattern
          const hasHealthyMatch = healthySecrets.some((s) =>
            matchScopePattern(s.scope, binding.scopePattern),
          );
          if (!hasHealthyMatch) {
            throw new Error(
              `Secret backend '${backendName}' is unreachable (${errorMsg}) and job context ` +
                `'${contextName}' has binding '${binding.scopePattern}' that may depend on it. ` +
                `No other backend provides matching secrets.`,
            );
          }
        }
      }
    }
  }
}
