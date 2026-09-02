import { z } from 'zod';
import { CheckMode, CheckStepOutcome } from '../../check-mode.js';
import { actorPrincipalSchema } from './actor.js';
import { dashboardSealedEnvelopeSchema } from './dashboard-sealed-write.js';
import { agentRunResultSchema } from './agent-run-result.js';
import { kiciBundleSchema } from '../../provenance/bundle.js';
import {
  dashboardAccessLogListRequestSchema,
  dashboardAccessLogListResponseSchema,
} from './access-log.js';
import { dashboardOrchLogsRequestSchema, dashboardOrchLogsResponseSchema } from './run-events.js';
import { EventLogStatus, PayloadOmittedReason, EventLogSource } from './event-log.js';
import {
  initFailureSchema,
  StepConcurrencyKind,
  stateReplayRunSchema,
  JobKind,
} from './execution-status.js';
import { SourceSubtype } from './source-registration.js';
import { SourceOrigin } from '../source-origin.js';
import { AttestationOrigin } from '../../provenance/attestation-origin.js';
import { DeploymentModeSchema, DeploymentContainerRuntimeSchema } from './deployment-identity.js';
import { ScalerBackendType } from '../../scaler/scaler-backend-type.js';
import { HoldScope, ApprovalDecision, approverClauseSchema } from '../../approval/types.js';
import { NeedsRunOn, OnUnreachableMode } from '../../trigger/types.js';
import { HostTargetSelector } from '../../labels-match.js';
import { ConcurrencyStrategy } from '../../context/concurrency-strategy.js';
import { HeldRunStatus } from '../../context/held-run-status.js';
import { HostInventoryEntry } from '../../inventory.js';
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

/**
 * Request the machine-first, provenance-tagged structured run result from the
 * orchestrator (user-plane equivalent of the orchestrator-admin
 * `/runs/:id/structured` endpoint). Reuses the Phase-1 `AgentRunResult` shape.
 */
