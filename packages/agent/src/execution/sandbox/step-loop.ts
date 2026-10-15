/**
 * Step execution loop with hooks and step rules, kept apart from the
 * workflow-runner's main() (IPC, clone, deps, module loading) for testability.
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
  RepoInfo,
} from '@kici-dev/sdk';
import { normalizeCacheSpecs, normalizeApproval } from '@kici-dev/sdk/internal';
import { ExecutionStepStatus, CheckMode, CheckStepOutcome, LogStream } from '@kici-dev/engine';
import type { ChangedFilesStatus } from '@kici-dev/engine';
import { runIdempotentStep, type IdempotentStep } from '@kici-dev/core/idempotency';
import { computeBackoffDelay } from '@kici-dev/core';
import type { RunnerToAgentMessage } from './ipc-protocol.js';
import type { SandboxStepResult } from './types.js';
import { executeHook, buildOutcomeMetadata } from '../hook-executor.js';
import { evaluateRules, createRuleContext } from '../rule-evaluator.js';
import { restoreCacheSpecs, saveCacheSpecs, type CachePhaseDeps } from '../cache/index.js';
import { runParallelGroup } from './parallel-scheduler.js';

/**
 * Thrown in the step race when parallel fail-fast aborts the step's own
 * controller, so the loop reports `cancelled` (not a failure) instead of the
 * `failed` a timeout or job-deadline reject produces.
 */
export class StepCancelledError extends Error {
  readonly name = 'StepCancelledError';
  constructor(stepName: string) {
    super(`Step '${stepName}' was cancelled by parallel fail-fast`);
    Object.setPrototypeOf(this, StepCancelledError.prototype);
  }
}

