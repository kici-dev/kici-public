import { describe, it, expect } from 'vitest';
import { selectOidcMintRegistration } from './oidc-mint-registration.js';
import type { LocalSigner } from './local-dev-signer.js';

const dispatcher = { resolveOwnedJob: () => undefined } as any;
const db = {} as any;
const localOidcSigner = {
  alg: 'ES256',
  sign: async () => new Uint8Array(64),
  getPublicJwk: () => ({ kty: 'EC' }),
  getKid: () => 'kid',
} as unknown as LocalSigner;

const base = {
  dispatcher,
  db,
  orchestratorId: 'orch',
};

const orchestratorSigner = {
  alg: 'ES256',
  signerKind: 'db',
  keyRef: null,
  sign: async () => new Uint8Array(64),
  getPublicJwk: async () => ({ kty: 'EC' }),
  getKid: async () => 'orch-kid',
} as any;

describe('selectOidcMintRegistration — anti-forgery choke point', () => {
  it('orchestrator signer configured → orchestrator-owned mint', () => {
    const reg = selectOidcMintRegistration({
      ...base,
      resolveOrchestratorSigner: async () => orchestratorSigner,
      provenanceSigningIssuer: 'https://orch.example',
      independentIdentity: false,
      localOidcSigner: undefined,
    });
    expect(reg?.kind).toBe('orchestrator');
  });

  it('orchestrator signer configured → wins over the local dev signer', () => {
    // fails-when: the local dev signer is consulted while orchestrator-owned
    // signing is configured — the orchestrator is the root of trust.
    const reg = selectOidcMintRegistration({
      ...base,
      resolveOrchestratorSigner: async () => orchestratorSigner,
      provenanceSigningIssuer: 'https://orch.example',
      independentIdentity: true,
      localOidcSigner,
    });
    expect(reg?.kind).toBe('orchestrator');
  });

  it('offline plane (independentIdentity + signer) → local dev-signed', () => {
    const reg = selectOidcMintRegistration({
      ...base,
      independentIdentity: true,
      localOidcSigner,
    });
    expect(reg?.kind).toBe('local');
  });

  it('bare independent (no signer) → no registration (unknown method)', () => {
    const reg = selectOidcMintRegistration({
      ...base,
      independentIdentity: false,
      localOidcSigner: undefined,
    });
    expect(reg).toBeUndefined();
  });

  it('independentIdentity set but signer absent → no registration', () => {
    const reg = selectOidcMintRegistration({
      ...base,
      independentIdentity: true,
      localOidcSigner: undefined,
    });
    expect(reg).toBeUndefined();
  });

  it('an issuer with no signer resolver → no registration', () => {
    // Half of the orchestrator-owned configuration is not a mint path: the
    // local dev signer is not reached for through it either.
    const reg = selectOidcMintRegistration({
      ...base,
      provenanceSigningIssuer: 'https://orch.example',
      independentIdentity: false,
      localOidcSigner: undefined,
    });
    expect(reg).toBeUndefined();
  });
});
