/**
 * Workflow modification detection.
 *
 * Compares base and head lock files to detect added, modified, or removed workflows.
 * Used by the processor to flag workflow changes in PRs from non-trusted contributors.
 */

import type { LockFile, LockWorkflow } from '@kici-dev/engine';

/** A single workflow modification detected between base and head lock files. */
export interface WorkflowModification {
  workflowName: string;
  changeType: 'added' | 'modified' | 'removed';
}

/**
 * Detect workflow modifications between base and head lock files.
 *
 * Compares workflow names and configurations:
 * - Added: in head but not base
 * - Removed: in base but not head
 * - Modified: in both but triggers, jobs, or steps differ
 *
 * @param baseLockFile - Lock file from the base branch (null for new repos)
 * @param headLockFile - Lock file from the head commit (null means nothing to detect)
 * @returns List of detected modifications
 */
export function detectWorkflowModifications(
  baseLockFile: LockFile | null,
  headLockFile: LockFile | null,
): WorkflowModification[] {
  // If head lock file is null, nothing to detect
  if (!headLockFile) return [];

  const modifications: WorkflowModification[] = [];

  // Build maps by workflow name
  const baseWorkflows = new Map<string, LockWorkflow>();
  if (baseLockFile) {
    for (const wf of baseLockFile.workflows) {
      baseWorkflows.set(wf.name, wf);
    }
  }

  const headWorkflows = new Map<string, LockWorkflow>();
  for (const wf of headLockFile.workflows) {
    headWorkflows.set(wf.name, wf);
  }

  // Check for added and modified workflows
  for (const [name, headWf] of headWorkflows) {
    const baseWf = baseWorkflows.get(name);
    if (!baseWf) {
      modifications.push({ workflowName: name, changeType: 'added' });
    } else if (hasWorkflowChanged(baseWf, headWf)) {
      modifications.push({ workflowName: name, changeType: 'modified' });
    }
  }

  // Check for removed workflows
  for (const name of baseWorkflows.keys()) {
    if (!headWorkflows.has(name)) {
      modifications.push({ workflowName: name, changeType: 'removed' });
    }
  }

  return modifications;
}

/**
 * Check if a workflow has changed between base and head versions.
 * Compares triggers and jobs (excluding volatile fields like contentHash).
 */
function hasWorkflowChanged(baseWf: LockWorkflow, headWf: LockWorkflow): boolean {
  // Compare triggers
  if (JSON.stringify(baseWf.triggers) !== JSON.stringify(headWf.triggers)) {
    return true;
  }

  // Compare jobs
  if (JSON.stringify(baseWf.jobs) !== JSON.stringify(headWf.jobs)) {
    return true;
  }

  // Compare rules
  if (JSON.stringify(baseWf.rules) !== JSON.stringify(headWf.rules)) {
    return true;
  }

  return false;
}
