import { isLockParallelStep, type LockStep, type LockStepEntry } from '@kici-dev/engine';

/**
 * Flatten a lock job's `steps` into the flat sequential list the orchestrator
 * iterates by `stepIndex`. A `parallel` group's children are inlined in array
 * order and the group wrapper is dropped (it consumes no flat index). This keeps
 * the orchestrator's enumeration aligned with the agent's `extractAndNormalizeSteps`
 * — the flat-stepIndex invariant: `flattenLockSteps(job.steps)[i]` is the step at
 * agent `stepIndex i`.
 */
export function flattenLockSteps(steps: readonly LockStepEntry[]): readonly LockStep[] {
  const flat: LockStep[] = [];
  for (const entry of steps) {
    if (isLockParallelStep(entry)) {
      flat.push(...entry.children);
    } else {
      flat.push(entry);
    }
  }
  return flat;
}
