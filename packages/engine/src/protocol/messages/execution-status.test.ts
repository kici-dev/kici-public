import { describe, expect, it } from 'vitest';
import {
  CacheOutcome,
  CacheRunEventType,
  CacheStepType,
  ExecutionJobStatus,
  ExecutionRunStatus,
  ExecutionStepStatus,
  StepConcurrencyKind,
  InitFailureCategory,
  TERMINAL_JOB_STATES,
  TERMINAL_RUN_STATES,
  TimeoutReason,
  executionStatusSchema,
  initFailureSchema,
  jobStatusForwardSchema,
  stepStatusForwardSchema,
  stateReplaySchema,
  STATUS_ID_MAX,
  STATUS_FREE_TEXT_MAX,
  REPO_IDENTIFIER_MAX,
  STATE_REPLAY_MAX_RUNS,
  MAX_JOBS_PER_RUN,
  RUNS_ON_LABELS_MAX,
} from './execution-status.js';
import { orchestratorToPlatformMessageSchema } from './platform-orchestrator.js';

describe('jobStatusForwardSchema', () => {
  const validJobStatus = {
    type: 'job.status.forward' as const,
    messageId: 'msg-700',
    runId: 'run-001',
    jobId: 'build-1',
    jobName: 'build',
    status: 'running' as const,
    matrixValues: { os: 'ubuntu', node: '20' },
    startedAt: 1700000000000,
    completedAt: 1700000060000,
    durationMs: 60000,
    agentId: 'scaler-container-abc123',
    orchestratorId: 'orch-node1-deadbeef',
    timestamp: 1700000060000,
  };

  it('validates a valid job status message with all fields', () => {
    const parsed = jobStatusForwardSchema.parse(validJobStatus);
    expect(parsed).toEqual(validJobStatus);
  });

  it('validates with optional fields omitted (matrixValues, startedAt, completedAt, durationMs)', () => {
    const minimal = {
      type: 'job.status.forward',
      messageId: 'msg-701',
      runId: 'run-002',
      jobId: 'test-1',
      jobName: 'test',
      status: 'pending',
      timestamp: 1700000000000,
    };
    const parsed = jobStatusForwardSchema.parse(minimal);
    expect(parsed.matrixValues).toBeUndefined();
    expect(parsed.startedAt).toBeUndefined();
    expect(parsed.completedAt).toBeUndefined();
    expect(parsed.durationMs).toBeUndefined();
  });

  it('rejects missing required fields (runId, jobId, jobName, status)', () => {
    const { runId, ...withoutRunId } = validJobStatus;
    expect(() => jobStatusForwardSchema.parse(withoutRunId)).toThrow();

    const { jobId, ...withoutJobId } = validJobStatus;
    expect(() => jobStatusForwardSchema.parse(withoutJobId)).toThrow();

    const { jobName, ...withoutJobName } = validJobStatus;
    expect(() => jobStatusForwardSchema.parse(withoutJobName)).toThrow();

    const { status, ...withoutStatus } = validJobStatus;
    expect(() => jobStatusForwardSchema.parse(withoutStatus)).toThrow();
  });

  it('validates all status enum values', () => {
    for (const status of [
      'pending',
      'running',
      'success',
      'failed',
      'cancelled',
      'skipped',
      'timed_out_stale',
    ]) {
      expect(jobStatusForwardSchema.parse({ ...validJobStatus, status })).toBeDefined();
    }
  });

  it('rejects invalid status value', () => {
    expect(() => jobStatusForwardSchema.parse({ ...validJobStatus, status: 'unknown' })).toThrow();
  });

  it('accepts agentId and orchestratorId as optional nullable fields', () => {
    // With both fields
    const withBoth = jobStatusForwardSchema.parse(validJobStatus);
    expect(withBoth.agentId).toBe('scaler-container-abc123');
    expect(withBoth.orchestratorId).toBe('orch-node1-deadbeef');

    // Without both fields
    const { agentId, orchestratorId, ...withoutIds } = validJobStatus;
    const parsed = jobStatusForwardSchema.parse(withoutIds);
    expect(parsed.agentId).toBeUndefined();
    expect(parsed.orchestratorId).toBeUndefined();

    // With null values
    const withNulls = jobStatusForwardSchema.parse({
      ...validJobStatus,
      agentId: null,
      orchestratorId: null,
    });
    expect(withNulls.agentId).toBeNull();
    expect(withNulls.orchestratorId).toBeNull();
  });

  it('accepts logBytes when set to a non-negative integer', () => {
    const msg = { ...validJobStatus, logBytes: 12345 };
    expect(jobStatusForwardSchema.parse(msg)).toEqual(msg);
    const zero = { ...validJobStatus, logBytes: 0 };
    expect(jobStatusForwardSchema.parse(zero)).toEqual(zero);
  });

  it('rejects negative logBytes', () => {
    expect(() => jobStatusForwardSchema.parse({ ...validJobStatus, logBytes: -1 })).toThrow();
  });

  it('rejects non-integer logBytes', () => {
    expect(() => jobStatusForwardSchema.parse({ ...validJobStatus, logBytes: 1.5 })).toThrow();
  });
});

