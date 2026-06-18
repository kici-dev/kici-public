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
