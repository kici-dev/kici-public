import { z } from 'zod';
import { CheckMode, CheckStepOutcome } from '../../check-mode.js';
import { actorPrincipalSchema } from './actor.js';
import { kiciBundleSchema } from '../../provenance/bundle.js';
import {
  dashboardAccessLogListRequestSchema,
  dashboardAccessLogListResponseSchema,
} from './access-log.js';
import { dashboardOrchLogsRequestSchema, dashboardOrchLogsResponseSchema } from './run-events.js';
import { EventLogStatus, PayloadOmittedReason, EventLogSource } from './event-log.js';
import { initFailureSchema } from './execution-status.js';
import { SourceSubtype } from './source-registration.js';
import { ScalerBackendType } from '../../scaler/scaler-backend-type.js';
import { HoldScope, ApprovalDecision, approverClauseSchema } from '../../approval/types.js';
import { IfFailedPolicy } from '../../trigger/types.js';
import {
  globalWorkflowsGetRequestSchema,
  globalWorkflowsUpdateRequestSchema,
  globalWorkflowsGetResponseSchema,
  globalWorkflowsUpdateResponseSchema,
} from './dashboard-global-workflows.js';

// --- Dashboard REST-over-WS protocol messages ---
//
// These messages enable the Platform dashboard to query run details and step logs
// from the orchestrator via the existing Platform-orchestrator WebSocket connection.
// Platform acts as a proxy: receives REST request from dashboard, sends WS request
// to the correct orchestrator, correlates the response by requestId, returns to dashboard.

// --- Platform -> Orchestrator: request messages ---

