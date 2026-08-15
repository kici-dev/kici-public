/**
 * Workflow Runner -- standalone entry point that runs INSIDE the sandbox.
 *
 * This is the code that actually executes customer workflows in isolation.
 * The agent process never loads or executes customer code -- only this runner does.
 *
 * Supports two IPC modes:
 * - Fork IPC: Used by bare-metal (bwrap) and Firecracker backends. Messages go
 *   via Node.js IPC channel (process.send / process.on('message')).
 * - Stdio IPC: Used by container backend (docker exec). JSON-line messages flow
 *   bidirectionally: agent writes to container stdin, runner writes to stdout.
 *
 * This file is compiled alongside the agent by rolldown (existing build), but
 * runs as a SEPARATE process spawned by the sandbox backend.
 */

import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $, $ as zx$ } from 'zx';
import { initZx, toErrorMessage } from '@kici-dev/shared';
import { createTempScope, makeTempDir, type TempHandle, type TempScope } from '@kici-dev/core/tmp';
import { makeStreamingZxLog } from '../streaming-zx-log.js';
import {
  ExecutionJobStatus,
  ExecutionStepStatus,
  LogStream,
  TimeoutReason,
} from '@kici-dev/engine';
import type { ChangedFilesStatus } from '@kici-dev/engine';
import { computeChangedFiles } from '../../checkout/changed-files.js';
import type { GitAuth } from '../../checkout/git-clone.js';
import type {
  Step,
  StepInput,
  Job,
  Logger,
  StepContext,
  JobOrFactory,
  RepoInfo,
  HookInput,
  Workflow,
  CacheSpec,
  EventPayload,
} from '@kici-dev/sdk';
import {
  isDynamicJobFn,
  isParallelGroup,
  buildKiciApi,
  createStepSecrets,
  setStepOutputsMap,
  setJobOutputsMap,
  setStepRefMap,
  resolveStepOutputs,
  resolveJobOutputs,
  normalizeCacheSpecs,
  provenanceSubjectIsPath,
  buildNeedsContext,
  isEventDefinition,
} from '@kici-dev/sdk';
import type {
  UpstreamSnapshot,
  NeedsContext,
  DynamicJobNeed,
  FanoutPosition,
  EventDefinition,
} from '@kici-dev/sdk';
import type {
  OutputsMap,
  StepRefMap,
  TrackedStepSecrets,
  StepSecretsHandle,
  StepSecretsFileHost,
} from '@kici-dev/sdk';
import {
  OIDC_TOKEN_REQUEST_METHOD,
  type OidcTokenResult,
} from '@kici-dev/engine/protocol/messages/oidc-token-relay';
import { sha256File } from '@kici-dev/core';
import type { AttestProvenanceOptions } from '@kici-dev/sdk';
import { attestProvenance as runAttest } from '../../provenance/attest.js';
import { uploadToPresignedUrl } from '../download.js';
import type {
  RunnerToAgentMessage,
  AgentToRunnerMessage,
  EventEmitRequest,
  EventEmitResponse,
  ConcurrencyAckMessage,
  CacheResponseIpc,
  ProvenanceResponseIpc,
  ArtifactResponseIpc,
  StepApprovalResolvedIpc,
  JobExecutionRequest,
} from './ipc-protocol.js';
import type { SandboxStepResult } from './types.js';
import {
  createCacheApi,
  restoreCacheSpecs,
  saveCacheSpecs,
  createCacheStepIndexAllocator,
  JOB_CACHE_OWNER,
  type CacheTransport,
  type CachePhaseDeps,
} from '../cache/index.js';
import { createArtifactsApi, type ArtifactTransport } from '../artifacts/artifact-engine.js';
import { LogMasker } from './log-masker.js';
import { applyEnvDelta } from './env-delta.js';
import { createEnvFiles, readEnvDelta, truncateEnvFiles, type EnvFiles } from './env-file.js';
import { buildMergedFlatSecrets } from './secret-merge.js';
import { executeStepLoop, type StepNode } from './step-loop.js';
import { runInStepCapture, currentCaptureStepIndex } from './capture-context.js';
import { StepTaskRegistry } from './step-task-registry.js';
import type { JobHooks, StepLoopOptions } from './step-loop.js';
import { runInitPhase } from '../env-init/init-phase.js';
import { normalizeInitItems } from '../env-init/presets/directives.js';
import { expandInitDirectives } from '../env-init/presets/expand.js';
import { armJobDeadline } from './job-deadline.js';
import { executeHook, buildOutcomeMetadata } from '../hook-executor.js';
import { gitClone } from '../../checkout/git-clone.js';
import { restoreDeps, excludeScratchFromGit } from '../dep-restore.js';
import { installDeps } from '../dep-installer.js';
import {
  loadWorkflowSource,
  extractWorkflow,
  extractSteps,
  extractStepsFromDynamicJob,
} from '../workflow-loader.js';
import type { SdkOutputSetters } from '../workflow-loader.js';
import type { GeneratorRepoPair } from '../generator-context.js';
import { applyGlobalWorkflowEnv, repoIdentifierFromUrl } from '../global-workflow-env.js';
import { restoreSource } from '../source-restore.js';
import { evaluateRules, createRuleContext, type RuleEvaluationResult } from '../rule-evaluator.js';
import { applyOverlay } from '../overlay-applier.js';

/** Build-time agent version (injected by the bundler; 'unknown' in unbundled tests). */
declare const KICI_PKG_VERSION: string;
const AGENT_VERSION = typeof KICI_PKG_VERSION !== 'undefined' ? KICI_PKG_VERSION : 'unknown';

// --- Global error handlers (must be first) ---

process.on('uncaughtException', (err) => {
  process.stderr.write(`[workflow-runner] UNCAUGHT EXCEPTION: ${err.message}\n`);
  if (err.stack) process.stderr.write(`[workflow-runner] Stack: ${err.stack}\n`);
  process.exit(99);
});

