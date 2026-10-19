import { describe, expect, it } from 'vitest';
import {
  INIT_STEP_INDEX_BASE,
  StepPhase,
  UNTYPED_STEP_TYPE,
  compareStepsByPhase,
  initStepIndex,
  initStepLabel,
  initStepType,
  parseInitStepRef,
  stepInitIndex,
  stepClassification,
  stepPhase,
  stepTypeOf,
  withStepClassification,
  CacheOutcome,
  CacheRunEventType,
  CacheStepType,
  ExecutionJobStatus,
  ExecutionRunStatus,
  ExecutionStepStatus,
  statusOptionsForLevel,
  StepConcurrencyKind,
  InitFailureCategory,
  RunFailureClass,
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
  STATUS_EPOCH_MAX,
} from './execution-status.js';
import { orchestratorToPlatformMessageSchema } from './platform-orchestrator.js';
import { TRUNCATION_MARKER } from './bounded-text.js';
import { dashboardRunStateResponseSchema } from './dashboard.js';

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

  it('carries an invoke-gate proxy jobKind + summonedRunId, and parses without them', () => {
    const proxy = jobStatusForwardSchema.parse({
      ...validJobStatus,
      jobKind: 'proxy',
      summonedRunId: 'r1',
    });
    expect(proxy.jobKind).toBe('proxy');
    expect(proxy.summonedRunId).toBe('r1');
    // Absent on an ordinary job — the fields are additive/optional.
    const parsed = jobStatusForwardSchema.parse(validJobStatus);
    expect(parsed.jobKind).toBeUndefined();
    expect(parsed.summonedRunId).toBeUndefined();
  });

  it('rejects an invalid jobKind value', () => {
    expect(() =>
      jobStatusForwardSchema.parse({ ...validJobStatus, jobKind: 'nonsense' }),
    ).toThrow();
  });

  it('accepts agentId and orchestratorId as optional nullable fields', () => {
    const withBoth = jobStatusForwardSchema.parse(validJobStatus);
    expect(withBoth.agentId).toBe('scaler-container-abc123');
    expect(withBoth.orchestratorId).toBe('orch-node1-deadbeef');

    const { agentId, orchestratorId, ...withoutIds } = validJobStatus;
    const parsed = jobStatusForwardSchema.parse(withoutIds);
    expect(parsed.agentId).toBeUndefined();
    expect(parsed.orchestratorId).toBeUndefined();

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
    statusEpoch: 0,
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
        statusEpoch: 0,
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
          statusEpoch: 0,
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
    const parsed = stateReplaySchema.parse(validStateReplay);
    expect(parsed.runs[0].jobs[0].agentId).toBe('scaler-container-abc123');

    // The fixture's second job has no agentId.
    expect(parsed.runs[0].jobs[1].agentId).toBeUndefined();

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
          statusEpoch: 0,
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

describe('terminal state sets (single source of truth)', () => {
  it('pins the run terminal set', () => {
    expect([...TERMINAL_RUN_STATES].sort()).toEqual(['cancelled', 'failed', 'success']);
  });

  it('pins the job terminal set', () => {
    expect([...TERMINAL_JOB_STATES].sort()).toEqual([
      'cancelled',
      'drift_dropped',
      'failed',
      'skipped',
      'success',
      'timed_out_stale',
      'unroutable',
    ]);
  });

  it('documents the intended difference: skipped/timed_out_stale/drift_dropped are job-only', () => {
    for (const s of ['skipped', 'timed_out_stale', 'drift_dropped']) {
      expect(TERMINAL_JOB_STATES.has(s)).toBe(true);
      expect(TERMINAL_RUN_STATES.has(s)).toBe(false);
    }
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
      statusEpoch: 0,
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

describe('RunFailureClass', () => {
  it('exposes exactly the five failure classes', () => {
    expect(RunFailureClass.options).toEqual([
      'never_started',
      'timed_out',
      'dead_orchestrator',
      'step_failure',
      'cancelled',
    ]);
  });

  it('executionStatusSchema carries an optional failureClass', () => {
    const msg = {
      type: 'execution.status',
      messageId: 'msg-fc',
      runId: 'run-fc',
      workflowName: 'wf',
      status: 'failed',
      jobCount: 1,
      startedAt: 1,
      statusEpoch: 0,
      timestamp: 2,
      failureClass: RunFailureClass.enum.timed_out,
    };
    expect(executionStatusSchema.parse(msg).failureClass).toBe('timed_out');
  });

  it('executionStatusSchema.failureClass is optional (absent → undefined)', () => {
    const msg = {
      type: 'execution.status',
      messageId: 'msg-fc2',
      runId: 'run-fc2',
      workflowName: 'wf',
      status: 'success',
      jobCount: 1,
      startedAt: 1,
      statusEpoch: 0,
      timestamp: 2,
    };
    expect(executionStatusSchema.parse(msg).failureClass).toBeUndefined();
  });

  it('rejects an unknown failure class', () => {
    const msg = {
      type: 'execution.status',
      messageId: 'msg-fc3',
      runId: 'run-fc3',
      workflowName: 'wf',
      status: 'failed',
      jobCount: 1,
      startedAt: 1,
      statusEpoch: 0,
      timestamp: 2,
      failureClass: 'exploded',
    };
    expect(executionStatusSchema.safeParse(msg).success).toBe(false);
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

  it('exposes all eleven categories on the enum', () => {
    expect(Object.values(InitFailureCategory.enum).sort()).toEqual(
      [
        'approval_misconfig',
        'build_coordination',
        'dynamic_eval',
        'context_rules',
        'install_secrets',
        'lock_resolution',
        'matrix_expansion',
        'no_agent',
        'sandbox_denied',
        'secret_resolution',
        'trust_policy',
      ].sort(),
    );
  });

  it('treats trust_policy as a run-scoped category', () => {
    expect(InitFailureCategory.options).toContain('trust_policy');
    const result = initFailureSchema.safeParse({
      scope: 'run',
      category: InitFailureCategory.enum.trust_policy,
      message: 'Fork PR rejected by org trust policy',
    });
    expect(result.success).toBe(true);
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
      statusEpoch: 0,
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
      statusEpoch: 0,
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
        category: InitFailureCategory.enum.context_rules,
        message: 'Rejected by protection rules',
        jobName: 'deploy',
      },
    };
    expect(jobStatusForwardSchema.parse(msg).initFailure?.category).toBe('context_rules');
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
    statusEpoch: 0,
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

  it('keeps a failureReason at STATUS_FREE_TEXT_MAX and clamps a longer one', () => {
    const atLimit = 'x'.repeat(STATUS_FREE_TEXT_MAX);
    // breaks-if-wrong: a value at the bound arrives byte-identical
    expect(
      executionStatusSchema.parse({ ...baseStatus, failureReason: atLimit }).failureReason,
    ).toBe(atLimit);
    const clamped = executionStatusSchema.parse({
      ...baseStatus,
      failureReason: 'x'.repeat(STATUS_FREE_TEXT_MAX + 1),
    }).failureReason!;
    // fails-when: an over-long failureReason makes the whole frame invalid again
    expect(clamped).toHaveLength(STATUS_FREE_TEXT_MAX);
    expect(clamped.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('clamps every free-text field of the status family and keeps identifiers strict', () => {
    const LONG = '\rDownloading 42%'.repeat(650); // 10,400 characters of redraws
    const job = {
      type: 'job.status.forward' as const,
      messageId: 'm',
      runId: 'r',
      jobId: 'j',
      jobName: 'build',
      status: 'failed' as const,
      timestamp: 1,
    };
    const replayRun = (extra: Record<string, unknown>, jobExtra: Record<string, unknown> = {}) => ({
      runId: 'r',
      workflowName: 'w',
      status: 'failed' as const,
      jobCount: 1,
      startedAt: 1,
      statusEpoch: 0,
      jobs: [{ jobId: 'j', jobName: 'build', status: 'failed', ...jobExtra }],
      ...extra,
    });
    const replay = (run: Record<string, unknown>) => ({
      type: 'state.replay' as const,
      messageId: 'm',
      timestamp: 1,
      runs: [run],
    });
    const initFailure = {
      scope: 'run' as const,
      category: 'secret_resolution' as const,
      message: LONG,
    };
    const cases: Array<[string, () => string | null | undefined]> = [
      [
        'execution.status failureReason',
        () => executionStatusSchema.parse({ ...baseStatus, failureReason: LONG }).failureReason,
      ],
      [
        'execution.status commitMessage',
        () => executionStatusSchema.parse({ ...baseStatus, commitMessage: LONG }).commitMessage,
      ],
      [
        'execution.status initFailure.message',
        () => executionStatusSchema.parse({ ...baseStatus, initFailure }).initFailure?.message,
      ],
      [
        'job.status.forward errorMessage',
        () => jobStatusForwardSchema.parse({ ...job, errorMessage: LONG }).errorMessage,
      ],
      [
        'job.status.forward initFailure.message',
        () => jobStatusForwardSchema.parse({ ...job, initFailure }).initFailure?.message,
      ],
      [
        'state.replay failureReason',
        () =>
          stateReplaySchema.parse(replay(replayRun({ failureReason: LONG }))).runs[0]!
            .failureReason,
      ],
      [
        'state.replay commitMessage',
        () =>
          stateReplaySchema.parse(replay(replayRun({ commitMessage: LONG }))).runs[0]!
            .commitMessage,
      ],
      [
        'state.replay job errorMessage',
        () =>
          stateReplaySchema.parse(replay(replayRun({}, { errorMessage: LONG }))).runs[0]!.jobs[0]!
            .errorMessage,
      ],
      [
        'dashboard.run.state.response failureReason',
        () =>
          dashboardRunStateResponseSchema.parse({
            type: 'dashboard.run.state.response',
            requestId: 'q',
            run: replayRun({ failureReason: LONG }),
          }).run?.failureReason,
      ],
    ];
    for (const [name, read] of cases) {
      const out = read();
      // fails-when: any free-text field of the family still refuses an over-long value
      expect(out, name).toHaveLength(STATUS_FREE_TEXT_MAX);
      expect(out!.endsWith(TRUNCATION_MARKER), name).toBe(true);
    }
    // breaks-if-wrong: identifiers are not clamped; an over-long id still makes the frame invalid
    expect(
      jobStatusForwardSchema.safeParse({ ...job, jobId: 'J'.repeat(STATUS_ID_MAX + 1) }).success,
    ).toBe(false);
    expect(
      jobStatusForwardSchema.safeParse({ ...job, jobName: 'J'.repeat(STATUS_ID_MAX + 1) }).success,
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
      statusEpoch: 0,
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
      statusEpoch: 0,
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
      runs: [
        {
          runId: 'r',
          workflowName: 'w',
          status: 'running',
          jobCount: 1,
          startedAt: 1,
          statusEpoch: 0,
          jobs,
        },
      ],
      timestamp: 1,
    });
    expect(r.success).toBe(false);
  });
});

describe('statusOptionsForLevel', () => {
  it('returns run statuses for run and job statuses for job', () => {
    expect(statusOptionsForLevel('run')).toEqual(ExecutionRunStatus.options);
    expect(statusOptionsForLevel('job')).toEqual(ExecutionJobStatus.options);
  });

  it('exposes job-only terminal statuses only at job level', () => {
    expect(statusOptionsForLevel('job')).toContain('timed_out_stale');
    expect(statusOptionsForLevel('job')).toContain('drift_dropped');
    expect(statusOptionsForLevel('run')).not.toContain('timed_out_stale');
    expect(statusOptionsForLevel('run')).not.toContain('drift_dropped');
  });

  it('keeps the run-only held status out of the job set', () => {
    expect(statusOptionsForLevel('run')).toContain('held');
    expect(statusOptionsForLevel('job')).not.toContain('held');
  });
});

describe('executionStatusSchema routingKey (per-run source attribution)', () => {
  const base = {
    type: 'execution.status' as const,
    messageId: 'm1',
    runId: 'r1',
    workflowName: 'wf',
    status: 'running' as const,
    startedAt: 1,
    statusEpoch: 0,
    timestamp: 2,
  };

  it('accepts an optional per-run routingKey', () => {
    const parsed = executionStatusSchema.parse({ ...base, routingKey: 'generic:org:src' });
    expect(parsed.routingKey).toBe('generic:org:src');
  });

  it('remains valid when routingKey is omitted (a run with no recorded routing key)', () => {
    const parsed = executionStatusSchema.parse(base);
    expect(parsed.routingKey).toBeUndefined();
  });
});

describe('workflowRepoIdentifier (the repo that defines a global workflow)', () => {
  const WORKFLOW_REPO = 'org/pipelines';

  const status = {
    type: 'execution.status' as const,
    messageId: 'm-wfrepo-1',
    runId: 'r-wfrepo-1',
    workflowName: 'wf',
    status: ExecutionRunStatus.enum.running,
    repoIdentifier: 'org/source-repo',
    startedAt: 1,
    statusEpoch: 0,
    timestamp: 2,
  };

  const replayRun = {
    runId: 'r-wfrepo-2',
    workflowName: 'wf',
    status: ExecutionRunStatus.enum.running,
    repoIdentifier: 'org/source-repo',
    jobCount: 0,
    startedAt: 1,
    statusEpoch: 0,
    jobs: [],
  };

  const replay = {
    type: 'state.replay' as const,
    messageId: 'm-wfrepo-2',
    runs: [replayRun],
    timestamp: 2,
  };

  it('carries workflowRepoIdentifier on execution.status alongside repoIdentifier', () => {
    const parsed = executionStatusSchema.parse({
      ...status,
      workflowRepoIdentifier: WORKFLOW_REPO,
    });
    expect(parsed.workflowRepoIdentifier).toBe(WORKFLOW_REPO);
    // The source repo is untouched — a global run belongs to both.
    expect(parsed.repoIdentifier).toBe('org/source-repo');
  });

  it('leaves workflowRepoIdentifier undefined for a per-repository run', () => {
    expect(executionStatusSchema.parse(status).workflowRepoIdentifier).toBeUndefined();
  });

  it('bounds workflowRepoIdentifier by REPO_IDENTIFIER_MAX', () => {
    expect(
      executionStatusSchema.safeParse({
        ...status,
        workflowRepoIdentifier: 'x'.repeat(REPO_IDENTIFIER_MAX),
      }).success,
    ).toBe(true);
    expect(
      executionStatusSchema.safeParse({
        ...status,
        workflowRepoIdentifier: 'x'.repeat(REPO_IDENTIFIER_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it('carries workflowRepoIdentifier on a state.replay run (reconnect replay)', () => {
    const parsed = stateReplaySchema.parse({
      ...replay,
      runs: [{ ...replayRun, workflowRepoIdentifier: WORKFLOW_REPO }],
    });
    expect(parsed.runs[0]!.workflowRepoIdentifier).toBe(WORKFLOW_REPO);
    expect(parsed.runs[0]!.repoIdentifier).toBe('org/source-repo');
  });

  it('leaves a replay run valid with workflowRepoIdentifier omitted', () => {
    expect(stateReplaySchema.parse(replay).runs[0]!.workflowRepoIdentifier).toBeUndefined();
  });

  it('bounds a replay run workflowRepoIdentifier by REPO_IDENTIFIER_MAX', () => {
    expect(
      stateReplaySchema.safeParse({
        ...replay,
        runs: [{ ...replayRun, workflowRepoIdentifier: 'x'.repeat(REPO_IDENTIFIER_MAX + 1) }],
      }).success,
    ).toBe(false);
  });
});

describe('statusEpoch (the run status generation)', () => {
  const status = {
    type: 'execution.status' as const,
    messageId: 'm-epoch-1',
    runId: 'r-epoch-1',
    workflowName: 'wf',
    status: ExecutionRunStatus.enum.running,
    startedAt: 1,
    timestamp: 2,
  };

  const replayRun = {
    runId: 'r-epoch-2',
    workflowName: 'wf',
    status: ExecutionRunStatus.enum.running,
    jobCount: 0,
    startedAt: 1,
    jobs: [],
  };

  it('carries statusEpoch on execution.status and on a state.replay run', () => {
    expect(executionStatusSchema.parse({ ...status, statusEpoch: 3 }).statusEpoch).toBe(3);
    const replay = stateReplaySchema.parse({
      type: 'state.replay',
      messageId: 'm-epoch-2',
      runs: [{ ...replayRun, statusEpoch: 0 }],
      timestamp: 2,
    });
    expect(replay.runs[0]!.statusEpoch).toBe(0);
  });

  it('refuses a frame without statusEpoch', () => {
    // fails-when: statusEpoch stays optional, so the Platform applies a frame unguarded.
    expect(executionStatusSchema.safeParse(status).success).toBe(false);
    expect(
      stateReplaySchema.safeParse({
        type: 'state.replay',
        messageId: 'm-epoch-3',
        runs: [replayRun],
        timestamp: 2,
      }).success,
    ).toBe(false);
  });

  it('rejects a negative or fractional statusEpoch', () => {
    // fails-when: the schema accepts an epoch the Platform's integer column cannot hold.
    expect(executionStatusSchema.safeParse({ ...status, statusEpoch: -1 }).success).toBe(false);
    expect(executionStatusSchema.safeParse({ ...status, statusEpoch: 1.5 }).success).toBe(false);
    expect(
      executionStatusSchema.safeParse({ ...status, statusEpoch: STATUS_EPOCH_MAX + 1 }).success,
    ).toBe(false);
    expect(
      executionStatusSchema.safeParse({ ...status, statusEpoch: STATUS_EPOCH_MAX }).success,
    ).toBe(true);
    expect(
      stateReplaySchema.safeParse({
        type: 'state.replay',
        messageId: 'm-epoch-4',
        runs: [{ ...replayRun, statusEpoch: -1 }],
        timestamp: 2,
      }).success,
    ).toBe(false);
  });
});

describe('init step types', () => {
  it('round-trips an init position through its step type and its label', () => {
    // fails-when: the agent's step type and the readers' parser disagree on the format
    expect(initStepIndex(initStepType(3))).toBe(3);
    expect(parseInitStepRef(initStepLabel(3))).toBe(3);
    expect(parseInitStepRef(initStepType(3))).toBe(3);
  });

  it('reads no init position from any other step type', () => {
    // breaks-if-wrong: hooks, cache steps and plain steps are never taken for an init
    for (const t of [
      'step',
      'hook:cleanup',
      'cache:save',
      'container:build',
      'init:',
      'init:x',
      'init:1a',
      null,
      undefined,
    ]) {
      expect(initStepIndex(t)).toBeUndefined();
    }
    expect(parseInitStepRef('7')).toBeUndefined();
    expect(parseInitStepRef('init[x]')).toBeUndefined();
  });

  it('places each step type in its phase', () => {
    const phase = (stepType: string | undefined) => stepPhase({ stepIndex: 0, stepType });
    expect(phase('container:build')).toBe(StepPhase.enum.setup);
    expect(phase('init:0')).toBe(StepPhase.enum.init);
    expect(phase('step')).toBe(StepPhase.enum.steps);
    expect(phase('hook:onFailure')).toBe(StepPhase.enum.steps);
    expect(phase(undefined)).toBe(StepPhase.enum.steps);
  });

  describe('an init step stored without a type', () => {
    const untypedInit = (n: number, stepType: string | null = UNTYPED_STEP_TYPE) => ({
      stepIndex: INIT_STEP_INDEX_BASE + n,
      stepName: initStepType(n),
      stepType,
    });

    it('is read as an init step from its index and name', () => {
      // fails-when: only an init:<n> type marks an init step, so an untyped row stays a step
      expect(stepInitIndex(untypedInit(0))).toBe(0);
      expect(stepInitIndex(untypedInit(2))).toBe(2);
      expect(stepPhase(untypedInit(0))).toBe(StepPhase.enum.init);
      // fails-when: a null type (a row read with no step_type) is not taken as untyped
      expect(stepInitIndex(untypedInit(1, null))).toBe(1);
      expect(stepInitIndex({ stepIndex: INIT_STEP_INDEX_BASE, stepName: 'init:0' })).toBe(0);
    });

    it('keeps a regular step just below the init base a regular step', () => {
      // breaks-if-wrong: the index alone would take the last allocator index for an init step
      const below = { stepIndex: INIT_STEP_INDEX_BASE - 1, stepName: 'init:0', stepType: 'step' };
      expect(stepInitIndex(below)).toBeUndefined();
      expect(stepPhase(below)).toBe(StepPhase.enum.steps);
      const belowNamedNegative = { ...below, stepName: 'init:-1' };
      expect(stepInitIndex(belowNamedNegative)).toBeUndefined();
    });

    it('needs the init name that matches its index', () => {
      // breaks-if-wrong: an untyped high-index step (a cache step in a huge job) stays a step
      const cache = {
        stepIndex: INIT_STEP_INDEX_BASE + 4,
        stepName: 'cache:restore',
        stepType: 'step',
      };
      expect(stepInitIndex(cache)).toBeUndefined();
      const shifted = { stepIndex: INIT_STEP_INDEX_BASE + 1, stepName: 'init:0', stepType: 'step' };
      expect(stepInitIndex(shifted)).toBeUndefined();
      expect(stepInitIndex({ stepIndex: 3, stepName: 'init:0', stepType: 'step' })).toBeUndefined();
    });

    it('is not overridden for a step that carries another type', () => {
      // breaks-if-wrong: a typed hook or image build at an init index keeps its own phase
      const hook = { ...untypedInit(0), stepType: 'hook:cleanup' };
      expect(stepInitIndex(hook)).toBeUndefined();
      expect(stepPhase(hook)).toBe(StepPhase.enum.steps);
      const build = { ...untypedInit(0), stepType: 'container:build' };
      expect(stepPhase(build)).toBe(StepPhase.enum.setup);
    });

    it('sorts before the steps it ran ahead of', () => {
      const steps = [
        { stepIndex: 0, stepName: 'baseline', stepType: 'step' },
        { stepIndex: 1, stepName: 'sudo-apt', stepType: 'step' },
        untypedInit(0),
      ];
      // fails-when: the untyped init row sorts by its stored index, last
      expect(steps.sort(compareStepsByPhase).map((s) => s.stepName)).toEqual([
        'init:0',
        'baseline',
        'sudo-apt',
      ]);
    });
  });

  it('orders steps by phase, then by index', () => {
    const steps = [
      { stepIndex: 1, stepType: 'step' },
      { stepIndex: 1_000_001, stepType: 'init:1' },
      { stepIndex: 0 },
      { stepIndex: 1_000_000, stepType: 'init:0' },
      { stepIndex: 2_000_000, stepType: 'container:build' },
    ];
    // fails-when: the init steps sort by their stored index, after the steps
    expect(steps.sort(compareStepsByPhase).map((s) => s.stepIndex)).toEqual([
      2_000_000, 1_000_000, 1_000_001, 0, 1,
    ]);
  });
});

describe('stepClassification', () => {
  it('gives a typed init step its phase and position', () => {
    expect(
      stepClassification({ stepIndex: 1_000_000, stepName: 'init:0', stepType: 'init:0' }),
    ).toEqual({ phase: 'init', initIndex: 0 });
  });

  it('classifies an init step an older orchestrator recorded without a type', () => {
    // fails-when: the classifier reads stepType alone
    expect(
      stepClassification({ stepIndex: 1_000_000, stepName: 'init:0', stepType: 'step' }),
    ).toEqual({ phase: 'init', initIndex: 0 });
    expect(stepClassification({ stepIndex: 1_000_000, stepName: 'init:0' })).toEqual({
      phase: 'init',
      initIndex: 0,
    });
  });

  it('gives a regular step no initIndex key', () => {
    // breaks-if-wrong: a regular step must not gain an initIndex key
    const result = stepClassification({ stepIndex: 0, stepName: 'build' });
    expect(result).toEqual({ phase: 'steps' });
    expect(result).not.toHaveProperty('initIndex');
    expect(stepClassification({ stepIndex: 1_000_004, stepName: 'cache:restore' })).toEqual({
      phase: 'steps',
    });
    expect(
      stepClassification({ stepIndex: 0, stepName: 'image', stepType: 'container:build' }),
    ).toEqual({ phase: 'setup' });
  });

  it('recomputes the classification and drops a stale one', () => {
    // fails-when: a stale initIndex survives the recompute
    const step = withStepClassification({
      stepIndex: 0,
      stepName: 'build',
      status: 'success',
      phase: 'init',
      initIndex: 3,
    });
    expect(step).toEqual({ stepIndex: 0, stepName: 'build', status: 'success', phase: 'steps' });
    expect(step).not.toHaveProperty('initIndex');
  });
});

describe('stepTypeOf', () => {
  it('reads the step type from either spelling a step.status data carries', () => {
    // fails-when: only the camelCase key is read, and every sandbox-relayed type is lost
    expect(stepTypeOf({ step_type: 'hook:cleanup' })).toBe('hook:cleanup');
    // breaks-if-wrong: the host-side camelCase spelling keeps working
    expect(stepTypeOf({ stepType: 'container:build' })).toBe('container:build');
    expect(stepTypeOf({ durationMs: 3 })).toBeUndefined();
    expect(stepTypeOf({ step_type: 7 })).toBeUndefined();
    expect(stepTypeOf(undefined)).toBeUndefined();
  });
});
