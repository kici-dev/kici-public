/**
 * The storage key of one step's log. The log writer, the `execution_steps`
 * row's `log_path`, and the step-log readers all build it here, so they agree
 * on the layout. A job's workflow-level log is step `-1`, stored as
 * `step--1.log`.
 */
export function stepLogPath(runId: string, jobName: string, stepIndex: number): string {
  return `executions/${runId}/job-${jobName}/step-${stepIndex}.log`;
}
