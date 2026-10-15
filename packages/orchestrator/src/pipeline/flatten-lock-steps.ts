import { isLockParallelStep, type LockStep, type LockStepEntry } from '@kici-dev/engine';

/**
 * Flatten a lock job's `steps` for `stepIndex` iteration: a `parallel` group's
 * children are inlined in order and the wrapper takes no index. Invariant,
 * matching the agent's `extractAndNormalizeSteps`:
 * `flattenLockSteps(job.steps)[i]` is the step at agent `stepIndex i`.
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
