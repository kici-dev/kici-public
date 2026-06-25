import { describe, expect, it } from 'vitest';
import {
  dashboardRunDetailRequestSchema,
  dashboardRunDetailResponseSchema,
  dashboardRunDetailApiResponseSchema,
  dashboardStepLogsRequestSchema,
  dashboardStepLogsResponseSchema,
  dashboardPlatformToOrchSchema,
  dashboardOrchToPlatformSchema,
  dashboardJobDetailSchema,
  runCancelRequestSchema,
  dashboardDiagnosticsResponseSchema,
  dashboardEventLogPayloadStreamRequestSchema,
  dashboardEventLogPayloadChunkSchema,
  browserEventLogPayloadChunkSchema,
  runListResponseSchema,
  diagnosticsInfrastructureResponseSchema,
  testRelayTriggerRequestSchema,
  dashboardFleetWorkflowsForHostRequestSchema,
  dashboardFleetWorkflowsForHostResponseSchema,
  fleetHostDeclareRequestSchema,
  fleetHostDeclareResponseSchema,
} from './dashboard.js';
import { InitFailureCategory } from './execution-status.js';

const testActor = { type: 'user' as const, sub: 'zsub-test' };

describe('dashboard.fleet.workflows-for-host messages', () => {
  it('parses a workflows-for-host request and is in the platform→orch union', () => {
    const msg = {
      type: 'dashboard.fleet.workflows-for-host' as const,
      requestId: 'r1',
      actor: testActor,
      agentId: 'host-1',
    };
    expect(dashboardFleetWorkflowsForHostRequestSchema.parse(msg)).toMatchObject({
      agentId: 'host-1',
    });
    expect(dashboardPlatformToOrchSchema.parse(msg)).toMatchObject({ agentId: 'host-1' });
  });

  it('parses a workflows-for-host response and is in the orch→platform union', () => {
    const msg = {
      type: 'dashboard.fleet.workflows-for-host.response' as const,
      requestId: 'r1',
      workflows: [
        {
          workflowName: 'deploy-all',
          repoIdentifier: 'org/repo',
          sourceFile: '.kici/workflows/deploy.ts',
          onUnreachable: 'hold' as const,
          disposition: 'target' as const,
        },
      ],
    };
    expect(dashboardFleetWorkflowsForHostResponseSchema.parse(msg).workflows).toHaveLength(1);
    expect(dashboardOrchToPlatformSchema.parse(msg)).toMatchObject({
      type: 'dashboard.fleet.workflows-for-host.response',
    });
  });

  it('accepts a null sourceFile', () => {
    const parsed = dashboardFleetWorkflowsForHostResponseSchema.parse({
      type: 'dashboard.fleet.workflows-for-host.response',
      requestId: 'r1',
      workflows: [
        {
          workflowName: 'w',
          repoIdentifier: 'o/r',
          sourceFile: null,
          onUnreachable: 'skip',
          disposition: 'unreachable-durable',
        },
      ],
    });
    expect(parsed.workflows[0].sourceFile).toBeNull();
  });
});

describe('testRelayTriggerRequestSchema — target host narrowing', () => {
  const base = {
    type: 'test.relay.trigger' as const,
    requestId: 'req-t',
    actor: testActor,
    routingKey: 'github:1',
    fixtureId: 'fx',
    event: { type: 'push', targetBranch: 'main', payload: {} },
  };

  it('round-trips an optional target selector', () => {
    const parsed = testRelayTriggerRequestSchema.parse({
      ...base,
      target: {
        values: [{ include: [{ kind: 'exact', value: 'role:web' }], exclude: [] }],
        allowEmpty: true,
      },
    });
    expect(parsed.target?.values).toHaveLength(1);
    expect(parsed.target?.allowEmpty).toBe(true);
  });

  it('accepts a request with no target (webhook parity)', () => {
    expect(testRelayTriggerRequestSchema.parse(base).target).toBeUndefined();
  });

  it('rejects a target with an empty values array', () => {
    const r = testRelayTriggerRequestSchema.safeParse({
      ...base,
      target: { values: [], allowEmpty: false },
    });
    expect(r.success).toBe(false);
  });
});

