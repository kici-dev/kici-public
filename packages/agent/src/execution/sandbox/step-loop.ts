/**
 * Step loop -- extracted step execution logic with hook integration and step rules.
 *
 * This module contains the core step execution loop that the workflow-runner calls.
 * Extracted for testability: the workflow-runner's main() handles IPC, clone, deps,
 * module loading, and calls this loop for step execution with hooks.
 */

import type {
  Step,
  StepContext,
  HookInput,
  OutputsMap,
  StepSecretMountRecord,
  CacheSpec,
} from '@kici-dev/sdk';
import { normalizeCacheSpecs, normalizeRequireApproval } from '@kici-dev/sdk';
import { ExecutionStepStatus } from '@kici-dev/engine';
import type { RunnerToAgentMessage } from './ipc-protocol.js';
import type { SandboxStepResult } from './types.js';
import { executeHook, buildOutcomeMetadata } from '../hook-executor.js';
import { evaluateRules, createRuleContext } from '../rule-evaluator.js';
import { restoreCacheSpecs, saveCacheSpecs, type CachePhaseDeps } from '../cache/index.js';

/** Job-level hooks passed to the step loop. */
export interface JobHooks {
  beforeStep?: HookInput;
  afterStep?: HookInput;
  onSuccess?: HookInput;
  onFailure?: HookInput;
  onCancel?: HookInput;
  cleanup?: HookInput;
}

/** Options for the step execution loop. */
export interface StepLoopOptions {
  steps: Step[];
  /** Factory that creates a StepContext for a given step index and name. */
  createStepContext: (stepIndex: number, stepName: string) => StepContext;
  sendIpc: (msg: RunnerToAgentMessage) => void;
  defaultTimeoutMs: number;
  outputsMap: OutputsMap;
  /** Event payload for rule context. */
  event: Record<string, unknown>;
  /** Environment variables for rule context. */
  env: Record<string, string | undefined>;
  /** Job-level hooks. */
  jobHooks?: JobHooks;
  /**
   * Declarative cache phase dependencies (cache API + IPC + pseudo-step index
   * allocator). When set, each step's own `cache` specs are restored before the
   * step's `run` and saved after (on an exact-key miss), surfacing as
   * `cache:restore` / `cache:save` pseudo-steps. Absent ⇒ no step-level cache.
   */
  cachePhaseDeps?: CachePhaseDeps;
  /** Abort check callback. Returns true if job was aborted. */
  isAborted?: () => boolean;
  /**
   * Aborted when the job-level wall-clock deadline (the lock job's `timeout`)
   * is breached. Threaded into each step's run race so an in-flight step is
   * interrupted immediately on breach — the between-steps `isAborted()` check
   * alone cannot unwind a single long-running step that has no per-step
   * `timeout`. When the signal fires, the step rejects with a job_timeout
   * error and the loop stops.
   */
  jobDeadlineSignal?: AbortSignal;
  /** Job start time (epoch ms) for outcome metadata duration. */
  startTime?: number;
  /**
   * Returns the secret key names accessed by the most recently created step context.
   * Called after each step completes to include in step.complete IPC messages.
   */
  getSecretsAccessLog?: () => string[];
  /**
   * Tear down per-step state created by the most recent `createStepContext`
   * call. Invoked from the step-loop's `finally` after the step completes
   * (success, failure, rule-skip, or timeout) so resources like the
   * `ctx.secrets.mountFile` tmpdir get removed even on the failure paths.
   * Never throws -- errors are logged by the wired implementation.
   */
  disposeStepResources?: () => Promise<void>;
  /**
   * Returns the IPC `step.secret_mount` records collected by the most
   * recently created step context. Emitted on step completion so the
   * orchestrator can persist the audit trail alongside `secretsAccessed`.
   */
  getSecretMountRecords?: () => StepSecretMountRecord[];
  /**
   * Before a step's run function executes, point KICI_ENV / KICI_PATH at fresh
   * temp files for this step. Invoked once per executed step (NOT for rule-skipped
   * steps). The workflow-runner owns the file lifecycle.
   */
  beforeStepEnvFiles?: () => Promise<void>;
  /**
   * After a step's run function completes (success OR failure), read the
   * KICI_ENV / KICI_PATH files, apply the delta via applyEnvDelta, and truncate
   * them for the next step. Never throws -- errors are logged by the wired impl.
   */
  afterStepApplyEnvFiles?: () => Promise<void>;
  /**
   * Block a `requireApproval` step pending an orchestrator-side approval hold.
   * The runner sends the normalized requirement and awaits the resolution; the
   * agent keeps job heartbeats flowing during the wait so the agent isn't
   * reaped. Absent ⇒ approvals are not gated (CT / unit harnesses) and steps
   * run unconditionally.
   */
  awaitStepApproval?: (req: {
    stepIndex: number;
    stepName: string;
    clauses: Array<{ team: string } | { user: string }>;
    reason: string;
    timeoutSeconds?: number;
  }) => Promise<StepApprovalResolution>;
}

