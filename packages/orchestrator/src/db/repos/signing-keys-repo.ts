import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database, OrchestratorSigningKeyRow } from '../types.js';
import { SigningKeyStatus, TRUSTED_STATUSES } from '../../oidc/signing-key-status.js';

export interface UpsertActiveInput {
  kid: string;
  public_jwk: Record<string, unknown>;
  /** Wrapped private JWK for `db` custody; null for `aws-kms` / `command`. */
  encrypted_private_jwk: string | null;
  alg: string;
  signer_kind: string;
  key_ref: string | null;
}

/**
 * Advisory-lock name taken (`pg_advisory_xact_lock(hashtext(...))`) by every
 * writer that changes which key is `active` or revokes a key: `activateIfCurrent`,
 * `upsertActive` and `revoke`. Holding it for the whole transaction makes
 * "read the active key, then write" atomic across orchestrator nodes sharing the
 * database, and orders a revoke against a key switch.
 */
export const ACTIVE_SIGNING_KEY_LOCK = 'orchestrator-signing-key-active';

/**
 * The columns a key listing may expose: identity, lifecycle and custody
 * metadata. Never the public JWK or the wrapped private key.
 */
export const SIGNING_KEY_METADATA_COLUMNS = [
  'kid',
  'status',
  'alg',
  'signer_kind',
  'key_ref',
  'activated_at',
  'created_at',
] as const;

/** One row of {@link OrchestratorSigningKeyRepo.listTrustedMetadata}. */
export type SigningKeyMetadataRow = Pick<
  OrchestratorSigningKeyRow,
  (typeof SIGNING_KEY_METADATA_COLUMNS)[number]
>;

/** Outcome of {@link OrchestratorSigningKeyRepo.activateIfCurrent}. */
export interface ActivateIfCurrentResult {
  /** True when this call activated `input.kid`. */
  activated: boolean;
  /**
   * The active row after the call: the new row when `activated`, otherwise the
   * row that was active when the lock was taken (null when none was).
   */
  active: OrchestratorSigningKeyRow | null;
}

/**
 * Repository for the orchestrator's provenance signing keys. Ports the Platform's
 * `signing-keys-repo.ts` status model (activate / retire / revoke) and adds
 * `encrypted_private_jwk` custody for `db` keys.
 */
export class OrchestratorSigningKeyRepo {
  constructor(private readonly db: Kysely<Database>) {}

