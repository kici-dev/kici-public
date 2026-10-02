/**
 * The spawn-retry budget a worker applies to each job a coordinator rerouted to it.
 *
 * A worker whose agent spawn fails retries, but only `maxAttempts` times and with
 * `backoffMs` between attempts, so the coordinator that owns the run can tell
 * "still trying" from "gave up". The coordinator sends the budget on `job.reroute`,
 * and the verdict for each failure rides back on the relayed `scaler.failed` as
 * `final`. One entry per rerouted job, created before the job is dispatched and
 * released when the job leaves this worker's queue.
 */
import { z } from 'zod';
import type { RerouteSpawnRetry } from '@kici-dev/engine';
import { toErrorMessage } from '@kici-dev/shared';

/** The answer to "may this job start a spawn now?". */
export const SpawnAttemptGate = z.enum([
  'untracked',
  'begun',
  'in-flight',
  'backoff',
  'not-queued',
]);
export type SpawnAttemptGate = z.infer<typeof SpawnAttemptGate>;

/** The budget's verdict on one spawn failure. */
export type FailureVerdict =
  | { tracked: false }
  | { tracked: true; final: boolean; failures: number; maxAttempts: number; duplicate: boolean };

export interface SpawnRetryBudgetDeps {
  /** True while the job waits in the worker's queue (not claimed, not stopped). */
  isQueued: (jobId: string) => boolean;
  /** Offer one pending job to the scaler again. */
  redrive: (jobId: string) => Promise<unknown>;
  logger: {
    debug(message: string, meta?: object): unknown;
    info(message: string, meta?: object): unknown;
    warn(message: string, meta?: object): unknown;
  };
  now?: () => number;
}

interface Entry {
  runId: string;
  policy: RerouteSpawnRetry;
  /** Agents whose spawn failed. A set, because some backends report one failure twice. */
  failedAgents: Set<string>;
  inFlight: boolean;
  /**
   * The agent the in-flight attempt is spawning, once the scaler named it. Only
   * its failure is charged: an earlier spawn that fails late (its job went to
   * another agent and came back) holds no attempt.
   */
  holder: string | undefined;
  backoffUntil: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class SpawnRetryBudget {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(private readonly deps: SpawnRetryBudgetDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Start tracking a rerouted job. A second call for the same job keeps the first entry. */
  register(jobId: string, runId: string, policy: RerouteSpawnRetry): void {
    if (this.entries.has(jobId)) return;
    this.entries.set(jobId, {
      runId,
      policy,
      failedAgents: new Set(),
      inFlight: false,
      holder: undefined,
      backoffUntil: 0,
      timer: undefined,
    });
  }

  /** Claim the right to start one spawn. Synchronous, so two callers cannot both win. */
  beginAttempt(jobId: string): SpawnAttemptGate {
    const entry = this.entries.get(jobId);
    if (!entry) return SpawnAttemptGate.enum.untracked;
    if (!this.deps.isQueued(jobId)) return SpawnAttemptGate.enum['not-queued'];
    if (entry.inFlight) return SpawnAttemptGate.enum['in-flight'];
    if (this.now() < entry.backoffUntil) return SpawnAttemptGate.enum.backoff;
    entry.inFlight = true;
    return SpawnAttemptGate.enum.begun;
  }

  /**
   * Record the agent the claimed attempt is spawning. Ignored when the attempt is
   * no longer in flight, or when that agent's failure already arrived.
   */
  setHolder(jobId: string, agentId: string): void {
    const entry = this.entries.get(jobId);
    if (!entry?.inFlight || entry.holder !== undefined || entry.failedAgents.has(agentId)) return;
    entry.holder = agentId;
  }

  /** The claimed attempt started no spawn (at capacity, no backend, skipped). */
  abortAttempt(jobId: string): void {
    const entry = this.entries.get(jobId);
    if (!entry) return;
    entry.inFlight = false;
    entry.holder = undefined;
  }

  /**
   * The claimed attempt started no spawn because the scaler is deferring for
   * `delayMs`. Nothing is charged; the job is offered to the scaler again when
   * the deferral ends. Without this a worker, which has no periodic pending
   * sweep, would ask once during the deferral and never again, and the
   * coordinator's spawn window would run out on an attempt the budget still
   * holds.
   */
  deferAttempt(jobId: string, delayMs: number): void {
    const entry = this.entries.get(jobId);
    if (!entry) return;
    this.abortAttempt(jobId);
    this.scheduleRedrive(jobId, entry, delayMs);
  }

  /** An agent received the job. The budget stays in place in case the job is requeued. */
  onDelivered(jobId: string): void {
    this.abortAttempt(jobId);
  }

  /**
   * Count one failed spawn. A failure for a job no longer queued is not a spawn
   * failure (an agent already took the job), so it is untracked. Only the spawn
   * holding the attempt gate is charged: a failure from any other agent (a
   * superseded spawn failing late) is untracked and leaves the gate held. While
   * the scaler has not yet named the in-flight agent, the in-flight attempt is
   * the only one that can fail, so its failure is charged. On a non-final
   * failure the backoff starts, and its timer offers the job to the scaler again.
   */
  recordFailure(jobId: string, agentId: string): FailureVerdict {
    const entry = this.entries.get(jobId);
    if (!entry || !this.deps.isQueued(jobId)) return { tracked: false };
    const { maxAttempts } = entry.policy;
    const duplicate = entry.failedAgents.has(agentId);
    if (!duplicate) {
      const holdsGate = entry.inFlight && (entry.holder === undefined || entry.holder === agentId);
      if (!holdsGate) {
        this.deps.logger.debug(`Ignoring a superseded spawn's failure for a rerouted job`, {
          runId: entry.runId,
          jobId,
          agentId,
          holder: entry.holder ?? null,
        });
        return { tracked: false };
      }
      entry.failedAgents.add(agentId);
      entry.inFlight = false;
      entry.holder = undefined;
    }
    const failures = entry.failedAgents.size;
    const final = failures >= maxAttempts;
    if (!final && !duplicate) this.armBackoff(jobId, entry);
    return { tracked: true, final, failures, maxAttempts, duplicate };
  }

  /** The job left the queue: terminal, stopped, or given back. */
  release(jobId: string): void {
    const entry = this.entries.get(jobId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.entries.delete(jobId);
  }

  private armBackoff(jobId: string, entry: Entry): void {
    this.scheduleRedrive(jobId, entry, entry.policy.backoffMs);
  }

  /** Gate new attempts for `delayMs`, then offer the job to the scaler again. */
  private scheduleRedrive(jobId: string, entry: Entry, delayMs: number): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.backoffUntil = this.now() + delayMs;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.entries.get(jobId) !== entry) return;
      this.deps.logger.info('Retrying spawn for a rerouted job after backoff', {
        runId: entry.runId,
        jobId,
        attempt: entry.failedAgents.size + 1,
        maxAttempts: entry.policy.maxAttempts,
      });
      this.deps.redrive(jobId).catch((err: unknown) => {
        this.deps.logger.warn('Rerouted job spawn retry failed', {
          runId: entry.runId,
          jobId,
          error: toErrorMessage(err),
        });
      });
    }, delayMs);
  }
}
