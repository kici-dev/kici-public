import { z } from 'zod';

// --- Platform -> Orchestrator: Log pull request/response only ---
// Live logs flow via the push-based log.chunk -> BrowserFanOut path.
// Only request/response for historical log retrieval is needed here.

/** Request historical logs for a completed or running execution. */
const logRequestSchema = z.object({
  type: z.literal('log.request'),
  messageId: z.string(),
  executionId: z.string(),
  jobName: z.string().optional(),
  stepIndex: z.number().optional(),
  cursor: z.number().optional(),
  limit: z.number().optional(),
});

/** Response with log data (correlates to log.request). */
const logResponseSchema = z.object({
  type: z.literal('log.response'),
  messageId: z.string(),
  executionId: z.string(),
  chunks: z.array(
    z.object({
      jobName: z.string(),
      stepIndex: z.number(),
      lines: z.array(z.string()),
      timestamp: z.number(),
    }),
  ),
  cursor: z.number().optional(),
  complete: z.boolean(),
  error: z.string().optional(),
});

// --- Direction-specific exports (single schemas, no union needed) ---

/** Log pull messages flowing from Platform to Orchestrator. */
export const logPullPlatformToOrchSchema = logRequestSchema;

/** Log pull messages flowing from Orchestrator to Platform. */
export const logPullOrchToPlatformSchema = logResponseSchema;