/** Outcome of an awaited step-level approval hold. */
export interface StepApprovalResolution {
  outcome: 'approved' | 'rejected' | 'expired';
  reason?: string;
}

/** Result of the step execution loop. */
interface StepLoopResult {
  status: 'success' | 'failed' | 'aborted';
  stepResults: SandboxStepResult[];
  failureReason?: string;
}

/**
 * Execute a single step with timeout enforcement.
 *
 * Timeout pattern using Promise.race + AbortController, with IPC status reporting.
 */
async function executeStepInLoop(
  step: Step,
  stepIndex: number,
  ctx: StepContext,
  timeoutMs: number,
  sendFn: (msg: RunnerToAgentMessage) => void,
  outputsMap: OutputsMap,
  getSecretsAccessLog?: () => string[],
  getSecretMountRecords?: () => StepSecretMountRecord[],
  jobDeadlineSignal?: AbortSignal,
): Promise<SandboxStepResult> {
  sendFn({ type: 'step.start', stepIndex, stepName: step.name });

  const startTime = Date.now();
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const result = await Promise.race([
      step.run(ctx),
      new Promise<never>((_, reject) => {
        abortController.signal.addEventListener('abort', () => {
          reject(new Error(`Step '${step.name}' timed out after ${timeoutMs}ms`));
        });
      }),
      // Job-level deadline: interrupt an in-flight step the instant the job
      // wall-clock timeout fires, rather than waiting for the step's own
      // (possibly 30-min default) timeout to elapse.
      new Promise<never>((_, reject) => {
        if (!jobDeadlineSignal) return;
        if (jobDeadlineSignal.aborted) {
          reject(new Error(`Step '${step.name}' aborted: job timeout exceeded`));
          return;
        }
        jobDeadlineSignal.addEventListener('abort', () => {
          reject(new Error(`Step '${step.name}' aborted: job timeout exceeded`));
        });
      }),
    ]);

    clearTimeout(timeoutId);
    const durationMs = Date.now() - startTime;

    const outputsPayload = result != null ? (result as Record<string, unknown>) : undefined;
    if (outputsPayload) {
      outputsMap.set(step.name, outputsPayload);
    }

    const secretsAccessed = getSecretsAccessLog?.();
    emitSecretMountEvents(getSecretMountRecords?.(), stepIndex, sendFn);

    sendFn({
      type: 'step.complete',
      stepIndex,
      status: ExecutionStepStatus.enum.success,
      durationMs,
      ...(outputsPayload && { outputs: outputsPayload }),
      ...(secretsAccessed !== undefined && { secretsAccessed }),
    });

    return {
      name: step.name,
      stepIndex,
      status: ExecutionStepStatus.enum.success,
      durationMs,
      ...(outputsPayload && { outputs: outputsPayload }),
    };
  } catch (e) {
    clearTimeout(timeoutId);
    const durationMs = Date.now() - startTime;
    const error = e instanceof Error ? e : new Error(String(e));

    const exitCode = extractExitCode(e);
    const signal = extractSignal(e);

    const secretsAccessed = getSecretsAccessLog?.();
    emitSecretMountEvents(getSecretMountRecords?.(), stepIndex, sendFn);

    sendFn({
      type: 'step.complete',
      stepIndex,
      status: ExecutionStepStatus.enum.failed,
      durationMs,
      error: {
        message: error.message,
        ...(exitCode !== undefined && { exitCode }),
        ...(signal !== undefined && { signal }),
      },
      ...(secretsAccessed !== undefined && { secretsAccessed }),
    });

    return {
      name: step.name,
      stepIndex,
      status: ExecutionStepStatus.enum.failed,
      durationMs,
      error: {
        message: error.message,
        ...(exitCode !== undefined && { exitCode }),
        ...(signal !== undefined && { signal }),
      },
    };
  }
}

