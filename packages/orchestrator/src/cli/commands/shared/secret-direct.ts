/**
 * `kici-admin secret set` and `secret verify` with `--database-url` (or `KICI_DATABASE_URL`).
 *
 * A direct write encrypts the value the way the orchestrator encrypts it (AES-256-GCM under
 * the master key, AAD `orgId:scope:key`, the store's key version) through the orchestrator's
 * own `PgSecretStore`, and records it in the secrets audit log, as the admin API does. The
 * orchestrator reads the row back like one it wrote; a value is never stored as plaintext.
 *
 * The master key and `KICI_PG_CUSTOMER_SECRETS` are read the way the orchestrator reads them
 * at startup: through its own config schema, from the shell environment or from the service
 * env file that `--env-file` names.
 */

import type { Kysely } from 'kysely';
import { createPool } from '@kici-dev/shared';
import { assertValidSecretKey, validateScopeName } from '@kici-dev/engine';
import { ConfigScope, loadConfig } from '../../../config.js';
import { createDb } from '../../../db/client.js';
import type { Database } from '../../../db/types.js';
import { AuditLogger } from '../../../secrets/audit-logger.js';
import { resolveMasterKeys, type ResolvedMasterKeys } from '../../../secrets/config.js';
import {
  PgSecretStore,
  StoredKeyCheck,
  type SecretLocation,
} from '../../../secrets/pg-secret-store.js';
import { DEFAULT_BACKEND_NAME, resolveScope } from '../../../secrets/scope-routing.js';
import { envFileVariables } from './env-file-variables.js';

/** Where a direct-database write is set, and its value. */
export interface DirectSecretWrite {
  orgId: string;
  scope: string;
  key: string;
  value: string;
}

/** The actor a direct-database write is audited as. */
export const DIRECT_SECRET_ACTOR = 'kici-admin (direct database)';

/** The env-file variables a direct secret command reads. */
const SECRET_ENV_NAMES = [
  'KICI_SECRET_KEY',
  'KICI_SECRET_KEY_FILE',
  'KICI_SECRET_KEY_OLD',
  'KICI_SECRET_KEY_FILE_OLD',
  'KICI_PG_CUSTOMER_SECRETS',
];

/** The settings a direct secret command runs with. */
export interface DirectSecretSettings {
  masterKeys: ResolvedMasterKeys | null;
  pgCustomerSecrets: boolean;
}

/**
 * The master-key and PG-customer-secret variables of a service env file. No other variable
 * is read, so an unrelated setting in the file cannot fail the command. Throws naming the
 * path, never the content, when the file cannot be read.
 */
export function secretEnvFromEnvFile(
  envFilePath: string,
  readFile?: (p: string) => string,
): NodeJS.ProcessEnv {
  return envFileVariables(envFilePath, (key) => SECRET_ENV_NAMES.includes(key), readFile);
}

/**
 * Resolve the settings from `env` through the orchestrator's startup schema, without its
 * runtime requirements (the packaging scope), so a shell with only the database and key
 * settings works and a value the orchestrator would refuse is refused here too.
 */
export function resolveDirectSecretSettings(env: NodeJS.ProcessEnv): DirectSecretSettings {
  const config = loadConfig(ConfigScope.enum.packaging, env);
  return {
    masterKeys: resolveMasterKeys(config),
    pgCustomerSecrets: config.pgCustomerSecrets,
  };
}

/** The settings, or a refusal naming where they come from when no master key is set. */
function requireMasterKeys(settings: DirectSecretSettings): ResolvedMasterKeys {
  if (settings.masterKeys) return settings.masterKeys;
  throw new Error(
    'A direct-database secret command needs the orchestrator master key: set KICI_SECRET_KEY or ' +
      'KICI_SECRET_KEY_FILE, pass the orchestrator env file with --env-file, or use the admin ' +
      'API (--url and --token).',
  );
}

