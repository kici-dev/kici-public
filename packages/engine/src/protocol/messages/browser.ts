/**
 * Browser-Platform WebSocket protocol schemas.
 *
 * Defines all message types for the browser <-> Platform WS connection:
 * - Browser -> Platform: auth, log subscribe/unsubscribe, status subscribe/unsubscribe
 * - Platform -> Browser: auth response, log lines, gap, run/job/step status, error
 *
 * Follows the same Zod-based pattern as platform-orchestrator.ts and other protocol schemas.
 */
import { z } from 'zod';
import { browserRunEventSchema, browserJobContextSchema } from './run-events.js';
import { browserEventLogPayloadChunkSchema } from './dashboard.js';

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

/** Browser subscribes to org-level status updates (run/job/step status changes). */
export const browserStatusSubscribeSchema = z.object({
  type: z.literal('status.subscribe'),
  /** Scope of status subscription. Currently only 'org' is supported. */
  scope: z.literal('org'),
  /** The org to subscribe to. Required so the Platform can route updates for the correct org. */
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
 * Browser asks Platform to begin streaming the body of an event-log delivery.
 *
 * The dashboard generates `requestId` (uuid) per fetch so it can correlate
 * incoming chunks. `orgId` is NOT taken from the wire — Platform's
 * browser-handler resolves the run's owning org from the user's membership
 * and gates on `event_log:read_payload`. Same trust model as the existing
 * `log.subscribe` message.
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
  /** Total line count (cumulative offset so browser knows position). */
  lineCount: z.number(),
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
 * Reason a live-log stream was terminated by the Platform.
 *
 * Currently only `plan_limit_live_log_minutes` (daily live-log minute cap
 * exceeded). New reasons land here as the Platform grows more enforcement
 * surfaces (e.g. retention, manual operator kick).
 */
export const browserLogStreamTerminatedReason = z.enum(['plan_limit_live_log_minutes']);
export type BrowserLogStreamTerminatedReason = z.infer<typeof browserLogStreamTerminatedReason>;

/**
 * Platform notifies browser that a live-log stream has been terminated.
 *
 * Sent in two cases:
 * 1. **At subscribe time:** the org is already over the daily live-log
 *    minute cap when the browser sends `log.subscribe`. The Platform
 *    sends `log.stream.terminated` and never registers the subscription.
 * 2. **Mid-stream:** the periodic metering tick observed the org just
 *    crossed the cap. The Platform sends `log.stream.terminated` to all
 *    active log subscribers in that org and unregisters them.
 *
 * Browsers should display the upgrade prompt and NOT auto-resubscribe.
 */
export const browserLogStreamTerminatedSchema = z.object({
  type: z.literal('log.stream.terminated'),
  runId: z.string(),
  jobId: z.string(),
  stepIndex: z.number(),
  reason: browserLogStreamTerminatedReason,
  /** Optional human-readable message for the dashboard to display. */
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
