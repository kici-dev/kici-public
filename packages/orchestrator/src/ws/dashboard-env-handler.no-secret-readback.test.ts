/**
 * regression: the dashboard-facing environment/secret WS handler MUST
 * NOT have a way to read plaintext secret values back. The
 * `SecretStoreForDashboard` interface in `dashboard-env-handler.ts`
 * deliberately excludes `getSecrets()` (the plaintext-returning method
 * on `PgSecretStore`) — only `listScopes`, `listKeys`, and the mutation
 * methods are exposed. Adding a value-returning method to that
 * interface would re-create a cross-tenant secret-readback primitive
 * because the dashboard surface fans out to every connected dashboard
 * session for the org.
 *
 * Trust model (must hold):
 *   The orchestrator's HTTP/WS surface MUST NOT return plaintext
 *   `value` fields from the `scoped_secrets` table. The negative
 *   invariant for §4.5 (no-http-secret-value-readback): list endpoints
 *   return key/scope NAMES only; set/rotate endpoints take a value as
 *   input but do not echo it; no GET endpoint exists that decrypts
 *   `scoped_secrets.encrypted_value` and returns it to the caller via
 *   HTTP — the only break-glass reveal path is
 *   `GET /api/v1/admin/runs/:runId/secret-outputs?reveal=true` which
 *   targets the `run_secret_outputs` table (per-run step outputs, not
 *   admin-configured `scoped_secrets`) and is gated by a separate
 *   `secret.reveal` RBAC permission, master-key requirement, and
 *   non-optional audit-log row.
 *
 *   environment_variables (non-secret config per docs/user/environments.md
 *   §31: "Variables — non-secret key-value configuration") are
 *   intentionally plaintext-readable via
 *   `GET /api/v1/admin/environments/:name`; that's outside the §4.5
 *   scope.
 */
import { describe, it, expectTypeOf } from 'vitest';
import type { DashboardEnvHandlerDeps } from './dashboard-env-handler.js';

type SecretStoreForDashboard = DashboardEnvHandlerDeps['secretStore'];

describe('§4.5 dashboard secret-store interface excludes value-returning methods', () => {
  it('SecretStoreForDashboard exposes name/key listing but not plaintext value reads', () => {
    // Compile-time invariant: the interface key set must be exactly
    // these eight members. Adding `getSecrets` (or any other
    // value-returning shape) to the dashboard-facing secret store
    // would let the WS handler at runtime fetch decrypted values and
    // either fan them out to every connected dashboard session or
    // return them via the WS reply path — both are §4.5 violations.
    type RequiredKeys = 'listScopes' | 'listKeys' | 'setSecret' | 'deleteSecret';
    type OptionalKeys = 'createScope' | 'renameScope' | 'deleteScope';

    expectTypeOf<keyof SecretStoreForDashboard>().toEqualTypeOf<RequiredKeys | OptionalKeys>();
  });

  it('SecretStoreForDashboard does NOT include `getSecrets` (the plaintext-returning method on PgSecretStore)', () => {
    // The runtime `PgSecretStore.getSecrets(orgId, scope)` returns
    // `Promise<Record<string, string>>` of decrypted key→value pairs.
    // It MUST NOT be reachable from the dashboard interface. Adding it
    // back would let the dashboard handler call it on behalf of any
    // dashboard session for the org — a cross-session secret-readback
    // primitive even within a single tenant.
    type WithoutGetSecrets = Exclude<keyof SecretStoreForDashboard, 'getSecrets'>;
    expectTypeOf<keyof SecretStoreForDashboard>().toEqualTypeOf<WithoutGetSecrets>();
  });
});
