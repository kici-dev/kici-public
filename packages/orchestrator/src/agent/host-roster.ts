import { type Kysely, sql } from 'kysely';
import {
  type CanonicalLabel,
  canonicalizeLabel,
  canonicalizeLabels,
  canonicalizeMatcher,
  type FleetHostEntry,
  FleetHostWriteRefusal,
  type HostInventoryEntry,
  type InventorySelector,
  type LabelMatcher,
  matcherSatisfiedBy,
} from '@kici-dev/engine';
import { type Database, HostIdentitySource, type HostRosterRow } from '../db/types.js';
import { safeJsonParse } from '../helpers/json.js';

/** Typed host-vars bag carried by roster rows (`string | number | boolean`). */
export type HostProperties = Record<string, string | number | boolean>;

/**
 * Reserved `host_properties` key holding the self-contained agent-payload version
 * the orchestrator last staged onto a host. Read by the fleet-convergence gate;
 * the `kici:` namespace is orchestrator-reserved so an agent never reports it.
 */
export const STAGED_AGENT_VERSION_KEY = 'kici:staged-agent-version';

/**
 * Fold a hostname to its canonical form, at every roster write AND every read
 * that leaves the store, so no row is reported folded while another is raw.
 *
 * Hostnames are case-insensitive (DNS), and the derived `kici:host:<hostname>`
 * label is stored canonical, so the label fold is reused to keep the two in
 * step. `agent_id` is deliberately NOT folded: it is opaque, and a
 * case-insensitive match would let a binding for one agent reach another.
 *
 * The read fold is load-bearing: a `declareStatic`-only host has no agent to
 * re-register it, so its row keeps the operator's case for as long as it exists.
 *
 * `${host}` in a secret scope pattern renders this name, so `prod/hosts/${host}`
 * resolves under the lowercase name — an accepted breaking change, delivered to
 * every host at once rather than to whichever rows happened to be rewritten.
 */
function canonicalizeHostname(raw: string | null | undefined): string | null {
  return raw === null || raw === undefined ? null : canonicalizeLabel(raw);
}

/** Prefix of the orchestrator-reserved namespace for host labels and property keys. */
const RESERVED_HOST_KEY_PREFIX = 'kici:';

/**
 * True when a host label or property key is in the orchestrator-reserved
 * `kici:` namespace. Trimmed and case-insensitive, matching how labels fold on
 * read (`canonicalizeLabel`).
 */
export function isReservedHostKey(key: string): boolean {
  return key.trim().toLowerCase().startsWith(RESERVED_HOST_KEY_PREFIX);
}

/**
 * Drop every reserved `kici:` key from an agent-reported host-property bag.
 * Agent keys win the roster shallow-merge, and the staged-version convergence
 * gate and the re-stage's SSH restart commands read `kici:` keys, so an agent
 * must never set them. Reserved keys come only from `recordStagedVersion` and
 * a local `kici-admin host declare`.
 */
export function stripReservedProperties(props: HostProperties): HostProperties {
  const out: HostProperties = {};
  for (const [key, value] of Object.entries(props)) {
    if (!isReservedHostKey(key)) out[key] = value;
  }
  return out;
}

/** Who is writing a static host declaration or removal. */
export enum HostWriteAuthority {
  /** A local `kici-admin` declare or remove. */
  operator = 'operator',
  /** A Platform-relayed dashboard write. The default. */
  platform = 'platform',
}

