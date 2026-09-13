import type { Kysely } from 'kysely';
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
 * Repository for the orchestrator's provenance signing keys. Ports the Platform's
 * `signing-keys-repo.ts` status model (activate / retire / revoke) and adds
 * `encrypted_private_jwk` custody for `db` keys.
 */
export class OrchestratorSigningKeyRepo {
  constructor(private readonly db: Kysely<Database>) {}

  /** Public keys served in the JWKS / trusted for verification (everything except revoked). */
  async listTrusted(): Promise<OrchestratorSigningKeyRow[]> {
    return this.db
      .selectFrom('orchestrator_signing_keys')
      .selectAll()
      .where('status', 'in', TRUSTED_STATUSES as string[])
      .orderBy('created_at', 'asc')
      .execute();
  }

  /** The single currently-active key row, or null when none is active. */
  async getActiveRow(): Promise<OrchestratorSigningKeyRow | null> {
    const row = await this.db
      .selectFrom('orchestrator_signing_keys')
      .selectAll()
      .where('status', '=', SigningKeyStatus.enum.active)
      .orderBy('activated_at', 'desc')
      .executeTakeFirst();
    return row ?? null;
  }

  /**
   * Activate `input.kid`. If it is already active, no-op. Otherwise demote any
   * current active key to `retiring`, upsert this kid as `active`, in one
   * transaction. Returns true when a NEW kid was activated (caller audits).
   * Refuses to reactivate a `revoked` kid.
   */
  async upsertActive(input: UpsertActiveInput): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
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

  async revoke(kid: string, reason: string): Promise<void> {
    await this.db
      .updateTable('orchestrator_signing_keys')
      .set({
        status: SigningKeyStatus.enum.revoked,
        revoked_at: new Date(),
        revocation_reason: reason,
      })
      .where('kid', '=', kid)
      .execute();
  }
}
