/**
 * Local dev-signed identity for the offline local dev plane (independent mode).
 *
 * The hosted KiCI Platform is the ONLY real OIDC minter in production
 * (`packages/platform/src/oidc/*`, private); a Platform-connected orchestrator
 * relays to it (`ws/oidc-token-relay.ts`). The offline local dev plane has no
 * Platform, so `ctx.kici.oidc.token()` / `ctx.attestProvenance()` would return
 * "unknown method". This module gives the plane a clearly-non-prod substitute:
 * an in-process ES256 signer keyed to a keypair the CLI generates fresh under
 * `~/.kici/local/dev-identity/` (mode 0600, never derived from any sops secret),
 * minting tokens whose issuer is the fixed sentinel `kici-local`.
 *
 * `kici-local` can NEVER masquerade as the prod issuer (`https://api.kici.dev`):
 * `kici verify-attestation` pins the token `iss` to the trust root supplied
 * out-of-band (default = the prod issuer), so a `kici-local` bundle rejects
 * structurally against prod and only verifies against a `kici local trust-root`
 * export. See `.claude/rules/platform-hosting-model.md`.
 *
 * This signer is constructed ONLY when the orchestrator runs in `independent`
 * mode with `KICI_INDEPENDENT_IDENTITY=1` (set solely by the local dev plane's
 * boot). A Platform-connected orchestrator never builds it and never registers
 * the local mint path — it keeps minting via the Platform relay exactly as
 * today.
 */
import { readFile } from 'node:fs/promises';
import { calculateJwkThumbprint, type JWK } from 'jose';

/** The fixed, non-prod dev-identity issuer. Never `https://api.kici.dev`. */
export const KICI_LOCAL_ISSUER = 'kici-local';

/** Minimal signing seam mirrored from the Platform's `Signer` idiom. */
export interface LocalSigner {
  readonly alg: 'ES256';
  /** Sign `data`, returning the JOSE-raw (r||s) ES256 signature. */
  sign(data: Uint8Array): Promise<Uint8Array>;
  /** The public key as a JWK (kty EC, crv P-256, alg ES256, use sig, kid). */
  getPublicJwk(): JWK;
  /** RFC 7638 thumbprint of the public JWK — the token-header `kid`. */
  getKid(): string;
}

/**
 * In-process ES256 signer over a persisted EC P-256 private JWK. NEVER selected
 * in a Platform-connected deployment; the local dev plane is its only caller.
 */
export class LocalDevSigner implements LocalSigner {
  readonly alg = 'ES256' as const;

  private constructor(
    private readonly privateKey: CryptoKey,
    private readonly publicJwk: JWK,
  ) {}

  /** Build a signer from an EC P-256 private JWK (`{ kty, crv, x, y, d }`). */
  static async fromPrivateJwk(jwk: JWK): Promise<LocalDevSigner> {
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d) {
      throw new Error(
        'dev identity key must be an EC P-256 private JWK (kty=EC, crv=P-256, d set)',
      );
    }
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      jwk as JsonWebKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    // Public JWK carries ONLY the public members; the private `d` never leaves
    // this process. The kid is the RFC 7638 thumbprint (jose reads only the
    // required members crv/kty/x/y), matched by the verifier's key selection.
    const publicJwk: JWK = {
      kty: 'EC',
      crv: 'P-256',
      x: jwk.x,
      y: jwk.y,
      alg: 'ES256',
      use: 'sig',
    };
    publicJwk.kid = await calculateJwkThumbprint(publicJwk, 'sha256');
    return new LocalDevSigner(privateKey, publicJwk);
  }

  /** Read + import the private JWK from `path` (the plane's 0600 key file). */
  static async fromFile(path: string): Promise<LocalDevSigner> {
    const jwk = JSON.parse(await readFile(path, 'utf-8')) as JWK;
    return LocalDevSigner.fromPrivateJwk(jwk);
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    // Web Crypto ECDSA already returns JOSE-raw r||s.
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      this.privateKey,
      data as unknown as BufferSource,
    );
    return new Uint8Array(sig);
  }

  getPublicJwk(): JWK {
    return this.publicJwk;
  }

  getKid(): string {
    return this.publicJwk.kid as string;
  }
}
