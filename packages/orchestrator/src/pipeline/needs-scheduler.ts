/**
 * DB-backed needs-aware dispatch scheduler.
 *
 * Gates ALL needs edges (static-to-static, static-to-dyn-group, dyn-to-static,
 * dyn-to-dyn) with event-driven scheduling instead of concurrent dispatch.
 *
 * The scheduler is pure DB — no in-memory state. Every scheduling decision is
 * a fresh DB query against execution_jobs + execution_job_needs. This means
 * zero recovery code on orchestrator restart.
 *
 * Each edge carries a `run_on` status-set (the upstream terminal statuses that
 * satisfy the edge). A downstream edge is dispatch-satisfied when the upstream's
 * terminal status is a member of the edge's run_on set; otherwise the downstream
 * is skipped. A downstream dispatches only when every edge is satisfied.
 *
 * Entry points:
 * - insertEdgesForRun: called at run start for static-to-static edges
 * - resolveGroupEdges: called on dynamic-eval completion
 * - evaluateDownstreams: called from onJobStatus(terminal)
 * - recomputeNeedsSatisfied: batch recompute after group resolution
 * - checkSchedulerInvariant: defensive stuck-job check
 * - getFailurePropagationTargets: cascade for transitive skip
 */

import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { TERMINAL_JOB_STATES, ExecutionJobStatus } from '@kici-dev/engine';
import type { NeedsEntry, NeedsGroupEntry, MaterializedJob } from '@kici-dev/engine';

/** Result of evaluating downstream jobs after an upstream completes. */
export interface SchedulerResult {
  jobName: string;
  action: 'dispatch' | 'skip';
  reason?: string;
}

/** The default run-on status-set for a bare-string need (success-only). */
const SUCCESS_ONLY_RUN_ON: ExecutionJobStatus[] = [ExecutionJobStatus.enum.success];
const SUCCESS_ONLY_RUN_ON_JSON = JSON.stringify(SUCCESS_ONLY_RUN_ON);

// --- Helpers ---

/** Check if a needs entry is a NeedsEntry object (has 'name' field). */
function isNeedsEntry(entry: string | NeedsEntry | NeedsGroupEntry): entry is NeedsEntry {
  return typeof entry === 'object' && 'name' in entry && !('group' in entry);
}

/** Check if a needs entry is a NeedsGroupEntry object (has 'group' field). */
function isNeedsGroupEntry(entry: string | NeedsEntry | NeedsGroupEntry): entry is NeedsGroupEntry {
  return typeof entry === 'object' && 'group' in entry;
}

/** Parse a persisted `run_on` JSON column into a status-set for membership tests. */
function parseRunOn(json: string): Set<string> {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.length > 0) return new Set(parsed as string[]);
  } catch {
    // Malformed value falls through to the success-only default below.
  }
  return new Set(SUCCESS_ONLY_RUN_ON);
}

/**
 * Check if ALL upstreams of a job are satisfied.
 * Returns { satisfied: true, action: 'dispatch' } when every upstream is
 * terminal and its status is a member of the edge's run_on set. Returns
 * { satisfied: true, action: 'skip', reason } when an upstream is terminal but
 * its status is not in the edge's run_on set. Returns { satisfied: false } when
 * any upstream is not yet terminal.
 */
async function checkAllUpstreamsSatisfied(
  db: Kysely<Database>,
  runId: string,
  jobName: string,
): Promise<{ satisfied: boolean; action?: 'dispatch' | 'skip'; reason?: string }> {
  // Get all upstream edges for this job
  const edges = await db
    .selectFrom('execution_job_needs')
    .select(['upstream_name', 'run_on'])
    .where('run_id', '=', runId)
    .where('job_name', '=', jobName)
    .execute();

  if (edges.length === 0) {
    // No edges = no needs = satisfied
    return { satisfied: true, action: 'dispatch' };
  }

  // Get upstream job statuses
  const upstreamNames = edges.map((e) => e.upstream_name);
  const upstreamJobs = await db
    .selectFrom('execution_jobs')
    .select(['job_name', 'status'])
    .where('run_id', '=', runId)
    .where('job_name', 'in', upstreamNames)
    .execute();

  const statusMap = new Map(upstreamJobs.map((j) => [j.job_name, j.status]));

  for (const edge of edges) {
    const status = statusMap.get(edge.upstream_name);
    if (!status || !TERMINAL_JOB_STATES.has(status)) {
      // Upstream not yet terminal
      return { satisfied: false };
    }
    // Upstream is terminal — the edge is satisfied iff its status is in run_on.
    if (!parseRunOn(edge.run_on).has(status)) {
      return {
        satisfied: true,
        action: 'skip',
        reason: `upstream_unmet: ${edge.upstream_name} (${status})`,
      };
    }
  }

  return { satisfied: true, action: 'dispatch' };
}

