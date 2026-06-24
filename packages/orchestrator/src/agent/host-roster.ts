import { type Kysely, sql } from 'kysely';
import {
  type HostInventoryEntry,
  type InventorySelector,
  type LabelMatcher,
  matcherSatisfiedBy,
} from '@kici-dev/engine';
import type { Database, HostRosterRow } from '../db/types.js';

/** Typed host-vars bag carried by roster rows (`string | number | boolean`). */
export type HostProperties = Record<string, string | number | boolean>;

/**
 * Derived (read-time) status of a roster host. Never a stored mutable column:
 * status is computed from the shared `last_seen` + `connected_instance_id` so
 * every cluster instance agrees regardless of which one holds the live WS.
 */
export enum HostStatus {
  /** Connected to some instance AND heartbeat fresh. */
  ready = 'ready',
  /** Static host that is not currently live (declared, rebooting, or gone). */
  unreachable = 'unreachable',
  /** Ephemeral host past ttl but not yet reaped (scaled down). */
  stale = 'stale',
}

/** The lifecycle class snapshot from the auth token's `agent_type`. */
export type LifecycleClass = 'static' | 'ephemeral';

/**
 * A roster host that matched a `runsOnAll` predicate, with its derived status.
 * The host-fanout resolver consumes this: `ready` hosts become pinned children;
 * `unreachable` static hosts are subject to the `onUnreachable` policy; `stale`
 * ephemeral hosts are skipped.
 */
export interface MatchedHost {
  agentId: string;
  /** Hostname (falls back to agentId). */
  host: string;
  labels: string[];
  lifecycleClass: LifecycleClass;
  /** Which orchestrator holds the live WS (null = disconnected). For the cross-cluster pin. */
  connectedInstanceId: string | null;
  status: HostStatus;
  platform: string | null;
  arch: string | null;
  /** Typed host-vars bag (parsed from `host_properties`). */
  properties: HostProperties;
}

export interface UpsertHostInput {
  agentId: string;
  tokenId: string | null;
  lifecycleClass: LifecycleClass;
  labels: string[];
  hostname: string | null;
  platform: string;
  arch: string;
  instanceId: string;
  /**
   * Agent-reported typed host-vars. Shallow-merged into any existing bag on
   * conflict (agent-reported keys win; operator-declared keys the agent does
   * not report are preserved). Omitted ⇒ no change to the stored bag on update,
   * `{}` on insert.
   */
  properties?: HostProperties;
}

/** Minimal row shape `deriveHostStatus` reads (the store row or the CLI row). */
export interface HostStatusRow {
  connected_instance_id: string | null;
  lifecycle_class: string;
  last_seen: Date | string;
}

/**
 * The ONE status-derivation function — used by the store and the kici-admin
 * host CLI. `ready` requires the host to be genuinely live (connected to some
 * instance AND heartbeat fresh — the freshness check catches a crashed
 * instance that never cleared `connected_instance_id`). It never returns
 * `ready` for a not-currently-live host: a not-live `static` reads
 * `unreachable` (the declared-but-absent alarm), a not-live `ephemeral` reads
 * `stale` (scaled down, awaiting reap).
 */
export function deriveHostStatus(row: HostStatusRow, nowMs: number, graceMs: number): HostStatus {
  const ageMs = nowMs - new Date(row.last_seen).getTime();
  if (row.connected_instance_id !== null && ageMs <= graceMs) return HostStatus.ready;
  if (row.lifecycle_class === 'ephemeral') return HostStatus.stale;
  return HostStatus.unreachable;
}

/**
 * Normalize a stored `host_properties` value into a typed host-vars bag. The pg
 * driver returns parsed JSON for a `jsonb` column, but accept a JSON string too
 * (defensive for non-pg paths / tests). Non-object / null reads back as `{}`.
 */
export function parseHostProperties(value: unknown): HostProperties {
  const parsed = typeof value === 'string' ? safeJsonParse(value) : value;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as HostProperties;
  }
  return {};
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Durable, cluster-shared roster of every agent the cluster has ever enrolled.
 *
 * The in-memory `AgentRegistry` reconciles into this table on register
 * (`upsert`) / unregister (`markDisconnected`), with a coarse heartbeat
 * (`stampLastSeen`). All liveness writes are owner-guarded by `instanceId` so a
 * stale disconnect from an old instance can never clobber a row a different
 * instance now owns. The leader-only reaper deletes `ephemeral` rows past their
 * ttl via `reapEphemeralPastTtl`; `static` rows persist and read `unreachable`.
 */
export class HostRosterStore {
  constructor(private readonly db: Kysely<Database>) {}