describe('executionStatusSchema logBytes', () => {
  const validExecutionStatus = {
    type: 'execution.status' as const,
    messageId: 'msg-900',
    runId: 'run-100',
    workflowName: 'wf',
    status: 'success' as const,
    startedAt: 1700000000000,
    timestamp: 1700000060000,
  };

  it('accepts logBytes when set to a non-negative integer', () => {
    const msg = { ...validExecutionStatus, logBytes: 99999 };
    expect(executionStatusSchema.parse(msg)).toEqual(msg);
    const zero = { ...validExecutionStatus, logBytes: 0 };
    expect(executionStatusSchema.parse(zero)).toEqual(zero);
  });

  it('rejects negative logBytes', () => {
    expect(() => executionStatusSchema.parse({ ...validExecutionStatus, logBytes: -1 })).toThrow();
  });

  it('rejects non-integer logBytes', () => {
    expect(() => executionStatusSchema.parse({ ...validExecutionStatus, logBytes: 1.5 })).toThrow();
  });

  it('accepts the trigger-actor fields', () => {
    const msg = {
      ...validExecutionStatus,
      triggerActorProvider: 'github',
      triggerActorUsername: 'octocat',
      triggerActorUserId: '583231',
    };
    expect(executionStatusSchema.parse(msg)).toEqual(msg);
  });

  it('bounds the trigger-actor username length', () => {
    expect(() =>
      executionStatusSchema.parse({
        ...validExecutionStatus,
        triggerActorUsername: 'x'.repeat(REPO_IDENTIFIER_MAX + 1),
      }),
    ).toThrow();
  });

  it('bounds the trigger-actor user id length', () => {
    expect(() =>
      executionStatusSchema.parse({
        ...validExecutionStatus,
        triggerActorUserId: 'x'.repeat(STATUS_ID_MAX + 1),
      }),
    ).toThrow();
  });
});

