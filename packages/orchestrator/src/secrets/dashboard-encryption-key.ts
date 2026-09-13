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
import { strandedKeyError } from './master-key-rotation.js';

export interface GeneratedDashboardEncryptionKey {
  kid: string;
  publicJwk: JWK;
  /** AES-256-GCM-wrapped DER private key (master-key wrapped). */
  encryptedPrivateKey: string;
  /** DER-SPKI public key Buffer (for callers that need the raw bytes). */
  publicKeyDer: Buffer;
}

/**
 * Re-seal the active row under the current master key when it opened only under
 * the old one, and turn a both-keys failure into a loud, recovery-pointing
 * error instead of a bare AES-GCM auth failure.
 */
async function healActiveRowIfStranded(
  deps: ReconcileDashboardEncryptionKeyDeps,
  row: { kid: string; key_version: number; encrypted_private_key: string },
  secretKey: string,
  oldSecretKey: string | undefined,
): Promise<void> {
  try {
    decryptPrivateKey(row.encrypted_private_key, secretKey);
    return; // already sealed under the current key — nothing to heal
  } catch {
    if (!oldSecretKey) throw strandedKeyError('the dashboard-encryption key');
  }
  let der: Buffer;
  try {
    der = decryptPrivateKey(row.encrypted_private_key, secretKey, oldSecretKey);
  } catch {
    throw strandedKeyError('the dashboard-encryption key');
  }
  if (!deps.selfHeal) return;
  await deps
    .selfHeal({ kid: row.kid, key_version: row.key_version }, der)
    .then(() =>
      deps.logWarn?.(
        'dashboard-encryption key was sealed under the old master key — re-encrypted under the current key (self-heal)',
        { kid: row.kid },
      ),
    )
    .catch((err: unknown) =>
      deps.logWarn?.('dashboard-encryption key self-heal failed; key stays stranded', {
        kid: row.kid,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
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
  /**
   * The previous master key (`KICI_SECRET_KEY_OLD`), during a rotation grace
   * window. Lets a row still sealed under the old key unwrap, and drives the
   * boot self-heal that re-seals it under the current key.
   */
  oldSecretKey?: string | undefined;
  /** Called once when a NEW kid is first activated (audit log, system actor). */
  audit: (info: { kid: string }) => Promise<void> | void;
  /**
   * Re-seal the active row when it opened only under the OLD master key, back
   * under the current one. Optional: when unset the key still resolves but
   * stays stranded. Best-effort — a failure is warned and never blocks the
   * boot. The recovery path for a deployment stranded by a rotation that ran
   * before `dashboard_encryption_keys` was part of the sweep.
   */
  selfHeal?: (row: { kid: string; key_version: number }, privateKeyDer: Buffer) => Promise<void>;
  /** Structured warn sink for the self-heal notice. */
  logWarn?: (message: string, meta: Record<string, unknown>) => void;
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
  const oldSecretKey = deps.oldSecretKey;

  const decryptPrivateKeyDer = async (kid: string): Promise<Buffer | null> => {
    const row = await deps.repo.getByKid(kid);
    if (!row) return null;
    return decryptPrivateKey(row.encrypted_private_key, secretKey, oldSecretKey);
  };

  const existing = await deps.repo.getActiveRow();
  if (existing) {
    await healActiveRowIfStranded(deps, existing, secretKey, oldSecretKey);
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
