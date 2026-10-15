/**
 * Complete the provider check runs a workflow-scoped hold leaves behind when it
 * ends without ever dispatching a job.
 *
 * `setupDispatchContext` posts the queued `kici/<workflow>` check and one
 * `kici/<workflow>/job/<name>` per static job BEFORE the trust-policy and
 * install gates decide. No other path completes them: terminal reporters key off
 * records a never-dispatched run lacks, and the stale sweep only touches
 * `in_progress` checks. Left alone they stay `queued` forever, blocking branch
 * protection.
 *
 * The names are rebuilt from the pending workflow context the resume path
 * replays, so they match what `setupDispatchContext` created.
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
 * A no-op without a pending workflow context. Call it BEFORE
 * `deletePendingWorkflowContext`: the context is the only source of the
 * check-run names.
 *
 * Never throws: a provider error must not stop the caller terminalizing the run.
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
      // The effective overlay: `info` alone holds the pre-overlay routing key for
      // a cross-source dispatch, and the credential lookup keys on it.
      provider: pending.effectiveProvider ?? pending.info.provider,
      routingKey: pending.effectiveRoutingKey ?? pending.info.routingKey,
      owner,
      repo,
      sha: pending.ref,
      workflowName: pending.workflow.name,
      // No `workflowRepoIdentifier`: the posted checks carry the unqualified name.
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
