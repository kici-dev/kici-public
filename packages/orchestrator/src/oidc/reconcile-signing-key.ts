/**
 * Boot reconcile for the orchestrator's provenance signing key. Ensures exactly
 * one `active` key exists and returns a live `Signer` bound to it.
 *
 *  - `db` custody: the private key is a random keypair generated + persisted
 *    (master-key-wrapped) in the DB. Any node with signing enabled may create it
 *    when no key of any custody is active; the leader gets the first chance (see
 *    `createKeyCreationGate`). The write is an atomic compare-and-activate, so
 *    nodes that race converge on the one key that won and every node signs with
 *    that key. An active key of another custody kind is never replaced here:
 *    the node refuses to sign, and `kici-admin signing-key rotate` is the
 *    explicit move to db custody.
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
import type { OrchestratorSigningKeyRow } from '../db/types.js';
import type { OrchestratorSigningKeyRepo } from '../db/repos/signing-keys-repo.js';

/**
 * How long a non-leader leaves key creation to the Raft leader before it
 * creates the key itself. Kept well under the mint's signer wait so the first
 * mint on a non-leader of a cluster whose leader has signing disabled still
 * gets a token instead of a deferral.
 */
export const NON_LEADER_KEY_CREATE_GRACE_MS = 2_000;

/**
 * Decide whether this node may create the db-custody key right now. The leader
 * always may. A non-leader may once `graceMs` has passed since it first asked,
 * so a cluster whose leader never creates the key (signing disabled on it, or
 * no leader elected) still gets one.
 */
export function createKeyCreationGate(opts: {
  isLeader: () => boolean;
  graceMs: number;
  now?: () => number;
}): () => boolean {
  const now = opts.now ?? Date.now;
  let firstAskedAt: number | undefined;
  return () => {
    if (opts.isLeader()) return true;
    const t = now();
    firstAskedAt ??= t;
    // fails-when: a non-leader is refused forever (grace never elapses).
    // breaks-if-wrong: inside the grace the leader must keep the first chance.
    return t - firstAskedAt >= opts.graceMs;
  };
}

export interface ReconcileSigningKeyDeps {
  repo: Pick<OrchestratorSigningKeyRepo, 'getActiveRow' | 'upsertActive' | 'activateIfCurrent'>;
  config: OrchestratorSignerConfig;
  /**
   * Whether this node may create the db-custody key now that none is usable.
   * Consulted only by `db` custody; see `createKeyCreationGate`.
   */
  mayCreateKey: () => boolean;
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
    return signerFromActiveRow(existing, existing.encrypted_private_jwk, deps, deps.secretKey);
  }
  // fails-when: a db-custody node replaces an active KMS or command key with a software key
  // breaks-if-wrong: with no active key at all, a node allowed to create still creates one
  if (existing) throw custodyMismatchError(existing);
  if (!deps.mayCreateKey()) return null;
  const generated = await DbSigner.generate(deps.secretKey);
  // Activate only if no key is active still. A node that lost that race writes
  // nothing and signs with the key that won.
  const outcome = await deps.repo.activateIfCurrent(null, {
    kid: generated.kid,
    public_jwk: generated.publicJwk as unknown as Record<string, unknown>,
    encrypted_private_jwk: generated.encryptedPrivateJwk,
    alg: generated.signer.alg,
    signer_kind: generated.signer.signerKind,
    key_ref: generated.signer.keyRef,
  });
  if (outcome.activated) {
    await deps.audit({
      kid: generated.kid,
      signerKind: generated.signer.signerKind,
      keyRef: generated.signer.keyRef,
    });
    return { signer: generated.signer };
  }
  const winner = outcome.active;
  if (!winner?.encrypted_private_jwk) return null;
  return signerFromActiveRow(winner, winner.encrypted_private_jwk, deps, deps.secretKey);
}

/**
 * The error a db-custody node raises for an active key it holds no private key
 * for: one of another custody kind (`aws-kms`, `command`). The node cannot sign
 * with it, and replacing it would silently move the cluster's custody, so it
 * names the two ways out instead.
 */
function custodyMismatchError(active: OrchestratorSigningKeyRow): Error {
  return new Error(
    `the active provenance signing key ${active.kid} is held in '${active.signer_kind}' custody, ` +
      `but this node is configured for 'db' custody (KICI_ORCHESTRATOR_SIGNER_KIND); it does not ` +
      `replace that key and signs nothing. Give every node the same custody, or run ` +
      `'kici-admin signing-key rotate' to move the cluster to db custody.`,
  );
}

/** Unwrap the active db-custody row and build its signer, self-healing an old-key seal. */
async function signerFromActiveRow(
  row: OrchestratorSigningKeyRow,
  encryptedPrivateJwk: string,
  deps: ReconcileSigningKeyDeps,
  secretKey: string,
): Promise<{ signer: Signer }> {
  let unwrapped: { privateJwk: JWK; usedOldKey: boolean };
  try {
    unwrapped = unwrapPrivateJwkWithKeyAge(encryptedPrivateJwk, secretKey, deps.oldSecretKey);
  } catch {
    // Loud and recovery-pointing rather than a bare AES-GCM auth failure:
    // this throw is what an operator sees when a rotation stranded the key,
    // and the boot path has no catch for it.
    throw strandedKeyError('the provenance signing key');
  }
  if (unwrapped.usedOldKey && deps.selfHeal) {
    await deps
      .selfHeal({ kid: row.kid, key_version: row.key_version }, unwrapped.privateJwk)
      .then(() =>
        deps.logWarn?.(
          'provenance signing key was sealed under the old master key — re-encrypted under the current key (self-heal)',
          { kid: row.kid },
        ),
      )
      .catch((err: unknown) =>
        deps.logWarn?.('provenance signing key self-heal failed; key stays stranded', {
          kid: row.kid,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
  }
  const signer = await DbSigner.fromPrivateJwk(unwrapped.privateJwk);
  return { signer };
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
