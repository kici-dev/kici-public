import type { Kysely } from 'kysely';
import type { Database, DashboardEncryptionKeyRow } from '../types.js';

/** Lifecycle status values for a dashboard-encryption key. */
export const DashboardEncryptionKeyStatus = {
  active: 'active',
  revoked: 'revoked',
} as const;
export type DashboardEncryptionKeyStatus =
  (typeof DashboardEncryptionKeyStatus)[keyof typeof DashboardEncryptionKeyStatus];

export interface UpsertActiveEncryptionKeyInput {
  kid: string;
  public_jwk: Record<string, unknown>;
  /** AES-256-GCM-wrapped DER private key (master-key wrapped). */
  encrypted_private_key: string;
}

/**
 * Repository for the orchestrator's dashboard-encryption (X25519) keys. One
 * `active` key seals browser writes; a rotated-out key is `revoked`, which drops
 * it from the published JWKS ({@link listNonRevoked}) so new seals only ever use
 * the current key, while its row — and therefore its wrapped private half —
 * stays on record ({@link getByKid}) so an envelope a browser already sealed to
 * the old `kid` still decrypts. Mirrors the activate/demote transaction shape of
 * `OrchestratorSigningKeyRepo`.
 */
export class DashboardEncryptionKeyRepo {
  constructor(private readonly db: Kysely<Database>) {}

  /** Public keys published in the JWKS (the active key; revoked ones drop out). */
  async listNonRevoked(): Promise<DashboardEncryptionKeyRow[]> {
    return this.db
      .selectFrom('dashboard_encryption_keys')
      .selectAll()
      .where('status', '!=', DashboardEncryptionKeyStatus.revoked)
      .orderBy('created_at', 'asc')
      .execute();
  }

  /** Every key on record: the active one plus every rotated-out (revoked) one. */
  async listServed(): Promise<DashboardEncryptionKeyRow[]> {
    return this.db
      .selectFrom('dashboard_encryption_keys')
      .selectAll()
      .orderBy('created_at', 'asc')
      .execute();
  }

  /** The single currently-active key row, or null when none is active. */
  async getActiveRow(): Promise<DashboardEncryptionKeyRow | null> {
    const row = await this.db
      .selectFrom('dashboard_encryption_keys')
      .selectAll()
      .where('status', '=', DashboardEncryptionKeyStatus.active)
      .orderBy('activated_at', 'desc')
      .executeTakeFirst();
    return row ?? null;
  }

  /** Resolve a key (active or rotated-out) by kid, or null. */
  async getByKid(kid: string): Promise<DashboardEncryptionKeyRow | null> {
    const row = await this.db
      .selectFrom('dashboard_encryption_keys')
      .selectAll()
      .where('kid', '=', kid)
      .executeTakeFirst();
    return row ?? null;
  }

  /**
   * Activate `input.kid`. If already active, no-op. Otherwise demote any
   * current active key to `revoked` and insert this kid as `active`, in one
   * transaction. Returns true when a NEW kid was activated (caller audits).
   */
  async upsertActive(input: UpsertActiveEncryptionKeyInput): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('dashboard_encryption_keys')
        .select(['kid', 'status'])
        .where('kid', '=', input.kid)
        .executeTakeFirst();
      if (existing?.status === DashboardEncryptionKeyStatus.active) return false;

      await trx
        .updateTable('dashboard_encryption_keys')
        .set({ status: DashboardEncryptionKeyStatus.revoked, revoked_at: new Date() })
        .where('status', '=', DashboardEncryptionKeyStatus.active)
        .where('kid', '!=', input.kid)
        .execute();

      await trx
        .insertInto('dashboard_encryption_keys')
        .values({
          kid: input.kid,
          public_jwk: JSON.stringify(input.public_jwk),
          encrypted_private_key: input.encrypted_private_key,
          status: DashboardEncryptionKeyStatus.active,
          activated_at: new Date(),
        })
        .onConflict((oc) =>
          oc.column('kid').doUpdateSet({
            status: DashboardEncryptionKeyStatus.active,
            activated_at: new Date(),
            revoked_at: null,
          }),
        )
        .execute();
      return true;
    });
  }

  /**
   * Mark a key revoked (rotation / compromise). It leaves the published JWKS
   * immediately, but its private half stays on record, so a browser still
   * holding the old kid keeps decrypting until the row is deleted.
   */
  async revoke(kid: string, reason: string): Promise<void> {
    await this.db
      .updateTable('dashboard_encryption_keys')
      .set({
        status: DashboardEncryptionKeyStatus.revoked,
        revoked_at: new Date(),
        revocation_reason: reason,
      })
      .where('kid', '=', kid)
      .execute();
  }
}
