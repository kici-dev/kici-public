/** Browser <-> Platform WebSocket protocol schemas. */
import { z } from 'zod';
import { browserRunEventSchema, browserJobContextSchema } from './run-events.js';
import { browserEventLogPayloadChunkSchema } from './dashboard.js';
import { OrchLogPhase } from './platform-orchestrator.js';
import { LogStream } from './log-stream.js';

// --- Browser -> Platform messages ---

/** Browser sends JWT token for authentication (first message after WS open). */
export const browserAuthRequestSchema = z.object({
  type: z.literal('auth.request'),
  token: z.string().min(1),
});

/** Browser sends a refreshed JWT token to extend the session. */
export const browserAuthRefreshSchema = z.object({
  type: z.literal('auth.refresh'),
  token: z.string().min(1),
});

/** Browser subscribes to log lines for a specific step. */
export const browserLogSubscribeSchema = z.object({
  type: z.literal('log.subscribe'),
  runId: z.string(),
  jobId: z.string(),
  stepIndex: z.number(),
  /** Resume from this line count (for mid-execution join after REST fetch). */
  afterLineCount: z.number().optional(),
});

/** Browser unsubscribes from log lines for a specific step. */
export const browserLogUnsubscribeSchema = z.object({
  type: z.literal('log.unsubscribe'),
  runId: z.string(),
  jobId: z.string(),
  stepIndex: z.number(),
});

/**
 * Browser subscribes to a job's live orchestration/provisioning logs, which are
 * job-level, so there is no `stepIndex`. On subscribe the Platform backfills
 * persisted history via the `dashboard.orch.logs` RPC, then streams live
 * `orch-log.lines`.
 */
export const browserOrchLogSubscribeSchema = z.object({
  type: z.literal('orch-log.subscribe'),
  runId: z.string(),
  jobId: z.string(),
});

/** Browser unsubscribes from live orchestration/provisioning logs for a job. */
export const browserOrchLogUnsubscribeSchema = z.object({
  type: z.literal('orch-log.unsubscribe'),
  runId: z.string(),
  jobId: z.string(),
});

/** Browser subscribes to org-level status updates (run/job/step status changes). */
export const browserStatusSubscribeSchema = z.object({
  type: z.literal('status.subscribe'),
  scope: z.literal('org'),
  /** Required so the Platform routes updates for the correct org. */
  orgId: z.string().min(1),
});

/** Browser unsubscribes from status updates. */
export const browserStatusUnsubscribeSchema = z.object({
  type: z.literal('status.unsubscribe'),
});

/** Browser sends a keepalive ping to prevent LB idle timeout. */
export const browserPingSchema = z.object({
  type: z.literal('ping'),
});

/**
 * Browser asks the Platform to stream the body of an event-log delivery.
 *
 * The dashboard generates a `requestId` (uuid) per fetch to correlate incoming
 * chunks. `orgId` is the org the dashboard is viewing; the Platform's
 * browser-handler verifies the user's active membership in it (as for
 * `status.subscribe`) and gates on `event_log:read_payload` in that org.
 */
export const browserEventLogPayloadFetchSchema = z.object({
  type: z.literal('event-log.payload.fetch'),
  requestId: z.string().min(1),
  orgId: z.string().min(1),
  deliveryId: z.string().min(1),
});

/** All messages that flow from Browser to Platform. */
export const browserToPlatformMessageSchema = z.discriminatedUnion('type', [
  browserAuthRequestSchema,
  browserAuthRefreshSchema,
  browserLogSubscribeSchema,
  browserLogUnsubscribeSchema,
  browserOrchLogSubscribeSchema,
  browserOrchLogUnsubscribeSchema,
  browserStatusSubscribeSchema,
  browserStatusUnsubscribeSchema,
  browserEventLogPayloadFetchSchema,
  browserPingSchema,
]);

// --- Platform -> Browser messages ---

/** Platform confirms browser authentication. */
export const browserAuthSuccessSchema = z.object({
  type: z.literal('auth.success'),
  connectionId: z.string(),
});

/** Platform rejects browser authentication. */
export const browserAuthFailureSchema = z.object({
  type: z.literal('auth.failure'),
  reason: z.string(),
});

/** Platform sends log lines for a subscribed step. */
export const browserLogLinesSchema = z.object({
  type: z.literal('log.lines'),
  runId: z.string(),
  jobId: z.string(),
  stepIndex: z.number(),
  lines: z.array(z.string()),
  /** Cumulative line count, so the browser knows its position. */
  lineCount: z.number(),
  /**
   * Which stream these lines came from. Absent when the producing orchestrator
   * does not report one; read as `stdout`.
   */
  stream: LogStream.optional(),
});

