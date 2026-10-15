/**
 * Dashboard REST-over-WS messages for org-level global workflow settings. The
 * Platform forwards them over the coordinator WS to the orchestrator, which
 * owns `org_settings` and answers with the current (or patched) row projected
 * into the shape below.
 *
 * Exposed via the `@kici-dev/engine/protocol/dashboard-global-workflows` subpath
 * (not the barrel) so server consumers pull nothing unrelated into the
 * dashboard bundle.
 *
 * Two independent policy axes (see GlobalWorkflowPolicy in the orchestrator):
 *   - `allowedRepos` restricts which repos may AUTHOR global workflows.
 *   - `deniedRepos` blocks global dispatches for events FROM these SOURCE repos.
 */
import { z } from 'zod';
import { negatedPatternReason } from '../../repo/pattern-negation.js';
import { actorPrincipalSchema } from './actor.js';

/**
 * One entry in either repo-pattern list. `routingKey` limits it to one webhook
 * source (e.g. `github:42` vs `generic:org:abcd`); absent, it applies to any
 * source in the org.
 */
export const repoPatternEntrySchema = z.object({
  routingKey: z.string().min(1).optional(),
  pattern: z.string().min(1),
});

export type RepoPatternEntry = z.infer<typeof repoPatternEntrySchema>;

/**
 * Why a pattern may not be stored on a global-workflow policy list, or null
 * when it is acceptable.
 *
 * Each entry matches as a single glob, so a negated pattern inverts to
 * "everything except": an allow list would allow, and a deny list deny, almost
 * every repo. The list's direction already encodes allow/deny, so negations are
 * rejected at write time.
 *
 * Not folded into `repoPatternEntrySchema`: that schema also reads rows already
 * in `org_settings`, which must keep parsing. Evaluation fails closed on a
 * stored negation.
 *
 * What counts as a negation comes from the one classifier in
 * `repo/pattern-negation.js`, shared with the Platform's repo-scope allow-list
 * so both read the pattern language the same way — notably `(?!…)` / `(?<!…)`,
 * which picomatch compiles into a real inversion, and `[!…]`, which it does not.
 */
export function invalidRepoPatternReason(pattern: string): string | null {
  if (pattern.trim() === '') return 'pattern is empty';
  const negation = negatedPatternReason(pattern);
  if (negation) {
    return `${negation} is not allowed on a policy list — the list's direction already encodes allow/deny`;
  }
  return null;
}

/**
 * Projected org-level global workflow settings. `.strict()` rejects an
 * orchestrator that echoes the removed elevated-access list: it runs a build
 * below this protocol floor.
 */
export const globalWorkflowSettingsSchema = z
  .object({
    customerId: z.string(),
    /**
     * The effective fleet-wide master switch
     * (`cluster_settings.global_workflows_enabled`, set with `kici-admin
     * cluster-settings`). Not per-org: the dashboard shows it read-only as a badge.
     */
    enabled: z.boolean(),
    allowedRepos: z.array(repoPatternEntrySchema).nullable(),
    deniedRepos: z.array(repoPatternEntrySchema).nullable(),
    createdAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
  })
  .strict();

export type GlobalWorkflowSettings = z.infer<typeof globalWorkflowSettingsSchema>;

// --- Platform -> Orchestrator: request messages ---

/** Request the current global-workflow settings row. */
export const globalWorkflowsGetRequestSchema = z.object({
  type: z.literal('dashboard.global-workflows.get'),
  requestId: z.string(),
  actor: actorPrincipalSchema,
});

/**
 * Patch the global-workflow settings row (upserts if missing). `null` clears a
 * list column (`allowedRepos: null` means "all repos pass the allow-list").
 *
 * The master switch is fleet-wide, not here. `.strict()` so a client that
 * still sends `enabled` fails validation instead of having it silently dropped.
 */
export const globalWorkflowsUpdateRequestSchema = z
  .object({
    type: z.literal('dashboard.global-workflows.update'),
    requestId: z.string(),
    actor: actorPrincipalSchema,
    allowedRepos: z.array(repoPatternEntrySchema).nullable().optional(),
    deniedRepos: z.array(repoPatternEntrySchema).nullable().optional(),
  })
  .strict();

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
