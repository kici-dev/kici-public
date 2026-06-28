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
  FanoutPosition,
  NormalizedRetry,
} from '@kici-dev/sdk';
import { normalizeCacheSpecs, normalizeApproval } from '@kici-dev/sdk';
import { ExecutionStepStatus, CheckMode, CheckStepOutcome } from '@kici-dev/engine';
import { runIdempotentStep, type IdempotentStep } from '@kici-dev/core/idempotency';
import { computeBackoffDelay } from '@kici-dev/core';
import type { RunnerToAgentMessage } from './ipc-protocol.js';
import type { SandboxStepResult } from './types.js';
import { executeHook, buildOutcomeMetadata } from '../hook-executor.js';
import { evaluateRules, createRuleContext } from '../rule-evaluator.js';
import { restoreCacheSpecs, saveCacheSpecs, type CachePhaseDeps } from '../cache/index.js';
import { runParallelGroup } from './parallel-scheduler.js';

/**
 * Thrown inside the step race when a step's own per-task abort controller fires
 * (parallel fail-fast cancels an in-flight sibling). Distinguished from a
 * timeout/job-deadline reject so the loop reports the step as `cancelled`
 * (which is NOT a failure) rather than `failed`.
 */
export class StepCancelledError extends Error {
  readonly name = 'StepCancelledError';
  constructor(stepName: string) {
    super(`Step '${stepName}' was cancelled by parallel fail-fast`);
    Object.setPrototypeOf(this, StepCancelledError.prototype);
  }
}

/**
 * A node in the concurrency-aware step walk. A `sequential` node is one ordinary
 * step; a `parallel` node is a `parallel()` group whose children each carry their
 * own flat `stepIndex` (the group wrapper consumes no index).
 */
