/**
 * Peer credentials: the coordinator stores every peer's credential in the DB
 * (PeerCredentialStore); workers persist their own in a local 0600 file to
 * reconnect after restart.
 */
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

/** How a credential row was issued, recorded in `peer_credentials.metadata.issuance`. */
export enum PeerCredentialIssuance {
  /** A coordinator issued the credential to itself (`coordinator-credential.ts`). */
  Self = 'self',
}

/**
 * `metadata` key set when a coordinator retires its previous run's self-issued
 * credential. An operator revoke never sets it, which tells the two apart.
 */
export const RETIRED_BY_INSTANCE_KEY = 'retiredByInstance';

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
  metadata: Record<string, unknown>;
}

/**
 * The local credential file (~/.kici/credential.json). Identity-scoped: one file
 * per orchestrator, shared by all its peer-clients (see `sendAuthRequest` in
 * peer-client.ts).
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

/** The coordinator's DB store of every cluster member's credential. */
export class PeerCredentialStore {
  constructor(private readonly db: Kysely<any>) {}

  /**
   * Save a credential, revoking the instanceId's prior active one
   * (`peer_credentials_active_uniq` permits one active credential per instanceId).
   *
   * `revokedCount > 0` means every sibling peer-client of `instanceId` still on the
   * old shared credential is rejected on its next proof; the caller logs it so a
   * cascade of sibling rejections is visible.
   */
  async save(opts: {
    instanceId: string;
    credentialHash: string;
    role: string;
    routingKeys: string[];
    sourceTokenHash?: string;
    expiryDays?: number;
    metadata?: Record<string, unknown>;
  }): Promise<{ revokedCount: number }> {
    const expiryDays = opts.expiryDays ?? DEFAULT_EXPIRY_DAYS;
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

    const runOnce = async (): Promise<number> => {
      return this.db.transaction().execute(async (trx) => {
        // Each reconnection issues a new credential; revoke the old so stale hashes
        // do not build up.
        const revokeResult = await trx
          .updateTable('peer_credentials' as any)
          .set({ revoked_at: new Date() })
          .where('instance_id', '=', opts.instanceId)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();

        await trx
          .insertInto('peer_credentials' as any)
          .values({
            instance_id: opts.instanceId,
            credential_hash: opts.credentialHash,
            role: opts.role,
            routing_keys: sql`${sql.val(opts.routingKeys)}`,
            source_token_hash: opts.sourceTokenHash ?? null,
            expires_at: expiresAt,
            ...(opts.metadata && {
              metadata: sql`${JSON.stringify(opts.metadata)}::jsonb`,
            }),
          })
          .execute();

        return Number((revokeResult as { numUpdatedRows?: bigint })?.numUpdatedRows ?? 0n);
      });
    };

    // Retry once on PG unique_violation ('23505'): two concurrent saves race the
    // UPDATE+INSERT against peer_credentials_active_uniq; the loser's retry sees
    // the winner's committed row and revokes it before re-inserting.
    try {
      return { revokedCount: await runOnce() };
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
        return { revokedCount: await runOnce() };
      }
      throw err;
    }
  }

  /** Non-revoked, non-expired credential by hash. */
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

  /** Newest non-revoked, non-expired credential for the instance. */
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
   * The credential row for `instanceId` that nobody revoked, expired or not.
   * `peer_credentials_active_uniq` allows at most one.
   */
  async findUnrevokedByInstanceId(instanceId: string): Promise<PeerCredential | null> {
    const row = await this.db
      .selectFrom('peer_credentials' as any)
      .selectAll()
      .where('instance_id', '=', instanceId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    return row ? mapRow(row) : null;
  }

  /** The most recently revoked credential row for `instanceId`, or null. */
  async findLatestRevokedByInstanceId(instanceId: string): Promise<PeerCredential | null> {
    const row = await this.db
      .selectFrom('peer_credentials' as any)
      .selectAll()
      .where('instance_id', '=', instanceId)
      .where('revoked_at', 'is not', null)
      .orderBy('revoked_at', 'desc')
      // Two rows revoked in the same millisecond tie on revoked_at; the newer
      // credential is the one issued last.
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    return row ? mapRow(row) : null;
  }

  /**
   * Revoke `instanceId`'s unrevoked self-issued row with `credentialHash`,
   * recording who retired it. Every condition is in the WHERE clause, so a row
   * that changed meanwhile is left alone. Returns whether a row was retired.
   */
  async retireSelfIssued(opts: {
    instanceId: string;
    credentialHash: string;
    retiredByInstance: string;
  }): Promise<boolean> {
    const marker = JSON.stringify({ [RETIRED_BY_INSTANCE_KEY]: opts.retiredByInstance });
    const result = await this.db
      .updateTable('peer_credentials' as any)
      .set({
        revoked_at: new Date(),
        metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${marker}::jsonb`,
      })
      .where('instance_id', '=', opts.instanceId)
      .where('credential_hash', '=', opts.credentialHash)
      .where('revoked_at', 'is', null)
      .where(sql`metadata->>'issuance'`, '=', PeerCredentialIssuance.Self)
      .executeTakeFirst();

    return Number((result as { numUpdatedRows?: bigint })?.numUpdatedRows ?? 0n) > 0;
  }

  /** Bump last_seen_at; optionally record the validating coordinator. */
  async updateLastSeen(credentialHash: string, validatedBy?: string): Promise<void> {
    const updates: Record<string, unknown> = { last_seen_at: new Date() };
    if (validatedBy) updates.last_validated_by = validatedBy;

    await this.db
      .updateTable('peer_credentials' as any)
      .set(updates)
      .where('credential_hash', '=', credentialHash)
      .execute();
  }

  async revoke(instanceId: string): Promise<void> {
    await this.db
      .updateTable('peer_credentials' as any)
      .set({ revoked_at: new Date() })
      .where('instance_id', '=', instanceId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  /** @returns The number of credentials revoked. */
  async revokeAll(): Promise<number> {
    const result = await this.db
      .updateTable('peer_credentials' as any)
      .set({ revoked_at: new Date() })
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    return Number((result as any)?.numUpdatedRows ?? 0);
  }

  /** Non-revoked, non-expired credentials, oldest first. */
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
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

/** Write the credential file 0600, creating its parent directory 0700 if missing. */
export async function writeCredentialFile(
  filePath: string,
  data: CredentialFileData,
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const json = JSON.stringify(data, null, 2) + '\n';
  await writeFile(filePath, json, { mode: 0o600 });
  // writeFile's mode applies only on create.
  await chmod(filePath, 0o600);
}

/** @returns The parsed credential file, or null if it does not exist. */
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
 * A store bound to a Postgres URL plus a pool disposer, so tests exercise the real
 * store without importing pg/kysely. Test-only: production passes the
 * orchestrator's shared Kysely instance.
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