describe('testRelayTriggerRequestSchema — dispatch inputs', () => {
  const base = {
    type: 'test.relay.trigger' as const,
    requestId: 'req-d',
    actor: testActor,
    routingKey: 'github:1',
    fixtureId: 'fx',
    event: { type: 'dispatch', targetBranch: 'main', payload: {} },
  };

  it('round-trips raw operator dispatchInputs', () => {
    const parsed = testRelayTriggerRequestSchema.parse({
      ...base,
      dispatchInputs: { skipCveScan: 'true', mode: 'full' },
    });
    expect(parsed.dispatchInputs).toEqual({ skipCveScan: 'true', mode: 'full' });
  });

  it('accepts a request with no dispatchInputs', () => {
    expect(testRelayTriggerRequestSchema.parse(base).dispatchInputs).toBeUndefined();
  });

  it('rejects non-string dispatchInput values (raw pairs are strings)', () => {
    const r = testRelayTriggerRequestSchema.safeParse({
      ...base,
      dispatchInputs: { n: 3 },
    });
    expect(r.success).toBe(false);
  });
});

describe('dashboardRunDetailRequestSchema', () => {
  const valid = {
    type: 'dashboard.run.detail',
    requestId: 'req-001',
    actor: testActor,
    runId: 'run-abc',
  };

  it('validates a well-formed request', () => {
    expect(dashboardRunDetailRequestSchema.parse(valid)).toEqual(valid);
  });

  it('rejects missing runId', () => {
    const { runId, ...rest } = valid;
    expect(() => dashboardRunDetailRequestSchema.parse(rest)).toThrow();
  });

  it('rejects missing requestId', () => {
    const { requestId, ...rest } = valid;
    expect(() => dashboardRunDetailRequestSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(valid));
    expect(dashboardRunDetailRequestSchema.parse(roundTripped)).toEqual(valid);
  });
});

describe('dashboardRunDetailResponseSchema', () => {
  const valid = {
    type: 'dashboard.run.detail.response',
    requestId: 'req-001',
    jobs: [
      {
        jobId: 'job-1',
        jobName: 'build',
        status: 'success',
        matrixValues: null,
        startedAt: 1000,
        completedAt: 2000,
        durationMs: 1000,
        agentId: null,
        errorMessage: null,
        steps: [
          {
            stepIndex: 0,
            stepName: 'Install',
            status: 'success',
            startedAt: 1000,
            completedAt: 1500,
            durationMs: 500,
            exitCode: 0,
            errorMessage: null,
          },
        ],
      },
    ],
  };

  it('validates a well-formed response', () => {
    expect(dashboardRunDetailResponseSchema.parse(valid)).toEqual(valid);
  });

  it('accepts optional error field', () => {
    const msg = { ...valid, error: 'Run not found' };
    const parsed = dashboardRunDetailResponseSchema.parse(msg);
    expect(parsed.error).toBe('Run not found');
  });

  it('accepts empty jobs array', () => {
    const msg = { ...valid, jobs: [] };
    expect(dashboardRunDetailResponseSchema.parse(msg)).toEqual(msg);
  });

  it('accepts job with matrix values', () => {
    const msg = {
      ...valid,
      jobs: [
        {
          ...valid.jobs[0],
          matrixValues: { os: 'linux', node: '20' },
        },
      ],
    };
    const parsed = dashboardRunDetailResponseSchema.parse(msg);
    expect(parsed.jobs[0].matrixValues).toEqual({ os: 'linux', node: '20' });
  });

  it('accepts nullable timing fields on steps', () => {
    const msg = {
      ...valid,
      jobs: [
        {
          ...valid.jobs[0],
          steps: [
            {
              stepIndex: 0,
              stepName: 'Pending',
              status: 'pending',
              startedAt: null,
              completedAt: null,
              durationMs: null,
              exitCode: null,
              errorMessage: null,
            },
          ],
        },
      ],
    };
    expect(dashboardRunDetailResponseSchema.parse(msg)).toEqual(msg);
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(valid));
    expect(dashboardRunDetailResponseSchema.parse(roundTripped)).toEqual(valid);
  });
});

