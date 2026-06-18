/**
 * Dashboard REST-over-WS protocol messages for org-level global workflow settings.
 *
 * Platform forwards these requests over the coordinator WS to the orchestrator,
 * which owns the `org_settings` table. The orchestrator responds with the
 * current (or patched) row projected into the shape below.
 *
 * Exposed via the `@kici-dev/engine/protocol/dashboard-global-workflows` subpath
 * export (not the barrel) so server consumers can import without pulling
 * anything unrelated into the dashboard bundle.
 *
 * Each repo-list entry is a `{routingKey?, pattern}` object. When
 * `routingKey` is absent, the entry applies to events / workflows from any
 * source in the org. When present, it qualifies the entry to a single
 * webhook source (e.g., `github:42` vs `generic:org:abcd`).
 *
 * Three independent policy axes (see GlobalWorkflowPolicy in the orchestrator):
 *   - `allowedRepos` restricts which repos may AUTHOR global workflows.
 *   - `deniedRepos` blocks global dispatches for events FROM these SOURCE repos.
 *   - `elevatedRepos` lists workflow-author repos with access to source secrets.
 */
import { z } from 'zod';
import { actorPrincipalSchema } from './actor.js';

/**
 * One entry in any of the three repo-pattern lists. `routingKey` is the
 * source-qualifier; when absent the entry applies to any source in the org.
 */
export const repoPatternEntrySchema = z.object({
  routingKey: z.string().min(1).optional(),
  pattern: z.string().min(1),
});

export type RepoPatternEntry = z.infer<typeof repoPatternEntrySchema>;

/** Projected org-level global workflow settings. */
export const globalWorkflowSettingsSchema = z.object({
  customerId: z.string(),
  enabled: z.boolean(),
  allowedRepos: z.array(repoPatternEntrySchema).nullable(),
  deniedRepos: z.array(repoPatternEntrySchema).nullable(),
  elevatedRepos: z.array(repoPatternEntrySchema).nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export type GlobalWorkflowSettings = z.infer<typeof globalWorkflowSettingsSchema>;

// --- Platform -> Orchestrator: request messages ---

/** Request the current global-workflow settings row. */
export const globalWorkflowsGetRequestSchema = z.object({
  type: z.literal('dashboard.global-workflows.get'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
});

/**
 * Patch the global-workflow settings row (upserts if missing).
 *
 * Every field is optional. `null` clears the corresponding list column
 * (e.g., `allowedRepos: null` means "all repos pass the allow-list").
 */
export const globalWorkflowsUpdateRequestSchema = z.object({
  type: z.literal('dashboard.global-workflows.update'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
  enabled: z.boolean().optional(),
  allowedRepos: z.array(repoPatternEntrySchema).nullable().optional(),
  deniedRepos: z.array(repoPatternEntrySchema).nullable().optional(),
  elevatedRepos: z.array(repoPatternEntrySchema).nullable().optional(),
});

// --- Orchestrator -> Platform: response messages ---

export const globalWorkflowsGetResponseSchema = z.object({
  type: z.literal('dashboard.global-workflows.get.response'),
  requestId: z.string(),
  settings: globalWorkflowSettingsSchema.optional(),
  error: z.string().optional(),
});

export const globalWorkflowsUpdateResponseSchema = z.object({
  type: z.literal('dashboard.global-workflows.update.response'),
  requestId: z.string(),
  settings: globalWorkflowSettingsSchema.optional(),
  error: z.string().optional(),
});

// --- Inferred types ---

export type GlobalWorkflowsGetRequest = z.infer<typeof globalWorkflowsGetRequestSchema>;
export type GlobalWorkflowsUpdateRequest = z.infer<typeof globalWorkflowsUpdateRequestSchema>;
export type GlobalWorkflowsGetResponse = z.infer<typeof globalWorkflowsGetResponseSchema>;
export type GlobalWorkflowsUpdateResponse = z.infer<typeof globalWorkflowsUpdateResponseSchema>;
