/**
 * Regression: the dashboard environment/secret WS handler MUST have no way to
 * read plaintext secret values back. `SecretStoreForDashboard` excludes
 * `PgSecretStore.getSecrets()`; adding a value-returning method would
 * re-create a cross-tenant secret-readback primitive, because the dashboard
 * surface fans out to every connected dashboard session for the org.
 *
 * Trust model: the orchestrator's HTTP/WS surface MUST NOT return plaintext
 * `scoped_secrets` values. List endpoints return key/scope NAMES only;
 * set/rotate take a value but never echo it; no GET decrypts
 * `scoped_secrets.encrypted_value`. The only break-glass reveal is
 * `GET /api/v1/admin/runs/:runId/secret-outputs?reveal=true`, over
 * `run_secret_outputs` (per-run step outputs), gated by the `secret.reveal`
 * RBAC permission, the master key and a mandatory audit-log row.
 *
 * context_variables are non-secret config (docs/user/contexts.md
 * § "Overview") and stay readable via `GET /api/v1/admin/contexts/:name`.
 */
import { describe, it, expectTypeOf } from 'vitest';
import type { DashboardContextHandlerDeps } from './dashboard-context-handler.js';

type SecretStoreForDashboard = DashboardContextHandlerDeps['secretStore'];

describe('dashboard secret-store interface excludes value-returning methods', () => {
  it('SecretStoreForDashboard exposes name/key listing but not plaintext value reads', () => {
    // Compile-time invariant: the interface key set must be exactly
    // the members below. Adding `getSecrets` (or any other
    // value-returning shape) to the dashboard-facing secret store
    // would let the WS handler at runtime fetch decrypted values and
    // either fan them out to every connected dashboard session or
    // return them via the WS reply path — both are readback violations.
    type RequiredKeys = 'listScopes' | 'listKeys' | 'setSecret' | 'deleteSecret';
    type OptionalKeys = 'createScope' | 'renameScope' | 'deleteScope';

    expectTypeOf<keyof SecretStoreForDashboard>().toEqualTypeOf<RequiredKeys | OptionalKeys>();
  });

  it('SecretStoreForDashboard does NOT include `getSecrets` (the plaintext-returning method on PgSecretStore)', () => {
    // `PgSecretStore.getSecrets(orgId, scope)` returns decrypted key→value
    // pairs; reachable here, it is a cross-session readback primitive even
    // within a single tenant.
    type WithoutGetSecrets = Exclude<keyof SecretStoreForDashboard, 'getSecrets'>;
    expectTypeOf<keyof SecretStoreForDashboard>().toEqualTypeOf<WithoutGetSecrets>();
  });
});