describe('dashboardJobDetailSchema (agentId)', () => {
  const validJob = {
    jobId: 'job-1',
    jobName: 'build',
    status: 'running',
    matrixValues: null,
    startedAt: 1000,
    completedAt: null,
    durationMs: null,
    agentId: 'agent-abc-123',
    errorMessage: null,
    steps: [],
  };

  it('accepts agentId as a string', () => {
    const parsed = dashboardJobDetailSchema.parse(validJob);
    expect(parsed.agentId).toBe('agent-abc-123');
  });

  it('accepts agentId as null', () => {
    const job = { ...validJob, agentId: null };
    const parsed = dashboardJobDetailSchema.parse(job);
    expect(parsed.agentId).toBeNull();
  });

  it('rejects missing agentId', () => {
    const { agentId, errorMessage, ...rest } = validJob;
    expect(() => dashboardJobDetailSchema.parse(rest)).toThrow();
  });
});

describe('dashboardJobDetailSchema needs', () => {
  it('accepts a needs array with a runOn status-set', () => {
    const parsed = dashboardJobDetailSchema.parse({
      jobId: 'test-linux',
      jobName: 'test',
      status: 'success',
      matrixValues: { os: 'linux' },
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
      agentId: null,
      errorMessage: null,
      steps: [],
      needs: [{ upstreamName: 'build', runOn: ['success'] }],
    });
    expect(parsed.needs).toEqual([{ upstreamName: 'build', runOn: ['success'] }]);
  });

  it('treats needs as optional (jobs without upstreams)', () => {
    const parsed = dashboardJobDetailSchema.parse({
      jobId: 'build',
      jobName: 'build',
      status: 'success',
      matrixValues: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
      agentId: null,
      errorMessage: null,
      steps: [],
    });
    expect(parsed.needs ?? null).toBeNull();
  });

  it('rejects an invalid runOn status', () => {
    expect(() =>
      dashboardJobDetailSchema.parse({
        jobId: 'x',
        jobName: 'x',
        status: 'success',
        matrixValues: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        agentId: null,
        errorMessage: null,
        steps: [],
        needs: [{ upstreamName: 'build', runOn: ['maybe'] }],
      }),
    ).toThrow();
  });
});

describe('dashboardStepLogsRequestSchema', () => {
  const valid = {
    type: 'dashboard.step.logs',
    requestId: 'req-002',
    actor: testActor,
    runId: 'run-abc',
    jobId: 'job-1',
    stepIndex: 0,
  };

  it('validates a well-formed request', () => {
    expect(dashboardStepLogsRequestSchema.parse(valid)).toEqual(valid);
  });

  it('rejects missing jobId', () => {
    const { jobId, ...rest } = valid;
    expect(() => dashboardStepLogsRequestSchema.parse(rest)).toThrow();
  });

  it('rejects missing stepIndex', () => {
    const { stepIndex, ...rest } = valid;
    expect(() => dashboardStepLogsRequestSchema.parse(rest)).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(valid));
    expect(dashboardStepLogsRequestSchema.parse(roundTripped)).toEqual(valid);
  });
});

describe('dashboardStepLogsResponseSchema', () => {
  const valid = {
    type: 'dashboard.step.logs.response',
    requestId: 'req-002',
    lines: ['Installing dependencies...', '\x1b[32mDone\x1b[0m in 3.2s'],
    totalLines: 2,
  };

  it('validates a well-formed response', () => {
    expect(dashboardStepLogsResponseSchema.parse(valid)).toEqual(valid);
  });

  it('accepts optional error field', () => {
    const msg = { ...valid, error: 'Step not found' };
    const parsed = dashboardStepLogsResponseSchema.parse(msg);
    expect(parsed.error).toBe('Step not found');
  });

  it('preserves ANSI escape codes in log lines', () => {
    const parsed = dashboardStepLogsResponseSchema.parse(valid);
    expect(parsed.lines[1]).toContain('\x1b[32m');
  });

  it('accepts empty lines array', () => {
    const msg = { ...valid, lines: [], totalLines: 0 };
    expect(dashboardStepLogsResponseSchema.parse(msg)).toEqual(msg);
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(valid));
    expect(dashboardStepLogsResponseSchema.parse(roundTripped)).toEqual(valid);
  });
});

