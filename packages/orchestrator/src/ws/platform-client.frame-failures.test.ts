import { afterEach, describe, expect, it, vi } from 'vitest';

// A sibling of platform-client.test.ts with its own logger mock, so asserting
// on the failure log does not change what the main suite sees.
const { mockInstances, mockLogError } = vi.hoisted(() => ({
  mockInstances: [] as import('node:events').EventEmitter[],
  mockLogError: vi.fn(),
}));

vi.mock('@kici-dev/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kici-dev/shared')>();
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: mockLogError, debug: vi.fn() }),
  };
});

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class MockWS extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    sentMessages: string[] = [];
    constructor() {
      super();
      mockInstances.push(this);
    }
    send(data: string): void {
      this.sentMessages.push(data);
    }
    close(): void {
      this.readyState = 3;
    }
  }
  return { default: MockWS, WebSocket: MockWS };
});

import {
  ExecutionJobStatus,
  NackCode,
  STATUS_FREE_TEXT_MAX,
  STATUS_ID_MAX,
  type OrchestratorToPlatformMessage,
} from '@kici-dev/engine';
import { PlatformClient, type PlatformClientOptions } from './platform-client.js';

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const clients: PlatformClient[] = [];

interface ConnectOptions {
  /** Frames sent before the connection authenticates, so they wait in the buffer. */
  buffered?: OrchestratorToPlatformMessage[];
  /** Runs on the socket before it opens. */
  beforeOpen?: (ws: MockSocket) => void;
}

type MockSocket = import('node:events').EventEmitter & {
  readyState: number;
  sentMessages: string[];
  send(data: string): void;
};

function connected(overrides: Partial<PlatformClientOptions>, opts: ConnectOptions = {}) {
  const client = new PlatformClient({
    url: 'ws://localhost:9999/ws',
    token: 'test-api-key',
    onWebhookRelay: vi.fn().mockResolvedValue(undefined),
    heartbeatIntervalMs: 30_000,
    maxReconnectDelayMs: 60_000,
    ...overrides,
  });
  clients.push(client);
  for (const frame of opts.buffered ?? []) client.send(frame);
  client.connect();
  const ws = mockInstances[mockInstances.length - 1]! as MockSocket;
  opts.beforeOpen?.(ws);
  ws.emit('open');
  ws.emit(
    'message',
    JSON.stringify({
      type: 'auth.success',
      connectionId: 'conn-1',
      orgPublicAlias: 'oal_test',
      orgId: 'org_test',
      githubWebhookUrl: null,
    }),
  );
  return { client, ws };
}

const runDetail = (requestId: string) =>
  JSON.stringify({
    type: 'dashboard.run.detail',
    requestId,
    actor: { type: 'user', sub: 'sub-1' },
    runId: 'run-1',
  });

afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
  mockInstances.length = 0;
  mockLogError.mockClear();
});

