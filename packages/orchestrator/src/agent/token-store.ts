/**
 * PSK agent tokens, static (CLI-created) and ephemeral (scaler-issued).
 * Format: kat_ + 64 hex chars (32 random bytes). Only the SHA-256 hash is
 * stored; the plaintext is returned once at generation time.
 */
import { randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { sha256 } from '@kici-dev/shared';
import type { Database, AgentTokenRow } from '../db/types.js';

const TOKEN_PREFIX = 'kat_';

/**
 * `created_by` prefix of single-use bootstrap (init-runner) tokens, stored as
 * `'<this prefix><targetAgentId>'` so the register-time identity binding
 * (agent-handler Gate 2) and the single-use consume check can resolve the
 * bound agent id.
 */
export const BOOTSTRAP_CREATED_BY_PREFIX = 'bootstrap:';

/**
 * Resolve the agent id an ephemeral token binds its holder to. Scaler tokens
 * store it verbatim in `created_by`; bootstrap tokens behind
 * `BOOTSTRAP_CREATED_BY_PREFIX`.
 */
export function boundAgentIdFromCreatedBy(createdBy: string): string {
  return createdBy.startsWith(BOOTSTRAP_CREATED_BY_PREFIX)
    ? createdBy.slice(BOOTSTRAP_CREATED_BY_PREFIX.length)
    : createdBy;
}

const TOKEN_BYTES = 32;

const hashToken = sha256;

function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('hex');
}

/** Token row returned from list/validate, without token_hash. */
export type SafeAgentTokenRow = Omit<AgentTokenRow, 'token_hash'>;

export class AgentTokenStore {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Create a static token: no expiry, for manually-registered agents.
   *
   * @param opts.labels - Agent labels this token is authorized for.
   * @param opts.mandatoryLabels - Kubernetes-taint-style gate: an agent
   *   registering with this token only accepts a job whose required labels
   *   include every label here. Undefined = no taint.
   * @param opts.createdBy - Creator identifier (e.g. "cli:admin").
   * @returns The plaintext token (shown once) and the DB row ID.
   */
  async createStatic(opts: {
    labels?: string[];
    mandatoryLabels?: string[];
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
        mandatory_labels: opts.mandatoryLabels ? JSON.stringify(opts.mandatoryLabels) : null,
        agent_type: 'static',
        created_by: opts.createdBy ?? null,
        expires_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return { token, id: row.id };
  }

  /**
   * Create an ephemeral token, issued by the scaler for an auto-provisioned
   * agent and expiring after `ttlMs`.
   *
   * @param agentId - Stored as created_by.
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
   * Mint a single-use, short-TTL bootstrap token for an init-runner bring-up,
   * bound to exactly the init-runner label set. Stored as `agent_type:
   * 'ephemeral'` so the expiry cleanup reaps it. `consumeBootstrapToken` sets
   * `consumed_at` on first `agent.register` and a second register is rejected,
   * so a leaked token is inert after enrollment AND after its TTL.
   *
   * @param targetAgentId - The agent id the init-runner will register as.
   * @param ttlMs - Short, ~10 min.
   * @returns The plaintext token (shown once) and the DB row ID.
   */
  async mintBootstrapToken(opts: {
    targetAgentId: string;
    ttlMs: number;
    labels: string[];
  }): Promise<{ token: string; id: string }> {
    const token = generateToken();
    const tokenHash = hashToken(token);
    const tokenPrefix = token.slice(0, 12);

    const row = await this.db
      .insertInto('agent_tokens')
      .values({
        token_hash: tokenHash,
        token_prefix: tokenPrefix,
        labels: JSON.stringify(opts.labels),
        agent_type: 'ephemeral',
        created_by: `${BOOTSTRAP_CREATED_BY_PREFIX}${opts.targetAgentId}`,
        expires_at: new Date(Date.now() + opts.ttlMs),
        consumed_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return { token, id: row.id };
  }

  /**
   * Consume a bootstrap token. Sets `consumed_at` only while null, so the first
   * register wins; returns true only when this call consumed it.
   */
  async consumeBootstrapToken(id: string): Promise<boolean> {
    const result = await this.db
      .updateTable('agent_tokens')
      .set({ consumed_at: sql`now()` })
      .where('id', '=', id)
      .where('consumed_at', 'is', null)
      .executeTakeFirst();
    return BigInt(result.numUpdatedRows) > 0n;
  }

  /**
   * Validate a plaintext token: exists, not revoked, not consumed, not expired.
   * On success, fires a non-blocking last_seen_at update.
   *
   * @returns The token row (without hash) if valid, null otherwise.
   */
  async validate(token: string): Promise<SafeAgentTokenRow | null> {
    const tokenHash = hashToken(token);

    const row = await this.db
      .selectFrom('agent_tokens')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .where('revoked_at', 'is', null)
      // A consumed bootstrap token never re-validates; other tokens keep
      // `consumed_at` null forever.
      .where('consumed_at', 'is', null)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]))
      .executeTakeFirst();

    if (!row) return null;

    this.db
      .updateTable('agent_tokens')
      .set({ last_seen_at: sql`now()` })
      .where('id', '=', row.id)
      .execute()
      .catch(() => {
        // Intentionally swallowed -- last_seen_at is best-effort
      });

    const { token_hash: _, ...safe } = row;
    return safe;
  }

  /** Revoke a token; false when it was already revoked or not found. */
  async revoke(id: string): Promise<boolean> {
    const result = await this.db
      .updateTable('agent_tokens')
      .set({ revoked_at: sql`now()` })
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    return BigInt(result.numUpdatedRows) > 0n;
  }

  /** List non-revoked tokens, newest first, without token_hash. */
  async list(opts?: { agentType?: string }): Promise<SafeAgentTokenRow[]> {
    let q = this.db
      .selectFrom('agent_tokens')
      .select([
        'id',
        'token_prefix',
        'labels',
        'mandatory_labels',
        'agent_type',
        'created_at',
        'last_seen_at',
        'created_by',
        'revoked_at',
        'expires_at',
        'consumed_at',
      ])
      .where('revoked_at', 'is', null);

    if (opts?.agentType) {
      q = q.where('agent_type', '=', opts.agentType);
    }

    q = q.orderBy('created_at', 'desc');

    return await q.execute();
  }

  /**
   * Delete expired ephemeral tokens. The orchestrator calls it every 60s so
   * the table cannot grow without bound.
   *
   * `onBeforeDelete` gets the expired ids once, **before** the DELETE; the
   * orchestrator calls `agentRegistry.disconnectByTokenId(id)` with each, so a
   * WS that outlived the per-token kick timer (e.g. a restart wiped the
   * in-memory `tokenExpiryTimers` map) is still kicked.
   *
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