describe('dashboardPlatformToOrchSchema (discriminated union)', () => {
  it('accepts dashboard.run.detail request', () => {
    const msg = {
      type: 'dashboard.run.detail',
      requestId: 'r1',
      actor: testActor,
      runId: 'run-1',
    };
    expect(dashboardPlatformToOrchSchema.parse(msg)).toEqual(msg);
  });

  it('accepts dashboard.step.logs request', () => {
    const msg = {
      type: 'dashboard.step.logs',
      requestId: 'r2',
      actor: testActor,
      runId: 'run-1',
      jobId: 'j1',
      stepIndex: 0,
    };
    expect(dashboardPlatformToOrchSchema.parse(msg)).toEqual(msg);
  });

  it('rejects response types (wrong direction)', () => {
    const msg = {
      type: 'dashboard.run.detail.response',
      requestId: 'r1',
      jobs: [],
    };
    expect(() => dashboardPlatformToOrchSchema.parse(msg)).toThrow();
  });

  it('rejects a request missing the actor field', () => {
    const msg = { type: 'dashboard.run.detail', requestId: 'r1', runId: 'run-1' };
    expect(() => dashboardPlatformToOrchSchema.parse(msg)).toThrow();
  });
});

describe('dashboardOrchToPlatformSchema (discriminated union)', () => {
  it('accepts dashboard.run.detail.response', () => {
    const msg = { type: 'dashboard.run.detail.response', requestId: 'r1', jobs: [] };
    expect(dashboardOrchToPlatformSchema.parse(msg)).toEqual(msg);
  });

  it('accepts dashboard.step.logs.response', () => {
    const msg = {
      type: 'dashboard.step.logs.response',
      requestId: 'r2',
      lines: ['ok'],
      totalLines: 1,
    };
    expect(dashboardOrchToPlatformSchema.parse(msg)).toEqual(msg);
  });

  it('rejects request types (wrong direction)', () => {
    const msg = { type: 'dashboard.run.detail', requestId: 'r1', runId: 'run-1' };
    expect(() => dashboardOrchToPlatformSchema.parse(msg)).toThrow();
  });

  it('accepts held-runs.list.response rows with a nulled environment reference', () => {
    // A held run whose environment was deleted carries environmentId AND
    // environmentName as null (held_runs.environment_id is FK ON DELETE SET
    // NULL). The union must accept the row — a rejection here drops the WS
    // response in the relay and surfaces as a Platform proxy timeout.
    const msg = {
      type: 'dashboard.held-runs.list.response',
      requestId: 'r3',
      heldRuns: [
        {
          id: 'hold-1',
          runId: 'run-1',
          environmentId: null,
          environmentName: null,
          holdType: 'reviewer',
          queueType: 'environment',
          status: 'rejected',
          requestedAt: '2026-06-06T00:00:00.000Z',
          resolvedAt: '2026-06-06T00:05:00.000Z',
          resolvedBy: 'user:abc',
          reason: 'resolved before environment deletion',
          expiresAt: null,
        },
      ],
    };
    expect(dashboardOrchToPlatformSchema.parse(msg)).toEqual(msg);
  });
});

// --- Diagnostics metadata and scaler tests ---

