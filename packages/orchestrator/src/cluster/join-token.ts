/**
 * Join token manager for zero-knowledge cluster bootstrap.
 *
 * Token format: kici_join_v1.<base64url(routing_json)>.<random_256bit_hex>
 * - Routing JSON: { orgId, routingKey, expiry } (cleartext for Platform relay routing)
 * - Secret: 32 random bytes as hex (used for key derivation)
 *
 * Key derivation:
 * - encryption_key = HKDF-SHA256(secret, salt="kici-join-encrypt", info="v1", length=32)
 * - validation_hash = SHA-256(secret) (stored in DB for lookup)
 *
 * Config bundle encryption: AES-256-GCM with random 12-byte IV.
 * Wire format: <12-byte IV><16-byte auth tag><ciphertext>
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';

import { createLogger, sha256 } from '@kici-dev/shared';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

const joinTokenLogger = createLogger({ prefix: 'join-token' });

/**
 * Silence the module-level logger (e.g. when a CLI is emitting JSON on stdout
 * and a stray log line would break the contract).
 */
export function silenceJoinTokenLogger(): void {
  joinTokenLogger.silent = true;
}

const TOKEN_PREFIX = 'kici_join_v1';
const DEFAULT_EXPIRY_MS = 3600_000; // 1 hour

const TOKEN_ALREADY_USED_MESSAGE =
  'Join token has already been used. Generate a new token with: kici admin create-join-token';

interface TokenRouting {
  orgId: string;
  routingKey: string;
  expiry: number; // Unix epoch ms
  role: 'coordinator' | 'worker';
}

interface DerivedKeys {
  encryptionKey: Buffer; // 32 bytes for AES-256-GCM
  validationHash: string; // SHA-256 hex of secret
}

interface JoinTokenManagerDeps {
  db: Kysely<any>;
}

export class JoinTokenManager {
  constructor(private readonly deps: JoinTokenManagerDeps) {}

  /**
   * Create a new join token.
   * Returns the full token string (only available at creation time).
   */
  async createToken(opts: {
    orgId: string;
    routingKey: string;
    createdBy: string;
    role?: 'coordinator' | 'worker';
    expiryMs?: number;
  }): Promise<string> {
    const expiryMs = opts.expiryMs ?? DEFAULT_EXPIRY_MS;
    const expiry = Date.now() + expiryMs;
    const role = opts.role ?? 'coordinator';

    const routing: TokenRouting = {
      orgId: opts.orgId,
      routingKey: opts.routingKey,
      expiry,
      role,
    };

    const secret = randomBytes(32);
    const routingB64 = Buffer.from(JSON.stringify(routing)).toString('base64url');
    const secretHex = secret.toString('hex');
    const token = `${TOKEN_PREFIX}.${routingB64}.${secretHex}`;

    // Store hash in DB
    const { validationHash } = deriveKeys(secret);
    await this.deps.db
      .insertInto('join_tokens' as any)
      .values({
        id: randomUUID(),
        token_hash: validationHash,
        routing_info: JSON.stringify(routing),
        role,
        created_by: opts.createdBy,
        expires_at: new Date(expiry),
      })
      .execute();

    joinTokenLogger.info('Created join token', {
      orgId: opts.orgId,
      routingKey: opts.routingKey,
    });
    return token;
  }