process.on('unhandledRejection', (reason) => {
  const msg = toErrorMessage(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  process.stderr.write(`[workflow-runner] UNHANDLED REJECTION: ${msg}\n`);
  if (stack) process.stderr.write(`[workflow-runner] Stack: ${stack}\n`);
  process.exit(98);
});

// --- IPC Mode Detection ---

/** Whether we are running in fork IPC mode (Node IPC channel available). */
const isForkMode = typeof process.send === 'function';

/**
 * Saved references to the original stdout/stderr write functions.
 * Used by sendMessage (container mode IPC) and output capture to avoid
 * infinite recursion when process.stdout.write is monkey-patched.
 */
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

// --- Console Output Capture ---

/**
 * Workflow-level capture flag for the pre-step `prepare` phase
 * (module load, concurrency-group evaluation, rule evaluation).
 *
 * When true, process.stdout/stderr writes are captured and emitted as
 * log.line IPC messages with `stepIndex: -1` — the same bucket already used
 * by existing meta-messages like `[kici] Concurrency group: ...`. This means
 * user console.log inside module top-level, concurrency-group functions, and
 * rule check functions lands in the job's workflow-level log file
 * (`executions/{runId}/job-{name}/step--1.log`) alongside runner narration.
 *
 * Mutually exclusive with a step capture scope: the step loop resets this flag
 * to false before any step runs inside its {@link runInStepCapture} scope (the
 * async-context source of {@link currentCaptureStepIndex}).
 */
let capturePrepareActive = false;

/** The maskedSend function used by the output capture. Set during main(). */
let captureSendFn: ((msg: RunnerToAgentMessage) => void) | null = null;

function captureIsActive(): boolean {
  return (currentCaptureStepIndex() >= 0 || capturePrepareActive) && captureSendFn !== null;
}

function captureTargetIndex(): number {
  // A step capture scope (async context) attributes to its own step index;
  // `capturePrepareActive` emits as workflow-level log (stepIndex: -1).
  return currentCaptureStepIndex();
}

/**
 * Install monkey-patches on process.stdout.write and process.stderr.write
 * so that console.log() / console.error() calls from customer step code
 * are captured and forwarded as log.line IPC messages.
 *
 * Without this, only subprocess output (via ctx.$) goes through zx's log
 * callback. Direct console.log() calls from pure JS/TS step code would be
 * lost (stdout goes to a pipe the fork-runner drains for debugging, but
 * never enters the log streaming pipeline).
 */
function installOutputCapture(): void {
  let stdoutBuf = '';
  let stderrBuf = '';

  process.stdout.write = ((chunk: any, encodingOrCb?: any, cb?: any): boolean => {
    if (captureIsActive() && captureSendFn) {
      const text =
        typeof chunk === 'string'
          ? chunk
          : chunk.toString(typeof encodingOrCb === 'string' ? encodingOrCb : 'utf8');
      stdoutBuf += text;
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop()!;
      const stepIdx = captureTargetIndex();
      for (const line of lines) {
        if (line) captureSendFn({ type: 'log.line', stepIndex: stepIdx, line });
      }
    }
    // In fork mode, still write to real stdout (fork-runner drains it for debug logs).
    // In stdio mode, origStdoutWrite is used by sendMessage for IPC — don't echo
    // console output there as it would corrupt the JSON-lines protocol.
    if (isForkMode) {
      return origStdoutWrite(chunk, encodingOrCb, cb);
    }
    // In stdio mode, swallow the raw output (it was already captured as log.line)
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    if (callback) callback();
    return true;
  }) as any;

  process.stderr.write = ((chunk: any, encodingOrCb?: any, cb?: any): boolean => {
    if (captureIsActive() && captureSendFn) {
      const text =
        typeof chunk === 'string'
          ? chunk
          : chunk.toString(typeof encodingOrCb === 'string' ? encodingOrCb : 'utf8');
      stderrBuf += text;
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop()!;
      const stepIdx = captureTargetIndex();
      for (const line of lines) {
        if (line)
          captureSendFn({
            type: 'log.line',
            stepIndex: stepIdx,
            line,
            stream: LogStream.enum.stderr,
          });
      }
    }
    // Always forward stderr to the real stderr for crash diagnostics
    return origStderrWrite(chunk, encodingOrCb, cb);
  }) as any;
}

/**
 * Flush any remaining partial lines in the output capture buffers.
 * Called after each step completes to ensure no trailing output is lost.
 */
function flushOutputCapture(): void {
  // The buffers are closured inside installOutputCapture. To flush them,
  // we write a final newline which triggers the line split logic.
  // This is a no-op if buffers are already empty.
  if (captureIsActive()) {
    // Force flush by writing a newline to both streams
    process.stdout.write('\n');
    process.stderr.write('\n');
  }
}

/**
 * Send a message from the runner to the agent.
 *
 * In fork mode: uses Node.js IPC channel (process.send).
 * In stdio mode: writes a JSON line to stdout via origStdoutWrite
 * (bypasses any monkey-patch on process.stdout.write).
 */
function sendMessage(msg: RunnerToAgentMessage): void {
  if (isForkMode) {
    process.send!(msg);
  } else {
    // Stdout JSON-lines for container (docker exec) mode.
    // Each message is a single JSON line terminated by newline.
    // Uses origStdoutWrite to bypass output capture during step execution.
    origStdoutWrite(JSON.stringify(msg) + '\n');
  }
}

/**
 * Readline interface for stdin in stdio (container) mode.
 * Created once and reused for both receiveRequest() and the response listener.
 */
let stdinRl: ReturnType<typeof createInterface> | null = null;

/**
 * Get or create the stdin readline interface for container/stdio mode.
 */
function getStdinRl(): ReturnType<typeof createInterface> {
  if (!stdinRl) {
    process.stdin.setEncoding('utf-8');
    stdinRl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  }
  return stdinRl;
}

/**
 * Receive the execution request from the agent.
 *
 * In fork mode: listens for the first 'execute' message on the IPC channel.
 * In stdio mode: reads JSON-lines from stdin, resolves on the first 'execute' message.
 *
 * @returns The execute message containing the JobExecutionRequest.
 */
function receiveRequest(): Promise<AgentToRunnerMessage & { type: 'execute' }> {
  if (isForkMode) {
    return new Promise((resolve) => {
      const handler = (msg: AgentToRunnerMessage) => {
        if (msg.type === 'execute') {
          process.removeListener('message', handler);
          resolve(msg);
        }
      };
      process.on('message', handler);
    });
  } else {
    // Stdio mode: read JSON-lines from stdin, resolve on first 'execute' message.
    return new Promise((resolve, reject) => {
      const rl = getStdinRl();
      const handler = (line: string) => {
        try {
          const parsed = JSON.parse(line) as AgentToRunnerMessage;
          if (parsed.type === 'execute') {
            rl.removeListener('line', handler);
            resolve(parsed);
          }
        } catch (e) {
          rl.removeListener('line', handler);
          reject(new Error(`Failed to parse stdin JSON: ${toErrorMessage(e)}`));
        }
      };
      rl.on('line', handler);
    });
  }
}

// --- zx Configuration ---

// Initialize zx for cross-platform quote support.
initZx();

// Don't echo commands ($`...` → "$ echo hello"), but allow output to flow
// to process.stdout/stderr so our step output capture can intercept it.
$.verbose = false;
$.quiet = false;

// --- Cancel State ---

/** Global abort flag. Set when abort message or SIGTERM is received. */
let aborted = false;

/**
 * Force cancel flag. When true, skip all remaining hooks and exit immediately.
 * Set when abort IPC arrives with force=true, or on second cancel while already cancelling.
 */
let forceAborted = false;

/**
 * Set when the job-level wall-clock deadline (the lock job's `timeout`) is
 * breached. Trips the same abort path cancellation uses, but tags the
 * job.complete with the distinct TimeoutReason.job_timeout reason.
 */
let jobTimedOut = false;

/** The configured job timeout budget in ms, captured when the deadline fires. */
let jobTimedOutMs: number | undefined;

/**
 * Aborted when the job-level deadline fires. Threaded into the step loop so the
 * IN-FLIGHT step (e.g. a long-running `sleep`) is interrupted immediately on
 * breach — the between-steps `isAborted()` check alone cannot unwind a single
 * long step that has no per-step `timeout`.
 */
const jobDeadlineAbort = new AbortController();

/**
 * Aborted when the job is being torn down by cancellation (abort IPC / SIGTERM),
 * as distinct from the wall-clock deadline (`jobDeadlineAbort`). Each step's
 * `ctx.signal` composes this with the deadline signal and its own per-step
 * controller, so a cancelled job cooperatively unwinds in-flight step bodies
 * that opted into `ctx.signal`. Inert for the rest of the runner today.
 */
const jobCancelAbort = new AbortController();

// --- Event Emit Response Tracking ---

/**
 * Pending promises for event.emit requests awaiting responses from the agent.
 *
 * Key: requestId (correlates EventEmitRequest -> EventEmitResponse)
 * Value: resolve/reject pair for the waiting ctx.emit() call
 */
const pendingEmitResponses = new Map<
  string,
  {
    resolve: (response: EventEmitResponse) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

/** Default timeout for event.emit responses (5 seconds per research doc). */
const EMIT_RESPONSE_TIMEOUT_MS = 5_000;

/**
 * Wait for an event.emit.response from the agent with the given requestId.
 *
 * On timeout, resolves with a synthetic success receipt and logs a warning
 * (per research doc pitfall 5: event was already persisted by orchestrator,
 * so it will still be routed even if the ack is lost).
 */
function waitForEmitResponse(requestId: string): Promise<EventEmitResponse> {
  return new Promise<EventEmitResponse>((resolve) => {
    const timer = setTimeout(() => {
      pendingEmitResponses.delete(requestId);
      // Synthetic receipt on timeout -- event was persisted by orchestrator,
      // delivery proceeds regardless of ack.
      process.stderr.write(
        `[workflow-runner] event.emit response timeout for requestId=${requestId} -- returning synthetic receipt\n`,
      );
      resolve({
        type: 'event.emit.response',
        requestId,
        deliveryId: `timeout-${requestId}`,
      });
    }, EMIT_RESPONSE_TIMEOUT_MS);

    pendingEmitResponses.set(requestId, {
      resolve: (response: EventEmitResponse) => {
        clearTimeout(timer);
        pendingEmitResponses.delete(requestId);
        resolve(response);
      },
      reject: (err: Error) => {
        clearTimeout(timer);
        pendingEmitResponses.delete(requestId);
        // On rejection, resolve with error-shaped response rather than throwing
        resolve({
          type: 'event.emit.response',
          requestId,
          error: err.message,
        });
      },
      timer,
    });
  });
}

// --- Concurrency Ack Tracking ---

/**
 * Pending promise for the concurrency.ack response from the agent.
 * Only one outstanding concurrency report per job (one workflow = one group).
 */
let pendingConcurrencyAck: {
  resolve: (ack: ConcurrencyAckMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
} | null = null;

/**
 * Wait for a concurrency.ack from the agent (relayed from orchestrator).
 * The timeout is configurable (default 30s) and fails the job on expiry.
 */
function waitForConcurrencyAck(timeoutMs: number): Promise<ConcurrencyAckMessage> {
  return new Promise<ConcurrencyAckMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingConcurrencyAck = null;
      reject(new Error(`Concurrency group ack timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingConcurrencyAck = {
      resolve: (ack: ConcurrencyAckMessage) => {
        clearTimeout(timer);
        pendingConcurrencyAck = null;
        resolve(ack);
      },
      reject: (err: Error) => {
        clearTimeout(timer);
        pendingConcurrencyAck = null;
        reject(err);
      },
      timer,
    };
  });
}

// --- Agent API Response Tracking ---

/**
 * Pending promises for agent.api.response messages from the agent.
 * Key: requestId, Value: resolve/reject pair.
 */
const pendingApiResponses = new Map<
  string,
  {
    resolve: (result: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

const API_RESPONSE_TIMEOUT_MS = 15_000;

/**
 * Wait for an agent.api.response from the agent with the given requestId.
 */
function waitForApiResponse(requestId: string): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingApiResponses.delete(requestId);
      reject(new Error(`Agent API request timed out after ${API_RESPONSE_TIMEOUT_MS}ms`));
    }, API_RESPONSE_TIMEOUT_MS);

    pendingApiResponses.set(requestId, {
      resolve: (result) => {
        clearTimeout(timer);
        pendingApiResponses.delete(requestId);
        resolve(result);
      },
      reject: (err) => {
        clearTimeout(timer);
        pendingApiResponses.delete(requestId);
        reject(err);
      },
      timer,
    });
  });
}

// --- User-facing cache request/response tracking ---

/**
 * Pending promises for cache.response messages from the agent.
 * Key: requestId (correlates cache.request -> cache.response).
 */
const pendingCacheResponses = new Map<
  string,
  {
    resolve: (response: CacheResponseIpc) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

/** Default timeout for a cache request relay (matches the upload-URL request budget). */
const CACHE_RESPONSE_TIMEOUT_MS = 30_000;

/**
 * Pending promises for provenance.response messages from the agent.
 * Key: requestId (correlates provenance.request -> provenance.response).
 */
const pendingProvenanceResponses = new Map<
  string,
  {
    resolve: (response: ProvenanceResponseIpc) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

/** Wait for a provenance.response from the agent with the given requestId. */
function waitForProvenanceResponse(requestId: string): Promise<ProvenanceResponseIpc> {
  return new Promise<ProvenanceResponseIpc>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingProvenanceResponses.delete(requestId);
      reject(new Error(`Provenance request timed out after ${CACHE_RESPONSE_TIMEOUT_MS}ms`));
    }, CACHE_RESPONSE_TIMEOUT_MS);

    pendingProvenanceResponses.set(requestId, {
      resolve: (response) => {
        clearTimeout(timer);
        pendingProvenanceResponses.delete(requestId);
        resolve(response);
      },
      reject: (err) => {
        clearTimeout(timer);
        pendingProvenanceResponses.delete(requestId);
        reject(err);
      },
      timer,
    });
  });
}

/**
 * Pending promises for artifacts.response messages from the agent.
 * Key: requestId (correlates artifacts.request -> artifacts.response).
 */
const pendingArtifactResponses = new Map<
  string,
  {
    resolve: (response: ArtifactResponseIpc) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

/** Wait for an artifacts.response from the agent with the given requestId. */
function waitForArtifactResponse(requestId: string): Promise<ArtifactResponseIpc> {
  return new Promise<ArtifactResponseIpc>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingArtifactResponses.delete(requestId);
      reject(new Error(`Artifact request timed out after ${CACHE_RESPONSE_TIMEOUT_MS}ms`));
    }, CACHE_RESPONSE_TIMEOUT_MS);

    pendingArtifactResponses.set(requestId, {
      resolve: (response) => {
        clearTimeout(timer);
        pendingArtifactResponses.delete(requestId);
        resolve(response);
      },
      reject: (err) => {
        clearTimeout(timer);
        pendingArtifactResponses.delete(requestId);
        reject(err);
      },
      timer,
    });
  });
}

/** Wait for a cache.response from the agent with the given requestId. */
function waitForCacheResponse(requestId: string): Promise<CacheResponseIpc> {
  return new Promise<CacheResponseIpc>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCacheResponses.delete(requestId);
      reject(new Error(`Cache request timed out after ${CACHE_RESPONSE_TIMEOUT_MS}ms`));
    }, CACHE_RESPONSE_TIMEOUT_MS);

    pendingCacheResponses.set(requestId, {
      resolve: (response) => {
        clearTimeout(timer);
        pendingCacheResponses.delete(requestId);
        resolve(response);
      },
      reject: (err) => {
        clearTimeout(timer);
        pendingCacheResponses.delete(requestId);
        reject(err);
      },
      timer,
    });
  });
}

/**
 * Pending promises for approval.resolved messages from the agent.
 * Key: requestId (correlates approval.request -> approval.resolved).
 */
const pendingApprovalResolutions = new Map<
  string,
  {
    resolve: (response: StepApprovalResolvedIpc) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

/**
 * Hard ceiling on how long the runner blocks a step waiting for an approval
 * resolution. The orchestrator enforces the real (org-/SDK-configured) expiry
 * and sends `expired` when it lapses; this is a safety net well above any sane
 * approval window so the runner cannot hang forever if the resolution is lost.
 */
const APPROVAL_RESOLUTION_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

/** Wait for an approval.resolved from the agent with the given requestId. */
function waitForApprovalResolution(requestId: string): Promise<StepApprovalResolvedIpc> {
  return new Promise<StepApprovalResolvedIpc>((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovalResolutions.delete(requestId);
      // Fail closed: an unresolved approval is treated as expired.
      resolve({ type: 'approval.resolved', requestId, outcome: 'expired' });
    }, APPROVAL_RESOLUTION_TIMEOUT_MS);

    pendingApprovalResolutions.set(requestId, {
      resolve: (response) => {
        clearTimeout(timer);
        pendingApprovalResolutions.delete(requestId);
        resolve(response);
      },
      timer,
    });
  });
}

/**
 * Send a step-approval `approval.request` IPC (relayed by the agent over the WS
 * as a `step.approval-request`), await the matching `approval.resolved`, and map
 * it onto a `StepApprovalResolution`. A relay error is treated as a fail-closed
 * reject. Shared by the `when: 'always'` and `when: 'drift'` callbacks; the
 * latter carries a drift `payload`.
 */
async function requestStepApproval(req: {
  stepIndex: number;
  stepName: string;
  clauses: Array<{ team: string } | { user: string }>;
  reason: string;
  timeoutSeconds?: number;
  payload?: { summaryMarkdown: string; drift: unknown };
}): Promise<{ outcome: 'approved' | 'rejected' | 'expired'; reason?: string }> {
  const requestId = randomUUID();
  sendMessage({
    type: 'approval.request',
    requestId,
    stepIndex: req.stepIndex,
    stepName: req.stepName,
    clauses: req.clauses,
    reason: req.reason,
    ...(req.timeoutSeconds !== undefined && { timeoutSeconds: req.timeoutSeconds }),
    ...(req.payload !== undefined && { payload: req.payload }),
  });
  const resolution = await waitForApprovalResolution(requestId);
  if (resolution.error) {
    return { outcome: 'rejected', reason: resolution.error };
  }
  return {
    outcome: resolution.outcome ?? 'rejected',
    ...(resolution.reason !== undefined && { reason: resolution.reason }),
  };
}

/**
 * Build the `awaitStepApproval` callback the step loop uses to block on an
 * `approval` step (`when: 'always'`).
 */
function buildAwaitStepApproval(): NonNullable<StepLoopOptions['awaitStepApproval']> {
  return (req) => requestStepApproval(req);
}

/**
 * Build the `awaitStepApprovalWithPayload` callback the step loop uses to block
 * on a `when: 'drift'` step mid-execution, carrying the computed drift payload.
 */
function buildAwaitStepApprovalWithPayload(): NonNullable<
  StepLoopOptions['awaitStepApprovalWithPayload']
> {
  return (req) => requestStepApproval(req);
}

/**
 * Build the {@link CacheTransport} the sandbox-side cache engine uses to reach
 * the orchestrator. Each method sends a `cache.request` IPC (relayed by the
 * agent over the WS as a `cache.user.*` message) and awaits the matching
 * `cache.response`. Mirrors the `event.emit` / `agent.api.request` relays.
 */
function buildCacheTransport(): CacheTransport {
  return {
    async restore(key, restoreKeys) {
      const requestId = randomUUID();
      sendMessage({
        type: 'cache.request',
        requestId,
        op: 'restore',
        key,
        ...(restoreKeys && { restoreKeys }),
      });
      const response = await waitForCacheResponse(requestId);
      if (response.error) throw new Error(`Cache restore failed: ${response.error}`);
      return {
        hit: response.hit ?? false,
        ...(response.matchedKey && { matchedKey: response.matchedKey }),
        ...(response.downloadUrl && { downloadUrl: response.downloadUrl }),
        ...(response.tarHash && { tarHash: response.tarHash }),
      };
    },
    async beginSave(key) {
      const requestId = randomUUID();
      sendMessage({ type: 'cache.request', requestId, op: 'beginSave', key });
      const response = await waitForCacheResponse(requestId);
      if (response.error) throw new Error(`Cache save failed: ${response.error}`);
      return {
        skip: response.skip ?? true,
        ...(response.uploadUrl && { uploadUrl: response.uploadUrl }),
      };
    },
    async completeSave(key, tarHash, sizeBytes) {
      const requestId = randomUUID();
      sendMessage({
        type: 'cache.request',
        requestId,
        op: 'completeSave',
        key,
        tarHash,
        sizeBytes,
      });
      const response = await waitForCacheResponse(requestId);
      if (response.error) throw new Error(`Cache save-complete failed: ${response.error}`);
    },
  };
}

/**
 * Build the {@link ArtifactTransport} the sandbox-side artifacts engine uses to
 * reach the orchestrator. Each method sends an `artifacts.request` IPC (relayed
 * by the agent over the WS as an `artifacts.upload.*` / `artifacts.download.*`
 * message) and awaits the matching `artifacts.response`. Mirrors
 * {@link buildCacheTransport}.
 */
function buildArtifactTransport(): ArtifactTransport {
  return {
    async beginUpload(name, declaredSizeBytes) {
      const requestId = randomUUID();
      sendMessage({
        type: 'artifacts.request',
        requestId,
        op: 'beginUpload',
        name,
        declaredSizeBytes,
      });
      const response = await waitForArtifactResponse(requestId);
      if (response.error) throw new Error(`Artifact upload failed: ${response.error}`);
      return {
        outcome: response.uploadOutcome ?? 'rejected',
        ...(response.uploadUrl && { uploadUrl: response.uploadUrl }),
        ...(response.storageKey && { storageKey: response.storageKey }),
        ...(response.reason && { reason: response.reason }),
        ...(response.rejectionDetail && { error: response.rejectionDetail }),
      };
    },
    async completeUpload(name, sizeBytes, sha256, storageKey) {
      const requestId = randomUUID();
      sendMessage({
        type: 'artifacts.request',
        requestId,
        op: 'completeUpload',
        name,
        sizeBytes,
        sha256,
        storageKey,
      });
      const response = await waitForArtifactResponse(requestId);
      if (response.error) throw new Error(`Artifact upload-complete failed: ${response.error}`);
    },
    async download(name) {
      const requestId = randomUUID();
      sendMessage({ type: 'artifacts.request', requestId, op: 'download', name });
      const response = await waitForArtifactResponse(requestId);
      if (response.error) throw new Error(`Artifact download failed: ${response.error}`);
      return {
        outcome: response.downloadOutcome ?? 'not_found',
        ...(response.downloadUrl && { downloadUrl: response.downloadUrl }),
        ...(response.sizeBytes !== undefined && { sizeBytes: response.sizeBytes }),
        ...(response.sha256 && { sha256: response.sha256 }),
        ...(response.rejectionDetail && { error: response.rejectionDetail }),
      };
    },
  };
}

/** Send a `provenance.request` IPC and await the matching `provenance.response`. */
async function relayProvenanceIpc(
  request: Omit<import('./ipc-protocol.js').ProvenanceRequestIpc, 'type' | 'requestId'>,
): Promise<ProvenanceResponseIpc> {
  const requestId = randomUUID();
  sendMessage({ type: 'provenance.request', requestId, ...request });
  const response = await waitForProvenanceResponse(requestId);
  if (response.error) throw new Error(`Provenance relay failed: ${response.error}`);
  return response;
}

/**
 * Extract an `owner/repo` identifier from a git clone URL for a deferred
 * statement's `externalParameters.workflow.repository` (the live path reads this
 * from the minted token claim; the deferred path has no token yet).
 */
function extractRepoIdentifier(repoUrl: string): string {
  const match = repoUrl.match(/(?:github|gitlab|bitbucket)\.\w+\/([^/]+\/[^/.]+)/);
  return match ? match[1] : 'unknown/unknown';
}

/**
 * Build the `ctx.attestProvenance` step helper. Resolves a `path` subject to a
 * SHA-256 digest, threads the identity token via the supplied OIDC getter, and
 * persists the bundle over the IPC -> WS provenance-upload relay. On a transient
 * mint failure the statement is frozen + reported for later minting (deferred);
 * the step still completes.
 */
function buildAttestProvenanceFn(
  request: JobExecutionRequest,
  workDir: string,
  getIdToken: (opts: { audience: string }) => Promise<OidcTokenResult>,
): StepContext['attestProvenance'] {
  return async (opts: AttestProvenanceOptions) => {
    const subject = provenanceSubjectIsPath(opts.subject)
      ? {
          name: opts.subject.name,
          digest: { sha256: await sha256File(join(workDir, opts.subject.path)) },
        }
      : { name: opts.subject.name, digest: opts.subject.digest as Record<string, string> };

    const result = await runAttest(
      {
        getIdToken,
        builderVersions: { 'kici-agent': AGENT_VERSION, 'kici-orchestrator': 'unknown' },
        localContext: {
          repository: extractRepoIdentifier(request.repoUrl),
          ref: request.ref,
          sha: request.sha || null,
          workflowRef: request.workflowRef ?? request.workflowName,
          runId: request.runId,
          jobId: request.jobId,
          issuer: request.provenanceIssuer ?? '',
        },
        // Transient mint failure: relay the frozen envelope for later minting
        // instead of uploading a bundle. The job stays green.
        reportDeferred: async (report) => {
          await relayProvenanceIpc({
            op: 'defer',
            subjectDigest: report.subjectDigest,
            subjectName: report.subjectName,
            mediaType: report.mediaType,
            audience: report.audience,
            statementHash: report.statementHash,
            dsseEnvelope: report.dsseEnvelope,
            publicKey: report.publicKey,
          });
        },
        persist: async (bundle, subjectDigest) => {
          const urlResponse = await relayProvenanceIpc({ op: 'requestUploadUrl', subjectDigest });
          if (!urlResponse.uploadUrl) {
            throw new Error('Orchestrator returned no provenance upload URL');
          }
          await uploadToPresignedUrl(urlResponse.uploadUrl, Buffer.from(JSON.stringify(bundle)));
          await relayProvenanceIpc({
            op: 'complete',
            subjectDigest,
            subjectName: subject.name,
            mediaType: bundle.mediaType,
          });
          // The orchestrator owns the canonical key (runId resolved server-side);
          // mirror its derivation locally for the returned result.
          return `provenance/${request.runId}/${request.jobId}/${subjectDigest}.kici.json`;
        },
      },
      { subject, ...(opts.audience !== undefined && { audience: opts.audience }) },
    );

    if ('deferred' in result) {
      return {
        deferred: true as const,
        subjectDigest: result.subjectDigest,
        statementHash: result.statementHash,
      };
    }
    return {
      storageKey: result.storageKey,
      subjectDigest: result.subjectDigest,
      bundleMediaType: result.bundle.mediaType,
    };
  };
}

/**
 * Build the declarative-cache phase dependencies and run the job-level cache
 * restore (Phase 9b).
 *
 * The deps carry one job-scoped cache API (over the same IPC→WS transport
 * `ctx.cache` uses) plus a monotonic pseudo-step index allocator that starts
 * well above every real-step and hook index (hooks use up to `stepCount * 3`).
 * Cache restores/saves surface as `cache:restore` / `cache:save` pseudo-steps
 * allocated from this cursor. The returned `jobCacheRestore` map lets the
 * post-loop save phase skip exact-key hits.
 */
async function setupJobCache(
  stepCwd: string,
  stepCount: number,
  jobCache: Job['cache'],
  sendIpc: (msg: RunnerToAgentMessage) => void,
): Promise<{
  cachePhaseDeps: CachePhaseDeps;
  jobCacheSpecs: CacheSpec[];
  jobCacheRestore: Map<string, { hit: boolean; matchedKey?: string }>;
}> {
  const cachePhaseDeps: CachePhaseDeps = {
    cache: createCacheApi(stepCwd, buildCacheTransport()),
    sendIpc,
    nextStepIndex: createCacheStepIndexAllocator(stepCount),
  };
  const jobCacheSpecs: CacheSpec[] = normalizeCacheSpecs(jobCache);
  const jobCacheRestore =
    jobCacheSpecs.length > 0
      ? await restoreCacheSpecs(jobCacheSpecs, cachePhaseDeps, JOB_CACHE_OWNER)
      : new Map<string, { hit: boolean; matchedKey?: string }>();
  return { cachePhaseDeps, jobCacheSpecs, jobCacheRestore };
}

/**
 * Job-level cache save (Phase 9c). Runs after the step loop, only when every
 * step succeeded and the job was not aborted. Each spec whose exact key did NOT
 * already hit on restore is saved (immutable: a re-save of an existing exact
 * key is skipped by the save phase itself). A no-op when the job declared no
 * cache or did not fully succeed (a failed/aborted job's artifacts may be
 * partial).
 */
async function maybeSaveJobCache(
  specs: CacheSpec[],
  restoreResults: Map<string, { hit: boolean; matchedKey?: string }>,
  deps: CachePhaseDeps,
  succeeded: boolean,
): Promise<void> {
  if (specs.length === 0 || !succeeded) return;
  await saveCacheSpecs(specs, restoreResults, deps, JOB_CACHE_OWNER);
}

/**
 * Dispatch an agent-to-runner message to the appropriate pending handler.
 * Shared between fork mode (IPC channel) and stdio mode (stdin readline).
 */
function dispatchAgentMessage(msg: AgentToRunnerMessage): void {
  if (msg.type === 'abort') {
    aborted = true;
    jobCancelAbort.abort();
    if (msg.force) {
      forceAborted = true;
    }
  } else if (msg.type === 'event.emit.response') {
    const pending = pendingEmitResponses.get(msg.requestId);
    if (pending) {
      pending.resolve(msg);
    }
  } else if (msg.type === 'concurrency.ack') {
    if (pendingConcurrencyAck) {
      pendingConcurrencyAck.resolve(msg);
    }
  } else if (msg.type === 'agent.api.response') {
    const pending = pendingApiResponses.get(msg.requestId);
    if (pending) {
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.result);
      }
    }
  } else if (msg.type === 'cache.response') {
    const pending = pendingCacheResponses.get(msg.requestId);
    if (pending) {
      pending.resolve(msg);
    }
  } else if (msg.type === 'provenance.response') {
    const pending = pendingProvenanceResponses.get(msg.requestId);
    if (pending) {
      pending.resolve(msg);
    }
  } else if (msg.type === 'artifacts.response') {
    const pending = pendingArtifactResponses.get(msg.requestId);
    if (pending) {
      pending.resolve(msg);
    }
  } else if (msg.type === 'approval.resolved') {
    const pending = pendingApprovalResolutions.get(msg.requestId);
    if (pending) {
      pending.resolve(msg);
    }
  }
}

if (isForkMode) {
  // In fork mode, listen for abort, event.emit.response, concurrency.ack,
  // and agent.api.response messages on the IPC channel.
  process.on('message', (msg: AgentToRunnerMessage) => {
    dispatchAgentMessage(msg);
  });
} else {
  // In stdio (container) mode, listen for the same messages on stdin JSON-lines.
  // The readline is shared with receiveRequest() — after the execute message is
  // consumed, subsequent lines are response/control messages from the agent.
  const rl = getStdinRl();
  rl.on('line', (line: string) => {
    try {
      const msg = JSON.parse(line) as AgentToRunnerMessage;
      // Skip 'execute' messages (already handled by receiveRequest).
      if (msg.type !== 'execute') {
        dispatchAgentMessage(msg);
      }
    } catch {
      // Non-JSON line on stdin — ignore (could be Docker noise).
    }
  });
}

// SIGTERM handling (used by container backend to stop execution).
process.on('SIGTERM', () => {
  aborted = true;
  jobCancelAbort.abort();
});

// --- IPC Logger ---

/**
 * Create a Logger that sends log lines via IPC.
 *
 * Each log call formats the line and sends it as a log.line IPC message.
 * Format matches the existing createStepLogger: [stepName] [level?] message args...
 */
function createIpcLogger(
  stepIndex: number,
  stepName: string,
  sendFn: (msg: RunnerToAgentMessage) => void,
): Logger {
  const formatLine = (level: string, message: string, args: unknown[]): string => {
    const formatted = args.length > 0 ? `${message} ${args.join(' ')}` : message;
    return `[${stepName}] ${level !== 'info' ? `[${level}] ` : ''}${formatted}`;
  };

  return {
    info: (message: string, ...args: unknown[]) => {
      sendFn({ type: 'log.line', stepIndex, line: formatLine('info', message, args) });
    },
    warn: (message: string, ...args: unknown[]) => {
      sendFn({ type: 'log.line', stepIndex, line: formatLine('warn', message, args) });
    },
    error: (message: string, ...args: unknown[]) => {
      sendFn({ type: 'log.line', stepIndex, line: formatLine('error', message, args) });
    },
    debug: (message: string, ...args: unknown[]) => {
      if (process.env.KICI_LOG_LEVEL === 'debug') {
        sendFn({ type: 'log.line', stepIndex, line: formatLine('debug', message, args) });
      }
    },
  };
}

// --- StepContext Reconstruction ---

/** A lock needs entry maps to a base name (single/matrix/host) or a group name. */
function needBaseName(need: unknown): { kind: 'job' | 'group'; key: string } | null {
  if (typeof need === 'string') return { kind: 'job', key: need };
  if (need && typeof need === 'object') {
    if ('group' in need) return { kind: 'group', key: (need as { group: string }).group };
    if ('name' in need) return { kind: 'job', key: (need as { name: string }).name };
  }
  return null;
}

/**
 * Build `ctx.needs` for a job's steps from the dispatch envelope. Reconstructs
 * an {@link UpstreamSnapshot} from `upstreamJobOutputs` (flat per single job;
 * `byMatrix` / `byHost` envelopes per fan-out) + `upstreamJobStatuses` (keyed by
 * each upstream job/child name), then resolves the job's declared needs into the
 * `{ result, status }` / ordered-array shape via the shared SDK builder. Returns
 * undefined when the job declares no needs.
 */
export function buildStepNeedsContext(
  declaredNeeds: readonly unknown[] | undefined,
  upstreamJobOutputs: Record<string, Record<string, unknown>> | undefined,
  upstreamJobStatuses: Record<string, ExecutionJobStatus> | undefined,
): NeedsContext | undefined {
  if (!declaredNeeds || declaredNeeds.length === 0) return undefined;

  const statuses = upstreamJobStatuses ?? {};
  const jobs: Record<string, Record<string, unknown>> = {};
  const groups: Record<string, string[]> = {};
  const snapStatuses: Record<string, ExecutionJobStatus> = {};
  const resolvedNeeds: DynamicJobNeed[] = [];

  for (const need of declaredNeeds) {
    const base = needBaseName(need);
    if (!base) continue;

    // Child names that fanned out from this base (matrix / host children share
    // the `${base} (...)` naming) come from the statuses map keyed per-child.
    const childNames = Object.keys(statuses).filter((n) => n.startsWith(`${base.key} (`));

    if (base.kind === 'group' || childNames.length > 0) {
      // Group or fanned-out upstream: an ordered array of children.
      groups[base.key] = [...childNames].sort();
      const envelope = upstreamJobOutputs?.[base.key];
      const bySuffix = envelopeChildOutputs(envelope);
      for (const child of childNames) {
        // The fan-out child name is `${base} (<suffix>)`; the envelope keys
        // outputs by `<suffix>`.
        const suffix = child.slice(base.key.length + 2, -1);
        jobs[child] = bySuffix[suffix] ?? {};
        snapStatuses[child] = statuses[child];
      }
      resolvedNeeds.push({ group: base.key } as DynamicJobNeed);
    } else {
      // Single non-fanned upstream.
      jobs[base.key] = upstreamJobOutputs?.[base.key] ?? {};
      if (statuses[base.key]) snapStatuses[base.key] = statuses[base.key];
      resolvedNeeds.push(base.key);
    }
  }

  const snapshot: UpstreamSnapshot = { jobs, groups, statuses: snapStatuses };
  return buildNeedsContext(snapshot, resolvedNeeds);
}

/**
 * Extract per-child output records from a fan-out outputs envelope, keyed by the
 * combination suffix (matrix `byMatrix`) or hostname (`runsOnAll` `byHost`).
 * Returns an empty map for a non-envelope value.
 */
function envelopeChildOutputs(
  envelope: Record<string, unknown> | undefined,
): Record<string, Record<string, unknown>> {
  if (!envelope) return {};
  const byMatrix = (envelope as { byMatrix?: Record<string, Record<string, unknown>> }).byMatrix;
  const byHost = (envelope as { byHost?: Record<string, Record<string, unknown>> }).byHost;
  return byMatrix ?? byHost ?? {};
}

/**
 * Build StepSecrets from the job execution request, wired with the per-step
 * file-mount host (used by `ctx.secrets.mountFile` / `exposeFile`).
 *
 * Returns a `{ secrets, dispose }` handle: `secrets` is bound into the step
 * context, and `dispose` is invoked by the step-loop's `finally` to remove
 * the per-step tmpdir and clear any env vars set via `exposeFile`.
 *
 * The mounted-file content is registered with the active `LogMasker` so any
 * subprocess that echoes the credential gets `***`-replaced in the streamed
 * log -- same masker the rest of the runner uses, so masking is global, not
 * per-step.
 */
function buildStepSecrets(
  request: JobExecutionRequest,
  masker: LogMasker,
  onMaskerSecretsAdded: () => void,
): StepSecretsHandle {
  const orchestratorSecrets = request.secrets ?? {};
  const namespaced = request.namespacedSecrets ?? {};

  // Build flat secrets: orchestrator-level + auto-flattened from all contexts (last wins)
  const mergedFlat = buildMergedFlatSecrets(orchestratorSecrets, namespaced);

  let stepTmpHandle: TempHandle | null = null;
  const exposedEnvVars = new Set<string>();
  let mountCounter = 0;
  const env = process.env as Record<string, string | undefined>;

  async function ensureTmpdir(): Promise<string> {
    if (stepTmpHandle === null) {
      stepTmpHandle = await makeTempDir('secret-files');
    }
    return stepTmpHandle.path;
  }

  const host: StepSecretsFileHost = {
    async writeMountedFile(args) {
      const dir = await ensureTmpdir();
      mountCounter += 1;
      const filename = args.name ?? `secret-${mountCounter}`;
      const filePath = join(dir, filename);
      await fsPromises.writeFile(filePath, args.content);
      await fsPromises.chmod(filePath, args.mode);
      // Register the materialised content with the global LogMasker so any
      // subprocess that echoes it gets `***`-masked. The mount sources are
      // already in the masker (via createSecretMasker at boot), but a
      // concatenation of two secrets is a brand-new value -- e.g. two age
      // keys joined by '\n' produce a string neither secret matches alone.
      masker.registerSecrets({ [`__mount_${mountCounter}__`]: args.content });
      onMaskerSecretsAdded();
      return filePath;
    },
    trackExposedEnv(envVar: string) {
      exposedEnvVars.add(envVar);
    },
  };

  return createStepSecrets(mergedFlat, env, request.secretMeta, {
    host,
    cleanup: async () => {
      for (const envVar of exposedEnvVars) {
        delete env[envVar];
        delete process.env[envVar];
      }
      exposedEnvVars.clear();
      if (stepTmpHandle !== null) {
        await stepTmpHandle.cleanup();
        stepTmpHandle = null;
      }
    },
    onDisposeError: (err) => {
      // Cleanup failures must not propagate -- they're logged via the
      // existing stderr trace channel so an operator inspecting the
      // sandbox log can see them.
      const message = err instanceof Error ? err.message : String(err);
      origStderrWrite(`[workflow-runner] secret-file cleanup error: ${message}\n`);
    },
  });
}

/**
 * Create a LogMasker initialized with all secret values from the request.
 *
 * Collects values from both flat secrets and all namespaced context secrets,
 * deduplicating before registration.
 */
function createSecretMasker(request: JobExecutionRequest): LogMasker {
  const masker = new LogMasker();
  const allSecrets: Record<string, string> = {};

  // Collect flat secrets
  if (request.secrets) {
    Object.assign(allSecrets, request.secrets);
  }

  // Collect all namespaced secret values
  if (request.namespacedSecrets) {
    for (const contextSecrets of Object.values(request.namespacedSecrets)) {
      Object.assign(allSecrets, contextSecrets);
    }
  }

  masker.registerSecrets(allSecrets);
  return masker;
}

/**
 * Build a fresh zx `$` shell bound to the sandbox working directory and the
 * sanitized environment (process.env was set by the parent via env-sanitizer
 * before spawning this process). This is the single shell-construction code
 * path shared by step execution (`createSandboxStepContext`) and the per-job
 * init phase (`runInitPhase`), so init commands run through the identical shell
 * steps use — same cwd, same live sanitized env, same masked log streaming.
 *
 * The shell binds `process.env` by reference (not a copy), so a same-step
 * ctx.setEnv / ctx.addPath mutation — which applyEnvDelta writes to live
 * process.env — is visible to that step's own subprocesses, matching the
 * "visible to this step" SDK contract.
 *
 * Intercept zx subprocess output via the log callback: zx does NOT write child
 * stdout/stderr to process.stdout — it pipes to an internal VoidStream and only
 * calls $.log() with { kind: 'stdout'|'stderr', verbose }. We override the log
 * function (`makeStreamingZxLog`) to capture both kinds and send them as masked
 * IPC log.line messages tagged with `stepIndex`.
 *
 * The shell is built with `verbose: true` so ordinary subprocess output is
 * flagged `verbose: true` (captured) while a step that opts into
 * `$({ quiet: true })` — e.g. a `sops -d` credential decrypt — is flagged
 * `verbose: false` and dropped by `makeStreamingZxLog`. That gate is what keeps
 * a decrypted secret out of the streamed run log; a `verbose: false` base would
 * flag ordinary output `verbose: false` too and drop every line.
 *
 * IMPORTANT: The log function must be passed in the zx$() config, not set on the
 * returned function. zx$() returns a plain function (not the proxy $), so setting
 * step$.log would only set it on the function object and NOT propagate to the
 * AsyncLocalStorage store that zx uses for ProcessPromise snapshots.
 */
export function buildSandboxShell(
  cwd: string,
  stepIndex: number,
  maskedSendFn: (msg: RunnerToAgentMessage) => void,
): typeof $ {
  return zx$({
    cwd,
    env: process.env as Record<string, string>,
    verbose: true,
    quiet: false,
    log: makeStreamingZxLog((line, stream) =>
      maskedSendFn({ type: 'log.line', stepIndex, line, stream }),
    ) as any,
  }) as unknown as typeof $;
}

/**
 * Resolve the on-the-wire event name for `ctx.emit`. Accepts either an ad-hoc
 * event-name string or a `defineEvent()` definition object (passed by the typed
 * emit overload); a definition resolves to its `.name`, a string passes through.
 */
export function resolveEmitEventName(nameOrDefinition: string | EventDefinition): string {
  return isEventDefinition(nameOrDefinition) ? nameOrDefinition.name : nameOrDefinition;
}

/**
 * Sanitize a raw identifier into a valid temp label: lowercase, every
 * non-`[a-z0-9-]` char to `-`, falling back to `'step'` when the result is
 * empty. Applied to both the caller-supplied `ctx.mktemp(label)` and the
 * default step-id label so a friendly-but-irregular label never rejects at the
 * scope. Mirrors the SDK test builder's `sanitizeTempLabel`.
 */
export function sanitizeTempLabel(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return cleaned.length > 0 ? cleaned : 'step';
}

/**
 * Drain the job-scoped temp allocator once at job end.
 *
 * Called after the step loop and cancel-path hooks, immediately before the
 * terminal `job.complete` emit, so a single call reclaims every `ctx.mktemp` /
 * `ctx.mktempFile` allocation on success, failure, and cancel/timeout alike. A
 * cleanup failure must NEVER change the job's terminal status, so any error is
 * swallowed into `warn` rather than thrown out of `main()`.
 */
export async function drainJobTempScope(
  scope: TempScope,
  warn: (message: string) => void,
): Promise<void> {
  try {
    await scope.disposeAll();
  } catch (err) {
    warn(`job temp scope cleanup failed: ${toErrorMessage(err)}`);
  }
}

/**
 * Job-end wrapper around {@link drainJobTempScope} that routes a cleanup
 * warning to the run log as a job-level (`stepIndex: -1`) line. Kept out of
 * `main()` so the single drain call site stays one line.
 */
async function drainJobTempScopeToLog(
  scope: TempScope,
  send: (msg: RunnerToAgentMessage) => void,
): Promise<void> {
  await drainJobTempScope(scope, (message) =>
    send({ type: 'log.line', stepIndex: -1, line: `[kici] ${message}` }),
  );
}

/**
 * Map the step loop's terminal status onto the initial job-level status —
 * `success` iff every step succeeded, else `failed`. `main()` may override this
 * afterward for the cancel/timeout paths.
 */
function initialJobStatus(loopStatus: string): 'success' | 'failed' {
  return loopStatus === ExecutionStepStatus.enum.success
    ? ExecutionJobStatus.enum.success
    : ExecutionJobStatus.enum.failed;
}

/**
 * Create a StepContext natively inside the workflow runner.
 *
 * The context is reconstructed from the environment and IPC request fields --
 * NOT serialized across the process boundary. This means zx $ runs natively
 * inside this process with full shell access.
 */
export function createSandboxStepContext(
  workDir: string,
  stepIndex: number,
  stepName: string,
  request: JobExecutionRequest,
  maskedSendFn: (msg: RunnerToAgentMessage) => void,
  outputsMap: OutputsMap,
  refMap: StepRefMap,
  operatorSecretKeys: Set<string>,
  secretOutputs: Map<string, string>,
  jobOutputsMap: OutputsMap,
  secrets: TrackedStepSecrets,
  masker: LogMasker,
  signal: AbortSignal,
  jobTempScope: TempScope,
): StepContext {
  const step$ = buildSandboxShell(workDir, stepIndex, maskedSendFn);

  const log = createIpcLogger(stepIndex, stepName, maskedSendFn);

  const rawPayload = rawPayloadFromEvent(request.event);

  const kici = buildKiciApi(
    async (method, params) => {
      const reqId = randomUUID();
      sendMessage({
        type: 'agent.api.request',
        requestId: reqId,
        method,
        params: params ?? {},
      });
      const result = await waitForApiResponse(reqId);
      // Mask the relayed OIDC ID token so the short-lived credential can
      // never land in step logs during its validity window.
      if (
        method === OIDC_TOKEN_REQUEST_METHOD &&
        result &&
        typeof (result as { token?: unknown }).token === 'string'
      ) {
        masker.registerSecrets({ __oidc_token__: (result as { token: string }).token });
      }
      return result;
    },
    { jobId: request.jobId },
  );

  return {
    $: step$,
    log,
    signal,
    env: process.env as Record<string, string | undefined>,
    setEnv: (key: string, value: string) => {
      applyEnvDelta(
        { env: { [key]: value }, pathPrepends: [] },
        {
          operatorSecretKeys,
          onReject: (k) =>
            log.warn(`Cannot override operator secret "${k}" via setEnv — value preserved`),
        },
      );
    },
    addPath: (dir: string) => {
      applyEnvDelta({ env: {}, pathPrepends: [dir] }, { operatorSecretKeys });
    },
    inputs: {},
    secrets,
    workflow: { name: request.workflowName },
    job: { name: request.jobName, runsOn: request.runsOn },
    isTestRun: request.isTestRun ?? false,
    context: request.context,
    // User-facing cache bound to the job's work dir. Each restore/save drives
    // the orchestrator over a cache.request IPC -> agent WS -> cache.user.*
    // relay (see buildCacheTransport), mirroring how ctx.emit / ctx.kici relay.
    cache: createCacheApi(workDir, buildCacheTransport()),
    // User-facing artifacts bound to the job's work dir. upload/download drive
    // the orchestrator over an artifacts.request IPC -> agent WS ->
    // artifacts.upload.*/download.* relay (see buildArtifactTransport).
    artifacts: createArtifactsApi(workDir, buildArtifactTransport()),
    emit: async (
      nameOrDefinition: string | EventDefinition,
      payload?: Record<string, unknown>,
      options?: { target?: { repos?: string[] } },
    ) => {
      // Accept either an ad-hoc event name or a defineEvent() definition; the
      // typed overload passes the definition object, so resolve its name here.
      const eventName = resolveEmitEventName(nameOrDefinition);
      const reqId = randomUUID();
      const request: EventEmitRequest = {
        type: 'event.emit',
        requestId: reqId,
        eventName,
        payload: payload ?? {},
        ...(options?.target && { target: options.target }),
      };
      // Send via IPC (same mechanism as other runner-to-agent messages)
      sendMessage(request);
      // Wait for response with timeout
      const response = await waitForEmitResponse(reqId);
      if (response.error) {
        throw new Error(`Event emission failed: ${response.error}`);
      }
      return { deliveryId: response.deliveryId! };
    },
    outputsOf: <T>(ref: { _tag: 'Step'; name: string } | ((...args: any[]) => any)): T => {
      return resolveStepOutputs<T>(ref as any, outputsMap, refMap);
    },
    jobOutputs: (ref: { name: string }): Record<string, unknown> => {
      return resolveJobOutputs(ref, jobOutputsMap);
    },
    setSecretOutput: (key: string, value: string): void => {
      secretOutputs.set(key, value);
    },
    // Job-scoped scratch: allocations delegate to the single `jobTempScope`
    // created in `main()`, so every dir/file a step makes is reclaimed by the
    // one `drainJobTempScope` at job end (success/failure/cancel). An omitted
    // label defaults to the sanitized step id.
    mktemp: (label?: string) => jobTempScope.mktemp(sanitizeTempLabel(label ?? stepName)),
    mktempFile: (label?: string, opts?: { suffix?: string }) =>
      jobTempScope.mktempFile(sanitizeTempLabel(label ?? stepName), opts),
    kici,
    // Build, sign, and persist a provenance attestation. The identity token is
    // relayed via ctx.kici.oidc.token (P1.4); the bundle is uploaded over the
    // provenance.request IPC -> agent WS -> orchestrator presigned PUT.
    attestProvenance: buildAttestProvenanceFn(request, workDir, (o) => kici.oidc.token(o)),
    ...(rawPayload && { rawPayload }),
    ...(request.provider && { provider: request.provider }),
    // Matrix combination for this child (orchestrator-materialized at dispatch
    // time); absent for non-matrix jobs. Combination values are always strings
    // (produced by the matrix expander), so the cast to MatrixValues is sound.
    ...(request.matrixValues && {
      matrix: request.matrixValues as Record<string, string | undefined>,
    }),
    // Host fan-out identity for a runsOnAll child (orchestrator-materialized at
    // dispatch time); absent for non-host jobs.
    ...(request.host && { host: request.host }),
    ...(request.agent && { agent: request.agent }),
    // Fan-out position (runsOnAll host or matrix combination); absent otherwise.
    ...(() => {
      const fanout = deriveFanout(request);
      return fanout ? { fanout } : {};
    })(),
    // Operator-supplied, validated + coerced + defaulted workflow-dispatch
    // inputs (orchestrator-resolved from the lock descriptor). Always present —
    // empty object when none declared — so `inputs.from(ctx)` never sees undefined.
    dispatchInputs: (request.dispatchInputs ?? {}) as Readonly<
      Record<string, string | number | boolean | null>
    >,
    // Upstream needs (result + terminal status) for step-level branching.
    ...(() => {
      const needs = buildStepNeedsContext(
        request.jobNeeds,
        request.upstreamJobOutputs,
        request.upstreamJobStatuses,
      );
      return needs ? { needs } : {};
    })(),
  };
}

// --- Helper ---

/**
 * Derive the fan-out position (`ctx.fanout`) from a dispatch request. Returns
 * `undefined` for a non-fan-out job (no `fanoutTotal`), so `ctx.fanout` is only
 * set for `runsOnAll` host children and matrix combinations.
 */
export function deriveFanout(request: JobExecutionRequest): FanoutPosition | undefined {
  if (request.fanoutTotal === undefined) return undefined;
  const index = request.fanoutIndex ?? 0;
  return {
    index,
    total: request.fanoutTotal,
    first: index === 0,
    last: index === request.fanoutTotal - 1,
  };
}

/** Raw provider webhook body for ctx.rawPayload — nested in the envelope. */
export function rawPayloadFromEvent(
  event: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!event) return undefined;
  const payload = (event as { payload?: Record<string, unknown> }).payload;
  return payload ?? undefined;
}

/**
 * Check if a file exists at the given path.
 */
function fileExists(p: string): boolean {
  return existsSync(p);
}

// --- Debug trace helper ---
function trace(msg: string): void {
  origStderrWrite(`[workflow-runner:trace] ${msg}\n`);
}

// --- Phase Helpers (private, share module-level state via closures) ---

/**
 * Send a job.complete + process.exit. Centralises the abort-mid-prepare path
 * (after clone / after deps / after rules) so the messages and exit code
 * stay consistent.
 */
function abortAndExit(reason: string): never {
  trace(reason);
  flushOutputCapture();
  capturePrepareActive = false;
  sendMessage({
    type: 'job.complete',
    status: ExecutionJobStatus.enum.failed,
    stepResults: [],
    // When the abort was triggered by the job-level deadline (during a prepare
    // phase, before the step loop), surface the distinct job_timeout reason.
    ...(jobTimedOut && {
      error: `${TimeoutReason.enum.job_timeout}: job exceeded its timeout of ${jobTimedOutMs ?? 0}ms`,
    }),
  });
  process.exit(1);
}

/**
 * Phase 1 — Clone the source / workflow repos (or skip when checkout=false).
 * Three modes: full-repo overlay-only (no clone), global dual-clone
 * (workflow + source), or single-repo clone. Each mode emits the same
 * progress IPC log lines as before.
 */
async function cloneRepoIfRequested(
  request: JobExecutionRequest,
  workDir: string,
  workflowDir: string,
  sourceDir: string,
  isGlobal: boolean,
): Promise<void> {
  if (request.checkout === false) return;

  if (request.fullRepo) {
    trace('fullRepo mode -- skipping git clone, workspace from overlay');
    await fsPromises.mkdir(workDir, { recursive: true });
    sendMessage({
      type: 'log.line',
      stepIndex: -1,
      line: '[workflow-runner] Full-repo mode: skipping git clone (workspace from overlay tarball)',
    });
    return;
  }

  if (isGlobal) {
    trace(`starting dual-clone (global workflow)`);
    await fsPromises.mkdir(workflowDir, { recursive: true });
    await fsPromises.mkdir(sourceDir, { recursive: true });

    const workflowAuth = request.workflowAuth ?? request.sourceAuth;
    const sourceAuth = request.sourceAuth ?? request.workflowAuth;

    sendMessage({
      type: 'log.line',
      stepIndex: -1,
      line: `[workflow-runner] Global workflow: cloning workflow repo ${request.workflowRepoUrl} ref=${request.workflowRef} into ${workflowDir}`,
    });
    await gitClone({
      repoUrl: request.workflowRepoUrl!,
      ref: request.workflowRef ?? '',
      sha: request.workflowSha ?? '',
      workDir: workflowDir,
      gitAuth: workflowAuth,
      token: workflowAuth ? undefined : request.token,
    });
    trace('workflow repo clone complete');
    // Hide dep-restore scratch dirs from `git status` in the workflow repo's
    // working tree. `.kici/` (and therefore the scratch dirs) lives in the
    // workflow repo for global workflows, not the source repo — so only this
    // clone gets the exclude rule. See dep-restore.ts#excludeScratchFromGit.
    await excludeScratchFromGit(workflowDir);

    sendMessage({
      type: 'log.line',
      stepIndex: -1,
      line: `[workflow-runner] Global workflow: cloning source repo ${request.repoUrl} ref=${request.ref} into ${sourceDir}`,
    });
    await gitClone({
      repoUrl: request.repoUrl,
      ref: request.ref,
      sha: request.sha,
      workDir: sourceDir,
      gitAuth: sourceAuth,
      token: sourceAuth ? undefined : request.token,
    });
    trace('source repo clone complete');
    sendMessage({ type: 'log.line', stepIndex: -1, line: '[workflow-runner] Dual-clone complete' });
    return;
  }

  trace('starting git clone');
  sendMessage({
    type: 'log.line',
    stepIndex: -1,
    line: `[workflow-runner] Cloning ${request.repoUrl} ref=${request.ref} into ${workDir}`,
  });
  await gitClone({
    repoUrl: request.repoUrl,
    ref: request.ref,
    sha: request.sha,
    workDir,
    gitAuth: request.sourceAuth,
    token: request.sourceAuth ? undefined : request.token,
  });
  // Hide dep-restore scratch dirs from `git status` in the cloned working
  // tree. See dep-restore.ts#excludeScratchFromGit for why this lives here
  // (post-clone) rather than in dep-restore itself.
  await excludeScratchFromGit(workDir);
  sendMessage({ type: 'log.line', stepIndex: -1, line: '[workflow-runner] Clone complete' });
  trace('git clone complete');
}

/**
 * Phase 1b — Apply the encrypted overlay tarball when present (test runs
 * with uncommitted changes). For global workflows the overlay applies to the
 * workflow repo (the one carrying `.kici/`).
 */
async function applyOverlayIfRequested(
  request: JobExecutionRequest,
  workflowDir: string,
): Promise<void> {
  if (!request.tarballUrl || !request.cliPublicKey || !request.orchestratorPrivateKey) return;
  trace('applying overlay tarball');
  sendMessage({
    type: 'log.line',
    stepIndex: -1,
    line: '[workflow-runner] Applying overlay (uncommitted changes)',
  });
  const overlayResult = await applyOverlay({
    tarballUrl: request.tarballUrl,
    cliPublicKey: request.cliPublicKey,
    orchestratorPrivateKey: request.orchestratorPrivateKey,
    repoDir: workflowDir,
  });
  sendMessage({
    type: 'log.line',
    stepIndex: -1,
    line: `[workflow-runner] Overlay applied: ${overlayResult.filesApplied} files changed, ${overlayResult.filesDeleted} files deleted`,
  });
  trace(
    `overlay applied: ${overlayResult.filesApplied} files, ${overlayResult.filesDeleted} deletions`,
  );
}

/**
 * Phase 1c — Make git usable in a full-repo overlay workspace.
 *
 * `kici run remote` uploads the developer's working tree (including `.git`) as
 * a self-contained overlay; no clone happens, so the extracted `.git` directory
 * is owned by whatever UID wrote the tarball. Under rootless podman that UID may
 * not match the container UID, which trips git's "dubious ownership" /
 * `safe.directory` check and makes every step `git` command fail.
 *
 * Mirroring the `file://`-clone fix in checkout/git-clone.ts, we point
 * `GIT_CONFIG_GLOBAL` at a temp config carrying `safe.directory = *`. Setting it
 * on `process.env` here (before the step loop) means every step subprocess —
 * each zx `$` reads live `process.env` at spawn — inherits it, so git
 * works in steps exactly as it does locally. We also register the dep-restore
 * scratch-dir exclude now that a real `.git` exists in the workspace.
 */
async function makeOverlayGitUsable(
  request: JobExecutionRequest,
  workspaceDir: string,
): Promise<void> {
  if (!request.fullRepo) return;
  if (!existsSync(join(workspaceDir, '.git'))) return;

  const { path: cfgDir } = await makeTempDir('gitcfg');
  const cfgPath = join(cfgDir, 'config');
  await fsPromises.writeFile(cfgPath, '[safe]\n\tdirectory = *\n', { mode: 0o600 });
  process.env.GIT_CONFIG_GLOBAL = cfgPath;
  trace(`fullRepo git safe.directory configured via GIT_CONFIG_GLOBAL=${cfgPath}`);

  // The overlay carries a real `.git`, so hide the dep-restore scratch dirs
  // from the customer's `git status` the same way the clone paths do.
  await excludeScratchFromGit(workspaceDir);
}

/**
 * Phase 2 — Restore deps from cache (with hash-mismatch hard-fail) OR fall
 * back to inline install. Skipped when `.kici/package.json` doesn't exist.
 * For global workflows deps come from the workflow repo (where `.kici/` lives).
 */
async function installDependenciesIfNeeded(
  workflowDir: string,
  request: JobExecutionRequest,
): Promise<void> {
  const kiciDir = join(workflowDir, '.kici');
  const hasPackageJson = fileExists(join(kiciDir, 'package.json'));
  trace(
    `deps: kiciDir=${kiciDir}, hasPackageJson=${hasPackageJson}, depsUrl=${request.depsUrl ?? 'none'}`,
  );
  if (!hasPackageJson) return;

  if (request.depsUrl) {
    trace('restoring deps from cache');
    sendMessage({
      type: 'log.line',
      stepIndex: -1,
      line: `[workflow-runner] Restoring deps from ${request.depsUrl}`,
    });
    try {
      await restoreDeps(workflowDir, request.depsUrl, request.depsHash);
      sendMessage({
        type: 'log.line',
        stepIndex: -1,
        line: '[workflow-runner] Deps restored from cache',
      });
      trace('deps restored from cache');
    } catch (err) {
      // Hash mismatch is not recoverable per user decision
      if (err instanceof Error && err.message.includes('hash mismatch')) throw err;
      trace(`cache restore failed: ${toErrorMessage(err)}, falling back`);
      sendMessage({
        type: 'log.line',
        stepIndex: -1,
        line: `[workflow-runner] Cache restore failed (${toErrorMessage(err)}), falling back to inline install`,
      });
      await installDeps(kiciDir, {
        npmRegistries: request.npmRegistries,
        installEnvSecrets: request.installEnvSecrets,
        jobIdShort: request.jobIdShort,
      });
      trace('fallback install complete');
    }
    return;
  }

  if (fileExists(join(kiciDir, 'node_modules'))) {
    trace('node_modules already exists, skipping install');
    sendMessage({
      type: 'log.line',
      stepIndex: -1,
      line: '[workflow-runner] Deps already present (node_modules exists), skipping install',
    });
    return;
  }

  trace('installing deps inline (no cache)');
  sendMessage({
    type: 'log.line',
    stepIndex: -1,
    line: '[workflow-runner] Installing deps inline (no cache)',
  });
  try {
    await installDeps(kiciDir, {
      npmRegistries: request.npmRegistries,
      installEnvSecrets: request.installEnvSecrets,
      jobIdShort: request.jobIdShort,
    });
    trace('installDeps() returned successfully');
  } catch (depErr) {
    const depMsg = toErrorMessage(depErr);
    const depStack = depErr instanceof Error ? depErr.stack : undefined;
    trace(`installDeps THREW: ${depMsg}`);
    if (depStack) trace(`installDeps stack: ${depStack}`);
    throw depErr;
  }
  sendMessage({ type: 'log.line', stepIndex: -1, line: '[workflow-runner] Deps installed' });
  trace('deps installed IPC sent');
}

/**
 * Phase 2b — Restore the cached `.kici/` source tarball over the cloned
 * workflow root so the loaded workflow's contentHash matches the lock file
 * exactly. No-op when no `sourceTarUrl` was provided.
 */
async function restoreSourceTarballIfRequested(
  workflowRoot: string,
  request: JobExecutionRequest,
): Promise<void> {
  if (!request.sourceTarUrl) return;
  trace(`restoring .kici/ source from tarball url=${request.sourceTarUrl}`);
  sendMessage({
    type: 'log.line',
    stepIndex: -1,
    line: '[workflow-runner] Restoring .kici/ source from cached tarball',
  });
  await restoreSource(workflowRoot, request.sourceTarUrl);
  trace('source tarball restored');
}

/**
 * Phase 3 — Install the stdout/stderr capture, then load the workflow module
 * via the oxc-transform ESM loader. Capture is enabled for the prepare phase
 * (module load → concurrency → rules) so user `console.log` lands in the
 * workflow-level log bucket (stepIndex: -1). On load failure we flush + clear
 * the prepare flag before rethrowing so the catch handler in main() doesn't
 * see stale buffer state.
 */
async function loadWorkflowModuleWithCapture(
  workflowRoot: string,
  request: JobExecutionRequest,
  isGlobal: boolean,
  maskedSend: (msg: RunnerToAgentMessage) => void,
): Promise<Awaited<ReturnType<typeof loadWorkflowSource>>> {
  let sourceFile = request.sourceFile ?? '.kici/workflows/ci.ts';
  if (sourceFile && !sourceFile.startsWith('.kici/')) sourceFile = `.kici/${sourceFile}`;
  trace(
    `loading workflow module, sourceFile=${sourceFile}, workflowRoot=${workflowRoot}, cachedSource=${!!request.sourceTarUrl}`,
  );
  sendMessage({
    type: 'log.line',
    stepIndex: -1,
    line: `[workflow-runner] Loading workflow module${isGlobal ? ' (global=true, from workflow repo)' : ''}`,
  });

  captureSendFn = maskedSend;
  installOutputCapture();
  capturePrepareActive = true;

  try {
    const loaded = await loadWorkflowSource(
      workflowRoot,
      sourceFile,
      request.contentHash,
      request.resolvedHashFiles,
    );
    sendMessage({
      type: 'log.line',
      stepIndex: -1,
      line: '[workflow-runner] Workflow module loaded',
    });
    trace(`workflow module loaded, exports=${Object.keys(loaded.module).join(',')}`);
    return loaded;
  } catch (err) {
    flushOutputCapture();
    capturePrepareActive = false;
    throw err;
  }
}

type ConcurrencyAction = 'proceed' | 'wait' | 'cancel' | 'failed';

/**
 * Build the argument the user's `concurrency.group(...)` function receives.
 *
 * The only inputs an author can scope a group by. `branch` alone does not
 * separate one repository from another — an organization-wide workflow runs on
 * events from many repositories, and their default branches share a name — so
 * `event.sourceRepo` is what makes a per-source-repository group expressible.
 * That is why the orchestrator writes the whole normalized envelope into every
 * global job config: an empty `event` here silently collapses every repository
 * into one group, and with `cancelInProgress` (the default) one repository's
 * push then cancels another's in-flight run.
 *
 * Boundary cast: the wire `request.event` is untyped JSON that, per the unified
 * event protocol, always carries the normalized event envelope.
 */
export function buildConcurrencyGroupContext(request: JobExecutionRequest): {
  branch: string;
  event: EventPayload;
} {
  return {
    branch: request.branch ?? request.ref,
    event: (request.event ?? {}) as EventPayload,
  };
}

/**
 * Phase 4b — Evaluate the user-defined `concurrency.group(...)` function with
 * a timeout, report the resulting key to the orchestrator, and act on the
 * returned ack. `wait` and `cancel` paths exit the process directly (the run
 * is over from the runner's perspective). Returns 'proceed' to the caller in
 * the success path.
 *
 * Returns 'failed' instead of exiting when group evaluation throws, so
 * main() can keep its single exit-on-error point.
 */
async function evaluateConcurrencyGroupIfPresent(
  workflow: Workflow,
  request: JobExecutionRequest,
): Promise<ConcurrencyAction> {
  if (!workflow.concurrency?.group) return 'proceed';
  trace('evaluating concurrency group function');
  const concurrencyTimeoutMs = request.concurrencyEvaluationTimeoutMs ?? 30_000;
  const groupCtx = buildConcurrencyGroupContext(request);

  try {
    const ac = new AbortController();
    const concurrencyTimer = setTimeout(() => ac.abort(), concurrencyTimeoutMs);
    let groupKey: string;
    try {
      groupKey = await Promise.race([
        Promise.resolve(workflow.concurrency.group(groupCtx)),
        new Promise<never>((_, reject) => {
          ac.signal.addEventListener('abort', () =>
            reject(
              new Error(`Concurrency group evaluation timed out after ${concurrencyTimeoutMs}ms`),
            ),
          );
        }),
      ]);
    } finally {
      clearTimeout(concurrencyTimer);
    }
    trace(`concurrency group evaluated: ${groupKey}`);
    sendMessage({
      type: 'log.line',
      stepIndex: -1,
      line: `[kici] Concurrency group: ${groupKey}`,
    });

    sendMessage({ type: 'concurrency.report', group: groupKey });
    trace('waiting for concurrency ack');
    let ack = await waitForConcurrencyAck(concurrencyTimeoutMs);
    trace(`concurrency ack received: action=${ack.action}, reason=${ack.reason ?? 'none'}`);

    if (ack.action === 'proceed') {
      sendMessage({
        type: 'log.line',
        stepIndex: -1,
        line: '[kici] Concurrency: proceeding with execution',
      });
      return 'proceed';
    }
    if (ack.action === 'wait') {
      // Long-poll for a follow-up ack: when the slot frees, the orchestrator
      // sends an unsolicited `concurrency.ack { action: 'proceed' }` over the
      // SAME WS connection. The agent stays connected; we re-arm the
      // single-slot pending-ack waiter and block until the orchestrator
      // notifies us, the connection drops, or the configured cap elapses.
      sendMessage({
        type: 'log.line',
        stepIndex: -1,
        line: `[kici] Concurrency: queued${ack.reason ? ` (${ack.reason})` : ''}, waiting for slot to free`,
      });
      // Prefer the orchestrator-pushed cluster value (fleet-wide
      // cluster_settings.concurrency_wait_timeout_ms); fall back to the agent's
      // own env/config default when the dispatch omits it (older orchestrators).
      const waitCapMs =
        request.concurrencyWaitTimeoutMs ??
        (Number.parseInt(process.env.KICI_CONCURRENCY_WAIT_TIMEOUT_MS ?? '', 10) || 3_600_000);
      try {
        ack = await waitForConcurrencyAck(waitCapMs);
      } catch (waitErr) {
        const waitErrMsg = toErrorMessage(waitErr);
        sendMessage({
          type: 'log.line',
          stepIndex: -1,
          line: `[kici] [error] Concurrency wait timed out: ${waitErrMsg}`,
        });
        sendMessage({
          type: 'job.complete',
          status: ExecutionJobStatus.enum.failed,
          stepResults: [],
          error: `Concurrency wait timed out after ${waitCapMs}ms: ${waitErrMsg}`,
        });
        process.exit(1);
      }
      trace(`concurrency follow-up ack: action=${ack.action}, reason=${ack.reason ?? 'none'}`);
      if (ack.action === 'proceed') {
        sendMessage({
          type: 'log.line',
          stepIndex: -1,
          line: '[kici] Concurrency: slot acquired, proceeding with execution',
        });
        return 'proceed';
      }
      if (ack.action === 'wait') {
        // Defensive: a second `wait` is unexpected (the orchestrator only sends
        // unsolicited acks on slot release). Treat as failure rather than
        // looping forever — the agent is in an inconsistent state.
        sendMessage({
          type: 'log.line',
          stepIndex: -1,
          line: '[kici] [error] Concurrency: unexpected second `wait` ack; aborting',
        });
        sendMessage({
          type: 'job.complete',
          status: ExecutionJobStatus.enum.failed,
          stepResults: [],
          error: 'Concurrency: unexpected second wait ack',
        });
        process.exit(1);
      }
      // ack.action === 'cancel' — fall through to the cancel branch below.
    }
    // ack.action === 'cancel'
    sendMessage({
      type: 'log.line',
      stepIndex: -1,
      line: `[kici] Concurrency: cancelled${ack.reason ? ` (${ack.reason})` : ''}`,
    });
    sendMessage({
      type: 'job.complete',
      status: ExecutionJobStatus.enum.failed,
      stepResults: [],
      error: `Cancelled by concurrency policy${ack.reason ? ': ' + ack.reason : ''}`,
    });
    process.exit(1);
  } catch (err) {
    const errMsg = toErrorMessage(err);
    trace(`concurrency group evaluation failed: ${errMsg}`);
    sendMessage({
      type: 'log.line',
      stepIndex: -1,
      line: `[kici] [error] Concurrency group evaluation failed: ${errMsg}`,
    });
    sendMessage({
      type: 'job.complete',
      status: ExecutionJobStatus.enum.failed,
      stepResults: [],
      error: `Concurrency group evaluation failed: ${errMsg}`,
    });
    process.exit(1);
  }
}

/**
 * Phase 5 — Inject env vars and build the `RepoInfo` pair that the generator,
 * the job rules, and step contexts receive when the job is a global workflow.
 * No-op for normal jobs.
 *
 * Runs at the head of phase 5, before anything that may read the source tree:
 * the generator's re-evaluation (phase 5) and the job rules (phase 7) both take
 * the returned pair, and both must see what the pre-dispatch evaluation saw.
 *
 * `sourceRepo.path` is this sandbox's own absolute path — the same repo lives at
 * a different path in the evaluation that produced the job list. Read through
 * it; never compare it or embed it in a job name.
 */
export function setupGlobalWorkflowEnv(
  request: JobExecutionRequest,
  isGlobal: boolean,
  workflowDir: string,
  sourceDir: string,
): { workflowRepo: RepoInfo; sourceRepo: RepoInfo } | undefined {
  if (!isGlobal) return undefined;
  const repos = {
    workflowRepo: {
      identifier: request.workflowRepoIdentifier ?? '',
      path: workflowDir,
      ref: request.workflowRef,
      sha: request.workflowSha,
    },
    sourceRepo: {
      identifier: repoIdentifierFromUrl(request.repoUrl),
      path: sourceDir,
      ref: request.ref,
      sha: request.sha,
    },
  };
  // Injected through the shared writer so this sandbox evaluation and the
  // pre-dispatch global eval round hand the generator the same ambient env.
  // The restorer is deliberately discarded: this process runs exactly one job
  // and then exits, so the keys must stay set for the rest of the job. A
  // caller in a long-lived process (the eval round, in the agent) must call it.
  applyGlobalWorkflowEnv(repos);
  trace(
    `global workflow env vars injected: KICI_WORKFLOW_REPO_PATH=${workflowDir}, KICI_SOURCE_REPO_PATH=${sourceDir}`,
  );
  return repos;
}

/**
 * Phase 8 — Cancel-path hook execution. Runs the four cancel hooks
 * (step onCancel → step cleanup → job onCancel → job cleanup) inside-out,
 * accumulating any failure reasons into a compound `cancelFailureReason`.
 *
 * `forceAborted=true` short-circuits and runs none of the hooks; the caller
 * still flips finalStatus to failed (the fork-runner overrides it back to
 * `cancelled` based on its own state machine).
 */
async function runCancelPathHooks(args: {
  forceAborted: boolean;
  normalizedSteps: Step[];
  loopResult: { stepResults: SandboxStepResult[] };
  jobHooks: JobHooks;
  jobStartTime: number;
  outputsMap: OutputsMap;
  createStepCtxWithCapture: (stepIndex: number, stepName: string) => StepContext;
  /**
   * Tear down per-step state created by a `createStepCtxWithCapture`
   * invocation, keyed by the hook's pseudo-step index. Each cancel-path hook
   * allocates a fresh secrets handle via the factory; calling dispose() after
   * the hook returns ensures the tmpdir is removed and any env vars set via
   * `exposeFile` are unset before the next hook (or the process exit).
   */
  disposeStepResources: (stepIndex: number) => Promise<void>;
  maskedSend: (msg: RunnerToAgentMessage) => void;
}): Promise<{ finalStatus: 'success' | 'failed'; cancelFailureReason?: string }> {
  const {
    forceAborted,
    normalizedSteps,
    loopResult,
    jobHooks,
    jobStartTime,
    outputsMap,
    createStepCtxWithCapture,
    disposeStepResources,
    maskedSend,
  } = args;

  if (forceAborted) {
    maskedSend({
      type: 'log.line',
      stepIndex: -1,
      line: '[kici] Force cancel received, skipping all hooks',
    });
    // finalStatus = 'failed' — fork-runner will override to 'cancelled'
    return { finalStatus: ExecutionJobStatus.enum.failed };
  }

  maskedSend({
    type: 'log.line',
    stepIndex: -1,
    line: '[kici] Cancel received, running cancel hooks...',
  });

  const cancelOutcome = buildOutcomeMetadata({
    status: ExecutionJobStatus.enum.cancelled,
    reason: 'Job cancelled',
    stepOutputs: Object.fromEntries(outputsMap),
    startTime: jobStartTime,
  });

  let hookStepIndex = normalizedSteps.length + loopResult.stepResults.length;
  let cancelFailureReason: string | undefined;

  const concatReason = (existing: string | undefined, fragment: string): string =>
    existing ? `${existing}; ${fragment}` : fragment;

  const runHook = async (
    hook: HookInput,
    label: string,
    hookType: 'onCancel' | 'cleanup',
    failedStep?: string,
  ): Promise<void> => {
    maskedSend({
      type: 'log.line',
      stepIndex: -1,
      line: `[kici] Running ${label} hook...`,
    });
    const ctx = createStepCtxWithCapture(hookStepIndex, label);
    let hookResult;
    try {
      // Wrap the hook body in the capture scope so its console output attributes
      // to the hook's pseudo-step index rather than the workflow-level bucket.
      hookResult = await runInStepCapture(hookStepIndex, () =>
        executeHook({
          hook,
          stepContext: ctx,
          outcome: failedStep ? { ...cancelOutcome, failedStep } : cancelOutcome,
          hookType,
          stepIndex: hookStepIndex,
          sendIpc: maskedSend,
        }),
      );
    } finally {
      await disposeStepResources(hookStepIndex);
    }
    hookStepIndex++;
    if (!hookResult.success) {
      const fragment =
        label === 'onCancel'
          ? `cancelled (onCancel hook failed: ${hookResult.error})`
          : label.endsWith(':onCancel')
            ? `cancelled (step onCancel hook failed: ${hookResult.error})`
            : label.endsWith(':cleanup')
              ? `step cleanup hook failed: ${hookResult.error}`
              : label === 'cleanup'
                ? `cleanup hook failed: ${hookResult.error}`
                : `${label} hook failed: ${hookResult.error}`;
      cancelFailureReason = concatReason(cancelFailureReason, fragment);
      maskedSend({
        type: 'log.line',
        stepIndex: -1,
        line: `[kici] ${label} hook failed: ${hookResult.error}`,
      });
    } else {
      maskedSend({
        type: 'log.line',
        stepIndex: -1,
        line: `[kici] ${label} hook completed`,
      });
    }
  };

  const lastStepIndex = loopResult.stepResults.length - 1;
  const lastStep = lastStepIndex >= 0 ? normalizedSteps[lastStepIndex] : undefined;
  if (lastStep?.onCancel) {
    await runHook(lastStep.onCancel, `${lastStep.name}:onCancel`, 'onCancel', lastStep.name);
  }
  if (lastStep?.cleanup) {
    await runHook(lastStep.cleanup, `${lastStep.name}:cleanup`, 'cleanup', lastStep.name);
  }
  if (jobHooks.onCancel) {
    await runHook(jobHooks.onCancel, 'onCancel', 'onCancel');
  }
  if (jobHooks.cleanup) {
    await runHook(jobHooks.cleanup, 'cleanup', 'cleanup');
  }

  maskedSend({
    type: 'log.line',
    stepIndex: -1,
    line: `[kici] Cancel complete, job status: ${cancelFailureReason ? 'failed' : 'cancelled'}`,
  });

  return { finalStatus: ExecutionJobStatus.enum.failed, cancelFailureReason };
}

/**
 * Mutable state threaded through {@link coerceStep} for one job normalization
 * pass: the shared `step-N` counter, the bare-function → name ref map, and the
 * set of step objects this pass has already auto-named.
 */
export interface CoerceState {
  counter: number;
  refMap: StepRefMap;
  autoNamed: WeakSet<object>;
}

/**
 * Coerce one raw entry (bare function or Step) into a normalized Step, naming
 * anonymous steps `step-N` with a counter shared across the whole flattened
 * sequence (parallel children inline) — matching the compiler's transformSteps
 * enumeration so the flat-stepIndex invariant holds agent ↔ orchestrator.
 *
 * Unnamed steps are named by MUTATING the original object so the SDK's
 * late-bound `.result` proxy (which reads `step.name` at access time) resolves.
 * A step object reused twice in one pass gets a clone with a fresh name on the
 * repeat encounter — mirroring the compiler's per-occurrence naming so lock
 * parity holds; the original keeps its first binding.
 */
export function coerceStep(stepOrFn: StepInput, state: CoerceState): Step<any> {
  if (typeof stepOrFn === 'function') {
    state.counter++;
    const name = `step-${state.counter}`;
    state.refMap.set(stepOrFn, name);
    return { _tag: 'Step' as const, name, run: stepOrFn, outputs: undefined } as Step<any>;
  }
  const s = stepOrFn as Step<any>;
  if (!s.name) {
    state.counter++;
    (s as { name: string }).name = `step-${state.counter}`;
    state.autoNamed.add(s);
    return s;
  }
  if (state.autoNamed.has(s)) {
    state.counter++;
    return { ...s, name: `step-${state.counter}` } as Step<any>;
  }
  return s;
}

/**
 * Phase 5 — Extract steps for the requested job (re-evaluating the dynamic
 * factory when `dynamicSource` is set, otherwise looking up the static job)
 * and normalise the result into the `Step[]` shape the step loop consumes.
 * Bare-function steps get auto-generated `step-N` names so the IPC reporting
 * and the StepRefMap (used by `.result` proxies) line up.
 */
async function extractAndNormalizeSteps(
  workflow: Workflow,
  request: JobExecutionRequest,
  apiTransport: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  /**
   * The global-workflow repo pair, or undefined for a normal job. Forwarded to
   * the generator's re-evaluation so it sees the same world the pre-dispatch
   * evaluation did.
   */
  repos?: GeneratorRepoPair,
): Promise<{
  normalizedSteps: Step[];
  nodes: StepNode[];
  refMap: StepRefMap;
  driftDroppedJobs: string[];
}> {
  let rawSteps: readonly StepInput[];
  let driftDroppedJobs: string[] = [];
  if (request.dynamicSource) {
    const dynamicResult = await extractStepsFromDynamicJob(
      workflow,
      request.dynamicSource.index,
      request.jobName,
      request.dynamicSource.event,
      process.env as Record<string, string | undefined>,
      apiTransport,
      request.dynamicSource.expectedJobNames,
      request.dynamicSource.upstreamSnapshot,
      request.dynamicSource.declaredNeeds,
      repos,
    );
    rawSteps = dynamicResult.steps;
    driftDroppedJobs = dynamicResult.droppedJobs;
    if (driftDroppedJobs.length > 0) {
      trace(
        `Determinism drift: ${driftDroppedJobs.length} job(s) dropped: ${driftDroppedJobs.join(', ')}`,
      );
    }
  } else {
    rawSteps = extractSteps(workflow, request.jobName);
  }

  const coerceState: CoerceState = { counter: 0, refMap: new WeakMap(), autoNamed: new WeakSet() };
  const refMap = coerceState.refMap;
  const coerce = (stepOrFn: StepInput): Step<any> => coerceStep(stepOrFn, coerceState);

  const normalizedSteps: Step[] = [];
  const nodes: StepNode[] = [];
  let flatIndex = 0;
  let groupOrdinal = 0;
  for (const entry of rawSteps) {
    if (isParallelGroup(entry)) {
      const groupId = `g${groupOrdinal++}`;
      const children = entry.steps.map((child) => {
        const step = coerce(child);
        const stepIndex = flatIndex++;
        normalizedSteps.push(step);
        return { step, stepIndex };
      });
      nodes.push({
        kind: 'parallel',
        groupId,
        name: entry.name ?? groupId,
        failFast: entry.failFast,
        ...(entry.maxParallel !== undefined && { maxParallel: entry.maxParallel }),
        children,
      });
      continue;
    }
    const step = coerce(entry);
    const stepIndex = flatIndex++;
    normalizedSteps.push(step);
    nodes.push({ kind: 'sequential', step, stepIndex });
  }

  return { normalizedSteps, nodes, refMap, driftDroppedJobs };
}

/**
 * Phase 6 — Build the output infrastructure: the per-step operator-secret
 * key set (used for setEnv override protection), and the output / job-output
 * maps that back `.result` proxies and `ctx.outputsOf()` / `ctx.jobOutputs()`.
 * Sets the SDK module globals as a side effect — on BOTH the agent's bundled
 * SDK and the workflow module's own SDK instance (`workflowSdkSetters`), with
 * the same map objects. The workflow's within-job `.result` proxies read that
 * instance's module-global step-outputs map, so wiring only the agent's bundled
 * SDK would leave the proxies reading an always-empty map.
 */
function buildOutputInfrastructure(
  request: JobExecutionRequest,
  refMap: StepRefMap,
  workflowSdkSetters?: SdkOutputSetters,
): {
  operatorSecretKeys: Set<string>;
  outputsMap: OutputsMap;
  secretOutputs: Map<string, string>;
  jobOutputsMap: OutputsMap;
} {
  const operatorSecretKeys = new Set<string>();
  if (request.secrets) {
    for (const key of Object.keys(request.secrets)) operatorSecretKeys.add(key);
  }
  if (request.namespacedSecrets) {
    for (const ctx of Object.values(request.namespacedSecrets)) {
      for (const key of Object.keys(ctx)) operatorSecretKeys.add(key);
    }
  }
  const outputsMap: OutputsMap = new Map();
  const secretOutputs = new Map<string, string>();
  setStepOutputsMap(outputsMap);
  setStepRefMap(refMap);
  workflowSdkSetters?.setStepOutputsMap(outputsMap);
  workflowSdkSetters?.setStepRefMap(refMap);

  const jobOutputsMap: OutputsMap = new Map();
  if (request.upstreamJobOutputs) {
    for (const [jobName, outputs] of Object.entries(request.upstreamJobOutputs)) {
      jobOutputsMap.set(jobName, outputs);
    }
  }
  setJobOutputsMap(jobOutputsMap);
  workflowSdkSetters?.setJobOutputsMap(jobOutputsMap);

  return { operatorSecretKeys, outputsMap, secretOutputs, jobOutputsMap };
}

/**
 * Resolve `event.changedFiles` for rule evaluation before job/step rules run.
 * Ground truth is the agent's own clone (`computeChangedFiles`); the
 * orchestrator's already-fetched list (status `'fetched'`) is a free fast-path.
 * Only runs when a rule could read `ctx.changedFiles` — rule-less jobs skip the
 * git cost. Diff-less events (schedule/tag/manual) resolve to `'unavailable'`.
 */
export async function resolveChangedFilesForRules(
  request: JobExecutionRequest,
  workDir: string,
  hasRules: boolean,
): Promise<void> {
  if (!hasRules) return;
  request.event ??= {};
  const ev = request.event as {
    changedFiles?: string[];
    changedFilesStatus?: ChangedFilesStatus;
  };
  if (ev.changedFilesStatus === 'fetched') return;
  // Authenticate the git deepen/fetch with the same credentials the clone used
  // for the SOURCE repo (its own were ephemeral), so a private remote resolves.
  // Mirror cloneRepoIfRequested's source-auth chain exactly: for a global
  // workflow the source clone falls back to workflowAuth, then `token` (the
  // transition-window Basic-auth fallback synthesised by computeChangedFiles).
  const sourceAuth = request.sourceAuth ?? request.workflowAuth;
  const auth: GitAuth | undefined =
    sourceAuth ??
    (request.token ? { kind: 'basic', user: 'x-access-token', secret: request.token } : undefined);
  const resolved = await computeChangedFiles(workDir, request.event as EventPayload, auth);
  ev.changedFiles = resolved.files;
  ev.changedFilesStatus = resolved.status;
}

/**
 * Decide the terminal `job.complete` for job-level rule evaluation, or `null`
 * when the job should proceed to step execution.
 *
 * - `allPassed` → `null` (run the steps).
 * - a rule's `check()` **threw** (`evaluationError`) → FAIL: the gate could not
 *   be evaluated, so treating "couldn't decide" as "don't run" would be a false
 *   green. Report `status: failed` with the error surfaced.
 * - a rule cleanly returned `false` → clean skip: `status: success` with every
 *   step marked skipped (a gate that evaluated and said "don't run").
 *
 * Pure and exported so the decision is unit-testable without `process.exit`.
 */
export function buildJobRuleCompletion(
  ruleResult: RuleEvaluationResult,
  normalizedSteps: Step[],
): (RunnerToAgentMessage & { type: 'job.complete' }) | null {
  if (ruleResult.allPassed) return null;

  const skippedResults: SandboxStepResult[] = normalizedSteps.map((s, i) => ({
    name: s.name,
    stepIndex: i,
    status: ExecutionStepStatus.enum.skipped,
    durationMs: 0,
  }));

  if (ruleResult.evaluationError) {
    return {
      type: 'job.complete',
      status: ExecutionJobStatus.enum.failed,
      stepResults: skippedResults,
      error: `rule '${ruleResult.evaluationError.label}' errored: ${ruleResult.evaluationError.message}`,
    };
  }

  return {
    type: 'job.complete',
    status: ExecutionJobStatus.enum.success,
    stepResults: skippedResults,
  };
}

/**
 * Phase 7 — Evaluate job-level rules. A clean rule failure sends
 * `job.complete{success}` with all steps skipped; a rule whose `check()` threw
 * sends `job.complete{failed}` with the error surfaced (never a silent
 * success-skip). Returns false when the caller should continue to step
 * execution.
 */
async function maybeSkipJobOnRules(
  job: Job | undefined,
  request: JobExecutionRequest,
  normalizedSteps: Step[],
  /** The global-workflow repo pair, or undefined for a normal job. */
  repos?: GeneratorRepoPair,
): Promise<boolean> {
  if (!job?.rules || job.rules.length === 0) return false;
  const ev = (request.event ?? {}) as {
    changedFiles?: string[];
    changedFilesStatus?: ChangedFilesStatus;
  };
  const ruleCtx = createRuleContext({
    event: request.event ?? {},
    changedFiles: ev.changedFiles,
    changedFilesStatus: ev.changedFilesStatus,
    env: process.env as Record<string, string | undefined>,
    dispatchInputs: (request.dispatchInputs ?? {}) as Readonly<
      Record<string, string | number | boolean | null>
    >,
    fanout: deriveFanout(request),
    // A rule reads the source tree through `sourceRepo.path` the same way a
    // generator does. Absent for a normal job.
    ...(repos && { sourceRepo: repos.sourceRepo, workflowRepo: repos.workflowRepo }),
  });
  const ruleResult = await evaluateRules(job.rules, ruleCtx, request.jobName);
  const completion = buildJobRuleCompletion(ruleResult, normalizedSteps);
  if (!completion) return false;

  flushOutputCapture();
  capturePrepareActive = false;
  sendMessage(completion);
  process.exit(0);
}

/**
 * Build the inputs the step loop turns into every step rule's `RuleContext`.
 *
 * Shares its source with `maybeSkipJobOnRules` so a step rule and a job rule
 * see the same world: the same event, env, dispatch inputs, fan-out position,
 * and — for a global workflow — the same source / workflow repo pair. A step
 * rule that received the pair as `undefined` while the job rule beside it
 * received the real thing would read the same `RuleContext` type two ways.
 *
 * The pair is spread conditionally: a present-but-undefined `sourceRepo` reads
 * as "declared" to a rule that guards on the key rather than the value.
 */
export function buildStepLoopRuleInputs(
  request: JobExecutionRequest,
  repos: GeneratorRepoPair | undefined,
): Pick<
  StepLoopOptions,
  'event' | 'env' | 'dispatchInputs' | 'fanout' | 'sourceRepo' | 'workflowRepo'
> {
  return {
    event: request.event ?? {},
    env: process.env as Record<string, string | undefined>,
    dispatchInputs: (request.dispatchInputs ?? {}) as Readonly<
      Record<string, string | number | boolean | null>
    >,
    fanout: deriveFanout(request),
    ...(repos && { sourceRepo: repos.sourceRepo, workflowRepo: repos.workflowRepo }),
  };
}

/**
 * Collect the six job-level hooks (beforeStep / afterStep / onSuccess /
 * onFailure / onCancel / cleanup) into a single typed object the step loop
 * and cancel-path consume.
 */
function collectJobHooks(job: Job | undefined): JobHooks {
  const jobHooks: JobHooks = {};
  if (!job) return jobHooks;
  if (job.beforeStep) jobHooks.beforeStep = job.beforeStep;
  if (job.afterStep) jobHooks.afterStep = job.afterStep;
  if (job.onSuccess) jobHooks.onSuccess = job.onSuccess;
  if (job.onFailure) jobHooks.onFailure = job.onFailure;
  if (job.onCancel) jobHooks.onCancel = job.onCancel;
  if (job.cleanup) jobHooks.cleanup = job.cleanup;
  return jobHooks;
}

/**
 * Base stepIndex for the `init:<n>` pseudo-steps. The step loop reserves the
 * range starting at `steps.length` for hook pseudo-steps (`beforeStep` =
 * `steps.length + i*2`, `afterStep` = `steps.length + i*2 + 1`, and job-level
 * onSuccess/onFailure/cleanup from `steps.length` upward — see step-loop.ts),
 * so init indices must sit ABOVE every possible hook index to avoid collision.
 * A large fixed offset reserves a dedicated range no realistic step/hook count
 * can reach; init:<n> then occupies `INIT_STEP_INDEX_BASE + n`.
 */
const INIT_STEP_INDEX_BASE = 1_000_000;

/**
 * Read the KICI_ENV/KICI_PATH delta written by a command, apply it through
 * `applyEnvDelta` (operator-secret override guard + masked reject log), then
 * truncate the files for the next command. Shared by the per-job init phase and
 * the per-step after-hook so both honor the identical operator-secret guard.
 */
async function applyEnvFilesDelta(
  envFiles: EnvFiles,
  operatorSecretKeys: Set<string>,
  maskedSend: (msg: RunnerToAgentMessage) => void,
): Promise<void> {
  const delta = await readEnvDelta(envFiles);
  applyEnvDelta(delta, {
    operatorSecretKeys,
    onReject: (key: string) =>
      maskedSend({
        type: 'log.line',
        stepIndex: -1,
        line: `[kici] Cannot override operator secret "${key}" via $KICI_ENV — value preserved`,
      }),
  });
  await truncateEnvFiles(envFiles);
}

/**
 * Build the step loop's KICI_ENV/KICI_PATH callbacks with a per-step delta-file
 * pair (keyed by step index). `beforeStepEnvFiles(stepIndex)` lazily creates the
 * step's pair and points the runner's process.env at it (each step's zx $
 * reads live process.env at spawn, which happens AFTER this before-hook, so
 * the shell sees them; the pre-fork env allowlist does not
 * re-filter runtime-set vars). `afterStepApplyEnvFiles(stepIndex)` applies that
 * step's delta and releases the pair.
 *
 * Env-isolation contract: under sequential execution this is identical to a
 * single shared pair truncated between steps — each step still sees only its own
 * delta. The pair is now per-step so two concurrently-running steps cannot
 * corrupt each other's delta file. `process.env.KICI_ENV` / `process.env.KICI_PATH`
 * remain process-global, so Phase 1 forbids `setEnv` / `addPath` / `$KICI_ENV`
 * writes inside `parallel()` children (compile-time validation); Phase 0 only
 * makes the file pair per-task.
 */
export function buildStepEnvFileHooks(
  operatorSecretKeys: Set<string>,
  maskedSend: (msg: RunnerToAgentMessage) => void,
): {
  beforeStepEnvFiles: (stepIndex: number) => Promise<void>;
  afterStepApplyEnvFiles: (stepIndex: number) => Promise<void>;
} {
  const perStep = new Map<number, EnvFiles>();
  return {
    beforeStepEnvFiles: async (stepIndex: number) => {
      let files = perStep.get(stepIndex);
      if (!files) {
        files = await createEnvFiles(tmpdir());
        perStep.set(stepIndex, files);
      }
      process.env.KICI_ENV = files.envFile;
      process.env.KICI_PATH = files.pathFile;
    },
    afterStepApplyEnvFiles: async (stepIndex: number) => {
      const files = perStep.get(stepIndex);
      if (!files) return;
      perStep.delete(stepIndex);
      try {
        await applyEnvFilesDelta(files, operatorSecretKeys, maskedSend);
      } catch (err) {
        maskedSend({
          type: 'log.line',
          stepIndex: -1,
          line: `[kici] Failed to apply $KICI_ENV/$KICI_PATH delta: ${toErrorMessage(err)}`,
        });
      }
    },
  };
}

/**
 * Run the per-job init phase with concrete ports, then fail the job (no steps)
 * if any init spec failed or timed out.
 *
 * Concrete ports supplied to `runInitPhase`:
 * - shell: a fresh `buildSandboxShell` per init (same zx config steps use), cwd
 *   = the clone root. Each init snapshots `process.env` (which `beginCapture`
 *   has pointed at the shared KICI_ENV/KICI_PATH files), so the command can hand
 *   env + PATH off to later inits and to every step.
 * - cache: the transport-backed `CacheApi` (`createCacheApi`) — the same engine
 *   `ctx.cache` and the declarative cache phase use. Restore before / save on
 *   key miss after.
 * - env: the P1 KICI_ENV/KICI_PATH lifecycle over the shared `envFiles`,
 *   mirroring the step loop's `beforeStepEnvFiles` / `afterStepApplyEnvFiles`
 *   (same `operatorSecretKeys` guard + masked reject log).
 *
 * On `result.ok === false`: emit `job.complete{failed}` with `stepResults: []`
 * (no step ran), an actionable error (carrying the distinct P3 timeout reason
 * when `timedOut`), and `process.exit(1)` — the step loop never executes.
 */
async function runInitPhaseOrFailJob(args: {
  job: Job | undefined;
  stepCwd: string;
  envFiles: EnvFiles;
  operatorSecretKeys: Set<string>;
  maskedSend: (msg: RunnerToAgentMessage) => void;
}): Promise<void> {
  const { job, stepCwd, envFiles, operatorSecretKeys, maskedSend } = args;
  const directives = normalizeInitItems(job);
  if (directives.length === 0) return;
  // Preset / 'auto' expansion happens here, where the clone root (stepCwd) is on
  // disk to hash for the cache key and scan for auto-detect marker files.
  const initSpecs = await expandInitDirectives(directives, {
    cloneRoot: stepCwd,
    log: (line) => maskedSend({ type: 'log.line', stepIndex: -1, line }),
  });
  if (initSpecs.length === 0) return;

  // The init cache engine is the same transport-backed CacheApi steps use
  // (createCacheApi over buildCacheTransport), bound to the clone root.
  const initCache = createCacheApi(stepCwd, buildCacheTransport());

  // P1 env-handoff port over the shared KICI_ENV/KICI_PATH files: point the
  // process env at the (truncated) files before each init so the command's
  // exports land there; after a successful command read+apply the delta through
  // applyEnvDelta and truncate for the next init/step.
  const initEnv = {
    beginCapture: async (): Promise<void> => {
      process.env.KICI_ENV = envFiles.envFile;
      process.env.KICI_PATH = envFiles.pathFile;
      await truncateEnvFiles(envFiles);
    },
    applyDelta: async (): Promise<void> => {
      await applyEnvFilesDelta(envFiles, operatorSecretKeys, maskedSend);
    },
  };

  const initResult = await runInitPhase({
    specs: initSpecs,
    shellFor: (_spec, i) => buildSandboxShell(stepCwd, INIT_STEP_INDEX_BASE + i, maskedSend),
    sendIpc: maskedSend,
    stepIndexBase: INIT_STEP_INDEX_BASE,
    cache: initCache,
    env: initEnv,
  });

  if (!initResult.ok) {
    const errorBody = initResult.error ?? '';
    sendMessage({
      type: 'job.complete',
      status: ExecutionJobStatus.enum.failed,
      stepResults: [],
      error: initResult.reason
        ? `init[${initResult.failedInitIndex}] ${initResult.reason}: ${errorBody}`.trim()
        : `init[${initResult.failedInitIndex}] failed: ${errorBody}`.trim(),
    });
    process.exit(1);
  }
}

// --- Main Job Execution Lifecycle ---

/**
 * Run the complete job execution lifecycle.
 *
 * 1. Receive execution request
 * 2. Git clone (if checkout enabled)
 * 3. Dependency handling (cache restore or inline install)
 * 4. Load workflow module (from bundle or source)
 * 5. Extract workflow and steps
 * 6. Evaluate rules (if any)
 * 7. Execute steps sequentially with IPC reporting
 * 8. Send job.complete and exit
 */
async function main(): Promise<void> {
  trace(`main() started, isForkMode=${isForkMode}, pid=${process.pid}`);
  sendMessage({ type: 'ready' });
  trace('ready message sent');

  const executeMsg = await receiveRequest();
  const request = executeMsg.request;
  trace(
    `execute request received: workDir=${request.workDir}, workflow=${request.workflowName}, job=${request.jobName}`,
  );

  const workDir = request.workDir;
  const defaultTimeoutMs = request.defaultStepTimeoutMs ?? 30 * 60 * 1000;
  const isGlobal = request.isGlobalWorkflow === true;
  const workflowDir = isGlobal ? join(workDir, 'workflow') : workDir;
  const sourceDir = isGlobal ? join(workDir, 'source') : workDir;

  const masker = createSecretMasker(request);
  const maskedSend = (msg: RunnerToAgentMessage): void => {
    if (msg.type === 'log.line' && masker.hasSecrets()) {
      sendMessage({ ...msg, line: masker.mask(msg.line) });
    } else {
      sendMessage(msg);
    }
  };

  // Arm the job-level wall-clock deadline (the lock job's `timeout`). On
  // breach it trips the SAME abort path cancellation uses (so the in-flight
  // step's own timeout race unwinds and the cancel-path hooks still run),
  // plus records the distinct job_timeout reason. A no-op when unset.
  const jobDeadline = armJobDeadline(request.jobTimeoutMs, (reason, timeoutMs) => {
    jobTimedOut = true;
    jobTimedOutMs = timeoutMs;
    aborted = true;
    forceAborted = true;
    maskedSend({
      type: 'log.line',
      stepIndex: -1,
      line: `[kici] Job exceeded its timeout of ${timeoutMs}ms (${reason}); aborting.`,
    });
    // Interrupt the in-flight step immediately — flipping `aborted` only takes
    // effect between steps, which never unwinds a single long-running step.
    jobDeadlineAbort.abort();
  });

  // Phase 1: clone (if checkout enabled) + overlay tarball
  await cloneRepoIfRequested(request, workDir, workflowDir, sourceDir, isGlobal);
  await applyOverlayIfRequested(request, workflowDir);
  await makeOverlayGitUsable(request, workflowDir);
  if (aborted) abortAndExit('aborted after clone');

  // Phase 2: deps (cache restore or inline install)
  await installDependenciesIfNeeded(workflowDir, request);
  if (aborted) abortAndExit('aborted after deps');

  // Phase 2b: restore cached source tarball over .kici/ if present
  await restoreSourceTarballIfRequested(workflowDir, request);

  // Phase 3: load workflow module + install output capture
  const loaded = await loadWorkflowModuleWithCapture(workflowDir, request, isGlobal, maskedSend);
  const module: Record<string, unknown> = loaded.module;
  const workflow = extractWorkflow(module, request.workflowName);

  // Phase 4: concurrency group eval (may exit the process for wait/cancel)
  await evaluateConcurrencyGroupIfPresent(workflow, request);

  // Phase 5: inject the global-workflow env + repo pair, then extract steps
  // (dynamic source eval or static lookup) and normalize.
  //
  // The env injection runs FIRST because the generator (below) and the rules
  // (phase 7) both receive the repo pair and both may read the source tree
  // through it. A generator re-evaluated in a sandbox that could not see the
  // source would produce a different job list than the pre-dispatch evaluation
  // did, and `extractStepsFromDynamicJob` fails the job on that mismatch.
  const globalRepoInfo = setupGlobalWorkflowEnv(request, isGlobal, workflowDir, sourceDir);

  const apiTransport = async (method: string, params?: Record<string, unknown>) => {
    const reqId = randomUUID();
    sendMessage({
      type: 'agent.api.request',
      requestId: reqId,
      method,
      params: params ?? {},
    });
    return waitForApiResponse(reqId);
  };
  const { normalizedSteps, nodes, refMap, driftDroppedJobs } = await extractAndNormalizeSteps(
    workflow,
    request,
    apiTransport,
    globalRepoInfo,
  );

  // Phase 6: build output infrastructure (operator-secret keys + outputs maps)
  const { operatorSecretKeys, outputsMap, secretOutputs, jobOutputsMap } =
    buildOutputInfrastructure(request, refMap, loaded.sdkSetters);

  // Phase 7: job-level rules — may early-exit with skipped steps
  const job = findJob(workflow, request.jobName);
  // Resolve changed files (ground truth = the source clone) before rule eval,
  // only when a job or step rule could read ctx.changedFiles.
  const jobHasRules = (job?.rules?.length ?? 0) > 0;
  const anyStepHasRules = normalizedSteps.some((s) => (s.rules?.length ?? 0) > 0);
  await resolveChangedFilesForRules(request, sourceDir, jobHasRules || anyStepHasRules);
  await maybeSkipJobOnRules(job, request, normalizedSteps, globalRepoInfo);
  if (aborted) abortAndExit('aborted after rules');

  // Phase 8: collect job hooks
  const jobHooks = collectJobHooks(job);

  // Phase 9: switch from prepare-phase capture to per-step capture
  flushOutputCapture();
  capturePrepareActive = false;

  // For global workflows, CWD for step execution is the source repo
  const stepCwd = sourceDir;

  // KICI_ENV / KICI_PATH temp-file contract: one pair of files reused across
  // the init phase + every step (truncated between each). A command appends
  // KEY=value lines to $KICI_ENV and one dir per line to $KICI_PATH; the delta
  // then flows through applyEnvDelta -- the same path ctx.setEnv / ctx.addPath
  // and the per-step after-hook use. Created here (before init) so init commands
  // can hand env/PATH off to subsequent inits and to every step.
  const envFiles: EnvFiles = await createEnvFiles(tmpdir());

  // Per-job init phase (after clone + module load, before the step
  // loop). Each init spec runs through the SAME sandbox shell steps use; on the
  // first failure/timeout the job fails before any step runs (no step loop).
  await runInitPhaseOrFailJob({
    job,
    stepCwd,
    envFiles,
    operatorSecretKeys,
    maskedSend,
  });

  // Declarative cache infrastructure + Phase 9b job-level cache restore.
  const { cachePhaseDeps, jobCacheSpecs, jobCacheRestore } = await setupJobCache(
    stepCwd,
    normalizedSteps.length,
    job?.cache,
    maskedSend,
  );

  // Per-step secrets handle (for access-log + mount-record reporting) and the
  // matching dispose closure (called from the step-loop's `finally` to remove
  // the per-step mount tmpdir + clear any env vars set via
  // `ctx.secrets.exposeFile`), keyed by step index so concurrent steps keep
  // independent secrets-audit trails.
  const stepTasks = new StepTaskRegistry();
  // Per-step abort controllers. Today they are only aborted via the composed
  // `ctx.signal` when the job is cancelled / times out; Phase 1 fail-fast aborts
  // an individual step's controller to cancel one in-flight sibling.
  const stepAbortControllers = new Map<number, AbortController>();
  // The single job-scoped allocator behind every step's `ctx.mktemp` /
  // `ctx.mktempFile` — created here, after all prepare-phase early exits
  // (`abortAndExit` after clone/deps/rules, concurrency wait/cancel) which run
  // before any step context exists and so allocate no `ctx` temp dirs, and
  // drained exactly once at job end below.
  const jobTempScope = createTempScope();
  const createStepCtxWithCapture = (stepIndex: number, stepName: string): StepContext => {
    const stepAbort = new AbortController();
    stepAbortControllers.set(stepIndex, stepAbort);
    // ctx.signal aborts when this step's own controller, the job-cancel signal,
    // or the job-deadline signal fires.
    const signal = AbortSignal.any([
      stepAbort.signal,
      jobCancelAbort.signal,
      jobDeadlineAbort.signal,
    ]);
    // Build the secrets handle FIRST so the file-mount host is bound for
    // this step's invocation. The masker is global to the job; mount calls
    // register their (potentially-concatenated) content into it before the
    // file path is returned, so a child process echoing the credential
    // sees the masked replacement on the streamed log.
    const handle = buildStepSecrets(request, masker, () => {
      // No-op: registerSecrets() already rebuilds the masker pattern.
    });
    stepTasks.set(stepIndex, { secrets: handle.secrets, dispose: handle.dispose });
    const ctx = createSandboxStepContext(
      stepCwd,
      stepIndex,
      stepName,
      request,
      maskedSend,
      outputsMap,
      refMap,
      operatorSecretKeys,
      secretOutputs,
      jobOutputsMap,
      handle.secrets,
      masker,
      signal,
      jobTempScope,
    );
    if (globalRepoInfo) {
      ctx.workflowRepo = globalRepoInfo.workflowRepo;
      ctx.sourceRepo = globalRepoInfo.sourceRepo;
    }
    return ctx;
  };

  const stepEnvHooks = buildStepEnvFileHooks(operatorSecretKeys, maskedSend);
  const jobStartTime = Date.now();
  const loopResult = await executeStepLoop({
    steps: normalizedSteps,
    stepNodes: nodes,
    abortStep: (stepIndex) => stepAbortControllers.get(stepIndex)?.abort(),
    getStepAbortSignal: (stepIndex) => stepAbortControllers.get(stepIndex)?.signal,
    checkMode: request.checkMode,
    createStepContext: createStepCtxWithCapture,
    sendIpc: maskedSend,
    defaultTimeoutMs,
    outputsMap,
    ...buildStepLoopRuleInputs(request, globalRepoInfo),
    jobHooks,
    cachePhaseDeps,
    isAborted: () => aborted,
    jobDeadlineSignal: jobDeadlineAbort.signal,
    startTime: jobStartTime,
    // Run each step body (and its hooks) inside an async-context capture scope so
    // console output attributes to that step's index even under Phase 1
    // concurrency. The flush below runs inside this scope, so a step's trailing
    // partial line is still attributed to it.
    runWithStepCapture: runInStepCapture,
    getSecretsAccessLog: (stepIndex) => {
      // Flush any remaining console output buffered for this step. Called inside
      // the step's `runWithStepCapture` scope, so the flush attributes to this
      // step; the scope unwinds on its own once the step run completes.
      flushOutputCapture();
      return stepTasks.getAccessLog(stepIndex);
    },
    getSecretMountRecords: (stepIndex) => stepTasks.getMountRecords(stepIndex),
    disposeStepResources: (stepIndex) => {
      stepAbortControllers.delete(stepIndex);
      return stepTasks.dispose(stepIndex);
    },
    // KICI_ENV / KICI_PATH file callbacks (shared with the init phase via
    // buildStepEnvFileHooks): point process.env at the files before each step,
    // apply + truncate the delta after.
    beforeStepEnvFiles: stepEnvHooks.beforeStepEnvFiles,
    afterStepApplyEnvFiles: stepEnvHooks.afterStepApplyEnvFiles,
    awaitStepApproval: buildAwaitStepApproval(),
    awaitStepApprovalWithPayload: buildAwaitStepApprovalWithPayload(),
  });

  // The step loop has returned — disarm the job deadline so a late fire can't
  // re-trip the abort flags during the cancel-path hooks / final emit.
  jobDeadline.clear();

  // Phase 9c: job-level cache save (after the step loop, only on full success).
  const jobSucceeded = !aborted && loopResult.status === ExecutionStepStatus.enum.success;
  await maybeSaveJobCache(jobCacheSpecs, jobCacheRestore, cachePhaseDeps, jobSucceeded);

  // Phase 10: cancel-path hooks (when aborted) or pass-through final status
  let finalStatus: 'success' | 'failed' = initialJobStatus(loopResult.status);
  let cancelFailureReason: string | undefined;
  if (aborted) {
    const cancelResult = await runCancelPathHooks({
      forceAborted,
      normalizedSteps,
      loopResult,
      jobHooks,
      jobStartTime,
      outputsMap,
      createStepCtxWithCapture,
      disposeStepResources: (stepIndex) => {
        stepAbortControllers.delete(stepIndex);
        return stepTasks.dispose(stepIndex);
      },
      maskedSend,
    });
    finalStatus = cancelResult.finalStatus;
    cancelFailureReason = cancelResult.cancelFailureReason;
  }

  // Phase 11: emit job.complete with aggregated outputs and exit.
  // A timed-out job is a FAILED job (not cancelled): the cancel-path hooks ran
  // because `aborted` was set, but the run outcome is failure with the
  // distinct job_timeout reason.
  if (jobTimedOut) finalStatus = ExecutionJobStatus.enum.failed;

  // Reclaim every `ctx.mktemp` / `ctx.mktempFile` allocation once, here — the
  // single convergence point for success, failure, and cancel/timeout (the step
  // loop returned and any cancel-path hooks ran above). Cleanup errors are
  // swallowed so a failed reclaim never flips the job's terminal status.
  await drainJobTempScopeToLog(jobTempScope, maskedSend);

  emitJobComplete({
    finalStatus,
    loopResult,
    outputsMap,
    secretOutputs,
    jobTimedOut,
    jobTimeoutMs: request.jobTimeoutMs,
    cancelFailureReason,
    driftDroppedJobs,
  });
  process.exit(finalStatus === ExecutionJobStatus.enum.success ? 0 : 1);
}

/**
 * Phase 11 — emit the terminal `job.complete` IPC. Aggregates per-step outputs
 * by step name, includes encrypted secret outputs, and selects the error
 * message: a `job_timeout` reason when the job-level deadline tripped, else the
 * step-loop's failure reason (or the cancel-path's compound reason).
 */
function emitJobComplete(args: {
  finalStatus: 'success' | 'failed';
  loopResult: { stepResults: SandboxStepResult[]; failureReason?: string };
  outputsMap: OutputsMap;
  secretOutputs: Map<string, string>;
  jobTimedOut: boolean;
  jobTimeoutMs?: number;
  cancelFailureReason?: string;
  driftDroppedJobs: string[];
}): void {
  const aggregatedOutputs: Record<string, Record<string, unknown>> = {};
  for (const [stepName, outputs] of args.outputsMap) {
    aggregatedOutputs[stepName] = outputs;
  }
  sendMessage({
    type: 'job.complete',
    status: args.finalStatus,
    stepResults: args.loopResult.stepResults,
    ...(Object.keys(aggregatedOutputs).length > 0 && { outputs: aggregatedOutputs }),
    ...(args.secretOutputs.size > 0 && {
      secretOutputs: Object.fromEntries(args.secretOutputs),
    }),
    ...(args.jobTimedOut
      ? {
          error: `${TimeoutReason.enum.job_timeout}: job exceeded its timeout of ${args.jobTimeoutMs}ms`,
        }
      : {
          ...(args.loopResult.failureReason && { error: args.loopResult.failureReason }),
          ...(args.cancelFailureReason && { error: args.cancelFailureReason }),
        }),
    ...(args.driftDroppedJobs.length > 0 && { droppedJobs: args.driftDroppedJobs }),
  });
}

/**
 * Find a static Job by name in the workflow.
 */
function findJob(workflow: { jobs: readonly JobOrFactory[] }, jobName: string): Job | undefined {
  for (const item of workflow.jobs) {
    if (!isDynamicJobFn(item) && (item as Job).name === jobName) {
      return item as Job;
    }
  }
  return undefined;
}

// --- Entry Point ---

main().catch((error) => {
  // Unhandled error in the job lifecycle
  const message = toErrorMessage(error);
  const stack = error instanceof Error ? error.stack : undefined;

  // Write to stderr for container log capture (IPC might not flush before exit)
  process.stderr.write(`[workflow-runner] Fatal error: ${message}\n`);
  if (stack) {
    process.stderr.write(`[workflow-runner] Stack: ${stack}\n`);
  }

  // Send error via IPC for agent-level visibility
  sendMessage({
    type: 'log.line',
    stepIndex: -1,
    line: `[workflow-runner] [error] Fatal: ${message}`,
  });

  sendMessage({
    type: 'job.complete',
    status: ExecutionJobStatus.enum.failed,
    stepResults: [],
    error: message,
  });

  // Give IPC messages time to flush before exiting
  setTimeout(() => process.exit(1), 100);
});