describe('dashboardDiagnosticsResponseSchema metadata fields', () => {
  const baseResponse = {
    type: 'dashboard.diagnostics.response',
    requestId: 'req-diag-1',
    orchestrator: {
      version: '1.0.0',
      mode: 'platform',
      scalerBackends: ['container'],
      runningJobs: 2,
      queuedJobs: 1,
      pendingLabelGaps: [],
    },
    agents: [],
  };

  it('accepts response with orchestrator instanceId and OS metadata', () => {
    const msg = {
      ...baseResponse,
      orchestrator: {
        ...baseResponse.orchestrator,
        instanceId: 'orch-main-abc123',
        hostname: 'orchestrator-host',
        osRelease: '6.1.0-amd64',
        osVersion: '#1 SMP Debian',
        totalMemoryMb: 32768,
        cpuCount: 16,
        nodeVersion: '24.0.0',
        memoryUsedMb: 8192,
        memoryAvailableMb: 24576,
        uptimeSeconds: 3600,
      },
    };
    const parsed = dashboardDiagnosticsResponseSchema.parse(msg);
    expect(parsed.orchestrator.instanceId).toBe('orch-main-abc123');
    expect(parsed.orchestrator.hostname).toBe('orchestrator-host');
    expect(parsed.orchestrator.totalMemoryMb).toBe(32768);
    expect(parsed.orchestrator.uptimeSeconds).toBe(3600);
  });

  it('accepts response without instanceId/metadata (backward compat)', () => {
    const parsed = dashboardDiagnosticsResponseSchema.parse(baseResponse);
    expect(parsed.orchestrator.instanceId).toBeUndefined();
    expect(parsed.orchestrator.hostname).toBeUndefined();
  });

  it('accepts response with scalers array', () => {
    const msg = {
      ...baseResponse,
      scalers: [
        {
          name: 'docker-pool',
          type: 'container',
          maxAgents: 10,
          activeAgents: 3,
          labelSets: [
            ['linux', 'x64'],
            ['linux', 'arm64'],
          ],
          config: { runtime: 'podman', host: null },
        },
      ],
    };
    const parsed = dashboardDiagnosticsResponseSchema.parse(msg);
    expect(parsed.scalers).toHaveLength(1);
    expect(parsed.scalers![0].name).toBe('docker-pool');
    expect(parsed.scalers![0].type).toBe('container');
    expect(parsed.scalers![0].maxAgents).toBe(10);
    expect(parsed.scalers![0].activeAgents).toBe(3);
    expect(parsed.scalers![0].labelSets).toEqual([
      ['linux', 'x64'],
      ['linux', 'arm64'],
    ]);
    expect(parsed.scalers![0].config).toEqual({ runtime: 'podman', host: null });
  });

  it('accepts response without scalers (backward compat)', () => {
    const parsed = dashboardDiagnosticsResponseSchema.parse(baseResponse);
    expect(parsed.scalers).toBeUndefined();
  });

  it('accepts agent entries with metadata and scalerName', () => {
    const msg = {
      ...baseResponse,
      agents: [
        {
          agentId: 'agent-1',
          labels: ['linux'],
          platform: 'linux',
          arch: 'x64',
          activeJobs: 0,
          maxConcurrency: 1,
          lastHeartbeatAt: Date.now(),
          registeredAt: Date.now(),
          version: '1.0.0',
          hostname: 'worker-01',
          osRelease: '6.1.0',
          totalMemoryMb: 8192,
          cpuCount: 4,
          nodeVersion: '24.0.0',
          memoryUsedMb: 2048,
          memoryAvailableMb: 6144,
          uptimeSeconds: 7200,
          scalerName: 'docker-pool',
        },
      ],
    };
    const parsed = dashboardDiagnosticsResponseSchema.parse(msg);
    expect(parsed.agents[0].hostname).toBe('worker-01');
    expect(parsed.agents[0].scalerName).toBe('docker-pool');
    expect(parsed.agents[0].memoryUsedMb).toBe(2048);
  });
});

