/**
 * Hook executor module -- shared hook execution logic with timeout, error handling,
 * and outcome metadata construction.
 *
 * Hooks run inline within the workflow-runner process (same sandbox), not as
 * separate child processes. IPC messages are for status reporting to the
 * fork-runner, which relays to the agent's job-runner.
 */

import type { HookConfig, HookFn, HookContext, OutcomeMetadata, HookInput } from '@kici-dev/sdk';
import type { StepContext } from '@kici-dev/sdk';
import type { RunnerToAgentMessage } from './sandbox/ipc-protocol.js';
import { toErrorMessage } from '@kici-dev/shared';

/** Default hook timeout: 5 minutes */
const DEFAULT_HOOK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Build outcome metadata from execution state.
 *
 * Duration is calculated as elapsed time since startTime.
 */
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

/**
 * Normalize a HookInput (bare function, { run, timeout }, or HookConfig) into a HookConfig.
 */
function normalizeHook(hook: HookInput | HookConfig, hookType: string): HookConfig {
  // Already a HookConfig with name and type
  if (typeof hook === 'object' && 'name' in hook && 'type' in hook) {
    return hook as HookConfig;
  }

  // Bare function
  if (typeof hook === 'function') {
    return {
      name: hookType,
      type: hookType as HookConfig['type'],
      run: hook as HookFn,
    };
  }

  // Object with run and optional timeout: { run, timeout }
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
  /** Default timeout in ms (overridden by hook-level timeout). Defaults to 5 minutes. */
  timeout?: number;
}

interface ExecuteHookResult {
  success: boolean;
  error?: string;
}

/**
 * Execute a single hook with timeout enforcement and IPC reporting.
 *
 * Sends step.start and step.complete IPC messages with step_type = 'hook:{hookType}'.
 * The hook runs in the same sandbox context as regular steps.
 */
export async function executeHook(opts: ExecuteHookOptions): Promise<ExecuteHookResult> {
  const { stepContext, outcome, hookType, stepIndex, sendIpc } = opts;

  const normalized = normalizeHook(opts.hook, hookType);
  const timeoutMs = normalized.timeout ?? opts.timeout ?? DEFAULT_HOOK_TIMEOUT_MS;

  // Send step.start IPC
  sendIpc({
    type: 'step.start',
    stepIndex,
    stepName: normalized.name,
    step_type: `hook:${hookType}`,
  });

  const startTime = Date.now();

  // Merge outcome into context for hook access
  const mergedCtx: HookContext = {
    ...stepContext,
    outcome,
  };

  // Declare outside try/catch so the timeout can be cleared in both paths
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    await Promise.race([
      normalized.run(mergedCtx),
      new Promise<never>((_, reject) => {
        abortController.signal.addEventListener('abort', () => {
          reject(new Error(`Hook '${normalized.name}' timed out after ${timeoutMs}ms`));
        });
      }),
    ]);
    clearTimeout(timeoutId);

    const durationMs = Date.now() - startTime;

    // Send step.complete IPC (success)
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

    // Send step.complete IPC (failed)
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
