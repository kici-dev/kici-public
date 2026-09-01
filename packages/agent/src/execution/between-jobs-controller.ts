import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { ExecutionMode, BetweenJobsRunOn } from '../config.js';
import { runBetweenJobsReset, type ResetStatus } from './between-jobs-reset.js';
import { runDeclaredCleanupOutOfBand, type CleanupRerunStatus } from './cleanup-rerun.js';
import {
  betweenJobsResetTotal,
  betweenJobsResetDurationSeconds,
  orphansReapedTotal,
  orphanCleanupTotal,
} from '../metrics/prometheus.js';

const logger = createLogger({ prefix: 'between-jobs' });

interface ControllerConfig {
  betweenJobsResetCommand?: string;
  betweenJobsResetTimeoutMs: number;
  betweenJobsResetRunOn: BetweenJobsRunOn;
  orphanCleanup: boolean;
  drainOnResetFailure: boolean;
}

export interface AfterJobContext {
  completionHooksRan: boolean;
  jobFailed: boolean;
  backend: ExecutionMode;
  declaresCleanup: boolean;
  workDir: string;
  reap: () => Promise<number>;
  deleteWorkdir: () => Promise<void>;
  cleanupSpawn?: (workDir: string, signal: AbortSignal) => Promise<void>;
}

export interface BetweenJobsOutcome {
  rerun: CleanupRerunStatus;
  reaped: number;
  reset: ResetStatus;
  consecutiveResetFailures: number;
}

/**
 * Supervisor-owned between-jobs phase for a reused (bare-metal / in-place) agent.
 * After every job it sequences: (1) out-of-band declared-cleanup re-run when the
 * runner died before its completion hooks ran, (2) process-group reap of the
 * job's descendant tree, (3) workdir deletion, (4) the operator reset command.
 * Each phase is delegated so the class stays unit-testable, and a persistently
 * failing reset can drain the agent via the consecutive-failure counter.
 */
export class BetweenJobsController {
  private _consecutiveResetFailures = 0;

  /** Consecutive between-jobs reset failures, for the supervisor's drain gate. */
  get consecutiveResetFailures(): number {
    return this._consecutiveResetFailures;
  }

  constructor(
    private deps: {
      config: ControllerConfig;
      rerun?: typeof runDeclaredCleanupOutOfBand;
      reset?: typeof runBetweenJobsReset;
    },
  ) {}

  private async runRerunPhase(ctx: AfterJobContext): Promise<CleanupRerunStatus> {
    if (ctx.completionHooksRan || !ctx.cleanupSpawn) return 'skipped';
    const rerunFn = this.deps.rerun ?? runDeclaredCleanupOutOfBand;
    const r = await rerunFn({
      workDir: ctx.workDir,
      backend: ctx.backend,
      declaresCleanup: ctx.declaresCleanup,
      timeoutMs: this.deps.config.betweenJobsResetTimeoutMs,
      spawn: ctx.cleanupSpawn,
    });
    orphanCleanupTotal.add(1, { status: r.status });
    if (r.status === 'failed' || r.status === 'timeout') {
      logger.warn('between-jobs out-of-band cleanup did not complete', { status: r.status });
    }
    return r.status;
  }

  private async runResetPhase(ctx: AfterJobContext): Promise<ResetStatus> {
    const resetFn = this.deps.reset ?? runBetweenJobsReset;
    const reset = await resetFn({
      command: this.deps.config.betweenJobsResetCommand,
      timeoutMs: this.deps.config.betweenJobsResetTimeoutMs,
      runOn: this.deps.config.betweenJobsResetRunOn,
      jobFailed: ctx.jobFailed,
    });
    if (reset.status !== 'skipped') {
      betweenJobsResetTotal.add(1, { status: reset.status });
      betweenJobsResetDurationSeconds.record(reset.durationMs / 1000);
    }
    if (reset.status === 'failed' || reset.status === 'timeout') {
      this._consecutiveResetFailures += 1;
      logger.warn('between-jobs reset failed', {
        status: reset.status,
        consecutive: this._consecutiveResetFailures,
      });
    } else if (reset.status === 'success') {
      this._consecutiveResetFailures = 0;
    }
    return reset.status;
  }

  async afterJob(ctx: AfterJobContext): Promise<BetweenJobsOutcome> {
    // Each phase is isolated: an earlier phase failing (a rejected reap or
    // workdir delete) must NOT skip the operator reset — leaving host state
    // un-reset is exactly the residue this phase exists to prevent.

    // 1. Out-of-band declared cleanup, only when the runner died before it ran.
    let rerun: CleanupRerunStatus = 'skipped';
    try {
      rerun = await this.runRerunPhase(ctx);
    } catch (err) {
      logger.warn('between-jobs out-of-band cleanup threw', { error: toErrorMessage(err) });
    }

    // 2. Reap the job's process group (bare-metal), unless disabled.
    let reaped = 0;
    if (this.deps.config.orphanCleanup) {
      try {
        reaped = await ctx.reap();
        if (reaped > 0) orphansReapedTotal.add(reaped);
      } catch (err) {
        logger.warn('between-jobs reap threw', { error: toErrorMessage(err) });
      }
    }

    // 3. Delete the (possibly preserved) workdir.
    try {
      await ctx.deleteWorkdir();
    } catch (err) {
      logger.warn('between-jobs workdir delete threw', { error: toErrorMessage(err) });
    }

    // 4. Operator reset command — always runs, regardless of earlier failures.
    const reset = await this.runResetPhase(ctx);

    return {
      rerun,
      reaped,
      reset,
      consecutiveResetFailures: this._consecutiveResetFailures,
    };
  }
}