/**
 * A node in the step walk: one step, or a `parallel()` group whose children each
 * carry their own flat `stepIndex` (the group wrapper consumes no index).
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

export interface JobHooks {
  beforeStep?: HookInput;
  afterStep?: HookInput;
  onSuccess?: HookInput;
  onFailure?: HookInput;
  onCancel?: HookInput;
  cleanup?: HookInput;
}

export interface StepLoopOptions {
  /**
   * Every executable step (parallel-group children inlined) in flat-stepIndex
   * order; `steps.length` derives the hook pseudo-indices. Grouping lives in
   * `stepNodes`.
   */
  steps: Step[];
  /**
   * Structural walk order; parallel groups go to the concurrency-aware
   * scheduler. Absent: walk `steps` with the array index as stepIndex (unit
   * harnesses).
   */
  stepNodes?: StepNode[];
  /**
   * Parallel fail-fast: aborts the workflow-runner's per-task controller, so the
   * sibling's `ctx.signal` fires and its race rejects with {@link StepCancelledError}.
   */
  abortStep?: (stepIndex: number) => void;
  /**
   * The controller `abortStep` triggers; the step race watches it so fail-fast
   * interrupts a step whose body ignores `ctx.signal`.
   */
  getStepAbortSignal?: (stepIndex: number) => AbortSignal | undefined;
  /**
   * `apply` (default) converges; `check` / `check-fail-on-drift` preview drift
   * and never invoke a checked step's apply.
   */
  checkMode?: CheckMode;
  createStepContext: (stepIndex: number, stepName: string) => StepContext;
  /**
   * Runs `fn` in the step's console-capture scope so its (and its hooks')
   * output attributes to `stepIndex`. Absent: calls `fn` directly (unit harnesses).
   */
  runWithStepCapture?: <T>(stepIndex: number, fn: () => Promise<T>) => Promise<T>;
  sendIpc: (msg: RunnerToAgentMessage) => void;
  defaultTimeoutMs: number;
  outputsMap: OutputsMap;
  event: Record<string, unknown>;
  env: Record<string, string | undefined>;
  dispatchInputs?: Readonly<Record<string, string | number | boolean | null>>;
  /** Undefined on a non-fan-out job. */
  fanout?: FanoutPosition;
  /**
   * The repo whose event triggered the run (`ctx.sourceRepo`); present only for
   * a global workflow. A step rule reads its tree through `.path`, as a job rule
   * and a generator do.
   */
  sourceRepo?: RepoInfo;
  /** The repo that registered the workflow (`ctx.workflowRepo`). */
  workflowRepo?: RepoInfo;
  jobHooks?: JobHooks;
  /**
   * Drives the completion hooks down the failed path (`onFailure` then
   * `cleanup`) whatever the step outcomes. Set by the between-jobs out-of-band
   * cleanup re-run, which runs no steps.
   */
  forceInitialFailure?: boolean;
  /**
   * When set, each step's own `cache` specs are restored before its `run` and
   * saved after (on an exact-key miss), as `cache:restore` / `cache:save`
   * pseudo-steps. Absent ⇒ no step-level cache.
   */
  cachePhaseDeps?: CachePhaseDeps;
  isAborted?: () => boolean;
  /**
   * Aborted on breach of the job wall-clock deadline (the lock job's
   * `timeout`). Each step's race watches it, because the between-steps
   * `isAborted()` check cannot unwind one long step with no per-step `timeout`;
   * the step rejects with a job_timeout error and the loop stops.
   */
  jobDeadlineSignal?: AbortSignal;
  /** Epoch ms, for outcome metadata duration. */
  startTime?: number;
  /** Secret key names the step's context accessed, reported on `step.complete`. */
  getSecretsAccessLog?: (stepIndex: number) => string[];
  /**
   * Tears down the step's context state (e.g. the `ctx.secrets.mountFile`
   * tmpdir) after the step completes — success, failure, rule-skip or timeout.
   * Never throws; the wired implementation logs errors.
   */
  disposeStepResources?: (stepIndex: number) => Promise<void>;
  /**
   * `step.secret_mount` records, emitted on completion so the orchestrator
   * persists the audit trail alongside `secretsAccessed`.
   */
  getSecretMountRecords?: (stepIndex: number) => StepSecretMountRecord[];
  /**
   * Points KICI_ENV / KICI_PATH at fresh temp files keyed by `stepIndex`, so
   * concurrent steps never share a delta file. Not called for rule-skipped
   * steps; the workflow-runner owns the file lifecycle.
   */
  beforeStepEnvFiles?: (stepIndex: number) => Promise<void>;
  /**
   * After the run (success or failure), applies the step's KICI_ENV / KICI_PATH
   * delta via applyEnvDelta and releases the files. Never throws; the wired
   * implementation logs errors.
   */
  afterStepApplyEnvFiles?: (stepIndex: number) => Promise<void>;
  /**
   * Blocks a `when: 'always'` approval step on an orchestrator-side hold; the
   * agent keeps job heartbeats flowing meanwhile so it is not reaped. Absent ⇒
   * approvals are not gated (CT / unit harnesses).
   */
  awaitStepApproval?: (req: {
    stepIndex: number;
    stepName: string;
    clauses: Array<{ team: string } | { user: string }>;
    reason: string;
    timeoutSeconds?: number;
  }) => Promise<StepApprovalResolution>;
  /**
   * Blocks an `approval: { when: 'drift' }` step after `check()` returns drift
   * in apply mode; the payload carries the drift (`summaryMarkdown` + structured
   * `drift`) so the operator approves the actual diff. Absent ⇒ no drift gate
   * (CT / unit harnesses) and the step applies.
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

export interface StepApprovalResolution {
  outcome: 'approved' | 'rejected' | 'expired';
  reason?: string;
}

/** The capture-scope wrapper, or a direct call without capture wiring. */
function captureWrap(
  opts: StepLoopOptions,
): <T>(stepIndex: number, fn: () => Promise<T>) => Promise<T> {
  return opts.runWithStepCapture ?? ((_stepIndex, fn) => fn());
}

interface StepLoopResult {
  status: 'success' | 'failed' | 'aborted';
  stepResults: SandboxStepResult[];
  failureReason?: string;
}

interface CheckPhaseResult {
  /** Set only for a non-default check mode or a step with a check facet. */
  checkOutcome?: CheckStepOutcome;
  status: 'success' | 'skipped';
  /** From run / whenInSync; undefined when nothing executed. */
  outputs: unknown;
  /** `summarize(drift)`, present when drift was detected. */
  driftSummary?: string;
  drift?: unknown;
}

/** A reviewer rejected the drift gate. */
class DriftGateRejectedError extends Error {
  constructor(reason?: string) {
    super(reason ? `approval rejected: ${reason}` : 'approval rejected');
    this.name = 'DriftGateRejectedError';
  }
}

