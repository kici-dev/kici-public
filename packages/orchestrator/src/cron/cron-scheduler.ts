import { Cron } from 'croner';
import type { Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { LockScheduleTrigger } from '@kici-dev/engine';

import type { Database } from '../db/types.js';
import type { RegistrationIndex, RegisteredWorkflow } from '../registration/registration-index.js';
import type { EventRouter } from '../events/event-router.js';
import type { CronStore } from './cron-store.js';

const logger = createLogger({ prefix: 'cron-scheduler' });

interface CronSchedulerOptions {
  db: Kysely<Database>;
  registrationIndex: RegistrationIndex;
  cronStore: CronStore;
  eventRouter: EventRouter;
  evaluationIntervalMs?: number; // default 30_000 (30s)
}

/**
 * Raft-leader-only cron evaluator.
 *
 * Only the current Raft leader evaluates cron schedules. On becoming leader,
 * loads the last-fired cache from the DB, recovers missed schedules (fires
 * once per schedule), then starts periodic evaluation.
 *
 * On losing leadership, stops evaluation immediately.
 *
 * Atomicity: each fire wraps `cronStore.tryClaimFire` and
 * `eventRouter.emitInTx` in a single Postgres transaction. `pg_notify`
 * inside that tx is queued by Postgres until commit, so a rollback discards
 * both the `cron_last_fired` write AND the listener notification together.
 * This closes the previous silent-loss window where a crash between claim
 * and emit advanced `last_fired_at` without persisting an event row.
 */
export class CronScheduler {
  private readonly db: Kysely<Database>;
  private readonly registrationIndex: RegistrationIndex;
  private readonly cronStore: CronStore;
  private readonly eventRouter: EventRouter;
  private readonly evaluationIntervalMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private isLeader = false;
  private lastFiredCache = new Map<string, Date>();

  constructor(options: CronSchedulerOptions) {
    this.db = options.db;
    this.registrationIndex = options.registrationIndex;
    this.cronStore = options.cronStore;
    this.eventRouter = options.eventRouter;
    this.evaluationIntervalMs = options.evaluationIntervalMs ?? 30_000;
  }

  /**
   * Called when this orchestrator becomes the Raft leader.
   * Loads last-fired cache, recovers missed schedules, starts periodic evaluation.
   */
  async onBecomeLeader(): Promise<void> {
    // Clear any existing timer from a previous leader tenure to prevent leaks
    // during rapid leader transitions (async onBecomeLeader may overlap with
    // onLoseLeadership + a second onBecomeLeader)
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.isLeader = true;
    this.lastFiredCache = await this.cronStore.getAll();

    logger.info('Became leader, loaded cron cache', {
      cachedSchedules: this.lastFiredCache.size,
    });

    await this.recoverMissedSchedules();

    this.timer = setInterval(() => {
      this.evaluate().catch((err) => {
        logger.error('Cron evaluation failed', {
          error: toErrorMessage(err),
        });
      });
    }, this.evaluationIntervalMs);
  }

  /**
   * Called when this orchestrator loses Raft leadership.
   * Stops the evaluation timer immediately.
   */
  onLoseLeadership(): void {
    this.isLeader = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('Lost leadership, stopped cron evaluation');
  }

  /**
   * Stop the scheduler entirely. Clears timer and resets leader state.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isLeader = false;
  }

  /**
   * Reload the last-fired cache from the database.
   * Called after registration changes as defense-in-depth to ensure
   * the in-memory cache stays current even if registration IDs change.
   */
  async refreshCache(): Promise<void> {
    this.lastFiredCache = await this.cronStore.getAll();
    logger.info('Refreshed cron last-fired cache', {
      cachedSchedules: this.lastFiredCache.size,
    });
  }

  /**
   * Evaluate all cron schedules and fire those that are due.
   *
   * For each schedule: uses croner to compute the most recent past scheduled
   * time. If that time is after the last-fired-at (or no last-fired exists),
   * fires the schedule.
   */
  async evaluate(): Promise<void> {
    if (!this.isLeader) return;

    const schedules = this.registrationIndex.getCronSchedules();
    if (schedules.length === 0) return;

    for (const registration of schedules) {
      await this.evaluateRegistration(registration, false);
    }
  }

  /**
   * Recover missed schedules after becoming leader.
   * Same logic as evaluate() but logs recovery context.
   */
  private async recoverMissedSchedules(): Promise<void> {
    const schedules = this.registrationIndex.getCronSchedules();
    if (schedules.length === 0) {
      logger.info('No cron schedules to recover');
      return;
    }

    logger.info('Recovering missed cron schedules', { count: schedules.length });

    for (const registration of schedules) {
      await this.evaluateRegistration(registration, true);
    }
  }

  /**
   * Evaluate a single registration and fire if due.
   */
  private async evaluateRegistration(
    registration: RegisteredWorkflow,
    isRecovery: boolean,
  ): Promise<void> {
    // Bail if leadership was lost mid-recovery or between evaluations
    if (!this.isLeader) return;

    // Find the schedule trigger in the lock entry
    const scheduleTrigger = registration.lockEntry.triggers.find(
      (t): t is LockScheduleTrigger => t._type === 'schedule',
    );

    if (!scheduleTrigger) return;

    const { cronExpression, timezone } = scheduleTrigger;

    try {
      const cron = new Cron(cronExpression, { timezone: timezone || undefined });

      // croner@10's `previousRuns(1)` THROWS (TypeError, "Cannot read
      // properties of undefined (reading '0')") for cron expressions whose
      // pattern can never resolve — e.g. '0 0 31 2 *' (Feb 31 doesn't
      // exist), used intentionally as a "manual-dispatch only, never
      // auto-fires" idiom. Catch that specific throw and treat it as "no
      // previous run" instead of letting the outer catch log it as
      // `Failed to evaluate cron schedule` once per evaluation tick.
      let previousRun: Date | undefined;
      try {
        [previousRun] = cron.previousRuns(1);
      } catch {
        return; // Impossible cron — never auto-fires.
      }

      if (!previousRun) return; // No previous scheduled time exists

      const lastFiredAt = this.lastFiredCache.get(registration.id);

      // Only fire if the previous scheduled time is after the last-fired time
      // (or if we've never fired this schedule)
      if (lastFiredAt && previousRun.getTime() <= lastFiredAt.getTime()) {
        return; // Already fired for this or a more recent scheduled time
      }

      if (isRecovery) {
        logger.info('Recovering missed schedule', {
          workflowName: registration.workflowName,
          cronExpression,
          timezone,
          scheduledAt: previousRun.toISOString(),
          lastFiredAt: lastFiredAt?.toISOString() ?? null,
        });
      }

      // Atomically claim this fire AND emit the event in a single
      // transaction. Closing the previous silent-loss window where:
      //   tryClaimFire commits → process killed → eventRouter.emit never
      //   runs → next leader sees lastFiredAt == previousRun and skips.
      //
      // pg_notify issued inside a tx is queued by Postgres until commit,
      // so a rollback discards both the cron_last_fired write AND the
      // notification together. Multi-orchestrator dedup is preserved by
      // the same WHERE last_fired_at < firedAt guard inside tryClaimFire.
      let claimed = false;
      let eventId: string | null = null;
      try {
        await this.db.transaction().execute(async (tx) => {
          claimed = await this.cronStore.tryClaimFire(registration.id, previousRun, tx);
          if (!claimed) return;

          eventId = await this.eventRouter.emitInTx(
            {
              eventName: '__schedule_fire',
              payload: {
                cronExpression,
                timezone,
                registrationId: registration.id,
                workflowName: registration.workflowName,
                routingKey: registration.routingKey,
                repoIdentifier: registration.repoIdentifier,
                scheduledAt: previousRun.toISOString(),
                // Pass registration commit SHA so downstream run creation can
                // associate the cron-triggered run with the commit that
                // registered the workflow.
                ...(registration.commitSha && { commitSha: registration.commitSha }),
                ...(registration.sourceFile && { sourceFile: registration.sourceFile }),
              },
              sourceRepo: registration.repoIdentifier,
            },
            tx,
          );
        });
      } catch (txErr) {
        // Transaction rolled back -- both the claim and the emit are gone.
        // Do NOT update lastFiredCache: the next tick will re-evaluate and
        // fire cleanly. This is the desired at-least-once behaviour.
        logger.error('Cron fire transaction rolled back; will retry on next tick', {
          workflowName: registration.workflowName,
          cronExpression,
          scheduledAt: previousRun.toISOString(),
          error: toErrorMessage(txErr),
        });
        return;
      }

      if (!claimed) {
        logger.info('Cron fire already claimed by another node', {
          workflowName: registration.workflowName,
          cronExpression,
          scheduledAt: previousRun.toISOString(),
        });
        this.lastFiredCache.set(registration.id, previousRun);
        return;
      }

      // Tx committed: claim AND emit are durable.
      this.lastFiredCache.set(registration.id, previousRun);

      logger.info('Cron schedule fired', {
        workflowName: registration.workflowName,
        cronExpression,
        scheduledAt: previousRun.toISOString(),
        eventId,
      });
    } catch (err) {
      logger.error('Failed to evaluate cron schedule', {
        workflowName: registration.workflowName,
        cronExpression,
        error: toErrorMessage(err),
      });
    }
  }
}
