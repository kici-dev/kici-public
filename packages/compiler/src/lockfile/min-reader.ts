import { GLOBAL_APPROVAL_MIN_READER } from '@kici-dev/engine';
import { BREAKING_FLOOR, isLockStaticJob, type LockTrigger, type LockWorkflow } from '../types.js';

/** True when the trigger carries `repos:` patterns, which makes its workflow organization-wide. */
function triggerHasRepos(trigger: LockTrigger): boolean {
  const repos = (trigger as { readonly repos?: readonly unknown[] }).repos;
  return Array.isArray(repos) && repos.length > 0;
}

/**
 * True when an organization-wide workflow (any trigger carrying `repos:`) or
 * one of its static jobs declares `approval`. Generated jobs are not visible
 * here: they are built on the agent, after the lock is read.
 */
export function hasGatedGlobalWorkflow(workflows: readonly LockWorkflow[]): boolean {
  return workflows.some(
    (wf) =>
      wf.triggers.some(triggerHasRepos) &&
      (wf.approval !== undefined ||
        wf.jobs.some((job) => isLockStaticJob(job) && job.approval !== undefined)),
  );
}

/**
 * The `minReaderVersion` a lock must carry. Orchestrators below
 * `GLOBAL_APPROVAL_MIN_READER` dispatch an organization-wide workflow without
 * holding it for approval, so a lock with a gated global workflow requires that
 * version. Every other lock stays readable down to `BREAKING_FLOOR`.
 */
export function lockMinReaderVersion(workflows: readonly LockWorkflow[]): number {
  return hasGatedGlobalWorkflow(workflows) ? GLOBAL_APPROVAL_MIN_READER : BREAKING_FLOOR;
}