/**
 * Emit one `step.secret_mount` IPC event per `mountFile` / `exposeFile` call
 * the step performed. Called from both the success and failure paths so the
 * orchestrator's audit trail records every mount regardless of step outcome.
 */
function emitSecretMountEvents(
  records: StepSecretMountRecord[] | undefined,
  stepIndex: number,
  sendFn: (msg: RunnerToAgentMessage) => void,
): void {
  if (!records || records.length === 0) return;
  for (const record of records) {
    sendFn({
      type: 'step.secret_mount',
      stepIndex,
      sources: record.sources,
      target: record.target,
      kind: record.kind,
      ...(record.envVar !== undefined && { envVar: record.envVar }),
    });
  }
}

function extractExitCode(error: unknown): number | undefined {
  if (
    error &&
    typeof error === 'object' &&
    'exitCode' in error &&
    typeof (error as { exitCode: unknown }).exitCode === 'number'
  ) {
    return (error as { exitCode: number }).exitCode;
  }
  return undefined;
}

function extractSignal(error: unknown): string | undefined {
  if (
    error &&
    typeof error === 'object' &&
    'signal' in error &&
    typeof (error as { signal: unknown }).signal === 'string'
  ) {
    return (error as { signal: string }).signal;
  }
  return undefined;
}

/**
 * Per-step iteration outcome returned by `runStepIteration`.
 */
interface StepIterationOutcome {
  /** The result to append to the running stepResults list. */
  result: SandboxStepResult;
  /** When true, the loop must break (failed step without continueOnError). */
  shouldBreak: boolean;
  /** Set when the step failed; carried into completion-hook outcome metadata. */
  failedStepName?: string;
}

/**
 * Evaluate step-level rules. Returns a 'skipped' result + emits IPC when a rule
 * fails; returns null when the step should run normally.
 */
async function evaluateStepRulesAndMaybeSkip(
  step: Step,
  stepIndex: number,
  opts: StepLoopOptions,
): Promise<SandboxStepResult | null> {
  if (!step.rules || step.rules.length === 0) return null;
  const ruleCtx = createRuleContext(opts.event, [], opts.env);
  const ruleResult = await evaluateRules(step.rules, ruleCtx, step.name);
  if (ruleResult.allPassed) return null;

  opts.sendIpc({ type: 'step.start', stepIndex, stepName: step.name });
  opts.sendIpc({
    type: 'step.complete',
    stepIndex,
    status: ExecutionStepStatus.enum.failed, // IPC doesn't have 'skipped' -- use metadata
    durationMs: 0,
  });
  opts.sendIpc({
    type: 'log.line',
    stepIndex,
    line: `[kici] Step '${step.name}' skipped: rule '${ruleResult.results.find((r) => !r.passed)?.label}' did not pass`,
  });
  return {
    name: step.name,
    stepIndex,
    status: ExecutionStepStatus.enum.skipped,
    durationMs: 0,
  };
}

/**
 * Manual approval gate for a step. When the step declares `requireApproval`
 * and the harness wired `awaitStepApproval`, block until the orchestrator
 * resolves the hold. Returns a failed `StepIterationOutcome` (breaking the
 * loop) on reject/expired; returns null when approved or when no gate applies.
 */