describe('dashboardDiagnosticsResponseSchema peers field', () => {
  const baseResponse = {
    type: 'dashboard.diagnostics.response',
    requestId: 'req-peers-1',
    orchestrator: {
      version: '1.0.0',
      mode: 'platform',
      scalerBackends: ['container'],
      runningJobs: 0,
      queuedJobs: 0,
      pendingLabelGaps: [],
    },
    agents: [],
  };

  it('accepts response with empty peers array', () => {
    const msg = { ...baseResponse, peers: [] };
    const parsed = dashboardDiagnosticsResponseSchema.parse(msg);
    expect(parsed.peers).toEqual([]);
  });

  it('accepts response with peers omitted (undefined)', () => {
    const parsed = dashboardDiagnosticsResponseSchema.parse(baseResponse);
    expect(parsed.peers).toBeUndefined();
  });

  it('accepts response with a populated peer entry', () => {
    const msg = {
      ...baseResponse,
      peers: [
        {
          instanceId: 'worker-001',
          role: 'worker',
          connected: true,
          lastHeartbeatAt: Date.now(),
          draining: false,
          agents: [
            {
              agentId: 'agent-w1',
              labels: ['linux', 'x64'],
              platform: 'linux',
              arch: 'x64',
              activeJobs: 1,
              maxConcurrency: 4,
            },
          ],
        },
      ],
    };
    const parsed = dashboardDiagnosticsResponseSchema.parse(msg);
    expect(parsed.peers).toHaveLength(1);
    expect(parsed.peers![0].instanceId).toBe('worker-001');
    expect(parsed.peers![0].role).toBe('worker');
    expect(parsed.peers![0].agents).toHaveLength(1);
    expect(parsed.peers![0].agents[0].agentId).toBe('agent-w1');
  });

  it('accepts peer with scalerCapacity and dependencyHealth', () => {
    const msg = {
      ...baseResponse,
      peers: [
        {
          instanceId: 'worker-002',
          role: 'worker',
          connected: true,
          lastHeartbeatAt: Date.now(),
          draining: false,
          agents: [],
          scalerCapacity: [
            {
              name: 'docker-pool',
              type: 'container',
              activeCount: 2,
              maxAgents: 5,
              labelSets: [['linux', 'x64']],
            },
          ],
          dependencyHealth: [
            {
              name: 'postgres',
              status: 'pass',
              message: null,
              details: { latencyMs: 5 },
              durationMs: 12,
            },
            {
              name: 's3',
              status: 'warn',
              message: 'Slow response',
            },
          ],
        },
      ],
    };
    const parsed = dashboardDiagnosticsResponseSchema.parse(msg);
    expect(parsed.peers![0].scalerCapacity).toHaveLength(1);
    expect(parsed.peers![0].scalerCapacity![0].name).toBe('docker-pool');
    expect(parsed.peers![0].dependencyHealth).toHaveLength(2);
    expect(parsed.peers![0].dependencyHealth![0].status).toBe('pass');
    expect(parsed.peers![0].dependencyHealth![1].message).toBe('Slow response');
  });
});

describe('runCancelRequestSchema force flag', () => {
  const validCancel = {
    type: 'run.cancel.request',
    requestId: 'req-001',
    actor: testActor,
    runId: 'run-abc',
  };

  it('accepts optional force: true', () => {
    const parsed = runCancelRequestSchema.parse({ ...validCancel, force: true });
    expect(parsed.force).toBe(true);
  });

  it('accepts without force', () => {
    const parsed = runCancelRequestSchema.parse(validCancel);
    expect(parsed.force).toBeUndefined();
  });
});

describe('dashboardEventLogPayloadStreamRequestSchema', () => {
  const valid = {
    type: 'dashboard.event-log.payload.stream',
    requestId: 'req-stream-1',
    actor: testActor,
    orgId: 'org-1',
    deliveryId: 'delivery-1',
  };

  it('validates the canonical shape', () => {
    expect(dashboardEventLogPayloadStreamRequestSchema.parse(valid)).toEqual(valid);
  });

  it('accepts optional routingKey hint', () => {
    const withKey = { ...valid, routingKey: 'github:42/owner/repo' };
    expect(dashboardEventLogPayloadStreamRequestSchema.parse(withKey).routingKey).toBe(
      'github:42/owner/repo',
    );
  });

  it('rejects missing deliveryId', () => {
    const { deliveryId: _, ...rest } = valid;
    expect(() => dashboardEventLogPayloadStreamRequestSchema.parse(rest)).toThrow();
  });

  it('rejects missing actor', () => {
    const { actor: _, ...rest } = valid;
    expect(() => dashboardEventLogPayloadStreamRequestSchema.parse(rest)).toThrow();
  });
});

describe('dashboardEventLogPayloadChunkSchema', () => {
  const baseChunk = {
    type: 'dashboard.event-log.payload.chunk',
    requestId: 'req-stream-1',
    seq: 0,
    data: 'aGVsbG8=',
    isLast: false,
  };

  it('validates an interior (non-terminal) chunk', () => {
    expect(dashboardEventLogPayloadChunkSchema.parse(baseChunk)).toEqual(baseChunk);
  });

  it('accepts totalBytes only on first chunk', () => {
    const first = { ...baseChunk, seq: 0, totalBytes: 1024 };
    expect(dashboardEventLogPayloadChunkSchema.parse(first).totalBytes).toBe(1024);
  });

  it('accepts terminal chunk with isLast and an error code', () => {
    const terminal = {
      ...baseChunk,
      seq: 0,
      data: '',
      isLast: true,
      error: 'payload_unavailable' as const,
    };
    const parsed = dashboardEventLogPayloadChunkSchema.parse(terminal);
    expect(parsed.isLast).toBe(true);
    expect(parsed.error).toBe('payload_unavailable');
  });

  it('rejects unknown error codes', () => {
    const invalid = { ...baseChunk, isLast: true, error: 'made_up_reason' };
    expect(() => dashboardEventLogPayloadChunkSchema.parse(invalid)).toThrow();
  });

  it('rejects negative seq', () => {
    expect(() => dashboardEventLogPayloadChunkSchema.parse({ ...baseChunk, seq: -1 })).toThrow();
  });
});

