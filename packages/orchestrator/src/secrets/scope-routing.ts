/**
 * Backend-qualified scope routing.
 *
 * A secret scope travels over the wire in *qualified* form -- `<backend>:<path>`
 * -- while every `SecretStore` implementation is addressed with the bare
 * `<path>`. This module owns the single split between the two forms so the two
 * write planes (the dashboard WebSocket handler and the HTTP admin API) can
 * never drift apart on where the qualifier is stripped.
 *
 * The registered-backend map IS the whitelist: a head before the first `:` is a
 * backend qualifier only when it names a registered backend. Anything else --
 * an unregistered head, a leading `:`, no `:` at all -- stays whole and is
 * routed to the default store, where the ordinary scope-name validation
 * rejects it if it is malformed. That is what keeps routing keys
 * (`<provider>:<id>`) out of the secret-scope namespace: `github:42` names no
 * backend, so it stays whole and is rejected as a scope path.
 */

/**
 * The subset of `SecretStore` a scope-taking route or WS handler needs.
 *
 * Deliberately narrower than the full `SecretStore` from `@kici-dev/engine`:
 * routing only needs the scope-addressed methods, so a caller may pass a
 * partial store (the degraded store below, a unit-test fake) without
 * implementing value resolution.
 */
export interface ScopedSecretStore {
  listScopes(orgId: string): Promise<string[]>;
  listKeys(orgId: string, scope: string): Promise<string[]>;
  setSecret(orgId: string, scope: string, key: string, value: string): Promise<void>;
  deleteSecret(orgId: string, scope: string, key: string): Promise<void>;
  createScope?(orgId: string, scope: string): Promise<void>;
  renameScope?(orgId: string, oldScope: string, newScope: string): Promise<void>;
  deleteScope?(orgId: string, scope: string): Promise<void>;
}

/**
 * Raised when a secret write is issued against an orchestrator that has no
 * secret store configured.
 *
 * The message is operator-facing: the dashboard write planes relay it verbatim
 * as the `error` on their response, so it names the deployment condition rather
 * than the internal cause.
 */
export class SecretsUnavailableError extends Error {
  constructor() {
    super(
      'Secrets are unavailable in this deployment: the orchestrator has no secret store configured.',
    );
    this.name = 'SecretsUnavailableError';
  }
}

/**
 * The store an orchestrator serves the dashboard from when it has no secret
 * store configured.
 *
 * The read/write asymmetry is deliberate. `listScopes` / `listKeys` return
 * empty because "this deployment holds no secrets" is true and complete.
 * `setSecret` / `deleteSecret` reject, because a write that resolved here would
 * be discarded while the dashboard reported the secret as stored -- and a
 * delete that resolved would leave a credential the operator believes is
 * revoked. The optional scope methods stay unimplemented: the write planes
 * already refuse a scope operation a store does not support.
 */
export function createUnavailableSecretStore(): ScopedSecretStore {
  return {
    listScopes: async () => [],
    listKeys: async () => [],
    setSecret: async () => {
      throw new SecretsUnavailableError();
    },
    deleteSecret: async () => {
      throw new SecretsUnavailableError();
    },
  };
}

/** Backend name assumed when a wire scope carries no recognised qualifier. */
export const DEFAULT_BACKEND_NAME = 'pg';

/** Outcome of resolving a wire-form scope against the registered backends. */
export interface ResolvedScope<S> {
  /** The store the operation must be issued against. */
  store: S;
  /** The backend the scope resolved to (the default name when unqualified). */
  backendName: string;
  /** The bare scope path to pass to the store -- never carries a qualifier. */
  path: string;
  /** True when the wire scope carried a recognised `<backend>:` qualifier. */
  qualified: boolean;
}

/**
 * The one method of the secret-backend registry that store loading needs.
 *
 * Structural on purpose: keeping the concrete registry out of this module lets
 * both write planes -- and their unit tests -- supply their own loader without
 * dragging a database-backed registry into a pure routing module.
 */
export interface BackendStoreRegistry<S, L> {
  loadAllStores(auditLogger: L): Promise<Map<string, S>>;
}

/**
 * Load the registered secret backends for one operation.
 *
 * Never cache the result: a backend's credentials can rotate, and a backend can
 * be added or removed, between operations -- a stale store would write to the
 * wrong place. A registry failure propagates rather than degrading to the
 * default store, because a misrouted secret write is worse than a failed one.
 *
 * The default-backend entry is ALWAYS `defaultStore`, overriding whatever the
 * registry returned. The registry builds its own `PgSecretStore` for the seeded
 * `pg` row, and that instance carries none of the orchestrator's configuration:
 * `customerSecretsEnabled` defaults to true (so it would ignore an operator's
 * `pgCustomerSecrets: false`), its key version is hardcoded to 1, and it has no
 * old-master-key fallback (so it cannot decrypt rows written before a
 * rotation). Overriding only when the registry omitted the entry is dead code
 * -- the default row is seeded at startup -- and would let `pg:<path>` and
 * `<path>` behave differently, which is the very defect this routing exists to
 * fix.
 *
 * @param registry - Backend registry, or undefined when none is configured.
 * @param auditLogger - Audit logger handed to the registry's store factory.
 * @param defaultStore - Configured store for the default backend.
 * @param defaultBackendName - Name the default store is registered under.
 */
export async function loadRoutableStores<S, L>(
  registry: BackendStoreRegistry<S, L> | undefined,
  auditLogger: L,
  defaultStore: S,
  defaultBackendName: string = DEFAULT_BACKEND_NAME,
): Promise<Map<string, S>> {
  const stores = registry ? await registry.loadAllStores(auditLogger) : new Map<string, S>();
  stores.set(defaultBackendName, defaultStore);
  return stores;
}

/**
 * Split a wire-form scope into the store that owns it and the bare path.
 *
 * Pure: takes the already-loaded store map rather than loading it, so both
 * planes can unit-test routing without a database.
 *
 * @param wireScope - Scope as supplied by the caller, possibly `<backend>:<path>`.
 * @param stores - Registered backends, keyed by backend name.
 * @param defaultStore - Store used when the scope carries no recognised qualifier.
 * @param defaultBackendName - Backend name reported for an unqualified scope.
 */
export function resolveScope<S>(
  wireScope: string,
  stores: Map<string, S>,
  defaultStore: S,
  defaultBackendName: string = DEFAULT_BACKEND_NAME,
): ResolvedScope<S> {
  // `> 0`, not `>= 0`: a leading `:` leaves an empty head, which names no
  // backend and must fall through as a (malformed) path rather than resolving
  // to a store keyed by the empty string.
  const colonIdx = wireScope.indexOf(':');
  if (colonIdx > 0) {
    const backendName = wireScope.slice(0, colonIdx);
    const store = stores.get(backendName);
    if (store) {
      return { store, backendName, path: wireScope.slice(colonIdx + 1), qualified: true };
    }
  }
  return {
    store: defaultStore,
    backendName: defaultBackendName,
    path: wireScope,
    qualified: false,
  };
}

/**
 * Join a backend name and a bare path back into wire form.
 *
 * Used for audit records and cross-backend listings, so an operator reading the
 * audit log sees the same qualified string the caller sent.
 */
export function toWireScope(backendName: string, path: string): string {
  return `${backendName}:${path}`;
}
