/**
 * Agent-facing, provenance-tagged run-result schema.
 *
 * A machine-first read shape for a run: the typed job DAG, per-step exit codes,
 * durations, statuses, and a coarse derived failure classification. Every field
 * an agent could be tricked by — names, refs, error text, log lines, job outputs —
 * is wrapped in an {@link untrusted} envelope so a consumer can keep
 * user-controlled content out of an instruction channel. KiCI-generated values
 * (ids, enum statuses, exit codes, durations, hashes, derived categories) stay
 * plain (trusted).
 *
 * Read-only contract — produced by the orchestrator admin run API and consumed by
 * agents / the developer MCP server. Reuses the existing execution status enums;
 * never define a parallel status string.
 */
import { z } from 'zod';
import {
  ExecutionRunStatus,
  ExecutionJobStatus,
  ExecutionStepStatus,
  InitFailureCategory,
} from './execution-status.js';
import { TrustTierSchema } from '../../environment/types.js';
import { CheckStepOutcome } from '../../check-mode.js';

/**
 * Wrap a value KiCI does not vouch for — content from the user's repo, the
 * contributor, or a process's output. Trusted fields are left plain. The
 * envelope self-tags so the value survives reshaping / fencing: a renderer that
 * fences untrusted content just refuses to emit any `{ untrusted: true }` value
 * into an instruction channel.
 */
export const untrusted = <T extends z.ZodTypeAny>(v: T) =>
  z.object({ untrusted: z.literal(true), value: v });

/** Construct an untrusted envelope around a runtime value. */
export function wrapUntrusted<T>(value: T): { untrusted: true; value: T } {
  return { untrusted: true, value };
}

const untrustedString = untrusted(z.string());
const untrustedStringNullable = untrusted(z.string()).nullable();

/** Coarse, derived run-failure classification (trusted — KiCI computes it). */
export const AgentFailureCategory = z.enum([
  'init_failure',
  'timed_out',
  'step_failed',
  'cancelled',
  'infra',
  'unknown',
]);
export type AgentFailureCategory = z.infer<typeof AgentFailureCategory>;

export const agentStepResultSchema = z.object({
  stepIndex: z.number().int(),
  stepName: untrustedString,
  status: ExecutionStepStatus,
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  errorMessage: untrustedStringNullable,
  /** Existing `step_type` discriminator (e.g. `step`, `hook:cleanup`, `cache:save`). */
  stepType: z.string(),
  checkOutcome: CheckStepOutcome.nullable(),
  /** Secret context key names accessed by this step — names only, never values. */
  secretsAccessed: z.array(z.string()),
});
export type AgentStepResult = z.infer<typeof agentStepResultSchema>;

export const agentJobResultSchema = z.object({
  jobId: z.string(),
  jobName: untrustedString,
  status: ExecutionJobStatus,
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  agentId: z.string().nullable(),
  errorMessage: untrustedStringNullable,
  initFailure: z
    .object({
      scope: z.enum(['run', 'job']),
      category: InitFailureCategory,
      message: untrustedString,
    })
    .nullable(),
  needs: z.array(
    z.object({
      ref: untrustedString,
      runOn: z.array(ExecutionJobStatus),
    }),
  ),
  /** Non-secret job outputs only (secret outputs are surfaced as key names). */
  outputs: z.record(z.string(), untrustedString).nullable(),
  /** Secret output key names produced by this job — names only, never values. */
  secretOutputKeys: z.array(z.string()),
  steps: z.array(agentStepResultSchema),
});
export type AgentJobResult = z.infer<typeof agentJobResultSchema>;

export const agentRunResultSchema = z.object({
  runId: z.string(),
  workflowName: untrustedString,
  status: ExecutionRunStatus,
  provider: z.string(),
  repoIdentifier: untrustedString,
  ref: untrustedString,
  sha: z.string(),
  /** Best-effort base commit (provider context); null when unavailable. */
  baseSha: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  trustTier: TrustTierSchema.nullable(),
  contributorUsername: untrustedStringNullable,
  failureCategory: AgentFailureCategory.nullable(),
  failureReason: untrustedStringNullable,
  /** Identity that triggered a re-run (null for webhook-triggered runs). */
  triggeredBy: z.string().nullable(),
  jobs: z.array(agentJobResultSchema),
});
export type AgentRunResult = z.infer<typeof agentRunResultSchema>;

export const agentStepLogsSchema = z.object({
  runId: z.string(),
  jobId: z.string(),
  stepIndex: z.number().int(),
  totalLines: z.number().int(),
  /** Every log line is user/process-controlled — each is enveloped untrusted. */
  lines: z.array(untrustedString),
  nextCursor: z.string().nullable(),
});
export type AgentStepLogs = z.infer<typeof agentStepLogsSchema>;
