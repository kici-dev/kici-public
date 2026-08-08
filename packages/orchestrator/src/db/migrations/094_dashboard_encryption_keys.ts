import { type Kysely, sql } from 'kysely';

/**
 * Add the `dashboard_encryption_keys` table: the cluster-scoped, long-lived
 * X25519 keypair the orchestrator owns for browser-sealed dashboard writes.
 * Under the `encrypted` dashboard-write posture the browser seals a secret /
 * variable value to the `active` key's public half before it leaves the page,
 * so the hosted Platform relays only opaque ciphertext.
 *
 * Modeled on `orchestrator_signing_keys` (migration 084). `public_jwk` is the
 * non-secret OKP/X25519 public JWK (`use:'enc'`) served at
 * `/.well-known/jwks.json`. `encrypted_private_key` holds the AES-256-GCM
 * master-key-wrapped (KICI_SECRET_KEY) DER private key — db custody only, so it
 * is NOT NULL. One `active` key seals; a rotated-out key goes `revoked` and
 * leaves the published JWKS, while its row stays so envelopes already sealed to
 * it still decrypt.
 *
 * Idempotent: guarded on table existence.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  if (await tableExists(db, 'dashboard_encryption_keys')) return;
  await db.schema
    .createTable('dashboard_encryption_keys')
    .addColumn('kid', 'text', (c) => c.primaryKey())
    .addColumn('public_jwk', 'jsonb', (c) => c.notNull())
    .addColumn('encrypted_private_key', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('active'))
    .addColumn('revocation_reason', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('activated_at', 'timestamptz')
    .addColumn('revoked_at', 'timestamptz')
    .execute();
  await db.schema
    .createIndex('idx_dashboard_encryption_keys_status')
    .on('dashboard_encryption_keys')
    .column('status')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('dashboard_encryption_keys').ifExists().execute();
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
