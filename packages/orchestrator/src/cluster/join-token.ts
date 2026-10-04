/**
 * Join tokens: creation, lookup and claim.
 *
 * Token format: kici_join_v1.<base64url(routing_json)>.<random_256bit_hex>
 * - Routing JSON: { orgId, routingKey, expiry, role }. A lookup key only: the
 *   row the token was stored as decides the role and routing a claim returns.
 * - Secret: 32 random bytes as hex. The database stores token_hash =
 *   SHA-256(secret), never the secret.
 *
 * A row is found by its hash (claimByHash, readByHash), or by its routing fields
 * plus a proof the caller checks against each candidate hash
 * (resolveLiveTokenByRouting).
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { OrchRole } from '@kici-dev/engine';
import { createLogger, sha256 } from '@kici-dev/shared';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { z } from 'zod';

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

export const TOKEN_ALREADY_USED_MESSAGE =
  'Join token has already been used. Create a new token with: kici-admin peer create-token';

export const TOKEN_EXPIRED_MESSAGE =
  'Join token has expired. Create a new token with: kici-admin peer create-token';

export const INVALID_JOIN_TOKEN_MESSAGE = 'Invalid join token';

/** Rows sharing one routing triple that a lookup will try; bounds HMAC work per request. */
export const JOIN_TOKEN_ROUTING_CANDIDATE_CAP = 16;

export type JoinTokenRole = OrchRole;

export interface TokenRouting {
  orgId: string;
  routingKey: string;
  expiry: number; // Unix epoch ms
  role: JoinTokenRole;
}

/** The routing fields a presented token claims. A lookup key only: the row decides. */
export type JoinRoutingClaim = Pick<TokenRouting, 'orgId' | 'routingKey' | 'expiry'>;

/** A consumed (or same-instance re-validated) join token, as the database records it. */
export interface ClaimedJoinToken {
  /** Hex SHA-256 of the token secret (`join_tokens.token_hash`). */
  tokenHash: string;
  /** From `routing_info`, never from the presented token. */
  routing: TokenRouting;
  /** From the `role` column. */
  role: JoinTokenRole;
}

export const ResolvedJoinTokenStatus = z.enum(['live', 'expired', 'unknown']);
export type ResolvedJoinTokenStatus = z.infer<typeof ResolvedJoinTokenStatus>;
export type ResolvedJoinToken =
  | { status: typeof ResolvedJoinTokenStatus.enum.live; tokenHash: string }
  | { status: typeof ResolvedJoinTokenStatus.enum.expired }
  | { status: typeof ResolvedJoinTokenStatus.enum.unknown };

const joinRoutingClaimSchema = z
  .object({ orgId: z.string().min(1), routingKey: z.string().min(1), expiry: z.number().finite() })
  .passthrough();

