import { z } from 'zod';

/**
 * Trigger types whose owning workflows are stored in workflow_registrations, so
 * the orchestrator resolves them by index lookup instead of re-fetching a lock
 * file per inbound event.
 *
 *   1. Non-Git-provider triggers (kici_event, schedule, webhook, lifecycle, …)
 *      have no per-repo lock file pipeline, so the index is authoritative.
 *
 *   2. Git-provider triggers (push, pr, tag, release, …) are still matched via
 *      the per-event lock file pipeline on the same-source path. Registering
 *      them too enables cross-source dispatch for a generic webhook targeting an
 *      externally hosted repo: the cross-source branch looks up
 *      `(customer_id, repo_identifier)` and reuses the stored `provider_context`
 *      (installation id, app id, …) to mint credentials for the provider bundle
 *      that owns the repo. Otherwise a `push()`-only workflow is invisible to
 *      cross-source dispatch, and generic webhooks targeting its repo silently no-op.
 */
export const RegisterableTriggerType = z.enum([
  // Non-Git-provider triggers
  'kici_event',
  'workflow_complete',
  'workflows_failed_batch',
  'job_complete',
  'generic_webhook',
  'schedule',
  'lifecycle',
  'webhook',
  // Git-provider triggers: an additive index for cross-source dispatch, not a
  // replacement for the same-source lock file pipeline.
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