// --- Public API ---

/**
 * Insert dependency edges at run start for static-to-static needs.
 *
 * Operates on materialized jobs (matrix-expanded children) and an expansion map
 * (base job name -> the expanded child names). An upstream reference to a base
 * name `test` that fanned into `test (a)` / `test (b)` produces one edge per
 * child, so a downstream `needs: ['test']` waits for ALL children to terminate.
 * Each materialized child likewise inherits the full upstream edge set under its
 * own expanded name.
 *
 * NeedsGroupEntry items are skipped (resolved later via resolveGroupEdges).
 * Root jobs (no needs, no dependsOnGroups) are marked needs_satisfied=true,
 * keyed by expanded name.
 */
export async function insertEdgesForRun(
  db: Kysely<Database>,
  runId: string,
  jobs: readonly MaterializedJob[],
  expansionMap: ReadonlyMap<string, readonly string[]>,
): Promise<void> {
  const edgeRows: Array<{
    run_id: string;
    job_name: string;
    upstream_name: string;
    run_on: string;
  }> = [];

  const rootJobNames: string[] = [];

  for (const job of jobs) {
    const concreteNeeds: Array<{ upstreamName: string; runOn: string }> = [];

    for (const need of job.lockJob.needs) {
      let baseName: string;
      let runOn: string;
      if (typeof need === 'string') {
        baseName = need;
        runOn = SUCCESS_ONLY_RUN_ON_JSON;
      } else if (isNeedsEntry(need)) {
        baseName = need.name;
        runOn = JSON.stringify(need.runOn ?? SUCCESS_ONLY_RUN_ON);
      } else if (isNeedsGroupEntry(need)) {
        // Skip — resolved later via resolveGroupEdges
        continue;
      } else {
        continue;
      }

      // Expand the base-name reference into one edge per expanded upstream child.
      // A non-fanned upstream maps to a single-element list ([baseName]).
      const upstreamNames = expansionMap.get(baseName) ?? [baseName];
      for (const upstreamName of upstreamNames) {
        concreteNeeds.push({ upstreamName, runOn });
      }
    }

    for (const { upstreamName, runOn } of concreteNeeds) {
      edgeRows.push({
        run_id: runId,
        job_name: job.expandedName,
        upstream_name: upstreamName,
        run_on: runOn,
      });
    }

    // Root job: no concrete needs AND no dependsOnGroups
    const hasDependsOnGroups =
      job.lockJob.dependsOnGroups && job.lockJob.dependsOnGroups.length > 0;
    if (concreteNeeds.length === 0 && !hasDependsOnGroups) {
      rootJobNames.push(job.expandedName);
    }
  }

  // Batch insert all edge rows
  if (edgeRows.length > 0) {
    await db
      .insertInto('execution_job_needs')
      .values(edgeRows)
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  // Mark root jobs as needs_satisfied=true
  if (rootJobNames.length > 0) {
    const now = new Date();
    await db
      .updateTable('execution_jobs')
      .set({ needs_satisfied: true, ready_at: now })
      .where('run_id', '=', runId)
      .where('job_name', 'in', rootJobNames)
      .execute();
  }
}

/**
 * Resolve dynamic group edges after eval completion.
 *
 * For each dependent static job and each member job name, inserts a concrete
 * edge row. Empty groups (0 members) trigger immediate needs_satisfied=true
 * for dependents.
 *
 * CRITICAL: dependentStaticJobs carries the per-job run_on status-set from the
 * NeedsGroupEntry in the lock file. Without this, all group edges would
 * silently default to success-only.
 */
export async function resolveGroupEdges(
  db: Kysely<Database>,
  runId: string,
  groupName: string,
  memberJobNames: string[],
  dependentStaticJobs: Array<{ jobName: string; runOn: ExecutionJobStatus[] }>,
): Promise<void> {
  if (memberJobNames.length > 0) {
    // Insert concrete edges: each dependent -> each member
    const edgeRows: Array<{
      run_id: string;
      job_name: string;
      upstream_name: string;
      run_on: string;
    }> = [];

    for (const dep of dependentStaticJobs) {
      for (const member of memberJobNames) {
        edgeRows.push({
          run_id: runId,
          job_name: dep.jobName,
          upstream_name: member,
          run_on: JSON.stringify(dep.runOn ?? SUCCESS_ONLY_RUN_ON),
        });
      }
    }

    if (edgeRows.length > 0) {
      await db
        .insertInto('execution_job_needs')
        .values(edgeRows)
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
  }

  // Recompute needs_satisfied for dependent jobs
  // For empty groups, this will find zero edges and mark as satisfied
  await recomputeNeedsSatisfied(
    db,
    runId,
    dependentStaticJobs.map((d) => d.jobName),
  );
}

/**
 * Evaluate downstream jobs after an upstream reaches terminal state.
 *
 * This is the core scheduler hook. For each downstream of the completed job:
 * 1. If the completed status is not in this edge's run_on set, mark the
 *    downstream as 'skip' immediately.
 * 2. Otherwise, check if ALL upstreams are terminal and satisfied.
 * 3. If all satisfied, mark needs_satisfied=true and return for dispatch.
 */
export async function evaluateDownstreams(
  db: Kysely<Database>,
  runId: string,
  completedJobName: string,
  completedStatus: string,
): Promise<SchedulerResult[]> {
  // Find all downstream jobs that depend on the completed job
  const downstreamEdges = await db
    .selectFrom('execution_job_needs')
    .select(['job_name', 'run_on'])
    .where('run_id', '=', runId)
    .where('upstream_name', '=', completedJobName)
    .execute();

  if (downstreamEdges.length === 0) {
    return [];
  }

  const results: SchedulerResult[] = [];

  // De-duplicate downstream job names (a job might have multiple edges from same upstream via groups)
  const seenJobs = new Set<string>();

  for (const edge of downstreamEdges) {
    if (seenJobs.has(edge.job_name)) continue;
    seenJobs.add(edge.job_name);

    // Quick check: if this upstream's terminal status is not in run_on, skip immediately.
    if (!parseRunOn(edge.run_on).has(completedStatus)) {
      results.push({
        jobName: edge.job_name,
        action: 'skip',
        reason: `upstream_unmet: ${completedJobName} (${completedStatus})`,
      });
      continue;
    }

    // Check ALL upstreams for this downstream job
    const check = await checkAllUpstreamsSatisfied(db, runId, edge.job_name);

    if (!check.satisfied) {
      // Not all upstreams terminal yet — skip this downstream
      continue;
    }

    if (check.action === 'skip') {
      results.push({
        jobName: edge.job_name,
        action: 'skip',
        reason: check.reason,
      });
    } else {
      // All upstreams satisfied — mark needs_satisfied and dispatch
      const now = new Date();
      await db
        .updateTable('execution_jobs')
        .set({ needs_satisfied: true, ready_at: now })
        .where('run_id', '=', runId)
        .where('job_name', '=', edge.job_name)
        .where('needs_satisfied', '=', false)
        .execute();

      results.push({
        jobName: edge.job_name,
        action: 'dispatch',
      });
    }
  }

  return results;
}

/**
 * Batch recompute needs_satisfied for specified jobs.
 * Used after group resolution and on orchestrator restart recovery.
 * Returns scheduler results for any jobs that became ready.
 */
export async function recomputeNeedsSatisfied(
  db: Kysely<Database>,
  runId: string,
  jobNames: string[],
): Promise<SchedulerResult[]> {
  const results: SchedulerResult[] = [];

  for (const jobName of jobNames) {
    const check = await checkAllUpstreamsSatisfied(db, runId, jobName);

    if (!check.satisfied) continue;

    if (check.action === 'skip') {
      results.push({ jobName, action: 'skip', reason: check.reason });
    } else {
      const now = new Date();
      await db
        .updateTable('execution_jobs')
        .set({ needs_satisfied: true, ready_at: now })
        .where('run_id', '=', runId)
        .where('job_name', '=', jobName)
        .where('needs_satisfied', '=', false)
        .execute();

      results.push({ jobName, action: 'dispatch' });
    }
  }

  return results;
}

/**
 * Layer 3: defensive scheduler invariant check.
 *
 * Finds jobs that are stuck: needs_satisfied=false, status='pending',
 * all upstreams are terminal, and no pending group resolution.
 * Returns the names of stuck jobs (empty array = no violation).
 */
export async function checkSchedulerInvariant(
  db: Kysely<Database>,
  runId: string,
): Promise<string[]> {
  // Find all pending jobs with needs_satisfied=false
  const pendingJobs = await db
    .selectFrom('execution_jobs')
    .select(['job_name'])
    .where('run_id', '=', runId)
    .where('needs_satisfied', '=', false)
    .where('status', '=', 'pending')
    .execute();

  if (pendingJobs.length === 0) return [];

  const stuckJobs: string[] = [];

  for (const pendingJob of pendingJobs) {
    // Get all upstream edges
    const edges = await db
      .selectFrom('execution_job_needs')
      .select(['upstream_name'])
      .where('run_id', '=', runId)
      .where('job_name', '=', pendingJob.job_name)
      .execute();

    if (edges.length === 0) {
      // No edges but needs_satisfied=false and pending — this shouldn't happen
      // (root jobs should be marked satisfied at insert time)
      stuckJobs.push(pendingJob.job_name);
      continue;
    }

    // Check if ALL upstreams are terminal
    const upstreamNames = edges.map((e) => e.upstream_name);
    const upstreamJobs = await db
      .selectFrom('execution_jobs')
      .select(['job_name', 'status'])
      .where('run_id', '=', runId)
      .where('job_name', 'in', upstreamNames)
      .execute();

    // If some upstreams don't have job rows yet (pending group resolution), skip
    if (upstreamJobs.length < upstreamNames.length) continue;

    const allTerminal = upstreamJobs.every((j) => TERMINAL_JOB_STATES.has(j.status));
    if (allTerminal) {
      stuckJobs.push(pendingJob.job_name);
    }
  }

  return stuckJobs;
}

/**
 * Failure-propagation cascade: find all transitive downstreams that should be
 * skipped because a terminal upstream's status is not in their edge's run_on
 * set. At each hop, the propagating job's actual terminal status decides which
 * downstream edges propagate (status not in run_on → the downstream skips and
 * propagates further).
 */
export async function getFailurePropagationTargets(
  db: Kysely<Database>,
  runId: string,
  failedJobName: string,
): Promise<string[]> {
  const targets: string[] = [];
  const visited = new Set<string>();
  const queue = [failedJobName];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    // Resolve the propagating job's terminal status (the originating failed job
    // or a transitively-skipped downstream).
    const currentJob = await db
      .selectFrom('execution_jobs')
      .select(['status'])
      .where('run_id', '=', runId)
      .where('job_name', '=', current)
      .executeTakeFirst();
    const currentStatus = currentJob?.status;

    // Find downstream edges whose run_on does NOT admit the propagating status.
    const downstreamEdges = await db
      .selectFrom('execution_job_needs')
      .select(['job_name', 'run_on'])
      .where('run_id', '=', runId)
      .where('upstream_name', '=', current)
      .execute();

    for (const edge of downstreamEdges) {
      if (visited.has(edge.job_name)) continue;
      // Without a resolved status (job row not yet written) fall back to the
      // conservative "propagate" behavior so a missing row never hides a skip.
      const propagates = currentStatus === undefined || !parseRunOn(edge.run_on).has(currentStatus);
      if (propagates) {
        targets.push(edge.job_name);
        queue.push(edge.job_name);
      }
    }
  }

  return targets;
}
