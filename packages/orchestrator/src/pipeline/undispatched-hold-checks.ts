/**
 * Complete the provider check runs a workflow-scoped hold leaves behind when it
 * ends without ever dispatching a job.
 *
 * `setupDispatchContext` posts the queued `kici/<workflow>` check and one
 * `kici/<workflow>/job/<name>` per static job BEFORE the trust-policy gate and
 * the install gate decide anything, so a hold that is rejected or expires has
 * already put those checks on the commit. Nothing else completes them: every
 * terminal reporter path keys off a run, job, or queue record a never-dispatched
 * run does not have, and the stale sweep only touches check runs whose status is
 * `in_progress`. Left alone they stay `queued` forever, which on a pull request
 * is a check that never finishes and a branch-protection blocker.
 *
 * The names are rebuilt from the same pending workflow context the resume path
 * replays, so they match what `setupDispatchContext` created for this run — the
 * effective routing key and provider, the acted-on repository, the commit sha,
 * and the static job list.
 */
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { isLockStaticJob, type CheckRunConclusion } from '@kici-dev/engine';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { CheckRunReporter } from '../reporting/check-run-reporter.js';
import { loadPendingWorkflowContext } from './pending-workflow-context.js';

const logger = createLogger({ prefix: 'undispatched-hold-checks' });

/**
 * Complete the check runs of `runId`'s stored workflow dispatch, if it has one.
 *
 * A run with no pending workflow context never held at workflow scope (or its
 * context was already consumed by a resume), so there is nothing to close and
 * this is a no-op. Call it BEFORE `deletePendingWorkflowContext` — the context
 * is the only place the check-run names can still be derived from.
 *
 * Never throws: closing a check run is a reporting courtesy on a path whose real
 * job is to terminalize the run, and a provider error must not stop that.
 */
export async function completeUndispatchedHoldChecks(args: {
  db: Kysely<Database> | undefined;
  checkRunReporter: CheckRunReporter | undefined;
  runId: string;
  conclusion: CheckRunConclusion;
  summary: string;
}): Promise<void> {
  const { checkRunReporter, runId } = args;
  if (!checkRunReporter) return;

  try {
    const pending = await loadPendingWorkflowContext(args.db, runId);
    if (!pending) return;

    const [owner, repo] = pending.repoIdentifier.split('/');
    if (!owner || !repo) {
      logger.warn('Cannot complete hold check runs: repo identifier is not owner/repo', {
        runId,
        repoIdentifier: pending.repoIdentifier,
      });
      return;
    }

    await checkRunReporter.completeUndispatchedCheckRuns({
      // The effective overlay `setupDispatchContext` applied before posting the
      // checks. Reading `info` alone would use the pre-overlay routing key for a
      // cross-source dispatch, and the credential lookup keys on it.
      provider: pending.effectiveProvider ?? pending.info.provider,
      routingKey: pending.effectiveRoutingKey ?? pending.info.routingKey,
      owner,
      repo,
      sha: pending.ref,
      workflowName: pending.workflow.name,
      // `setupDispatchContext` passes no `workflowRepoIdentifier`, so the checks
      // on the commit carry the unqualified name. Passing one here would build a
      // qualified name that matches nothing.
      jobNames: pending.workflow.jobs.filter(isLockStaticJob).map((j) => j.name),
      installationId: (pending.credentials as { installationId?: number } | undefined)
        ?.installationId,
      runId,
      conclusion: args.conclusion,
      summary: args.summary,
    });
  } catch (err) {
    logger.warn('Failed to complete check runs for an undispatched hold', {
      runId,
      error: toErrorMessage(err),
    });
  }
}
