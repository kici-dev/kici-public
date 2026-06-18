/**
 * Per-orchestrator policy controlling which dashboard.* write operations
 * the orch accepts from Platform.
 *
 * Storage: a JSONB column on the existing `org_settings` table, keyed by
 * `customer_id`. Empty object means every operation is enabled
 * (permissive default at first-boot). Operators flip individual
 * operations off via `kici-admin org-settings dashboard-writes set`.
 *
 * Three callers:
 *   - The kici-admin CLI mutates via `setDashboardWritePolicy`.
 *   - Mutating dashboard.* handlers check via `assertDashboardWriteAllowed`.
 *   - The Platform-bound WS publisher reads the full map via
 *     `getDashboardWritePolicy` to broadcast `orch.capabilities`.
 *
 * Reads are cached in-process (30 s TTL) — the policy changes
 * infrequently and reading on every dashboard.* request is wasted IO.
 * Writes invalidate the cache and emit a change event so the WS
 * broadcaster can republish.
 */
import { EventEmitter } from 'node:events';
import { sql, type Kysely } from 'kysely';
import { createLogger } from '@kici-dev/shared';
import {
  DASHBOARD_WRITE_OPERATIONS_BY_NAME,
  DashboardWriteOperation,
  dashboardWritePolicyMapSchema,
  type DashboardWritePolicyMap,
  isDashboardWriteOperationEnabled,
} from '@kici-dev/engine/protocol/dashboard-write-operations';
import type { Database } from '../db/types.js';
import type { ActorPrincipal } from '@kici-dev/engine';

const logger = createLogger({ prefix: 'dashboard-write-policy' });

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  policy: DashboardWritePolicyMap;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Event bus for policy-change notifications. The WS publisher subscribes
 * to `'changed'` so it can broadcast a fresh `orch.capabilities` to
 * Platform whenever the operator flips a switch.
 */
export const dashboardWritePolicyEvents = new EventEmitter();

/**
 * Error thrown by `assertDashboardWriteAllowed` when an operation is
 * disabled. Carries the operation name + the descriptor's CLI hint so
 * callers can surface a structured error to Platform / dashboard.
 */
export class DashboardWritePolicyDisabledError extends Error {
  readonly code = 'operation_disabled' as const;
  constructor(
    readonly operation: DashboardWriteOperation,
    readonly cliEquivalent: string,
  ) {
    super(`dashboard write operation "${operation}" is disabled by orch policy`);
    this.name = 'DashboardWritePolicyDisabledError';
  }
}

/**
 * Structured response envelope sent back to Platform when a mutating
 * dashboard.* handler is rejected by the policy gate. Mirrors the
 * Platform-side 403 body so the dashboard renders one consistent
 * "operation disabled" affordance no matter which layer fires first.
 */
export function buildPolicyDeniedResponse(
  op: DashboardWriteOperation,
  responseType: string,
  requestId: string,
): Record<string, unknown> {
  const descriptor = DASHBOARD_WRITE_OPERATIONS_BY_NAME.get(op);
  return {
    type: responseType,
    requestId,
    error: 'operation_disabled',
    operation: op,
    cliEquivalent: descriptor?.cliEquivalent ?? 'kici-admin',
    ...(descriptor && {
      category: descriptor.category,
      label: descriptor.label,
      message: `Dashboard write "${descriptor.label}" is disabled by orchestrator policy. Use ${descriptor.cliEquivalent} instead.`,
    }),
  };
}