describe('browserEventLogPayloadChunkSchema', () => {
  it('mirrors the orchestrator-side chunk shape', () => {
    const chunk = {
      type: 'event-log.payload.chunk',
      requestId: 'req-stream-1',
      seq: 3,
      data: 'd29ybGQ=',
      isLast: true,
      totalBytes: 2048,
    };
    expect(browserEventLogPayloadChunkSchema.parse(chunk)).toEqual(chunk);
  });

  it('rejects the orchestrator-side type literal (different namespace)', () => {
    const wrong = {
      type: 'dashboard.event-log.payload.chunk',
      requestId: 'r',
      seq: 0,
      data: '',
      isLast: true,
    };
    expect(() => browserEventLogPayloadChunkSchema.parse(wrong)).toThrow();
  });
});

describe('dashboardJobDetailSchema with initFailure', () => {
  const baseJob = {
    jobId: 'rejected-abc',
    jobName: 'deploy',
    status: 'failed',
    matrixValues: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    agentId: null,
    errorMessage: 'Rejected by protection rules',
    steps: [],
  };

  it('accepts a job-scoped initFailure', () => {
    const job = {
      ...baseJob,
      initFailure: {
        scope: 'job' as const,
        category: InitFailureCategory.enum.environment_rules,
        message: 'Rejected by protection rules',
        jobName: 'deploy',
      },
    };
    expect(dashboardJobDetailSchema.parse(job).initFailure?.category).toBe('environment_rules');
  });

  it('omits initFailure for normal jobs', () => {
    expect(dashboardJobDetailSchema.parse(baseJob).initFailure).toBeUndefined();
  });
});

describe('dashboardRunDetailResponseSchema with initFailure', () => {
  it('accepts a run-scoped initFailure on the response', () => {
    const res = {
      type: 'dashboard.run.detail.response' as const,
      requestId: 'r1',
      jobs: [],
      initFailure: {
        scope: 'run' as const,
        category: InitFailureCategory.enum.install_secrets,
        message: '.npmrc resolution rejected',
      },
    };
    expect(dashboardRunDetailResponseSchema.parse(res).initFailure?.category).toBe(
      'install_secrets',
    );
  });
});

describe('dashboardRunDetailApiResponseSchema with initFailure', () => {
  it('accepts a run-scoped initFailure on the REST API response', () => {
    const res = {
      jobs: [],
      initFailure: {
        scope: 'run' as const,
        category: InitFailureCategory.enum.install_secrets,
        message: '.npmrc resolution rejected',
      },
    };
    expect(dashboardRunDetailApiResponseSchema.parse(res).initFailure?.category).toBe(
      'install_secrets',
    );
  });

  it('omits initFailure for normal runs', () => {
    const res = { jobs: [] };
    expect(dashboardRunDetailApiResponseSchema.parse(res).initFailure).toBeUndefined();
  });
});