/** Request full run detail (jobs + steps) from orchestrator. */
export const dashboardRunDetailRequestSchema = z.object({
  type: z.literal('dashboard.run.detail'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  runId: z.string(),
});

/** Request step logs from orchestrator. */
export const dashboardStepLogsRequestSchema = z.object({
  type: z.literal('dashboard.step.logs'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  runId: z.string(),
  jobId: z.string(),
  stepIndex: z.number(),
});

// --- Orchestrator -> Platform: response messages ---

/** Step detail within a job response. */
const dashboardStepDetailSchema = z.object({
  stepIndex: z.number(),
  stepName: z.string(),
  status: z.string(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  durationMs: z.number().nullable(),
  exitCode: z.number().nullable(),
  errorMessage: z.string().nullable(),
  /** Step type (e.g., 'hook:onCancel', 'hook:cleanup'). Omitted for regular steps. */
  stepType: z.string().optional(),
  /** Secret context names accessed by this step. null = tracking not available. */
  secretsAccessed: z.array(z.string()).nullable().optional(),
  /** Idempotent per-step outcome under a check mode. null/absent for non-check runs. */
  checkOutcome: CheckStepOutcome.nullable().optional(),
  /** Human-readable drift summary, present when the step reported drift. */
  driftSummary: z.string().nullable().optional(),
});

/** Job detail within a run detail response. */
export const dashboardJobDetailSchema = z.object({
  jobId: z.string(),
  jobName: z.string(),
  status: z.string(),
  matrixValues: z.record(z.string(), z.unknown()).nullable(),
  /** Base (logical) job name for a fan-out child; null for non-fanned jobs. */
  baseJobName: z.string().nullable().optional(),
  /** Fan-out kind for a child: 'matrix' | 'host'; null for non-fanned jobs. */
  variantKind: z.string().nullable().optional(),
  /** Fan-out label for a child: matrix suffix or hostname; null for non-fanned jobs. */
  variantLabel: z.string().nullable().optional(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  durationMs: z.number().nullable(),
  agentId: z.string().nullable(),
  orchestratorId: z.string().nullable().optional(),
  errorMessage: z.string().nullable(),
  /** Labels used for agent routing (e.g. ["kici:os:linux", "kici:arch:x64"]). */
  runsOnLabels: z.array(z.string()).nullable().optional(),
  /** Aggregated step outputs (step-keyed map). Present when job completed successfully with outputs. */
  outputs: z.record(z.string(), z.record(z.string(), z.unknown())).nullable().optional(),
  /** Secret output key names produced by this job (values are NOT included -- display masked). */
  secretOutputKeys: z.array(z.string()).nullable().optional(),
  /**
   * Structured init-failure signal for jobs that never started. Presence means
   * the job is a synthetic `rejected-*` or `init-failed-*` row; status will be 'failed'.
   */
  initFailure: initFailureSchema.optional(),
  /**
   * Upstream dependency edges for this job (one entry per `needs` declaration),
   * resolved by the orchestrator from execution_job_needs. `upstreamName` is the
   * upstream job name; `ifFailed` is the per-edge failure policy. null/absent when
   * the job has no upstreams.
   */
  needs: z
    .array(
      z.object({
        upstreamName: z.string(),
        ifFailed: IfFailedPolicy,
      }),
    )
    .nullable()
    .optional(),
  steps: z.array(dashboardStepDetailSchema),
});

/** Trust context from orchestrator execution_runs (populated for PR-triggered runs). */
const trustContextSchema = z.object({
  trustTier: z.enum(['trusted', 'known', 'unknown']).nullable(),
  lockFileSource: z.enum(['head', 'base']).nullable(),
  contributorUsername: z.string().nullable(),
});

/** Response with full run detail (correlates to dashboard.run.detail). */
export const dashboardRunDetailResponseSchema = z.object({
  type: z.literal('dashboard.run.detail.response'),
  requestId: z.string(),
  jobs: z.array(dashboardJobDetailSchema),
  trustContext: trustContextSchema.optional(),
  /**
   * Structured init-failure signal for runs that never started. Set when the
   * run row was created via recordInitFailureRun() on the orchestrator side.
   */
  initFailure: initFailureSchema.optional(),
  error: z.string().optional(),
});

/** Response with step log lines (correlates to dashboard.step.logs). */
export const dashboardStepLogsResponseSchema = z.object({
  type: z.literal('dashboard.step.logs.response'),
  requestId: z.string(),
  lines: z.array(z.string()),
  totalLines: z.number(),
  error: z.string().optional(),
});

// --- Attestations list request/response (REST-over-WS proxy) ---
//
// Build-provenance attestations for a run. Like the step-logs read, this is
// served by the customer orchestrator (which inlines each stored bundle from
// object storage) and access-logged there; Platform proxies the request and
// augments the response with the provenance trust root (issuer + JWKS URI)
// from its own `oidcIssuer` config so the dashboard can verify each bundle
// client-side.

/** Request the build-provenance attestations for a run. */
export const dashboardAttestationsListRequestSchema = z.object({
  type: z.literal('dashboard.attestations.list'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  runId: z.string(),
});
export type DashboardAttestationsListRequest = z.infer<
  typeof dashboardAttestationsListRequestSchema
>;

/**
 * Single attestation in the list response, with its bundle inlined from object
 * storage so the dashboard verifies it without a second fetch. The bundle is a
 * KiCI Mode-A bundle (`@kici-dev/engine/provenance/bundle`).
 */
export const attestationListItemSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  jobName: z.string().nullable(),
  subjectName: z.string(),
  subjectDigest: z.string(),
  mode: z.string(),
  mediaType: z.string(),
  createdAt: z.string(),
  bundle: kiciBundleSchema,
});
export type AttestationListItem = z.infer<typeof attestationListItemSchema>;

/** Response with the run's attestations (correlates to dashboard.attestations.list). */
export const dashboardAttestationsListResponseSchema = z.object({
  type: z.literal('dashboard.attestations.list.response'),
  requestId: z.string(),
  attestations: z.array(attestationListItemSchema),
  error: z.string().optional(),
});
export type DashboardAttestationsListResponse = z.infer<
  typeof dashboardAttestationsListResponseSchema
>;

// --- Run list request/response (REST-over-WS proxy) ---
//
// Operator-console read of the orchestrator's run list. Like the run-detail
// read, this is served by the customer orchestrator and access-logged there;
// Platform only proxies the request to the right orchestrator connection.

/**
 * Run-summary projection from the orchestrator's execution_runs table.
 *
 * The required fields (`runId` / `routingKey` / `status`) are always present.
 * Every other field is optional: the orchestrator omits what it cannot
 * supply, and the customer runs page degrades a missing field to '—'.
 */
export const dashboardRunSummarySchema = z.object({
  runId: z.string(),
  routingKey: z.string(),
  status: z.string(),
  repoIdentifier: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  trigger: z.string().optional(),
  // enriched (optional — orchestrator omits what it lacks; page degrades to '—'):
  workflowName: z.string().optional(),
  sha: z.string().optional(),
  ref: z.string().optional(),
  triggerEvent: z.string().optional(),
  commitMessage: z.string().optional(),
  jobCount: z.number().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  durationMs: z.number().optional(),
  parentRunId: z.string().optional(),
  originalRunId: z.string().optional(),
  triggeredBy: z.string().optional(),
  cancelledBy: z.string().optional(),
  failureReason: z.string().optional(),
  hadCompileJob: z.boolean().optional(),
  compileJobId: z.string().optional(),
  source: z
    .object({
      routingKey: z.string(),
      name: z.string().nullable(),
      subtype: z.string(),
      provider: z.string(),
    })
    .optional(),
});
export type DashboardRunSummary = z.infer<typeof dashboardRunSummarySchema>;

/** Request a page of run summaries from the orchestrator. */
export const dashboardRunsListRequestSchema = z.object({
  type: z.literal('dashboard.runs.list'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  /** Page size (1-200). Bounds protect the orchestrator from unbounded reads. */
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});
export type DashboardRunsListRequest = z.infer<typeof dashboardRunsListRequestSchema>;

/** Response with the page of run summaries + next-page cursor. */
export const dashboardRunsListResponseSchema = z.object({
  type: z.literal('dashboard.runs.list.response'),
  requestId: z.string(),
  runs: z.array(dashboardRunSummarySchema),
  nextCursor: z.string().optional(),
  error: z.string().optional(),
});
export type DashboardRunsListResponse = z.infer<typeof dashboardRunsListResponseSchema>;

// --- Run filters request/response ---
//
// Distinct-value filter options the customer runs page renders in its filter
// controls (statuses / workflows / branches / repositories / triggerTypes /
// sources). Served by the customer orchestrator and access-logged there;
// Platform only proxies the request to the right orchestrator connection.

/** Request the distinct filter-option values from the orchestrator. */
export const dashboardRunsFiltersRequestSchema = z.object({
  type: z.literal('dashboard.runs.filters'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
});
export type DashboardRunsFiltersRequest = z.infer<typeof dashboardRunsFiltersRequestSchema>;

/** Response with the distinct filter-option values. */
export const dashboardRunsFiltersResponseSchema = z.object({
  type: z.literal('dashboard.runs.filters.response'),
  requestId: z.string(),
  statuses: z.array(z.string()),
  workflows: z.array(z.string()),
  branches: z.array(z.string()),
  repositories: z.array(z.string()),
  triggerTypes: z.array(z.string()),
  sources: z.array(z.object({ routingKey: z.string(), name: z.string().nullable() })),
  error: z.string().optional(),
});
export type DashboardRunsFiltersResponse = z.infer<typeof dashboardRunsFiltersResponseSchema>;

// --- Sources list request/response ---

/** Minimal source-summary projection from the orchestrator's sources tables. */
export const dashboardSourceSummarySchema = z.object({
  routingKey: z.string(),
  name: z.string().nullable(),
  provider: z.string(),
  subtype: SourceSubtype,
  enabled: z.boolean(),
  createdAt: z.string(),
});
export type DashboardSourceSummary = z.infer<typeof dashboardSourceSummarySchema>;

/** Request a page of source summaries from the orchestrator. */
export const dashboardSourcesListRequestSchema = z.object({
  type: z.literal('dashboard.sources.list'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  /** Page size (1-200). Bounds protect the orchestrator from unbounded reads. */
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});
export type DashboardSourcesListRequest = z.infer<typeof dashboardSourcesListRequestSchema>;

/** Response with the page of source summaries + next-page cursor. */
export const dashboardSourcesListResponseSchema = z.object({
  type: z.literal('dashboard.sources.list.response'),
  requestId: z.string(),
  sources: z.array(dashboardSourceSummarySchema),
  nextCursor: z.string().optional(),
  error: z.string().optional(),
});
export type DashboardSourcesListResponse = z.infer<typeof dashboardSourcesListResponseSchema>;

// --- Re-run request/response ---

/** Request to re-run a completed run. */
export const runRerunRequestSchema = z.object({
  type: z.literal('run.rerun.request'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  runId: z.string(),
  /**
   * Phase F — Platform forwards the original run's `routing_key` so the
   * orchestrator can probe its cold-store under the right tenant prefix
   * when the run is missing from PG. Optional for backwards compatibility
   * with older Platform versions in mixed deploys; if absent, the
   * orchestrator skips the cold-store probe and surfaces the legacy
   * `runArchivedNotRerunnable` / "Run not found" branches.
   */
  routingKey: z.string().optional(),
});

/** Response to a re-run request. */
const runRerunResponseSchema = z.object({
  type: z.literal('run.rerun.response'),
  requestId: z.string(),
  newRunId: z.string().optional(),
  error: z.string().optional(),
  /**
   * Stable, machine-readable error code. Set when the orchestrator
   * needs to communicate a specific failure shape to the Platform proxy
   * (e.g. `runArchivedNotRerunnable` → HTTP 410). Free-text `error`
   * remains the human message.
   */
  errorCode: z.string().optional(),
});

// --- Manual schedule request/response ---

/** Request to manually trigger a cron-scheduled workflow. */
export const manualScheduleRequestSchema = z.object({
  type: z.literal('run.manual_schedule.request'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  registrationId: z.string(),
});

/** Response to a manual schedule trigger request. */
const manualScheduleResponseSchema = z.object({
  type: z.literal('run.manual_schedule.response'),
  requestId: z.string(),
  newRunId: z.string().optional(),
  error: z.string().optional(),
});

// --- Cancel request/response ---

/** Request to cancel a running run. */
export const runCancelRequestSchema = z.object({
  type: z.literal('run.cancel.request'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  runId: z.string(),
  /** When true, force-cancel immediately without waiting for hooks. */
  force: z.boolean().optional(),
});

/** Response to a cancel request. */
const runCancelResponseSchema = z.object({
  type: z.literal('run.cancel.response'),
  requestId: z.string(),
  cancelledJobs: z.number().optional(),
  error: z.string().optional(),
});

// --- Payload request/response (REST-over-WS proxy) ---

/** Request the original webhook payload for a run. */
export const dashboardPayloadRequestSchema = z.object({
  type: z.literal('dashboard.payload'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  runId: z.string(),
});

/** Response with the original webhook payload. */
const dashboardPayloadResponseSchema = z.object({
  type: z.literal('dashboard.payload.response'),
  requestId: z.string(),
  payload: z.unknown().optional(),
  error: z.string().optional(),
});

// --- Lineage API response schema (Platform DB-direct endpoint) ---

/** Single run entry in a lineage chain. */
const runLineageSchema = z.object({
  runId: z.string(),
  status: z.string(),
  createdAt: z.coerce.string(),
});

/** Lineage response containing all re-runs of a root run. */
export const runLineageResponseSchema = z.object({
  reruns: z.array(runLineageSchema),
});

// --- Event log request/response (REST-over-WS proxy) ---
//
// Inbound webhook delivery log: list + detail. Joined server-side by
// Platform with its own `event_log` projection on (org_id, delivery_id);
// these schemas describe the orchestrator's half of the projection.
//
// The detail response carries the payload INLINE (the orchestrator fetches
// it from its LogStorage adapter using the row's payload_key — the dashboard
// never sees the raw object-storage key). Oversized / failed-upload payloads
// surface as `payloadOmitted: true` with a reason; callers render an empty
// state in that case.

/** Single delivery row in the list response (orchestrator-side projection). */
export const eventLogListItemSchema = z.object({
  deliveryId: z.string(),
  routingKey: z.string(),
  event: z.string(),
  action: z.string().nullable(),
  source: EventLogSource,
  provider: z.string(),
  repoIdentifier: z.string().nullable(),
  ref: z.string().nullable(),
  status: EventLogStatus,
  matchedCount: z.number(),
  runId: z.string().nullable(),
  errorMessage: z.string().nullable(),
  receivedAt: z.string(),
  payloadOmitted: z.boolean(),
  payloadOmittedReason: PayloadOmittedReason.nullable(),
  payloadSizeBytes: z.number(),
  payloadHash: z.string(),
});

/** Request a paginated list of inbound webhook deliveries from the orchestrator. */
export const dashboardEventLogListRequestSchema = z.object({
  type: z.literal('dashboard.event-log.list'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  /** Tenant ID -- the orchestrator scopes by org_id, NOT routing key. */
  orgId: z.string(),
  /** Optional filters. */
  routingKey: z.string().optional(),
  event: z.string().optional(),
  status: EventLogStatus.optional(),
  /** ISO timestamp lower bound (inclusive). */
  fromTimestamp: z.string().optional(),
  /** ISO timestamp upper bound (exclusive). */
  toTimestamp: z.string().optional(),
  /** Free-text delivery_id substring filter. */
  deliveryId: z.string().optional(),
  /** Page size (default 50, max 200). */
  limit: z.number().optional(),
  /** Cursor returned by the previous response. Server-defined opaque format
   *  (encodes received_at + id for stable pagination on ties). */
  cursor: z.string().optional(),
});

/** Response with the page of deliveries + next-page cursor (null = end). */
const dashboardEventLogListResponseSchema = z.object({
  type: z.literal('dashboard.event-log.list.response'),
  requestId: z.string(),
  items: z.array(eventLogListItemSchema).optional(),
  nextCursor: z.string().nullable().optional(),
  error: z.string().optional(),
});

/** Request the full detail (incl. payload) of a single delivery. */
export const dashboardEventLogDetailRequestSchema = z.object({
  type: z.literal('dashboard.event-log.detail'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  orgId: z.string(),
  deliveryId: z.string(),
  /**
   * Phase E cold-store hint: when the Platform side has resurrected the
   * archived `event_log` row, it forwards the `routing_key` so the
   * orchestrator can scope its own cold-store fetch to a single tenant
   * prefix instead of scanning every routing_key for the org.
   */
  routingKey: z.string().optional(),
});

/** Response with the orchestrator-side projection.
 *  The webhook body is NOT included here — it streams over the chunked
 *  transport (see `dashboardEventLogPayloadStreamRequestSchema`). When
 *  `payloadOmitted=true` the `payloadOmittedReason` field on the item carries
 *  the cause; the dashboard renders the empty state without issuing a
 *  payload-stream request in that case. */
const dashboardEventLogDetailResponseSchema = z.object({
  type: z.literal('dashboard.event-log.detail.response'),
  requestId: z.string(),
  item: eventLogListItemSchema.optional(),
  error: z.string().optional(),
});

// --- Event-log payload chunked streaming (REST-over-WS) ---
//
// The dashboard fetches the webhook body via a separate chunked-WS path so
// Platform never buffers the full payload. Three message types coordinate
// the flow:
//
//   - `event-log.payload.fetch` (browser → Platform browser-handler)
//     Browser asks Platform to begin streaming; Platform validates org
//     membership + `event_log:read_payload` permission, resolves the
//     orchestrator connection, registers a pending stream, and forwards
//     the request upstream.
//
//   - `dashboard.event-log.payload.stream` (Platform → orchestrator)
//     Platform asks the orchestrator to read its `event_log` row,
//     decompress the body, and stream it as chunks. Cross-tenant binding
//     (mirroring `DashboardProxy`'s source-binding rule) ensures the
//     orchestrator's reply chunks must come from the connection the
//     request was sent to.
//
//   - `dashboard.event-log.payload.chunk` (orchestrator → Platform) +
//     `event-log.payload.chunk` (Platform → browser)
//     One chunk per slice. Platform forwards each into the originating
//     browser WebSocket as it arrives.

/**
 * Reasons a chunked event-log payload stream may terminate without a body.
 * The terminal chunk carries `isLast=true` plus one of these codes in
 * `error`. A successful stream ends with `isLast=true` and no `error`.
 *
 * - `payload_unavailable`: orchestrator row exists but `payload_omitted=true`
 *   or `payload_key=null`. The dashboard renders the existing empty state
 *   (size cap exceeded / object-storage write failed at ingress).
 * - `not_found`: no orchestrator row matched the deliveryId. The dashboard
 *   shows the existing "delivery not found" message.
 * - `read_failed`: orchestrator could not read or gunzip the body.
 * - `forbidden`: caller lacks `event_log:read_payload`. Platform synthesizes
 *   this code on its side and never forwards the upstream request.
 * - `orch_stream_timeout`: Platform observed no inter-chunk activity for
 *   `KICI_EVENT_LOG_PAYLOAD_STREAM_IDLE_MS` and synthesized a terminal
 *   chunk to evict the stream entry.
 * - `orchestrator_unavailable`: Platform could not select an orchestrator
 *   connection for the request (synthesized on Platform side).
 */
export const EventLogPayloadStreamError = z.enum([
  'payload_unavailable',
  'not_found',
  'read_failed',
  'forbidden',
  'orch_stream_timeout',
  'orchestrator_unavailable',
]);
export type EventLogPayloadStreamError = z.infer<typeof EventLogPayloadStreamError>;

/** Platform → orchestrator: begin streaming the body for a delivery. */
export const dashboardEventLogPayloadStreamRequestSchema = z.object({
  type: z.literal('dashboard.event-log.payload.stream'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  orgId: z.string(),
  deliveryId: z.string(),
  /**
   * Phase E cold-store hint: when Platform has resurrected the archived
   * `event_log` row, it forwards `routing_key` so the orchestrator can scope
   * its own cold-store fetch to a single tenant prefix instead of scanning
   * every routing_key for the org. Mirrors `dashboardEventLogDetailRequestSchema`.
   */
  routingKey: z.string().optional(),
});

/**
 * Orchestrator → Platform / Platform → browser: one chunk of the body.
 *
 * - `seq` is 0-based and monotonic. The orchestrator emits chunks strictly
 *   in order on a single WS connection, which guarantees in-order delivery.
 * - `data` is base64-encoded UTF-8 bytes. Base64 sidesteps mid-multibyte
 *   slicing concerns when chunking by raw byte count.
 * - `isLast=true` ends the stream. The terminal chunk may carry an `error`
 *   code (and `data` is empty) when streaming aborted before sending any
 *   body bytes; or it may carry the final body slice (with `error`
 *   undefined).
 * - `totalBytes` is included only on `seq=0` so the dashboard can render
 *   "N KB / M KB" progress.
 */
export const dashboardEventLogPayloadChunkSchema = z.object({
  type: z.literal('dashboard.event-log.payload.chunk'),
  requestId: z.string(),
  seq: z.number().int().min(0),
  data: z.string(),
  isLast: z.boolean(),
  error: EventLogPayloadStreamError.optional(),
  totalBytes: z.number().int().min(0).optional(),
});

/**
 * Platform → browser: forwarded chunk. Same shape as the orchestrator-side
 * message, just renamed to keep the `dashboard.*` family for the
 * Platform↔orchestrator hop and align with the browser-facing `log.lines` /
 * `run.status` naming convention.
 */
export const browserEventLogPayloadChunkSchema = z.object({
  type: z.literal('event-log.payload.chunk'),
  requestId: z.string(),
  seq: z.number().int().min(0),
  data: z.string(),
  isLast: z.boolean(),
  error: EventLogPayloadStreamError.optional(),
  totalBytes: z.number().int().min(0).optional(),
});

// --- Event DLQ request/response (REST-over-WS proxy) ---
//
// Per-org view of the orchestrator-local dead-letter queue. The DLQ holds
// custom internal events whose dispatch attempts exhausted the retry budget
// (or that hit a non-retryable error). The dashboard page calls list / count
// for the read surface, retry / discard for the write surface; the orch
// records an access_log row per call using the user actor.

/** Single DLQ event in the list response. */
export const dashboardEventDlqListItemSchema = z.object({
  id: z.string(),
  eventName: z.string(),
  payload: z.record(z.string(), z.unknown()),
  sourceRepo: z.string().nullable(),
  sourceRoutingKey: z.string().nullable(),
  sourceRunId: z.string().nullable(),
  sourceJobId: z.string().nullable(),
  chainDepth: z.number(),
  createdAt: z.string(),
  dlqAt: z.string().nullable(),
  dlqReason: z.string().nullable(),
  attempts: z.number(),
  lastError: z.string().nullable(),
});

/** Request a paginated list of DLQ events from the orchestrator. */
export const dashboardEventDlqListRequestSchema = z.object({
  type: z.literal('dashboard.event-dlq.list'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  /** Tenant ID -- the orchestrator scopes by org_id, not routing key. */
  orgId: z.string(),
  /** Page size (default 50, max 200). */
  limit: z.number().optional(),
  /** Cursor: ISO `dlq_at` of the last row on the previous page. */
  before: z.string().optional(),
});

const dashboardEventDlqListResponseSchema = z.object({
  type: z.literal('dashboard.event-dlq.list.response'),
  requestId: z.string(),
  items: z.array(dashboardEventDlqListItemSchema).optional(),
  nextCursor: z.string().nullable().optional(),
  error: z.string().optional(),
});

/** Request the DLQ depth for the sidebar badge. */
export const dashboardEventDlqCountRequestSchema = z.object({
  type: z.literal('dashboard.event-dlq.count'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  orgId: z.string(),
});

const dashboardEventDlqCountResponseSchema = z.object({
  type: z.literal('dashboard.event-dlq.count.response'),
  requestId: z.string(),
  total: z.number().optional(),
  error: z.string().optional(),
});

/** Clear DLQ flag + re-publish for retry. */
export const dashboardEventDlqRetryRequestSchema = z.object({
  type: z.literal('dashboard.event-dlq.retry'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  orgId: z.string(),
  eventId: z.string(),
});

const dashboardEventDlqRetryResponseSchema = z.object({
  type: z.literal('dashboard.event-dlq.retry.response'),
  requestId: z.string(),
  retried: z.boolean().optional(),
  error: z.string().optional(),
});

/** Permanently delete the DLQ row. */
export const dashboardEventDlqDiscardRequestSchema = z.object({
  type: z.literal('dashboard.event-dlq.discard'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  orgId: z.string(),
  eventId: z.string(),
});

const dashboardEventDlqDiscardResponseSchema = z.object({
  type: z.literal('dashboard.event-dlq.discard.response'),
  requestId: z.string(),
  discarded: z.boolean().optional(),
  error: z.string().optional(),
});

// --- Environment CRUD request/response (REST-over-WS proxy) ---

const environmentTypeSchema = z.enum(['fixed', 'glob']);
const concurrencyStrategySchema = z.enum(['queue', 'cancel-pending']);

// -- Environments --

/** List all environments for the org. */
export const envListRequestSchema = z.object({
  type: z.literal('dashboard.environments.list'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  /**
   * When true, each returned environment carries its reachable secret key
   * names (never values) in `secretKeys`. Used by the developer CLI's
   * `kici secrets list` / `kici types` commands.
   */
  includeSecrets: z.boolean().optional(),
  /**
   * Target org the read must be scoped to, carried per-request by the Platform
   * (the validated `:orgId` path param). The orchestrator honors this over its
   * static connection-level org so a Platform-first `kici run remote` org —
   * anchored only by `remote_sources` — sees its own environments even when the
   * orchestrator's connection also serves a webhook source for a different org.
   * Absent on the legacy customer-dashboard path, where the connection org is
   * already the request org.
   */
  orgId: z.string().optional(),
});

const envListResponseSchema = z.object({
  type: z.literal('dashboard.environments.list.response'),
  requestId: z.string(),
  environments: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        type: environmentTypeSchema,
        globPattern: z.string().nullable(),
        enabled: z.boolean(),
        allowLocalExecution: z.boolean(),
        createdAt: z.coerce.string(),
        updatedAt: z.coerce.string(),
        /**
         * Distinct secret key names reachable from this environment's scope
         * bindings (never values). Present only when the request set
         * `includeSecrets: true`.
         */
        secretKeys: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  error: z.string().optional(),
});

/** Get a single environment by ID. */
export const envGetRequestSchema = z.object({
  type: z.literal('dashboard.environments.get'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  environmentId: z.string(),
});

const envGetResponseSchema = z.object({
  type: z.literal('dashboard.environments.get.response'),
  requestId: z.string(),
  environment: z
    .object({
      id: z.string(),
      name: z.string(),
      type: environmentTypeSchema,
      globPattern: z.string().nullable(),
      branchRestrictions: z.array(z.string()).nullable(),
      concurrencyLimit: z.number().nullable(),
      concurrencyStrategy: concurrencyStrategySchema.nullable(),
      requiredReviewers: z.number().nullable(),
      waitTimerSeconds: z.number().nullable(),
      holdExpirySeconds: z.number().nullable(),
      enabled: z.boolean(),
      allowLocalExecution: z.boolean(),
      createdAt: z.coerce.string(),
      updatedAt: z.coerce.string(),
    })
    .optional(),
  error: z.string().optional(),
});

/** Create a new environment. */
export const envCreateRequestSchema = z.object({
  type: z.literal('dashboard.environments.create'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  name: z.string(),
  envType: environmentTypeSchema,
  globPattern: z.string().optional(),
  branchRestrictions: z.array(z.string()).optional(),
  concurrencyLimit: z.number().optional(),
  concurrencyStrategy: concurrencyStrategySchema.optional(),
  requiredReviewers: z.number().optional(),
  waitTimerSeconds: z.number().optional(),
  holdExpirySeconds: z.number().optional(),
  enabled: z.boolean().optional(),
});

const envCreateResponseSchema = z.object({
  type: z.literal('dashboard.environments.create.response'),
  requestId: z.string(),
  environmentId: z.string().optional(),
  error: z.string().optional(),
});

/** Update an existing environment. */
export const envUpdateRequestSchema = z.object({
  type: z.literal('dashboard.environments.update'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  environmentId: z.string(),
  updates: z.object({
    name: z.string().optional(),
    envType: environmentTypeSchema.optional(),
    globPattern: z.string().nullable().optional(),
    branchRestrictions: z.array(z.string()).nullable().optional(),
    concurrencyLimit: z.number().nullable().optional(),
    concurrencyStrategy: concurrencyStrategySchema.nullable().optional(),
    requiredReviewers: z.number().nullable().optional(),
    waitTimerSeconds: z.number().nullable().optional(),
    holdExpirySeconds: z.number().nullable().optional(),
    enabled: z.boolean().optional(),
  }),
});

const envUpdateResponseSchema = z.object({
  type: z.literal('dashboard.environments.update.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

/** Set an environment's test-run access flag (allowLocalExecution). */
export const envTestAccessSetRequestSchema = z.object({
  type: z.literal('dashboard.environments.test_access.set'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  environmentId: z.string(),
  allowLocalExecution: z.boolean(),
});

const envTestAccessSetResponseSchema = z.object({
  type: z.literal('dashboard.environments.test_access.set.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

/** Delete an environment. */
export const envDeleteRequestSchema = z.object({
  type: z.literal('dashboard.environments.delete'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  environmentId: z.string(),
});

/**
 * Machine-readable codes for environment-delete rejections.
 *
 * Three-category response taxonomy on dashboard responses, each mapped to a
 * distinct HTTP status by the Platform proxy: a bare free-text `error` is the
 * human message and maps to 400; a missing result (e.g. environment not found)
 * maps to 404; an `errorCode` flags a specific business rejection mapped to a
 * non-400/404 status — here `pending_held_runs` → 409. The sibling precedent is
 * the rerun response's `errorCode` (`runArchivedNotRerunnable` → 410) above.
 */
export const EnvDeleteErrorCode = z.enum(['pending_held_runs']);
export type EnvDeleteErrorCode = z.infer<typeof EnvDeleteErrorCode>;

const envDeleteResponseSchema = z.object({
  type: z.literal('dashboard.environments.delete.response'),
  requestId: z.string(),
  error: z.string().optional(),
  errorCode: EnvDeleteErrorCode.optional(),
});

// -- Environment variables --

/** List variables for an environment. */
export const envVarsListRequestSchema = z.object({
  type: z.literal('dashboard.environments.variables.list'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  environmentId: z.string(),
});

const envVarsListResponseSchema = z.object({
  type: z.literal('dashboard.environments.variables.list.response'),
  requestId: z.string(),
  variables: z
    .array(
      z.object({
        key: z.string(),
        value: z.string(),
        locked: z.boolean(),
      }),
    )
    .optional(),
  error: z.string().optional(),
});

/** Set (create or update) a variable on an environment. */
export const envVarSetRequestSchema = z.object({
  type: z.literal('dashboard.environments.variables.set'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  environmentId: z.string(),
  key: z.string(),
  value: z.string(),
  locked: z.boolean().optional(),
});

const envVarSetResponseSchema = z.object({
  type: z.literal('dashboard.environments.variables.set.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

/** Delete a variable from an environment. */
export const envVarDeleteRequestSchema = z.object({
  type: z.literal('dashboard.environments.variables.delete'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  environmentId: z.string(),
  key: z.string(),
});

const envVarDeleteResponseSchema = z.object({
  type: z.literal('dashboard.environments.variables.delete.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

// -- Source overrides --

/** List source overrides for an environment + routing key. */
export const envSourceOverridesListRequestSchema = z.object({
  type: z.literal('dashboard.environments.source-overrides.list'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  environmentId: z.string(),
  routingKey: z.string(),
});

const envSourceOverridesListResponseSchema = z.object({
  type: z.literal('dashboard.environments.source-overrides.list.response'),
  requestId: z.string(),
  overrides: z
    .array(
      z.object({
        key: z.string(),
        value: z.string(),
      }),
    )
    .optional(),
  error: z.string().optional(),
});

/** Set a source override variable. */
export const envSourceOverrideSetRequestSchema = z.object({
  type: z.literal('dashboard.environments.source-overrides.set'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  environmentId: z.string(),
  routingKey: z.string(),
  key: z.string(),
  value: z.string(),
});

const envSourceOverrideSetResponseSchema = z.object({
  type: z.literal('dashboard.environments.source-overrides.set.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

/** Delete a source override variable. */
export const envSourceOverrideDeleteRequestSchema = z.object({
  type: z.literal('dashboard.environments.source-overrides.delete'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  environmentId: z.string(),
  routingKey: z.string(),
  key: z.string(),
});

const envSourceOverrideDeleteResponseSchema = z.object({
  type: z.literal('dashboard.environments.source-overrides.delete.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

// -- Environment bindings --

/** List bindings for an environment. */
export const envBindingsListRequestSchema = z.object({
  type: z.literal('dashboard.environments.bindings.list'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  environmentId: z.string(),
});

const envBindingsListResponseSchema = z.object({
  type: z.literal('dashboard.environments.bindings.list.response'),
  requestId: z.string(),
  scopePatterns: z.array(z.string()).optional(),
  error: z.string().optional(),
});

/** Set bindings (scope patterns) for an environment. */
export const envBindingsSetRequestSchema = z.object({
  type: z.literal('dashboard.environments.bindings.set'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  environmentId: z.string(),
  scopePatterns: z.array(z.string()),
});

const envBindingsSetResponseSchema = z.object({
  type: z.literal('dashboard.environments.bindings.set.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

// -- Scoped secrets --

/** List all scoped secrets for the org. */
export const envSecretsListRequestSchema = z.object({
  type: z.literal('dashboard.environments.secrets.list'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
});

const envSecretsListResponseSchema = z.object({
  type: z.literal('dashboard.environments.secrets.list.response'),
  requestId: z.string(),
  secrets: z
    .array(
      z.object({
        scope: z.string(),
        key: z.string(),
        createdAt: z.coerce.string(),
        updatedAt: z.coerce.string(),
      }),
    )
    .optional(),
  error: z.string().optional(),
});

/** Set (create or update) a scoped secret. */
export const envSecretSetRequestSchema = z.object({
  type: z.literal('dashboard.environments.secrets.set'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  scope: z.string(),
  key: z.string(),
  value: z.string(),
});

const envSecretSetResponseSchema = z.object({
  type: z.literal('dashboard.environments.secrets.set.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

/** Delete a scoped secret. */
export const envSecretDeleteRequestSchema = z.object({
  type: z.literal('dashboard.environments.secrets.delete'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  scope: z.string(),
  key: z.string(),
});

const envSecretDeleteResponseSchema = z.object({
  type: z.literal('dashboard.environments.secrets.delete.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

// -- Scope CRUD --

/** Create an empty scope. */
export const envSecretScopeCreateRequestSchema = z.object({
  type: z.literal('dashboard.environments.secrets.scope.create'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  scope: z.string(),
});

const envSecretScopeCreateResponseSchema = z.object({
  type: z.literal('dashboard.environments.secrets.scope.create.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

/** Rename a scope -- also updates all environment bindings referencing old scope. */
export const envSecretScopeRenameRequestSchema = z.object({
  type: z.literal('dashboard.environments.secrets.scope.rename'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  oldScope: z.string(),
  newScope: z.string(),
});

const envSecretScopeRenameResponseSchema = z.object({
  type: z.literal('dashboard.environments.secrets.scope.rename.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

/** Delete a scope and all its secrets. Also removes environment bindings referencing this scope. */
export const envSecretScopeDeleteRequestSchema = z.object({
  type: z.literal('dashboard.environments.secrets.scope.delete'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  scope: z.string(),
});

const envSecretScopeDeleteResponseSchema = z.object({
  type: z.literal('dashboard.environments.secrets.scope.delete.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

// -- Environment history --

/** Fetch runs that targeted a specific environment. */
export const envHistoryRequestSchema = z.object({
  type: z.literal('dashboard.environments.history'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  environmentName: z.string(),
  limit: z.number().optional(),
  offset: z.number().optional(),
});

const envHistoryResponseSchema = z.object({
  type: z.literal('dashboard.environments.history.response'),
  requestId: z.string(),
  runs: z
    .array(
      z.object({
        id: z.string(),
        runId: z.string(),
        workflowName: z.string(),
        status: z.string(),
        branch: z.string().nullable(),
        commitSha: z.string().nullable(),
        startedAt: z.coerce.string().nullable(),
        completedAt: z.coerce.string().nullable(),
        environment: z.string().nullable(),
      }),
    )
    .optional(),
  error: z.string().optional(),
});

// -- Held runs --

/** Status values for held runs (approval queue). */
export const HeldRunStatus = z.enum(['pending', 'approved', 'rejected', 'expired']);
export type HeldRunStatus = z.infer<typeof HeldRunStatus>;

/** Queue type for held runs. */
export const HeldRunQueueType = z.enum(['environment', 'security']);
export type HeldRunQueueType = z.infer<typeof HeldRunQueueType>;

/** List held runs. */
export const heldRunsListRequestSchema = z.object({
  type: z.literal('dashboard.held-runs.list'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  status: HeldRunStatus.optional(),
  queueType: HeldRunQueueType.optional(),
  runId: z.string().optional(),
});

const heldRunsListResponseSchema = z.object({
  type: z.literal('dashboard.held-runs.list.response'),
  requestId: z.string(),
  heldRuns: z
    .array(
      z.object({
        id: z.string(),
        runId: z.string(),
        // Null once the environment is deleted (held_runs.environment_id is
        // FK ON DELETE SET NULL): terminal hold history outlives its env.
        environmentId: z.string().nullable(),
        environmentName: z.string().nullable(),
        holdType: z.string(),
        queueType: HeldRunQueueType,
        status: HeldRunStatus,
        requestedAt: z.coerce.string(),
        resolvedAt: z.coerce.string().nullable(),
        resolvedBy: z.string().nullable(),
        reason: z.string().nullable(),
        expiresAt: z.coerce.string().nullable(),
        contributorUsername: z.string().nullable().optional(),
        trustTier: z.string().nullable().optional(),
        // Per-element approval fields (job/workflow/step holds). Optional so
        // legacy environment-only holds (which carry no approval requirement)
        // still validate.
        jobId: z.string().optional(),
        holdScope: HoldScope.optional(),
        stepIndex: z.number().nullable().optional(),
        requirement: z
          .object({
            clauses: z.array(approverClauseSchema),
            reason: z.string().nullable().optional(),
          })
          .nullable()
          .optional(),
        decisions: z
          .array(
            z.object({
              approverUserId: z.string(),
              decision: ApprovalDecision,
              clausesSatisfied: z.array(approverClauseSchema).nullable().optional(),
              createdAt: z.coerce.string(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
  error: z.string().optional(),
});

/** Approve a held run. */
export const heldRunApproveRequestSchema = z.object({
  type: z.literal('dashboard.held-runs.approve'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  heldRunId: z.string(),
});

const heldRunApproveResponseSchema = z.object({
  type: z.literal('dashboard.held-runs.approve.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

/** Reject a held run. */
export const heldRunRejectRequestSchema = z.object({
  type: z.literal('dashboard.held-runs.reject'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  heldRunId: z.string(),
  reason: z.string().optional(),
});

const heldRunRejectResponseSchema = z.object({
  type: z.literal('dashboard.held-runs.reject.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

// --- Diagnostics request/response (REST-over-WS proxy) ---

/** Request diagnostics info (orchestrator metadata + agent list) from orchestrator. */
export const dashboardDiagnosticsRequestSchema = z.object({
  type: z.literal('dashboard.diagnostics'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  /** When false or omitted, agents[] is empty and aggregate fields are populated instead. */
  includeAgents: z.boolean().optional(),
});

/** Agent info within the diagnostics response. */
const diagnosticsAgentSchema = z.object({
  agentId: z.string(),
  labels: z.array(z.string()),
  platform: z.string(),
  arch: z.string(),
  activeJobs: z.number(),
  maxConcurrency: z.number(),
  lastHeartbeatAt: z.number(),
  registeredAt: z.number(),
  version: z.string().nullable(),
  // --- Static metadata (from agent.register) ---
  hostname: z.string().nullable().optional(),
  osRelease: z.string().nullable().optional(),
  osVersion: z.string().nullable().optional(),
  totalMemoryMb: z.number().nullable().optional(),
  cpuCount: z.number().nullable().optional(),
  nodeVersion: z.string().nullable().optional(),
  // --- Dynamic metadata (from agent.status) ---
  memoryUsedMb: z.number().nullable().optional(),
  memoryAvailableMb: z.number().nullable().optional(),
  uptimeSeconds: z.number().nullable().optional(),
  // --- Process identity ---
  runningAsUser: z.string().nullable().optional(),
  runningAsUid: z.number().nullable().optional(),
  // --- Scaler association ---
  scalerName: z.string().nullable().optional(),
});

/** Single scaler backend within the diagnostics response. */
const diagnosticsScalerSchema = z.object({
  name: z.string(),
  type: ScalerBackendType,
  maxAgents: z.number(),
  activeAgents: z.number(),
  labelSets: z.array(z.array(z.string())),
  config: z.record(z.string(), z.unknown()).optional(),
  /**
   * The spawning host of this scaler, declared statically by its backend.
   * Populated (with the owning orchestrator instance's hostname) for backends
   * that spawn agents on the host itself — bare-metal, Firecracker, container
   * on a local runtime socket. Omitted for backends that provision elsewhere
   * (remote container runtime, future cloud backends).
   */
  hosts: z.array(z.string()).optional(),
});

/** Agent info within a peer diagnostics entry (subset of full agent schema). */
const diagnosticsPeerAgentSchema = z.object({
  agentId: z.string(),
  labels: z.array(z.string()),
  platform: z.string(),
  arch: z.string(),
  activeJobs: z.number(),
  maxConcurrency: z.number(),
  /** Scaler backend that spawned the agent, or null for static (stateful) agents. */
  scalerName: z.string().nullable().optional(),
});

/** Peer orchestrator reported by coordinator in diagnostics. */
const diagnosticsPeerSchema = z.object({
  instanceId: z.string(),
  role: z.enum(['coordinator', 'worker']),
  connected: z.boolean(),
  lastHeartbeatAt: z.number(),
  draining: z.boolean(),
  agents: z.array(diagnosticsPeerAgentSchema),
  // OS metadata (from peer heartbeats)
  hostname: z.string().optional(),
  osRelease: z.string().optional(),
  totalMemoryMb: z.number().optional(),
  memoryUsedMb: z.number().optional(),
  memoryAvailableMb: z.number().optional(),
  cpuCount: z.number().optional(),
  uptimeSeconds: z.number().optional(),
  nodeVersion: z.string().optional(),
  runningAsUser: z.string().nullable().optional(),
  runningAsUid: z.number().nullable().optional(),
  version: z.string().nullable().optional(),
  scalerCapacity: z
    .array(
      z.object({
        name: z.string().optional(),
        type: z.string().optional(),
        activeCount: z.number(),
        maxAgents: z.number(),
        labelSets: z.array(z.array(z.string())),
        spawnsOnLocalHost: z.boolean().optional(),
      }),
    )
    .optional(),
  dependencyHealth: z
    .array(
      z.object({
        name: z.string(),
        status: z.enum(['pass', 'warn', 'fail']),
        message: z.string().nullable(),
        details: z.record(z.string(), z.unknown()).optional(),
        durationMs: z.number().optional(),
      }),
    )
    .optional(),
  // --- Raft election state (from peer heartbeats) ---
  raftTerm: z.number().optional(),
  raftLeaderId: z.string().nullable().optional(),
});

/** Response with orchestrator metadata and connected agents. */
export const dashboardDiagnosticsResponseSchema = z.object({
  type: z.literal('dashboard.diagnostics.response'),
  requestId: z.string(),
  orchestrator: z.object({
    version: z.string().nullable(),
    mode: z.string().nullable(),
    /** Cluster role: coordinator or worker. Null for non-clustered orchestrators. */
    role: z.enum(['coordinator', 'worker']).nullable().optional(),
    scalerBackends: z.array(z.string()),
    runningJobs: z.number(),
    queuedJobs: z.number(),
    pendingLabelGaps: z.array(z.string()),
    // --- Orchestrator identity and OS metadata ---
    instanceId: z.string().optional(),
    hostname: z.string().nullable().optional(),
    osRelease: z.string().nullable().optional(),
    osVersion: z.string().nullable().optional(),
    totalMemoryMb: z.number().nullable().optional(),
    cpuCount: z.number().nullable().optional(),
    nodeVersion: z.string().nullable().optional(),
    memoryUsedMb: z.number().nullable().optional(),
    memoryAvailableMb: z.number().nullable().optional(),
    uptimeSeconds: z.number().nullable().optional(),
    // --- Process identity ---
    runningAsUser: z.string().nullable().optional(),
    runningAsUid: z.number().nullable().optional(),
    // --- Raft election state ---
    /** Current Raft role: leader, follower, or candidate. Null for non-clustered orchestrators. */
    raftRole: z.enum(['follower', 'candidate', 'leader']).nullable().optional(),
    /** Current Raft term number. Increments with each election. */
    raftTerm: z.number().nullable().optional(),
    /** Instance ID of the current Raft leader. Null if no leader elected. */
    raftLeaderId: z.string().nullable().optional(),
    /** Total number of registered agents (always populated regardless of includeAgents). */
    agentCount: z.number().nullable().optional(),
    /** Number of agents not bound to any scaler. */
    statefulAgentCount: z.number().nullable().optional(),
  }),
  agents: z.array(diagnosticsAgentSchema),
  scalers: z.array(diagnosticsScalerSchema).optional(),
  peers: z.array(diagnosticsPeerSchema).optional(),
  error: z.string().optional(),
});

// --- Scaler capacity request/response (REST-over-WS proxy) ---

/** Request per-scaler capacity info from orchestrator. */
export const dashboardScalerCapacityRequestSchema = z.object({
  type: z.literal('dashboard.scaler.capacity'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
});

/** Single scaler backend capacity info. */
const scalerCapacityItemSchema = z.object({
  scalerType: z.string(),
  name: z.string(),
  activeAgents: z.number(),
  maxAgents: z.number(),
  history: z.array(z.number()),
});

/** Response with per-scaler capacity data. */
export const dashboardScalerCapacityResponseSchema = z.object({
  type: z.literal('dashboard.scaler.capacity.response'),
  requestId: z.string(),
  scalers: z.array(scalerCapacityItemSchema),
  error: z.string().optional(),
});

// --- Scaler agents request/response (on-demand agent loading per scaler) ---

/** Request agents for a specific scaler (or stateful agents when scalerName is null). */
export const dashboardScalerAgentsRequestSchema = z.object({
  type: z.literal('dashboard.scaler.agents'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  scalerName: z.string().nullable(),
});

/** Response with agents for a specific scaler. */
export const dashboardScalerAgentsResponseSchema = z.object({
  type: z.literal('dashboard.scaler.agents.response'),
  requestId: z.string(),
  scalerName: z.string().nullable(),
  agents: z.array(diagnosticsAgentSchema),
  error: z.string().optional(),
});

// --- Registration disable/delete request/response (REST-over-WS proxy) ---

/** Request to disable or enable a workflow registration. */
export const registrationDisableRequestSchema = z.object({
  type: z.literal('dashboard.registration.disable'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  registrationId: z.string(),
  disabled: z.boolean(),
});

/** Response to a registration disable/enable request. */
const registrationDisableResponseSchema = z.object({
  type: z.literal('dashboard.registration.disable.result'),
  requestId: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});

/** Request to delete a workflow registration. */
export const registrationDeleteRequestSchema = z.object({
  type: z.literal('dashboard.registration.delete'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  registrationId: z.string(),
  cancelActiveRuns: z.boolean().optional(),
});

/** Response to a registration delete request. */
const registrationDeleteResponseSchema = z.object({
  type: z.literal('dashboard.registration.delete.result'),
  requestId: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});

// --- Registration list request/response (REST-over-WS proxy) ---

/** Request workflow registrations from orchestrator. */
export const registrationsListRequestSchema = z.object({
  type: z.literal('dashboard.registrations.list'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  triggerType: z.string().optional(),
  repoIdentifier: z.string().optional(),
});

/**
 * Source identity attached to a registration — fed by a batch lookup against
 * the orchestrator-side `sources` and `generic_webhook_sources` tables keyed
 * on `routing_key`. `name` and `subtype` may be null when the source row was
 * deleted but the registration row still exists (rare; the column degrades
 * gracefully to a synthetic `{ routingKey, provider }` derived from the
 * routing key prefix).
 */
const registrationSourceSchema = z.object({
  routingKey: z.string(),
  name: z.string().nullable(),
  subtype: SourceSubtype.nullable(),
  provider: z.string(),
});

/** Single registration item in the list response. */
export const registrationItemSchema = z.object({
  id: z.string(),
  repoIdentifier: z.string(),
  workflowName: z.string(),
  triggerTypes: z.array(z.string()),
  triggers: z.array(z.unknown()),
  lastTriggeredAt: z.string().nullable(),
  nextFireAt: z.string().nullable(),
  sourceRepos: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  disabled: z.boolean().optional(),
  commitSha: z.string().optional(),
  sourceFile: z.string().optional(),
  /**
   * Source identity (routingKey + friendly name + fine-grained subtype +
   * coarse provider). `null` when the registration has no `routing_key`
   * (legacy / global-workflow rows). Mirrors the shape attached to run
   * summaries so the dashboard can reuse the same icon/label helpers.
   */
  source: registrationSourceSchema.nullable().optional(),
});

/** Response with workflow registrations. */
export const registrationsListResponseSchema = z.object({
  type: z.literal('dashboard.registrations.list.response'),
  requestId: z.string(),
  registrations: z.array(registrationItemSchema).optional(),
  registryVersion: z.number(),
  registryUpdatedAt: z.string(),
  error: z.string().optional(),
});

// --- Backend management request/response (REST-over-WS proxy) ---

/** Request to list all secret backends. */
export const backendsListRequestSchema = z.object({
  type: z.literal('dashboard.backends.list'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
});

/** Single backend item in the list response. */
export const backendItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  backendType: z.enum(['pg', 'vault']),
  scopeFilter: z.string(),
  syncIntervalMs: z.number(),
  enabled: z.boolean(),
  healthStatus: z.enum(['healthy', 'degraded', 'unreachable', 'unknown']),
  scopeCount: z.number(),
  lastSyncAt: z.string().nullable(),
  lastSyncError: z.string().nullable(),
  lastHealthCheckAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Response with all secret backends. */
export const backendsListResponseSchema = z.object({
  type: z.literal('dashboard.backends.list.response'),
  requestId: z.string(),
  backends: z.array(backendItemSchema).optional(),
  error: z.string().optional(),
});

/** Request to get a single backend by name. */
export const backendGetRequestSchema = z.object({
  type: z.literal('dashboard.backends.get'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  name: z.string(),
});

/** Response with a single backend. */
export const backendGetResponseSchema = z.object({
  type: z.literal('dashboard.backends.get.response'),
  requestId: z.string(),
  backend: backendItemSchema.optional(),
  error: z.string().optional(),
});

/** Request to sync all backends. */
export const backendsSyncAllRequestSchema = z.object({
  type: z.literal('dashboard.backends.sync'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
});

/** Response to sync all backends. */
export const backendsSyncAllResponseSchema = z.object({
  type: z.literal('dashboard.backends.sync.response'),
  requestId: z.string(),
  results: z.array(z.unknown()).optional(),
  error: z.string().optional(),
});

/** Request to sync a single backend. */
export const backendSyncRequestSchema = z.object({
  type: z.literal('dashboard.backends.sync.one'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  name: z.string(),
});

/** Response to sync a single backend. */
export const backendSyncResponseSchema = z.object({
  type: z.literal('dashboard.backends.sync.one.response'),
  requestId: z.string(),
  synced: z.boolean().optional(),
  scopeCount: z.number().optional(),
  error: z.string().optional(),
});

/** Request to test a named backend connection. */
export const backendTestRequestSchema = z.object({
  type: z.literal('dashboard.backends.test'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  name: z.string(),
});

/** Response to test a backend connection. */
export const backendTestResponseSchema = z.object({
  type: z.literal('dashboard.backends.test.response'),
  requestId: z.string(),
  ok: z.boolean().optional(),
  latencyMs: z.number().optional(),
  error: z.string().optional(),
});

// --- Platform-first `kici run remote` relay (REST-over-WS proxy) ---
//
// The developer CLI (`kici run remote` + companions) reaches a potentially
// hidden orchestrator through the Platform over the same dashboard-proxy WS
// relay. Control-plane messages (upload-init, trigger, status, logs, cancel)
// ride this relay; the overlay tarball itself uploads directly dev→object-store
// via the external presigned URL returned by `test.uploads.init`. Each request
// carries the dev's `actor` (PAT identity), which the orchestrator writes to
// `access_log`.

/** Enum of the five test-relay control message types (request side). */
export const TestRelayType = z.enum([
  'test.relay.uploads.init',
  'test.relay.trigger',
  'test.relay.run.status',
  'test.relay.run.logs',
  'test.relay.cancel',
]);
export type TestRelayType = z.infer<typeof TestRelayType>;

/** Request an external presigned upload URL for the overlay tarball. */
export const testRelayUploadsInitRequestSchema = z.object({
  type: z.literal('test.relay.uploads.init'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  routingKey: z.string(),
  sha: z.string().optional(),
  fileCount: z.number().optional(),
  compressedSize: z.number().optional(),
});
export type TestRelayUploadsInitRequest = z.infer<typeof testRelayUploadsInitRequestSchema>;

/** Response with the external presigned upload URL + ephemeral encryption key. */
export const testRelayUploadsInitResponseSchema = z.object({
  type: z.literal('test.relay.uploads.init.response'),
  requestId: z.string(),
  uploadId: z.string().optional(),
  signedUrl: z.string().optional(),
  publicKey: z.string().optional(),
  expiresIn: z.number().optional(),
  error: z.string().optional(),
});
export type TestRelayUploadsInitResponse = z.infer<typeof testRelayUploadsInitResponseSchema>;

/** Trigger a remote test run (mirrors the orchestrator's TestTriggerInput). */
export const testRelayTriggerRequestSchema = z.object({
  type: z.literal('test.relay.trigger'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  routingKey: z.string(),
  fixtureId: z.string(),
  event: z.object({
    type: z.string(),
    action: z.string().optional(),
    targetBranch: z.string(),
    sourceBranch: z.string().optional(),
    payload: z.record(z.string(), z.unknown()),
    changedFiles: z.array(z.string()).optional(),
  }),
  workflowName: z.string().optional(),
  uploadId: z.string().optional(),
  // The CLI's ephemeral X25519 public key used to encrypt the overlay TARBALL.
  // The orchestrator pairs it with the upload record's stored private key to
  // decrypt the overlay. Distinct from `encryptedSecretsKey` (which keys the
  // CLI-supplied secrets blob, present only when secrets were sent).
  cliPublicKey: z.string().optional(),
  inlineLockFile: z.string().optional(),
  fullRepo: z.boolean().optional(),
  /** Run mode for idempotent steps; relayed onto the dispatch event. Omitted = apply. */
  checkMode: CheckMode.optional(),
  secrets: z.record(z.string(), z.string()).optional(),
  encryptedSecrets: z.string().optional(),
  encryptedSecretsKey: z.string().optional(),
});
export type TestRelayTriggerRequest = z.infer<typeof testRelayTriggerRequestSchema>;

/** Response acknowledging a triggered run. */
export const testRelayTriggerResponseSchema = z.object({
  type: z.literal('test.relay.trigger.response'),
  requestId: z.string(),
  runId: z.string().optional(),
  status: z.enum(['accepted', 'rejected']).optional(),
  reason: z.string().optional(),
  jobIds: z.array(z.string()).optional(),
  error: z.string().optional(),
});
export type TestRelayTriggerResponse = z.infer<typeof testRelayTriggerResponseSchema>;

/** Request a snapshot of a run's status. */
export const testRelayRunStatusRequestSchema = z.object({
  type: z.literal('test.relay.run.status'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  runId: z.string(),
});
export type TestRelayRunStatusRequest = z.infer<typeof testRelayRunStatusRequestSchema>;

/** Response carrying a run-status snapshot. */
export const testRelayRunStatusResponseSchema = z.object({
  type: z.literal('test.relay.run.status.response'),
  requestId: z.string(),
  runId: z.string().optional(),
  status: z.string().optional(),
  jobs: z
    .array(
      z.object({
        jobId: z.string(),
        jobName: z.string(),
        status: z.string(),
        exitCode: z.number().nullable().optional(),
        errorMessage: z.string().nullable().optional(),
      }),
    )
    .optional(),
  done: z.boolean().optional(),
  error: z.string().optional(),
});
export type TestRelayRunStatusResponse = z.infer<typeof testRelayRunStatusResponseSchema>;

/** Request the next chunk of a run's logs from a cursor. */
export const testRelayRunLogsRequestSchema = z.object({
  type: z.literal('test.relay.run.logs'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  runId: z.string(),
  cursor: z.number(),
});
export type TestRelayRunLogsRequest = z.infer<typeof testRelayRunLogsRequestSchema>;

/** Response carrying the next log chunk + a monotonic cursor. */
export const testRelayRunLogsResponseSchema = z.object({
  type: z.literal('test.relay.run.logs.response'),
  requestId: z.string(),
  lines: z.array(z.string()).optional(),
  nextCursor: z.number().optional(),
  done: z.boolean().optional(),
  error: z.string().optional(),
});
export type TestRelayRunLogsResponse = z.infer<typeof testRelayRunLogsResponseSchema>;

/** Request to cancel a run. */
export const testRelayCancelRequestSchema = z.object({
  type: z.literal('test.relay.cancel'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  runId: z.string().optional(),
  branch: z.string().optional(),
});
export type TestRelayCancelRequest = z.infer<typeof testRelayCancelRequestSchema>;

/** Response acknowledging a cancel. */
export const testRelayCancelResponseSchema = z.object({
  type: z.literal('test.relay.cancel.response'),
  requestId: z.string(),
  cancelled: z.boolean().optional(),
  error: z.string().optional(),
});
export type TestRelayCancelResponse = z.infer<typeof testRelayCancelResponseSchema>;

/** Union of the five Platform→orchestrator test-relay control requests. */
export type TestRelayRequest =
  | TestRelayUploadsInitRequest
  | TestRelayTriggerRequest
  | TestRelayRunStatusRequest
  | TestRelayRunLogsRequest
  | TestRelayCancelRequest;

// --- Direction-specific discriminated unions ---

/** Dashboard messages flowing from Platform to Orchestrator. */
export const dashboardPlatformToOrchSchema = z.discriminatedUnion('type', [
  dashboardRunDetailRequestSchema,
  dashboardStepLogsRequestSchema,
  dashboardAttestationsListRequestSchema,
  dashboardRunsListRequestSchema,
  dashboardRunsFiltersRequestSchema,
  dashboardSourcesListRequestSchema,
  runRerunRequestSchema,
  manualScheduleRequestSchema,
  runCancelRequestSchema,
  dashboardPayloadRequestSchema,
  dashboardOrchLogsRequestSchema,
  // Environment CRUD
  envListRequestSchema,
  envGetRequestSchema,
  envCreateRequestSchema,
  envUpdateRequestSchema,
  envTestAccessSetRequestSchema,
  envDeleteRequestSchema,
  // Environment variables
  envVarsListRequestSchema,
  envVarSetRequestSchema,
  envVarDeleteRequestSchema,
  // Source overrides
  envSourceOverridesListRequestSchema,
  envSourceOverrideSetRequestSchema,
  envSourceOverrideDeleteRequestSchema,
  // Bindings
  envBindingsListRequestSchema,
  envBindingsSetRequestSchema,
  // Scoped secrets
  envSecretsListRequestSchema,
  envSecretSetRequestSchema,
  envSecretDeleteRequestSchema,
  // Scope CRUD
  envSecretScopeCreateRequestSchema,
  envSecretScopeRenameRequestSchema,
  envSecretScopeDeleteRequestSchema,
  // Environment history
  envHistoryRequestSchema,
  // Held runs
  heldRunsListRequestSchema,
  heldRunApproveRequestSchema,
  heldRunRejectRequestSchema,
  // Registrations
  registrationsListRequestSchema,
  registrationDisableRequestSchema,
  registrationDeleteRequestSchema,
  // Diagnostics
  dashboardDiagnosticsRequestSchema,
  // Scaler capacity
  dashboardScalerCapacityRequestSchema,
  // Scaler agents (on-demand)
  dashboardScalerAgentsRequestSchema,
  // Backends
  backendsListRequestSchema,
  backendGetRequestSchema,
  backendsSyncAllRequestSchema,
  backendSyncRequestSchema,
  backendTestRequestSchema,
  // Inbound webhook delivery log
  dashboardEventLogListRequestSchema,
  dashboardEventLogDetailRequestSchema,
  dashboardEventLogPayloadStreamRequestSchema,
  // Event DLQ (per-org)
  dashboardEventDlqListRequestSchema,
  dashboardEventDlqCountRequestSchema,
  dashboardEventDlqRetryRequestSchema,
  dashboardEventDlqDiscardRequestSchema,
  // Org-level global workflow settings
  globalWorkflowsGetRequestSchema,
  globalWorkflowsUpdateRequestSchema,
  // Access log (dashboard "Data access" tab)
  dashboardAccessLogListRequestSchema,
  // Platform-first `kici run remote` control plane
  testRelayUploadsInitRequestSchema,
  testRelayTriggerRequestSchema,
  testRelayRunStatusRequestSchema,
  testRelayRunLogsRequestSchema,
  testRelayCancelRequestSchema,
]);

/** Dashboard messages flowing from Orchestrator to Platform. */
export const dashboardOrchToPlatformSchema = z.discriminatedUnion('type', [
  dashboardRunDetailResponseSchema,
  dashboardStepLogsResponseSchema,
  dashboardAttestationsListResponseSchema,
  dashboardRunsListResponseSchema,
  dashboardRunsFiltersResponseSchema,
  dashboardSourcesListResponseSchema,
  runRerunResponseSchema,
  manualScheduleResponseSchema,
  runCancelResponseSchema,
  dashboardPayloadResponseSchema,
  dashboardOrchLogsResponseSchema,
  // Environment CRUD
  envListResponseSchema,
  envGetResponseSchema,
  envCreateResponseSchema,
  envUpdateResponseSchema,
  envTestAccessSetResponseSchema,
  envDeleteResponseSchema,
  // Environment variables
  envVarsListResponseSchema,
  envVarSetResponseSchema,
  envVarDeleteResponseSchema,
  // Source overrides
  envSourceOverridesListResponseSchema,
  envSourceOverrideSetResponseSchema,
  envSourceOverrideDeleteResponseSchema,
  // Bindings
  envBindingsListResponseSchema,
  envBindingsSetResponseSchema,
  // Scoped secrets
  envSecretsListResponseSchema,
  envSecretSetResponseSchema,
  envSecretDeleteResponseSchema,
  // Scope CRUD
  envSecretScopeCreateResponseSchema,
  envSecretScopeRenameResponseSchema,
  envSecretScopeDeleteResponseSchema,
  // Environment history
  envHistoryResponseSchema,
  // Held runs
  heldRunsListResponseSchema,
  heldRunApproveResponseSchema,
  heldRunRejectResponseSchema,
  // Registrations
  registrationsListResponseSchema,
  registrationDisableResponseSchema,
  registrationDeleteResponseSchema,
  // Diagnostics
  dashboardDiagnosticsResponseSchema,
  // Scaler capacity
  dashboardScalerCapacityResponseSchema,
  // Scaler agents (on-demand)
  dashboardScalerAgentsResponseSchema,
  // Backends
  backendsListResponseSchema,
  backendGetResponseSchema,
  backendsSyncAllResponseSchema,
  backendSyncResponseSchema,
  backendTestResponseSchema,
  // Inbound webhook delivery log
  dashboardEventLogListResponseSchema,
  dashboardEventLogDetailResponseSchema,
  dashboardEventLogPayloadChunkSchema,
  // Event DLQ (per-org)
  dashboardEventDlqListResponseSchema,
  dashboardEventDlqCountResponseSchema,
  dashboardEventDlqRetryResponseSchema,
  dashboardEventDlqDiscardResponseSchema,
  // Org-level global workflow settings
  globalWorkflowsGetResponseSchema,
  globalWorkflowsUpdateResponseSchema,
  // Access log (dashboard "Data access" tab)
  dashboardAccessLogListResponseSchema,
  // Platform-first `kici run remote` control plane
  testRelayUploadsInitResponseSchema,
  testRelayTriggerResponseSchema,
  testRelayRunStatusResponseSchema,
  testRelayRunLogsResponseSchema,
  testRelayCancelResponseSchema,
]);

// --- Inferred types ---

export type DashboardRunDetailRequest = z.infer<typeof dashboardRunDetailRequestSchema>;
export type DashboardStepLogsRequest = z.infer<typeof dashboardStepLogsRequestSchema>;
export type RunRerunRequest = z.infer<typeof runRerunRequestSchema>;
export type ManualScheduleRequest = z.infer<typeof manualScheduleRequestSchema>;
export type RunCancelRequest = z.infer<typeof runCancelRequestSchema>;
export type DashboardPayloadRequest = z.infer<typeof dashboardPayloadRequestSchema>;
export type DashboardPlatformToOrchMessage = z.infer<typeof dashboardPlatformToOrchSchema>;

// Inbound webhook delivery log
export type EventLogListItem = z.infer<typeof eventLogListItemSchema>;
export type DashboardEventLogListRequest = z.infer<typeof dashboardEventLogListRequestSchema>;
export type DashboardEventLogListResponse = z.infer<typeof dashboardEventLogListResponseSchema>;
export type DashboardEventLogDetailRequest = z.infer<typeof dashboardEventLogDetailRequestSchema>;
export type DashboardEventLogDetailResponse = z.infer<typeof dashboardEventLogDetailResponseSchema>;
export type DashboardEventLogPayloadStreamRequest = z.infer<
  typeof dashboardEventLogPayloadStreamRequestSchema
>;
export type DashboardEventLogPayloadChunk = z.infer<typeof dashboardEventLogPayloadChunkSchema>;
export type BrowserEventLogPayloadChunk = z.infer<typeof browserEventLogPayloadChunkSchema>;

// Event DLQ types (per-org)
export type DashboardEventDlqListItem = z.infer<typeof dashboardEventDlqListItemSchema>;
export type DashboardEventDlqListRequest = z.infer<typeof dashboardEventDlqListRequestSchema>;
export type DashboardEventDlqListResponse = z.infer<typeof dashboardEventDlqListResponseSchema>;
export type DashboardEventDlqCountRequest = z.infer<typeof dashboardEventDlqCountRequestSchema>;
export type DashboardEventDlqCountResponse = z.infer<typeof dashboardEventDlqCountResponseSchema>;
export type DashboardEventDlqRetryRequest = z.infer<typeof dashboardEventDlqRetryRequestSchema>;
export type DashboardEventDlqRetryResponse = z.infer<typeof dashboardEventDlqRetryResponseSchema>;
export type DashboardEventDlqDiscardRequest = z.infer<typeof dashboardEventDlqDiscardRequestSchema>;
export type DashboardEventDlqDiscardResponse = z.infer<
  typeof dashboardEventDlqDiscardResponseSchema
>;

// Environment CRUD types
export type EnvListRequest = z.infer<typeof envListRequestSchema>;
type EnvListResponse = z.infer<typeof envListResponseSchema>;
export type EnvGetRequest = z.infer<typeof envGetRequestSchema>;
type EnvGetResponse = z.infer<typeof envGetResponseSchema>;
export type EnvCreateRequest = z.infer<typeof envCreateRequestSchema>;
export type EnvUpdateRequest = z.infer<typeof envUpdateRequestSchema>;
export type EnvTestAccessSetRequest = z.infer<typeof envTestAccessSetRequestSchema>;
export type EnvDeleteRequest = z.infer<typeof envDeleteRequestSchema>;
export type EnvVarsListRequest = z.infer<typeof envVarsListRequestSchema>;
type EnvVarsListResponse = z.infer<typeof envVarsListResponseSchema>;
export type EnvVarSetRequest = z.infer<typeof envVarSetRequestSchema>;
export type EnvVarDeleteRequest = z.infer<typeof envVarDeleteRequestSchema>;
export type EnvSourceOverridesListRequest = z.infer<typeof envSourceOverridesListRequestSchema>;
export type EnvSourceOverrideSetRequest = z.infer<typeof envSourceOverrideSetRequestSchema>;
export type EnvSourceOverrideDeleteRequest = z.infer<typeof envSourceOverrideDeleteRequestSchema>;
export type EnvBindingsListRequest = z.infer<typeof envBindingsListRequestSchema>;
export type EnvBindingsSetRequest = z.infer<typeof envBindingsSetRequestSchema>;
export type EnvSecretsListRequest = z.infer<typeof envSecretsListRequestSchema>;
export type EnvSecretSetRequest = z.infer<typeof envSecretSetRequestSchema>;
export type EnvSecretDeleteRequest = z.infer<typeof envSecretDeleteRequestSchema>;
export type EnvSecretScopeCreateRequest = z.infer<typeof envSecretScopeCreateRequestSchema>;
export type EnvSecretScopeRenameRequest = z.infer<typeof envSecretScopeRenameRequestSchema>;
export type EnvSecretScopeDeleteRequest = z.infer<typeof envSecretScopeDeleteRequestSchema>;
export type EnvHistoryRequest = z.infer<typeof envHistoryRequestSchema>;
export type HeldRunsListRequest = z.infer<typeof heldRunsListRequestSchema>;
type HeldRunsListResponse = z.infer<typeof heldRunsListResponseSchema>;
export type HeldRunApproveRequest = z.infer<typeof heldRunApproveRequestSchema>;
export type HeldRunRejectRequest = z.infer<typeof heldRunRejectRequestSchema>;

// Diagnostics types
export type DashboardDiagnosticsRequest = z.infer<typeof dashboardDiagnosticsRequestSchema>;
export type DashboardDiagnosticsResponse = z.infer<typeof dashboardDiagnosticsResponseSchema>;
export type DiagnosticsPeer = z.infer<typeof diagnosticsPeerSchema>;

// Scaler capacity types
export type DashboardScalerCapacityRequest = z.infer<typeof dashboardScalerCapacityRequestSchema>;
export type DashboardScalerCapacityResponse = z.infer<typeof dashboardScalerCapacityResponseSchema>;

// Scaler agents types
export type DashboardScalerAgentsRequest = z.infer<typeof dashboardScalerAgentsRequestSchema>;
export type DashboardScalerAgentsResponse = z.infer<typeof dashboardScalerAgentsResponseSchema>;

// Backend types
export type BackendsListRequest = z.infer<typeof backendsListRequestSchema>;
export type BackendGetRequest = z.infer<typeof backendGetRequestSchema>;
export type BackendsSyncAllRequest = z.infer<typeof backendsSyncAllRequestSchema>;
export type BackendSyncRequest = z.infer<typeof backendSyncRequestSchema>;
export type BackendTestRequest = z.infer<typeof backendTestRequestSchema>;
export type BackendItem = z.infer<typeof backendItemSchema>;

// Registration types
export type RegistrationItem = z.infer<typeof registrationItemSchema>;

// --- REST API response schemas (Platform -> Dashboard) ---
// Used by Platform to validate proxy responses before forwarding to dashboard.
// Also used by orchestrator to validate its responses before sending.

/** REST API response for run detail (jobs with nested steps). */
export const dashboardRunDetailApiResponseSchema = z.object({
  jobs: z.array(dashboardJobDetailSchema),
  trustContext: trustContextSchema.optional(),
  /** Run mode for idempotent steps. A non-apply value labels the run a check-mode preview. */
  checkMode: CheckMode.nullable().optional(),
  /**
   * Structured init-failure signal for runs that never started a step. Set
   * when the run row was created via `recordInitFailureRun()` on the
   * orchestrator and surfaced to the dashboard so the banner can render
   * even while the orchestrator is offline (Platform-DB fallback path).
   */
  initFailure: initFailureSchema.optional(),
});

/** REST API response for step logs. */
export const dashboardStepLogsApiResponseSchema = z.object({
  lines: z.array(z.string()),
  totalLines: z.number(),
});

/**
 * REST API response for the run attestations list. The orchestrator-relayed
 * `attestations` array is augmented by Platform with the provenance trust root
 * from its own `oidcIssuer` config: `trustedIssuer` is the issuer the dashboard
 * pins each bundle's identity token to (never the bundle's own `iss`), and
 * `jwksUri` is the discovery JWKS endpoint the dashboard fetches to verify.
 * Both are null when the Platform has no provenance issuer configured — the
 * dashboard then lists + downloads the bundles but renders the badge as
 * "verification unavailable".
 */
export const dashboardAttestationsApiResponseSchema = z.object({
  trustedIssuer: z.string().nullable(),
  jwksUri: z.string().nullable(),
  attestations: z.array(attestationListItemSchema),
});

// --- Runs list REST response (Platform -> Dashboard) ---
// Source of truth for GET /api/v1/orgs/:org/runs. Defined here (rather than in
// the private platform package) so the kici CLI can consume the same shape
// without importing platform internals.

/** Resolved user identity attached to run attribution fields. */
const runListPrincipalUserSchema = z.object({
  sub: z.string(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
});

/** Source identity attached to a run summary. */
const runListSourceSchema = z.object({
  routingKey: z.string(),
  name: z.string().nullable(),
  subtype: SourceSubtype.nullable(),
  provider: z.string(),
});

/** Single run summary in the paginated run list. */
export const runListItemSchema = z.object({
  runId: z.string(),
  workflowName: z.string(),
  status: z.string(),
  repoIdentifier: z.string().nullable(),
  sha: z.string().nullable(),
  ref: z.string().nullable(),
  triggerEvent: z.string().nullable(),
  commitMessage: z.string().nullable(),
  jobCount: z.number().nullable(),
  startedAt: z.coerce.string().nullable(),
  completedAt: z.coerce.string().nullable(),
  durationMs: z.number().nullable(),
  parentRunId: z.string().nullable(),
  originalRunId: z.string().nullable(),
  triggeredBy: z.string().nullable(),
  triggeredByUser: runListPrincipalUserSchema.nullable(),
  cancelledBy: z.string().nullable(),
  cancelledByUser: runListPrincipalUserSchema.nullable(),
  failureReason: z.string().optional(),
  hadCompileJob: z.boolean(),
  compileJobId: z.string().nullable(),
  source: runListSourceSchema.nullable(),
});
export type RunListItem = z.infer<typeof runListItemSchema>;

/** Paginated run list response envelope. */
export const runListResponseSchema = z.object({
  runs: z.array(runListItemSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  hasMore: z.boolean(),
});
export type RunListResponse = z.infer<typeof runListResponseSchema>;

// --- Diagnostics infrastructure REST response (Platform -> Dashboard) ---
// Source of truth for GET /api/v1/orgs/:org/diagnostics/infrastructure.

const diagnosticsInfraAgentSchema = z.object({
  agentId: z.string(),
  labels: z.array(z.string()),
  platform: z.string(),
  arch: z.string(),
  activeJobs: z.number(),
  maxConcurrency: z.number(),
  lastHeartbeatAt: z.number(),
  registeredAt: z.number(),
  version: z.string().nullable().optional(),
  hostname: z.string().nullable().optional(),
  osRelease: z.string().nullable().optional(),
  osVersion: z.string().nullable().optional(),
  totalMemoryMb: z.number().nullable().optional(),
  cpuCount: z.number().nullable().optional(),
  nodeVersion: z.string().nullable().optional(),
  memoryUsedMb: z.number().nullable().optional(),
  memoryAvailableMb: z.number().nullable().optional(),
  uptimeSeconds: z.number().nullable().optional(),
  runningAsUser: z.string().nullable().optional(),
  runningAsUid: z.number().nullable().optional(),
  scalerName: z.string().nullable().optional(),
});
const diagnosticsInfraScalerSchema = z.object({
  name: z.string(),
  type: z.string(),
  maxAgents: z.number(),
  activeAgents: z.number(),
  labelSets: z.array(z.array(z.string())),
  config: z.record(z.string(), z.unknown()).optional(),
  hosts: z.array(z.string()).optional(),
});
const diagnosticsInfraOrchestratorSchema = z.object({
  connectionId: z.string(),
  clusterName: z.string().nullable().optional(),
  instanceId: z.string().nullable().optional(),
  routingKeys: z.array(z.string()),
  connected: z.boolean(),
  connectedAt: z.number().nullable().optional(),
  lastHeartbeat: z.number().nullable().optional(),
  version: z.string().nullable().optional(),
  mode: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  raftRole: z.string().nullable().optional(),
  raftTerm: z.number().nullable().optional(),
  raftLeaderId: z.string().nullable().optional(),
  scalerBackends: z.array(z.string()),
  s3LogAccess: z.boolean().nullable().optional(),
  agentCount: z.number(),
  runningJobs: z.number(),
  queuedJobs: z.number(),
  pendingLabelGaps: z.array(z.string()),
  agents: z.array(diagnosticsInfraAgentSchema),
  hostname: z.string().nullable().optional(),
  osRelease: z.string().nullable().optional(),
  osVersion: z.string().nullable().optional(),
  totalMemoryMb: z.number().nullable().optional(),
  cpuCount: z.number().nullable().optional(),
  nodeVersion: z.string().nullable().optional(),
  memoryUsedMb: z.number().nullable().optional(),
  memoryAvailableMb: z.number().nullable().optional(),
  uptimeSeconds: z.number().nullable().optional(),
  runningAsUser: z.string().nullable().optional(),
  runningAsUid: z.number().nullable().optional(),
  statefulAgentCount: z.number(),
  scalers: z.array(diagnosticsInfraScalerSchema),
  dependencyHealth: z
    .array(
      z.object({
        name: z.string(),
        status: z.enum(['pass', 'warn', 'fail']),
        message: z.string().nullable(),
        details: z.record(z.string(), z.unknown()).optional(),
        durationMs: z.number().optional(),
      }),
    )
    .optional(),
  error: z.string().optional(),
});
const diagnosticsInfraAlertSchema = z.object({
  type: z.string(),
  message: z.string(),
  severity: z.string(),
});
export const diagnosticsInfrastructureResponseSchema = z.object({
  orchestrators: z.array(diagnosticsInfraOrchestratorSchema),
  alerts: z.array(diagnosticsInfraAlertSchema),
  latestVersion: z.string().nullable().optional(),
});
export type DiagnosticsInfrastructureResponse = z.infer<
  typeof diagnosticsInfrastructureResponseSchema
>;
export type DiagnosticsOrchestrator = z.infer<typeof diagnosticsInfraOrchestratorSchema>;
export type DiagnosticsAgent = z.infer<typeof diagnosticsInfraAgentSchema>;

// --- Diagnostics summary REST response (Platform -> Dashboard) ---
// Source of truth for GET /api/v1/orgs/:org/diagnostics — the header metrics
// the dashboard shows above the infrastructure tree.

const diagnosticsExecutionMetricsSchema = z.object({
  totalRuns: z.number(),
  successRate: z.number(),
  avgDurationSeconds: z.number(),
  queuedJobs: z.number(),
  runningJobs: z.number(),
});
export const diagnosticsSummaryResponseSchema = z.object({
  connections: z.array(z.unknown()),
  executionMetrics: diagnosticsExecutionMetricsSchema,
  orphanedConnections: z.number(),
});
export type DiagnosticsSummaryResponse = z.infer<typeof diagnosticsSummaryResponseSchema>;

// REST API inferred types (consumed by dashboard for type-safe queries)
export type DashboardRunDetailApiResponse = z.infer<typeof dashboardRunDetailApiResponseSchema>;
export type DashboardStepLogsApiResponse = z.infer<typeof dashboardStepLogsApiResponseSchema>;
export type DashboardAttestationsApiResponse = z.infer<
  typeof dashboardAttestationsApiResponseSchema
>;
export type DashboardJobDetail = z.infer<typeof dashboardJobDetailSchema>;

// --- Dashboard payload utility types ---
// Extracted item types for use by dashboard components and orchestrator handlers.
// These are the "inner" shapes — e.g., a single environment, a single held run —
// without the WS envelope (type, requestId).

/** Single environment from the list response. */
export type DashboardEnvironment = NonNullable<EnvListResponse['environments']>[number];

/** Full environment detail from the get response. */
export type DashboardEnvironmentDetail = NonNullable<EnvGetResponse['environment']>;

/** Single environment variable from the variables list response. */
export type DashboardEnvironmentVariable = NonNullable<EnvVarsListResponse['variables']>[number];

/** Single held run from the held runs list response. */
export type DashboardHeldRun = NonNullable<HeldRunsListResponse['heldRuns']>[number];

// --- REST-only dashboard schemas ---
// These schemas define response shapes for Platform REST endpoints consumed by the dashboard.
// Shared between Platform (validation) and dashboard (type inference).

/** Single infrastructure event for a run (from run_events table). */
export const runEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  eventType: z.string(),
  timestampMs: z.number(),
  sourceService: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  durationMs: z.number().nullable(),
  jobId: z.string().nullable(),
  stepIndex: z.number().nullable(),
  traceId: z.string().nullable(),
  spanId: z.string().nullable(),
  parentSpanId: z.string().nullable(),
});

export type RunEvent = z.infer<typeof runEventSchema>;

/** Trust policy response (from trust_policies table). */
export const trustPolicyResponseSchema = z.object({
  forkPolicy: z.string(),
  unknownContributorPolicy: z.string(),
  workflowChangePolicy: z.string(),
  approvalExpiryHours: z.number(),
});

export type TrustPolicy = z.infer<typeof trustPolicyResponseSchema>;

/** Single identity link item. */
export const identityLinkItemSchema = z.object({
  id: z.string(),
  provider: z.string(),
  providerUsername: z.string(),
  linkMethod: z.string(),
  linkedAt: z.string(),
});

/** Response for identity links list endpoint. */
export const identityLinkListResponseSchema = z.object({
  identityLinks: z.array(identityLinkItemSchema),
});

export type IdentityLink = z.infer<typeof identityLinkItemSchema>;
export type IdentityLinkListResponse = z.infer<typeof identityLinkListResponseSchema>;

/** Single identity link in a member context (no id/method/date). */
export const memberIdentityLinkSchema = z.object({
  provider: z.string(),
  providerUsername: z.string(),
});

/** Role assignment within a member response. */
export const memberRoleAssignmentSchema = z.object({
  roleId: z.string(),
  roleName: z.string(),
  isOwner: z.boolean(),
});

/** Single org member with identity and trust info. */
export const orgMemberSchema = z.object({
  userId: z.string(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  roles: z.array(z.string()),
  roleAssignments: z.array(memberRoleAssignmentSchema),
  suspendedAt: z.coerce.string().nullable(),
  joinedAt: z.coerce.string(),
  ciTrustLevel: z.string(),
  identityLinks: z.array(memberIdentityLinkSchema),
});

/** Response for org members list endpoint. */
export const memberListResponseSchema = z.object({
  members: z.array(orgMemberSchema),
});

export type OrgMember = z.infer<typeof orgMemberSchema>;
export type MemberListResponse = z.infer<typeof memberListResponseSchema>;
