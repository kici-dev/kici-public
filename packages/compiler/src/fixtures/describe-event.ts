/**
 * Describe the event type from a fixture's trigger config, for the fixtures
 * table and the interactive picker.
 *
 * A fixture's `event` is an SDK `TriggerConfig`, discriminated by the `_tag`
 * field (e.g. `PushTrigger`, `PrTrigger`). This maps each tag to a short,
 * human-readable event label.
 */
const TAG_TO_EVENT: Record<string, string> = {
  PushTrigger: 'push',
  PrTrigger: 'pr',
  TagTrigger: 'tag',
  CommentTrigger: 'comment',
  ReviewTrigger: 'review',
  ReviewCommentTrigger: 'review_comment',
  ReleaseTrigger: 'release',
  DispatchTrigger: 'dispatch',
  CreateTrigger: 'create',
  DeleteTrigger: 'delete',
  StatusTrigger: 'status',
  WorkflowRunTrigger: 'workflow_run',
  ForkTrigger: 'fork',
  StarTrigger: 'star',
  WatchTrigger: 'watch',
  KiciEventTrigger: 'kici_event',
  WorkflowCompleteTrigger: 'workflow_complete',
  JobCompleteTrigger: 'job_complete',
  GenericWebhookTrigger: 'generic_webhook',
  ScheduleTrigger: 'schedule',
  LifecycleTrigger: 'lifecycle',
  WebhookTrigger: 'webhook',
};

export function describeEvent(event: unknown): string {
  if (!event || typeof event !== 'object') return 'unknown';
  const e = event as Record<string, unknown>;
  const tag = e._tag;
  if (typeof tag !== 'string') return 'custom';
  const label = TAG_TO_EVENT[tag];
  if (!label) return 'custom';
  if (tag === 'PrTrigger' && Array.isArray(e.events) && e.events.length > 0) {
    return `pr:${String(e.events[0])}`;
  }
  return label;
}
