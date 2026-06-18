import { z } from 'zod';

/**
 * Trigger types whose owning workflows must be stored in workflow_registrations
 * so the orchestrator can resolve them from an index lookup instead of
 * re-fetching a lock file per inbound event.
 *
 * Two families live in this list:
 *
 *   1. Non-Git-provider triggers (kici_event, schedule, webhook, lifecycle, …)
 *      — these have no per-repo lock file pipeline to fall back to, so the
 *      registration index is the authoritative source for matching.
 *
 *   2. Git-provider triggers (push, pr, tag, release, …) — these ARE still
 *      matched via the per-event lock file pipeline on the same-source path
 *      (e.g. a real GitHub push webhook). Registering them in addition is
 *      what makes cross-source dispatch work for a generic webhook that
 *      targets an externally-hosted repo (phase 28.5): the cross-source
 *      branch looks up `(customer_id, repo_identifier)` and reuses the
 *      stored `provider_context` (installation id, app id, …) to mint
 *      credentials for the actual provider bundle that owns the repo.
 *      Without this, a workflow whose only trigger is `push()` is invisible
 *      to cross-source dispatch and generic webhooks targeting its repo
 *      silently no-op.
 *
 * Access values: RegisterableTriggerType.enum.kici_event, etc.
 */
export const RegisterableTriggerType = z.enum([
  // Non-Git-provider triggers
  'kici_event',
  'workflow_complete',
  'job_complete',
  'generic_webhook',
  'schedule',
  'lifecycle',
  'webhook',
  // Git-provider triggers (indexed for cross-source dispatch — see phase 28.5).
  // These continue to be evaluated via the per-event lock file pipeline on the
  // same-source path; registration is an additive index, not a replacement.
  'push',
  'pr',
  'tag',
  'comment',
  'review',
  'review_comment',
  'release',
  'dispatch',
  'create',
  'delete',
  'status',
  'workflow_run',
  'fork',
  'star',
  'watch',
]);
export type RegisterableTriggerType = z.infer<typeof RegisterableTriggerType>;
