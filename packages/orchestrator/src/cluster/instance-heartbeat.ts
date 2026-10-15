import { sql, type Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { Database } from '../db/types.js';
import { runDetached } from '../helpers/run-detached.js';

const logger = createLogger({ prefix: 'instance-heartbeat' });

/** Default interval between `cluster_instances` heartbeat writes. */
export const DEFAULT_INSTANCE_HEARTBEAT_MS = 10_000;

/**
 * Missed ticks before a coordinator reads as dead. Six (60 s at the default
 * interval) survives a GC pause, slow DB or brief network stall; a false "dead"
 * verdict makes another coordinator recover jobs this one is watching.
 */
export const HEARTBEAT_MISSES_BEFORE_DEAD = 6;

/**
 * The dispatcher's default recovery grace: twice `agentMaxReconnectDelayMs` (60 s).
 * The fallback floor when a caller has no configured grace period.
 */
export const DEFAULT_RECOVERY_GRACE_MS = 120_000;

/**
 * Window inside which a `cluster_instances` row counts as live: the larger of the
 * recovery grace and six ticks, so the ownership predicate never calls a
 * coordinator dead sooner than recovery would have let it reconnect.
 */
export function instanceLivenessGraceMs(
  gracePeriodMs: number,
  heartbeatMs: number = DEFAULT_INSTANCE_HEARTBEAT_MS,
): number {
  return Math.max(gracePeriodMs, heartbeatMs * HEARTBEAT_MISSES_BEFORE_DEAD);
}

/**
 * Whether `instanceId` has a `cluster_instances` heartbeat inside `graceMs`:
 * the same liveness the dispatch plane's ownership predicate reads.
 */
export async function isInstanceLive(
  db: Kysely<Database>,
  instanceId: string,
  graceMs: number,
): Promise<boolean> {
  const row = await db
    .selectFrom('cluster_instances')
    .select('instance_id')
    .where('instance_id', '=', instanceId)
    .where(
      sql<boolean>`last_heartbeat_at > NOW() - ${sql.lit(Math.max(0, Math.round(graceMs)))} * INTERVAL '1 millisecond'`,
    )
    .executeTakeFirst();
  return row !== undefined;
}

export interface InstanceHeartbeatOptions {
  db: Kysely<Database>;
  instanceId: string;
  /** Interval between writes. Defaults to {@link DEFAULT_INSTANCE_HEARTBEAT_MS}. */
  intervalMs?: number;
  /** Orchestrator version, recorded for operator visibility. */
  version?: string;
  /** Reads the current Raft role, when the node runs Raft. */
  getRole?: () => string | null;
}

/**
 * Writes this coordinator's liveness into `cluster_instances` on a fixed tick.
 *
 * Dispatch-plane ownership predicates ("is this row's owner alive?") must read the
 * DB. The in-memory peer registry is empty when startup recovery runs (no peer
 * handshakes yet), so it reads every live sibling as dead — the boot-time bug the
 * predicate exists to fix. Raft membership is worse: a partitioned coordinator
 * self-elects and reads the other half as gone.
 *
 * A DB heartbeat needs no peer connectivity, so it behaves the same in Raft,
 * plain multi-coordinator and standalone deployments — the mechanism
 * `host_roster` uses for agent liveness.
 */
export class InstanceHeartbeat {
  private readonly db: Kysely<Database>;
  private readonly instanceId: string;
  private readonly intervalMs: number;
  private readonly version: string | null;
  private readonly getRole?: () => string | null;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: InstanceHeartbeatOptions) {
    this.db = opts.db;
    this.instanceId = opts.instanceId;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INSTANCE_HEARTBEAT_MS;
    this.version = opts.version ?? null;
    this.getRole = opts.getRole;
  }

  /**
   * Write one heartbeat immediately, then every `intervalMs`. The immediate write
   * matters: startup recovery reads this table moments after boot, and a
   * coordinator with no row yet is invisible to its siblings' predicates.
   */
  async start(): Promise<void> {
    await this.beat({ processStart: true });
    this.timer = setInterval(() => {
      runDetached(logger, 'Coordinator heartbeat', () => this.beat(), {
        instanceId: this.instanceId,
      });
    }, this.intervalMs);
    this.timer.unref?.();
    logger.info('Coordinator heartbeat started', {
      instanceId: this.instanceId,
      intervalMs: this.intervalMs,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Delete this row on clean shutdown so siblings see it dead immediately, not
   * after the grace window. Best-effort: a crash leaves the row to expire.
   */
  async retire(): Promise<void> {
    this.stop();
    try {
      await this.db
        .deleteFrom('cluster_instances')
        .where('instance_id', '=', this.instanceId)
        .execute();
    } catch (err) {
      logger.warn('Coordinator heartbeat retire failed', {
        instanceId: this.instanceId,
        error: toErrorMessage(err),
      });
    }
  }

  /**
   * One heartbeat write. Best-effort: a failed tick is retried on the next.
   * Only `start()`'s write (`processStart`) rewrites `started_at`, which records
   * when THIS process came up: a restart under the same id moves it, a tick does not.
   */
  async beat(opts: { processStart?: boolean } = {}): Promise<void> {
    const now = new Date();
    const role = this.getRole?.() ?? null;
    try {
      await this.db
        .insertInto('cluster_instances')
        .values({
          instance_id: this.instanceId,
          role,
          version: this.version,
          started_at: now,
          last_heartbeat_at: now,
        })
        .onConflict((oc) =>
          oc.column('instance_id').doUpdateSet({
            role,
            version: this.version,
            last_heartbeat_at: now,
            ...(opts.processStart === true ? { started_at: now } : {}),
          }),
        )
        .execute();
    } catch (err) {
      logger.warn('Coordinator heartbeat write failed', {
        instanceId: this.instanceId,
        error: toErrorMessage(err),
      });
    }
  }
}

/**
 * Which of the given coordinator ids are alive now. Reads `cluster_instances`, not
 * the peer registry (empty at boot, blind under a partition — see the class above):
 * a wrong "dead" verdict means acting on a row a working coordinator owns.
 */
export async function liveInstanceIds(
  db: Kysely<Database>,
  instanceIds: readonly string[],
  graceMs: number,
): Promise<Set<string>> {
  const unique = [...new Set(instanceIds)];
  if (unique.length === 0) return new Set();
  const cutoff = new Date(Date.now() - Math.max(0, graceMs));
  const rows = await db
    .selectFrom('cluster_instances')
    .select(['instance_id'])
    .where('instance_id', 'in', unique)
    .where('last_heartbeat_at', '>', cutoff)
    .execute();
  return new Set(rows.map((r) => r.instance_id));
}
