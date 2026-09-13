/**
 * Canonical trigger event types with human-readable metadata.
 *
 * These correspond to SimulatedEvent.type values produced by normalizers,
 * plus 'rerun' for re-run events. Adding a new event type here forces
 * compile-time failures in any exhaustive Record<TriggerEventType, ...>
 * (e.g., the dashboard icon map).
 */

export const TRIGGER_EVENT_TYPES = [
  'pull_request',
  'push',
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
  'webhook',
  'kici_event',
  'workflow_complete',
  'workflows_failed_batch',
  'job_complete',
  'generic_webhook',
  'schedule',
  'lifecycle',
  'rerun',
  'manual_schedule',
] as const;

export type TriggerEventType = (typeof TRIGGER_EVENT_TYPES)[number];

export const TRIGGER_EVENT_META: Record<TriggerEventType, { label: string }> = {
  pull_request: { label: 'Pull request' },
  push: { label: 'Push' },
  tag: { label: 'Tag' },
  comment: { label: 'Comment' },
  review: { label: 'Review' },
  review_comment: { label: 'Review comment' },
  release: { label: 'Release' },
  dispatch: { label: 'Dispatch' },
  create: { label: 'Create' },
  delete: { label: 'Delete' },
  status: { label: 'Status' },
  workflow_run: { label: 'Workflow run' },
  fork: { label: 'Fork' },
  star: { label: 'Star' },
  watch: { label: 'Watch' },
  webhook: { label: 'Webhook' },
  kici_event: { label: 'KiCI event' },
  workflow_complete: { label: 'Workflow complete' },
  workflows_failed_batch: { label: 'Workflows failed batch' },
  job_complete: { label: 'Job complete' },
  generic_webhook: { label: 'Generic webhook' },
  schedule: { label: 'Schedule' },
  lifecycle: { label: 'Lifecycle' },
  rerun: { label: 'Re-run' },
  manual_schedule: { label: 'Manual schedule' },
};

/**
 * The event types that carry a pull request: the PR itself plus the two review
 * events that hang off one. Each has a HEAD that a contributor controls and a
 * BASE that the repository owner does, so an identity derived from the base
 * alone cannot tell one from a push to that same base branch.
 */
export const PULL_REQUEST_FAMILY_TRIGGER_EVENTS = [
  'pull_request',
  'review',
  'review_comment',
] as const satisfies ReadonlyArray<TriggerEventType>;

/**
 * True when a persisted `trigger_event` names a pull-request-family event.
 *
 * The stored value is `<type>` or `<type>:<action>` (`buildTriggerEvent`), so
 * the action is stripped before the comparison. A null or unrecognised value
 * reads as NOT PR-family, which is the conservative direction: it keeps the
 * branch-shaped identity, which a trust policy can still constrain by ref.
 */
export function isPullRequestFamilyTriggerEvent(triggerEvent: string | null | undefined): boolean {
  if (!triggerEvent) return false;
  const type = triggerEvent.split(':', 1)[0];
  return (PULL_REQUEST_FAMILY_TRIGGER_EVENTS as readonly string[]).includes(type);
}
