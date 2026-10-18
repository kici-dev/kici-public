/** How `kici runs` lists a job's steps: in run order, init steps named `init[<n>]`. */
import { compareStepsByPhase, initStepLabel, stepInitIndex } from '@kici-dev/engine';

interface StepRef {
  stepIndex: number;
  stepName: string;
  stepType?: string | null;
}

/** Setup and init pseudo-steps first, whatever order an older orchestrator sent. */
export function stepsInRunOrder<T extends StepRef>(steps: readonly T[] | undefined): T[] {
  return [...(steps ?? [])].sort(compareStepsByPhase);
}

/** The step's name in human output; an init step reads `init[<n>]`, as in its job error. */
export function stepDisplayName(step: StepRef): string {
  const initIndex = stepInitIndex(step);
  return initIndex === undefined ? step.stepName : initStepLabel(initIndex);
}
