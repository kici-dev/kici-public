/**
 * Master-key rotation sweeps for the four wrapped stores `rotate-key` did not
 * cover: the provenance signing key, the dashboard-encryption key, run
 * ephemeral keys, and stored secret outputs.
 *
 * Each sweep runs in its own transaction with the same skip-and-count
 * discipline as `BackendRegistry.rotateKey` — a row neither key opens is
 * counted and left alone rather than failing the whole rotation, so the
 * operator sees a non-zero `skipped` and can act on it. Each sweep is
 * idempotent: re-running over rows already at the current key re-seals them at
 * the next version, which is exactly what the no-old-key "periodic
 * re-encryption" mode is for.
 */
import type { Kysely } from 'kysely';
import { decrypt, encrypt } from '@kici-dev/shared';
import type { Database } from '../db/types.js';
import { unwrapPrivateJwk, wrapPrivateJwk } from '../oidc/db-signer.js';
import type { ResolvedMasterKeys } from './config.js';
import { PRIVATE_KEY_AAD } from './ephemeral-keys.js';
import { secretOutputAad } from './secret-output-crypto.js';

/** One store's rotation outcome. Mirrors the three existing sweeps' shape. */
export interface SweepResult {
  reEncrypted: number;
  skipped: number;
}

/** Every wrapped store this module sweeps, keyed as the API reports them. */
export interface MasterKeyRotationResult {
  signingKeys: SweepResult;
  dashboardKeys: SweepResult;
  ephemeralKeys: SweepResult;
  secretOutputs: SweepResult;
}

/** Try the current key, then the old one. Null when neither opens the value. */
function openWithEitherKey(
  data: string,
  keyVersion: number,
  aad: string,
  keys: ResolvedMasterKeys,
): string | null {
  const value = { data, keyVersion };
  try {
    return decrypt(value, keys.current, aad);
  } catch {
    if (!keys.old) return null;
  }
  try {
    return decrypt(value, keys.old, aad);
  } catch {
    return null;
  }
}

type Warn = (message: string, meta: Record<string, unknown>) => void;

/**
 * Re-seal `orchestrator_signing_keys.encrypted_private_jwk` under the current
 * master key. Sweeps EVERY row, not only the active one: a retiring or revoked
 * key still has to unwrap for its historical bundles to keep verifying.
 */
async function sweepSigningKeys(
  db: Kysely<Database>,
  keys: ResolvedMasterKeys,
  warn: Warn,
): Promise<SweepResult> {
  let reEncrypted = 0;
  let skipped = 0;
  await db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom('orchestrator_signing_keys')
      .select(['kid', 'encrypted_private_jwk', 'key_version'])
      .where('encrypted_private_jwk', 'is not', null)
      .execute();
    const newVersion = rows.reduce((m, r) => Math.max(m, r.key_version), 0) + 1;
    for (const row of rows) {
      // External custody (aws-kms / command) stores no private half; the SQL
      // filter already excludes those, so this only guards the type.
      if (!row.encrypted_private_jwk) continue;
      let jwk;
      try {
        jwk = unwrapPrivateJwk(row.encrypted_private_jwk, keys.material, keys.materialOld);
      } catch {
        skipped++;
        warn('signing key undecryptable under both master keys — skipped during rotation', {
          kid: row.kid,
        });
        continue;
      }
      await trx
        .updateTable('orchestrator_signing_keys')
        .set({
          encrypted_private_jwk: wrapPrivateJwk(jwk, keys.material),
          key_version: newVersion,
        })
        .where('kid', '=', row.kid)
        .where('key_version', '=', row.key_version)
        .execute();
      reEncrypted++;
    }
  });
  return { reEncrypted, skipped };
}

/**
 * Re-seal `dashboard_encryption_keys.encrypted_private_key`. Sweeps every row
 * for the same reason as the signing keys: a revoked kid must still open the
 * writes that were sealed to it.
 */
async function sweepDashboardKeys(
  db: Kysely<Database>,
  keys: ResolvedMasterKeys,
  warn: Warn,
): Promise<SweepResult> {
  let reEncrypted = 0;
  let skipped = 0;
  await db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom('dashboard_encryption_keys')
      .select(['kid', 'encrypted_private_key', 'key_version'])
      .execute();
    const newVersion = rows.reduce((m, r) => Math.max(m, r.key_version), 0) + 1;
    for (const row of rows) {
      const der = openWithEitherKey(
        row.encrypted_private_key,
        row.key_version,
        PRIVATE_KEY_AAD,
        keys,
      );
      if (der === null) {
        skipped++;
        warn('dashboard key undecryptable under both master keys — skipped during rotation', {
          kid: row.kid,
        });
        continue;
      }
      await trx
        .updateTable('dashboard_encryption_keys')
        .set({
          encrypted_private_key: encrypt(der, keys.current, newVersion, PRIVATE_KEY_AAD).data,
          key_version: newVersion,
        })
        .where('kid', '=', row.kid)
        .where('key_version', '=', row.key_version)
        .execute();
      reEncrypted++;
    }
  });
  return { reEncrypted, skipped };
}