async function maybeGateStepApproval(
  step: Step,
  stepIndex: number,
  opts: StepLoopOptions,
): Promise<StepIterationOutcome | null> {
  if (step.requireApproval === undefined || !opts.awaitStepApproval) return null;

  const normalized = normalizeRequireApproval(step.requireApproval);
  opts.sendIpc({
    type: 'log.line',
    stepIndex,
    line: `[kici] Step '${step.name}' awaiting approval...`,
  });

  const resolution = await opts.awaitStepApproval({
    stepIndex,
    stepName: step.name,
    clauses: normalized.clauses,
    reason: normalized.reason ?? `Approval required for step '${step.name}'`,
    timeoutSeconds: normalized.timeoutSeconds,
  });

  if (resolution.outcome === 'approved') {
    opts.sendIpc({ type: 'log.line', stepIndex, line: `[kici] Step '${step.name}' approved.` });
    return null;
  }

  const why =
    resolution.outcome === 'expired'
      ? 'approval expired'
      : `approval rejected${resolution.reason ? `: ${resolution.reason}` : ''}`;
  opts.sendIpc({ type: 'step.start', stepIndex, stepName: step.name });
  opts.sendIpc({
    type: 'step.complete',
    stepIndex,
    status: ExecutionStepStatus.enum.failed,
    durationMs: 0,
  });
  opts.sendIpc({
    type: 'log.line',
    stepIndex,
    line: `[kici] Step '${step.name}' ${why}.`,
  });
  await opts.disposeStepResources?.();
  return {
    result: {
      name: step.name,
      stepIndex,
      status: ExecutionStepStatus.enum.failed,
      durationMs: 0,
      error: { message: `Step '${step.name}' ${why}` },
    },
    shouldBreak: true,
    failedStepName: step.name,
  };
}

/**
 * Run a single observer hook (beforeStep / afterStep). Failures only emit a
 * log line — they never change job status. Centralises the per-call boilerplate
 * so the per-step body can stay flat.
 */
async function runObserverHook(args: {
  hook: HookInput;
  hookType: 'beforeStep' | 'afterStep';
  step: Step;
  stepIndex: number;
  hookStepIndex: number;
  failedStep?: string;
  opts: StepLoopOptions;
}): Promise<void> {
  const { hook, hookType, step, stepIndex, hookStepIndex, failedStep, opts } = args;
  const status =
    failedStep !== undefined ? ExecutionStepStatus.enum.failed : ExecutionStepStatus.enum.success;
  const outcome = buildOutcomeMetadata({
    status,
    stepOutputs: Object.fromEntries(opts.outputsMap),
    startTime: opts.startTime ?? Date.now(),
    ...(failedStep !== undefined && { failedStep }),
  });
  const ctx = opts.createStepContext(stepIndex, step.name);
  const hookResult = await executeHook({
    hook,
    stepContext: ctx,
    outcome,
    hookType,
    stepIndex: hookStepIndex,
    sendIpc: opts.sendIpc,
    timeout: 300_000,
  });
  if (!hookResult.success) {
    opts.sendIpc({
      type: 'log.line',
      stepIndex,
      line: `[kici] ${hookType} hook failed: ${hookResult.error} (continuing -- hooks are observers)`,
    });
  }
}

/**
 * Execute one iteration of the step loop: step rules → beforeStep → execute →
 * afterStep → failure-handling. Returns a typed outcome the loop uses to
 * accumulate results, decide whether to break, and remember the failed step.
 *
 * Wraps the per-step lifecycle in a `try / finally` that calls
 * `opts.disposeStepResources()` so per-step state (the
 * `ctx.secrets.mountFile` tmpdir, any env vars set via `exposeFile`) is
 * removed even when the step throws, times out, or rule-skips.
 */
