/**
 * Custody + leader-gated reconcile for the orchestrator's dashboard-encryption
 * X25519 key — the trust root for browser-sealed dashboard writes under the
 * `encrypted` posture.
 *
 * The private key is a random X25519 keypair generated + persisted (master-key
 * wrapped under `KICI_SECRET_KEY`) in the DB. Generation is LEADER-GATED so an
 * HA cluster never races two active keys; every node then loads the one active
 * row. A non-leader that finds no active row yet returns null this tick and is
 * retried on the next leadership/boot cycle. Mirrors
 * `reconcileOrchestratorSigningKey`'s db-custody path.
 */
import { createPublicKey } from 'node:crypto';
import { calculateJwkThumbprint, type JWK } from 'jose';
import { generateRunKeyPair, encryptPrivateKey, decryptPrivateKey } from './ephemeral-keys.js';
import type { DashboardEncryptionKeyRepo } from '../db/repos/dashboard-encryption-keys-repo.js';

export interface GeneratedDashboardEncryptionKey {
  kid: string;
  publicJwk: JWK;
  /** AES-256-GCM-wrapped DER private key (master-key wrapped). */
  encryptedPrivateKey: string;
  /** DER-SPKI public key Buffer (for callers that need the raw bytes). */
  publicKeyDer: Buffer;
}

/**
 * Generate a fresh X25519 dashboard-encryption key: the OKP public JWK
 * (`use:'enc'`, `kid` = RFC 7638 thumbprint) plus the master-key-wrapped
 * private half.
 */
export async function generateDashboardEncryptionKey(
  secretKey: string,
): Promise<GeneratedDashboardEncryptionKey> {
  const { publicKey, privateKey } = generateRunKeyPair();
  const jwk = createPublicKey({ key: publicKey, format: 'der', type: 'spki' }).export({
    format: 'jwk',
  }) as JWK;
  jwk.use = 'enc';
  const kid = await calculateJwkThumbprint(jwk, 'sha256');
  jwk.kid = kid;
  return {
    kid,
    publicJwk: jwk,
    encryptedPrivateKey: encryptPrivateKey(privateKey, secretKey),
    publicKeyDer: publicKey,
  };
}

export interface ReconcileDashboardEncryptionKeyDeps {
  repo: Pick<DashboardEncryptionKeyRepo, 'getActiveRow' | 'upsertActive' | 'getByKid'>;
  isLeader: () => boolean;
  /** The orchestrator master key (`KICI_SECRET_KEY`), for db-custody wrapping. */
  secretKey: string | undefined;
  /** Called once when a NEW kid is first activated (audit log, system actor). */
  audit: (info: { kid: string }) => Promise<void> | void;
}

/** The resolved active dashboard-encryption key + a per-request decrypt closure. */
export interface ResolvedDashboardEncryptionKey {
  activeKid: string;
  publicJwk: JWK;
  /**
   * Unwrap the DER private key for a given `kid` — the active key OR a
   * rotated-out one whose row is still on record. The lookup is
   * status-agnostic, so a revoked key that has left the published JWKS still
   * decrypts; null means the kid is unknown (never minted, or its row was
   * deleted). Reads the wrapped private half from the DB each call, so
   * rotation is picked up without a restart.
   */
  decryptPrivateKeyDer: (kid: string) => Promise<Buffer | null>;
}

/**
 * Ensure exactly one `active` dashboard-encryption key exists and return the
 * resolved key + decrypt closure, or null when not yet ready (non-leader before
 * the leader has generated it). Requires `KICI_SECRET_KEY` (throws otherwise —
 * the private key is master-key wrapped, same posture as db-custody signing).
 */
export async function reconcileDashboardEncryptionKey(
  deps: ReconcileDashboardEncryptionKeyDeps,
): Promise<ResolvedDashboardEncryptionKey | null> {
  if (!deps.secretKey) {
    throw new Error(
      'dashboard-encryption key requires KICI_SECRET_KEY (the master key that wraps the private encryption key)',
    );
  }
  const secretKey = deps.secretKey;

  const decryptPrivateKeyDer = async (kid: string): Promise<Buffer | null> => {
    const row = await deps.repo.getByKid(kid);
    if (!row) return null;
    return decryptPrivateKey(row.encrypted_private_key, secretKey);
  };

  const existing = await deps.repo.getActiveRow();
  if (existing) {
    return { activeKid: existing.kid, publicJwk: existing.public_jwk as JWK, decryptPrivateKeyDer };
  }
  if (!deps.isLeader()) {
    // A non-leader must not generate a fresh random key (would race the leader).
    return null;
  }
  const generated = await generateDashboardEncryptionKey(secretKey);
  const activatedNew = await deps.repo.upsertActive({
    kid: generated.kid,
    public_jwk: generated.publicJwk as unknown as Record<string, unknown>,
    encrypted_private_key: generated.encryptedPrivateKey,
  });
  if (activatedNew) {
    await deps.audit({ kid: generated.kid });
  }
  return { activeKid: generated.kid, publicJwk: generated.publicJwk, decryptPrivateKeyDer };
}
