/**
 * Where a job's checkouts live in its work directory.
 *
 * A job of a global workflow — a workflow defined in one repository and run for
 * another — holds two checkouts: the workflow repository, which carries
 * `.kici/`, under `workflow/`, and the source repository the event came from
 * under `source/`. Every other job holds one checkout: the work directory
 * itself.
 *
 * The host checkout, every evaluation job, and the eval child read the layout
 * here. The sandbox runner derives the same two directories from the same
 * `isGlobalWorkflow` flag.
 *
 * Its own module because the eval child reads it, and the child must not import
 * the job runner.
 */

import { join } from 'node:path';

export interface JobWorkspaceLayout {
  /** The job holds the global two-checkout layout. */
  isGlobal: boolean;
  /** The checkout that carries `.kici/`. */
  workflowDir: string;
  /** The checkout of the repository the event came from. */
  sourceDir: string;
}

/** The two-checkout layout of a global workflow's job under `workDir`. */
export function globalWorkspaceLayout(workDir: string): JobWorkspaceLayout {
  return {
    isGlobal: true,
    workflowDir: join(workDir, 'workflow'),
    sourceDir: join(workDir, 'source'),
  };
}

/** The layout a job's config selects: the global one for a global workflow, one checkout otherwise. */
export function jobWorkspaceLayout(
  jobConfig: { isGlobalWorkflow?: unknown },
  workDir: string,
): JobWorkspaceLayout {
  if (jobConfig.isGlobalWorkflow === true) return globalWorkspaceLayout(workDir);
  return { isGlobal: false, workflowDir: workDir, sourceDir: workDir };
}