async function runStepIteration(
  step: Step,
  stepIndex: number,
  opts: StepLoopOptions,
): Promise<StepIterationOutcome> {
  const skippedResult = await evaluateStepRulesAndMaybeSkip(step, stepIndex, opts);
  if (skippedResult) {
    // Even a rule-skipped step may have allocated context state via a prior
    // `createStepContext` call (when `getSecretMountRecords` is wired the
    // outer caller may have pre-allocated the secrets handle). Dispose to be
    // safe.
    await opts.disposeStepResources?.();
    return { result: skippedResult, shouldBreak: false };
  }

  // Manual approval gate: block this step until the orchestrator resolves an
  // approval hold. A rejected/expired hold fails the job; an approved hold
  // falls through to normal execution.
  const gate = await maybeGateStepApproval(step, stepIndex, opts);
  if (gate) {
    return gate;
  }

  if (opts.jobHooks?.beforeStep) {
    await runObserverHook({
      hook: opts.jobHooks.beforeStep,
      hookType: 'beforeStep',
      step,
      stepIndex,
      hookStepIndex: opts.steps.length + stepIndex * 2,
      opts,
    });
  }

  // Step-level declarative cache: restore this step's specs BEFORE its run.
  const stepCacheSpecs: CacheSpec[] = opts.cachePhaseDeps ? normalizeCacheSpecs(step.cache) : [];
  const stepCacheRestore =
    stepCacheSpecs.length > 0 && opts.cachePhaseDeps
      ? await restoreCacheSpecs(stepCacheSpecs, opts.cachePhaseDeps)
      : new Map<string, { hit: boolean; matchedKey?: string }>();

  try {
    await opts.beforeStepEnvFiles?.();
    const ctx = opts.createStepContext(stepIndex, step.name);
    const timeoutMs = step.timeout ?? opts.defaultTimeoutMs;
    let result: SandboxStepResult;
    try {
      result = await executeStepInLoop(
        step,
        stepIndex,
        ctx,
        timeoutMs,
        opts.sendIpc,
        opts.outputsMap,
        opts.getSecretsAccessLog,
        opts.getSecretMountRecords,
        opts.jobDeadlineSignal,
      );
    } finally {
      await opts.afterStepApplyEnvFiles?.();
    }

    // Step-level declarative cache: save AFTER the step succeeds (on exact-key
    // miss). A failed step does not save — the cached artifacts may be partial.
    if (
      stepCacheSpecs.length > 0 &&
      opts.cachePhaseDeps &&
      result.status === ExecutionStepStatus.enum.success
    ) {
      await saveCacheSpecs(stepCacheSpecs, stepCacheRestore, opts.cachePhaseDeps);
    }

    if (opts.jobHooks?.afterStep) {
      await runObserverHook({
        hook: opts.jobHooks.afterStep,
        hookType: 'afterStep',
        step,
        stepIndex,
        hookStepIndex: opts.steps.length + stepIndex * 2 + 1,
        failedStep: result.status === ExecutionStepStatus.enum.failed ? step.name : undefined,
        opts,
      });
    }

    if (result.status === ExecutionStepStatus.enum.failed) {
      return {
        result,
        shouldBreak: !step.continueOnError,
        failedStepName: step.name,
      };
    }
    return { result, shouldBreak: false };
  } finally {
    await opts.disposeStepResources?.();
  }
}

/**
 * Mutable accumulator passed to `runJobCompletionHooks` so completion-hook
 * failures can promote the job to failed and append to `failureReason`.
 */
interface CompletionState {
  failed: boolean;
  failedStepName?: string;
  failureReason?: string;
}

/**
 * Execute one named completion hook (onSuccess / onFailure / cleanup) and
 * return the updated `CompletionState`. Treated as the single source of truth
 * for the "promote to failed + concat reason" pattern that the three completion
 * hooks share.
 */
async function runCompletionHook(args: {
  hook: HookInput;
  hookType: 'onSuccess' | 'onFailure' | 'cleanup';
  hookStepIndex: number;
  outcome: ReturnType<typeof buildOutcomeMetadata>;
  state: CompletionState;
  promoteToFailed: boolean;
  opts: StepLoopOptions;
}): Promise<CompletionState> {
  const { hook, hookType, hookStepIndex, outcome, state, promoteToFailed, opts } = args;
  opts.sendIpc({ type: 'log.line', stepIndex: -1, line: `[kici] Running ${hookType} hook...` });
  const ctx = opts.createStepContext(hookStepIndex, hookType);
  const hookResult = await executeHook({
    hook,
    stepContext: ctx,
    outcome,
    hookType,
    stepIndex: hookStepIndex,
    sendIpc: opts.sendIpc,
  });
  if (hookResult.success) {
    opts.sendIpc({
      type: 'log.line',
      stepIndex: -1,
      line: `[kici] ${hookType} hook completed`,
    });
    return state;
  }
  opts.sendIpc({
    type: 'log.line',
    stepIndex: -1,
    line: `[kici] ${hookType} hook failed: ${hookResult.error}`,
  });
  const reasonFragment = `Hook ${hookType} failed: ${hookResult.error}`;
  return {
    failed: state.failed || promoteToFailed,
    failedStepName: state.failedStepName,
    failureReason: state.failureReason
      ? `${state.failureReason}; ${reasonFragment}`
      : reasonFragment,
  };
}

