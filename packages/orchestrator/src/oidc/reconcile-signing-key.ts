/**
 * Boot reconcile for the orchestrator's provenance signing key. Ensures exactly
 * one `active` key exists and returns a live `Signer` bound to it.
 *
 *  - `db` custody: the private key is a random keypair generated + persisted
 *    (master-key-wrapped) in the DB. Generation is LEADER-GATED so an HA cluster
 *    never races two active keys; every node then loads the one active row. A
 *    non-leader that finds no active row yet returns null this tick and is
 *    retried on the next leadership/boot cycle.
 *  - `aws-kms` / `command` custody: the key lives outside KiCI, so every node
 *    resolves the SAME kid and `upsertActive` is idempotent across the fleet.
 */
import type { JWK } from 'jose';
import { DbSigner, unwrapPrivateJwkWithKeyAge } from './db-signer.js';
import { strandedKeyError } from '../secrets/master-key-rotation.js';
import {
  buildExternalSigner,
  isProvenanceSigningEnabled,
  OrchestratorSignerKind,
  type OrchestratorSignerConfig,
  resolveSignerKind,
} from './orchestrator-signer-factory.js';
import type { Signer } from './signer.js';
import type { OrchestratorSigningKeyRepo } from '../db/repos/signing-keys-repo.js';

export interface ReconcileSigningKeyDeps {
  repo: Pick<OrchestratorSigningKeyRepo, 'getActiveRow' | 'upsertActive'>;
  config: OrchestratorSignerConfig;
  isLeader: () => boolean;
  /** The orchestrator master key (`KICI_SECRET_KEY`), for `db` custody wrapping. */
  secretKey: string | undefined;
  /**
   * The previous master key (`KICI_SECRET_KEY_OLD`), during a rotation grace
   * window. The signing key is master-key wrapped, so a rotation that has not
   * yet swept `orchestrator_signing_keys` leaves the row sealed under the old
   * key — without this fallback the boot path throws and provenance signing is
   * dead until the old key is restored.
   */
  oldSecretKey?: string | undefined;
  /**
   * Re-seal a row that opened only under the OLD master key, back under the
   * current one. Optional: when unset the row is loaded and left as it is, so
   * signing works but stays stranded. Best-effort — a failure is warned and
   * never blocks the boot.
   *
   * This is the recovery path for a deployment stranded by a rotation that ran
   * before `orchestrator_signing_keys` was part of the sweep: restore the old
   * key once, restart, and the row moves to the current key on its own.
   */
  selfHeal?: (row: { kid: string; key_version: number }, privateJwk: JWK) => Promise<void>;
  /** Structured warn sink for the self-heal notice. */
  logWarn?: (message: string, meta: Record<string, unknown>) => void;
  /** Called once when a NEW kid is first activated (audit log, system actor). */
  audit: (info: { kid: string; signerKind: string; keyRef: string | null }) => Promise<void> | void;
}

/** Reconcile + return the active signer, or null when signing is off / not yet ready. */
export async function reconcileOrchestratorSigningKey(
  deps: ReconcileSigningKeyDeps,
): Promise<{ signer: Signer } | null> {
  if (!isProvenanceSigningEnabled(deps.config)) return null;
  const kind = resolveSignerKind(deps.config);

  if (kind === OrchestratorSignerKind.enum.db) {
    return reconcileDbCustody(deps);
  }
  return reconcileExternalCustody(deps);
}

async function reconcileDbCustody(
  deps: ReconcileSigningKeyDeps,
): Promise<{ signer: Signer } | null> {
  if (!deps.secretKey) {
    throw new Error(
      'orchestrator-owned provenance signing with db custody requires KICI_SECRET_KEY (the master key that wraps the private signing key)',
    );
  }
  const existing = await deps.repo.getActiveRow();
  if (existing?.encrypted_private_jwk) {
    let unwrapped: { privateJwk: JWK; usedOldKey: boolean };
    try {
      unwrapped = unwrapPrivateJwkWithKeyAge(
        existing.encrypted_private_jwk,
        deps.secretKey,
        deps.oldSecretKey,
      );
    } catch {
      // Loud and recovery-pointing rather than a bare AES-GCM auth failure:
      // this throw is what an operator sees when a rotation stranded the key,
      // and the boot path has no catch for it.
      throw strandedKeyError('the provenance signing key');
    }
    if (unwrapped.usedOldKey && deps.selfHeal) {
      await deps
        .selfHeal({ kid: existing.kid, key_version: existing.key_version }, unwrapped.privateJwk)
        .then(() =>
          deps.logWarn?.(
            'provenance signing key was sealed under the old master key — re-encrypted under the current key (self-heal)',
            { kid: existing.kid },
          ),
        )
        .catch((err: unknown) =>
          deps.logWarn?.('provenance signing key self-heal failed; key stays stranded', {
            kid: existing.kid,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    }
    const signer = await DbSigner.fromPrivateJwk(unwrapped.privateJwk);
    return { signer };
  }
  if (!deps.isLeader()) {
    // A non-leader must not generate a fresh random key (would race the leader).
    return null;
  }
  const generated = await DbSigner.generate(deps.secretKey);
  const activatedNew = await deps.repo.upsertActive({
    kid: generated.kid,
    public_jwk: generated.publicJwk as unknown as Record<string, unknown>,
    encrypted_private_jwk: generated.encryptedPrivateJwk,
    alg: generated.signer.alg,
    signer_kind: generated.signer.signerKind,
    key_ref: generated.signer.keyRef,
  });
  if (activatedNew) {
    await deps.audit({
      kid: generated.kid,
      signerKind: generated.signer.signerKind,
      keyRef: generated.signer.keyRef,
    });
  }
  return { signer: generated.signer };
}

async function reconcileExternalCustody(
  deps: ReconcileSigningKeyDeps,
): Promise<{ signer: Signer } | null> {
  const signer = await buildExternalSigner(deps.config);
  if (!signer) return null; // unreachable given the kind guard, but keeps the type honest
  const publicJwk = await signer.getPublicJwk();
  const kid = await signer.getKid();
  const activatedNew = await deps.repo.upsertActive({
    kid,
    public_jwk: publicJwk as unknown as Record<string, unknown>,
    encrypted_private_jwk: null, // external custody never stores the private key
    alg: signer.alg,
    signer_kind: signer.signerKind,
    key_ref: signer.keyRef,
  });
  if (activatedNew) {
    await deps.audit({ kid, signerKind: signer.signerKind, keyRef: signer.keyRef });
  }
  return { signer };
}