export type StepNode =
  | { kind: 'sequential'; step: Step; stepIndex: number }
  | {
      kind: 'parallel';
      groupId: string;
      name: string;
      failFast: boolean;
      maxParallel?: number;
      children: { step: Step; stepIndex: number }[];
    };

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
  /**
   * Flat list of every executable step (sequential steps + parallel-group
   * children inlined in flat-stepIndex order). `steps.length` is the flat step
   * count used to derive hook pseudo-indices. The structural walk order (which
   * entries are grouped) is carried separately by `stepNodes`.
   */
  steps: Step[];
  /**
   * Structural walk order: sequential steps and parallel groups in array order.
   * When present, the loop walks these nodes (dispatching parallel groups to the
   * concurrency-aware scheduler); when absent, it walks `steps` sequentially with
   * the array index as the stepIndex (unit-harness back-compat).
   */
  stepNodes?: StepNode[];
  /**
   * Abort the per-task controller for `stepIndex` (parallel fail-fast). Wired to
   * the workflow-runner's `stepAbortControllers` map so an aborted sibling's
   * `ctx.signal` fires and its step race rejects with {@link StepCancelledError}.
   */
  abortStep?: (stepIndex: number) => void;
  /**
   * Returns the per-task abort signal for `stepIndex` (the same controller
   * `abortStep` triggers). The step race watches it so a fail-fast abort
   * interrupts an in-flight step even if its body ignores `ctx.signal`.
   */
  getStepAbortSignal?: (stepIndex: number) => AbortSignal | undefined;
  /**
   * Run mode for idempotent steps. `apply` (default) converges; `check` /
   * `check-fail-on-drift` preview drift and never invoke a checked step's apply.
   */
  checkMode?: CheckMode;
  /** Factory that creates a StepContext for a given step index and name. */
  createStepContext: (stepIndex: number, stepName: string) => StepContext;
  /**
   * Run `fn` inside the step's console-capture scope so any console output it
   * (or its hooks) produces attributes to `stepIndex`. Defaults to calling `fn`
   * directly when absent (unit harnesses without capture wiring).
   */
  runWithStepCapture?: <T>(stepIndex: number, fn: () => Promise<T>) => Promise<T>;
  sendIpc: (msg: RunnerToAgentMessage) => void;
  defaultTimeoutMs: number;
  outputsMap: OutputsMap;
  /** Event payload for rule context. */
  event: Record<string, unknown>;
  /** Environment variables for rule context. */
  env: Record<string, string | undefined>;
  /** Operator dispatch inputs for the rule context (`ctx.dispatchInputs`). */
  dispatchInputs?: Readonly<Record<string, string | number | boolean | null>>;
  /** Fan-out position for the rule context (`ctx.fanout`); undefined on a non-fan-out job. */
  fanout?: FanoutPosition;
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
   * Returns the secret key names accessed by the step context created for
   * `stepIndex`. Called after each step completes to include in step.complete
   * IPC messages.
   */
  getSecretsAccessLog?: (stepIndex: number) => string[];
  /**
   * Tear down per-step state created by the `createStepContext` call for
   * `stepIndex`. Invoked from the step-loop's `finally` after the step completes
   * (success, failure, rule-skip, or timeout) so resources like the
   * `ctx.secrets.mountFile` tmpdir get removed even on the failure paths.
   * Never throws -- errors are logged by the wired implementation.
   */
  disposeStepResources?: (stepIndex: number) => Promise<void>;
  /**
   * Returns the IPC `step.secret_mount` records collected by the step context
   * created for `stepIndex`. Emitted on step completion so the orchestrator can
   * persist the audit trail alongside `secretsAccessed`.
   */
  getSecretMountRecords?: (stepIndex: number) => StepSecretMountRecord[];
  /**
   * Before a step's run function executes, point KICI_ENV / KICI_PATH at fresh
   * temp files for this step (keyed by `stepIndex` so concurrent steps never
   * share a delta file). Invoked once per executed step (NOT for rule-skipped
   * steps). The workflow-runner owns the file lifecycle.
   */
  beforeStepEnvFiles?: (stepIndex: number) => Promise<void>;
  /**
   * After a step's run function completes (success OR failure), read this
   * step's KICI_ENV / KICI_PATH files, apply the delta via applyEnvDelta, and
   * release them. Never throws -- errors are logged by the wired impl.
   */
  afterStepApplyEnvFiles?: (stepIndex: number) => Promise<void>;
  /**
   * Block an `approval` step (`when: 'always'`) pending an orchestrator-side
   * approval hold. The runner sends the normalized requirement and awaits the
   * resolution; the agent keeps job heartbeats flowing during the wait so the
   * agent isn't reaped. Absent ⇒ approvals are not gated (CT / unit harnesses)
   * and steps run unconditionally.
   */
  awaitStepApproval?: (req: {
    stepIndex: number;
    stepName: string;
    clauses: Array<{ team: string } | { user: string }>;
    reason: string;
    timeoutSeconds?: number;
  }) => Promise<StepApprovalResolution>;
  /**
   * Block an `approval: { when: 'drift' }` step mid-execution: after `check()`
   * returns drift in apply mode, send a payload-bearing step-approval and await
   * the resolution. The payload carries the computed drift (`summaryMarkdown` +
   * structured `drift`) so the operator approves the actual diff. Absent ⇒ the
   * drift gate is not enforced (CT / unit harnesses) and the step applies.
   */
  awaitStepApprovalWithPayload?: (req: {
    stepIndex: number;
    stepName: string;
    clauses: Array<{ team: string } | { user: string }>;
    reason: string;
    timeoutSeconds?: number;
    payload: { summaryMarkdown: string; drift: unknown };
  }) => Promise<StepApprovalResolution>;
}

/** Outcome of an awaited step-level approval hold. */
export interface StepApprovalResolution {
  outcome: 'approved' | 'rejected' | 'expired';
  reason?: string;
}

/**
 * Resolve the capture-scope wrapper from options, falling back to a direct call
 * when no capture wiring is present (unit harnesses).
 */
function captureWrap(
  opts: StepLoopOptions,
): <T>(stepIndex: number, fn: () => Promise<T>) => Promise<T> {
  return opts.runWithStepCapture ?? ((_stepIndex, fn) => fn());
}

/** Result of the step execution loop. */
interface StepLoopResult {
  status: 'success' | 'failed' | 'aborted';
  stepResults: SandboxStepResult[];
  failureReason?: string;
}

/** Structured result of running a step under a given check mode. */
interface CheckPhaseResult {
  /** Idempotent outcome, set only when the run carried a non-default check mode
   *  or the step has a check facet. Undefined for the plain apply-mode path. */
  checkOutcome?: CheckStepOutcome;
  /** Step status mapped from the outcome (or the plain success path). */
  status: 'success' | 'skipped';
  /** Step outputs (from run / whenInSync). Undefined when nothing executed. */
  outputs: unknown;
  /** Drift summary (`summarize(drift)`), present when drift was detected. */
  driftSummary?: string;
  /** Structured drift value, present when drift was detected. */
  drift?: unknown;
}