describe('Platform frame handler failures', () => {
  // fails-when: an async handler's rejection is left unhandled — the shutdown
  // hook stops the orchestrator.
  it('logs a rejected handler with the frame type and request, and handles the next frame', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const onDashboardRunDetail = vi
        .fn()
        .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
        .mockResolvedValueOnce(undefined);
      const { ws } = connected({
        dashboardHandlers: { 'dashboard.run.detail': onDashboardRunDetail },
      });

      ws.emit('message', runDetail('req-1'));
      await settle();
      ws.emit('message', runDetail('req-2'));
      await settle();

      expect(mockLogError).toHaveBeenCalledWith(
        'Platform frame handler failed',
        expect.objectContaining({
          messageType: 'dashboard.run.detail',
          requestId: 'req-1',
          runId: 'run-1',
          error: 'Connection terminated unexpectedly',
        }),
      );
      // breaks-if-wrong: the next frame still reaches its handler.
      expect(onDashboardRunDetail).toHaveBeenCalledTimes(2);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  // fails-when: a synchronous throw escapes the socket's message listener.
  it('logs a handler that throws synchronously', () => {
    const onDashboardRunDetail = vi.fn(() => {
      throw new TypeError('boom');
    });
    const { ws } = connected({
      dashboardHandlers: { 'dashboard.run.detail': onDashboardRunDetail },
    });

    expect(() => ws.emit('message', runDetail('req-3'))).not.toThrow();
    expect(mockLogError).toHaveBeenCalledWith(
      'Platform frame handler failed',
      expect.objectContaining({
        messageType: 'dashboard.run.detail',
        requestId: 'req-3',
        error: 'boom',
      }),
    );
  });

  // fails-when: the log-pull path (a separate schema) invokes its handler bare.
  it('logs a rejected log-pull handler', async () => {
    const onLogPullRequest = vi.fn().mockRejectedValue(new Error('log storage down'));
    const { ws } = connected({ onLogPullRequest });

    ws.emit(
      'message',
      JSON.stringify({ type: 'log.request', messageId: 'm-1', executionId: 'exec-1' }),
    );
    await settle();

    expect(mockLogError).toHaveBeenCalledWith(
      'Platform frame handler failed',
      expect.objectContaining({ messageType: 'log.request', error: 'log storage down' }),
    );
  });

  // fails-when: the post-registration hook's rejection is left unhandled.
  it('logs a rejected authenticated hook', async () => {
    const onAuthenticated = vi.fn().mockRejectedValue(new Error('roster read failed'));
    const { ws } = connected({ onAuthenticated });

    ws.emit(
      'message',
      JSON.stringify({ type: 'source.register.ack', messageId: 'm-2', accepted: [], rejected: [] }),
    );
    await settle();

    expect(onAuthenticated).toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalledWith(
      'Platform authenticated hook failed',
      expect.objectContaining({ error: 'roster read failed' }),
    );
  });
});

const jobFrame = (messageId: string, extra: Record<string, unknown> = {}) =>
  ({
    type: 'job.status.forward',
    messageId,
    runId: 'run-1',
    jobId: 'job-1',
    jobName: 'build',
    status: ExecutionJobStatus.enum.failed,
    timestamp: 1,
    ...extra,
  }) as OrchestratorToPlatformMessage;

const sentIds = (ws: MockSocket) =>
  ws.sentMessages.map((m) => (JSON.parse(m) as { messageId?: string }).messageId);

describe('Outbound frames to the Platform', () => {
  it('never sends a status frame the Platform would reject', () => {
    const { client, ws } = connected({});
    client.send(jobFrame('bad', { jobId: 'J'.repeat(STATUS_ID_MAX + 1) }));
    // fails-when: the invalid frame is written to the socket
    expect(sentIds(ws)).not.toContain('bad');
    expect(mockLogError).toHaveBeenCalledWith(
      'Refusing to send an invalid frame to the Platform',
      expect.objectContaining({ messageType: 'job.status.forward' }),
    );
  });

  it('sends a long status error clamped', () => {
    const { client, ws } = connected({});
    client.send(jobFrame('long', { errorMessage: 'e'.repeat(9_000) }));
    const sent = ws.sentMessages.map((m) => JSON.parse(m)).find((m) => m.messageId === 'long');
    // breaks-if-wrong: the valid frame still goes out
    expect(sent.errorMessage).toHaveLength(STATUS_FREE_TEXT_MAX);
  });

  it('keeps the frames behind a buffered frame that cannot be serialized', () => {
    const { ws } = connected(
      {},
      {
        buffered: [
          jobFrame('buf-1'),
          jobFrame('buf-2', { matrixValues: { size: 10n } }),
          jobFrame('buf-3'),
        ],
      },
    );
    // fails-when: the serialization error aborts the flush and loses buf-3
    expect(sentIds(ws)).toEqual(expect.arrayContaining(['buf-1', 'buf-3']));
    expect(sentIds(ws)).not.toContain('buf-2');
    expect(mockLogError).toHaveBeenCalledWith(
      'Dropping a buffered frame that cannot be serialized',
      expect.objectContaining({ messageType: 'job.status.forward' }),
    );
  });

  it('keeps the unsent frames when the socket closes during the flush', () => {
    const { client, ws } = connected(
      {},
      {
        buffered: [jobFrame('buf-1'), jobFrame('buf-2'), jobFrame('buf-3')],
        beforeOpen: (socket) => {
          const write = socket.send.bind(socket);
          socket.send = (data: string) => {
            write(data);
            if (data.includes('"buf-1"')) socket.readyState = 3;
          };
        },
      },
    );
    expect(sentIds(ws)).toContain('buf-1');
    // fails-when: frames removed from the buffer are dropped once the socket is not open
    expect(client.getBufferedCount()).toBe(2);
  });

  it('logs an invalid-frame NACK from the Platform as an error and keeps the connection', () => {
    const { ws } = connected({});
    const before = ws.sentMessages.length;
    ws.emit(
      'message',
      JSON.stringify({
        type: 'nack',
        code: NackCode.enum.invalid_frame,
        messageId: 'm-9',
        receivedType: 'job.status.forward',
        reason: 'invalid job.status.forward frame dropped: jobId failed validation',
      }),
    );
    // fails-when: the orchestrator reports its own invalid frame as version skew
    expect(mockLogError).toHaveBeenCalledWith(
      'Platform dropped an invalid frame (NACK)',
      expect.objectContaining({ receivedType: 'job.status.forward', messageId: 'm-9' }),
    );
    // breaks-if-wrong: the NACK is never answered and never closes the uplink
    expect(ws.sentMessages.length).toBe(before);
    expect(ws.readyState).toBe(1);
  });
});
