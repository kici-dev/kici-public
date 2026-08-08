import { describe, it, expect } from 'vitest';
import { selectOidcMintRegistration } from './oidc-mint-registration.js';
import type { LocalSigner } from './local-dev-signer.js';

const dispatcher = { resolveOwnedJob: () => undefined } as any;
const db = {} as any;
const platformClient = { sendRequestAndAwait: async () => ({}) } as any;
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
  testMode: false,
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
  it('orchestrator signer configured → orchestrator-owned mint (wins over the Platform relay)', () => {
    const reg = selectOidcMintRegistration({
      ...base,
      resolveOrchestratorSigner: async () => orchestratorSigner,
      provenanceSigningIssuer: 'https://orch.example',
      platformUrl: 'wss://platform',
      platformToken: 'tok',
      platformClient,
      independentIdentity: false,
      localOidcSigner: undefined,
    });
    expect(reg?.kind).toBe('orchestrator');
  });

  it('no orchestrator signer, Platform-connected → relay (deprecated path)', () => {
    const reg = selectOidcMintRegistration({
      ...base,
      platformUrl: 'wss://platform',
      platformToken: 'tok',
      platformClient,
      independentIdentity: false,
      localOidcSigner: undefined,
    });
    expect(reg?.kind).toBe('relay');
  });

  it('Platform-connected → relay (local signer NEVER consulted)', () => {
    const reg = selectOidcMintRegistration({
      ...base,
      platformUrl: 'wss://platform',
      platformToken: 'tok',
      platformClient,
      independentIdentity: false,
      localOidcSigner: undefined,
    });
    expect(reg?.kind).toBe('relay');
  });

  it('Platform-connected AND independentIdentity+signer set → STILL relay (local unreachable)', () => {
    // The critical guarantee: even if KICI_INDEPENDENT_IDENTITY is somehow set
    // on a Platform-connected orchestrator, the local mint path is unreachable.
    const reg = selectOidcMintRegistration({
      ...base,
      platformUrl: 'wss://platform',
      platformToken: 'tok',
      platformClient,
      independentIdentity: true,
      localOidcSigner,
    });
    expect(reg?.kind).toBe('relay');
    expect(reg?.kind).not.toBe('local');
  });

  it('hybrid local dev plane (attach) → relay, never the dev signer (Phase 3 boundary)', () => {
    // When `kici local attach` boots the plane hybrid, the orchestrator has a
    // Platform connection (KICI_PLATFORM_URL/_TOKEN + a live client) and the
    // dev-signer envs are NOT set. Even if a stale dev signer were somehow
    // present, the relay wins — an attached run mints via the real Platform, so
    // its OIDC/attestation verify against the Platform issuer and can never
    // carry the non-prod `kici-local` issuer.
    const reg = selectOidcMintRegistration({
      ...base,
      platformUrl: 'wss://thinker1.dev.kici.dev/kici-stg/ws',
      platformToken: 'kici_ok_secret',
      platformClient,
      independentIdentity: true,
      localOidcSigner,
    });
    expect(reg?.kind).toBe('relay');
    expect(reg?.kind).not.toBe('local');
  });

  it('offline plane (independentIdentity + signer, no Platform) → local dev-signed', () => {
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

  it('partial Platform config (missing client) does not register the relay', () => {
    const reg = selectOidcMintRegistration({
      ...base,
      platformUrl: 'wss://platform',
      platformToken: 'tok',
      platformClient: undefined,
      independentIdentity: false,
      localOidcSigner: undefined,
    });
    expect(reg).toBeUndefined();
  });
});
