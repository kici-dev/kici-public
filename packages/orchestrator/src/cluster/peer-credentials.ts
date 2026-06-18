/**
 * Peer credential management for cluster authentication.
 *
 * Provides two persistence layers:
 * 1. DB CRUD (PeerCredentialStore) — coordinator stores credentials for all peers
 * 2. File I/O (readCredentialFile/writeCredentialFile) — workers persist their
 *    credential locally for reconnection after restart
 *
 * Credential files are written with 0600 permissions to protect the secret.
 */
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

/**
 * A peer credential record stored in the coordinator's database.
 */
export interface PeerCredential {
  id: string;
  instanceId: string;
  credentialHash: string;
  role: string;
  routingKeys: string[];
  sourceTokenHash: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  lastValidatedBy: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

/**
 * Data persisted in this orchestrator's local credential file
 * (~/.kici/credential.json). The credential is identity-scoped: one file per
 * orchestrator, shared across every peer-client this orchestrator runs. See
 * the `sendAuthRequest` doc in peer-client.ts for the history.
 */
export interface CredentialFileData {
  instanceId: string;
  credential: string;
  role: string;
  /** ISO 8601 timestamp of when this credential was issued. */
  issuedAt: string;
}

/** Default credential expiry: 90 days. */
const DEFAULT_EXPIRY_DAYS = 90;

/**
 * Database CRUD operations for peer credentials.
 * Used by the coordinator to manage credentials for all cluster members.
 */
export class PeerCredentialStore {
  constructor(private readonly db: Kysely<any>) {}

  /**
   * Save a new peer credential.
   */
  async save(opts: {
    instanceId: string;
    credentialHash: string;
    role: string;
    routingKeys: string[];
    sourceTokenHash?: string;
    expiryDays?: number;
  }): Promise<void> {
    const expiryDays = opts.expiryDays ?? DEFAULT_EXPIRY_DAYS;
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

    const runOnce = async (): Promise<void> => {
      await this.db.transaction().execute(async (trx) => {
        // Revoke old credentials for this instanceId to prevent stale hash buildup.
        // Each reconnection issues a new credential; the old one is no longer valid.
        await trx
          .updateTable('peer_credentials' as any)
          .set({ revoked_at: new Date() })
          .where('instance_id', '=', opts.instanceId)
          .where('revoked_at', 'is', null)
          .execute();

        await trx
          .insertInto('peer_credentials' as any)
          .values({
            instance_id: opts.instanceId,
            credential_hash: opts.credentialHash,
            role: opts.role,
            routing_keys: sql`${sql.val(opts.routingKeys)}`,
            source_token_hash: opts.sourceTokenHash ?? null,
            expires_at: expiresAt,
          })
          .execute();
      });
    };

    // Retry-once on PG unique_violation ('23505'): the partial unique index
    // peer_credentials_active_uniq makes the UPDATE+INSERT racing two
    // concurrent saves a TOCTOU loser. The retry's UPDATE now sees the
    // winner's committed row and revokes it before re-inserting. See
    try {
      await runOnce();
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
        await runOnce();
        return;
      }
      throw err;
    }
  }

  /**
   * Find a non-revoked, non-expired credential by its hash.
   */
  async findByCredentialHash(hash: string): Promise<PeerCredential | null> {
    const row = await this.db
      .selectFrom('peer_credentials' as any)
      .selectAll()
      .where('credential_hash', '=', hash)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', new Date())
      .executeTakeFirst();

    return row ? mapRow(row) : null;
  }

  /**
   * Find a non-revoked, non-expired credential by instance ID.
   */
  async findByInstanceId(instanceId: string): Promise<PeerCredential | null> {
    const row = await this.db
      .selectFrom('peer_credentials' as any)
      .selectAll()
      .where('instance_id', '=', instanceId)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', new Date())
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    return row ? mapRow(row) : null;
  }

  /**
   * Update the last_seen_at timestamp for a credential.
   * Optionally records which coordinator validated it.
   */
  async updateLastSeen(credentialHash: string, validatedBy?: string): Promise<void> {
    const updates: Record<string, unknown> = { last_seen_at: new Date() };
    if (validatedBy) updates.last_validated_by = validatedBy;

    await this.db
      .updateTable('peer_credentials' as any)
      .set(updates)
      .where('credential_hash', '=', credentialHash)
      .execute();
  }

  /**
   * Revoke a peer's credential by instance ID.
   */
  async revoke(instanceId: string): Promise<void> {
    await this.db
      .updateTable('peer_credentials' as any)
      .set({ revoked_at: new Date() })
      .where('instance_id', '=', instanceId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  /**
   * Revoke all active credentials.
   * @returns The number of credentials revoked.
   */
  async revokeAll(): Promise<number> {
    const result = await this.db
      .updateTable('peer_credentials' as any)
      .set({ revoked_at: new Date() })
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    return Number((result as any)?.numUpdatedRows ?? 0);
  }

  /**
   * List all active (non-revoked, non-expired) credentials.
   */
  async listActive(): Promise<PeerCredential[]> {
    const rows = await this.db
      .selectFrom('peer_credentials' as any)
      .selectAll()
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', new Date())
      .orderBy('created_at', 'asc')
      .execute();

    return (rows as any[]).map(mapRow);
  }
}

/**
 * Map a database row to a PeerCredential interface.
 */
function mapRow(row: any): PeerCredential {
  return {
    id: row.id,
    instanceId: row.instance_id,
    credentialHash: row.credential_hash,
    role: row.role,
    routingKeys:
      typeof row.routing_keys === 'string' ? JSON.parse(row.routing_keys) : row.routing_keys,
    sourceTokenHash: row.source_token_hash ?? null,
    createdAt: new Date(row.created_at),
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : null,
    lastValidatedBy: row.last_validated_by ?? null,
    expiresAt: new Date(row.expires_at),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  };
}

/**
 * Write credential data to a JSON file with restrictive permissions.
 *
 * Creates the parent directory (e.g., ~/.kici/) with 0700 if it doesn't exist.
 * The credential file is written with 0600 permissions (owner read/write only).
 *
 * @param filePath - Absolute path to the credential file
 * @param data - Credential data to persist
 */
export async function writeCredentialFile(
  filePath: string,
  data: CredentialFileData,
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const json = JSON.stringify(data, null, 2) + '\n';
  await writeFile(filePath, json, { mode: 0o600 });
  // Ensure permissions are correct even if the file already existed
  await chmod(filePath, 0o600);
}

/**
 * Read credential data from a JSON file.
 *
 * @param filePath - Absolute path to the credential file
 * @returns Parsed credential data, or null if the file doesn't exist
 */
export async function readCredentialFile(filePath: string): Promise<CredentialFileData | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as CredentialFileData;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * Construct a PeerCredentialStore bound to a Postgres URL, returning the
 * store plus a disposer that closes the underlying pool. Lets tests
 * exercise the real Kysely-backed store without importing pg/kysely.
 *
 * Intended for e2e coverage of the store's own CRUD methods — production
 * code constructs the store with an already-allocated Kysely instance
 * shared with the orchestrator.
 */
export async function createPeerCredentialStoreFromUrl(
  databaseUrl: string,
  opts?: { maxConnections?: number },
): Promise<{ store: PeerCredentialStore; dispose: () => Promise<void> }> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: opts?.maxConnections ?? 3 });
  const db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
  const store = new PeerCredentialStore(db);
  return {
    store,
    dispose: async () => {
      await db.destroy();
    },
  };
}