/**
 * Runs one step under the run-level {@link CheckMode}, driving checked steps
 * through `runIdempotentStep` (never hand-rolled branching).
 *
 * - Plain step (no `check`): runs in apply mode; any check mode skips it with
 *   `no_check`, since a side-effecting step cannot be safely previewed.
 * - Checked step: `dryRun` in check mode, so `apply`/`run` never fires; drift
 *   is logged as its summary. An `approval: { when: 'drift' }` step in apply
 *   mode confirms through a payload-bearing step-approval and throws on reject
 *   (fail-stop); any other apply-mode step uses `yes: true`.
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
    return { status: 'success', outputs: await step.run(ctx) };
  }

  // The primitive's confirm/summarize see only the summary string; keep the
  // structured drift for the approval payload.
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
          // confirm() runs only on non-null drift, which is exactly "gate on
          // drift"; the author's summary comes from summarize(lastDrift), not
          // the primitive's prompt string.
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
            // Reject / expire is a fail-stop.
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
  // dry-run is a successful preview, distinct from an in-sync skip.
  const mappedStatus = res.outcome === CheckStepOutcome.enum['dry-run'] ? 'success' : status;
  return {
    checkOutcome: res.outcome as CheckStepOutcome,
    status: mappedStatus,
    outputs: res.result,
    ...(driftSummary !== undefined && { driftSummary }),
    ...(res.drift != null && { drift: res.drift }),
  };
}

/** Most lines of a failing step's error message that reach the run log. */
export const STEP_FAILURE_LOG_MAX_LINES = 100;
/** Most characters of a failing step's error message that reach the run log. */
export const STEP_FAILURE_LOG_MAX_CHARS = 8192;

/**
 * Writes a failing step's error message into its own log stream (as `stderr`).
 *
 * Otherwise the failure reaches only `step.complete` (the step row), and the run
 * log shows a red step with no reason; subprocess wrappers pack the diagnosis —
 * stderr, exit code, kill signal — into the error message.
 *
 * Bounded to {@link STEP_FAILURE_LOG_MAX_LINES} lines /
 * {@link STEP_FAILURE_LOG_MAX_CHARS} characters, because a wrapped process error
 * can carry a subprocess's entire output; the log states what was dropped, and
 * `step.complete` keeps the full message.
 *
 * It goes through `sendFn`, so the runner's secret masking applies as to
 * ordinary output. A failing `$({ quiet: true })` command's captured output
 * (otherwise kept out by the `verbose` gate in `streaming-zx-log.ts`) is in the
 * zx error message and so reaches the log — deliberately, since that failure is
 * otherwise undiagnosable. `maskMessageText` masks `step.complete.error.message`
 * too; registered secret values are masked, anything unregistered is not.
 */
function emitStepFailureLog(
  stepName: string,
  stepIndex: number,
  message: string,
  sendFn: (msg: RunnerToAgentMessage) => void,
): void {
  const prefix = `[kici] Step '${stepName}' failed: `;
  const capped =
    message.length > STEP_FAILURE_LOG_MAX_CHARS
      ? message.slice(0, STEP_FAILURE_LOG_MAX_CHARS)
      : message;
  const kept = (prefix + capped).split('\n').slice(0, STEP_FAILURE_LOG_MAX_LINES);

  for (const line of kept) {
    if (line) sendFn({ type: 'log.line', stepIndex, line, stream: LogStream.enum.stderr });
  }

  // Count against the ORIGINAL message, never the char-capped copy: each cap
  // also drops what the other measures, so counting from the copy reports
  // "0 more" for a cap that fired. `kept.join('\n')` is exactly the emitted
  // prefix of `prefix + capped`, so minus `prefix` it is the message
  // characters that got out; newlines after that are the lines that did not.
  const emittedChars = Math.max(0, kept.join('\n').length - prefix.length);
  const omittedChars = message.length - emittedChars;
  if (omittedChars > 0) {
    let omittedLines = 0;
    for (let i = emittedChars; i < message.length; i++) {
      if (message.charCodeAt(i) === 10 /* \n */) omittedLines++;
    }
    sendFn({
      type: 'log.line',
      stepIndex,
      line:
        `[kici] … error message truncated (${omittedLines} more line(s), ` +
        `${omittedChars} more character(s)); see the step's recorded error for the full text`,
      stream: LogStream.enum.stderr,
    });
  }
}