/** A host write refused because of the writer's authority. */
export class HostWriteRefusedError extends Error {
  constructor(
    readonly code: FleetHostWriteRefusal,
    readonly detail: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** A Platform write named a reserved `kici:` label or property key. */
export class ReservedHostKeyError extends HostWriteRefusedError {
  constructor(readonly keys: string[]) {
    super(
      FleetHostWriteRefusal.enum.reserved_property,
      keys.join(','),
      `reserved kici: labels and properties are set only with kici-admin host declare: ${keys.join(', ')}`,
    );
  }
}

/** A Platform declare named a host that already exists. */
export class HostExistsError extends HostWriteRefusedError {
  constructor(agentId: string) {
    super(
      FleetHostWriteRefusal.enum.host_exists,
      agentId,
      `host ${agentId} already exists; change it with kici-admin host declare`,
    );
  }
}

/** A Platform remove named a host an agent or operator confirmed. */
export class HostConfirmedError extends HostWriteRefusedError {
  constructor(agentId: string) {
    super(
      FleetHostWriteRefusal.enum.host_confirmed,
      agentId,
      `host ${agentId} is confirmed; remove it with kici-admin host remove`,
    );
  }
}

/** Input of {@link HostRosterStore.declareStatic}. */
export interface DeclareStaticInput {
  agentId: string;
  labels?: string[];
  hostname?: string;
  properties?: HostProperties;
  address?: string;
  sshUser?: string;
  sshPort?: number;
  sshKeySecret?: string;
  s3Reachable?: boolean;
  /** Who is writing. Omitted ⇒ `platform`, the most restricted. */
  authority?: HostWriteAuthority;
}

/**
 * How to SSH to a declared host for bootstrap bring-up before it has an agent.
 * A host with no reach metadata cannot be bootstrapped. `sshKeySecret` is a
 * scoped-secret ref (`scope/key`) resolved server-side; the key never lives here.
 */
export interface HostReach {
  agentId: string;
  address: string | null;
  sshUser: string | null;
  sshPort: number | null;
  sshKeySecret: string | null;
  /**
   * True ⇒ the box reaches the orchestrator's object storage, so bring-up uses
   * `s3-direct` (the box pulls the payload via a presigned URL). NULL / false ⇒
   * the conservative `ssh-push` fallback.
   */
  s3Reachable: boolean | null;
}

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
 * A roster host that matched a `runsOnAll` predicate. In the host-fanout
 * resolver, `ready` hosts become pinned children, `unreachable` static hosts
 * get the `onUnreachable` policy, and `stale` ephemeral hosts are skipped.
 */
export interface MatchedHost {
  agentId: string;
  /** Canonical hostname; falls back to the raw agentId when the row has none. */
  host: string;
  /**
   * Folded on read: a row written before labels were canonicalized keeps the
   * operator's case, and this is the only place it would otherwise reach a matcher.
   */
  labels: CanonicalLabel[];
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
  /**
   * True when an auto-scaler spawned this agent, so `runsOnAll` fan-out skips
   * it. From the scaler manager's registration lookup, never `lifecycleClass`
   * (`ephemeral` for every agent under auth mode `none`). Omitted ⇒ false.
   */
  scalerManaged?: boolean;
  labels: string[];
  hostname: string | null;
  platform: string;
  arch: string;
  instanceId: string;
  /**
   * Shallow-merged into the existing bag on conflict: agent keys win, operator
   * keys the agent does not report survive. Omitted ⇒ no change on update,
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
 * The ONE status derivation, shared by the store and the kici-admin host CLI.
 * `ready` needs a connected instance AND a fresh heartbeat (freshness catches a
 * crashed instance that never cleared `connected_instance_id`). A not-live
 * `static` reads `unreachable` (the declared-but-absent alarm); a not-live
 * `ephemeral` reads `stale` (scaled down, awaiting reap).
 */
export function deriveHostStatus(row: HostStatusRow, nowMs: number, graceMs: number): HostStatus {
  const ageMs = nowMs - new Date(row.last_seen).getTime();
  if (row.connected_instance_id !== null && ageMs <= graceMs) return HostStatus.ready;
  if (row.lifecycle_class === 'ephemeral') return HostStatus.stale;
  return HostStatus.unreachable;
}

/**
 * Normalize a stored `host_properties` value. pg returns parsed `jsonb`; a JSON
 * string is accepted for non-pg paths and tests. Non-object / null reads `{}`.
 */
export function parseHostProperties(value: unknown): HostProperties {
  const parsed = typeof value === 'string' ? safeJsonParse(value) : value;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as HostProperties;
  }
  return {};
}

/**
 * Durable, cluster-shared roster of every agent the cluster has ever enrolled.
 *
 * The in-memory `AgentRegistry` reconciles into it on register (`upsert`),
 * unregister (`markDisconnected`) and a coarse heartbeat (`stampLastSeen`).
 * Liveness writes are owner-guarded by `instanceId`, so a stale disconnect from
 * an old instance never clobbers a row another instance now owns. The
 * leader-only reaper deletes `ephemeral` rows past ttl; `static` rows persist
 * and read `unreachable`.
 */
export class HostRosterStore {
  constructor(private readonly db: Kysely<Database>) {}

  /** Idempotent upsert on agent_id; stamps connected_instance_id + last_seen. */
  async upsert(input: UpsertHostInput): Promise<void> {
    const labelsJson = JSON.stringify(input.labels);
    const hostname = canonicalizeHostname(input.hostname);
    // Security boundary: without the strip, a compromised agent could forge
    // `kici:staged-agent-version` (evading the fleet-upgrade convergence) or
    // `kici:agent-restart-*` (a command the re-stage runs over SSH).
    const reportedJson = JSON.stringify(stripReservedProperties(input.properties ?? {}));
    await this.db
      .insertInto('host_roster')
      .values({
        agent_id: input.agentId,
        token_id: input.tokenId,
        lifecycle_class: input.lifecycleClass,
        scaler_managed: input.scalerManaged ?? false,
        labels: labelsJson,
        hostname,
        platform: input.platform,
        arch: input.arch,
        connected_instance_id: input.instanceId,
        host_properties: reportedJson,
        identity_source: HostIdentitySource.agent,
        last_seen: sql`now()`,
        updated_at: sql`now()`,
      })
      .onConflict((oc) =>
        oc.column('agent_id').doUpdateSet({
          token_id: input.tokenId,
          lifecycle_class: input.lifecycleClass,
          // Converges on re-registration, so a host that stops (or starts) being
          // scaler-spawned under the same agent id never keeps stale eligibility.
          scaler_managed: input.scalerManaged ?? false,
          labels: labelsJson,
          hostname,
          platform: input.platform,
          arch: input.arch,
          connected_instance_id: input.instanceId,
          // Registration confirms the host: a dashboard-declared row is replaced
          // by the agent's report; any other row shallow-merges (agent keys win).
          // PostgreSQL evaluates every SET against the existing row, so this CASE
          // reads the source before the update.
          host_properties: sql`CASE WHEN host_roster.identity_source = ${HostIdentitySource.platform}
            THEN ${reportedJson}::jsonb
            ELSE COALESCE(host_roster.host_properties, '{}'::jsonb) || ${reportedJson}::jsonb END`,
          identity_source: HostIdentitySource.agent,
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

  /**
   * Declare a static host. `operator` authority (a local `kici-admin`) inserts
   * or converges the row; `platform` authority (a dashboard write, the default)
   * only creates a new, unconfirmed row. `created` is true when it inserted.
   */
  async declareStatic(input: DeclareStaticInput): Promise<{ created: boolean }> {
    const authority = input.authority ?? HostWriteAuthority.platform;
    return authority === HostWriteAuthority.operator
      ? this.declareAsOperator(input)
      : this.createPlaceholder(input);
  }

  /**
   * A Platform declare: create a new `platform` row, never touch an existing
   * one. Reserved `kici:` labels or properties refuse the whole write before
   * any SQL, and the insert-or-nothing statement leaves no check-then-write race.
   */
  private async createPlaceholder(input: DeclareStaticInput): Promise<{ created: boolean }> {
    const reserved = [...(input.labels ?? []), ...Object.keys(input.properties ?? {})].filter(
      isReservedHostKey,
    );
    if (reserved.length > 0) throw new ReservedHostKeyError(reserved);
    const reach = [
      input.address,
      input.sshUser,
      input.sshPort,
      input.sshKeySecret,
      input.s3Reachable,
    ];
    if (reach.some((v) => v !== undefined)) {
      throw new Error('declareStatic: reach fields need HostWriteAuthority.operator');
    }
    const row = await this.db
      .insertInto('host_roster')
      .values({
        agent_id: input.agentId,
        token_id: null,
        lifecycle_class: 'static',
        labels: JSON.stringify(input.labels ?? []),
        hostname: canonicalizeHostname(input.hostname),
        connected_instance_id: null,
        host_properties: JSON.stringify(input.properties ?? {}),
        identity_source: HostIdentitySource.platform,
        last_seen: sql`now()`,
        updated_at: sql`now()`,
      })
      .onConflict((oc) => oc.column('agent_id').doNothing())
      .returning('agent_id')
      .executeTakeFirst();
    if (!row) throw new HostExistsError(input.agentId);
    return { created: true };
  }

  /**
   * An operator declare. A re-declare converges the operator-owned columns
   * (labels, hostname, reach, host_properties) and preserves the agent-reported
   * ones (connected_instance_id, last_seen, platform, arch, lifecycle_class,
   * token_id, reboot_pending_until). Operator fields are preserve-on-omit and
   * properties shallow-merge — except on a dashboard-declared row, where the
   * operator's labels, hostname and properties replace it outright (no
   * Platform-chosen value survives confirmation) and the row becomes
   * `operator`. An `agent` row stays `agent`. PostgreSQL evaluates every SET
   * against the existing row, so each CASE reads the source before the update.
   */
  private async declareAsOperator(input: DeclareStaticInput): Promise<{ created: boolean }> {
    // undefined ⇒ NULL ⇒ COALESCE preserves the existing column on update.
    const labelsBind = input.labels === undefined ? null : JSON.stringify(input.labels);
    const propsBind = input.properties === undefined ? null : JSON.stringify(input.properties);
    const hostnameBind = canonicalizeHostname(input.hostname);
    const labelsJson = JSON.stringify(input.labels ?? []);
    const propsJson = JSON.stringify(input.properties ?? {});
    const adopting = sql<boolean>`host_roster.identity_source = ${HostIdentitySource.platform}`;
    const row = await this.db
      .insertInto('host_roster')
      .values({
        agent_id: input.agentId,
        token_id: null,
        lifecycle_class: 'static',
        labels: labelsJson,
        hostname: hostnameBind,
        connected_instance_id: null,
        host_properties: propsJson,
        address: input.address ?? null,
        ssh_user: input.sshUser ?? null,
        ssh_port: input.sshPort ?? null,
        ssh_key_secret: input.sshKeySecret ?? null,
        s3_reachable: input.s3Reachable ?? null,
        identity_source: HostIdentitySource.operator,
        last_seen: sql`now()`,
        updated_at: sql`now()`,
      })
      .onConflict((oc) =>
        oc.column('agent_id').doUpdateSet({
          labels: sql`CASE WHEN ${adopting} THEN ${labelsJson}::text
            ELSE COALESCE(${labelsBind}::text, host_roster.labels) END`,
          hostname: sql`CASE WHEN ${adopting} THEN ${hostnameBind}::text
            ELSE COALESCE(${hostnameBind}::text, host_roster.hostname) END`,
          host_properties: sql`CASE WHEN ${adopting} THEN ${propsJson}::jsonb
            ELSE COALESCE(host_roster.host_properties, '{}'::jsonb) || COALESCE(${propsBind}::jsonb, '{}'::jsonb) END`,
          address: sql`COALESCE(${input.address ?? null}, host_roster.address)`,
          ssh_user: sql`COALESCE(${input.sshUser ?? null}, host_roster.ssh_user)`,
          ssh_port: sql`COALESCE(${input.sshPort ?? null}, host_roster.ssh_port)`,
          ssh_key_secret: sql`COALESCE(${input.sshKeySecret ?? null}, host_roster.ssh_key_secret)`,
          s3_reachable: sql`COALESCE(${input.s3Reachable ?? null}, host_roster.s3_reachable)`,
          identity_source: sql<HostIdentitySource>`CASE WHEN ${adopting} THEN ${HostIdentitySource.operator}::text
            ELSE host_roster.identity_source END`,
          updated_at: sql`now()`,
        }),
      )
      .returning(sql<boolean>`(xmax = 0)`.as('created'))
      .executeTakeFirstOrThrow();
    return { created: !!row.created };
  }

  /**
   * Read a host's pre-agent reach metadata. Returns null when the host is not
   * in the roster; a host declared without reach fields reads back with nulls.
   */
  async getReach(agentId: string): Promise<HostReach | null> {
    const row = await this.db
      .selectFrom('host_roster')
      .select(['agent_id', 'address', 'ssh_user', 'ssh_port', 'ssh_key_secret', 's3_reachable'])
      .where('agent_id', '=', agentId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      agentId: row.agent_id,
      address: row.address,
      sshUser: row.ssh_user,
      sshPort: row.ssh_port,
      sshKeySecret: row.ssh_key_secret,
      s3Reachable: row.s3_reachable,
    };
  }

  async get(agentId: string): Promise<HostRosterRow | null> {
    const row = await this.db
      .selectFrom('host_roster')
      .selectAll()
      .where('agent_id', '=', agentId)
      .executeTakeFirst();
    return row ?? null;
  }

  /**
   * Record the agent-payload version staged onto a host (bring-up or fleet
   * re-stage), under a reserved key, so the convergence gate compares it to the
   * target INDEPENDENTLY of the agent's self-reported version (two payloads can
   * share a self-report but differ in staged key). Shallow-merged, so it survives
   * an agent re-register (the agent's reserved keys are stripped).
   */
  async recordStagedVersion(agentId: string, version: string): Promise<void> {
    const patch = JSON.stringify({ [STAGED_AGENT_VERSION_KEY]: version });
    await this.db
      .updateTable('host_roster')
      .set({
        host_properties: sql`COALESCE(host_roster.host_properties, '{}'::jsonb) || ${patch}::jsonb`,
        updated_at: sql`now()`,
      })
      .where('agent_id', '=', agentId)
      .execute();
  }

  /** Read a host's recorded staged agent-payload version, or null when never staged. */
  async getStagedVersion(agentId: string): Promise<string | null> {
    const row = await this.get(agentId);
    if (!row) return null;
    const value = parseHostProperties(row.host_properties)[STAGED_AGENT_VERSION_KEY];
    return typeof value === 'string' ? value : null;
  }

  async listAll(): Promise<HostRosterRow[]> {
    return this.db.selectFrom('host_roster').selectAll().orderBy('agent_id', 'asc').execute();
  }

  /** Every confirmed roster row (agent- or operator-set identity), by agent id. */
  private async listConfirmed(): Promise<HostRosterRow[]> {
    return this.db
      .selectFrom('host_roster')
      .selectAll()
      .where('identity_source', '!=', HostIdentitySource.platform)
      .orderBy('agent_id', 'asc')
      .execute();
  }

  /**
   * Resolve EVERY roster host matching a label predicate (OR-of-AND include
   * groups, minus exclude labels), with derived status. Declared-but-absent
   * static hosts come back `unreachable` so a caller can apply `onUnreachable`;
   * the live registry alone cannot name them.
   *
   * The INVENTORY query: it includes auto-scaler hosts, told apart by the
   * `lifecycleClass` `ctx.kici.inventory` exposes. `runsOnAll` fan-out uses
   * {@link findFanoutTargets} instead.
   */
  async findMatching(
    include: readonly (readonly LabelMatcher[])[],
    exclude: readonly LabelMatcher[],
    graceMs: number,
  ): Promise<MatchedHost[]> {
    return this.matchRows(include, exclude, graceMs, false);
  }

  /**
   * The `runsOnAll` fan-out targets: {@link findMatching} minus every
   * auto-scaler host. Fan-out targets DECLARED fleet members: a scaler agent
   * has a pool's fixed shape, so a child pinned to one runs at that shape — the
   * defect the dispatcher's warm-pool suitability gate removes, on the path a
   * pin deliberately leaves ungated.
   *
   * Separate on purpose: `findMatching` also backs `inventory.query`, where a
   * selector must never return FEWER hosts than no selector at all.
   */
  async findFanoutTargets(
    include: readonly (readonly LabelMatcher[])[],
    exclude: readonly LabelMatcher[],
    graceMs: number,
  ): Promise<MatchedHost[]> {
    return this.matchRows(include, exclude, graceMs, true);
  }

  /**
   * Shared row loop. `excludeScalerManaged` stays private so a call site cannot
   * pick the wrong population by passing a bare boolean.
   */
  private async matchRows(
    include: readonly (readonly LabelMatcher[])[],
    exclude: readonly LabelMatcher[],
    graceMs: number,
    excludeScalerManaged: boolean,
  ): Promise<MatchedHost[]> {
    // A dashboard-declared row is an unconfirmed placeholder: never a target
    // until its agent or an operator confirms it.
    const rows = await this.db
      .selectFrom('host_roster')
      .selectAll()
      .where('identity_source', '!=', HostIdentitySource.platform)
      .execute();
    const now = Date.now();
    const out: MatchedHost[] = [];
    for (const row of rows) {
      if (excludeScalerManaged && row.scaler_managed) continue;
      // Fold on read rather than migrating rows written before canonicalization.
      const labels = canonicalizeLabels(JSON.parse(row.labels) as string[]);
      const set = new Set(labels);
      if (exclude.some((e) => matcherSatisfiedBy(canonicalizeMatcher(e), set))) continue;
      if (
        include.length &&
        !include.some((grp) => grp.every((m) => matcherSatisfiedBy(canonicalizeMatcher(m), set)))
      )
        continue;
      out.push({
        agentId: row.agent_id,
        // Only the hostname branch folds. The `?? agent_id` fallback carries an
        // opaque identifier, and `matchHostPattern` skips its host arm exactly
        // when `host === agentId` — folding here would defeat that guard.
        host: canonicalizeHostname(row.hostname) ?? row.agent_id,
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
   * Map a roster row to the {@link HostInventoryEntry} the `inventory.query` /
   * `inventory.get` RPC returns and `ctx.kici.inventory` types. Status derives
   * as in `findMatching`.
   */
  toInventoryEntry(row: HostRosterRow, graceMs: number): HostInventoryEntry {
    return {
      agentId: row.agent_id,
      // Folded as in `matchRows`, so an old row answers a canonical selector.
      labels: canonicalizeLabels(JSON.parse(row.labels) as string[]),
      properties: parseHostProperties(row.host_properties),
      // Read fold: see canonicalizeHostname.
      hostname: canonicalizeHostname(row.hostname),
      platform: row.platform,
      arch: row.arch,
      lifecycleClass: row.lifecycle_class as LifecycleClass,
      status: deriveHostStatus(row, Date.now(), graceMs),
      lastSeen: new Date(row.last_seen).toISOString(),
    };
  }

  /**
   * Query the roster as {@link HostInventoryEntry} records. A selector reuses
   * `findMatching`'s server-side label filtering (glob/regex); property
   * filtering happens client-side in the workflow. No selector ⇒ every host.
   * Unconfirmed dashboard-declared rows are omitted.
   */
  async queryInventory(
    selector: InventorySelector | undefined,
    graceMs: number,
  ): Promise<HostInventoryEntry[]> {
    if (!selector || (!selector.include && !selector.exclude)) {
      const rows = await this.listConfirmed();
      return rows.map((r) => this.toInventoryEntry(r, graceMs));
    }
    const matched = await this.findMatching(
      selector.include ?? [],
      selector.exclude ?? [],
      graceMs,
    );
    const byId = new Map(matched.map((m) => [m.agentId, m]));
    const rows = await this.listConfirmed();
    return rows.filter((r) => byId.has(r.agent_id)).map((r) => this.toInventoryEntry(r, graceMs));
  }

  /** Single-host inventory lookup; null when the agent is absent or unconfirmed. */
  async getInventory(agentId: string, graceMs: number): Promise<HostInventoryEntry | null> {
    const row = await this.get(agentId);
    return row && row.identity_source !== HostIdentitySource.platform
      ? this.toInventoryEntry(row, graceMs)
      : null;
  }

  /** A roster row as the dashboard sees it: the inventory entry plus `confirmed`. */
  toFleetEntry(row: HostRosterRow, graceMs: number): FleetHostEntry {
    return {
      ...this.toInventoryEntry(row, graceMs),
      confirmed: row.identity_source !== HostIdentitySource.platform,
    };
  }

  /** Every roster host for the dashboard, unconfirmed placeholders included. */
  async listFleetHosts(graceMs: number): Promise<FleetHostEntry[]> {
    return (await this.listAll()).map((r) => this.toFleetEntry(r, graceMs));
  }

  /** One roster host for the dashboard, or null when the agent id has no row. */
  async getFleetHost(agentId: string, graceMs: number): Promise<FleetHostEntry | null> {
    const row = await this.get(agentId);
    return row ? this.toFleetEntry(row, graceMs) : null;
  }

  /**
   * Count `unreachable` static hosts — the declared-but-absent alarm. Uses
   * {@link deriveHostStatus} so it matches `kici-admin host list`. A
   * disconnected static host is `unreachable` regardless of grace; only the
   * connected-but-stale case depends on `graceMs`. An unconfirmed
   * dashboard-created row never raises the alarm.
   */
  async countStaticUnreachable(graceMs: number): Promise<number> {
    const rows = await this.db
      .selectFrom('host_roster')
      .selectAll()
      .where('lifecycle_class', '=', 'static')
      .where('identity_source', '!=', HostIdentitySource.platform)
      .execute();
    const now = Date.now();
    return rows.filter((r) => deriveHostStatus(r, now, graceMs) === HostStatus.unreachable).length;
  }

  /**
   * Remove a host from the roster by agent id. Returns rows deleted (0 when no
   * row matches). Under `platform` authority (the default) only an unconfirmed
   * row a dashboard declare created is removed; a confirmed row throws
   * {@link HostConfirmedError}.
   */
  async removeStatic(
    agentId: string,
    opts: { authority?: HostWriteAuthority } = {},
  ): Promise<number> {
    const authority = opts.authority ?? HostWriteAuthority.platform;
    let query = this.db.deleteFrom('host_roster').where('agent_id', '=', agentId);
    if (authority === HostWriteAuthority.platform) {
      query = query.where('identity_source', '=', HostIdentitySource.platform);
    }
    const deleted = Number((await query.executeTakeFirst()).numDeletedRows ?? 0n);
    if (deleted === 0 && authority === HostWriteAuthority.platform && (await this.get(agentId))) {
      throw new HostConfirmedError(agentId);
    }
    return deleted;
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
   * Set by the `host.requestReboot` handler when an agent's `restartHost()` step
   * runs. Until `until`, a disconnect is the expected reboot and the pinned
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
