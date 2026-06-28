/**
 * Zod argument schemas for the KiCI MCP tools.
 *
 * Browser-safe (zod only) and shared between the Platform-hosted developer MCP
 * and the sibling orchestrator-side admin MCP so both expose an identical tool
 * argument contract. Each export is a Zod *raw shape* (a plain object of Zod
 * fields) so it can be passed directly as an MCP tool `inputSchema`.
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
};

export const listWorkflowsToolSchema = {
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
