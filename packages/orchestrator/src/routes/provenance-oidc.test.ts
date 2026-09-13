import { describe, expect, it } from 'vitest';
import type { OrchestratorSigningKeyRow } from '../db/types.js';
import { buildOpenidConfiguration, createProvenanceOidcRoutes } from './provenance-oidc.js';

const PUBLIC_JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: 'a',
  y: 'b',
  alg: 'ES256',
  use: 'sig',
  kid: 'kid-1',
};

function repoWith(rows: OrchestratorSigningKeyRow[]): {
  listTrusted: () => Promise<OrchestratorSigningKeyRow[]>;
} {
  return { listTrusted: async () => rows };
}

const activeRow = {
  kid: 'kid-1',
  public_jwk: PUBLIC_JWK,
  encrypted_private_jwk: 'enc',
  key_version: 1,
  alg: 'ES256',
  signer_kind: 'db',
  key_ref: null,
  status: 'active',
  revocation_reason: null,
  created_at: new Date(),
  activated_at: new Date(),
  retired_at: null,
  revoked_at: null,
} as OrchestratorSigningKeyRow;

describe('buildOpenidConfiguration', () => {
  it('advertises ES256 and derives jwks_uri from the issuer', () => {
    const doc = buildOpenidConfiguration('https://orch.example/');
    expect(doc.id_token_signing_alg_values_supported).toEqual(['ES256']);
    expect(doc.jwks_uri).toBe('https://orch.example/.well-known/jwks.json');
    expect(doc.issuer).toBe('https://orch.example/');
  });
});

