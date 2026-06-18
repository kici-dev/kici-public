/**
 * Admin API token manager for secrets management.
 *
 * Handles SHA-256 hashed token storage, validation, revocation,
 * and bootstrap token generation for initial setup.
 *
 * Tokens are stored as SHA-256 hashes -- plaintext is only ever
 * returned at generation time and never persisted.
 */
import { randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { sha256 } from '@kici-dev/shared';
import type { Database, AdminTokenRow } from '../db/types.js';
import type { Role } from './rbac.js';

/** Hash a plaintext token with SHA-256 for storage. */
const hashToken = sha256;

/**
 * Manages admin API tokens for the secrets management system.
 *
 * Tokens are 32-byte random hex strings (64 chars). Only the SHA-256
 * hash is stored; the plaintext is returned once at generation time.
 */
export class TokenManager {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Generate a new admin API token.
   *
   * @param label - Human-readable label for this token.
   * @param role - Role to assign (owner, admin, auditor).
   * @param routingKey - Optional routing key scope (null = all).
   * @returns The plaintext token (shown once) and the row ID.
   */
  async generateToken(
    label: string,
    role: Role,
    routingKey?: string | null,
  ): Promise<{ token: string; id: string }> {
    const token = randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);

    const row = await this.db
      .insertInto('admin_tokens')
      .values({
        token_hash: tokenHash,
        label,
        role,
        routing_key: routingKey ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return { token, id: row.id };
  }

  /**
   * Validate a plaintext token against stored hashes.
   *
   * @param token - The plaintext token to validate.
   * @returns Token info if valid, null if invalid/expired/revoked.
   */
  async validate(
    token: string,
  ): Promise<{ id: string; role: Role; routingKey: string | null; label: string } | null> {
    const tokenHash = hashToken(token);

    const row = await this.db
      .selectFrom('admin_tokens')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .where('revoked', '=', false)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]))
      .executeTakeFirst();

    if (!row) return null;

    // Update last_used_at
    await this.db
      .updateTable('admin_tokens')
      .set({ last_used_at: sql`now()` })
      .where('id', '=', row.id)
      .execute();

    return {
      id: row.id,
      role: row.role as Role,
      routingKey: row.routing_key,
      label: row.label,
    };
  }

  /**
   * Revoke a token by ID.
   */
  async revokeToken(tokenId: string): Promise<void> {
    await this.db
      .updateTable('admin_tokens')
      .set({ revoked: true })
      .where('id', '=', tokenId)
      .execute();
  }

  /**
   * List all tokens (excluding hash for security).
   *
   * @param routingKey - Optional filter by routing key.
   */
  async listTokens(routingKey?: string | null): Promise<Omit<AdminTokenRow, 'token_hash'>[]> {
    let q = this.db
      .selectFrom('admin_tokens')
      .select([
        'id',
        'label',
        'role',
        'routing_key',
        'created_at',
        'expires_at',
        'last_used_at',
        'revoked',
      ]);

    if (routingKey !== undefined && routingKey !== null) {
      q = q.where('routing_key', '=', routingKey);
    }

    q = q.orderBy('created_at', 'desc');

    return await q.execute();
  }

  /**
   * Ensure a bootstrap admin token exists.
   *
   * If KICI_BOOTSTRAP_ADMIN_TOKEN env var (or envOverride) is set,
   * use that as the plaintext, hash, and upsert with label='bootstrap', role='owner'.
   *
   * If no env var and no non-revoked tokens exist, generate a new owner
   * token and return the plaintext for logging.
   *
   * If tokens already exist, return null (no bootstrap needed).
   *
   * @param envOverride - Override for KICI_BOOTSTRAP_ADMIN_TOKEN env var.
   * @returns Plaintext token if generated/created, null if not needed.
   */
  async ensureBootstrapToken(envOverride?: string): Promise<string | null> {
    const envToken = envOverride ?? process.env.KICI_BOOTSTRAP_ADMIN_TOKEN;

    if (envToken) {
      const tokenHash = hashToken(envToken);

      // Check if bootstrap token already exists, update hash or insert
      const existing = await this.db
        .selectFrom('admin_tokens')
        .select('id')
        .where('label', '=', 'bootstrap')
        .executeTakeFirst();

      if (existing) {
        await this.db
          .updateTable('admin_tokens')
          .set({ token_hash: tokenHash, role: 'owner' })
          .where('label', '=', 'bootstrap')
          .execute();
      } else {
        await this.db
          .insertInto('admin_tokens')
          .values({
            token_hash: tokenHash,
            label: 'bootstrap',
            role: 'owner',
            routing_key: null,
          })
          .execute();
      }

      return envToken;
    }

    // Check if any non-revoked tokens exist
    const existing = await this.db
      .selectFrom('admin_tokens')
      .select('id')
      .where('revoked', '=', false)
      .executeTakeFirst();

    if (existing) {
      // Tokens already exist, no bootstrap needed
      return null;
    }

    // No tokens at all -- generate a bootstrap token
    const { token } = await this.generateToken('bootstrap', 'owner', null);
    return token;
  }
}