/**
 * Run the job-completion hook sequence after the per-step loop ends:
 * onSuccess (or onFailure), then cleanup (always). The cleanup outcome is
 * recomputed so it reflects any failures introduced by onSuccess/onFailure.
 */
async function runJobCompletionHooks(
  opts: StepLoopOptions,
  initial: CompletionState,
  outputsMap: OutputsMap,
  startTime: number,
): Promise<CompletionState> {
  const { jobHooks } = opts;
  const initialFinalStatus = initial.failed
    ? ExecutionStepStatus.enum.failed
    : ExecutionStepStatus.enum.success;
  const jobOutcome = buildOutcomeMetadata({
    status: initialFinalStatus,
    stepOutputs: Object.fromEntries(outputsMap),
    startTime,
    ...(initial.failedStepName && {
      failedStep: initial.failedStepName,
      reason: `Step '${initial.failedStepName}' failed`,
    }),
  });

  let state = initial;
  let hookStepIndex = opts.steps.length;

  if (initialFinalStatus === ExecutionStepStatus.enum.success && jobHooks?.onSuccess) {
    state = await runCompletionHook({
      hook: jobHooks.onSuccess,
      hookType: 'onSuccess',
      hookStepIndex,
      outcome: jobOutcome,
      state,
      promoteToFailed: true,
      opts,
    });
    hookStepIndex++;
  } else if (initialFinalStatus === ExecutionStepStatus.enum.failed && jobHooks?.onFailure) {
    state = await runCompletionHook({
      hook: jobHooks.onFailure,
      hookType: 'onFailure',
      hookStepIndex,
      outcome: jobOutcome,
      state,
      promoteToFailed: false,
      opts,
    });
    hookStepIndex++;
  }

  if (jobHooks?.cleanup) {
    const cleanupOutcome = buildOutcomeMetadata({
      status: state.failed ? ExecutionStepStatus.enum.failed : ExecutionStepStatus.enum.success,
      stepOutputs: Object.fromEntries(outputsMap),
      startTime,
      ...(state.failedStepName && { failedStep: state.failedStepName }),
      ...(state.failureReason && { reason: state.failureReason }),
    });
    state = await runCompletionHook({
      hook: jobHooks.cleanup,
      hookType: 'cleanup',
      hookStepIndex,
      outcome: cleanupOutcome,
      state,
      promoteToFailed: true,
      opts,
    });
  }

  return state;
}

/**
 * Execute the step loop with hook integration and step-level rule evaluation.
 *
 * Hook execution order:
 * - beforeStep -> step -> afterStep (per step)
 * - onSuccess or onFailure (after all steps)
 * - cleanup (always, after onSuccess/onFailure)
 *
 * Hooks are observers: beforeStep/afterStep failures do NOT affect step execution.
 * Only completion hooks (onSuccess/onFailure/cleanup) can change job status to failed.
 */
export async function executeStepLoop(opts: StepLoopOptions): Promise<StepLoopResult> {
  const startTime = opts.startTime ?? Date.now();
  const stepResults: SandboxStepResult[] = [];
  const state: CompletionState = { failed: false };

  for (const [i, step] of opts.steps.entries()) {
    if (opts.isAborted?.()) break;
    const outcome = await runStepIteration(step, i, opts);
    stepResults.push(outcome.result);
    if (outcome.failedStepName) {
      state.failed = true;
      state.failedStepName = outcome.failedStepName;
    }
    if (outcome.shouldBreak) break;
  }

  // If aborted between steps, skip completion hooks — the workflow-runner's
  // cancel-path will handle onCancel + cleanup to avoid double execution.
  if (opts.isAborted?.()) {
    return {
      status: 'aborted',
      stepResults,
      failureReason:
        state.failureReason ?? (state.failed ? `Step '${state.failedStepName}' failed` : undefined),
    };
  }

  const finalState = await runJobCompletionHooks(opts, state, opts.outputsMap, startTime);
  return {
    status: finalState.failed ? ExecutionStepStatus.enum.failed : ExecutionStepStatus.enum.success,
    stepResults,
    failureReason: finalState.failureReason,
  };
}
