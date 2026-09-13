import { z } from 'zod';
import { actorPrincipalSchema } from './actor.js';

// --- Run event protocol messages ---
//
// These messages enable infrastructure event tracking and execution context
// forwarding through the three-tier relay: orchestrator/agent -> Platform -> browser.

// --- Orchestrator/Agent -> Platform: run event tracking ---

/** Infrastructure event emitted by orchestrator or agent during run lifecycle.
 *
 * SECURITY INVARIANT: This schema MUST NOT carry an `orgId` (or any tenant
 * identifier). Orchestrator WS connections are single-tenant — `authState.orgId`
 * is fixed for the connection's lifetime, derived from a DB-backed API-key hash.
 * The Platform always uses `authState.orgId` for tenant attribution; trusting a
 * wire-supplied field would be a cross-tenant injection primitive (see
 * `docs/architecture/security/ws-tenant-isolation.md`).
 */
export const runEventMessageSchema = z.object({
  type: z.literal('run.event'),
  runId: z.string(),
  eventType: z.string(), // e.g. 'webhook.received', 'platform.relay', 'orchestrator.dispatch', 'agent.spawn', 'clone.start', 'clone.end', 'execution.start', 'execution.end', 'teardown'
  timestampMs: z.number(),
  sourceService: z.enum(['platform', 'orchestrator', 'agent']),
  metadata: z.record(z.string(), z.unknown()).optional(),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  parentSpanId: z.string().optional(),
  durationMs: z.number().nullable().optional(),
  jobId: z.string().nullable().optional(),
  stepIndex: z.number().nullable().optional(),
});

// --- Agent -> Orchestrator -> Platform -> Browser: job execution context ---

/** Execution context sent by agent at job start for the Summary tab.
 *
 * SECURITY INVARIANT: see `runEventMessageSchema` above — no tenant identifier
 * may appear on this wire schema. All tenant attribution comes from
 * `authState.orgId` on the receiving Platform side.
 */
export const jobContextMessageSchema = z.object({
  type: z.literal('job.context'),
  runId: z.string(),
  jobId: z.string(),
  context: z.object({
    envVars: z
      .array(
        z.object({
          name: z.string(),
          value: z.string(), // masked for secrets
          category: z.enum(['system', 'user', 'inherited', 'secret']),
        }),
      )
      .optional(),
    runtime: z
      .object({
        nodeVersion: z.string().optional(),
        os: z.string().optional(),
        arch: z.string().optional(),
      })
      .optional(),
    sandboxType: z.string().optional(),
    labels: z.array(z.string()).optional(),
    workingDirectory: z.string().optional(),
    gitRef: z.string().optional(),
    lockFileVersion: z.string().optional(),
    sdkVersion: z.string().optional(),
    depCacheStatus: z.string().optional(),
    networkIsolation: z.string().optional(),
    scalerContext: z
      .object({
        backendType: z.string(),
        scalerName: z.string(),
      })
      .passthrough()
      .optional(),
  }),
});

// --- Platform -> Browser: forwarded events ---

/** Run event forwarded to browser for live timeline updates.
 *
 * NOTE: `runId` is already present in this schema (and always populated by the
 * Platform WS fan-out in `browser-fan-out.ts::onRunEvent`). The dashboard uses it
 * to group events by their originating run in the rerun chain. Do not remove.
 */
export const browserRunEventSchema = z.object({
  type: z.literal('run.event'),
  runId: z.string(),
  eventType: z.string(),
  timestampMs: z.number(),
  sourceService: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  durationMs: z.number().nullable().optional(),
  jobId: z.string().nullable().optional(),
  stepIndex: z.number().nullable().optional(),
});

/** Job context forwarded to browser for Summary tab. */
export const browserJobContextSchema = z.object({
  type: z.literal('job.context'),
  runId: z.string(),
  jobId: z.string(),
  context: jobContextMessageSchema.shape.context,
});

// --- Dashboard -> Orchestrator: orchestration log request ---

/** Request orchestration logs for a job via Platform-orchestrator proxy. */
export const dashboardOrchLogsRequestSchema = z.object({
  type: z.literal('dashboard.orch.logs'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  runId: z.string(),
  jobId: z.string(),
});

/** Response with orchestration logs for a job. */
export const dashboardOrchLogsResponseSchema = z.object({
  type: z.literal('dashboard.orch.logs.response'),
  requestId: z.string(),
  lines: z.array(z.string()),
  totalLines: z.number(),
  error: z.string().optional(),
});

// --- Inferred types ---

export type DashboardOrchLogsRequest = z.infer<typeof dashboardOrchLogsRequestSchema>;
