import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Attributes captured console output to the step whose run is currently on the
 * async call stack.
 *
 * The monkey-patched `process.stdout/stderr.write` reads
 * {@link currentCaptureStepIndex} to decide which `step-N.log` a console line
 * belongs to. Keying this on the async execution context (rather than a single
 * module global) makes attribution correct when more than one step body runs
 * concurrently: each step's `run` executes inside its own
 * {@link runInStepCapture} scope, so its writes resolve to its own index even
 * while a sibling step is mid-flight. Under sequential execution exactly one
 * scope is active at a time, identical to the former global.
 */
const stepCaptureStore = new AsyncLocalStorage<number>();

/**
 * Run `fn` with `stepIndex` as the active console-capture attribution for the
 * duration of its async execution (including everything it awaits).
 */
export function runInStepCapture<T>(stepIndex: number, fn: () => Promise<T>): Promise<T> {
  return stepCaptureStore.run(stepIndex, fn);
}

/**
 * The step index whose run is currently on the async stack, or `-1` when no
 * capture scope is active (workflow-level / between-steps output).
 */
export function currentCaptureStepIndex(): number {
  return stepCaptureStore.getStore() ?? -1;
}