/**
 * Platform sends orchestration/provisioning log lines for a subscribed job, in
 * two forms:
 * - **Backfill** (on subscribe): `lines` are the persisted JSONL strings from
 *   the `dashboard.orch.logs` RPC, each carrying its own `phase`/`ts`, so the
 *   top-level `phase`/`ts` are omitted.
 * - **Live** (after backfill): `lines` are raw message strings for a single
 *   `phase` at timestamp `ts`.
 *
 * The dashboard JSON-parses each line, falls back to the envelope `phase`/`ts`,
 * and dedups on `(ts, phase, message)` so an overlap between the backfill
 * snapshot and the first live chunk is not appended twice.
 */
export const browserOrchLogLinesSchema = z.object({
  type: z.literal('orch-log.lines'),
  runId: z.string(),
  jobId: z.string(),
  phase: OrchLogPhase.optional(),
  lines: z.array(z.string()),
  ts: z.number().optional(),
});

/** Platform notifies browser that lines were dropped due to backpressure. */
export const browserGapSchema = z.object({
  type: z.literal('log.gap'),
  runId: z.string(),
  jobId: z.string(),
  stepIndex: z.number(),
  droppedLineCount: z.number(),
});

/**
 * Why the Platform terminated a live-log stream. `plan_limit_live_log_minutes`:
 * the org exceeded its daily live-log minute cap.
 */
export const browserLogStreamTerminatedReason = z.enum(['plan_limit_live_log_minutes']);
export type BrowserLogStreamTerminatedReason = z.infer<typeof browserLogStreamTerminatedReason>;

/**
 * Platform notifies browser that a live-log stream has been terminated:
 * 1. **At subscribe time:** the org is already over the daily live-log minute
 *    cap, so the subscription is never registered.
 * 2. **Mid-stream:** the periodic metering tick saw the org cross the cap; every
 *    active log subscriber in that org gets this and is unregistered.
 *
 * Browsers show the upgrade prompt and do NOT auto-resubscribe.
 */
export const browserLogStreamTerminatedSchema = z.object({
  type: z.literal('log.stream.terminated'),
  runId: z.string(),
  jobId: z.string(),
  stepIndex: z.number(),
  reason: browserLogStreamTerminatedReason,
  /** Human-readable message for the dashboard to display. */
  message: z.string().optional(),
});

/** Platform sends a run-level status update. */
export const browserRunStatusSchema = z.object({
  type: z.literal('run.status'),
  runId: z.string(),
  status: z.string(),
  completedAt: z.number().optional(),
  durationMs: z.number().optional(),
});

/** Platform sends a job-level status update. */
export const browserJobStatusSchema = z.object({
  type: z.literal('job.status'),
  runId: z.string(),
  jobId: z.string(),
  jobName: z.string(),
  status: z.string(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  durationMs: z.number().optional(),
});

/** Platform sends a step-level status update. */
export const browserStepStatusSchema = z.object({
  type: z.literal('step.status'),
  runId: z.string(),
  jobId: z.string(),
  stepIndex: z.number(),
  stepName: z.string(),
  state: z.string(),
  timestamp: z.number(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  durationMs: z.number().optional(),
  /** Secret key names accessed by this step. Present on completion states. */
  secretsAccessed: z.array(z.string()).optional(),
});

/** Platform notifies browser of a new run (first-time insert, full run summary). */
export const browserRunNewSchema = z.object({
  type: z.literal('run.new'),
  runId: z.string(),
  status: z.string(),
  workflowName: z.string(),
  repoIdentifier: z.string().optional(),
  sha: z.string().optional(),
  ref: z.string().optional(),
  triggerEvent: z.string().optional(),
  commitMessage: z.string().optional(),
  jobCount: z.number(),
  startedAt: z.number(),
  orgId: z.string(),
});

/** Platform notifies browser of a new job (first-time insert). */
export const browserJobNewSchema = z.object({
  type: z.literal('job.new'),
  runId: z.string(),
  jobId: z.string(),
  jobName: z.string(),
  status: z.string(),
  matrixValues: z.record(z.string(), z.unknown()).nullable().optional(),
  startedAt: z.number().optional(),
});

/** Platform responds to a browser keepalive ping. */
export const browserPongSchema = z.object({
  type: z.literal('pong'),
});

/** Platform sends an error to the browser. */
export const browserErrorSchema = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
});

/** All messages that flow from Platform to Browser. */
export const platformToBrowserMessageSchema = z.discriminatedUnion('type', [
  browserAuthSuccessSchema,
  browserAuthFailureSchema,
  browserLogLinesSchema,
  browserOrchLogLinesSchema,
  browserGapSchema,
  browserLogStreamTerminatedSchema,
  browserRunStatusSchema,
  browserRunNewSchema,
  browserJobStatusSchema,
  browserJobNewSchema,
  browserStepStatusSchema,
  browserErrorSchema,
  browserPongSchema,
  browserRunEventSchema,
  browserJobContextSchema,
  browserEventLogPayloadChunkSchema,
]);

// --- Inferred types ---

export type BrowserEventLogPayloadFetch = z.infer<typeof browserEventLogPayloadFetchSchema>;