describe('createProvenanceOidcRoutes', () => {
  it('serves the active public JWK at /.well-known/jwks.json (public halves only)', async () => {
    const app = createProvenanceOidcRoutes({
      issuer: 'https://orch.example',
      repo: repoWith([activeRow]),
      enabled: true,
    });
    const res = await app.request('/.well-known/jwks.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: Record<string, unknown>[] };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].kid).toBe('kid-1');
    expect(body.keys[0].d).toBeUndefined(); // never a private member
  });

  it('appends the X25519 dashboard-encryption key(s) alongside the ES256 signing keys', async () => {
    const encRows = [
      {
        kid: 'enc-1',
        public_jwk: { kty: 'OKP', crv: 'X25519', x: 'e1', use: 'enc', kid: 'enc-1' },
      },
      {
        kid: 'enc-2',
        public_jwk: { kty: 'OKP', crv: 'X25519', x: 'e2', use: 'enc', kid: 'enc-2' },
      },
    ];
    const app = createProvenanceOidcRoutes({
      issuer: 'https://orch.example',
      repo: repoWith([activeRow]),
      enabled: true,
      dashboardEncryptionRepo: { listNonRevoked: async () => encRows as never },
    });
    const res = await app.request('/.well-known/jwks.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: Record<string, unknown>[] };
    // 1 signing + 2 enc keys, all non-revoked served (rotation is seamless).
    expect(body.keys).toHaveLength(3);
    const encKeys = body.keys.filter((k) => k.use === 'enc');
    expect(encKeys.map((k) => k.kid)).toEqual(['enc-1', 'enc-2']);
    for (const k of encKeys) expect(k.crv).toBe('X25519');
  });

  it('discovery doc carries ES256 + a derived jwks_uri', async () => {
    const app = createProvenanceOidcRoutes({
      issuer: 'https://orch.example',
      repo: repoWith([activeRow]),
      enabled: true,
    });
    const res = await app.request('/.well-known/openid-configuration');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id_token_signing_alg_values_supported: string[] };
    expect(body.id_token_signing_alg_values_supported).toEqual(['ES256']);
  });

  it('serves CORS on the JWKS so a browser can fetch the encryption key cross-origin', async () => {
    const app = createProvenanceOidcRoutes({
      issuer: 'https://orch.example',
      repo: repoWith([activeRow]),
      enabled: true,
    });
    const res = await app.request('/.well-known/jwks.json');
    // The key material is public and served unauthenticated; without this the
    // browser blocks the Verified-tier fetch and every encrypted write blocks.
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('serves CORS on the discovery document too', async () => {
    const app = createProvenanceOidcRoutes({
      issuer: 'https://orch.example',
      repo: repoWith([activeRow]),
      enabled: true,
    });
    const res = await app.request('/.well-known/openid-configuration');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('still sets CORS on the empty-JWKS error response', async () => {
    const app = createProvenanceOidcRoutes({
      issuer: undefined,
      repo: repoWith([]),
      enabled: false,
    });
    const res = await app.request('/.well-known/jwks.json');
    expect(res.status).toBe(503);
    // Otherwise the browser reports an opaque CORS failure instead of the
    // real reason, and the operator cannot tell the two apart.
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('503s when signing is disabled', async () => {
    const app = createProvenanceOidcRoutes({
      issuer: undefined,
      repo: repoWith([]),
      enabled: false,
    });
    expect((await app.request('/.well-known/jwks.json')).status).toBe(503);
    expect((await app.request('/.well-known/openid-configuration')).status).toBe(503);
  });
});

// The JWKS never consults `deps.issuer` — it publishes whatever keys exist, of
// either kind — so its 503 body must not name the issuer configuration. These
// pin the body to a reason that is true in every state that reaches it.
describe('the empty-JWKS 503 reports "nothing to publish", not "no issuer"', () => {
  async function jwksError(app: ReturnType<typeof createProvenanceOidcRoutes>) {
    const res = await app.request('/.well-known/jwks.json');
    expect(res.status).toBe(503);
    return (await res.json()) as { error?: string };
  }

  it('says no_published_keys when signing is off and no enc key exists', async () => {
    const body = await jwksError(
      createProvenanceOidcRoutes({ issuer: undefined, repo: repoWith([]), enabled: false }),
    );
    expect(body.error).toBe('no_published_keys');
  });

  // The state that makes an issuer-shaped body a lie: the issuer IS configured
  // and signing IS on, the signing key simply is not provisioned yet.
  it('says no_published_keys when the issuer is configured but no key is provisioned', async () => {
    const body = await jwksError(
      createProvenanceOidcRoutes({
        issuer: 'https://orch.example',
        repo: repoWith([]),
        enabled: true,
      }),
    );
    expect(body.error).toBe('no_published_keys');
  });

  // Regression pin: the discovery document genuinely cannot be built without an
  // issuer, so its body names the issuer configuration — while the JWKS, which
  // needs no issuer, must not.
  it('leaves the discovery document reporting oidc_issuer_not_configured', async () => {
    const app = createProvenanceOidcRoutes({
      issuer: undefined,
      repo: repoWith([]),
      enabled: false,
    });
    const res = await app.request('/.well-known/openid-configuration');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error?: string }).error).toBe('oidc_issuer_not_configured');
  });

  // Regression pin: an enc-key-only JWKS is a success, not an error shape.
  it('returns 200 with no error member when only an enc key exists', async () => {
    const app = createProvenanceOidcRoutes({
      issuer: undefined,
      repo: repoWith([]),
      enabled: false,
      dashboardEncryptionRepo: {
        listNonRevoked: async () =>
          [
            { kid: 'enc-1', public_jwk: { kty: 'OKP', crv: 'X25519', x: 'e1', use: 'enc' } },
          ] as never,
      },
    });
    const res = await app.request('/.well-known/jwks.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: unknown[]; error?: string };
    expect(body.error).toBeUndefined();
    expect(body.keys).toHaveLength(1);
  });
});

describe('dashboard-encryption keys are published independently of provenance signing', () => {
  const encRow = {
    kid: 'enc-1',
    public_jwk: { kty: 'OKP', crv: 'X25519', x: 'e1', use: 'enc', kid: 'enc-1' },
  };

  // An operator who configures only the Verified dashboard tier — no build
  // attestations — must still get a fetchable key.
  it('serves the enc key with no provenance issuer configured', async () => {
    const app = createProvenanceOidcRoutes({
      issuer: undefined,
      repo: repoWith([]),
      enabled: false,
      dashboardEncryptionRepo: { listNonRevoked: async () => [encRow] as never },
    });

    const res = await app.request('/.well-known/jwks.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: Record<string, unknown>[] };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].kid).toBe('enc-1');
    expect(body.keys[0].use).toBe('enc');
    // No signing keys leak in when signing is off.
    expect(body.keys.some((k) => k.use === 'sig')).toBe(false);
  });

  it('still 503s when the enc repo is present but holds no keys', async () => {
    const app = createProvenanceOidcRoutes({
      issuer: undefined,
      repo: repoWith([]),
      enabled: false,
      dashboardEncryptionRepo: { listNonRevoked: async () => [] as never },
    });
    expect((await app.request('/.well-known/jwks.json')).status).toBe(503);
  });

  // This is what makes the change a split rather than a blanket un-gating.
  // Without it, deleting both gates would satisfy every other case here.
  it('keeps the discovery document gated even when enc keys exist', async () => {
    const app = createProvenanceOidcRoutes({
      issuer: undefined,
      repo: repoWith([]),
      enabled: false,
      dashboardEncryptionRepo: { listNonRevoked: async () => [encRow] as never },
    });
    expect((await app.request('/.well-known/openid-configuration')).status).toBe(503);
  });

  it('still serves CORS on the enc-only JWKS', async () => {
    const app = createProvenanceOidcRoutes({
      issuer: undefined,
      repo: repoWith([]),
      enabled: false,
      dashboardEncryptionRepo: { listNonRevoked: async () => [encRow] as never },
    });
    const res = await app.request('/.well-known/jwks.json');
    // The browser fetch is cross-origin; without this header it is blocked and
    // every encrypted write fails closed.
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
