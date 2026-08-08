import { type Kysely, sql } from 'kysely';

/**
 * Add the `orchestrator_signing_keys` table: the cluster-scoped, long-lived
 * ES256 provenance signing keys the orchestrator uses to sign its own build
 * attestations. One `active` key signs; rotated-out keys go `retiring` then
 * `retired` (still served in the JWKS so historical attestations keep
 * verifying); `revoked` keys are removed from the trust root.
 *
 * `public_jwk` is the non-secret public half served at `/.well-known/jwks.json`.
 * `encrypted_private_jwk` holds the AES-256-GCM-wrapped private JWK for `db`
 * custody (wrapped with the orchestrator's `KICI_SECRET_KEY` master key, same
 * posture as `scoped_secrets`) and is NULL for `aws-kms` / `command` custody
 * where the private key never lives in the DB. `key_ref` locates the external
 * key (KMS ARN / signer command) for non-`db` custody.
 *
 * Idempotent: guarded on table existence.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  if (await tableExists(db, 'orchestrator_signing_keys')) return;
  await db.schema
    .createTable('orchestrator_signing_keys')
    .addColumn('kid', 'text', (c) => c.primaryKey())
    .addColumn('public_jwk', 'jsonb', (c) => c.notNull())
    .addColumn('encrypted_private_jwk', 'text')
    .addColumn('key_version', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('alg', 'text', (c) => c.notNull())
    .addColumn('signer_kind', 'text', (c) => c.notNull())
    .addColumn('key_ref', 'text')
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('active'))
    .addColumn('revocation_reason', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('activated_at', 'timestamptz')
    .addColumn('retired_at', 'timestamptz')
    .addColumn('revoked_at', 'timestamptz')
    .execute();
  await db.schema
    .createIndex('idx_orch_signing_keys_status')
    .on('orchestrator_signing_keys')
    .column('status')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('orchestrator_signing_keys').ifExists().execute();
}

async function tableExists(db: Kysely<unknown>, table: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ${table}
    ) AS exists
  `.execute(db);
  return result.rows[0]?.exists ?? false;
}