describe('stateReplaySchema', () => {
  const validStateReplay = {
    type: 'state.replay' as const,
    messageId: 'msg-800',
    runs: [
      {
        runId: 'run-001',
        workflowName: 'ci',
        status: 'running' as const,
        routingKey: 'github:42',
        repoIdentifier: 'org/repo',
        sha: 'abc123',
        ref: 'main',
        triggerEvent: 'push',
        commitMessage: 'fix: something',
        jobCount: 3,
        startedAt: 1700000000000,
        completedAt: 1700000060000,
        durationMs: 60000,
        jobs: [
          {
            jobId: 'build-1',
            jobName: 'build',
            status: 'success',
            startedAt: 1700000000000,
            completedAt: 1700000030000,
            durationMs: 30000,
            agentId: 'scaler-container-abc123',
          },
          {
            jobId: 'test-1',
            jobName: 'test',
            status: 'running',
            startedAt: 1700000030000,
          },
        ],
      },
    ],
    timestamp: 1700000060000,
  };

  it('validates a valid state replay message with runs array containing jobs', () => {
    const parsed = stateReplaySchema.parse(validStateReplay);
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0].jobs).toHaveLength(2);
    expect(parsed.runs[0].workflowName).toBe('ci');
  });

  it('validates an empty runs array', () => {
    const msg = {
      type: 'state.replay',
      messageId: 'msg-801',
      runs: [],
      timestamp: 1700000000000,
    };
    const parsed = stateReplaySchema.parse(msg);
    expect(parsed.runs).toEqual([]);
  });

  it('validates with optional run fields omitted', () => {
    const minimalRun = {
      type: 'state.replay',
      messageId: 'msg-802',
      runs: [
        {
          runId: 'run-002',
          workflowName: 'deploy',
          status: 'success',
          jobCount: 1,
          startedAt: 1700000000000,
          jobs: [],
        },
      ],
      timestamp: 1700000000000,
    };
    const parsed = stateReplaySchema.parse(minimalRun);
    expect(parsed.runs[0].routingKey).toBeUndefined();
    expect(parsed.runs[0].repoIdentifier).toBeUndefined();
    expect(parsed.runs[0].sha).toBeUndefined();
    expect(parsed.runs[0].ref).toBeUndefined();
    expect(parsed.runs[0].triggerEvent).toBeUndefined();
    expect(parsed.runs[0].commitMessage).toBeUndefined();
    expect(parsed.runs[0].completedAt).toBeUndefined();
    expect(parsed.runs[0].durationMs).toBeUndefined();
  });

  it('accepts jobs with optional agentId', () => {
    // With agentId
    const parsed = stateReplaySchema.parse(validStateReplay);
    expect(parsed.runs[0].jobs[0].agentId).toBe('scaler-container-abc123');

    // Without agentId (second job in fixture)
    expect(parsed.runs[0].jobs[1].agentId).toBeUndefined();

    // With null agentId
    const withNull = stateReplaySchema.parse({
      ...validStateReplay,
      runs: [
        {
          ...validStateReplay.runs[0],
          jobs: [{ ...validStateReplay.runs[0].jobs[0], agentId: null }],
        },
      ],
    });
    expect(withNull.runs[0].jobs[0].agentId).toBeNull();
  });

  it('validates with optional job fields omitted', () => {
    const msg = {
      type: 'state.replay',
      messageId: 'msg-803',
      runs: [
        {
          runId: 'run-003',
          workflowName: 'ci',
          status: 'running',
          jobCount: 1,
          startedAt: 1700000000000,
          jobs: [
            {
              jobId: 'build-1',
              jobName: 'build',
              status: 'pending',
            },
          ],
        },
      ],
      timestamp: 1700000000000,
    };
    const parsed = stateReplaySchema.parse(msg);
    expect(parsed.runs[0].jobs[0].startedAt).toBeUndefined();
    expect(parsed.runs[0].jobs[0].completedAt).toBeUndefined();
    expect(parsed.runs[0].jobs[0].durationMs).toBeUndefined();
  });
});

describe('ExecutionRunStatus held', () => {
  it('includes held for workflow-level install holds', () => {
    expect(ExecutionRunStatus.options).toContain('held');
  });

  it('held is NOT a terminal run state (resumable)', () => {
    expect(TERMINAL_RUN_STATES.has(ExecutionRunStatus.enum.held)).toBe(false);
  });

  it('held is accepted by executionStatusSchema', () => {
    const msg = {
      type: 'execution.status' as const,
      messageId: 'm-held',
      runId: 'r-held',
      workflowName: 'wf',
      status: 'held' as const,
      startedAt: 1,
      timestamp: 2,
    };
    expect(executionStatusSchema.parse(msg).status).toBe('held');
  });
});

