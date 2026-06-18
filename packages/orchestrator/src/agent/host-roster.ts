import { type Kysely, sql } from 'kysely';
import { type LabelMatcher, matcherSatisfiedBy } from '@kici-dev/engine';
import type { Database, HostRosterRow } from '../db/types.js';

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
      });
    }
    out.sort((a, b) => a.agentId.localeCompare(b.agentId));
    return out;
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

  /** Delete ephemeral rows whose last_seen is older than ttl. Returns count. */
  async reapEphemeralPastTtl(ttlMs: number): Promise<number> {
    const res = await this.db
      .deleteFrom('host_roster')
      .where('lifecycle_class', '=', 'ephemeral')
      .where('last_seen', '<', sql<Date>`now() - (${ttlMs}::text || ' milliseconds')::interval`)
      .executeTakeFirst();
    return Number(res.numDeletedRows ?? 0n);
  }
}
