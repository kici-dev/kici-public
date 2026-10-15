/**
 * Execution-tracker doubles and `onExecutionStarted` argument builders the
 * orchestrator tests share.
 */
import { vi, type Mock } from 'vitest';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';

type StartArgs = Parameters<ExecutionTracker['onExecutionStarted']>;

/** The `onExecutionStarted` parameter names, in signature order. */
export const START_RUN_PARAMS = [
  'runId',
  'workflowName',
  'provider',
  'repoIdentifier',
  'ref',
  'sha',
  'deliveryId',
  'providerContext',
  'triggerDecision',
  'jobs',
  'routingKey',
  'dispatchedContexts',
  'triggerEvent',
  'commitMessage',
  'parentRunId',
  'triggeredBy',
  'originalRunId',
  'concurrency',
  'workflowTimeoutMs',
  'checkMode',
  'localWorkingTree',
  'triggerActorUsername',
  'triggerActorUserId',
  'triggeredByAgentLabel',
  'prNumber',
  'workflowRepo',
  'eventContext',
] as const;

type ParamIndex = Extract<keyof typeof START_RUN_PARAMS, `${number}`>;

/** `onExecutionStarted` arguments by name; each one omitted takes its default or stays unset. */
export type StartRunOptions = {
  [I in ParamIndex as (typeof START_RUN_PARAMS)[I]]?: I extends keyof StartArgs
    ? StartArgs[I]
    : never;
};

/** The ten required positions, with the values the tracker tests share. */
function requiredDefaults(): StartRunOptions {
  return {
    runId: 'run-1',
    workflowName: 'ci',
    provider: 'github',
    repoIdentifier: 'owner/repo',
    ref: 'refs/heads/main',
    sha: 'abc123',
    deliveryId: 'delivery-1',
    providerContext: {},
    triggerDecision: null,
    jobs: [],
  };
}

const REQUIRED_COUNT = 10;

/**
 * The positional `onExecutionStarted` arguments for `o`. The list ends at the
 * last option `o` names, so an optional position after it is left out rather
 * than passed as `undefined`.
 */
export function startRunArgs(o: StartRunOptions = {}): StartArgs {
  const values: Record<string, unknown> = { ...requiredDefaults(), ...o };
  let length = REQUIRED_COUNT;
  START_RUN_PARAMS.forEach((name, i) => {
    if (name in o) length = Math.max(length, i + 1);
  });
  return START_RUN_PARAMS.slice(0, length).map((name) => values[name]) as StartArgs;
}

/** Call `tracker.onExecutionStarted` with {@link startRunArgs}. */
export function startRun(
  tracker: Pick<ExecutionTracker, 'onExecutionStarted'>,
  o: StartRunOptions = {},
): Promise<void> {
  return tracker.onExecutionStarted(...startRunArgs(o));
}

export interface MockExecutionTracker {
  onExecutionStarted: Mock;
  addJobsToRun: Mock;
  holdRunForPendingJobs: Mock;
  releasePendingJobsHold: Mock;
  onJobStatus: Mock;
  onStepStatus: Mock;
  updateJobHeartbeat: Mock;
  getExecutionContext: Mock;
  getJobName: Mock;
  recordInitFailureRun: Mock;
}

/**
 * The tracker double the pipeline tests pass as `executionTracker`. It has no
 * `onJobReadyCallback`: the dispatch path probes for that method and takes a
 * different branch when it exists, so a test that needs it adds it.
 */
export function mockExecutionTracker(): MockExecutionTracker {
  return {
    onExecutionStarted: vi.fn().mockResolvedValue(undefined),
    addJobsToRun: vi.fn().mockResolvedValue(undefined),
    holdRunForPendingJobs: vi.fn(() => true),
    releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
    onJobStatus: vi.fn().mockResolvedValue(undefined),
    onStepStatus: vi.fn(),
    updateJobHeartbeat: vi.fn(),
    getExecutionContext: vi.fn(),
    getJobName: vi.fn(),
    recordInitFailureRun: vi.fn().mockResolvedValue(undefined),
  };
}