describe('ExecutionJobStatus drift_dropped', () => {
  it('includes drift_dropped as a valid enum value', () => {
    expect(ExecutionJobStatus.enum.drift_dropped).toBe('drift_dropped');
  });

  it('drift_dropped is in TERMINAL_JOB_STATES', () => {
    expect(TERMINAL_JOB_STATES.has(ExecutionJobStatus.enum.drift_dropped)).toBe(true);
  });

  it('all pre-existing terminal states still in the set (regression)', () => {
    expect(TERMINAL_JOB_STATES.has(ExecutionJobStatus.enum.success)).toBe(true);
    expect(TERMINAL_JOB_STATES.has(ExecutionJobStatus.enum.failed)).toBe(true);
    expect(TERMINAL_JOB_STATES.has(ExecutionJobStatus.enum.cancelled)).toBe(true);
    expect(TERMINAL_JOB_STATES.has(ExecutionJobStatus.enum.skipped)).toBe(true);
    expect(TERMINAL_JOB_STATES.has(ExecutionJobStatus.enum.timed_out_stale)).toBe(true);
  });

  it('drift_dropped is accepted by jobStatusForwardSchema', () => {
    const msg = {
      type: 'job.status.forward',
      messageId: 'msg-drift',
      runId: 'run-001',
      jobId: 'test-shard-3',
      jobName: 'test-shard-3',
      status: 'drift_dropped',
      timestamp: 1700000000000,
    };
    const parsed = jobStatusForwardSchema.parse(msg);
    expect(parsed.status).toBe('drift_dropped');
  });
});

describe('orchestratorToPlatformMessageSchema (job.status.forward + state.replay)', () => {
  it('parses job.status.forward message type', () => {
    const msg = {
      type: 'job.status.forward',
      messageId: 'msg-900',
      runId: 'run-001',
      jobId: 'build-1',
      jobName: 'build',
      status: 'success',
      timestamp: 1700000000000,
    };
    expect(orchestratorToPlatformMessageSchema.parse(msg)).toEqual(msg);
  });

  it('parses state.replay message type', () => {
    const msg = {
      type: 'state.replay',
      messageId: 'msg-901',
      runs: [],
      timestamp: 1700000000000,
    };
    expect(orchestratorToPlatformMessageSchema.parse(msg)).toEqual(msg);
  });
});

describe('initFailureSchema', () => {
  it('round-trips a run-scoped init failure', () => {
    const value = {
      scope: 'run' as const,
      category: InitFailureCategory.enum.secret_resolution,
      message: 'Failed to resolve workflow secret context: missing scope kici/prod',
    };
    expect(initFailureSchema.parse(value)).toEqual(value);
  });

  it('round-trips a job-scoped init failure with jobName', () => {
    const value = {
      scope: 'job' as const,
      category: InitFailureCategory.enum.no_agent,
      message: 'No agent matching labels [kici:os:linux] available',
      jobName: 'deploy',
    };
    expect(initFailureSchema.parse(value)).toEqual(value);
  });

  it('rejects an unknown category', () => {
    const result = initFailureSchema.safeParse({
      scope: 'run',
      category: 'nope',
      message: 'x',
    });
    expect(result.success).toBe(false);
  });

  it('exposes all eight categories on the enum', () => {
    expect(Object.values(InitFailureCategory.enum).sort()).toEqual(
      [
        'build_coordination',
        'dynamic_eval',
        'environment_rules',
        'install_secrets',
        'lock_resolution',
        'matrix_expansion',
        'no_agent',
        'secret_resolution',
      ].sort(),
    );
  });
});

describe('executionStatusSchema with initFailure', () => {
  it('accepts a failed run with run-scoped initFailure', () => {
    const msg = {
      type: 'execution.status' as const,
      messageId: 'm1',
      runId: 'r1',
      workflowName: 'wf',
      status: 'failed' as const,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
      timestamp: 2,
      failureReason: 'Failed to resolve workflow secret context',
      initFailure: {
        scope: 'run' as const,
        category: InitFailureCategory.enum.secret_resolution,
        message: 'Failed to resolve workflow secret context',
      },
    };
    expect(executionStatusSchema.parse(msg).initFailure?.category).toBe('secret_resolution');
  });

  it('omits initFailure on success runs', () => {
    const msg = {
      type: 'execution.status' as const,
      messageId: 'm2',
      runId: 'r2',
      workflowName: 'wf',
      status: 'success' as const,
      startedAt: 1,
      timestamp: 2,
    };
    expect(executionStatusSchema.parse(msg).initFailure).toBeUndefined();
  });
});

