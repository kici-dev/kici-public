/**
 * Stable identity of a schedule trigger for last-fired bookkeeping.
 *
 * Two schedule triggers are the same schedule iff they share cron expression
 * AND timezone (same instants, same dispatch; the matcher keys on
 * cronExpression). The orchestrator's `cron_last_fired` table is keyed by
 * (registration_id, this key), so each distinct schedule is tracked independently.
 *
 * Newline-joined so migration SQL reproduces it byte-for-byte:
 * `cronExpression || E'\n' || timezone`.
 */
export function scheduleTriggerKey(cronExpression: string, timezone: string): string {
  return `${cronExpression}\n${timezone}`;
}