async function withStore<T>(
  databaseUrl: string,
  masterKeys: ResolvedMasterKeys,
  fn: (store: PgSecretStore, db: Kysely<Database>, auditLogger: AuditLogger) => Promise<T>,
): Promise<T> {
  const pool = createPool(databaseUrl);
  const db = createDb(pool);
  try {
    const auditLogger = new AuditLogger(db);
    const store = await PgSecretStore.create(db, masterKeys.current, auditLogger, masterKeys.old);
    return await fn(store, db, auditLogger);
  } finally {
    await db.destroy();
    await pool.end().catch(() => {});
  }
}

/** What a direct write learned about the master key. */
export interface DirectSecretResult {
  /**
   * False when no stored secret could confirm the key: the store held no ciphertext (none
   * stored yet, or only legacy plaintext). The caller warns and points at `secret verify`.
   */
  keyConfirmed: boolean;
}

/**
 * Encrypt and store `write` in the orchestrator database at `databaseUrl`.
 * @throws When no master key is configured, when the store holds ciphertext and the key
 * decrypts none of it (it is not this orchestrator's key), on a scope or key the admin API
 * refuses, on a scope qualified with another backend, and when PG customer secrets are
 * disabled.
 */
export async function setSecretDirect(
  databaseUrl: string,
  write: DirectSecretWrite,
  settings: DirectSecretSettings,
): Promise<DirectSecretResult> {
  // fails-when: a direct write stores the value as plaintext, which the orchestrator cannot read
  const masterKeys = requireMasterKeys(settings);
  assertValidSecretKey(write.key);

  return withStore(databaseUrl, masterKeys, async (store, _db, auditLogger) => {
    // A `pg:` qualifier names the backend this command writes to, as the admin API accepts it.
    const resolved = resolveScope(write.scope, new Map([[DEFAULT_BACKEND_NAME, store]]), store);
    const otherBackend = resolved.qualified ? null : /^([a-z][a-z0-9-]*):/.exec(write.scope)?.[1];
    // fails-when: a scope for another backend is written to PostgreSQL, or refused with a
    //   message about the scope name
    if (otherBackend) {
      throw new Error(
        `Direct-database mode writes only the PostgreSQL store (${DEFAULT_BACKEND_NAME}:). ` +
          `"${write.scope}" names the "${otherBackend}" backend: set it through the admin API ` +
          '(--url and --token).',
      );
    }
    const scopeError = validateScopeName(resolved.path);
    if (scopeError) throw new Error(scopeError);
    // fails-when: a foreign key writes a row that no orchestrator key decrypts, which then
    //   fails rotate-key for the whole install
    const keyCheck = await store.checkKeyAgainstStoredSecrets();
    if (keyCheck === StoredKeyCheck.Mismatch) {
      throw new Error(
        'The master key decrypts none of the secrets already stored in this database, so it is ' +
          'not this orchestrator key. Check KICI_SECRET_KEY / KICI_SECRET_KEY_FILE, or pass the ' +
          'orchestrator env file with --env-file. "kici-admin secret verify" lists the secrets a ' +
          'key cannot decrypt.',
      );
    }
    store.customerSecretsEnabled = settings.pgCustomerSecrets;
    await store.setSecret(write.orgId, resolved.path, write.key, write.value);
    await auditLogger.log({
      action: 'setSecret',
      // The scope exactly as the caller sent it, as the admin API records it.
      contextName: write.scope,
      routingKey: null,
      secretKeys: [write.key],
      outcome: 'allowed',
      runId: null,
      jobId: null,
      userId: DIRECT_SECRET_ACTOR,
      role: null,
      metadata: { orgId: write.orgId },
    });
    return { keyConfirmed: keyCheck === StoredKeyCheck.Match };
  });
}

/** Every stored secret the master key cannot decrypt, read straight from the database. */
export async function verifySecretsDirect(
  databaseUrl: string,
  settings: DirectSecretSettings,
): Promise<SecretLocation[]> {
  return withStore(databaseUrl, requireMasterKeys(settings), (store) => store.findUndecryptable());
}
