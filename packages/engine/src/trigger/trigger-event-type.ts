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
  job_complete: { label: 'Job complete' },
  generic_webhook: { label: 'Generic webhook' },
  schedule: { label: 'Schedule' },
  lifecycle: { label: 'Lifecycle' },
  rerun: { label: 'Re-run' },
  manual_schedule: { label: 'Manual schedule' },
};
