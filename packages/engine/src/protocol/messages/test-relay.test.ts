import { describe, expect, it } from 'vitest';
import {
  TestRelayType,
  testRelayUploadsInitRequestSchema,
  testRelayUploadsInitResponseSchema,
  testRelayTriggerRequestSchema,
  testRelayTriggerResponseSchema,
  testRelayRunStatusRequestSchema,
  testRelayRunLogsRequestSchema,
  testRelayRunLogsResponseSchema,
  testRelayCancelRequestSchema,
  dashboardPlatformToOrchSchema,
  dashboardOrchToPlatformSchema,
  RUN_DETAIL_SOURCE_HEADER,
  RUN_DETAIL_FALLBACK_REASON_HEADER,
  RunDetailSource,
  RunDetailFallbackReason,
  TEST_RUN_LOG_CURSOR_START,
} from './dashboard.js';

const actor = { type: 'user' as const, sub: 'sub-1' };

describe('test-relay control messages', () => {
  it('enumerates the five relay request types', () => {
    expect(TestRelayType.options).toEqual([
      'test.relay.uploads.init',
      'test.relay.trigger',
      'test.relay.run.status',
      'test.relay.run.logs',
      'test.relay.cancel',
    ]);
  });

  it('parses uploads.init request + response', () => {
    const req = testRelayUploadsInitRequestSchema.parse({
      type: 'test.relay.uploads.init',
      requestId: 'r1',
      actor,
      routingKey: 'remote:org_abc',
      sha: 'deadbeef',
    });
    expect(req.routingKey).toBe('remote:org_abc');
    const res = testRelayUploadsInitResponseSchema.parse({
      type: 'test.relay.uploads.init.response',
      requestId: 'r1',
      uploadId: 'u1',
      signedUrl: 'https://store/put',
      publicKey: 'base64key',
      expiresIn: 3600,
    });
    expect(res.uploadId).toBe('u1');
  });

  it('parses trigger request + response', () => {
    const req = testRelayTriggerRequestSchema.parse({
      type: 'test.relay.trigger',
      requestId: 'r2',
      actor,
      routingKey: 'remote:org_abc',
      fixtureId: 'push-main',
      event: { type: 'push', targetBranch: 'main', payload: {} },
      uploadId: 'u1',
    });
    expect(req.fixtureId).toBe('push-main');
    const res = testRelayTriggerResponseSchema.parse({
      type: 'test.relay.trigger.response',
      requestId: 'r2',
      runId: 'run-1',
      status: 'accepted',
      jobIds: ['j1'],
    });
    expect(res.status).toBe('accepted');
  });

  it('carries the multi-run capability flag, the per-workflow runs and the per-line job names across both unions', () => {
    const req = dashboardPlatformToOrchSchema.parse({
      type: 'test.relay.trigger',
      requestId: 'r2',
      actor,
      routingKey: 'remote:org_abc',
      fixtureId: 'push-main',
      event: { type: 'push', targetBranch: 'main', payload: {} },
      acceptsMultipleRuns: true,
    });
    // fails-when: the schema lacks the flag, so the orchestrator's frame parse strips it
    expect(req).toMatchObject({ acceptsMultipleRuns: true });

    const runs = [
      { runId: 'run-a', workflowName: 'wf-a', jobIds: ['j1'] },
      { runId: 'run-b', workflowName: 'wf-b' },
    ];
    const res = dashboardOrchToPlatformSchema.parse({
      type: 'test.relay.trigger.response',
      requestId: 'r2',
      runId: 'run-a',
      runs,
      status: 'accepted',
    });
    // fails-when: the Platform's frame parse strips `runs`, so it records one owner
    expect(res).toMatchObject({ runId: 'run-a', runs });

    const status = dashboardOrchToPlatformSchema.parse({
      type: 'test.relay.run.status.response',
      requestId: 'r3',
      runId: 'run-a',
      status: 'failed',
      jobs: [],
      failureReason: 'secret not found',
      done: true,
    });
    // fails-when: the status frame drops the run's failure reason
    expect(status).toMatchObject({ failureReason: 'secret not found' });

    const logs = dashboardOrchToPlatformSchema.parse({
      type: 'test.relay.run.logs.response',
      requestId: 'r4',
      lines: ['a', 'b'],
      lineJobNames: ['build', 'test'],
      nextCursor: 2,
      done: false,
    });
    // fails-when: the logs frame drops the per-line job names
    expect(logs).toMatchObject({ lineJobNames: ['build', 'test'] });
  });

  it('parses run.status / run.logs / cancel', () => {
    expect(
      testRelayRunStatusRequestSchema.parse({
        type: 'test.relay.run.status',
        requestId: 'r3',
        actor,
        runId: 'run-1',
      }).runId,
    ).toBe('run-1');
    const logsReq = testRelayRunLogsRequestSchema.parse({
      type: 'test.relay.run.logs',
      requestId: 'r4',
      actor,
      runId: 'run-1',
      cursor: 0,
    });
    expect(logsReq.cursor).toBe(0);
    // breaks-if-wrong: an older CLI's request, numeric cursor only, still parses
    expect(logsReq).not.toHaveProperty('logCursor');
    const perFile = testRelayRunLogsRequestSchema.parse({
      type: 'test.relay.run.logs',
      requestId: 'r4b',
      actor,
      runId: 'run-1',
      cursor: 0,
      logCursor: TEST_RUN_LOG_CURSOR_START,
    });
    // fails-when: the schema drops logCursor, so the orchestrator's frame parse
    // strips it and the per-file cursor never reaches the handler
    expect(perFile.logCursor).toBe('');
    expect(
      testRelayRunLogsResponseSchema.parse({
        type: 'test.relay.run.logs.response',
        requestId: 'r4b',
        lines: [],
        nextCursor: 0,
        nextLogCursor: 'e30',
        done: false,
      }).nextLogCursor,
    ).toBe('e30');
    const logsRes = testRelayRunLogsResponseSchema.parse({
      type: 'test.relay.run.logs.response',
      requestId: 'r4',
      lines: ['hello'],
      nextCursor: 1,
      done: false,
    });
    expect(logsRes.nextCursor).toBe(1);
    expect(
      testRelayCancelRequestSchema.parse({
        type: 'test.relay.cancel',
        requestId: 'r5',
        actor,
        runId: 'run-1',
      }).runId,
    ).toBe('run-1');
  });

  it('routes all five requests through the Platform→orch union', () => {
    for (const type of TestRelayType.options) {
      const base = { type, requestId: 'x', actor } as Record<string, unknown>;
      if (type === 'test.relay.uploads.init') base.routingKey = 'remote:o';
      if (type === 'test.relay.trigger') {
        base.routingKey = 'remote:o';
        base.fixtureId = 'f';
        base.event = { type: 'push', targetBranch: 'main', payload: {} };
      }
      if (type === 'test.relay.run.status') base.runId = 'run-1';
      if (type === 'test.relay.run.logs') {
        base.runId = 'run-1';
        base.cursor = 0;
      }
      const parsed = dashboardPlatformToOrchSchema.parse(base);
      expect(parsed.type).toBe(type);
    }
  });

  it('routes all five responses through the orch→Platform union', () => {
    const responses = [
      { type: 'test.relay.uploads.init.response', requestId: 'x' },
      { type: 'test.relay.trigger.response', requestId: 'x' },
      { type: 'test.relay.run.status.response', requestId: 'x' },
      { type: 'test.relay.run.logs.response', requestId: 'x' },
      { type: 'test.relay.cancel.response', requestId: 'x' },
    ];
    for (const r of responses) {
      expect(dashboardOrchToPlatformSchema.parse(r).type).toBe(r.type);
    }
  });
});

describe('run-detail source headers', () => {
  it('names the source and fallback-reason headers and their values', () => {
    expect(RUN_DETAIL_SOURCE_HEADER).toBe('X-Detail-Source');
    expect(RUN_DETAIL_FALLBACK_REASON_HEADER).toBe('X-Detail-Fallback-Reason');
    // breaks-if-wrong: the existing header values stay byte-identical, so a
    // dashboard or test that reads `orchestrator-proxy` keeps working
    expect(RunDetailSource.options).toEqual(['orchestrator-proxy', 'platform-db']);
    expect(RunDetailFallbackReason.safeParse('orchestrator_timeout').success).toBe(true);
    expect(RunDetailFallbackReason.safeParse('anything-else').success).toBe(false);
  });
});