/** Read a `routing_info` value (object, or a JSON string) and the `role` column. */
function routingFromRow(
  routingInfo: unknown,
  role: unknown,
): { routing: TokenRouting; role: JoinTokenRole } {
  const raw = typeof routingInfo === 'string' ? JSON.parse(routingInfo) : routingInfo;
  const parsed = joinRoutingClaimSchema.parse(raw);
  const rowRole = OrchRole.parse(role);
  return {
    role: rowRole,
    routing: {
      orgId: parsed.orgId,
      routingKey: parsed.routingKey,
      expiry: parsed.expiry,
      role: rowRole,
    },
  };
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
    role?: JoinTokenRole;
    expiryMs?: number;
  }): Promise<string> {
    const expiryMs = opts.expiryMs ?? DEFAULT_EXPIRY_MS;
    // Whole milliseconds: the routing lookup compares expiry as text, so a
    // fractional --expiry-hours never reaches the stored routing.
    const expiry = Date.now() + Math.floor(expiryMs);
    const role = opts.role ?? OrchRole.enum.coordinator;

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

    await this.deps.db
      .insertInto('join_tokens' as any)
      .values({
        id: randomUUID(),
        token_hash: tokenHashOf(secretHex),
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
   * Peer token mode: claim the row the presented token's secret hashes to. Role and
   * routing come from the row (`claimByHash`), never from the token's routing part.
   *
   * Self-healing reuse: a join token is re-consumable by the same joining peer
   * (`peerInstanceId`) until its `expires_at`. A peer that lost its credential
   * re-presents the still-valid join token already in its env, and the coordinator
   * issues a fresh credential without an operator action. Reuse is bounded by both
   * `expires_at` and the consuming instanceId, so it never widens a leaked token's
   * usefulness beyond the instance that first consumed it.
   */
  async validateAndConsumeToken(
    token: string,
    consumedBy: string,
    peerInstanceId: string,
  ): Promise<ClaimedJoinToken> {
    return this.claimByHash(tokenHashOf(parseToken(token).secretHex), consumedBy, peerInstanceId);
  }

  /**
   * Find the row whose proof the caller accepts, among rows whose routing matches
   * the claimed routing. Consumption state is not checked here; `claimByHash` owns it.
   * At most JOIN_TOKEN_ROUTING_CANDIDATE_CAP rows, newest first, are offered.
   */
  async resolveLiveTokenByRouting(
    claimed: JoinRoutingClaim,
    accepts: (tokenHash: string) => boolean,
  ): Promise<ResolvedJoinToken> {
    const rows = (await this.deps.db
      .selectFrom('join_tokens' as any)
      .select(['token_hash', 'expires_at'] as any)
      // Compared as text, so one malformed row cannot fail a cast for the whole query.
      .where(sql`routing_info->>'orgId'`, '=', claimed.orgId)
      .where(sql`routing_info->>'routingKey'`, '=', claimed.routingKey)
      .where(sql`routing_info->>'expiry'`, '=', String(claimed.expiry))
      .orderBy('created_at' as any, 'desc')
      .limit(JOIN_TOKEN_ROUTING_CANDIDATE_CAP)
      .execute()) as Array<{ token_hash: string; expires_at: Date | string }>;

    for (const row of rows) {
      if (!accepts(row.token_hash)) continue;
      return new Date(row.expires_at).getTime() > Date.now()
        ? { status: ResolvedJoinTokenStatus.enum.live, tokenHash: row.token_hash }
        : { status: ResolvedJoinTokenStatus.enum.expired };
    }
    return { status: ResolvedJoinTokenStatus.enum.unknown };
  }

  /**
   * Atomically consume the row with this hash, or re-validate it for the instance
   * that consumed it (self-healing reuse, bounded by expires_at). Routing and role
   * come from the row.
   *
   * One UPDATE ... WHERE consumed_at IS NULL wins the claim across a shared-DB
   * multi-coordinator mesh; every other concurrent caller gets
   * TOKEN_ALREADY_USED_MESSAGE, the message peer-handler's idempotent retry keys on.
   * On a 0-row claim, a follow-up SELECT tells not-found, expired, already-used and
   * reusable-by-the-same-instance apart.
   */
  async claimByHash(
    tokenHash: string,
    consumedBy: string,
    consumerInstanceId: string,
  ): Promise<ClaimedJoinToken> {
    const claimed = (await this.deps.db
      .updateTable('join_tokens' as any)
      .set({
        consumed_at: new Date(),
        consumed_by: consumedBy,
        consumed_by_instance: consumerInstanceId,
      })
      .where('token_hash', '=', tokenHash)
      .where('consumed_at', 'is', null)
      .where('expires_at', '>', new Date())
      .returning(['routing_info', 'role'] as any)
      .executeTakeFirst()) as { routing_info: unknown; role: unknown } | undefined;

    if (claimed) {
      joinTokenLogger.info('Consumed join token', {
        consumedBy,
        consumerInstanceId,
        tokenFingerprint: tokenFingerprint(tokenHash),
      });
      return { tokenHash, ...routingFromRow(claimed.routing_info, claimed.role) };
    }

    const row = (await this.deps.db
      .selectFrom('join_tokens' as any)
      .select(['routing_info', 'role', 'expires_at', 'consumed_at', 'consumed_by_instance'] as any)
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst()) as
      | {
          routing_info: unknown;
          role: unknown;
          expires_at: Date | string;
          consumed_at: Date | null;
          consumed_by_instance: string | null;
        }
      | undefined;

    if (!row) throw new Error(INVALID_JOIN_TOKEN_MESSAGE);
    // Expiry first, so an expired-and-consumed token gets the expiry message for anyone.
    if (new Date(row.expires_at).getTime() <= Date.now()) throw new Error(TOKEN_EXPIRED_MESSAGE);
    if (row.consumed_at) {
      if (row.consumed_by_instance === consumerInstanceId) {
        joinTokenLogger.info('Re-validated join token for returning instance', {
          consumedBy,
          consumerInstanceId,
          tokenFingerprint: tokenFingerprint(tokenHash),
        });
        return { tokenHash, ...routingFromRow(row.routing_info, row.role) };
      }
      throw new Error(TOKEN_ALREADY_USED_MESSAGE);
    }
    // Unconsumed, yet the claim failed: lost an expiry race between the UPDATE and this SELECT.
    throw new Error(INVALID_JOIN_TOKEN_MESSAGE);
  }

  /** Role and routing of the row with this hash, or null. */
  async readByHash(
    tokenHash: string,
  ): Promise<{ routing: TokenRouting; role: JoinTokenRole } | null> {
    const row = (await this.deps.db
      .selectFrom('join_tokens' as any)
      .select(['routing_info', 'role'] as any)
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst()) as { routing_info: unknown; role: unknown } | undefined;
    return row ? routingFromRow(row.routing_info, row.role) : null;
  }
}

/**
 * Build a JoinTokenManager backed by its own connection pool to the given
 * orchestrator database URL. Mirrors `createPeerCredentialStoreFromUrl`;
 * used by tests that need to exercise token validation/reuse against a real
 * cluster DB.
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

// --- Pure functions ---

/**
 * Parse a join token string into routing info and secret hex.
 */
export function parseToken(token: string): {
  routing: TokenRouting;
  routingB64: string;
  secretHex: string;
} {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    throw new Error(`Invalid join token format. Expected: ${TOKEN_PREFIX}.<routing>.<secret>`);
  }

  const routingJson = Buffer.from(parts[1], 'base64url').toString('utf-8');
  const routing = JSON.parse(routingJson) as TokenRouting;

  if (!routing.orgId || !routing.routingKey || !routing.expiry) {
    throw new Error('Invalid join token routing data');
  }

  return { routing, routingB64: parts[1], secretHex: parts[2] };
}

/** Hex SHA-256 of a token secret: the value `join_tokens.token_hash` stores. */
export function tokenHashOf(secretHex: string): string {
  return sha256(Buffer.from(secretHex, 'hex'));
}

/** A log-safe tag for a token hash. Never log the hash itself: it is the join key root. */
export function tokenFingerprint(tokenHash: string): string {
  return sha256(`kici-join-log:${tokenHash}`).slice(0, 12);
}

/** Decode the base64url routing part of a token into its lookup fields. */
export function decodeJoinRouting(routingB64: string): JoinRoutingClaim {
  const json = Buffer.from(routingB64, 'base64url').toString('utf-8');
  const parsed = joinRoutingClaimSchema.parse(JSON.parse(json));
  return { orgId: parsed.orgId, routingKey: parsed.routingKey, expiry: parsed.expiry };
}
