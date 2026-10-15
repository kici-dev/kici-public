/**
 * DB-backed needs-aware dispatch scheduler.
 *
 * Gates ALL needs edges (static and dynamic-group, either side) with
 * event-driven scheduling instead of concurrent dispatch.
 *
 * Pure DB, no in-memory state: every decision is a fresh query against
 * execution_jobs + execution_job_needs, so a restart needs no recovery code.
 *
 * Each edge carries a `run_on` set of upstream terminal statuses. An upstream
 * status outside the set skips the downstream; a downstream dispatches only when
 * every edge is satisfied.
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

function isNeedsEntry(entry: string | NeedsEntry | NeedsGroupEntry): entry is NeedsEntry {
  return typeof entry === 'object' && 'name' in entry && !('group' in entry);
}

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
 * Check if ALL upstreams of a job are satisfied: `satisfied: false` while any
 * is non-terminal, `action: 'skip'` when a terminal status is outside its
 * edge's run_on, otherwise `action: 'dispatch'`.
 */
export async function checkAllUpstreamsSatisfied(
  db: Kysely<Database>,
  runId: string,
  jobName: string,
): Promise<{ satisfied: boolean; action?: 'dispatch' | 'skip'; reason?: string }> {
  const edges = await db
    .selectFrom('execution_job_needs')
    .select(['upstream_name', 'run_on'])
    .where('run_id', '=', runId)
    .where('job_name', '=', jobName)
    .execute();

  if (edges.length === 0) {
    return { satisfied: true, action: 'dispatch' };
  }

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
      return { satisfied: false };
    }
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
 * An upstream base name `test` fanned into `test (a)` / `test (b)` yields one
 * edge per child, so `needs: ['test']` waits for ALL children; each
 * materialized child inherits the full upstream edge set under its expanded name.
 *
 * NeedsGroupEntry items wait for resolveGroupEdges. Root jobs (no needs, no
 * dependsOnGroups) are marked needs_satisfied=true.
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

    // A directly-registered global lock job can arrive without a `needs` array
    // (the compiler emits `needs: []`); treat a missing one as no upstreams.
    for (const need of job.lockJob.needs ?? []) {
      let baseName: string;
      let runOn: string;
      if (typeof need === 'string') {
        baseName = need;
        runOn = SUCCESS_ONLY_RUN_ON_JSON;
      } else if (isNeedsEntry(need)) {
        baseName = need.name;
        runOn = JSON.stringify(need.runOn ?? SUCCESS_ONLY_RUN_ON);
      } else if (isNeedsGroupEntry(need)) {
        // Group edges are written later, by resolveGroupEdges.
        continue;
      } else {
        continue;
      }

      // One edge per expanded upstream child; a non-fanned upstream maps to [baseName].
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

    const hasDependsOnGroups =
      job.lockJob.dependsOnGroups && job.lockJob.dependsOnGroups.length > 0;
    if (concreteNeeds.length === 0 && !hasDependsOnGroups) {
      rootJobNames.push(job.expandedName);
    }
  }

  if (edgeRows.length > 0) {
    await db
      .insertInto('execution_job_needs')
      .values(edgeRows)
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

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
 * Inserts one edge per (dependent, member); an empty group satisfies its
 * dependents immediately.
 *
 * CRITICAL: dependentStaticJobs carries each NeedsGroupEntry's run_on set;
 * without it every group edge silently defaults to success-only.
 */
export async function resolveGroupEdges(
  db: Kysely<Database>,
  runId: string,
  groupName: string,
  memberJobNames: string[],
  dependentStaticJobs: Array<{ jobName: string; runOn: ExecutionJobStatus[] }>,
): Promise<void> {
  if (memberJobNames.length > 0) {
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

  // An empty group finds zero edges, so its dependents become satisfied.
  await recomputeNeedsSatisfied(
    db,
    runId,
    dependentStaticJobs.map((d) => d.jobName),
  );
}

/**
 * Evaluate downstream jobs after an upstream reaches terminal state.
 *
 * The core scheduler hook: a downstream whose edge's run_on excludes the
 * completed status skips; one whose upstreams are all satisfied is claimed and
 * returned for dispatch.
 */
export async function evaluateDownstreams(
  db: Kysely<Database>,
  runId: string,
  completedJobName: string,
  completedStatus: string,
): Promise<SchedulerResult[]> {
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

  // A job can have several edges from one upstream via groups.
  const seenJobs = new Set<string>();

  for (const edge of downstreamEdges) {
    if (seenJobs.has(edge.job_name)) continue;
    seenJobs.add(edge.job_name);

    // This upstream's status is not in run_on: skip without checking the rest.
    if (!parseRunOn(edge.run_on).has(completedStatus)) {
      results.push({
        jobName: edge.job_name,
        action: 'skip',
        reason: `upstream_unmet: ${completedJobName} (${completedStatus})`,
      });
      continue;
    }

    const check = await checkAllUpstreamsSatisfied(db, runId, edge.job_name);

    if (!check.satisfied) {
      continue;
    }

    if (check.action === 'skip') {
      results.push({
        jobName: edge.job_name,
        action: 'skip',
        reason: check.reason,
      });
    } else {
      // The `needs_satisfied = false` predicate is the CLAIM: concurrent
      // evaluateDownstreams calls for a fan-in job all see every upstream
      // satisfied; exactly one UPDATE flips the row, and the losers MUST NOT
      // dispatch, or the job runs twice.
      const now = new Date();
      const claim = await db
        .updateTable('execution_jobs')
        .set({ needs_satisfied: true, ready_at: now })
        .where('run_id', '=', runId)
        .where('job_name', '=', edge.job_name)
        .where('needs_satisfied', '=', false)
        .executeTakeFirst();

      if ((claim?.numUpdatedRows ?? 0n) === 0n) {
        // Lost the claim — a concurrent evaluation owns this job's dispatch.
        continue;
      }

      results.push({
        jobName: edge.job_name,
        action: 'dispatch',
      });
    }
  }

  return results;
}

/**
 * Batch recompute needs_satisfied, after group resolution and on restart
 * recovery. Returns results for jobs that became ready.
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
      // NOTE: unlike evaluateDownstreams, this reports `dispatch` even on a
      // lost claim. Safe today: dispatchReadyJob consumes the pending job
      // context, so a second dispatch no-ops with a warning.
      //
      // Do NOT skip on a lost claim without giving dispatchReadyJob a way to
      // hand the claim back: a won claim whose dispatch dropped is recoverable
      // only by a later recompute, and that interaction is unverified.
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
 * Returns stuck jobs: needs_satisfied=false, pending, every upstream terminal,
 * and no group resolution pending.
 */
export async function checkSchedulerInvariant(
  db: Kysely<Database>,
  runId: string,
): Promise<string[]> {
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
    const edges = await db
      .selectFrom('execution_job_needs')
      .select(['upstream_name'])
      .where('run_id', '=', runId)
      .where('job_name', '=', pendingJob.job_name)
      .execute();

    if (edges.length === 0) {
      // Root jobs are marked satisfied at insert time, so this is stuck.
      stuckJobs.push(pendingJob.job_name);
      continue;
    }

    const upstreamNames = edges.map((e) => e.upstream_name);
    const upstreamJobs = await db
      .selectFrom('execution_jobs')
      .select(['job_name', 'status'])
      .where('run_id', '=', runId)
      .where('job_name', 'in', upstreamNames)
      .execute();

    // Missing upstream rows mean group resolution is still pending.
    if (upstreamJobs.length < upstreamNames.length) continue;

    const allTerminal = upstreamJobs.every((j) => TERMINAL_JOB_STATES.has(j.status));
    if (allTerminal) {
      stuckJobs.push(pendingJob.job_name);
    }
  }

  return stuckJobs;
}

/**
 * Failure-propagation cascade: every transitive downstream to skip. At each hop
 * the propagating job's own terminal status decides: outside an edge's run_on,
 * the downstream skips and propagates further.
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

    const currentJob = await db
      .selectFrom('execution_jobs')
      .select(['status'])
      .where('run_id', '=', runId)
      .where('job_name', '=', current)
      .executeTakeFirst();
    const currentStatus = currentJob?.status;

    const downstreamEdges = await db
      .selectFrom('execution_job_needs')
      .select(['job_name', 'run_on'])
      .where('run_id', '=', runId)
      .where('upstream_name', '=', current)
      .execute();

    for (const edge of downstreamEdges) {
      if (visited.has(edge.job_name)) continue;
      // A missing job row propagates, so it never hides a skip.
      const propagates = currentStatus === undefined || !parseRunOn(edge.run_on).has(currentStatus);
      if (propagates) {
        targets.push(edge.job_name);
        queue.push(edge.job_name);
      }
    }
  }

  return targets;
}
