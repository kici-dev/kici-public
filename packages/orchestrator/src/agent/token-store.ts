/**
 * Agent token store for PSK-based agent authentication.
 *
 * Handles SHA-256 hashed token storage, validation, revocation,
 * and cleanup for both static (CLI-created) and ephemeral (scaler-issued) tokens.
 *
 * Token format: kat_ + 64 hex chars (32 random bytes).
 * Only the SHA-256 hash is stored; plaintext is returned once at generation time.
 */
import { randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { sha256 } from '@kici-dev/shared';
import type { Database, AgentTokenRow } from '../db/types.js';

/** Token prefix for KiCI Agent Tokens */
const TOKEN_PREFIX = 'kat_';

/** Number of random bytes for token generation */
const TOKEN_BYTES = 32;

/** Hash a plaintext token with SHA-256 for storage. */
const hashToken = sha256;

/**
 * Generate a new agent token (prefix + random hex).
 */
function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Safe token row shape returned from list/validate (excludes token_hash).
 */
export type SafeAgentTokenRow = Omit<AgentTokenRow, 'token_hash'>;

/**
 * Manages agent authentication tokens.
 *
 * Tokens are kat_ + 64 hex chars (32 random bytes = 256 bits).
 * Only the SHA-256 hash is stored; the plaintext is returned once at generation time.
 */
export class AgentTokenStore {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Create a static (long-lived) agent token.
   *
   * Static tokens have no expiry and are intended for manually-registered agents.
   *
   * @param opts.labels - Optional agent labels this token is authorized for.
   * @param opts.createdBy - Optional creator identifier (e.g. "cli:admin").
   * @returns The plaintext token (shown once) and the DB row ID.
   */
  async createStatic(opts: {
    labels?: string[];
    createdBy?: string;
  }): Promise<{ token: string; id: string }> {
    const token = generateToken();
    const tokenHash = hashToken(token);
    const tokenPrefix = token.slice(0, 12); // kat_ + first 8 hex chars

    const row = await this.db
      .insertInto('agent_tokens')
      .values({
        token_hash: tokenHash,
        token_prefix: tokenPrefix,
        labels: opts.labels ? JSON.stringify(opts.labels) : null,
        agent_type: 'static',
        created_by: opts.createdBy ?? null,
        expires_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return { token, id: row.id };
  }

  /**
   * Create an ephemeral (short-lived) agent token.
   *
   * Ephemeral tokens are issued by the scaler for auto-provisioned agents
   * and expire after the specified TTL.
   *
   * @param agentId - The agent ID this token is for (used as created_by).
   * @param labels - Agent labels this token is authorized for.
   * @param ttlMs - Time-to-live in milliseconds.
   * @returns The plaintext token (shown once).
   */
  async createEphemeral(agentId: string, labels: string[], ttlMs: number): Promise<string> {
    const token = generateToken();
    const tokenHash = hashToken(token);
    const tokenPrefix = token.slice(0, 12);

    await this.db
      .insertInto('agent_tokens')
      .values({
        token_hash: tokenHash,
        token_prefix: tokenPrefix,
        labels: JSON.stringify(labels),
        agent_type: 'ephemeral',
        created_by: agentId,
        expires_at: new Date(Date.now() + ttlMs),
      })
      .execute();

    return token;
  }

  /**
   * Validate a plaintext token against stored hashes.
   *
   * Checks that the token exists, is not revoked, and has not expired.
   * On success, fires a non-blocking update to last_seen_at.
   *
   * @param token - The plaintext token to validate.
   * @returns The token row (without hash) if valid, null otherwise.
   */
  async validate(token: string): Promise<SafeAgentTokenRow | null> {
    const tokenHash = hashToken(token);

    const row = await this.db
      .selectFrom('agent_tokens')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .where('revoked_at', 'is', null)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]))
      .executeTakeFirst();

    if (!row) return null;

    // Fire-and-forget last_seen_at update
    this.db
      .updateTable('agent_tokens')
      .set({ last_seen_at: sql`now()` })
      .where('id', '=', row.id)
      .execute()
      .catch(() => {
        // Intentionally swallowed -- last_seen_at is best-effort
      });

    // Return row without token_hash
    const { token_hash: _, ...safe } = row;
    return safe;
  }

  /**
   * Revoke a token by ID.
   *
   * Sets revoked_at to now. Returns true if the token was revoked,
   * false if it was already revoked or not found.
   *
   * @param id - The token row ID to revoke.
   * @returns True if the token was newly revoked.
   */
  async revoke(id: string): Promise<boolean> {
    const result = await this.db
      .updateTable('agent_tokens')
      .set({ revoked_at: sql`now()` })
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    return BigInt(result.numUpdatedRows) > 0n;
  }

  /**
   * List all non-revoked tokens (excludes token_hash for security).
   *
   * @param opts.agentType - Optional filter by agent type ('static' | 'ephemeral').
   * @returns Array of token rows without the hash field.
   */
  async list(opts?: { agentType?: string }): Promise<SafeAgentTokenRow[]> {
    let q = this.db
      .selectFrom('agent_tokens')
      .select([
        'id',
        'token_prefix',
        'labels',
        'agent_type',
        'created_at',
        'last_seen_at',
        'created_by',
        'revoked_at',
        'expires_at',
      ])
      .where('revoked_at', 'is', null);

    if (opts?.agentType) {
      q = q.where('agent_type', '=', opts.agentType);
    }

    q = q.orderBy('created_at', 'desc');

    return await q.execute();
  }

  /**
   * Clean up expired ephemeral tokens.
   *
   * Deletes rows where `expires_at < now()` and `agent_type = 'ephemeral'`.
   * Called periodically by the orchestrator (every 60s) to keep the
   * table from growing without bound.
   *
   * Optional `onBeforeDelete` callback is invoked once with the list
   * of expired token IDs **before** the DELETE runs. The orchestrator
   * uses this to call `agentRegistry.disconnectByTokenId(id)` for
   * each expired row, so any in-flight WS that survived the
   * per-token kick timer (e.g. across a process restart that wiped
   * the in-memory `tokenExpiryTimers` map) is still kicked. Closes
   * the sister gap to the revocation finding.
   *
   * @param opts.onBeforeDelete - Optional sync/async callback invoked
   *   with expired token IDs before the DELETE.
   * @returns Number of deleted rows.
   */
  async cleanupExpired(opts?: {
    onBeforeDelete?: (tokenIds: string[]) => void | Promise<void>;
  }): Promise<number> {
    const expired = await this.db
      .selectFrom('agent_tokens')
      .select('id')
      .where('agent_type', '=', 'ephemeral')
      .where('expires_at', '<', sql<Date>`now()`)
      .execute();

    if (expired.length === 0) return 0;

    if (opts?.onBeforeDelete !== undefined) {
      await opts.onBeforeDelete(expired.map((row) => row.id));
    }

    const result = await this.db
      .deleteFrom('agent_tokens')
      .where('agent_type', '=', 'ephemeral')
      .where('expires_at', '<', sql<Date>`now()`)
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  }
}