  /**
   * Atomically validate and consume a token in one DB round-trip.
   *
   * Single UPDATE with `WHERE token_hash = ? AND consumed_at IS NULL AND
   * expires_at > NOW()` — only one caller can win the claim across a
   * shared-DB multi-coordinator mesh. The winner gets `{ routing, keys }`;
   * every other concurrent caller gets `TOKEN_ALREADY_USED_MESSAGE` and is
   * expected to fall into the idempotent recovery branch in
   * `peer-handler.ts` (which serialises credential issuance via the
   * `peer_credentials_active_uniq` partial unique index).
   *
   * On a 0-row claim, a follow-up SELECT disambiguates not-found / expired
   * / already-used / reusable-by-same-instance so callers can branch on the
   * specific reason — the recovery path in peer-handler.ts keys on the
   * "already used" string specifically. The follow-up only fires on the
   * unhappy path.
   *
   * Self-healing reuse: a join token is re-consumable by the same joining
   * peer (`peerInstanceId`) until its `expires_at`. A peer that lost its
   * credential (transient outage / deleted credential file) re-presents the
   * still-valid join token already in its env; the coordinator accepts the
   * reuse and issues a fresh credential — no operator action, no cluster
   * redeploy. Reuse is bounded by BOTH `expires_at` AND the consuming
   * instanceId, so it never widens a leaked token's usefulness beyond the
   * instance that first consumed it.
   */
  async validateAndConsumeToken(
    token: string,
    consumedBy: string,
    peerInstanceId: string,
  ): Promise<{ routing: TokenRouting; keys: DerivedKeys }> {
    const parsed = parseToken(token);
    const keys = deriveKeys(Buffer.from(parsed.secretHex, 'hex'));

    const updateResult = await this.deps.db
      .updateTable('join_tokens' as any)
      .set({
        consumed_at: new Date(),
        consumed_by: consumedBy,
        consumed_by_instance: peerInstanceId,
      })
      .where('token_hash', '=', keys.validationHash)
      .where('consumed_at', 'is', null)
      .where('expires_at', '>', new Date())
      .executeTakeFirst();

    if (Number((updateResult as { numUpdatedRows?: bigint })?.numUpdatedRows ?? 0n) > 0) {
      joinTokenLogger.info('Consumed join token', { consumedBy, peerInstanceId });
      return { routing: parsed.routing, keys };
    }

    // Atomic claim returned 0 rows. Disambiguate so the caller sees the
    // same error vocabulary as the prior two-step path.
    const row = await this.deps.db
      .selectFrom('join_tokens' as any)
      .selectAll()
      .where('token_hash', '=', keys.validationHash)
      .executeTakeFirst();

    if (!row) {
      throw new Error('Invalid join token');
    }

    // Expired is checked before the consumed/reuse branch so an
    // expired-and-consumed token is rejected with the expiry message
    // regardless of which instance presents it.
    const expired = new Date((row as any).expires_at).getTime() <= Date.now();
    if (expired) {
      throw new Error(
        'Join token has expired. Generate a new token with: kici admin create-join-token',
      );
    }

    if ((row as any).consumed_at) {
      // Reuse path: a returning peer that lost its credential re-presents its
      // still-valid join token. Allow it iff the SAME instance is presenting
      // it — bounded by expires_at — so the peer self-heals without a redeploy.
      if ((row as any).consumed_by_instance === peerInstanceId) {
        joinTokenLogger.info('Re-validated join token for returning instance', {
          consumedBy,
          peerInstanceId,
        });
        return { routing: parsed.routing, keys };
      }
      throw new Error(TOKEN_ALREADY_USED_MESSAGE);
    }

    // Unconsumed but the atomic claim still failed (e.g. lost an expiry race
    // between the UPDATE and this SELECT) — treat as invalid.
    throw new Error('Invalid join token');
  }
}

/**
 * Build a JoinTokenManager backed by its own connection pool to the given
 * orchestrator database URL. Mirrors `createPeerCredentialStoreFromUrl`;
 * consumed by E2E tests that need to exercise token validation/reuse against
 * the real cluster DB.
 */
export function createJoinTokenManagerFromUrl(
  databaseUrl: string,
  opts?: { maxConnections?: number },
): { manager: JoinTokenManager; dispose: () => Promise<void> } {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: opts?.maxConnections ?? 3 });
  const db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
  const manager = new JoinTokenManager({ db });
  return {
    manager,
    dispose: async () => {
      await db.destroy();
    },
  };
}

/**
 * Narrow detector for the "already been used" error thrown by
 * validateAndConsumeToken(). Used by peer-handler.ts to branch into the
 * idempotent recovery path on legitimate mesh-join races (sibling
 * peer-clients on the same peer identity racing on a shared join token
 * across a multi-coordinator shared-DB mesh). Other validation failures
 * (expired, not found, bad parse) MUST NOT be treated as recoverable.
 */
export function isTokenAlreadyUsedError(err: unknown): boolean {
  return err instanceof Error && err.message === TOKEN_ALREADY_USED_MESSAGE;
}

// --- Pure functions (exported for testing) ---

/**
 * Parse a join token string into routing info and secret hex.
 */
export function parseToken(token: string): { routing: TokenRouting; secretHex: string } {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    throw new Error(`Invalid join token format. Expected: ${TOKEN_PREFIX}.<routing>.<secret>`);
  }

  const routingJson = Buffer.from(parts[1], 'base64url').toString('utf-8');
  const routing = JSON.parse(routingJson) as TokenRouting;

  if (!routing.orgId || !routing.routingKey || !routing.expiry) {
    throw new Error('Invalid join token routing data');
  }

  return { routing, secretHex: parts[2] };
}

/**
 * Derive encryption key and validation hash from a token secret.
 * - encryptionKey: HKDF-SHA256 with salt="kici-join-encrypt", info="v1"
 * - validationHash: SHA-256 of secret (stored in DB for lookup)
 */
export function deriveKeys(secret: Buffer): DerivedKeys {
  // Validation hash: simple SHA-256 of secret (stored in DB for lookup)
  const validationHash = sha256(secret);

  // Encryption key: HKDF-SHA256 with salt and info context
  const derived = hkdfSync(
    'sha256',
    secret,
    Buffer.from('kici-join-encrypt'),
    Buffer.from('v1'),
    32,
  );

  return { encryptionKey: Buffer.from(derived), validationHash };
}

/**
 * Encrypt a config bundle with the derived encryption key.
 * Format: <12-byte IV><16-byte auth tag><ciphertext>
 */
export function encryptBundle(plaintext: object, encryptionKey: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);

  const json = JSON.stringify(plaintext);
  const encrypted = Buffer.concat([cipher.update(json, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypt a config bundle with the derived encryption key.
 * Expects format: <12-byte IV><16-byte auth tag><ciphertext>
 */
export function decryptBundle(data: Buffer, encryptionKey: Buffer): object {
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);

  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf-8'));
}
