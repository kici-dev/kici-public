import type { Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { Database } from '../db/types.js';

const logger = createLogger({ prefix: 'instance-heartbeat' });

/** Default interval between `cluster_instances` heartbeat writes. */
export const DEFAULT_INSTANCE_HEARTBEAT_MS = 10_000;

/**
 * How many missed ticks a coordinator gets before it reads as dead. Six ticks
 * (60 s at the default interval) is wide enough that a GC pause, a slow DB or a
 * brief network stall does not evict a healthy coordinator — the cost of a
 * false "dead" verdict is another coordinator recovering jobs it is watching.
 */
export const HEARTBEAT_MISSES_BEFORE_DEAD = 6;

/**
 * The dispatcher's recovery grace period at the default config: twice
 * `agentMaxReconnectDelayMs` (60 s). Used as the fallback floor when a caller
 * has no configured grace period to hand in.
 */
export const DEFAULT_RECOVERY_GRACE_MS = 120_000;

/**
 * The window inside which a `cluster_instances` row counts as live.
 *
 * Deliberately the larger of the recovery grace period and six heartbeat ticks:
 * the ownership predicate must never call a coordinator dead sooner than the
 * recovery machinery would have given it to reconnect.
 */
export function instanceLivenessGraceMs(
  gracePeriodMs: number,
  heartbeatMs: number = DEFAULT_INSTANCE_HEARTBEAT_MS,
): number {
  return Math.max(gracePeriodMs, heartbeatMs * HEARTBEAT_MISSES_BEFORE_DEAD);
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
 * Every ownership predicate in the dispatch plane asks "is the coordinator that
 * owns this row still alive?", and the answer has to come from the database.
 * The in-memory peer registry cannot answer it: it is empty at exactly the
 * moment startup recovery runs, because a freshly booted process has not
 * handshaken with any peer yet, so it reads every live sibling as dead — which
 * is the boot-time bug the predicate exists to fix. Raft membership is worse:
 * a partitioned coordinator self-elects and reads the other half as gone.
 *
 * A DB heartbeat needs no peer connectivity, so it behaves the same in a
 * Raft cluster, a plain multi-coordinator deployment and a standalone one.
 * `host_roster` already derives agent liveness this way; this is the same
 * mechanism pointed at coordinators.
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
   * Write one heartbeat immediately, then every `intervalMs`.
   *
   * The immediate write matters: startup recovery runs moments after boot and
   * reads this table, so a coordinator that had not yet written a row would be
   * invisible to its own siblings' predicates.
   */
  async start(): Promise<void> {
    await this.beat({ processStart: true });
    this.timer = setInterval(() => {
      void this.beat();
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
   * Remove this instance's row on a clean shutdown, so a coordinator that
   * stopped on purpose is dead to its siblings immediately rather than after
   * the grace window. Best-effort: a crash leaves the row to expire.
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
   *
   * `processStart` is set for the write `start()` makes, and is the only one
   * that rewrites `started_at` — the column records when THIS process came up,
   * so a restart under the same instance id must move it while an ordinary tick
   * must not.
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
 * Which of the given coordinator instance ids are alive right now.
 *
 * Reads `cluster_instances` directly rather than the peer registry, for the
 * reason the class above documents: the peer registry is empty during boot and
 * blind under a partition, and a wrong "dead" verdict here means acting on a
 * row a working coordinator owns.
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
