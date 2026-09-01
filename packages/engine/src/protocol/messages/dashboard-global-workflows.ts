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
 *   - `elevatedRepos` is DEPRECATED and not enforced — see the field comments
 *     below and `docs/user/deprecations.md`.
 */
import { z } from 'zod';
import { negatedPatternReason } from '../../repo/pattern-negation.js';
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

/**
 * Why a pattern may not be stored on a global-workflow policy list, or null
 * when it is acceptable.
 *
 * The lists match each entry as a single glob, so a negated pattern inverts to
 * "everything except" — on an allow list that allows almost every repo, on a
 * deny list it denies almost every repo. The list's own direction already
 * encodes allow/deny, so negation forms are rejected at write time.
 *
 * This is deliberately not folded into `repoPatternEntrySchema`: the schema is
 * also the read path for rows already in `org_settings`, which must keep
 * parsing. Evaluation handles a stored negation form by failing closed.
 *
 * Which forms count as a negation is not decided here: it comes from the one
 * classifier in `repo/pattern-negation.js`, shared with the Platform's
 * repo-scope allow-list. Keeping the verdict in one place is what stops this
 * list and that one from reading the same pattern language two different ways —
 * notably the regular-expression assertions `(?!…)` / `(?<!…)`, which picomatch
 * compiles into a real inversion, and `[!…]`, which it does not.
 */
export function invalidRepoPatternReason(pattern: string): string | null {
  if (pattern.trim() === '') return 'pattern is empty';
  const negation = negatedPatternReason(pattern);
  if (negation) {
    return `${negation} is not allowed on a policy list — the list's direction already encodes allow/deny`;
  }
  return null;
}

/** Projected org-level global workflow settings. */
export const globalWorkflowSettingsSchema = z.object({
  customerId: z.string(),
  /**
   * The effective fleet-wide master switch
   * (`cluster_settings.global_workflows_enabled`, set with `kici-admin
   * cluster-settings`). Read-only here — the dashboard renders it as a status
   * badge; it is not a per-org value and cannot be flipped from the dashboard.
   */
  enabled: z.boolean(),
  allowedRepos: z.array(repoPatternEntrySchema).nullable(),
  deniedRepos: z.array(repoPatternEntrySchema).nullable(),
  /**
   * @deprecated Stored and echoed back, but never enforced: an organization-wide
   * workflow's job is dispatched with no secret material at all, so there is no
   * secret access for this list to widen. Removal at v1.0.0.
   */
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
 *
 * The master enable switch is NOT here: it is fleet-wide
 * (`cluster_settings.global_workflows_enabled`, set with `kici-admin
 * cluster-settings`), not per-org. `.strict()` so a client that still sends
 * `enabled` gets a validation failure instead of a silently dropped field.
 */
export const globalWorkflowsUpdateRequestSchema = z
  .object({
    type: z.literal('dashboard.global-workflows.update'),
    requestId: z.string(),
    actor: actorPrincipalSchema,
    allowedRepos: z.array(repoPatternEntrySchema).nullable().optional(),
    deniedRepos: z.array(repoPatternEntrySchema).nullable().optional(),
    /** @deprecated Accepted and stored, but never enforced. Removal at v1.0.0. */
    elevatedRepos: z.array(repoPatternEntrySchema).nullable().optional(),
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