/** Re-seal `run_ephemeral_keys.encrypted_private_key` for every in-flight run. */
async function sweepEphemeralKeys(
  db: Kysely<Database>,
  keys: ResolvedMasterKeys,
  warn: Warn,
): Promise<SweepResult> {
  let reEncrypted = 0;
  let skipped = 0;
  await db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom('run_ephemeral_keys')
      .select(['run_id', 'encrypted_private_key', 'key_version'])
      .execute();
    const newVersion = rows.reduce((m, r) => Math.max(m, r.key_version), 0) + 1;
    for (const row of rows) {
      const der = openWithEitherKey(
        row.encrypted_private_key,
        row.key_version,
        PRIVATE_KEY_AAD,
        keys,
      );
      if (der === null) {
        skipped++;
        warn('run ephemeral key undecryptable under both master keys — skipped during rotation', {
          runId: row.run_id,
        });
        continue;
      }
      await trx
        .updateTable('run_ephemeral_keys')
        .set({
          encrypted_private_key: encrypt(der, keys.current, newVersion, PRIVATE_KEY_AAD).data,
          key_version: newVersion,
        })
        .where('run_id', '=', row.run_id)
        .where('key_version', '=', row.key_version)
        .execute();
      reEncrypted++;
    }
  });
  return { reEncrypted, skipped };
}

/**
 * Re-seal `run_secret_outputs.encrypted_value`. The AAD is per-run, so each row
 * is opened and re-sealed against its own `run_id`.
 */
async function sweepSecretOutputs(
  db: Kysely<Database>,
  keys: ResolvedMasterKeys,
  warn: Warn,
): Promise<SweepResult> {
  let reEncrypted = 0;
  let skipped = 0;
  await db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom('run_secret_outputs')
      .select(['id', 'run_id', 'output_key', 'encrypted_value', 'key_version'])
      .execute();
    const newVersion = rows.reduce((m, r) => Math.max(m, r.key_version), 0) + 1;
    for (const row of rows) {
      const aad = secretOutputAad(row.run_id);
      const plaintext = openWithEitherKey(row.encrypted_value, row.key_version, aad, keys);
      if (plaintext === null) {
        skipped++;
        warn('secret output undecryptable under both master keys — skipped during rotation', {
          runId: row.run_id,
          outputKey: row.output_key,
        });
        continue;
      }
      await trx
        .updateTable('run_secret_outputs')
        .set({
          encrypted_value: encrypt(plaintext, keys.current, newVersion, aad).data,
          key_version: newVersion,
        })
        .where('id', '=', row.id)
        .where('key_version', '=', row.key_version)
        .execute();
      reEncrypted++;
    }
  });
  return { reEncrypted, skipped };
}

/**
 * Run all four sweeps, each in its own transaction so a bug in one cannot roll
 * back a good rotation of another. Order is least-to-most volume, so the
 * singleton key tables — the two whose loss brings the orchestrator down — move
 * first.
 */
export async function rotateMasterKeyWrappedTables(
  db: Kysely<Database>,
  keys: ResolvedMasterKeys,
  warn: Warn,
): Promise<MasterKeyRotationResult> {
  return {
    signingKeys: await sweepSigningKeys(db, keys, warn),
    dashboardKeys: await sweepDashboardKeys(db, keys, warn),
    ephemeralKeys: await sweepEphemeralKeys(db, keys, warn),
    secretOutputs: await sweepSecretOutputs(db, keys, warn),
  };
}

/**
 * Re-seal a single row that decrypted only under the OLD master key, back under
 * the current one. This is the boot self-heal: a deployment already stranded by
 * a rotation that ran before these tables were swept recovers by restoring the
 * old key once and restarting.
 *
 * The `key_version` match is the concurrent-rotation guard — mirrors
 * `BackendRegistry.selfHealStrandedRow`. A rotation running at the same time
 * has already moved the version, so this UPDATE matches no row and is a no-op
 * rather than a clobber.
 */
export async function selfHealStrandedSigningKey(
  db: Kysely<Database>,
  row: { kid: string; key_version: number },
  privateJwk: Parameters<typeof wrapPrivateJwk>[0],
  keys: ResolvedMasterKeys,
): Promise<void> {
  await db
    .updateTable('orchestrator_signing_keys')
    .set({
      encrypted_private_jwk: wrapPrivateJwk(privateJwk, keys.material),
      key_version: row.key_version + 1,
    })
    .where('kid', '=', row.kid)
    .where('key_version', '=', row.key_version)
    .execute();
}

/** The dashboard-encryption twin of {@link selfHealStrandedSigningKey}. */
export async function selfHealStrandedDashboardKey(
  db: Kysely<Database>,
  row: { kid: string; key_version: number },
  privateKeyDer: Buffer,
  keys: ResolvedMasterKeys,
): Promise<void> {
  await db
    .updateTable('dashboard_encryption_keys')
    .set({
      encrypted_private_key: encrypt(
        privateKeyDer.toString('base64'),
        keys.current,
        row.key_version + 1,
        PRIVATE_KEY_AAD,
      ).data,
      key_version: row.key_version + 1,
    })
    .where('kid', '=', row.kid)
    .where('key_version', '=', row.key_version)
    .execute();
}

/**
 * Loud, recovery-pointing error for a key stranded by a master-key rotation.
 * Same shape and intent as `BackendRegistry.strandedError`: the operator needs
 * to be told the recovery path, not just that AES-GCM failed.
 */
export function strandedKeyError(store: string): Error {
  return new Error(
    `${store} cannot be decrypted with the configured master key(s). ` +
      `This usually means master-key rotation ran before this store was included in the sweep. ` +
      `Recovery: set KICI_SECRET_KEY_OLD (or KICI_SECRET_KEY_FILE_OLD) to the previous key and ` +
      `restart — the key is re-encrypted under the current key automatically — then re-run ` +
      `'kici-admin rotate-key' and confirm it reports a non-zero count for this store.`,
  );
}
