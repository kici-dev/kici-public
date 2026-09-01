/**
 * In-memory stand-in for the `scaler_pending_claims` half of `ScalerStateStore`.
 *
 * It reproduces the three properties the real table enforces in SQL — a claim
 * is consumable exactly once, a consume past `expires_at` finds nothing, and a
 * per-agent invalidation removes every row for that agent — against an injected
 * clock. That lets a test drive the whole register → redeem round trip without a
 * database, so the single-use and TTL properties are executed rather than
 * hand-fed through a stubbed answer.
 *
 * Only the pending-claim methods are implemented. Reaching any other
 * `ScalerStateStore` method is a `TypeError` at the call site, not a silent
 * no-op.
 */

import type { PendingClaimRow, ScalerStateStore } from '../scaler/scaler-state-store.js';

/** A row of the fake table, plus the consumption bit the real column carries. */
interface FakeClaimRow {
  row: PendingClaimRow;
  consumed: boolean;
}

/**
 * Build an in-memory pending-claim store.
 *
 * @param now Clock (epoch ms) the TTL is evaluated against. Pass the same clock
 *   the `ClaimStore` under test uses, or its `expiresAt` lands in a different
 *   era than this store's `now()` and every redeem reads as expired.
 */
export function makeFakeScalerStateStore(now: () => number = () => Date.now()): ScalerStateStore {
  const rows = new Map<string, FakeClaimRow>();

  const fake = {
    registerClaim: async (row: PendingClaimRow): Promise<void> => {
      rows.set(row.claimHash, { row, consumed: false });
    },

    redeemClaim: async (claimHash: string) => {
      const entry = rows.get(claimHash);
      if (!entry || entry.consumed || entry.row.expiresAt.getTime() <= now()) return null;
      entry.consumed = true;
      return {
        agentId: entry.row.agentId,
        labels: entry.row.labels,
        agentTokenTtlMs: entry.row.agentTokenTtlMs,
        orchestratorUrl: entry.row.orchestratorUrl,
      };
    },

    describeClaim: async (claimHash: string) => {
      const entry = rows.get(claimHash);
      if (!entry) return null;
      return { consumed: entry.consumed, expired: entry.row.expiresAt.getTime() <= now() };
    },

    invalidateClaimsForAgent: async (agentId: string): Promise<void> => {
      for (const [claimHash, entry] of rows) {
        if (entry.row.agentId === agentId) rows.delete(claimHash);
      }
    },
  };

  return fake as unknown as ScalerStateStore;
}
