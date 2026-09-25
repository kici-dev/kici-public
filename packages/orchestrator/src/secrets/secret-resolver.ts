/**
 * Secret resolver for dispatch-time secret resolution.
 *
 * Uses context bindings + scope resolver to match secrets from multiple backends.
 * When a job dispatches through a context, the resolver:
 * 1. Takes the context row the dispatch path already matched (a fixed context
 *    by exact name, or a glob context whose pattern matched the declared name)
 * 2. Gets bindings for that row
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
 * The context a job's secrets resolve through.
 *
 * `id` is the row the dispatch path matched — which, for a glob context, is not
 * the row whose name equals the declared one — so the resolver reads that row's
 * bindings and never matches a name again: a second match could land on a
 * different row than the one the caller's protection rules and held-run
 * checks ran against. `name` is the name the job declared; it labels the audit
 * entry and keys per-context namespacing.
 */
export interface MatchedContextRef {
  id: string;
  name: string;
}

/** The run and job a resolution is recorded against in the secret audit log. */
export interface SecretResolutionAttribution {
  runId?: string;
  jobId?: string;
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
 * resolveNamedInternal for source-scoped credential lookup).
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
  resolveForContext(
    orgId: string,
    context: MatchedContextRef,
    hostCtx?: HostFacts,
    attribution?: SecretResolutionAttribution,
  ): Promise<Record<string, string>>;
  /**
   * System-scoped direct lookup — no context binding, no protection rule, no
   * trust tier. A job-originated reference goes through
   * `resolveJobQualifiedSecret` instead. See the implementation's doc comment.
   */
  resolveNamedInternal(
    orgId: string,
    scope: string,
    key: string,
    opts?: { store?: string; runId?: string; jobId?: string },
  ): Promise<string | null>;
  resolveForContextWithMeta(
    orgId: string,
    context: MatchedContextRef,
    hostCtx?: HostFacts,
  ): Promise<Record<string, ResolvedSecretMeta>>;
  /**
   * How many scope bindings the context row `contextId` has. A context with
   * none resolves no secret; the dispatch path reads this to say so in its log.
   */
  countContextBindings?(contextId: string): Promise<number>;
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
  private readonly bindingStore: BindingStoreLike;
  private readonly backendStores: Map<string, SecretStoreLike>;
  private readonly auditLogger: AuditLogger;
  private readonly logger: Logger;

  constructor(deps: SecretResolverDeps) {
    this.bindingStore = deps.bindingStore;
    this.backendStores = deps.backendStores;
    this.auditLogger = deps.auditLogger;
    this.logger = deps.logger;
  }

  /**
   * Resolve secrets for a job dispatch.
   *
   * @param orgId - Organization ID
   * @param context - The matched context row and the name the job declared
   * @param hostCtx - Optional fan-out child identity for per-host resolution.
   *   When supplied, each binding is gated by its `host_pattern` and its
   *   `scope_pattern` is templated per-child; when omitted, only fleet-wide
   *   (`'**'`) non-templated bindings contribute.
   * @param attribution - The run and job the audit entry names, when the
   *   caller resolves on behalf of one.
   * @returns Flat map of decrypted secret key-value pairs
   */
  async resolveForContext(
    orgId: string,
    context: MatchedContextRef,
    hostCtx?: HostFacts,
    attribution?: SecretResolutionAttribution,
  ): Promise<Record<string, string>> {
    const contextName = context.name;
    // 1-2. Bindings of the matched row. A row deleted since the match has none.
    const bindings = await this.bindingStore.getByContextId(context.id);
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
        runId: attribution?.runId ?? null,
        jobId: attribution?.jobId ?? null,
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
   * a specific backend.
   *
   * SYSTEM-SCOPED CALLERS ONLY. It applies no authorization of any kind: no
   * context binding, no protection rule, no trust tier. Its legitimate callers
   * resolve the orchestrator's OWN credentials, under scopes a workflow can
   * never name — `resolveSourceCredential` (`__source__/<sourceId>`) and the
   * bringup API's host secret refs.
   *
   * A JOB-ORIGINATED reference goes through `resolveJobQualifiedSecret`
   * (`secrets/job-secret-gate.ts`) instead, which runs the named context's
   * protection rules and the trust-tier strip, then reads the value through
   * that context's bindings with `resolveForContext`. It calls this method in
   * one deprecated case only, after its own checks pass: a non-glob context
   * matched by its exact name, whose bound scopes do not carry the key, reads
   * the scope named after the context (removal planned for v1.0.0). The `Internal` suffix marks the
   * boundary: a warning in a doc comment is not one, but a name shows up in a
   * grep of callers.
   *
   * When `store` is omitted, backends are tried in Map iteration order (the
   * order they were registered) and the first hit wins. An explicit `store`
   * restricts the lookup to that one backend and returns null on miss.
   *
   * Audit-log: writes one `resolve_named` entry on success. Throws when the
   * named store is requested but doesn't exist, mirroring `resolveForContext`'s
   * fail-fast policy — the caller asked for a specific backend and
   * it's gone.
   */
  async resolveNamedInternal(
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
          `Secret backend '${preferredStore}' is not registered (resolveNamedInternal orgId=${orgId} scope=${scope} key=${key})`,
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
        // Skip unreachable backends — unlike resolveForContext, named lookups do
        // NOT cause job failure on a missed backend. The caller can re-ask
        // with an explicit `store` if they need to pin to one.
        this.logger.warn('Secret backend unreachable during resolveNamedInternal', {
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

  /** How many scope bindings the context row `contextId` has. */
  async countContextBindings(contextId: string): Promise<number> {
    return (await this.bindingStore.getByContextId(contextId)).length;
  }

  /**
   * Resolve secrets with metadata (per, for secrets.getMeta).
   *
   * Returns the secret value along with which backend and scope provided it.
   */
  async resolveForContextWithMeta(
    orgId: string,
    context: MatchedContextRef,
    hostCtx?: HostFacts,
  ): Promise<Record<string, ResolvedSecretMeta>> {
    const contextName = context.name;
    const bindings = await this.bindingStore.getByContextId(context.id);
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
