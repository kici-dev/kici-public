/**
 * Hook execution with timeout, error handling and outcome metadata.
 *
 * Hooks run inline in the workflow-runner process (same sandbox), not as child
 * processes. IPC messages report status to the fork-runner, which relays to the
 * agent's job-runner.
 */

import type { HookConfig, HookFn, HookContext, OutcomeMetadata, HookInput } from '@kici-dev/sdk';
import type { StepContext } from '@kici-dev/sdk';
import type { RunnerToAgentMessage } from './sandbox/ipc-protocol.js';
import { toErrorMessage } from '@kici-dev/shared';

const DEFAULT_HOOK_TIMEOUT_MS = 5 * 60 * 1000;

/** Duration is the elapsed time since startTime. */
export function buildOutcomeMetadata(opts: {
  status: 'cancelled' | 'success' | 'failed';
  reason?: string;
  failedStep?: string;
  stepOutputs: Record<string, unknown>;
  startTime: number;
}): OutcomeMetadata {
  return {
    status: opts.status,
    reason: opts.reason,
    failedStep: opts.failedStep,
    stepOutputs: opts.stepOutputs,
    duration: Date.now() - opts.startTime,
  };
}

/** Normalize a bare function, `{ run, timeout }` or HookConfig into a HookConfig. */
function normalizeHook(hook: HookInput | HookConfig, hookType: string): HookConfig {
  if (typeof hook === 'object' && 'name' in hook && 'type' in hook) {
    return hook as HookConfig;
  }

  if (typeof hook === 'function') {
    return {
      name: hookType,
      type: hookType as HookConfig['type'],
      run: hook as HookFn,
    };
  }

  if (typeof hook === 'object' && 'run' in hook) {
    return {
      name: hookType,
      type: hookType as HookConfig['type'],
      run: hook.run,
      timeout: hook.timeout,
    };
  }

  throw new Error(`Invalid hook input for ${hookType}`);
}

interface ExecuteHookOptions {
  hook: HookInput | HookConfig;
  stepContext: StepContext;
  outcome: OutcomeMetadata;
  hookType: string;
  stepIndex: number;
  sendIpc: (msg: RunnerToAgentMessage) => void;
  /** In ms; a hook-level timeout overrides it. Defaults to 5 minutes. */
  timeout?: number;
}

interface ExecuteHookResult {
  success: boolean;
  error?: string;
}

/**
 * Execute one hook with timeout enforcement, reporting step.start and
 * step.complete with step_type = 'hook:{hookType}'.
 */
export async function executeHook(opts: ExecuteHookOptions): Promise<ExecuteHookResult> {
  const { stepContext, outcome, hookType, stepIndex, sendIpc } = opts;

  const normalized = normalizeHook(opts.hook, hookType);
  const timeoutMs = normalized.timeout ?? opts.timeout ?? DEFAULT_HOOK_TIMEOUT_MS;

  sendIpc({
    type: 'step.start',
    stepIndex,
    stepName: normalized.name,
    step_type: `hook:${hookType}`,
  });

  const startTime = Date.now();

  const abortController = new AbortController();
  // Rejected explicitly rather than through an abort listener: a hook body that
  // resolves when it observes its own signal settles in the same turn as the
  // abort, so leaving the two to race by listener order would sometimes report a
  // timed-out hook as successful.
  let rejectTimeout: (error: Error) => void = () => {};
  const timeoutRace = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const timeoutId = setTimeout(() => {
    rejectTimeout(new Error(`Hook '${normalized.name}' timed out after ${timeoutMs}ms`));
    abortController.abort();
  }, timeoutMs);

  // The hook's signal composes the step's signal with the hook's own timeout, so
  // a hook body awaiting `ctx.signal` observes its own deadline; the step's
  // signal alone never fires for a hook timeout.
  const mergedCtx: HookContext = {
    ...stepContext,
    outcome,
    signal: AbortSignal.any([
      ...(stepContext.signal ? [stepContext.signal] : []),
      abortController.signal,
    ]),
    // Rebind the shell to the hook's OWN timeout controller (skipped when `$` is
    // not callable, as unit harnesses stub it). A zx shell called with options
    // keeps this one's cwd and log wiring, so the hook streams into the same log
    // and dies on its own deadline.
    //
    // Deliberately NOT the composed signal: a completion hook runs after its job
    // was cancelled or its deadline passed, so the step half is already aborted
    // and would hand the hook a dead shell for the grace window `cleanup` exists
    // to use. A step TIMEOUT is unaffected either way: a completion hook is built
    // against its own step index and gets its own fresh controller.
    ...(typeof stepContext.$ === 'function'
      ? {
          $: (stepContext.$ as unknown as (o: { signal: AbortSignal }) => StepContext['$'])({
            signal: abortController.signal,
          }),
        }
      : {}),
  };

  try {
    await Promise.race([normalized.run(mergedCtx), timeoutRace]);
    clearTimeout(timeoutId);

    const durationMs = Date.now() - startTime;

    sendIpc({
      type: 'step.complete',
      stepIndex,
      status: 'success',
      durationMs,
      step_type: `hook:${hookType}`,
    });

    return { success: true };
  } catch (e) {
    clearTimeout(timeoutId);
    const durationMs = Date.now() - startTime;
    const error = toErrorMessage(e);

    sendIpc({
      type: 'step.complete',
      stepIndex,
      status: 'failed',
      durationMs,
      error: { message: error },
      step_type: `hook:${hookType}`,
    });

    return { success: false, error };
  }
}
