/**
 * Agent-API handlers for the host inventory query surface.
 *
 * `inventory.query` and `inventory.get` ride the same agent-WS RPC channel as
 * `infrastructure.list`, resolving against the caller's own orchestrator
 * cluster's roster (one cluster = one orch DB = one roster). Both are read-only
 * and validate their params with the engine schemas before touching the store.
 */
import { z } from 'zod';
import {
  type HostInventoryEntry,
  type InventorySelector,
  InventorySelectorSchema,
} from '@kici-dev/engine';
import type { HostRosterStore } from '../agent/host-roster.js';

/** Kept narrow for testability. */
export interface InventoryApiDeps {
  rosterStore: Pick<HostRosterStore, 'queryInventory' | 'getInventory'>;
  /** Roster grace window (ms) — the same value runsOnAll's `findMatching` uses. */
  graceMs: number;
}

const getParamsSchema = z.object({ agentId: z.string().min(1) });

/**
 * Label selector: `include` OR-of-AND groups + `exclude`; an empty selector ⇒
 * all hosts. The workflow filters properties client-side.
 */
export function createInventoryQueryHandler(
  deps: InventoryApiDeps,
): (agentId: string, params: Record<string, unknown>) => Promise<HostInventoryEntry[]> {
  return async (_agentId, params) => {
    const parsed = InventorySelectorSchema.parse(params ?? {});
    const selector: InventorySelector | undefined =
      parsed.include || parsed.exclude
        ? { include: parsed.include, exclude: parsed.exclude }
        : undefined;
    return deps.rosterStore.queryInventory(selector, deps.graceMs);
  };
}

/** Single-host lookup, null when absent. */
export function createInventoryGetHandler(
  deps: InventoryApiDeps,
): (agentId: string, params: Record<string, unknown>) => Promise<HostInventoryEntry | null> {
  return async (_agentId, params) => {
    const { agentId } = getParamsSchema.parse(params);
    return deps.rosterStore.getInventory(agentId, deps.graceMs);
  };
}
