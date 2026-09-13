/**
 * Canonical, workflow-queryable host inventory schema.
 *
 * One `HostInventoryEntry` is the single shape every inventory consumer reads:
 * the orchestrator's roster store maps each `host_roster` row to it, the
 * `inventory.query`/`inventory.get` agent-API RPC returns it, and the SDK's
 * `ctx.kici.inventory` types it. Labels stay the flat-string grouping
 * dimension (the shipped runsOnAll glob/regex matchers operate on flat
 * strings); `properties` is the separate typed host-vars dimension.
 */
import { z } from 'zod';
import { LabelMatcher } from './labels-match.js';

/** A single host-property value — the typed host-vars dimension. */
export const HostPropertyValue = z.union([z.string(), z.number(), z.boolean()]);
export type HostPropertyValue = z.infer<typeof HostPropertyValue>;

/**
 * Lifecycle class of a roster host. Mirrors the orchestrator's `LifecycleClass`
 * (the auth token's `agent_type` snapshot): `static` hosts persist and alarm on
 * absence; `ephemeral` hosts are GC'd past their ttl.
 */
export const InventoryLifecycleClass = z.enum(['static', 'ephemeral']);
export type InventoryLifecycleClass = z.infer<typeof InventoryLifecycleClass>;

/**
 * Read-time derived status of a roster host. Mirrors the orchestrator's
 * `HostStatus` values: `ready` (live + fresh heartbeat), `unreachable`
 * (declared static host not currently live), `stale` (ephemeral past ttl,
 * awaiting reap).
 */
export const InventoryHostStatus = z.enum(['ready', 'unreachable', 'stale']);
export type InventoryHostStatus = z.infer<typeof InventoryHostStatus>;

/** Canonical queryable inventory record for one roster host. */
export const HostInventoryEntry = z.object({
  agentId: z.string(),
  /** Flat-string grouping/tags dimension (runsOnAll selectors operate on these). */
  labels: z.array(z.string()),
  /** Typed host-vars dimension (the ansible host-vars analogue). */
  properties: z.record(z.string(), HostPropertyValue),
  hostname: z.string().nullable(),
  platform: z.string().nullable(),
  arch: z.string().nullable(),
  lifecycleClass: InventoryLifecycleClass,
  status: InventoryHostStatus,
  /** ISO 8601 timestamp of the last heartbeat. */
  lastSeen: z.string(),
});
export type HostInventoryEntry = z.infer<typeof HostInventoryEntry>;

/**
 * Label selector for `inventory.query`. Reuses the shipped `LabelMatcher`
 * (glob/regex) semantics: `include` is an OR-of-AND group list, `exclude`
 * removes any host whose labels satisfy a matcher. Omit ⇒ all hosts.
 * Property filtering is done client-side in the workflow (full JS).
 */
export interface InventorySelector {
  include?: (readonly LabelMatcher[])[];
  exclude?: LabelMatcher[];
}

/** Zod validator for the `inventory.query` selector params on the wire. */
export const InventorySelectorSchema = z.object({
  include: z.array(z.array(LabelMatcher)).optional(),
  exclude: z.array(LabelMatcher).optional(),
});

/**
 * Coerce a raw string into a typed {@link HostPropertyValue}: `true`/`false` ⇒
 * boolean, a finite integer/decimal literal ⇒ number, everything else ⇒ the
 * verbatim string. The single source of truth for the `key=value` typing used
 * by both `kici-admin host declare --prop` and the agent's `KICI_PROPERTIES`.
 */
export function coerceHostPropertyValue(raw: string): HostPropertyValue {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  // Only treat as a number when the trimmed string round-trips exactly, so
  // e.g. '1.2.3' or '08x' stay strings.
  if (raw !== '' && /^-?\d+(\.\d+)?$/.test(raw) && Number.isFinite(Number(raw))) {
    return Number(raw);
  }
  return raw;
}

/**
 * Parse a list of `key=value` property assignments into a typed property bag.
 * Values are typed via {@link coerceHostPropertyValue}. Throws on a malformed
 * entry (missing `=`) or an empty key. Used by the host-declare CLI `--prop`
 * option and the agent's `KICI_PROPERTIES` config parse.
 */
export function parseHostPropertyAssignments(values: string[]): Record<string, HostPropertyValue> {
  const out: Record<string, HostPropertyValue> = {};
  for (const entry of values) {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      throw new Error(`Invalid property '${entry}': expected key=value`);
    }
    const key = entry.slice(0, eq);
    out[key] = coerceHostPropertyValue(entry.slice(eq + 1));
  }
  return out;
}
