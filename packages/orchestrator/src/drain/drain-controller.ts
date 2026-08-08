/**
 * Owns the coordinator's ephemeral "draining" state for pre-upgrade quiescing.
 *
 * While draining, the Dispatcher routes every new job to the Pending queue
 * (Model A / job-level drain), the peer heartbeat advertises `draining: true`
 * (siblings stop rerouting here), and the scaler stops spawning fresh agents.
 * Jobs already executing on agents finish; `jobsRunning()` drops monotonically
 * to zero, at which point the coordinator is quiesced and safe to restart.
 *
 * State is in-memory only: an upgrade restart comes back accepting and the
 * existing startup recovery re-dispatches the Pending backlog.
 */
export interface DrainControllerDeps {
  /** Sum of activeJobs across all connected agents (agentRegistry). */
  activeJobsTotal: () => number;
  /**
   * Count of dispatch_queue rows in Dispatched status. In the single-coordinator
   * drain-before-upgrade scenario this equals this instance's in-flight jobs; a
   * per-instance ownership column does not exist on dispatch_queue, so a
   * multi-coordinator cluster may over-count here (belt-and-suspenders only —
   * `activeJobsTotal` is the primary signal, and both shrink monotonically once
   * the dispatcher gate stops new claims).
   */
  dispatchedJobsOwned: () => Promise<number>;
  /**
   * Optional hook fired whenever the draining flag changes, used to drive the
   * `kici_orchestrator_draining` metric. Not fired on a no-op (idempotent) call.
   */
  onChange?: (draining: boolean) => void;
}

export class DrainController {
  private draining = false;

  constructor(private readonly deps: DrainControllerDeps) {}

  isDraining(): boolean {
    return this.draining;
  }

  startDrain(): void {
    if (this.draining) return;
    this.draining = true;
    this.deps.onChange?.(true);
  }

  stopDrain(): void {
    if (!this.draining) return;
    this.draining = false;
    this.deps.onChange?.(false);
  }

  /**
   * Live quiesce signal: jobs currently executing on agents versus any row this
   * instance already claimed (Dispatched) but whose activeJobs increment has not
   * yet landed. Since draining stops new claims, this set only shrinks, so a
   * poll on it is guaranteed to converge to zero. Uses `Math.max` (not sum) — the
   * Dispatched rows are the durable view of the same jobs the in-memory
   * activeJobs counts, so summing would double-count the common case.
   */
  async jobsRunning(): Promise<number> {
    const active = this.deps.activeJobsTotal();
    const dispatched = await this.deps.dispatchedJobsOwned();
    return Math.max(active, dispatched);
  }

  async snapshot(): Promise<{ draining: boolean; jobsRunning: number }> {
    return { draining: this.draining, jobsRunning: await this.jobsRunning() };
  }
}