/** Result of a rejected drift gate: the run was declined by a reviewer. */
class DriftGateRejectedError extends Error {
  constructor(reason?: string) {
    super(reason ? `approval rejected: ${reason}` : 'approval rejected');
    this.name = 'DriftGateRejectedError';
  }
}

/**
 * Run one step honoring the run-level {@link CheckMode}, reusing the
 * `runIdempotentStep` primitive for checked steps (never hand-rolled branching).
 *
 * - Plain step (no `check`): in apply mode, runs as today; in any check mode it
 *   is skipped with `no_check` (a side-effecting step can't be safely previewed).
 * - Checked step: adapted into an `IdempotentStep` and driven by the primitive
 *   with `dryRun` set in check mode (so `apply`/`run` never fires). On drift the
 *   summary is emitted as a log line. A `approval: { when: 'drift' }` step in
 *   apply mode passes a `confirm` callback that round-trips a payload-bearing
 *   step-approval; on reject the gate throws (fail-stop). Any other apply-mode
 *   step uses `yes: true`.
 */
async function runStepWithCheckMode(
  step: Step,
  stepIndex: number,
  ctx: StepContext,
  checkMode: CheckMode,
  sendFn: (msg: RunnerToAgentMessage) => void,
  opts: StepLoopOptions,
): Promise<CheckPhaseResult> {
  if (!step.check) {
    if (checkMode !== CheckMode.enum.apply) {
      return {
        checkOutcome: CheckStepOutcome.enum.no_check,
        status: 'skipped',
        outputs: undefined,
      };
    }
    // Unchanged plain-step apply path: run with only the context, no outcome tag.
    return { status: 'success', outputs: await step.run(ctx) };
  }

  // Capture the structured drift the primitive computes so the payload carries
  // it (the primitive's confirm/summarize see only the summary string).
  let lastDrift: unknown = null;
  const adapted: IdempotentStep<unknown, unknown, unknown> = {
    name: step.name,
    check: async () => {
      lastDrift = await step.check!(ctx);
      return lastDrift;
    },
    summarize: step.summarize!,
    apply: (drift) => step.run(ctx, drift),
    whenInSync: step.whenInSync ? () => step.whenInSync!(ctx) : undefined,
  };

  const driftGate =
    step.approval !== undefined &&
    normalizeApproval(step.approval).when === 'drift' &&
    checkMode === CheckMode.enum.apply &&
    opts.awaitStepApprovalWithPayload !== undefined;

  const res = await runIdempotentStep(adapted, {
    dryRun: checkMode !== CheckMode.enum.apply,
    ...(driftGate
      ? {
          // The primitive calls confirm() only on non-null drift, which is
          // exactly "gate on drift". It passes its own prompt string; the
          // author-rendered summary comes from summarize(lastDrift).
          confirm: async () => {
            const norm = normalizeApproval(step.approval!);
            const summaryMarkdown = step.summarize!(lastDrift);
            const resolution = await opts.awaitStepApprovalWithPayload!({
              stepIndex,
              stepName: step.name,
              clauses: norm.clauses,
              reason: norm.reason ?? `Approval required for drift in '${step.name}'`,
              ...(norm.timeoutSeconds !== undefined && { timeoutSeconds: norm.timeoutSeconds }),
              payload: { summaryMarkdown, drift: lastDrift },
            });
            if (resolution.outcome === 'approved') return true;
            // Reject / expire is a fail-stop: surface a clear error to the loop.
            throw new DriftGateRejectedError(
              resolution.outcome === 'expired' ? 'approval expired' : resolution.reason,
            );
          },
        }
      : { yes: true }),
    log: (line) => sendFn({ type: 'log.line', stepIndex, line }),
  });

  const driftSummary = res.drift != null ? step.summarize!(res.drift) : undefined;
  const status = res.outcome === CheckStepOutcome.enum.applied ? 'success' : 'skipped';
  // dry-run is a successful preview (status success), distinct from in-sync skip.
  const mappedStatus = res.outcome === CheckStepOutcome.enum['dry-run'] ? 'success' : status;
  return {
    checkOutcome: res.outcome as CheckStepOutcome,
    status: mappedStatus,
    outputs: res.result,
    ...(driftSummary !== undefined && { driftSummary }),
    ...(res.drift != null && { drift: res.drift }),
  };
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
  getSecretsAccessLog: ((stepIndex: number) => string[]) | undefined,
  getSecretMountRecords: ((stepIndex: number) => StepSecretMountRecord[]) | undefined,
  jobDeadlineSignal: AbortSignal | undefined,
  checkMode: CheckMode,
  opts: StepLoopOptions,
): Promise<SandboxStepResult> {
  sendFn({ type: 'step.start', stepIndex, stepName: step.name });

  const startTime = Date.now();
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
  const stepAbortSignal = opts.getStepAbortSignal?.(stepIndex);

  try {
    const phase = await Promise.race([
      runStepWithCheckMode(step, stepIndex, ctx, checkMode, sendFn, opts),
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
      // Per-task fail-fast: a parallel sibling failed and aborted this step's
      // own controller. Reject with StepCancelledError so the catch reports
      // `cancelled` (not `failed`) — a cancelled sibling is not a failure.
      new Promise<never>((_, reject) => {
        if (!stepAbortSignal) return;
        if (stepAbortSignal.aborted) {
          reject(new StepCancelledError(step.name));
          return;
        }
        stepAbortSignal.addEventListener('abort', () => reject(new StepCancelledError(step.name)));
      }),
    ]);

    clearTimeout(timeoutId);
    const durationMs = Date.now() - startTime;

    const outputsPayload =
      phase.outputs != null ? (phase.outputs as Record<string, unknown>) : undefined;
    if (outputsPayload) {
      outputsMap.set(step.name, outputsPayload);
    }

    const secretsAccessed = getSecretsAccessLog?.(stepIndex);
    emitSecretMountEvents(getSecretMountRecords?.(stepIndex), stepIndex, sendFn);

    const stepStatus =
      phase.status === 'skipped'
        ? ExecutionStepStatus.enum.skipped
        : ExecutionStepStatus.enum.success;

    sendFn({
      type: 'step.complete',
      stepIndex,
      status: stepStatus,
      durationMs,
      ...(outputsPayload && { outputs: outputsPayload }),
      ...(secretsAccessed !== undefined && { secretsAccessed }),
      ...(phase.checkOutcome !== undefined && { checkOutcome: phase.checkOutcome }),
      ...(phase.driftSummary !== undefined && { driftSummary: phase.driftSummary }),
      ...(phase.drift !== undefined && { drift: phase.drift }),
    });

    return {
      name: step.name,
      stepIndex,
      status: stepStatus,
      durationMs,
      ...(outputsPayload && { outputs: outputsPayload }),
    };
  } catch (e) {
    clearTimeout(timeoutId);
    const durationMs = Date.now() - startTime;
    const error = e instanceof Error ? e : new Error(String(e));

    // A fail-fast cancellation is a terminal `cancelled` step, not a failure.
    if (e instanceof StepCancelledError) {
      const secretsAccessed = getSecretsAccessLog?.(stepIndex);
      emitSecretMountEvents(getSecretMountRecords?.(stepIndex), stepIndex, sendFn);
      sendFn({
        type: 'step.complete',
        stepIndex,
        status: ExecutionStepStatus.enum.cancelled,
        durationMs,
        ...(secretsAccessed !== undefined && { secretsAccessed }),
      });
      return {
        name: step.name,
        stepIndex,
        status: ExecutionStepStatus.enum.cancelled,
        durationMs,
      };
    }

    const exitCode = extractExitCode(e);
    const signal = extractSignal(e);

    const secretsAccessed = getSecretsAccessLog?.(stepIndex);
    emitSecretMountEvents(getSecretMountRecords?.(stepIndex), stepIndex, sendFn);

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
export interface StepIterationOutcome {
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
  const ruleCtx = createRuleContext(
    opts.event,
    [],
    opts.env,
    opts.dispatchInputs ?? {},
    opts.fanout,
  );
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
 * Pre-step manual approval gate. When the step declares `approval` with
 * `when: 'always'` and the harness wired `awaitStepApproval`, block until the
 * orchestrator resolves the hold. A `when: 'drift'` gate is NOT handled here —
 * it fires mid-execution inside `runStepWithCheckMode` once `check()` returns
 * drift. Returns a failed `StepIterationOutcome` (breaking the loop) on
 * reject/expired; returns null when approved or when no gate applies.
 */
async function maybeGateStepApproval(
  step: Step,
  stepIndex: number,
  opts: StepLoopOptions,
): Promise<StepIterationOutcome | null> {
  if (step.approval === undefined || !opts.awaitStepApproval) return null;

  const normalized = normalizeApproval(step.approval);
  // Drift gates fire between check and run, not before the step.
  if (normalized.when === 'drift') return null;
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
  await opts.disposeStepResources?.(stepIndex);
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
  const hookResult = await captureWrap(opts)(hookStepIndex, () =>
    executeHook({
      hook,
      stepContext: ctx,
      outcome,
      hookType,
      stepIndex: hookStepIndex,
      sendIpc: opts.sendIpc,
      timeout: 300_000,
    }),
  );
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
/**
 * Run a step through its retry policy. Each call to `executeStepInLoop` is one
 * attempt: it sets up its own per-attempt timeout from `step.timeout` and returns
 * a `SandboxStepResult` (it never throws — a failed attempt is reported as a
 * `failed` status with an `error`). A failed attempt is retried while attempts
 * remain AND `retryIf(reconstructedError)` is true; backoff sleeps between
 * attempts. The retry loop runs to completion BEFORE the caller applies
 * `continueOnError` to the final outcome.
 */
async function runStepWithRetry(
  step: Step,
  stepIndex: number,
  ctx: StepContext,
  timeoutMs: number,
  opts: StepLoopOptions,
): Promise<SandboxStepResult> {
  const retry: NormalizedRetry | undefined = step.retry;
  const max = retry?.maxAttempts ?? 1;
  let result!: SandboxStepResult;
  for (let n = 1; n <= max; n++) {
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
      opts.checkMode ?? CheckMode.enum.apply,
      opts,
    );
    if (result.status !== ExecutionStepStatus.enum.failed) return result;
    const err = new Error(result.error?.message ?? `Step '${step.name}' failed`);
    const canRetry = n < max && (retry?.retryIf?.(err) ?? true);
    if (!canRetry) break;
    const delay = computeBackoffDelay(n, {
      maxAttempts: max,
      delayMs: retry!.delayMs,
      backoff: retry!.backoff,
      maxDelayMs: retry!.maxDelayMs,
    });
    opts.sendIpc({
      type: 'log.line',
      stepIndex,
      line: `[kici] Step '${step.name}' attempt ${n}/${max} failed: ${err.message}; retrying in ${delay}ms`,
    });
    await new Promise((r) => setTimeout(r, delay));
  }
  return result;
}

export async function runStepIteration(
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
    await opts.disposeStepResources?.(stepIndex);
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
      ? await restoreCacheSpecs(stepCacheSpecs, opts.cachePhaseDeps, stepIndex)
      : new Map<string, { hit: boolean; matchedKey?: string }>();

  try {
    await opts.beforeStepEnvFiles?.(stepIndex);
    const ctx = opts.createStepContext(stepIndex, step.name);
    const timeoutMs = step.timeout ?? opts.defaultTimeoutMs;
    let result: SandboxStepResult;
    try {
      result = await captureWrap(opts)(stepIndex, () =>
        runStepWithRetry(step, stepIndex, ctx, timeoutMs, opts),
      );
    } finally {
      await opts.afterStepApplyEnvFiles?.(stepIndex);
    }

    // Step-level declarative cache: save AFTER the step succeeds (on exact-key
    // miss). A failed step does not save — the cached artifacts may be partial.
    if (
      stepCacheSpecs.length > 0 &&
      opts.cachePhaseDeps &&
      result.status === ExecutionStepStatus.enum.success
    ) {
      await saveCacheSpecs(stepCacheSpecs, stepCacheRestore, opts.cachePhaseDeps, stepIndex);
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
    await opts.disposeStepResources?.(stepIndex);
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
  const hookResult = await captureWrap(opts)(hookStepIndex, () =>
    executeHook({
      hook,
      stepContext: ctx,
      outcome,
      hookType,
      stepIndex: hookStepIndex,
      sendIpc: opts.sendIpc,
    }),
  );
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

  // Walk the structural node list when present (sequential steps + parallel
  // groups); otherwise fall back to the flat `steps` list (unit-harness path)
  // with the array index as the stepIndex.
  const nodes: StepNode[] =
    opts.stepNodes ?? opts.steps.map((step, i) => ({ kind: 'sequential', step, stepIndex: i }));

  for (const node of nodes) {
    if (opts.isAborted?.()) break;
    if (node.kind === 'parallel') {
      const groupOutcome = await runParallelGroup(node, opts);
      stepResults.push(...groupOutcome.results);
      if (groupOutcome.failed) {
        state.failed = true;
        state.failedStepName = groupOutcome.failedStepName;
        break;
      }
      continue;
    }
    const outcome = await runStepIteration(node.step, node.stepIndex, opts);
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
