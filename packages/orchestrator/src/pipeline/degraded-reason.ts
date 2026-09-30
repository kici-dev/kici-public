/**
 * Annotation written to a `processed` event-log row when path filters were
 * evaluated against an unavailable changed-files diff. Reuses the existing
 * free-text field so the outcome is never a silent `processed / matched 0` —
 * no new event-log status enum value is added.
 */
export const DEGRADED_CHANGED_FILES_REASON =
  'trigger evaluation degraded: changed files unavailable — path filters matched conservatively';