describe('jobStatusForwardSchema with initFailure', () => {
  it('accepts a failed job with initFailure', () => {
    const msg = {
      type: 'job.status.forward' as const,
      messageId: 'm',
      runId: 'r',
      jobId: 'rejected-x',
      jobName: 'deploy',
      status: 'failed' as const,
      timestamp: 1,
      initFailure: {
        scope: 'job' as const,
        category: InitFailureCategory.enum.environment_rules,
        message: 'Rejected by protection rules',
        jobName: 'deploy',
      },
    };
    expect(jobStatusForwardSchema.parse(msg).initFailure?.category).toBe('environment_rules');
  });

  it('omits initFailure on normal job status messages', () => {
    const msg = {
      type: 'job.status.forward' as const,
      messageId: 'm',
      runId: 'r',
      jobId: 'j',
      jobName: 'build',
      status: 'success' as const,
      timestamp: 1,
    };
    expect(jobStatusForwardSchema.parse(msg).initFailure).toBeUndefined();
  });
});

describe('TimeoutReason', () => {
  it('exposes job_timeout and workflow_timeout values', () => {
    expect(TimeoutReason.enum.job_timeout).toBe('job_timeout');
    expect(TimeoutReason.enum.workflow_timeout).toBe('workflow_timeout');
  });

  it('rejects unknown values', () => {
    expect(TimeoutReason.safeParse('step_timeout').success).toBe(false);
  });
});

describe('step concurrency (parallel groups)', () => {
  it('ExecutionStepStatus accepts pending + cancelled', () => {
    expect(ExecutionStepStatus.safeParse('pending').success).toBe(true);
    expect(ExecutionStepStatus.safeParse('cancelled').success).toBe(true);
    expect(ExecutionStepStatus.safeParse('bogus').success).toBe(false);
  });

  it('StepConcurrencyKind enumerates sequential/parallel-child/parallel-group', () => {
    expect(StepConcurrencyKind.options).toEqual(['sequential', 'parallel-child', 'parallel-group']);
  });

  it('stepStatusForwardSchema accepts cancelled + concurrency fields end to end', () => {
    const ok = stepStatusForwardSchema.safeParse({
      type: 'step.status.forward',
      messageId: 'm',
      runId: 'r',
      jobId: 'j',
      jobName: 'n',
      stepIndex: 1,
      stepName: 'lint',
      state: 'cancelled',
      timestamp: 1,
      concurrencyKind: 'parallel-child',
      groupId: 'g0',
    });
    expect(ok.success).toBe(true);
  });
});

describe('user-facing cache enums', () => {
  it('CacheStepType enumerates the two pseudo-step types', () => {
    expect(CacheStepType.options).toEqual(['cache:restore', 'cache:save']);
    expect(CacheStepType.enum['cache:restore']).toBe('cache:restore');
    expect(CacheStepType.enum['cache:save']).toBe('cache:save');
  });

  it('CacheRunEventType enumerates the two run-event types', () => {
    expect(CacheRunEventType.options).toEqual(['cache.restore', 'cache.save']);
    expect(CacheRunEventType.enum['cache.restore']).toBe('cache.restore');
    expect(CacheRunEventType.enum['cache.save']).toBe('cache.save');
  });

  it('CacheOutcome enumerates hit/miss/saved/skipped/error', () => {
    expect(CacheOutcome.options).toEqual(['hit', 'miss', 'saved', 'skipped', 'error']);
  });

  it('rejects unknown cache enum values', () => {
    expect(CacheStepType.safeParse('cache:purge').success).toBe(false);
    expect(CacheOutcome.safeParse('partial').success).toBe(false);
  });
});

