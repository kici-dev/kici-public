import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Attributes captured console output to the step whose run is on the async
 * call stack: the patched `process.stdout/stderr.write` reads
 * {@link currentCaptureStepIndex} to pick the `step-N.log`. Keyed on the async
 * context, not a module global, so concurrent step bodies each resolve to
 * their own {@link runInStepCapture} scope.
 */
const stepCaptureStore = new AsyncLocalStorage<number>();

/** Attribute console output to `stepIndex` for `fn`'s whole async execution, awaits included. */
export function runInStepCapture<T>(stepIndex: number, fn: () => Promise<T>): Promise<T> {
  return stepCaptureStore.run(stepIndex, fn);
}

/** `-1` outside any capture scope (workflow-level / between-steps output). */
export function currentCaptureStepIndex(): number {
  return stepCaptureStore.getStore() ?? -1;
}