describe('REST response schemas (CLI reuse)', () => {
  it('runListResponseSchema validates a minimal page envelope', () => {
    const ok = runListResponseSchema.parse({
      runs: [],
      total: 0,
      page: 1,
      pageSize: 20,
      hasMore: false,
    });
    expect(ok.pageSize).toBe(20);
  });

  it('runListResponseSchema validates a populated run item', () => {
    const ok = runListResponseSchema.parse({
      runs: [
        {
          runId: 'r1',
          workflowName: 'ci',
          status: 'success',
          repoIdentifier: 'o/r',
          sha: 'abc',
          ref: 'main',
          triggerEvent: 'push',
          commitMessage: 'fix',
          jobCount: 2,
          startedAt: '2026-06-12T00:00:00.000Z',
          completedAt: '2026-06-12T00:00:05.000Z',
          durationMs: 5000,
          parentRunId: null,
          originalRunId: null,
          triggeredBy: null,
          triggeredByUser: null,
          cancelledBy: null,
          cancelledByUser: null,
          hadCompileJob: false,
          compileJobId: null,
          source: null,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      hasMore: false,
    });
    expect(ok.runs[0].runId).toBe('r1');
  });

  it('diagnosticsInfrastructureResponseSchema validates an empty tree', () => {
    const ok = diagnosticsInfrastructureResponseSchema.parse({
      orchestrators: [],
      alerts: [],
    });
    expect(ok.orchestrators).toEqual([]);
  });

  it('diagnosticsInfrastructureResponseSchema accepts an orchestrator with scalers and agents', () => {
    const ok = diagnosticsInfrastructureResponseSchema.parse({
      orchestrators: [
        {
          connectionId: 'conn-1',
          clusterName: 'c1',
          instanceId: 'i1',
          routingKeys: ['github:1'],
          connected: true,
          agentCount: 1,
          runningJobs: 0,
          queuedJobs: 0,
          pendingLabelGaps: [],
          scalerBackends: [],
          deployment: {
            mode: 'compose',
            containerName: 'kici-orchestrator',
            containerRuntime: 'podman',
          },
          statefulAgentCount: 0,
          scalers: [
            {
              name: 's1',
              type: 'container',
              maxAgents: 5,
              activeAgents: 1,
              labelSets: [['linux']],
              hosts: [],
            },
          ],
          agents: [
            {
              agentId: 'a1',
              labels: ['linux', 'x64'],
              platform: 'linux',
              arch: 'x64',
              activeJobs: 0,
              maxConcurrency: 2,
              lastHeartbeatAt: 1,
              registeredAt: 1,
              scalerName: 's1',
            },
          ],
        },
      ],
      alerts: [{ type: 'zero-agents', message: 'none', severity: 'warning' }],
    });
    expect(ok.orchestrators[0].agents[0].labels).toContain('linux');
    expect(ok.orchestrators[0].deployment).toEqual({
      mode: 'compose',
      containerName: 'kici-orchestrator',
      containerRuntime: 'podman',
    });
  });

  it('diagnosticsInfrastructureResponseSchema accepts an unknown deployment shape', () => {
    const ok = diagnosticsInfrastructureResponseSchema.parse({
      orchestrators: [
        {
          connectionId: 'conn-2',
          routingKeys: [],
          connected: true,
          agentCount: 0,
          runningJobs: 0,
          queuedJobs: 0,
          pendingLabelGaps: [],
          scalerBackends: [],
          deployment: { mode: 'unknown', containerName: null, containerRuntime: null },
          statefulAgentCount: 0,
          scalers: [],
          agents: [],
        },
      ],
      alerts: [],
    });
    expect(ok.orchestrators[0].deployment.mode).toBe('unknown');
  });
});

describe('fleetHostDeclareRequestSchema labels optionality', () => {
  it('accepts a declare request with labels omitted', () => {
    const parsed = fleetHostDeclareRequestSchema.parse({
      type: 'dashboard.fleet.host.declare',
      requestId: 'r1',
      actor: testActor,
      agentId: 'db-01',
    });
    expect(parsed.labels).toBeUndefined();
  });

  it('accepts a declare request with labels provided', () => {
    const parsed = fleetHostDeclareRequestSchema.parse({
      type: 'dashboard.fleet.host.declare',
      requestId: 'r1',
      actor: testActor,
      agentId: 'db-01',
      labels: ['role:db'],
    });
    expect(parsed.labels).toEqual(['role:db']);
  });
});

describe('fleetHostDeclareResponseSchema created flag', () => {
  it('accepts a response carrying created', () => {
    const parsed = fleetHostDeclareResponseSchema.parse({
      type: 'dashboard.fleet.host.declare.response',
      requestId: 'r1',
      declared: true,
      created: false,
    });
    expect(parsed.created).toBe(false);
  });
});
