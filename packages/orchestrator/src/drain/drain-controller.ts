/**
 * Owns the coordinator's ephemeral "draining" state for pre-upgrade quiescing.
 *
 * While draining, the Dispatcher routes every new job to the Pending queue
 * (Model A / job-level drain), the peer heartbeat advertises `draining: true`
 * (siblings stop rerouting here), and the scaler stops spawning agents.
 * Executing jobs finish; once `jobsRunning()` drops monotonically to zero the
 * coordinator is safe to restart.
 *
 * State is in-memory only: an upgrade restart comes back accepting and startup
 * recovery re-dispatches the Pending backlog.
 */
export interface DrainControllerDeps {
  /** Sum of activeJobs across connected agents. */
  activeJobsTotal: () => number;
  /**
   * Count of Dispatched dispatch_queue rows: this instance's in-flight jobs on a
   * single coordinator. dispatch_queue has no per-instance ownership column, so
   * a multi-coordinator cluster may over-count; this is belt-and-suspenders
   * behind `activeJobsTotal`, and both shrink monotonically once the dispatcher
   * gate stops new claims.
   */
  dispatchedJobsOwned: () => Promise<number>;
  /** Fired when the draining flag changes (drives `kici_orchestrator_draining`), not on a no-op. */
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
   * Live quiesce signal covering executing jobs and claimed (Dispatched) rows
   * whose activeJobs increment has not landed yet. Draining stops new claims,
   * so a poll converges to zero. `Math.max`, not a sum: both views count the
   * same jobs, so summing double-counts the common case.
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
