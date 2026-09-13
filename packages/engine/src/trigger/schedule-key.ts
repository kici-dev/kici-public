/**
 * Stable identity of a schedule trigger for last-fired bookkeeping.
 *
 * Two schedule triggers are "the same schedule" iff they share a cron
 * expression AND timezone — they fire at the same instants and dispatch
 * identically (the trigger matcher keys on cronExpression). The orchestrator's
 * `cron_last_fired` table is keyed by (registration_id, this key) so every
 * distinct schedule of a workflow is fired and tracked independently.
 *
 * The format is intentionally trivial (newline-joined) so migration SQL can
 * reproduce it byte-for-byte: `cronExpression || E'\n' || timezone`.
 */
export function scheduleTriggerKey(cronExpression: string, timezone: string): string {
  return `${cronExpression}\n${timezone}`;
}