  private async lockActiveKey(trx: Transaction<Database>): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${ACTIVE_SIGNING_KEY_LOCK}))`.execute(trx);
  }

  private async readActiveRow(
    executor: Kysely<Database> | Transaction<Database>,
  ): Promise<OrchestratorSigningKeyRow | null> {
    const row = await executor
      .selectFrom('orchestrator_signing_keys')
      .selectAll()
      .where('status', '=', SigningKeyStatus.enum.active)
      .orderBy('activated_at', 'desc')
      .executeTakeFirst();
    return row ?? null;
  }

  /** Public keys served in the JWKS / trusted for verification (everything except revoked). */
  async listTrusted(): Promise<OrchestratorSigningKeyRow[]> {
    return this.db
      .selectFrom('orchestrator_signing_keys')
      .selectAll()
      .where('status', 'in', TRUSTED_STATUSES as string[])
      .orderBy('created_at', 'asc')
      .execute();
  }

  /**
   * The same keys as {@link listTrusted}, in the same order, with only the
   * {@link SIGNING_KEY_METADATA_COLUMNS}. Backs `kici-admin signing-key list`.
   */
  async listTrustedMetadata(): Promise<SigningKeyMetadataRow[]> {
    return this.db
      .selectFrom('orchestrator_signing_keys')
      .select(SIGNING_KEY_METADATA_COLUMNS)
      .where('status', 'in', TRUSTED_STATUSES as string[])
      .orderBy('created_at', 'asc')
      .execute();
  }

  /** The single currently-active key row, or null when none is active. */
  async getActiveRow(): Promise<OrchestratorSigningKeyRow | null> {
    return this.readActiveRow(this.db);
  }

  /**
   * Activate the freshly generated key `input` only if the active key is still
   * the one the caller last read (`expectedActiveKid`; null = none was active).
   * The read and the write run under {@link ACTIVE_SIGNING_KEY_LOCK}, so of
   * several nodes that each read "no key" and each generated one, exactly one
   * activates; every other call returns the winner's row untouched. A replaced
   * key is demoted to `retiring`.
   */
  async activateIfCurrent(
    expectedActiveKid: string | null,
    input: UpsertActiveInput,
  ): Promise<ActivateIfCurrentResult> {
    return this.db.transaction().execute(async (trx) => {
      await this.lockActiveKey(trx);
      const current = await this.readActiveRow(trx);
      // fails-when: another node activated (or replaced) a key between the
      // caller's read and this transaction — the caller's key is never written.
      // breaks-if-wrong: the first node to create a key, or a custody switch
      // replacing the key it read, must still activate.
      if ((current?.kid ?? null) !== expectedActiveKid) {
        return { activated: false, active: current };
      }
      if (current) {
        // Only an `active` row is demoted: a `revoked` status is terminal, and a
        // writer outside the lock may have revoked this key since the read above.
        // fails-when: the demote matches on kid alone and rewrites `revoked` to
        // `retiring`, which returns a compromised key to the JWKS.
        // breaks-if-wrong: a custody switch must still demote the active key it read.
        await trx
          .updateTable('orchestrator_signing_keys')
          .set({ status: SigningKeyStatus.enum.retiring })
          .where('kid', '=', current.kid)
          .where('status', '=', SigningKeyStatus.enum.active)
          .execute();
      }
      const inserted = await trx
        .insertInto('orchestrator_signing_keys')
        .values({
          kid: input.kid,
          public_jwk: JSON.stringify(input.public_jwk),
          encrypted_private_jwk: input.encrypted_private_jwk,
          alg: input.alg,
          signer_kind: input.signer_kind,
          key_ref: input.key_ref,
          status: SigningKeyStatus.enum.active,
          activated_at: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { activated: true, active: inserted };
    });
  }

  /**
   * Activate `input.kid`. If it is already active, no-op. Otherwise demote any
   * current active key to `retiring`, upsert this kid as `active`, in one
   * transaction under {@link ACTIVE_SIGNING_KEY_LOCK}. Returns true when a NEW
   * kid was activated (caller audits). Refuses to reactivate a `revoked` kid.
   */
  async upsertActive(input: UpsertActiveInput): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      await this.lockActiveKey(trx);
      const existing = await trx
        .selectFrom('orchestrator_signing_keys')
        .select(['kid', 'status'])
        .where('kid', '=', input.kid)
        .executeTakeFirst();
      if (existing?.status === SigningKeyStatus.enum.active) return false;
      // `revoked` is terminal: a compromised key never returns to the trust root.
      if (existing?.status === SigningKeyStatus.enum.revoked) {
        throw new Error(
          `refusing to reactivate revoked signing key ${input.kid}: rotate the signing key and update config`,
        );
      }

      await trx
        .updateTable('orchestrator_signing_keys')
        .set({ status: SigningKeyStatus.enum.retiring })
        .where('status', '=', SigningKeyStatus.enum.active)
        .where('kid', '!=', input.kid)
        .execute();

      await trx
        .insertInto('orchestrator_signing_keys')
        .values({
          kid: input.kid,
          public_jwk: JSON.stringify(input.public_jwk),
          encrypted_private_jwk: input.encrypted_private_jwk,
          alg: input.alg,
          signer_kind: input.signer_kind,
          key_ref: input.key_ref,
          status: SigningKeyStatus.enum.active,
          activated_at: new Date(),
        })
        .onConflict((oc) =>
          oc
            .column('kid')
            .doUpdateSet({ status: SigningKeyStatus.enum.active, activated_at: new Date() }),
        )
        .execute();
      return true;
    });
  }

  async retire(kid: string): Promise<void> {
    await this.db
      .updateTable('orchestrator_signing_keys')
      .set({ status: SigningKeyStatus.enum.retired, retired_at: new Date() })
      .where('kid', '=', kid)
      .where('status', '=', SigningKeyStatus.enum.retiring)
      .execute();
  }

  /**
   * Mark `kid` revoked, under {@link ACTIVE_SIGNING_KEY_LOCK} so a concurrent
   * key switch either sees the revoke or finishes before it.
   */
  async revoke(kid: string, reason: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await this.lockActiveKey(trx);
      await trx
        .updateTable('orchestrator_signing_keys')
        .set({
          status: SigningKeyStatus.enum.revoked,
          revoked_at: new Date(),
          revocation_reason: reason,
        })
        .where('kid', '=', kid)
        .execute();
    });
  }
}