/** One step attempt, raced against its timeout, the job deadline and fail-fast. */
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
  // The timeout aborts `ctx.signal` through `opts.abortStep`, the fail-fast
  // controller; this flag keeps that self-inflicted abort from reporting
  // `cancelled` instead of the timeout message.
  let timedOut = false;
  // Rejected explicitly, not via an abort listener: a body that resolves on
  // `ctx.signal` settles in the same turn, so listener order would sometimes
  // report a timed-out step as successful.
  let rejectTimeout: (error: Error) => void = () => {};
  const timeoutRace = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    // Fix the verdict, then abort in the same turn so `ctx.$` kills its
    // subprocess and `fetch(..., { signal: ctx.signal })` rejects; otherwise
    // the timed-out command keeps running under `onFailure`'s rollback.
    rejectTimeout(new Error(`Step '${step.name}' timed out after ${timeoutMs}ms`));
    abortController.abort();
    opts.abortStep?.(stepIndex);
  }, timeoutMs);
  const stepAbortSignal = opts.getStepAbortSignal?.(stepIndex);

  const stepPromise = runStepWithCheckMode(step, stepIndex, ctx, checkMode, sendFn, opts);
  // `.then` with both handlers always fulfils, so no unhandled rejection; the
  // race handles `stepPromise` itself.
  let stepSettled = false;
  const stepSettledPromise = stepPromise.then(
    () => {
      stepSettled = true;
    },
    () => {
      stepSettled = true;
    },
  );

  try {
    const phase = await Promise.race([
      stepPromise,
      timeoutRace,
      // Job deadline: interrupt at once, not after the step's own (possibly
      // 30-min default) timeout.
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
      // Fail-fast: a failed parallel sibling aborted this step; it reports
      // `cancelled`, not `failed`.
      new Promise<never>((_, reject) => {
        if (!stepAbortSignal) return;
        if (stepAbortSignal.aborted) {
          reject(new StepCancelledError(step.name));
          return;
        }
        stepAbortSignal.addEventListener('abort', () => {
          // The timeout branch reports this step's own timeout abort.
          if (timedOut) return;
          reject(new StepCancelledError(step.name));
        });
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

    // Give the aborted body a bounded moment to unwind, so `onFailure` does not
    // roll back while the timed-out command holds its lock. A body ignoring
    // `ctx.signal` is named in the log ("gave up on it", not "stopped it").
    if (timedOut && !stepSettled) {
      await Promise.race([stepSettledPromise, delayUnref(STEP_ABORT_GRACE_MS)]);
      if (!stepSettled) {
        sendFn({
          type: 'log.line',
          stepIndex,
          line: `[timeout] Step '${step.name}' did not stop within ${STEP_ABORT_GRACE_MS}ms of its abort signal; continuing without it.`,
          stream: LogStream.enum.stderr,
        });
      }
    }

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

    // Before `step.complete`, so the line precedes the terminal status on the
    // runner->agent IPC channel. Only IPC order is guaranteed: the agent's
    // LogStreamer batches lines while statuses go out at once, so the chunk can
    // reach the orchestrator after the status.
    emitStepFailureLog(step.name, stepIndex, error.message, sendFn);

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

/** Unwind time a timed-out step gets after its abort before the loop moves on. */
const STEP_ABORT_GRACE_MS = 2000;

/** A timer-backed delay that never keeps the process alive on its own. */
function delayUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * One `step.secret_mount` event per `mountFile` / `exposeFile` call, on every
 * outcome path so the audit trail records every mount.
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

export interface StepIterationOutcome {
  result: SandboxStepResult;
  /** A failed step without continueOnError. */
  shouldBreak: boolean;
  /** Carried into the completion-hook outcome metadata. */
  failedStepName?: string;
}

/**
 * Null when the step should run. A rule whose `check()` threw fails the step
 * and breaks the loop — the gate could not be evaluated, so a skip would be a
 * false green; a rule returning `false` skips it and the loop continues.
 */
async function evaluateStepRulesAndMaybeSkip(
  step: Step,
  stepIndex: number,
  opts: StepLoopOptions,
): Promise<StepIterationOutcome | null> {
  if (!step.rules || step.rules.length === 0) return null;
  const ev = opts.event as {
    changedFiles?: string[];
    changedFilesStatus?: ChangedFilesStatus;
  };
  const ruleCtx = createRuleContext({
    event: opts.event,
    changedFiles: ev.changedFiles,
    changedFilesStatus: ev.changedFilesStatus,
    env: opts.env,
    dispatchInputs: opts.dispatchInputs ?? {},
    fanout: opts.fanout,
    // Spread conditionally: a present-but-undefined `sourceRepo` reads as
    // "declared" to a rule that guards on the key rather than the value.
    ...(opts.sourceRepo && { sourceRepo: opts.sourceRepo }),
    ...(opts.workflowRepo && { workflowRepo: opts.workflowRepo }),
  });
  const ruleResult = await evaluateRules(step.rules, ruleCtx, step.name);
  if (ruleResult.allPassed) return null;

  if (ruleResult.evaluationError) {
    const message = `rule '${ruleResult.evaluationError.label}' errored: ${ruleResult.evaluationError.message}`;
    opts.sendIpc({ type: 'step.start', stepIndex, stepName: step.name });
    opts.sendIpc({
      type: 'step.complete',
      stepIndex,
      status: ExecutionStepStatus.enum.failed,
      durationMs: 0,
      error: { message },
    });
    opts.sendIpc({
      type: 'log.line',
      stepIndex,
      line: `[kici] Step '${step.name}' failed: ${message}`,
      stream: LogStream.enum.stderr,
    });
    return {
      result: {
        name: step.name,
        stepIndex,
        status: ExecutionStepStatus.enum.failed,
        durationMs: 0,
        error: { message },
      },
      shouldBreak: true,
      failedStepName: step.name,
    };
  }

  opts.sendIpc({ type: 'step.start', stepIndex, stepName: step.name });
  opts.sendIpc({
    type: 'step.complete',
    stepIndex,
    status: ExecutionStepStatus.enum.failed, // IPC says failed; the returned result says skipped
    durationMs: 0,
  });
  opts.sendIpc({
    type: 'log.line',
    stepIndex,
    line: `[kici] Step '${step.name}' skipped: rule '${ruleResult.results.find((r) => !r.passed)?.label}' did not pass`,
  });
  return {
    result: {
      name: step.name,
      stepIndex,
      status: ExecutionStepStatus.enum.skipped,
      durationMs: 0,
    },
    shouldBreak: false,
  };
}

/**
 * Pre-step `when: 'always'` approval gate; a `when: 'drift'` gate fires inside
 * `runStepWithCheckMode` instead. Null when approved or ungated; a failed,
 * loop-breaking outcome on reject/expiry.
 */
async function maybeGateStepApproval(
  step: Step,
  stepIndex: number,
  opts: StepLoopOptions,
): Promise<StepIterationOutcome | null> {
  if (step.approval === undefined || !opts.awaitStepApproval) return null;

  const normalized = normalizeApproval(step.approval);
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
    stream: LogStream.enum.stderr,
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

/** A beforeStep / afterStep observer hook; a failure only logs, never changes job status. */
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
      stream: LogStream.enum.stderr,
    });
  }
}

/**
 * Runs a step through its retry policy. Each `executeStepInLoop` call is one
 * attempt with its own `step.timeout`, and never throws. A failed attempt
 * retries while attempts remain and `retryIf(reconstructedError)` is true, with
 * backoff between attempts; the caller applies `continueOnError` afterwards.
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
      stream: LogStream.enum.stderr,
    });
    await new Promise((r) => setTimeout(r, delay));
  }
  return result;
}

/**
 * One loop iteration: step rules → approval → beforeStep → execute → afterStep.
 * Per-step state (the `ctx.secrets.mountFile` tmpdir, env vars set via
 * `exposeFile`) is disposed even when the step throws, times out or rule-skips.
 */
export async function runStepIteration(
  step: Step,
  stepIndex: number,
  opts: StepLoopOptions,
): Promise<StepIterationOutcome> {
  const ruleOutcome = await evaluateStepRulesAndMaybeSkip(step, stepIndex, opts);
  if (ruleOutcome) {
    // The outer caller may already have allocated context state (the secrets
    // handle, when `getSecretMountRecords` is wired).
    await opts.disposeStepResources?.(stepIndex);
    return ruleOutcome;
  }

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

    // A failed step does not save: its artifacts may be partial.
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

interface CompletionState {
  failed: boolean;
  failedStepName?: string;
  failureReason?: string;
}

/** One completion hook; a failure appends to `failureReason` and may promote the job to failed. */
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
 * onSuccess or onFailure, then cleanup (always), whose outcome is recomputed to
 * include onSuccess/onFailure failures.
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

  // Tells the supervisor not to re-run the hooks out-of-band; sent even when a
  // hook failed, since the job status already carries the failure.
  opts.sendIpc({ type: 'completion-hooks-done' });

  return state;
}

/**
 * Hook order: beforeStep -> step -> afterStep per step, then onSuccess or
 * onFailure, then cleanup (always). beforeStep/afterStep failures do not affect
 * execution; only completion hooks can change the job status to failed.
 */
export async function executeStepLoop(opts: StepLoopOptions): Promise<StepLoopResult> {
  const startTime = opts.startTime ?? Date.now();
  const stepResults: SandboxStepResult[] = [];
  const state: CompletionState = { failed: opts.forceInitialFailure === true };

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

  // The workflow-runner's cancel path runs onCancel + cleanup; running the
  // completion hooks here too would double-execute them.
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