  /** Idempotent upsert on agent_id; stamps connected_instance_id + last_seen. */
  async upsert(input: UpsertHostInput): Promise<void> {
    const labelsJson = JSON.stringify(input.labels);
    const reportedJson = JSON.stringify(input.properties ?? {});
    await this.db
      .insertInto('host_roster')
      .values({
        agent_id: input.agentId,
        token_id: input.tokenId,
        lifecycle_class: input.lifecycleClass,
        labels: labelsJson,
        hostname: input.hostname,
        platform: input.platform,
        arch: input.arch,
        connected_instance_id: input.instanceId,
        host_properties: reportedJson,
        last_seen: sql`now()`,
        updated_at: sql`now()`,
      })
      .onConflict((oc) =>
        oc.column('agent_id').doUpdateSet({
          token_id: input.tokenId,
          lifecycle_class: input.lifecycleClass,
          labels: labelsJson,
          hostname: input.hostname,
          platform: input.platform,
          arch: input.arch,
          connected_instance_id: input.instanceId,
          // Shallow-merge: existing bag on the left, agent-reported on the
          // right (right keys win). Operator-declared keys the agent does not
          // report are preserved.
          host_properties: sql`COALESCE(host_roster.host_properties, '{}'::jsonb) || ${reportedJson}::jsonb`,
          last_seen: sql`now()`,
          updated_at: sql`now()`,
        }),
      )
      .execute();
  }

  /** Clear liveness on disconnect — but only if THIS instance still owns it. */
  async markDisconnected(agentId: string, instanceId: string): Promise<void> {
    await this.db
      .updateTable('host_roster')
      .set({ connected_instance_id: null, updated_at: sql`now()` })
      .where('agent_id', '=', agentId)
      .where('connected_instance_id', '=', instanceId)
      .execute();
  }

  /** Coarse heartbeat stamp — same owner-guard as markDisconnected. */
  async stampLastSeen(agentId: string, instanceId: string): Promise<void> {
    await this.db
      .updateTable('host_roster')
      .set({ last_seen: sql`now()` })
      .where('agent_id', '=', agentId)
      .where('connected_instance_id', '=', instanceId)
      .execute();
  }

  /** Operator pre-declare of a static host before its agent dials in. */
  async declareStatic(input: {
    agentId: string;
    labels: string[];
    hostname?: string;
    properties?: HostProperties;
  }): Promise<void> {
    await this.db
      .insertInto('host_roster')
      .values({
        agent_id: input.agentId,
        token_id: null,
        lifecycle_class: 'static',
        labels: JSON.stringify(input.labels),
        hostname: input.hostname ?? null,
        connected_instance_id: null,
        host_properties: JSON.stringify(input.properties ?? {}),
        last_seen: sql`now()`,
        updated_at: sql`now()`,
      })
      .onConflict((oc) => oc.column('agent_id').doNothing())
      .execute();
  }

  async get(agentId: string): Promise<HostRosterRow | null> {
    const row = await this.db
      .selectFrom('host_roster')
      .selectAll()
      .where('agent_id', '=', agentId)
      .executeTakeFirst();
    return row ?? null;
  }

  async listAll(): Promise<HostRosterRow[]> {
    return this.db.selectFrom('host_roster').selectAll().orderBy('agent_id', 'asc').execute();
  }

  /**
   * Resolve every roster host matching a `runsOnAll` predicate (OR-of-AND
   * include groups, minus exclude labels), tagged with its derived status. This
   * is the host-fanout resolver: it returns declared-but-absent static hosts
   * (status `unreachable`) so the caller can apply `onUnreachable` — the live
   * registry alone cannot name an expected-but-absent host.
   */
  async findMatching(
    include: readonly (readonly LabelMatcher[])[],
    exclude: readonly LabelMatcher[],
    graceMs: number,
  ): Promise<MatchedHost[]> {
    const rows = await this.db.selectFrom('host_roster').selectAll().execute();
    const now = Date.now();
    const out: MatchedHost[] = [];
    for (const row of rows) {
      const labels: string[] = JSON.parse(row.labels);
      const set = new Set(labels);
      if (exclude.some((e) => matcherSatisfiedBy(e, set))) continue;
      if (include.length && !include.some((grp) => grp.every((m) => matcherSatisfiedBy(m, set))))
        continue;
      out.push({
        agentId: row.agent_id,
        host: row.hostname ?? row.agent_id,
        labels,
        lifecycleClass: row.lifecycle_class as LifecycleClass,
        connectedInstanceId: row.connected_instance_id,
        status: deriveHostStatus(row, now, graceMs),
        platform: row.platform,
        arch: row.arch,
        properties: parseHostProperties(row.host_properties),
      });
    }
    out.sort((a, b) => a.agentId.localeCompare(b.agentId));
    return out;
  }

  /**
   * Map a roster row to the canonical {@link HostInventoryEntry} — the queryable
   * shape returned by the `inventory.query`/`inventory.get` RPC and typed on the
   * SDK's `ctx.kici.inventory`. Status is derived the same way `findMatching`
   * derives it (live + fresh ⇒ ready; declared-but-absent static ⇒ unreachable;
   * ephemeral past ttl ⇒ stale).
   */
  toInventoryEntry(row: HostRosterRow, graceMs: number): HostInventoryEntry {
    return {
      agentId: row.agent_id,
      labels: JSON.parse(row.labels) as string[],
      properties: parseHostProperties(row.host_properties),
      hostname: row.hostname,
      platform: row.platform,
      arch: row.arch,
      lifecycleClass: row.lifecycle_class as LifecycleClass,
      status: deriveHostStatus(row, Date.now(), graceMs),
      lastSeen: new Date(row.last_seen).toISOString(),
    };
  }

