/**
 * Zod argument schemas for the KiCI developer MCP tools.
 *
 * Browser-safe (zod only) so they live in the shared engine barrel. Each export
 * is a Zod *raw shape* (a plain object of Zod fields) so it can be passed
 * directly as an MCP tool `inputSchema`. The Platform-hosted developer MCP
 * server (packages/platform/src/mcp/server.ts) is the consumer.
 */
import { z } from 'zod';

/**
 * Optional organization id. When the calling user belongs to exactly one org
 * it is resolved automatically; pass it explicitly when a member of several.
 */
const orgIdArg = z
  .string()
  .min(1)
  .optional()
  .describe('Organization id. Optional when you belong to exactly one organization.');

export const listRunsToolSchema = {
  orgId: orgIdArg,
  status: z.string().optional().describe('Filter by run status (e.g. success, failed, running).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Maximum number of runs to return (default 20).'),
};

export const getRunToolSchema = {
  orgId: orgIdArg,
  runId: z.string().min(1).describe('The run id to fetch.'),
};

export const getStepLogsToolSchema = {
  orgId: orgIdArg,
  runId: z.string().min(1).describe('The run id.'),
  jobId: z.string().min(1).describe('The job id within the run.'),
  stepIndex: z.number().int().min(0).describe('Zero-based step index within the job.'),
  cursor: z
    .string()
    .optional()
    .describe('Opaque pagination cursor from a prior response nextCursor.'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum number of log lines to return (capped server-side).'),
};

export const listWorkflowsToolSchema = {
  orgId: orgIdArg,
  stale: z
    .string()
    .optional()
    .describe('Only workflows not triggered within this duration (e.g. 30d, 7d, 24h, 2h).'),
  triggerType: z.string().optional().describe('Filter by trigger type (e.g. push, pull_request).'),
  repo: z.string().optional().describe('Filter by repository identifier.'),
};

/** No arguments — lists the organizations the calling user belongs to. */
export const listOrgsToolSchema = {};

export const listSecretsToolSchema = {
  orgId: orgIdArg,
};

export const listOrchestratorsToolSchema = {
  orgId: orgIdArg,
};

export const getDiagnosticsToolSchema = {
  orgId: orgIdArg,
};

export const cancelRunToolSchema = {
  orgId: orgIdArg,
  runId: z.string().min(1).describe('The run id to cancel.'),
  force: z.boolean().optional().describe('Force-cancel (SIGKILL, skip cleanup hooks).'),
};

export const rerunRunToolSchema = {
  orgId: orgIdArg,
  runId: z.string().min(1).describe('The run id to re-run.'),
};

export const triggerRunToolSchema = {
  orgId: orgIdArg,
  registrationId: z.string().min(1).describe('The workflow registration id to trigger.'),
};

/**
 * The two filters that separate holds a job name cannot. One job can carry more
 * than one pending hold — an SDK `requireApproval` paired with a security-typed
 * context gate writes two job-scoped rows under one job name — so `job` alone is
 * ambiguous for that shape, and the error listing names these instead.
 */
const holdTypeArg = z
  .string()
  .optional()
  .describe(
    'Hold type (reviewer, timer, concurrency, security), when one job carries more than one hold.',
  );
const holdIdArg = z
  .string()
  .optional()
  .describe(
    'A specific hold id, as printed in the candidate list when nothing else separates them.',
  );

export const approveRunToolSchema = {
  orgId: orgIdArg,
  runId: z.string().min(1).describe('The run whose held approval gate to approve.'),
  job: z.string().optional().describe('Job name, to disambiguate when the run has multiple holds.'),
  step: z
    .string()
    .optional()
    .describe('Zero-based step index (requires job) for a step-scoped hold.'),
  holdType: holdTypeArg,
  holdId: holdIdArg,
};

export const rejectRunToolSchema = {
  orgId: orgIdArg,
  runId: z.string().min(1).describe('The run whose held approval gate to reject.'),
  job: z.string().optional().describe('Job name, to disambiguate when the run has multiple holds.'),
  step: z
    .string()
    .optional()
    .describe('Zero-based step index (requires job) for a step-scoped hold.'),
  holdType: holdTypeArg,
  holdId: holdIdArg,
  reason: z.string().min(1).describe('Why the gate is rejected (required).'),
};

export const cancelRunsByBranchToolSchema = {
  orgId: orgIdArg,
  branch: z.string().min(1).describe('Cancel all in-progress runs on this branch (ref).'),
};
