/**
 * In-memory agent token store for worker nodes.
 *
 * Workers have no database access. This implementation stores token
 * hashes in memory and supports both static (long-lived) and ephemeral
 * (TTL-based) tokens with the same kat_ prefix format as the DB-backed
 * AgentTokenStore.
 *
 * Token format: kat_ + 64 hex chars (32 random bytes = 256 bits).
 * Only the SHA-256 hash is stored; plaintext is returned once at creation.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { sha256 } from '@kici-dev/shared';

/** Token prefix for KiCI Agent Tokens. */
const TOKEN_PREFIX = 'kat_';

/** Number of random bytes for token generation. */
const TOKEN_BYTES = 32;

/** Generate a new agent token (prefix + random hex). */
function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('hex');
}

/** Internal token record. */
interface TokenRecord {
  id: string;
  tokenHash: string;
  tokenPrefix: string;
  agent_type: 'static' | 'ephemeral';
  labels: string[] | null;
  createdBy: string | null;
  expiresAt: number | null;
  revokedAt: number | null;
}

/** Safe token info returned from validate (matches SafeAgentTokenRow shape). */
interface SafeTokenInfo {
  id: string;
  token_prefix: string;
  labels: string | null;
  agent_type: string;
  created_by: string | null;
  expires_at: Date | null;
  revoked_at: null;
}

export class StaticAgentTokenStore {
  private readonly tokens = new Map<string, TokenRecord>();

  /**
   * Create a static (long-lived) agent token.
   */
  async createStatic(opts: {
    labels?: string[];
    createdBy?: string;
  }): Promise<{ token: string; id: string }> {
    const token = generateToken();
    const tokenHash = sha256(token);
    const id = randomUUID();

    this.tokens.set(id, {
      id,
      tokenHash,
      tokenPrefix: token.slice(0, 12),
      agent_type: 'static',
      labels: opts.labels ?? null,
      createdBy: opts.createdBy ?? null,
      expiresAt: null,
      revokedAt: null,
    });

    return { token, id };
  }

  /**
   * Create an ephemeral (short-lived) agent token.
   */
  async createEphemeral(agentId: string, labels: string[], ttlMs: number): Promise<string> {
    const token = generateToken();
    const tokenHash = sha256(token);
    const id = randomUUID();

    this.tokens.set(id, {
      id,
      tokenHash,
      tokenPrefix: token.slice(0, 12),
      agent_type: 'ephemeral',
      labels,
      createdBy: agentId,
      expiresAt: Date.now() + ttlMs,
      revokedAt: null,
    });

    return token;
  }

  /**
   * Validate a plaintext token.
   *
   * Returns token info if valid, null if unknown/revoked/expired.
   */
  async validate(token: string): Promise<SafeTokenInfo | null> {
    const tokenHash = sha256(token);

    for (const record of this.tokens.values()) {
      if (record.tokenHash !== tokenHash) continue;
      if (record.revokedAt !== null) return null;
      if (record.expiresAt !== null && record.expiresAt <= Date.now()) return null;

      return {
        id: record.id,
        token_prefix: record.tokenPrefix,
        labels: record.labels ? JSON.stringify(record.labels) : null,
        agent_type: record.agent_type,
        created_by: record.createdBy,
        expires_at: record.expiresAt ? new Date(record.expiresAt) : null,
        revoked_at: null,
      };
    }

    return null;
  }

  /**
   * Revoke a token by ID.
   *
   * @returns true if newly revoked, false if not found or already revoked.
   */
  async revoke(id: string): Promise<boolean> {
    const record = this.tokens.get(id);
    if (!record || record.revokedAt !== null) return false;
    record.revokedAt = Date.now();
    return true;
  }

  /**
   * Clean up expired ephemeral tokens.
   *
   * @returns Number of removed tokens.
   */
  async cleanupExpired(): Promise<number> {
    const now = Date.now();
    let count = 0;

    for (const [id, record] of this.tokens) {
      if (
        record.agent_type === 'ephemeral' &&
        record.expiresAt !== null &&
        record.expiresAt <= now
      ) {
        this.tokens.delete(id);
        count++;
      }
    }

    return count;
  }
}