export const dashboardRunStructuredRequestSchema = z.object({
  type: z.literal('dashboard.run.structured'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  runId: z.string(),
});
export type DashboardRunStructuredRequest = z.infer<typeof dashboardRunStructuredRequestSchema>;

/** Response carrying the provenance-tagged AgentRunResult (null when not found). */
export const dashboardRunStructuredResponseSchema = z.object({
  type: z.literal('dashboard.run.structured.response'),
  requestId: z.string(),
  result: agentRunResultSchema.nullable(),
  error: z.string().optional(),
});
export type DashboardRunStructuredResponse = z.infer<typeof dashboardRunStructuredResponseSchema>;

/**
 * Request the current mirror-projection state of a single run from the
 * orchestrator. Unlike `dashboard.run.detail` (a user-plane read that
 * access-logs), this is a **system reconciliation read**: the Platform's
 * `RunMirrorReconciler` issues it for a run stuck non-terminal in the mirror to
 * recover a terminal frame dropped on a live connection. The `actor` is always a
 * `system` principal, and the orchestrator does NOT write an access-log row.
 */
export const dashboardRunStateRequestSchema = z.object({
  type: z.literal('dashboard.run.state'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  runId: z.string(),
});
export type DashboardRunStateRequest = z.infer<typeof dashboardRunStateRequestSchema>;

/**
 * Response carrying the run's current `StateReplayRun` mirror-projection shape
 * (the same shape `state.replay` carries), or `run: null` when the orchestrator
 * has no such run. Consumed by `upsertRunMirror` on the Platform side.
 */
export const dashboardRunStateResponseSchema = z.object({
  type: z.literal('dashboard.run.state.response'),
  requestId: z.string(),
  run: stateReplayRunSchema.nullable(),
  error: z.string().optional(),
});
export type DashboardRunStateResponse = z.infer<typeof dashboardRunStateResponseSchema>;

/** Request step logs from orchestrator. */
export const dashboardStepLogsRequestSchema = z.object({
  type: z.literal('dashboard.step.logs'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  runId: z.string(),
  jobId: z.string(),
  stepIndex: z.number(),
  /**
   * Optional line-offset cursor (a prior response's `nextCursor`). Absent reads
   * from the start.
   */
  cursor: z.string().optional(),
  /**
   * Optional max lines to return. Absent = unbounded (the human dashboard relies
   * on this); the MCP layer opts into paging by sending an explicit limit.
   */
  limit: z.number().int().positive().optional(),
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
  /** Step concurrency role; absent/`sequential` for ordinary steps. */
  concurrencyKind: StepConcurrencyKind.nullable().optional(),
  /** Parallel-group correlation id shared by a group's children (e.g. `g0`). */
  groupId: z.string().nullable().optional(),
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
  /**
   * Job kind: `standard` runs steps on an agent, `gate` is an invoke gate, and
   * `proxy` mirrors a summoned source-repo run. Absent/null for a standard job.
   *
   * OPTIONAL, and must stay optional: the wire protocol is compatibility-
   * protected, so an orchestrator that predates invoke gates omits it.
   */
  jobKind: JobKind.nullable().optional(),
  /**
   * For a `proxy` job, the summoned source-repo run this job mirrors; the
   * dashboard links the proxy node through to it. null/absent otherwise.
   */
  summonedRunId: z.string().nullable().optional(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  durationMs: z.number().nullable(),
  agentId: z.string().nullable(),
  orchestratorId: z.string().nullable().optional(),
  errorMessage: z.string().nullable(),
  /**
   * Why this job cannot currently be routed to any agent, present only while it
   * is still queued and nothing in the fleet matches its `runsOn`; cleared once
   * a matching agent or scaler backend appears.
   *
   * OPTIONAL, and must stay optional: the wire protocol is compatibility-
   * protected, so an orchestrator that predates the unroutable probe
   * omits it.
   */
  routingReason: z.string().nullable().optional(),
  /** Labels used for agent routing (e.g. ["kici:os:linux", "kici:arch:x64"]). */
  runsOnLabels: z.array(z.string()).nullable().optional(),
  /**
   * Ordered bound deployment-context names for this job, in merge order
   * (later contexts override earlier on key collisions). A `(dynamic)`
   * entry marks an element resolved at runtime. null/absent = no binding.
   */
  contexts: z.array(z.string()).nullable().optional(),
  /**
   * Bound contexts skipped on a test/local run (non-test or unconfigured).
   * null/absent when nothing was skipped.
   */
  skippedContexts: z.array(z.string()).nullable().optional(),
  /** User-visible warning naming the skipped test-run contexts. null/absent when none. */
  envWarning: z.string().nullable().optional(),
  /**
   * A job's non-secret outputs. Present when the job completed successfully with
   * outputs.
   *
   * The value is intentionally `z.record(z.string(), z.unknown())` — the same
   * loose shape the wire (`job.status.data.outputs`) and `InvokeResult.outputs`
   * use — because two job kinds populate it with two different shapes:
   * - a **standard** job carries the agent's step-keyed map
   *   (`{ <stepName>: { <outputKey>: value } }`), so each value is itself a map;
   * - a **proxy** job mirrors a summoned run, and a run's outputs are FLAT
   *   (`{ <outputKey>: value }`, values scalar), matching `InvokeResult.outputs`.
   *
   * A stricter step-keyed record type rejected the flat proxy shape and failed
   * the whole run-detail response, so the schema accepts either.
   */
  outputs: z.record(z.string(), z.unknown()).nullable().optional(),
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
   * upstream job name; `runOn` is the per-edge run-on status-set (the upstream
   * terminal statuses that satisfy the edge). null/absent when the job has no
   * upstreams.
   */
  needs: z
    .array(
      z.object({
        upstreamName: z.string(),
        runOn: NeedsRunOn,
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
  /** Next line-offset cursor, or null when the page reached the end. */
  nextCursor: z.string().nullable().optional(),
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
 * Server-side verification verdict for an attestation, computed at ingest.
 * - `verified` — `verifyKiciBundle` succeeded.
 * - `failed` — verification ran and the bundle failed (signature / identity /
 *   build-context / unsupported mode). A provenance-integrity signal.
 * - `unverifiable` — no verdict could be computed (no trust root configured, or
 *   the JWKS / bundle could not be read). NOT a forgery signal.
 * - `pending` — verdict not yet computed (pre-backfill row, or ingest raced the
 *   trust root).
 */
export const attestationVerifyStatusSchema = z.enum([
  'verified',
  'failed',
  'unverifiable',
  'pending',
]);
export type AttestationVerifyStatus = z.infer<typeof attestationVerifyStatusSchema>;

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
  /**
   * Owning run id — populated by the single-attestation detail get (for the
   * "view run" link); omitted by the per-run list (the run is already known).
   */
  runId: z.string().optional(),
  /** Stored server-side verdict — populated by the detail get (omitted per-run). */
  verifyStatus: attestationVerifyStatusSchema.optional(),
  /** First failure reason for the stored verdict, when failed (detail get only). */
  verifyReason: z.string().nullable().optional(),
  /**
   * Source-origin brand: triggered vs kici run remote (local working-tree
   * overlay). Read from the signed statement's internalParameters.
   */
  sourceOrigin: SourceOrigin.optional(),
  /** Authoritative origin: the customer's public org id (from the signed statement). */
  originOrgId: z.string().optional(),
  /**
   * Mint-timing origin: live / deferred / offline-backfill. Read from the token
   * claim or the signed statement's internalParameters; absent defaults to live.
   */
  attestationOrigin: AttestationOrigin.optional(),
});
export type AttestationListItem = z.infer<typeof attestationListItemSchema>;

/** Response with the run's attestations (correlates to dashboard.attestations.list). */
export const dashboardAttestationsListResponseSchema = z.object({
  type: z.literal('dashboard.attestations.list.response'),
  requestId: z.string(),
  attestations: z.array(attestationListItemSchema),
  /**
   * The provenance issuer that signs this orchestrator's attestations, when it
   * owns signing (`KICI_ORCHESTRATOR_PROVENANCE_ISSUER`). The Platform surfaces
   * it as `trustedIssuer` so the dashboard / CLI verify against the orchestrator
   * that actually signed the bundles; absent → the Platform falls back to its own
   * issuer (for historical Platform-signed bundles). Optional for backward
   * compatibility with older orchestrators.
   */
  trustedIssuer: z.string().nullable().optional(),
  error: z.string().optional(),
});
export type DashboardAttestationsListResponse = z.infer<
  typeof dashboardAttestationsListResponseSchema
>;

// --- Artifacts list request/response (REST-over-WS proxy) ---
//
// Named, durable build artifacts uploaded by a run's jobs (`ctx.artifacts`).
// Like the per-run attestations read, this is served by the customer
// orchestrator and access-logged there; Platform proxies the request. Each item
// carries a presigned GET URL (`downloadUrl`) the dashboard links directly, so
// the artifact bytes never transit Platform.

/** Request the named artifacts uploaded by a run. */
export const dashboardArtifactsListRequestSchema = z.object({
  type: z.literal('dashboard.artifacts.list'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  runId: z.string(),
});
export type DashboardArtifactsListRequest = z.infer<typeof dashboardArtifactsListRequestSchema>;

/**
 * Single artifact in the list response. `downloadUrl` is a presigned GET the
 * dashboard links directly; it is omitted when the backing object could not be
 * resolved (expired / missing), in which case the row still lists the metadata.
 */
export const artifactListItemSchema = z.object({
  name: z.string(),
  jobId: z.string(),
  sizeBytes: z.number(),
  sha256: z.string(),
  createdAt: z.string(),
  downloadUrl: z.string().optional(),
});
export type ArtifactListItem = z.infer<typeof artifactListItemSchema>;

/** Response with the run's artifacts (correlates to dashboard.artifacts.list). */
export const dashboardArtifactsListResponseSchema = z.object({
  type: z.literal('dashboard.artifacts.list.response'),
  requestId: z.string(),
  artifacts: z.array(artifactListItemSchema),
  /**
   * Signature-validity window (seconds) of the presigned `downloadUrl`s in this
   * response, from the storage backend's presigned-GET expiry; the dashboard
   * refreshes the list on a fraction of it so a displayed link is never stale.
   * Optional for backward compatibility with older orchestrators (mirrors
   * `trustedIssuer`).
   */
  downloadUrlExpiresInSeconds: z.number().int().positive().optional(),
  error: z.string().optional(),
});
export type DashboardArtifactsListResponse = z.infer<typeof dashboardArtifactsListResponseSchema>;

// --- Org-wide attestations browser (search + browse) ---
//
// A second, org-scoped read surface alongside the per-run list above. The list
// is metadata-only (no inlined bundle) so it stays cheap at any scale; the
// verdict badge comes from the server-side `verifyStatus` recorded at ingest.
// The detail get inlines exactly one bundle for the attestation-detail page.
// (`attestationVerifyStatusSchema` is defined above, next to the list item.)

/**
 * Metadata-only summary row for the org-wide list. No inlined bundle (keeps the
 * list cheap). `repository` / `workflow` are joined from `execution_runs` when
 * available.
 */
export const attestationListSummarySchema = z.object({
  id: z.string(),
  runId: z.string(),
  jobId: z.string(),
  jobName: z.string().nullable(),
  subjectName: z.string(),
  subjectDigest: z.string(),
  mode: z.string(),
  mediaType: z.string(),
  createdAt: z.string(),
  verifyStatus: attestationVerifyStatusSchema,
  verifyReason: z.string().nullable(),
  repository: z.string().nullable(),
  workflow: z.string().nullable(),
  /**
   * Source-origin brand: triggered vs kici run remote (local working-tree
   * overlay). Derived from the run's local_working_tree flag.
   */
  sourceOrigin: SourceOrigin.optional(),
  /** Mint-timing origin: live / deferred / offline-backfill. */
  attestationOrigin: AttestationOrigin.optional(),
  /**
   * True for a row still in the deferred-attestation outbox (not yet minted):
   * `verifyStatus: 'pending'`, no bundle. The page offers a retry action.
   */
  pending: z.boolean().optional(),
});
export type AttestationListSummary = z.infer<typeof attestationListSummarySchema>;

/** Filters for the org-wide attestations list. */
export const attestationListFiltersSchema = z.object({
  digest: z.string().optional(),
  name: z.string().optional(),
  status: attestationVerifyStatusSchema.optional(),
  repository: z.string().optional(),
  workflow: z.string().optional(),
  job: z.string().optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
});
export type AttestationListFilters = z.infer<typeof attestationListFiltersSchema>;

/** Request the org-wide, paginated, filtered list of attestations. */
export const dashboardAttestationsListAllRequestSchema = z.object({
  type: z.literal('dashboard.attestations.list.all'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  page: z.number().int().positive(),
  sort: z.string().optional(),
  filters: attestationListFiltersSchema.default({}),
});
export type DashboardAttestationsListAllRequest = z.infer<
  typeof dashboardAttestationsListAllRequestSchema
>;

/** Response with one page of org-wide attestation summaries. */
export const dashboardAttestationsListAllResponseSchema = z.object({
  type: z.literal('dashboard.attestations.list.all.response'),
  requestId: z.string(),
  attestations: z.array(attestationListSummarySchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  /** See `dashboardAttestationsListResponseSchema.trustedIssuer`. */
  trustedIssuer: z.string().nullable().optional(),
  error: z.string().optional(),
});
export type DashboardAttestationsListAllResponse = z.infer<
  typeof dashboardAttestationsListAllResponseSchema
>;

/** Request a single attestation by id (detail page; inlines the one bundle). */
export const dashboardAttestationGetRequestSchema = z.object({
  type: z.literal('dashboard.attestation.get'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  attestationId: z.string(),
});
export type DashboardAttestationGetRequest = z.infer<typeof dashboardAttestationGetRequestSchema>;

/** Response with one attestation (the existing item shape with bundle), or null. */
export const dashboardAttestationGetResponseSchema = z.object({
  type: z.literal('dashboard.attestation.get.response'),
  requestId: z.string(),
  attestation: attestationListItemSchema.nullable(),
  error: z.string().optional(),
});
export type DashboardAttestationGetResponse = z.infer<typeof dashboardAttestationGetResponseSchema>;

/** Request an on-demand drain of the deferred-attestation outbox (optionally one run). */
export const dashboardAttestationRetryRequestSchema = z.object({
  type: z.literal('dashboard.attestation.retry'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  /** Scope to a single run; omitted drains every pending attestation. */
  runId: z.string().optional(),
});
export type DashboardAttestationRetryRequest = z.infer<
  typeof dashboardAttestationRetryRequestSchema
>;

/** Response with the drain counts. */
export const dashboardAttestationRetryResponseSchema = z.object({
  type: z.literal('dashboard.attestation.retry.response'),
  requestId: z.string(),
  minted: z.number().int(),
  stillPending: z.number().int(),
  error: z.string().optional(),
});
export type DashboardAttestationRetryResponse = z.infer<
  typeof dashboardAttestationRetryResponseSchema
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
  /** Distinct bound deployment-context names across the run's jobs (first-seen order). */
  contexts: z.array(z.string()).optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  durationMs: z.number().optional(),
  parentRunId: z.string().optional(),
  originalRunId: z.string().optional(),
  triggeredBy: z.string().optional(),
  triggeredByAgentLabel: z.string().nullable().optional(),
  cancelledBy: z.string().optional(),
  cancelledByAgentLabel: z.string().nullable().optional(),
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
  /** Agent provenance label when triggered through an agent credential. */
  triggeredByAgentLabel: z.string().nullable().optional(),
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
  /**
   * True when the run was already terminal, so the cancel wrote nothing. Optional
   * so an orchestrator that predates the field still parses: an absent value
   * means "not reported", not "false".
   */
  alreadyTerminal: z.boolean().optional(),
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

/** Aggregate webhook-activity counts for a time window (org-scoped).
 *  Powers the Runs-page misconfig strip + the `kici runs` hint. No payloads,
 *  no repo identifiers — safe for all org members. */
export const dashboardEventLogActivityRequestSchema = z.object({
  type: z.literal('dashboard.event-log.activity'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  orgId: z.string(),
  /** ISO timestamp lower bound (inclusive). */
  fromTimestamp: z.string(),
  /** ISO timestamp upper bound (exclusive). */
  toTimestamp: z.string(),
});

/** Orchestrator-only bucketed counts over the window. `matched`/`unmatched`
 *  distinguish a trigger-no-match delivery from one that produced a run — a
 *  fact the Platform relay cannot compute (see the two-table architecture). */
export const eventLogActivityCountsSchema = z.object({
  total: z.number(),
  matched: z.number(),
  unmatched: z.number(),
  lockfileMissing: z.number(),
  lockfileCorrupt: z.number(),
  failed: z.number(),
});

export const dashboardEventLogActivityResponseSchema = z.object({
  type: z.literal('dashboard.event-log.activity.response'),
  requestId: z.string(),
  counts: eventLogActivityCountsSchema.optional(),
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

// --- Context CRUD request/response (REST-over-WS proxy) ---

const contextTypeSchema = z.enum(['fixed', 'glob']);

// -- Contexts --

/** List all contexts for the org. */
export const contextListRequestSchema = z.object({
  type: z.literal('dashboard.contexts.list'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  /**
   * When true, each returned context carries its reachable secret key
   * names (never values) in `secretKeys`. Used by the developer CLI's
   * `kici secrets list` / `kici types` commands.
   */
  includeSecrets: z.boolean().optional(),
  /**
   * Target org the read must be scoped to, carried per-request by the Platform
   * (the validated `:orgId` path param). The orchestrator honors this over its
   * static connection-level org so a Platform-first `kici run remote` org —
   * anchored only by `remote_sources` — sees its own contexts even when the
   * orchestrator's connection also serves a webhook source for a different org.
   * Absent on the legacy customer-dashboard path, where the connection org is
   * already the request org.
   */
  orgId: z.string().optional(),
});

const contextListResponseSchema = z.object({
  type: z.literal('dashboard.contexts.list.response'),
  requestId: z.string(),
  contexts: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        type: contextTypeSchema,
        globPattern: z.string().nullable(),
        enabled: z.boolean(),
        allowLocalExecution: z.boolean(),
        createdAt: z.coerce.string(),
        updatedAt: z.coerce.string(),
        /**
         * Distinct secret key names reachable from this context's scope
         * bindings (never values). Present only when the request set
         * `includeSecrets: true`.
         */
        secretKeys: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  error: z.string().optional(),
});

/** Get a single context by ID. */
export const contextGetRequestSchema = z.object({
  type: z.literal('dashboard.contexts.get'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  contextId: z.string(),
});

const contextGetResponseSchema = z.object({
  type: z.literal('dashboard.contexts.get.response'),
  requestId: z.string(),
  context: z
    .object({
      id: z.string(),
      name: z.string(),
      type: contextTypeSchema,
      globPattern: z.string().nullable(),
      branchRestrictions: z.array(z.string()).nullable(),
      concurrencyLimit: z.number().nullable(),
      concurrencyStrategy: ConcurrencyStrategy.nullable(),
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

/** Create a new context. */
export const contextCreateRequestSchema = z.object({
  type: z.literal('dashboard.contexts.create'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  name: z.string(),
  contextType: contextTypeSchema,
  globPattern: z.string().optional(),
  branchRestrictions: z.array(z.string()).optional(),
  // A concurrency limit must be a positive integer; `null`/omitted means
  // unlimited. `0` (or a negative / fractional value) is rejected here because
  // it wedges the workflow-install concurrency gate into an unreleasable hold.
  concurrencyLimit: z.number().int().positive().optional(),
  concurrencyStrategy: ConcurrencyStrategy.optional(),
  requiredReviewers: z.number().optional(),
  waitTimerSeconds: z.number().optional(),
  // A hold expiry must be a positive integer; `null`/omitted means "no explicit
  // expiry" and resolves to `DEFAULT_HOLD_EXPIRY_SECONDS` on read. `0` (or a
  // negative / fractional value) is rejected because it puts the hold's
  // deadline at the instant the hold is created, so the stale detector expires
  // it before a reviewer can act — cancelling the job the hold existed to gate.
  holdExpirySeconds: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
});

const contextCreateResponseSchema = z.object({
  type: z.literal('dashboard.contexts.create.response'),
  requestId: z.string(),
  contextId: z.string().optional(),
  error: z.string().optional(),
});

/** Update an existing context. */
export const contextUpdateRequestSchema = z.object({
  type: z.literal('dashboard.contexts.update'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  contextId: z.string(),
  updates: z.object({
    name: z.string().optional(),
    contextType: contextTypeSchema.optional(),
    globPattern: z.string().nullable().optional(),
    branchRestrictions: z.array(z.string()).nullable().optional(),
    // Positive integer, or `null` for unlimited. `0`/negative/fractional is
    // rejected — see the create-request schema above for why.
    concurrencyLimit: z.number().int().positive().nullable().optional(),
    concurrencyStrategy: ConcurrencyStrategy.nullable().optional(),
    requiredReviewers: z.number().nullable().optional(),
    waitTimerSeconds: z.number().nullable().optional(),
    // Positive integer, or `null` to clear the explicit expiry.
    // `0`/negative/fractional is rejected — see the create-request schema above
    // for why. Clearing is how the dashboard's emptied field is expressed, so
    // `null` stays valid.
    holdExpirySeconds: z.number().int().positive().nullable().optional(),
    enabled: z.boolean().optional(),
  }),
});

const contextUpdateResponseSchema = z.object({
  type: z.literal('dashboard.contexts.update.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

/** Set an context's test-run access flag (allowLocalExecution). */
export const contextTestAccessSetRequestSchema = z.object({
  type: z.literal('dashboard.contexts.test_access.set'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  contextId: z.string(),
  allowLocalExecution: z.boolean(),
});

const contextTestAccessSetResponseSchema = z.object({
  type: z.literal('dashboard.contexts.test_access.set.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

/** Delete an context. */
export const contextDeleteRequestSchema = z.object({
  type: z.literal('dashboard.contexts.delete'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  contextId: z.string(),
});

/**
 * Machine-readable codes for context-delete rejections.
 *
 * Three-category response taxonomy on dashboard responses, each mapped to a
 * distinct HTTP status by the Platform proxy: a bare free-text `error` is the
 * human message and maps to 400; a missing result (e.g. context not found)
 * maps to 404; an `errorCode` flags a specific business rejection mapped to a
 * non-400/404 status — here `pending_held_runs` → 409. The sibling precedent is
 * the rerun response's `errorCode` (`runArchivedNotRerunnable` → 410) above.
 */
export const ContextDeleteErrorCode = z.enum(['pending_held_runs']);
export type ContextDeleteErrorCode = z.infer<typeof ContextDeleteErrorCode>;

const contextDeleteResponseSchema = z.object({
  type: z.literal('dashboard.contexts.delete.response'),
  requestId: z.string(),
  error: z.string().optional(),
  errorCode: ContextDeleteErrorCode.optional(),
});

// -- Context variables --

/** List variables for an context. */
export const contextVarsListRequestSchema = z.object({
  type: z.literal('dashboard.contexts.variables.list'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  contextId: z.string(),
});

const contextVarsListResponseSchema = z.object({
  type: z.literal('dashboard.contexts.variables.list.response'),
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

/**
 * Set (create or update) a variable on an context.
 *
 * Under the `permissive` posture the browser sends the plaintext `value`.
 * Under the `encrypted` posture it sends a `sealed` envelope instead (the value
 * sealed to the orchestrator's X25519 key in the browser). Exactly one of
 * `value` / `sealed` is present; `value` stays optional for backward
 * compatibility with older dashboards that only ever send plaintext.
 */
export const contextVarSetRequestSchema = z
  .object({
    type: z.literal('dashboard.contexts.variables.set'),
    requestId: z.string(),
    actor: actorPrincipalSchema,
    contextId: z.string(),
    key: z.string(),
    value: z.string().optional(),
    sealed: dashboardSealedEnvelopeSchema.optional(),
    locked: z.boolean().optional(),
  })
  .refine((m) => (m.value === undefined) !== (m.sealed === undefined), {
    message: 'exactly one of value / sealed must be present',
  });

const contextVarSetResponseSchema = z.object({
  type: z.literal('dashboard.contexts.variables.set.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

/** Delete a variable from an context. */
export const contextVarDeleteRequestSchema = z.object({
  type: z.literal('dashboard.contexts.variables.delete'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  contextId: z.string(),
  key: z.string(),
});

const contextVarDeleteResponseSchema = z.object({
  type: z.literal('dashboard.contexts.variables.delete.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

// -- Source overrides --

/** List source overrides for an context + routing key. */
export const contextSourceOverridesListRequestSchema = z.object({
  type: z.literal('dashboard.contexts.source-overrides.list'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  contextId: z.string(),
  routingKey: z.string(),
});

const contextSourceOverridesListResponseSchema = z.object({
  type: z.literal('dashboard.contexts.source-overrides.list.response'),
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
export const contextSourceOverrideSetRequestSchema = z.object({
  type: z.literal('dashboard.contexts.source-overrides.set'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  contextId: z.string(),
  routingKey: z.string(),
  key: z.string(),
  value: z.string(),
});

const contextSourceOverrideSetResponseSchema = z.object({
  type: z.literal('dashboard.contexts.source-overrides.set.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

/** Delete a source override variable. */
export const contextSourceOverrideDeleteRequestSchema = z.object({
  type: z.literal('dashboard.contexts.source-overrides.delete'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  contextId: z.string(),
  routingKey: z.string(),
  key: z.string(),
});

const contextSourceOverrideDeleteResponseSchema = z.object({
  type: z.literal('dashboard.contexts.source-overrides.delete.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

// -- Context bindings --

/**
 * A scope→context binding with its host selector. `hostPattern` is the host
 * the binding applies to (`'**'` = all hosts); exact / glob / regex over a
 * fan-out child's agentId / hostname / labels.
 */
export const contextBindingEntrySchema = z.object({
  scopePattern: z.string(),
  hostPattern: z.string(),
});
export type ContextBindingEntry = z.infer<typeof contextBindingEntrySchema>;

/** List bindings for an context. */
export const contextBindingsListRequestSchema = z.object({
  type: z.literal('dashboard.contexts.bindings.list'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  contextId: z.string(),
});

const contextBindingsListResponseSchema = z.object({
  type: z.literal('dashboard.contexts.bindings.list.response'),
  requestId: z.string(),
  bindings: z.array(contextBindingEntrySchema).optional(),
  error: z.string().optional(),
});

/** Set bindings (scope + host patterns) for an context. */
export const contextBindingsSetRequestSchema = z.object({
  type: z.literal('dashboard.contexts.bindings.set'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  contextId: z.string(),
  bindings: z.array(contextBindingEntrySchema),
});

const contextBindingsSetResponseSchema = z.object({
  type: z.literal('dashboard.contexts.bindings.set.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

// -- Scoped secrets --

/** List all scoped secrets for the org. */
export const contextSecretsListRequestSchema = z.object({
  type: z.literal('dashboard.contexts.secrets.list'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
});

const contextSecretsListResponseSchema = z.object({
  type: z.literal('dashboard.contexts.secrets.list.response'),
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

/**
 * Set (create or update) a scoped secret.
 *
 * Under the `permissive` posture the browser sends the plaintext `value`.
 * Under the `encrypted` posture it sends a `sealed` envelope instead (the value
 * sealed to the orchestrator's X25519 key in the browser). Exactly one of
 * `value` / `sealed` is present; `value` stays optional for backward
 * compatibility with older dashboards that only ever send plaintext.
 */
export const contextSecretSetRequestSchema = z
  .object({
    type: z.literal('dashboard.contexts.secrets.set'),
    requestId: z.string(),
    actor: actorPrincipalSchema,
    scope: z.string(),
    key: z.string(),
    value: z.string().optional(),
    sealed: dashboardSealedEnvelopeSchema.optional(),
  })
  .refine((m) => (m.value === undefined) !== (m.sealed === undefined), {
    message: 'exactly one of value / sealed must be present',
  });

const contextSecretSetResponseSchema = z.object({
  type: z.literal('dashboard.contexts.secrets.set.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

/** Delete a scoped secret. */
export const contextSecretDeleteRequestSchema = z.object({
  type: z.literal('dashboard.contexts.secrets.delete'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  scope: z.string(),
  key: z.string(),
});

const contextSecretDeleteResponseSchema = z.object({
  type: z.literal('dashboard.contexts.secrets.delete.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

// -- Scope CRUD --

/** Create an empty scope. */
export const contextSecretScopeCreateRequestSchema = z.object({
  type: z.literal('dashboard.contexts.secrets.scope.create'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  scope: z.string(),
});

const contextSecretScopeCreateResponseSchema = z.object({
  type: z.literal('dashboard.contexts.secrets.scope.create.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

/** Rename a scope -- also updates all context bindings referencing old scope. */
export const contextSecretScopeRenameRequestSchema = z.object({
  type: z.literal('dashboard.contexts.secrets.scope.rename'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  oldScope: z.string(),
  newScope: z.string(),
});

const contextSecretScopeRenameResponseSchema = z.object({
  type: z.literal('dashboard.contexts.secrets.scope.rename.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

/** Delete a scope and all its secrets. Also removes context bindings referencing this scope. */
export const contextSecretScopeDeleteRequestSchema = z.object({
  type: z.literal('dashboard.contexts.secrets.scope.delete'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  scope: z.string(),
});

const contextSecretScopeDeleteResponseSchema = z.object({
  type: z.literal('dashboard.contexts.secrets.scope.delete.response'),
  requestId: z.string(),
  error: z.string().optional(),
});

// -- Context history --

/** Fetch runs that targeted a specific context, keyed by context id. */
export const contextHistoryRequestSchema = z.object({
  type: z.literal('dashboard.contexts.history'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  contextId: z.string(),
  limit: z.number().optional(),
  offset: z.number().optional(),
});

export const contextHistoryResponseSchema = z.object({
  type: z.literal('dashboard.contexts.history.response'),
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
        context: z.string().nullable(),
      }),
    )
    .optional(),
  hasMore: z.boolean().optional(),
  error: z.string().optional(),
});

// -- Held runs --

/**
 * Known held-run statuses — the vocabulary the dashboard renders a labelled
 * badge and a queue tab for, and the vocabulary a client may filter the list
 * by. Defined in `context/held-run-status.ts` and re-exported here so the
 * domain types and the wire schema cannot carry divergent copies; a parity test
 * in the orchestrator asserts these options match every status it persists.
 *
 * This is deliberately NOT the wire type of the response field:
 * `held_runs.status` is a plain-text column owned by a customer-deployed
 * orchestrator, so the response carries `z.string()` (see
 * `heldRunsListResponseSchema`) and this enum is what the UI switches on.
 */
export { HeldRunStatus } from '../../context/held-run-status.js';

/** Queue type for held runs. */
export const HeldRunQueueType = z.enum(['context', 'security']);
export type HeldRunQueueType = z.infer<typeof HeldRunQueueType>;

/** List held runs. */
export const heldRunsListRequestSchema = z.object({
  type: z.literal('dashboard.held-runs.list'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  status: HeldRunStatus.optional(),
  queueType: HeldRunQueueType.optional(),
  runId: z.string().optional(),
  /**
   * Narrow to a single hold by its `held_runs.id`. The Platform's held-run
   * approval gate uses this to resolve one hold's `holdType` before deciding
   * which permission the caller needs. Optional so an orchestrator that does
   * not know the field still answers the request — the Platform then narrows
   * client-side from the response.
   */
  heldRunId: z.string().optional(),
  /**
   * Target org the read must be scoped to, carried per-request by the Platform
   * (the validated `:orgId` path param). The orchestrator honors this over its
   * static connection-level org so a Platform-first `kici run remote` org —
   * anchored only by `remote_sources` — sees its own held runs even when the
   * orchestrator's connection also serves a webhook source for a different org.
   * Absent on the legacy customer-dashboard path, where the connection org is
   * already the request org.
   */
  orgId: z.string().optional(),
});

const heldRunsListResponseSchema = z.object({
  type: z.literal('dashboard.held-runs.list.response'),
  requestId: z.string(),
  heldRuns: z
    .array(
      z.object({
        id: z.string(),
        runId: z.string(),
        // Null once the context is deleted (held_runs.context_id is
        // FK ON DELETE SET NULL): terminal hold history outlives its env.
        contextId: z.string().nullable(),
        contextName: z.string().nullable(),
        // Carries the gate vocabulary — `HoldType` in @kici-dev/engine, which
        // the dashboard compares against. Two normalizations put it there, and
        // both are needed: an orchestrator on a current version maps the
        // persisted `held_runs.hold_type` through `normalizePersistedHoldType`
        // before sending, which covers a row an older orchestrator wrote under
        // a legacy spelling; and the dashboard normalizes again on receipt,
        // which covers an orchestrator that is itself older than the mapping
        // and therefore sends a legacy spelling verbatim.
        //
        // Kept `z.string()` for forward-compatibility with orchestrators that
        // introduce new hold types: a strict enum would reject the entire
        // relayed held-runs message on one unknown value. An unrecognised value
        // renders as a neutral badge carrying the raw string.
        holdType: z.string(),
        // Kept `z.string()` for the same reason as `holdType` above: both
        // mirror plain-text columns (`held_runs.queue_type` /
        // `held_runs.status`, each `Generated<string>`) whose vocabulary a
        // customer-deployed orchestrator owns and can extend ahead of us.
        //
        // A strict enum here does NOT degrade one row — it fails the whole
        // relayed message, and because `dashboard.held-runs.list.response` is a
        // type the Platform recognizes, the relay treats that failure as
        // malformed rather than version skew and CLOSES the orchestrator's
        // WebSocket (`packages/platform/src/ws/handler.ts`). That is exactly
        // what `released` did: one released wait-timer hold dropped the whole
        // control-plane connection, in a reconnect loop.
        //
        // The known vocabularies are `HeldRunQueueType` and `HeldRunStatus`,
        // which the dashboard compares against; any other value renders as a
        // neutral badge carrying the raw string. The REQUEST-side filters stay
        // strict enums — a client-supplied filter with a typo should be
        // rejected, not silently matched against nothing.
        queueType: z.string(),
        status: z.string(),
        requestedAt: z.coerce.string(),
        resolvedAt: z.coerce.string().nullable(),
        resolvedBy: z.string().nullable(),
        reason: z.string().nullable(),
        expiresAt: z.coerce.string().nullable(),
        contributorUsername: z.string().nullable().optional(),
        trustTier: z.string().nullable().optional(),
        // Per-element approval fields (job/workflow/step holds). Optional so
        // legacy context-only holds (which carry no approval requirement)
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
        // Computed drift payload for a `when: 'drift'` step hold; null/absent
        // for every other hold. Rendered in the approval queue + the CLI.
        payload: z
          .object({ summaryMarkdown: z.string(), drift: z.unknown() })
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
  /**
   * Set by the `kici run --approve-all` breakglass: the approval was issued by
   * the run's own dispatcher auto-approving every gate of that run. Eligibility
   * is still enforced (this only changes the audit action to
   * `held_run.auto_approve`); it is never a bypass.
   */
  autoApprove: z.boolean().optional(),
  /**
   * Target org the decision must be scoped to, carried per-request by the
   * Platform (the validated `:orgId` path param). Honored over the static
   * connection-level org so a remote run's hold — recorded under the run's own
   * `remote_sources` org — is resolvable even when the orchestrator's
   * connection also serves a webhook source for a different org.
   */
  orgId: z.string().optional(),
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
  /**
   * Target org the decision must be scoped to, carried per-request by the
   * Platform (the validated `:orgId` path param). Honored over the static
   * connection-level org so a remote run's hold — recorded under the run's own
   * `remote_sources` org — is resolvable even when the orchestrator's
   * connection also serves a webhook source for a different org.
   */
  orgId: z.string().optional(),
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

// --- Fleet read protocol (roster, host detail, runsOnAll preview) ---

/** A run pinned to a host, for the host-detail "recent runs" list. */
export const fleetPinnedRunSchema = z.object({
  runId: z.string(),
  workflowName: z.string().nullable(),
  status: z.string(),
  createdAt: z.string(),
});
export type FleetPinnedRun = z.infer<typeof fleetPinnedRunSchema>;

/** How a runsOnAll fan-out would treat one host, given its current reachability. */
export const FleetHostDisposition = z.enum(['target', 'unreachable-durable', 'skipped-ephemeral']);
export type FleetHostDisposition = z.infer<typeof FleetHostDisposition>;

/** A host matched by a runsOnAll preview, plus how the fan-out would treat it. */
export const fleetPreviewHostSchema = z.object({
  entry: HostInventoryEntry,
  disposition: FleetHostDisposition,
});
export type FleetPreviewHost = z.infer<typeof fleetPreviewHostSchema>;

// Requests (Platform -> orch)
export const dashboardFleetHostsRequestSchema = z.object({
  type: z.literal('dashboard.fleet.hosts'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
});
export const dashboardFleetHostRequestSchema = z.object({
  type: z.literal('dashboard.fleet.host'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  agentId: z.string(),
});
export const dashboardFleetPreviewRequestSchema = z.object({
  type: z.literal('dashboard.fleet.preview'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  workflowName: z.string(),
});

// Responses (orch -> Platform)
export const dashboardFleetHostsResponseSchema = z.object({
  type: z.literal('dashboard.fleet.hosts.response'),
  requestId: z.string(),
  hosts: z.array(HostInventoryEntry),
});
export const dashboardFleetHostResponseSchema = z.object({
  type: z.literal('dashboard.fleet.host.response'),
  requestId: z.string(),
  host: HostInventoryEntry.nullable(),
  runs: z.array(fleetPinnedRunSchema),
});
export const dashboardFleetPreviewResponseSchema = z.object({
  type: z.literal('dashboard.fleet.preview.response'),
  requestId: z.string(),
  matched: z.array(fleetPreviewHostSchema),
  onUnreachable: OnUnreachableMode,
  estimatedChildCount: z.number(),
});

export type DashboardFleetHostsRequest = z.infer<typeof dashboardFleetHostsRequestSchema>;
export type DashboardFleetHostRequest = z.infer<typeof dashboardFleetHostRequestSchema>;
export type DashboardFleetPreviewRequest = z.infer<typeof dashboardFleetPreviewRequestSchema>;
export type DashboardFleetHostsResponse = z.infer<typeof dashboardFleetHostsResponseSchema>;
export type DashboardFleetHostResponse = z.infer<typeof dashboardFleetHostResponseSchema>;
export type DashboardFleetPreviewResponse = z.infer<typeof dashboardFleetPreviewResponseSchema>;

// --- Fleet "workflows for host" read (host-centric inverse of the preview) ---

/** Request: which registered runsOnAll fan-outs target this host? */
export const dashboardFleetWorkflowsForHostRequestSchema = z.object({
  type: z.literal('dashboard.fleet.workflows-for-host'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  agentId: z.string(),
});

/** One registered runsOnAll workflow whose selector matches the host. */
export const fleetHostWorkflowSchema = z.object({
  workflowName: z.string(),
  repoIdentifier: z.string(),
  sourceFile: z.string().nullable(),
  onUnreachable: OnUnreachableMode,
  disposition: FleetHostDisposition,
});
export type FleetHostWorkflow = z.infer<typeof fleetHostWorkflowSchema>;

export const dashboardFleetWorkflowsForHostResponseSchema = z.object({
  type: z.literal('dashboard.fleet.workflows-for-host.response'),
  requestId: z.string(),
  workflows: z.array(fleetHostWorkflowSchema),
});

export type DashboardFleetWorkflowsForHostRequest = z.infer<
  typeof dashboardFleetWorkflowsForHostRequestSchema
>;
export type DashboardFleetWorkflowsForHostResponse = z.infer<
  typeof dashboardFleetWorkflowsForHostResponseSchema
>;

// --- Fleet host writes (Model C: declare / remove) ---

/** Declare a static host into the roster (wraps HostRosterStore.declareStatic). */
export const fleetHostDeclareRequestSchema = z.object({
  type: z.literal('dashboard.fleet.host.declare'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  agentId: z.string(),
  // Optional so a re-declare can omit labels (preserve-on-omit at the store).
  labels: z.array(z.string()).optional(),
  hostname: z.string().optional(),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export const fleetHostDeclareResponseSchema = z.object({
  type: z.literal('dashboard.fleet.host.declare.response'),
  requestId: z.string(),
  declared: z.boolean().optional(),
  // true when the declare inserted a new roster row; false on a converging
  // re-declare (existing row updated). Lets the dashboard report created vs updated.
  created: z.boolean().optional(),
  error: z.string().optional(),
});

/** Remove a host from the roster by agent id (HostRosterStore.removeStatic). */
export const fleetHostRemoveRequestSchema = z.object({
  type: z.literal('dashboard.fleet.host.remove'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  agentId: z.string(),
});
export const fleetHostRemoveResponseSchema = z.object({
  type: z.literal('dashboard.fleet.host.remove.response'),
  requestId: z.string(),
  // false ⇒ no row matched (not-found); the `error` field stays reserved for
  // internal errors, which the Platform maps to HTTP 500.
  removed: z.boolean().optional(),
  error: z.string().optional(),
});

export type FleetHostDeclareRequest = z.infer<typeof fleetHostDeclareRequestSchema>;
export type FleetHostDeclareResponse = z.infer<typeof fleetHostDeclareResponseSchema>;
export type FleetHostRemoveRequest = z.infer<typeof fleetHostRemoveRequestSchema>;
export type FleetHostRemoveResponse = z.infer<typeof fleetHostRemoveResponseSchema>;

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
  /**
   * True when this registration is a global workflow — one whose trigger
   * carries `repos:`, so it fires on events from other repos in the org.
   *
   * Optional because an orchestrator predating this field omits it. A reader
   * that needs a value for such a row derives one from `triggers[].repos`,
   * which is the same signal the orchestrator classifies on at registration
   * time. Prefer this field when present: it mirrors the `is_global` column
   * the dispatcher itself reads, so it cannot drift from dispatch behaviour.
   */
  isGlobal: z.boolean().optional(),
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
  /**
   * Runtime host narrowing from `kici run --target`. Intersects each runsOnAll
   * job's matched roster with this selector. Omitted for webhook runs.
   */
  target: HostTargetSelector.optional(),
  /**
   * Raw operator-supplied `kici run --input KEY=VALUE` pairs (not coerced /
   * defaulted), relayed verbatim. The orchestrator validates + coerces + applies
   * defaults authoritatively against the matched workflow's lock descriptor.
   */
  dispatchInputs: z.record(z.string(), z.string()).optional(),
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
  /** User-visible warnings on acceptance (e.g. skipped non-test bound contexts). */
  warnings: z.array(z.string()).optional(),
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
  dashboardRunStructuredRequestSchema,
  dashboardRunStateRequestSchema,
  dashboardStepLogsRequestSchema,
  dashboardAttestationsListRequestSchema,
  dashboardAttestationsListAllRequestSchema,
  dashboardAttestationGetRequestSchema,
  dashboardAttestationRetryRequestSchema,
  dashboardArtifactsListRequestSchema,
  dashboardRunsListRequestSchema,
  dashboardRunsFiltersRequestSchema,
  dashboardSourcesListRequestSchema,
  runRerunRequestSchema,
  manualScheduleRequestSchema,
  runCancelRequestSchema,
  dashboardPayloadRequestSchema,
  dashboardOrchLogsRequestSchema,
  // Context CRUD
  contextListRequestSchema,
  contextGetRequestSchema,
  contextCreateRequestSchema,
  contextUpdateRequestSchema,
  contextTestAccessSetRequestSchema,
  contextDeleteRequestSchema,
  // Context variables
  contextVarsListRequestSchema,
  contextVarSetRequestSchema,
  contextVarDeleteRequestSchema,
  // Source overrides
  contextSourceOverridesListRequestSchema,
  contextSourceOverrideSetRequestSchema,
  contextSourceOverrideDeleteRequestSchema,
  // Bindings
  contextBindingsListRequestSchema,
  contextBindingsSetRequestSchema,
  // Scoped secrets
  contextSecretsListRequestSchema,
  contextSecretSetRequestSchema,
  contextSecretDeleteRequestSchema,
  // Scope CRUD
  contextSecretScopeCreateRequestSchema,
  contextSecretScopeRenameRequestSchema,
  contextSecretScopeDeleteRequestSchema,
  // Context history
  contextHistoryRequestSchema,
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
  // Fleet read (roster, host detail, runsOnAll preview)
  dashboardFleetHostsRequestSchema,
  dashboardFleetHostRequestSchema,
  dashboardFleetPreviewRequestSchema,
  dashboardFleetWorkflowsForHostRequestSchema,
  // Fleet host writes (Model C: declare / remove)
  fleetHostDeclareRequestSchema,
  fleetHostRemoveRequestSchema,
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
  dashboardEventLogActivityRequestSchema,
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
  dashboardRunStructuredResponseSchema,
  dashboardRunStateResponseSchema,
  dashboardStepLogsResponseSchema,
  dashboardAttestationsListResponseSchema,
  dashboardAttestationsListAllResponseSchema,
  dashboardAttestationGetResponseSchema,
  dashboardAttestationRetryResponseSchema,
  dashboardArtifactsListResponseSchema,
  dashboardRunsListResponseSchema,
  dashboardRunsFiltersResponseSchema,
  dashboardSourcesListResponseSchema,
  runRerunResponseSchema,
  manualScheduleResponseSchema,
  runCancelResponseSchema,
  dashboardPayloadResponseSchema,
  dashboardOrchLogsResponseSchema,
  // Context CRUD
  contextListResponseSchema,
  contextGetResponseSchema,
  contextCreateResponseSchema,
  contextUpdateResponseSchema,
  contextTestAccessSetResponseSchema,
  contextDeleteResponseSchema,
  // Context variables
  contextVarsListResponseSchema,
  contextVarSetResponseSchema,
  contextVarDeleteResponseSchema,
  // Source overrides
  contextSourceOverridesListResponseSchema,
  contextSourceOverrideSetResponseSchema,
  contextSourceOverrideDeleteResponseSchema,
  // Bindings
  contextBindingsListResponseSchema,
  contextBindingsSetResponseSchema,
  // Scoped secrets
  contextSecretsListResponseSchema,
  contextSecretSetResponseSchema,
  contextSecretDeleteResponseSchema,
  // Scope CRUD
  contextSecretScopeCreateResponseSchema,
  contextSecretScopeRenameResponseSchema,
  contextSecretScopeDeleteResponseSchema,
  // Context history
  contextHistoryResponseSchema,
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
  // Fleet read (roster, host detail, runsOnAll preview)
  dashboardFleetHostsResponseSchema,
  dashboardFleetHostResponseSchema,
  dashboardFleetPreviewResponseSchema,
  dashboardFleetWorkflowsForHostResponseSchema,
  // Fleet host writes (Model C: declare / remove)
  fleetHostDeclareResponseSchema,
  fleetHostRemoveResponseSchema,
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
  dashboardEventLogActivityResponseSchema,
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
export type EventLogActivityCounts = z.infer<typeof eventLogActivityCountsSchema>;
export type DashboardEventLogActivityRequest = z.infer<
  typeof dashboardEventLogActivityRequestSchema
>;
export type DashboardEventLogActivityResponse = z.infer<
  typeof dashboardEventLogActivityResponseSchema
>;
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

// Context CRUD types
export type ContextListRequest = z.infer<typeof contextListRequestSchema>;
type ContextListResponse = z.infer<typeof contextListResponseSchema>;
export type ContextGetRequest = z.infer<typeof contextGetRequestSchema>;
type ContextGetResponse = z.infer<typeof contextGetResponseSchema>;
export type ContextCreateRequest = z.infer<typeof contextCreateRequestSchema>;
export type ContextUpdateRequest = z.infer<typeof contextUpdateRequestSchema>;
export type ContextTestAccessSetRequest = z.infer<typeof contextTestAccessSetRequestSchema>;
export type ContextDeleteRequest = z.infer<typeof contextDeleteRequestSchema>;
export type ContextVarsListRequest = z.infer<typeof contextVarsListRequestSchema>;
type ContextVarsListResponse = z.infer<typeof contextVarsListResponseSchema>;
export type ContextVarSetRequest = z.infer<typeof contextVarSetRequestSchema>;
export type ContextVarDeleteRequest = z.infer<typeof contextVarDeleteRequestSchema>;
export type ContextSourceOverridesListRequest = z.infer<
  typeof contextSourceOverridesListRequestSchema
>;
export type ContextSourceOverrideSetRequest = z.infer<typeof contextSourceOverrideSetRequestSchema>;
export type ContextSourceOverrideDeleteRequest = z.infer<
  typeof contextSourceOverrideDeleteRequestSchema
>;
export type ContextBindingsListRequest = z.infer<typeof contextBindingsListRequestSchema>;
export type ContextBindingsSetRequest = z.infer<typeof contextBindingsSetRequestSchema>;
export type ContextSecretsListRequest = z.infer<typeof contextSecretsListRequestSchema>;
export type ContextSecretSetRequest = z.infer<typeof contextSecretSetRequestSchema>;
export type ContextSecretDeleteRequest = z.infer<typeof contextSecretDeleteRequestSchema>;
export type ContextSecretScopeCreateRequest = z.infer<typeof contextSecretScopeCreateRequestSchema>;
export type ContextSecretScopeRenameRequest = z.infer<typeof contextSecretScopeRenameRequestSchema>;
export type ContextSecretScopeDeleteRequest = z.infer<typeof contextSecretScopeDeleteRequestSchema>;
export type ContextHistoryRequest = z.infer<typeof contextHistoryRequestSchema>;
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
  /** Next line-offset cursor, or null when the page reached the end. */
  nextCursor: z.string().nullable().optional(),
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
  /**
   * The repository that DEFINES this run's workflow. Non-null only when it
   * differs from `repoIdentifier` — i.e. this is an organization-wide global
   * run, whose workflow file lives in another repo entirely. Optional so a
   * client parsing a response from an older Platform still validates.
   */
  workflowRepoIdentifier: z.string().nullable().optional(),
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
  triggeredByAgentLabel: z.string().nullable().optional(),
  triggeredByUser: runListPrincipalUserSchema.nullable(),
  cancelledBy: z.string().nullable(),
  cancelledByAgentLabel: z.string().nullable().optional(),
  cancelledByUser: runListPrincipalUserSchema.nullable(),
  failureReason: z.string().optional(),
  hadCompileJob: z.boolean(),
  compileJobId: z.string().nullable(),
  /**
   * Distinct bound deployment-context names across the run's jobs
   * (first-seen order). Drives the run-list context chips; empty/absent
   * when no job binds an context.
   */
  contexts: z.array(z.string()).optional(),
  /**
   * Run-level repo provider (origin host) — distinct from `source.provider`
   * which is derived from the routing key. Drives provider-aware repo links.
   */
  repoProvider: z.string().nullable(),
  /** True when the run executed a developer's local working tree (`kici run remote`). */
  localWorkingTree: z.boolean(),
  source: runListSourceSchema.nullable(),
});
export type RunListItem = z.infer<typeof runListItemSchema>;

/**
 * Cursor-paginated run list response envelope.
 *
 * Keyset (cursor) pagination: `nextCursor` fetches the next (older) page,
 * `prevCursor` the previous (newer) page — both opaque, `null` when there is no
 * such page. `hasMore` is true when an older page exists. `approxTotal` is a
 * cached, approximate match count for the "~N runs" label (not an exact total).
 */
export const runListResponseSchema = z.object({
  runs: z.array(runListItemSchema),
  nextCursor: z.string().nullable(),
  prevCursor: z.string().nullable(),
  hasMore: z.boolean(),
  approxTotal: z.number(),
  pageSize: z.number(),
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
  /**
   * Self-reported deployment shape, used by the dashboard to build the correct
   * per-orchestrator kici-admin invocation. Orchestrators that never reported
   * it serialize as `mode: 'unknown'` with null container fields.
   *
   * `adminInvocation` is a shell command, not a pair of raw paths: either half
   * is single-quoted when its path holds whitespace, so it is rendered verbatim
   * and a reader that wants the shim path back has to split it as shell words
   * rather than on the last space.
   *
   * `adminPath` is the `windows` counterpart: the RAW, unquoted path of the
   * `kici-admin.cmd` launcher, null for every other mode and whenever it could
   * not be located. It is deliberately not a command — cmd.exe runs a
   * double-quoted path in command position while PowerShell only prints it, so
   * the renderer has to quote it per shell and a pre-quoted value would take
   * that choice away.
   */
  deployment: z.object({
    mode: DeploymentModeSchema,
    containerName: z.string().nullable(),
    containerRuntime: DeploymentContainerRuntimeSchema.nullable(),
    adminInvocation: z.string().nullable(),
    adminPath: z.string().nullable(),
  }),
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
/**
 * A single infrastructure health alert.
 *
 * Both vocabulary fields are `z.string()` on purpose. `InfraAlertType` and
 * `InfraAlertSeverity` (`diagnostics/infra-alert.ts`) name the *known*
 * vocabulary the producer mints from and the read-side consumers colour by; the
 * wire stays permissive because the `kici` CLI hard-parses this response while
 * pinned to an older version than the hosted Platform it is talking to. A
 * strict enum would fail the whole response rather than degrade one row.
 */
export const diagnosticsInfraAlertSchema = z.object({
  type: z.string(),
  message: z.string(),
  severity: z.string(),
});
export type DiagnosticsInfraAlert = z.infer<typeof diagnosticsInfraAlertSchema>;
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
// These are the "inner" shapes — e.g., a single context, a single held run —
// without the WS envelope (type, requestId).

/** Single context from the list response. */
export type DashboardContext = NonNullable<ContextListResponse['contexts']>[number];

/** Full context detail from the get response. */
export type DashboardContextDetail = NonNullable<ContextGetResponse['context']>;

/** Single context variable from the variables list response. */
export type DashboardContextVariable = NonNullable<ContextVarsListResponse['variables']>[number];

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

/**
 * Trust policy response (from trust_policies table).
 *
 * `approvalExpirySeconds` is the authoritative window and `approvalExpiryHours`
 * its coarse, rounded-up view, so a client reading only the older field still
 * gets a usable number. Both are always sent by this build; the seconds field is
 * optional so a dashboard build reading an older Platform still parses.
 */
export const trustPolicyResponseSchema = z.object({
  forkPolicy: z.string(),
  unknownContributorPolicy: z.string(),
  workflowChangePolicy: z.string(),
  approvalExpiryHours: z.number(),
  approvalExpirySeconds: z.number().optional(),
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
  /**
   * The per-member `ci_trust` override, when one is stored, or `null` when the
   * member's level is entirely role-derived.
   *
   * Carried beside `ciTrustLevel` rather than folded into it, because the two
   * answer different questions. `ciTrustLevel` is the effective level the CI
   * trust gate decides with — the role-derived level with any override applied
   * on top — so it cannot say which half produced it. An override OUTRANKS the
   * roles, so an org that lowered a member by override has no way to see that,
   * and no way to undo it, from a payload that reports only the result.
   *
   * Optional so an older client keeps parsing the response.
   */
  ciTrustOverride: z.string().nullable().optional(),
  identityLinks: z.array(memberIdentityLinkSchema),
});

/** Response for org members list endpoint. */
export const memberListResponseSchema = z.object({
  members: z.array(orgMemberSchema),
});

export type OrgMember = z.infer<typeof orgMemberSchema>;
export type MemberListResponse = z.infer<typeof memberListResponseSchema>;

/**
 * Every dashboard request type the local build understands, derived from the
 * discriminated union so it can never drift. A component advertises this set to
 * describe ITSELF; gating decisions always compare against the REMOTE's
 * advertised set, never this local one.
 */
export const DASHBOARD_REQUEST_TYPES: readonly string[] = dashboardPlatformToOrchSchema.options.map(
  (o) => o.shape.type.value,
);

/** Membership-test form of {@link DASHBOARD_REQUEST_TYPES}. */
export const DASHBOARD_REQUEST_TYPE_SET: ReadonlySet<string> = new Set(DASHBOARD_REQUEST_TYPES);

/** Structured error code on a dashboard `*.response` frame's `code` field. */
export const DashboardResponseErrorCode = z.enum([
  'unsupported_request_type',
  'invalid_payload',
  'unsupported_message_type',
  'internal_error',
]);
export type DashboardResponseErrorCode = z.infer<typeof DashboardResponseErrorCode>;
