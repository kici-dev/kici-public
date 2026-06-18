import type { LockFile, LockTrigger, LockWorkflow } from '@kici-dev/engine';
import { RegisterableTriggerType } from '@kici-dev/engine';

/**
 * Trigger types that cause a workflow to be stored in workflow_registrations.
 *
 * Non-Git-provider triggers (kici_event, schedule, webhook, …) live in the
 * registration table because they have no per-repo lock file pipeline to
 * fall back to. Git-provider triggers (push, pr, tag, …) ALSO live in the
 * registration table so that the cross-source dispatch path (phase 28.5)
 * can resolve them by (customer_id, repo_identifier) when a generic webhook
 * targets an externally-hosted repo. The per-event lock file pipeline still
 * handles same-source dispatch for git triggers; registration is an additive
 * index.
 */
const REGISTERABLE_TRIGGER_TYPES: ReadonlySet<string> = new Set(RegisterableTriggerType.options);

/**
 * Check whether a trigger has repo patterns, indicating
 * it is part of a global workflow that matches across repositories.
 */
export function hasRepoPatterns(trigger: LockTrigger): boolean {
  const t = trigger as unknown as Record<string, unknown>;
  return 'repos' in t && Array.isArray(t.repos) && (t.repos as unknown[]).length > 0;
}

/**
 * Extract workflows that have at least one trigger with repo patterns.
 * These are "global workflows" that match events across repositories.
 *
 * @param lockFile - The compiled lock file to extract from
 * @returns Workflows that have at least one trigger with repo patterns
 */
export function extractGlobalWorkflows(lockFile: LockFile): LockWorkflow[] {
  return lockFile.workflows.filter((w) => w.triggers.some((t) => hasRepoPatterns(t)));
}

/**
 * Extract workflows that have at least one registerable trigger, OR that
 * have repo patterns (global workflows).
 *
 * Since phase 28.5, Git-provider triggers (push, pr, tag, …) are ALSO
 * registerable so cross-source dispatch can resolve them via the registration
 * index when a generic webhook targets an externally-hosted repo. The
 * per-event lock file pipeline remains the primary matching path for
 * same-source git events; registration is an additive index.
 *
 * @param lockFile - The compiled lock file to extract from
 * @returns Workflows that have at least one registerable trigger or repo patterns
 */
export function extractRegisterableWorkflows(lockFile: LockFile): LockWorkflow[] {
  return lockFile.workflows.filter((w) =>
    w.triggers.some((t) => REGISTERABLE_TRIGGER_TYPES.has(t._type) || hasRepoPatterns(t)),
  );
}

/** Exposed for testing */
export { REGISTERABLE_TRIGGER_TYPES };