describe('flood-hardening field bounds', () => {
  const baseStatus = {
    type: 'execution.status' as const,
    messageId: 'm',
    runId: 'r',
    workflowName: 'w',
    status: 'failed' as const,
    startedAt: 1,
    timestamp: 1,
  };

  it('accepts workflowName at the STATUS_ID_MAX limit', () => {
    const r = executionStatusSchema.safeParse({
      ...baseStatus,
      workflowName: 'x'.repeat(STATUS_ID_MAX),
    });
    expect(r.success).toBe(true);
  });

  it('rejects a workflowName one char over the limit', () => {
    const r = executionStatusSchema.safeParse({
      ...baseStatus,
      workflowName: 'x'.repeat(STATUS_ID_MAX + 1),
    });
    expect(r.success).toBe(false);
  });

  it('accepts a failureReason at STATUS_FREE_TEXT_MAX and rejects over', () => {
    expect(
      executionStatusSchema.safeParse({
        ...baseStatus,
        failureReason: 'x'.repeat(STATUS_FREE_TEXT_MAX),
      }).success,
    ).toBe(true);
    expect(
      executionStatusSchema.safeParse({
        ...baseStatus,
        failureReason: 'x'.repeat(STATUS_FREE_TEXT_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it('accepts a repoIdentifier at REPO_IDENTIFIER_MAX and rejects over', () => {
    expect(
      executionStatusSchema.safeParse({
        ...baseStatus,
        repoIdentifier: 'x'.repeat(REPO_IDENTIFIER_MAX),
      }).success,
    ).toBe(true);
    expect(
      executionStatusSchema.safeParse({
        ...baseStatus,
        repoIdentifier: 'x'.repeat(REPO_IDENTIFIER_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects an over-long errorMessage on job.status.forward', () => {
    const r = jobStatusForwardSchema.safeParse({
      type: 'job.status.forward',
      messageId: 'm',
      runId: 'r',
      jobId: 'j',
      jobName: 'build',
      status: 'failed',
      timestamp: 1,
      errorMessage: 'x'.repeat(STATUS_FREE_TEXT_MAX + 1),
    });
    expect(r.success).toBe(false);
  });

  it('rejects a runsOnLabels array over RUNS_ON_LABELS_MAX', () => {
    const r = jobStatusForwardSchema.safeParse({
      type: 'job.status.forward',
      messageId: 'm',
      runId: 'r',
      jobId: 'j',
      jobName: 'build',
      status: 'running',
      timestamp: 1,
      runsOnLabels: Array.from({ length: RUNS_ON_LABELS_MAX + 1 }, () => 'label'),
    });
    expect(r.success).toBe(false);
  });

  it('rejects a runsOnLabels element over STATUS_ID_MAX', () => {
    const r = jobStatusForwardSchema.safeParse({
      type: 'job.status.forward',
      messageId: 'm',
      runId: 'r',
      jobId: 'j',
      jobName: 'build',
      status: 'running',
      timestamp: 1,
      runsOnLabels: ['x'.repeat(STATUS_ID_MAX + 1)],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a state.replay runs array over STATE_REPLAY_MAX_RUNS', () => {
    const runs = Array.from({ length: STATE_REPLAY_MAX_RUNS + 1 }, () => ({
      runId: 'r',
      workflowName: 'w',
      status: 'failed' as const,
      jobCount: 0,
      startedAt: 1,
      jobs: [],
    }));
    const r = stateReplaySchema.safeParse({
      type: 'state.replay',
      messageId: 'm',
      runs,
      timestamp: 1,
    });
    expect(r.success).toBe(false);
  });

  it('accepts a state.replay runs array exactly at the cap', () => {
    const runs = Array.from({ length: STATE_REPLAY_MAX_RUNS }, () => ({
      runId: 'r',
      workflowName: 'w',
      status: 'failed' as const,
      jobCount: 0,
      startedAt: 1,
      jobs: [],
    }));
    const r = stateReplaySchema.safeParse({
      type: 'state.replay',
      messageId: 'm',
      runs,
      timestamp: 1,
    });
    expect(r.success).toBe(true);
  });

  it('rejects a per-run jobs array over MAX_JOBS_PER_RUN', () => {
    const jobs = Array.from({ length: MAX_JOBS_PER_RUN + 1 }, () => ({
      jobId: 'j',
      jobName: 'build',
      status: 'running',
    }));
    const r = stateReplaySchema.safeParse({
      type: 'state.replay',
      messageId: 'm',
      runs: [{ runId: 'r', workflowName: 'w', status: 'running', jobCount: 1, startedAt: 1, jobs }],
      timestamp: 1,
    });
    expect(r.success).toBe(false);
  });
});
