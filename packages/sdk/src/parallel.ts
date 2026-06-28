import type { Step, BareStepFn, StepInput } from './types.js';

/** A flat step entry: a step or bare function, never a parallel group. */
export type FlatStepInput = Step<any> | BareStepFn<any>;

/**
 * A concurrent group of steps with a join barrier. Each child runs concurrently
 * and surfaces as its own observable dashboard step (own logs, status, timing).
 * Execution continues past the group only once every child has settled.
 */
export interface ParallelGroup {
  readonly _tag: 'ParallelGroup';
  /** Optional group label shown on the dashboard band. */
  readonly name?: string;
  /** When the first child fails, cancel in-flight siblings (default `true`). */
  readonly failFast: boolean;
  /** Maximum children running at once; queued children show `pending`. */
  readonly maxParallel?: number;
  readonly steps: readonly StepInput[];
}

export interface ParallelOptions {
  readonly failFast?: boolean;
  readonly maxParallel?: number;
  readonly name?: string;
}

/**
 * Run `steps` concurrently with a join barrier; each child is its own
 * observable step. A `parallel()` group's `failFast`/`maxParallel` nest inside
 * the job-level fan-out scopes — they govern only this step group.
 */
export function parallel(steps: StepInput[], opts: ParallelOptions = {}): ParallelGroup {
  return {
    _tag: 'ParallelGroup',
    name: opts.name,
    failFast: opts.failFast ?? true,
    maxParallel: opts.maxParallel,
    steps,
  };
}

/** Type guard distinguishing a `ParallelGroup` from a step or bare function. */
export function isParallelGroup(x: unknown): x is ParallelGroup {
  return typeof x === 'object' && x !== null && (x as ParallelGroup)._tag === 'ParallelGroup';
}

/**
 * Flatten a job's `steps` into a flat list where each parallel group's children
 * are inlined in array order (the group wrapper is dropped). Used by single-
 * process consumers (the local executor and dry-run preview) that surface each
 * child as its own step but do not run a concurrent scheduler; the concurrent
 * agent path expands groups into observable concurrent tasks instead.
 */
export function flattenStepInputs(steps: readonly StepInput[]): FlatStepInput[] {
  const flat: FlatStepInput[] = [];
  for (const entry of steps) {
    if (isParallelGroup(entry)) {
      flat.push(...(entry.steps as readonly FlatStepInput[]));
    } else {
      flat.push(entry);
    }
  }
  return flat;
}
