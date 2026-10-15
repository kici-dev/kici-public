/**
 * Annotates a `processed` event-log row whose path filters ran against an
 * unavailable changed-files diff, in the existing free-text field (no new
 * status enum value), so the outcome is never a silent `processed / matched 0`.
 */
export const DEGRADED_CHANGED_FILES_REASON =
  'trigger evaluation degraded: changed files unavailable — path filters matched conservatively';