function parsePolicyColumn(raw: unknown): DashboardWritePolicyMap {
  if (raw === null || raw === undefined) return {};
  const candidate = typeof raw === 'string' ? safeParseJson(raw) : raw;
  const result = dashboardWritePolicyMapSchema.safeParse(candidate);
  if (!result.success) {
    logger.warn('Invalid dashboard_write_policy column shape — treating as empty', {
      error: result.error.message,
    });
    return {};
  }
  return result.data;
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function readCache(customerId: string): DashboardWritePolicyMap | null {
  const entry = cache.get(customerId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(customerId);
    return null;
  }
  return entry.policy;
}

function writeCache(customerId: string, policy: DashboardWritePolicyMap): void {
  cache.set(customerId, { policy, fetchedAt: Date.now() });
}

/**
 * Clear the cache. Public for tests and for the rare case where an
 * operator wants to force a fresh read after manual DB surgery.
 */
export function invalidateDashboardWritePolicyCache(customerId?: string): void {
  if (customerId === undefined) {
    cache.clear();
  } else {
    cache.delete(customerId);
  }
}

/**
 * Read the full policy map for a customer. Hits the in-process cache
 * for 30 s after the first read; falls back to the DB on cache miss.
 * Returns an empty map (everything enabled) when no `org_settings` row
 * exists for the customer.
 */
export async function getDashboardWritePolicy(
  db: Kysely<Database>,
  customerId: string,
): Promise<DashboardWritePolicyMap> {
  const cached = readCache(customerId);
  if (cached !== null) return cached;

  const row = await db
    .selectFrom('org_settings')
    .select('dashboard_write_policy')
    .where('customer_id', '=', customerId)
    .executeTakeFirst();

  const policy = parsePolicyColumn(row?.dashboard_write_policy);
  writeCache(customerId, policy);
  return policy;
}

/**
 * Single-operation check. Convenience wrapper around
 * `getDashboardWritePolicy` + the engine-side resolver.
 */
export async function isDashboardWriteEnabled(
  db: Kysely<Database>,
  customerId: string,
  op: DashboardWriteOperation,
): Promise<boolean> {
  const policy = await getDashboardWritePolicy(db, customerId);
  return isDashboardWriteOperationEnabled(policy, op);
}

/**
 * Defense-in-depth gate for orch-side dashboard.* handlers. Throws
 * `DashboardWritePolicyDisabledError` when the operation is disabled.
 * Callers translate the error into the structured error envelope they
 * send back to Platform.
 */
export async function assertDashboardWriteAllowed(
  db: Kysely<Database>,
  customerId: string,
  op: DashboardWriteOperation,
): Promise<void> {
  const enabled = await isDashboardWriteEnabled(db, customerId, op);
  if (enabled) return;
  const descriptor = DASHBOARD_WRITE_OPERATIONS_BY_NAME.get(op);
  throw new DashboardWritePolicyDisabledError(op, descriptor?.cliEquivalent ?? 'kici-admin');
}

/**
 * Merge `updates` into the persisted policy and persist the result.
 * Unknown keys in `updates` are rejected at the Zod schema layer
 * before this function runs (kici-admin already validates). Any
 * operation explicitly set to `true` is normalized away — the
 * permissive default lives in the absence of the key, keeping the
 * JSONB shape minimal.
 *
 * Each changed operation invokes the optional `onChange` callback
 * once — the caller decides what to do with it (typically: write
 * one `access_log` row per change).
 *
 * Emits `'changed'` on `dashboardWritePolicyEvents` with the new map
 * so the WS publisher can rebroadcast capabilities.
 */
export async function setDashboardWritePolicy(
  db: Kysely<Database>,
  customerId: string,
  updates: DashboardWritePolicyMap,
  options: {
    actor: ActorPrincipal;
    onChange?: (event: PolicyChangeEvent) => Promise<void>;
  },
): Promise<DashboardWritePolicyMap> {
  // Validate every key/value pair up front. The schema rejects unknown ops.
  const parsed = dashboardWritePolicyMapSchema.parse(updates);

  const { policy: result, didChange } = await db.transaction().execute(async (tx) => {
    const existing = await tx
      .selectFrom('org_settings')
      .select('dashboard_write_policy')
      .where('customer_id', '=', customerId)
      .executeTakeFirst();
    const current = parsePolicyColumn(existing?.dashboard_write_policy);

    const next: DashboardWritePolicyMap = { ...current };
    const changed: Array<{
      op: DashboardWriteOperation;
      prior: boolean;
      next: boolean;
    }> = [];
    for (const [op, value] of Object.entries(parsed) as Array<[DashboardWriteOperation, boolean]>) {
      const priorExplicit = current[op];
      const priorEffective = priorExplicit === undefined ? true : priorExplicit;
      if (value === true) {
        // Normalize: permissive is the default — drop the key.
        if (priorExplicit !== undefined) delete next[op];
      } else {
        next[op] = value;
      }
      if (priorEffective !== value) {
        changed.push({ op, prior: priorEffective, next: value });
      }
    }

    if (changed.length === 0) {
      return { policy: current, didChange: false };
    }

    await tx
      .insertInto('org_settings')
      .values({
        customer_id: customerId,
        dashboard_write_policy: JSON.stringify(next),
      })
      .onConflict((oc) =>
        oc.column('customer_id').doUpdateSet({
          dashboard_write_policy: JSON.stringify(next),
          updated_at: sql<Date>`now()`,
        }),
      )
      .execute();

    if (options.onChange) {
      for (const change of changed) {
        await options.onChange({
          actor: options.actor,
          customerId,
          op: change.op,
          prior: change.prior,
          next: change.next,
        });
      }
    }
    return { policy: next, didChange: true };
  });

  if (didChange) {
    invalidateDashboardWritePolicyCache(customerId);
    dashboardWritePolicyEvents.emit('changed', { customerId, policy: result });
  }
  return result;
}

/**
 * Per-operation change event fired by `setDashboardWritePolicy` for
 * each switch that actually flipped. The caller (admin HTTP route,
 * test, future automation) decides what to do — typically writes one
 * `access_log` row carrying `op`, `prior`, and `next` in `meta`.
 */
export interface PolicyChangeEvent {
  actor: ActorPrincipal;
  customerId: string;
  op: DashboardWriteOperation;
  prior: boolean;
  next: boolean;
}

/**
 * Reset to the permissive defaults (everything enabled). Useful for
 * the `kici-admin org-settings dashboard-writes reset` subcommand.
 */
export async function resetDashboardWritePolicy(
  db: Kysely<Database>,
  customerId: string,
  options: {
    actor: ActorPrincipal;
    onChange?: (event: PolicyChangeEvent) => Promise<void>;
  },
): Promise<DashboardWritePolicyMap> {
  // Reset = explicit `true` for every key currently disabled. The
  // updates are normalized to "remove keys" so the JSONB ends up empty.
  const current = await getDashboardWritePolicy(db, customerId);
  const updates: DashboardWritePolicyMap = {};
  for (const op of Object.keys(current) as DashboardWriteOperation[]) {
    updates[op] = true;
  }
  if (Object.keys(updates).length === 0) {
    return current;
  }
  return setDashboardWritePolicy(db, customerId, updates, options);
}

// The full-view resolver lives in the engine
// (`@kici-dev/engine/protocol/dashboard-write-operations`) so the
// dashboard SPA, the orch admin route, and any other consumer share
// one implementation. Re-export here for callers that already import
// from this module.
export { resolveFullPolicyView } from '@kici-dev/engine/protocol/dashboard-write-operations';