  /**
   * Query the roster as canonical {@link HostInventoryEntry} records. With a
   * selector, reuses `findMatching`'s label filtering (server-side, glob/regex);
   * property filtering is done client-side in the workflow. Omit the selector ⇒
   * every host.
   */
  async queryInventory(
    selector: InventorySelector | undefined,
    graceMs: number,
  ): Promise<HostInventoryEntry[]> {
    if (!selector || (!selector.include && !selector.exclude)) {
      const rows = await this.listAll();
      return rows.map((r) => this.toInventoryEntry(r, graceMs));
    }
    const matched = await this.findMatching(
      selector.include ?? [],
      selector.exclude ?? [],
      graceMs,
    );
    const byId = new Map(matched.map((m) => [m.agentId, m]));
    const rows = await this.listAll();
    return rows.filter((r) => byId.has(r.agent_id)).map((r) => this.toInventoryEntry(r, graceMs));
  }

  /** Single-host inventory lookup; null when the agent is not in the roster. */
  async getInventory(agentId: string, graceMs: number): Promise<HostInventoryEntry | null> {
    const row = await this.get(agentId);
    return row ? this.toInventoryEntry(row, graceMs) : null;
  }

  /**
   * Count `static` (declared) hosts whose derived status is `unreachable` —
   * the "declared-but-absent" alarm population. Reuses the single-source
   * {@link deriveHostStatus} so the count never diverges from what
   * `kici-admin host list` shows. A not-currently-connected static host reads
   * `unreachable` regardless of grace (only the connected-but-stale case
   * depends on `graceMs`).
   */
  async countStaticUnreachable(graceMs: number): Promise<number> {
    const rows = await this.db
      .selectFrom('host_roster')
      .selectAll()
      .where('lifecycle_class', '=', 'static')
      .execute();
    const now = Date.now();
    return rows.filter((r) => deriveHostStatus(r, now, graceMs) === HostStatus.unreachable).length;
  }

  /** Remove a host from the roster by agent id. Returns rows deleted. */
  async removeStatic(agentId: string): Promise<number> {
    const res = await this.db
      .deleteFrom('host_roster')
      .where('agent_id', '=', agentId)
      .executeTakeFirst();
    return Number(res.numDeletedRows ?? 0n);
  }

  /** Delete ephemeral rows whose last_seen is older than ttl. Returns count. */
  async reapEphemeralPastTtl(ttlMs: number): Promise<number> {
    const res = await this.db
      .deleteFrom('host_roster')
      .where('lifecycle_class', '=', 'ephemeral')
      .where('last_seen', '<', sql<Date>`now() - (${ttlMs}::text || ' milliseconds')::interval`)
      .executeTakeFirst();
    return Number(res.numDeletedRows ?? 0n);
  }

  /**
   * Mark a host as about-to-reboot until `until`. Set by the `host.requestReboot`
   * API handler when an agent's `restartHost()` step runs. While the value is in
   * the future, the host's disconnect is the expected reboot and its pinned
   * post-restart job is held.
   */
  async setRebootPending(agentId: string, until: Date): Promise<void> {
    await this.db
      .updateTable('host_roster')
      .set({ reboot_pending_until: until, updated_at: sql`now()` })
      .where('agent_id', '=', agentId)
      .execute();
  }

  /** Clear the reboot-pending flag (on reconnect, deadline expiry, or cancel). */
  async clearRebootPending(agentId: string): Promise<void> {
    await this.db
      .updateTable('host_roster')
      .set({ reboot_pending_until: null, updated_at: sql`now()` })
      .where('agent_id', '=', agentId)
      .execute();
  }

  /** True when the host has a reboot-pending deadline still in the future at `nowMs`. */
  async isRebootPending(agentId: string, nowMs: number): Promise<boolean> {
    const row = await this.db
      .selectFrom('host_roster')
      .select('reboot_pending_until')
      .where('agent_id', '=', agentId)
      .executeTakeFirst();
    const until = row?.reboot_pending_until ? new Date(row.reboot_pending_until).getTime() : 0;
    return until > nowMs;
  }

  /**
   * Agent ids whose reboot-pending deadline has passed at `nowMs`. The deadline
   * sweep clears these; the held post-restart job then hits the queue timeout.
   */
  async listExpiredRebootPending(nowMs: number): Promise<string[]> {
    const rows = await this.db
      .selectFrom('host_roster')
      .select('agent_id')
      .where('reboot_pending_until', 'is not', null)
      .where('reboot_pending_until', '<=', new Date(nowMs))
      .execute();
    return rows.map((r) => r.agent_id);
  }
}
