import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PROTOCOL_VERSION,
  WS_MAX_PAYLOAD_BYTES,
  type AgentToOrchestratorMessage,
} from '@kici-dev/engine';
import {
  MAX_COMPLETE_RESEND_ATTEMPTS,
  OrchestratorClient,
  type OrchestratorClientOptions,
} from './orchestrator-client.js';
import { readAgentVersion } from '../version.js';

// ── Hoisted mock state ──────────────────────────────────────────────

/**
 * vi.hoisted runs before any imports, making these values available
 * inside the vi.mock factory which is also hoisted.
 */
const { mockInstances, mockConstructorArgs } = vi.hoisted(() => {
  return {
    mockInstances: [] as import('node:events').EventEmitter[],
    // Each entry is the argv array a single `new WebSocket(...)` call received.
    // Used by the compression-bomb-defense invariant test to introspect
    // the options object passed to the WS constructor.
    mockConstructorArgs: [] as unknown[][],
  };
});

/**
 * Mock the 'ws' module. The factory must be self-contained.
 * We import EventEmitter inside the factory to avoid hoisting issues.
 */
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');

  class MockWS extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;

    readyState = 1; // OPEN
    sentMessages: string[] = [];
    closeCode?: number;
    closeReason?: string;

    constructor(...args: unknown[]) {
      super();
      mockConstructorArgs.push(args);
      mockInstances.push(this);
    }

    send(data: string): void {
      this.sentMessages.push(data);
    }

    close(code?: number, reason?: string): void {
      this.closeCode = code;
      this.closeReason = reason;
      this.readyState = 3; // CLOSED
      setImmediate(() => {
        this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
      });
    }
  }

  return {
    default: MockWS,
    WebSocket: MockWS,
  };
});

// ── Typed helpers ───────────────────────────────────────────────────

interface MockWsInstance {
  readyState: number;
  sentMessages: string[];
  closeCode?: number;
  closeReason?: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  emit(event: string, ...args: unknown[]): boolean;
  on(event: string, listener: (...args: unknown[]) => void): MockWsInstance;
}

function getLatestMock(): MockWsInstance {
  return mockInstances[mockInstances.length - 1] as unknown as MockWsInstance;
}

function getSentMessages(mock: MockWsInstance): unknown[] {
  return mock.sentMessages.map((m) => JSON.parse(m));
}

function simulateMessage(mock: MockWsInstance, data: unknown): void {
  mock.emit('message', JSON.stringify(data));
}

function simulateOpen(mock: MockWsInstance): void {
  mock.emit('open');
}

/** Simulate the orchestrator sending register.ack to complete the handshake. */
function simulateRegisterAck(
  mock: MockWsInstance,
  overrides: Partial<{
    agentId: string;
    labels: string[];
    scalerManaged: boolean;
    /** Agent-facing capabilities; omit to model a pre-capability orchestrator. */
    capabilities: Record<string, unknown>;
  }> = {},
): void {
  simulateMessage(mock, {
    type: 'register.ack',
    agentId: overrides.agentId ?? 'agent-test-1',
    labels: overrides.labels ?? ['linux', 'docker'],
    scalerManaged: overrides.scalerManaged ?? false,
    ...(overrides.capabilities ? { capabilities: overrides.capabilities } : {}),
  });
}

// ── Test helpers ────────────────────────────────────────────────────

function createClient(overrides: Partial<OrchestratorClientOptions> = {}) {
  return new OrchestratorClient({
    url: 'ws://localhost:9999/ws/agent',
    agentId: 'agent-test-1',
    labels: ['linux', 'docker'],
    onJobDispatch: vi.fn(),
    onJobCancel: vi.fn(),
    heartbeatIntervalMs: 30_000,
    maxReconnectDelayMs: 60_000,
    ...overrides,
  });
}

/**
 * Connect and register the client. Simulates the full handshake:
 * connect -> open -> send agent.register -> receive register.ack -> registered.
 */
function registerClient(
  client: OrchestratorClient,
  ackOverrides: Parameters<typeof simulateRegisterAck>[1] = {},
): MockWsInstance {
  client.connect();
  const mock = getLatestMock();
  simulateOpen(mock);
  simulateRegisterAck(mock, ackOverrides);
  return mock;
}

// ── Setup / Teardown ────────────────────────────────────────────────

beforeEach(() => {
  mockInstances.length = 0;
  mockConstructorArgs.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Tests ───────────────────────────────────────────────────────────

describe('OrchestratorClient', () => {
  describe('connection lifecycle', () => {
    it('starts in disconnected state', () => {
      const client = createClient();
      expect(client.state).toBe('disconnected');
    });

    it('transitions: disconnected -> connecting -> registering on open', () => {
      const client = createClient();
      client.connect();

      expect(client.state).toBe('connecting');

      const mock = getLatestMock();
      simulateOpen(mock);

      // Stays in 'registering' until register.ack is received
      expect(client.state).toBe('registering');
    });

    it('transitions to registered on register.ack', () => {
      const client = createClient();
      client.connect();

      const mock = getLatestMock();
      simulateOpen(mock);
      expect(client.state).toBe('registering');

      simulateRegisterAck(mock);
      expect(client.state).toBe('registered');
    });

    it('sends agent.register on open with correct fields', () => {
      const client = createClient({
        agentId: 'my-agent',
        labels: ['gpu', 'linux'],
      });
      client.connect();

      const mock = getLatestMock();
      simulateOpen(mock);

      const sent = getSentMessages(mock);
      expect(sent).toHaveLength(1);
      const msg = sent[0] as Record<string, unknown>;
      expect(msg.type).toBe('agent.register');
      expect(msg.agentId).toBe('my-agent');
      // Labels include user-specified labels plus auto-derived os/arch/host labels
      expect(msg.labels).toEqual(expect.arrayContaining(['gpu', 'linux']));
      // Should NOT have maxConcurrency
      expect(msg.maxConcurrency).toBeUndefined();
      // Should have a messageId
      expect(msg.messageId).toBeDefined();
      // Reports its own package version so the Infrastructure page can show it.
      expect(msg.version).toBe(readAgentVersion());
    });

    it('transitions to disconnected on close', () => {
      const client = createClient();
      const mock = registerClient(client);

      mock.readyState = 3; // CLOSED
      mock.emit('close', 1000, Buffer.from('normal'));

      expect(client.state).toBe('disconnected');
    });
  });

  describe('job dispatch', () => {
    it('routes job.dispatch to onJobDispatch callback', () => {
      const onDispatch = vi.fn();
      const client = createClient({ onJobDispatch: onDispatch });
      const mock = registerClient(client);

      simulateMessage(mock, {
        type: 'job.dispatch',
        messageId: 'msg-1',
        runId: 'run-1',
        jobId: 'job-1',
        repoUrl: 'https://github.com/test/repo',
        ref: 'refs/heads/main',
        sha: 'abc123',
        lockFileUrl: 'https://raw.githubusercontent.com/test/repo/main/.kici/kici.lock.json',
        jobConfig: { name: 'build' },
        timestamp: Date.now(),
      });

      expect(onDispatch).toHaveBeenCalledTimes(1);
      expect(onDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'job.dispatch',
          runId: 'run-1',
          jobId: 'job-1',
        }),
      );
    });
  });

  describe('job cancel', () => {
    it('routes job.cancel to onJobCancel callback', () => {
      const onCancel = vi.fn();
      const client = createClient({ onJobCancel: onCancel });
      const mock = registerClient(client);

      simulateMessage(mock, {
        type: 'job.cancel',
        messageId: 'msg-2',
        runId: 'run-1',
        jobId: 'job-1',
        reason: 'User cancelled',
      });

      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onCancel).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'job.cancel',
          runId: 'run-1',
          jobId: 'job-1',
          reason: 'User cancelled',
        }),
      );
    });
  });

  describe('send() and buffering', () => {
    it('sends immediately when registered', () => {
      const client = createClient();
      const mock = registerClient(client);
      mock.sentMessages = [];

      const msg: AgentToOrchestratorMessage = {
        type: 'job.status',
        messageId: 'msg-1',
        runId: 'run-1',
        jobId: 'job-1',
        state: 'running',
        timestamp: Date.now(),
      };

      client.send(msg);

      const sent = getSentMessages(mock);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ type: 'job.status', runId: 'run-1' });
    });

    it('buffers messages when disconnected', () => {
      const client = createClient();

      const msg: AgentToOrchestratorMessage = {
        type: 'job.status',
        messageId: 'msg-1',
        runId: 'run-1',
        jobId: 'job-1',
        state: 'running',
        timestamp: Date.now(),
      };

      client.send(msg);
      expect(client.getBufferedCount()).toBe(1);
    });

    it('buffers messages when connecting (not yet registered)', () => {
      const client = createClient();
      client.connect();

      const msg: AgentToOrchestratorMessage = {
        type: 'job.status',
        messageId: 'msg-1',
        runId: 'run-1',
        jobId: 'job-1',
        state: 'running',
        timestamp: Date.now(),
      };

      client.send(msg);
      expect(client.getBufferedCount()).toBe(1);
    });
  });

  describe('sendDirect()', () => {
    it('sends immediately when WS is open regardless of state', () => {
      const client = createClient();
      client.connect();
      // State is 'connecting', WS is open (mock default)
      const mock = getLatestMock();

      const msg: AgentToOrchestratorMessage = {
        type: 'job.status',
        messageId: 'msg-direct',
        runId: 'run-1',
        jobId: 'job-1',
        state: 'failed',
        timestamp: Date.now(),
      };

      client.sendDirect(msg);

      const sent = getSentMessages(mock);
      expect(sent).toContainEqual(
        expect.objectContaining({ type: 'job.status', messageId: 'msg-direct' }),
      );
    });

    it('does nothing when WS is closed', () => {
      const client = createClient();
      // Never connected, no WS

      const msg: AgentToOrchestratorMessage = {
        type: 'job.status',
        messageId: 'msg-direct',
        runId: 'run-1',
        jobId: 'job-1',
        state: 'failed',
        timestamp: Date.now(),
      };

      // Should not throw
      client.sendDirect(msg);
    });
  });

  describe('buffer flush on registration', () => {
    it('flushes buffered messages on register.ack', () => {
      const client = createClient();

      // Buffer messages while disconnected
      client.send({
        type: 'job.status',
        messageId: 'msg-1',
        runId: 'run-1',
        jobId: 'job-1',
        state: 'running',
        timestamp: 1000,
      });
      client.send({
        type: 'log.chunk',
        messageId: 'msg-2',
        runId: 'run-1',
        jobId: 'job-1',
        stepIndex: 0,
        lines: ['output'],
        timestamp: 2000,
      });

      expect(client.getBufferedCount()).toBe(2);

      // Connect
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      // Still buffered (in registering state, waiting for register.ack)
      expect(client.getBufferedCount()).toBe(2);

      // Clear sent messages to check what arrives after register.ack
      mock.sentMessages = [];
      simulateRegisterAck(mock);

      // After register.ack, buffer is flushed
      expect(client.getBufferedCount()).toBe(0);

      const sent = getSentMessages(mock);
      // Should have: config.ack + 2 flushed messages
      expect(sent).toContainEqual(
        expect.objectContaining({ type: 'job.status', messageId: 'msg-1' }),
      );
      expect(sent).toContainEqual(
        expect.objectContaining({ type: 'log.chunk', messageId: 'msg-2' }),
      );
    });
  });

  describe('reconnection', () => {
    it('schedules reconnect on unexpected close', () => {
      const client = createClient();
      client.connect();

      const mock = getLatestMock();
      simulateOpen(mock);

      mock.readyState = 3;
      mock.emit('close', 1006, Buffer.from('abnormal'));

      expect(client.state).toBe('disconnected');

      vi.advanceTimersByTime(2000);

      expect(mockInstances.length).toBe(2);
    });

    it('does not reconnect after intentional disconnect()', () => {
      const client = createClient();
      registerClient(client);

      client.disconnect();

      expect(client.state).toBe('disconnected');

      vi.advanceTimersByTime(120_000);

      expect(mockInstances.length).toBe(1);
    });

    it('resets reconnect attempts on successful registration', () => {
      const client = createClient();

      client.connect();
      let mock = getLatestMock();
      mock.readyState = 3;
      mock.emit('close', 1006, Buffer.from('abnormal'));

      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(120_000);
        mock = getLatestMock();
        mock.readyState = 3;
        mock.emit('close', 1006, Buffer.from('abnormal'));
      }

      const attemptsBeforeRegister = mockInstances.length;

      vi.advanceTimersByTime(120_000);
      mock = getLatestMock();
      simulateOpen(mock);
      simulateRegisterAck(mock);

      // Agent is now registered (via register.ack)
      expect(client.state).toBe('registered');

      mock.readyState = 3;
      mock.emit('close', 1006, Buffer.from('abnormal'));

      // With reset, base delay ~1000-1500ms
      vi.advanceTimersByTime(2000);

      expect(mockInstances.length).toBe(attemptsBeforeRegister + 2);
    });

    it('flushes buffer on re-registration after reconnect', () => {
      const client = createClient();
      const mock1 = registerClient(client);

      // Buffer a message while registered
      mock1.sentMessages = [];
      client.send({
        type: 'job.status',
        messageId: 'msg-1',
        runId: 'run-1',
        jobId: 'job-1',
        state: 'success',
        timestamp: Date.now(),
      });
      // It was sent immediately
      expect(getSentMessages(mock1)).toHaveLength(1);

      // Disconnect unexpectedly
      mock1.readyState = 3;
      mock1.emit('close', 1006, Buffer.from('abnormal'));

      // Buffer messages while disconnected
      client.send({
        type: 'job.status',
        messageId: 'msg-2',
        runId: 'run-2',
        jobId: 'job-2',
        state: 'failed',
        timestamp: Date.now(),
      });
      expect(client.getBufferedCount()).toBe(1);

      // Reconnect
      vi.advanceTimersByTime(2000);
      const mock2 = getLatestMock();
      simulateOpen(mock2);
      simulateRegisterAck(mock2);

      // Buffer should be flushed after register.ack
      expect(client.getBufferedCount()).toBe(0);

      const sent = getSentMessages(mock2);
      // register message + config.ack + flushed message
      expect(sent).toContainEqual(expect.objectContaining({ type: 'agent.register' }));
      expect(sent).toContainEqual(
        expect.objectContaining({ type: 'job.status', messageId: 'msg-2' }),
      );
    });

    it('does not replay heartbeats sent via sendDirect while disconnected', () => {
      const client = createClient();
      const mock1 = registerClient(client);

      // Disconnect unexpectedly
      mock1.readyState = 3;
      mock1.emit('close', 1006, Buffer.from('abnormal'));

      // A heartbeat via sendDirect while the socket is down is silently dropped
      // (never buffered) — the liveness contract that lets status frames move to
      // the buffered path without co-buffering ephemeral heartbeats.
      client.sendDirect({
        type: 'agent.heartbeat',
        agentId: 'test-agent',
        timestamp: 1234,
      } as never);
      expect(client.getBufferedCount()).toBe(0);

      // Reconnect + re-register
      vi.advanceTimersByTime(2000);
      const mock2 = getLatestMock();
      simulateOpen(mock2);
      simulateRegisterAck(mock2);

      // The dropped heartbeat must NOT reappear on the new connection.
      const sent = getSentMessages(mock2);
      expect(sent).not.toContainEqual(
        expect.objectContaining({ type: 'agent.heartbeat', timestamp: 1234 }),
      );
    });
  });

  describe('exponential backoff calculation', () => {
    it('returns base delay on first attempt', () => {
      const client = createClient({ maxReconnectDelayMs: 60_000 });

      vi.spyOn(Math, 'random').mockReturnValue(0);

      const delay = client.getReconnectDelay();
      expect(delay).toBe(1000);

      vi.spyOn(Math, 'random').mockRestore();
    });

    it('caps delay at maxReconnectDelayMs', () => {
      const client = createClient({ maxReconnectDelayMs: 5000 });

      vi.spyOn(Math, 'random').mockReturnValue(0.5);

      const delay = client.getReconnectDelay();
      expect(delay).toBeLessThanOrEqual(5000);

      vi.spyOn(Math, 'random').mockRestore();
    });

    it('applies jitter to prevent thundering herd', () => {
      const client = createClient();

      const delays = new Set<number>();
      for (let i = 0; i < 10; i++) {
        vi.spyOn(Math, 'random').mockReturnValue(i * 0.05);
        delays.add(client.getReconnectDelay());
      }

      expect(delays.size).toBeGreaterThan(1);

      vi.spyOn(Math, 'random').mockRestore();
    });
  });

  describe('heartbeat', () => {
    it('sends heartbeat messages periodically when registered', () => {
      const client = createClient({ heartbeatIntervalMs: 5000 });
      const mock = registerClient(client);
      mock.sentMessages = [];

      vi.advanceTimersByTime(5000);

      const sent = getSentMessages(mock);
      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent[0]).toMatchObject({ type: 'heartbeat' });
      expect(sent[0]).toHaveProperty('timestamp');
    });

    it('stops heartbeat on disconnect', () => {
      const client = createClient({ heartbeatIntervalMs: 5000 });
      const mock = registerClient(client);
      mock.sentMessages = [];

      client.disconnect();

      vi.advanceTimersByTime(10_000);

      expect(mock.sentMessages).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('handles malformed JSON from server gracefully', () => {
      const client = createClient();
      const mock = registerClient(client);

      mock.emit('message', 'not-json{{{');

      // Should still be registered
      expect(client.state).toBe('registered');
    });

    it('handles invalid protocol messages gracefully', () => {
      const client = createClient();
      const mock = registerClient(client);

      simulateMessage(mock, { type: 'unknown.type', foo: 'bar' });

      expect(client.state).toBe('registered');
    });

    it('handles heartbeat response from orchestrator', () => {
      const client = createClient();
      const mock = registerClient(client);

      // Orchestrator can send heartbeat responses
      simulateMessage(mock, { type: 'heartbeat', timestamp: Date.now() });

      expect(client.state).toBe('registered');
    });
  });

  describe('connect guard', () => {
    it('ignores connect() when not disconnected', () => {
      const client = createClient();
      client.connect();

      expect(client.state).toBe('connecting');

      // Should not create another WS
      client.connect();
      expect(mockInstances.length).toBe(1);
    });
  });

  describe('authentication flow (with token)', () => {
    it('sends auth.request on open when token is provided', () => {
      const client = createClient({ token: 'kat_test_token_abc' });
      client.connect();

      const mock = getLatestMock();
      simulateOpen(mock);

      // Should be in authenticating state (not registering)
      expect(client.state).toBe('authenticating');

      const sent = getSentMessages(mock);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: 'auth.request',
        token: 'kat_test_token_abc',
        protocolVersion: PROTOCOL_VERSION,
      });
    });

    it('transitions: authenticating -> registering -> registered on auth.success + register.ack', () => {
      const client = createClient({ token: 'kat_test_token_abc' });
      client.connect();

      const mock = getLatestMock();
      simulateOpen(mock);
      expect(client.state).toBe('authenticating');

      // Orchestrator responds with auth.success
      simulateMessage(mock, {
        type: 'auth.success',
        connectionId: 'conn-123',
      });
      expect(client.state).toBe('registering');

      // Should have sent agent.register after auth.success
      const sent = getSentMessages(mock);
      const registerMsg = sent.find(
        (m) => (m as Record<string, unknown>).type === 'agent.register',
      ) as Record<string, unknown> | undefined;
      expect(registerMsg).toBeDefined();
      expect(registerMsg!.type).toBe('agent.register');
      expect(registerMsg!.agentId).toBe('agent-test-1');
      // Labels include user-specified labels plus auto-derived os/arch/host labels
      expect(registerMsg!.labels).toEqual(expect.arrayContaining(['linux', 'docker']));

      // Orchestrator sends register.ack
      simulateRegisterAck(mock);
      expect(client.state).toBe('registered');
    });

    it('auth.failure stops reconnecting permanently', () => {
      const client = createClient({ token: 'kat_bad_token' });
      client.connect();

      const mock = getLatestMock();
      simulateOpen(mock);
      expect(client.state).toBe('authenticating');

      // Orchestrator rejects the token
      simulateMessage(mock, {
        type: 'auth.failure',
        reason: 'Invalid or expired token',
      });

      expect(client.state).toBe('disconnected');

      // Wait a very long time -- should NOT reconnect
      vi.advanceTimersByTime(300_000);

      // Only 1 mock instance created (the initial one) -- no reconnection
      expect(mockInstances.length).toBe(1);
    });

    // defense in depth: the close-code branch must stop the
    // reconnect loop even when the preceding auth.failure message is
    // dropped / arrives garbled. Without this, a revoked token's WS
    // close (code 4010) would leave intentionalDisconnect=false and
    // the agent would reconnect-storm.
    it('close code 4010 (WS_CLOSE_AGENT_AUTH_FAILED) stops reconnecting permanently', () => {
      const client = createClient({ token: 'kat_revoked_token' });
      client.connect();

      const mock = getLatestMock();
      simulateOpen(mock);
      simulateMessage(mock, { type: 'auth.success', connectionId: 'conn-1' });
      simulateRegisterAck(mock);
      expect(client.state).toBe('registered');

      // Orchestrator revokes the token mid-connection. Simulate the
      // kick: the auth.failure message is *not* delivered (it
      // could be lost on a saturated socket) -- only the WS close with
      // code 4010 reaches the agent.
      mock.emit('close', 4010, Buffer.from('Token revoked'));

      expect(client.state).toBe('disconnected');

      // Wait a very long time -- the agent must NOT reconnect.
      vi.advanceTimersByTime(300_000);

      // Only 1 mock instance ever created.
      expect(mockInstances.length).toBe(1);
    });

    it('does not send agent.register on open when token is provided', () => {
      const client = createClient({ token: 'kat_test_token_abc' });
      client.connect();

      const mock = getLatestMock();
      simulateOpen(mock);

      // Should only have auth.request, not agent.register
      const sent = getSentMessages(mock);
      expect(sent).toHaveLength(1);
      expect((sent[0] as Record<string, unknown>).type).toBe('auth.request');
    });

    it('buffers messages during authenticating state', () => {
      const client = createClient({ token: 'kat_test_token' });
      client.connect();

      const mock = getLatestMock();
      simulateOpen(mock);
      expect(client.state).toBe('authenticating');

      // Buffer a message
      client.send({
        type: 'job.status',
        messageId: 'msg-buffered',
        runId: 'run-1',
        jobId: 'job-1',
        state: 'running',
        timestamp: Date.now(),
      });

      expect(client.getBufferedCount()).toBe(1);

      // Complete auth and registration
      simulateMessage(mock, { type: 'auth.success', connectionId: 'conn-1' });
      simulateRegisterAck(mock);

      // Buffer should be flushed
      expect(client.getBufferedCount()).toBe(0);
    });

    it('skips auth and sends agent.register directly when no token', () => {
      const client = createClient(); // No token
      client.connect();

      const mock = getLatestMock();
      simulateOpen(mock);

      // Should go directly to registering (not authenticating)
      expect(client.state).toBe('registering');

      const sent = getSentMessages(mock);
      expect(sent).toHaveLength(1);
      expect((sent[0] as Record<string, unknown>).type).toBe('agent.register');
    });
  });

  describe('register.ack handshake', () => {
    it('sends config.ack after receiving register.ack', () => {
      const client = createClient({ agentId: 'agent-ack-test' });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      // Clear sent messages (agent.register was sent)
      mock.sentMessages = [];

      simulateRegisterAck(mock, { agentId: 'agent-ack-test' });

      const sent = getSentMessages(mock);
      const configAck = sent.find((m) => (m as Record<string, unknown>).type === 'config.ack') as
        Record<string, unknown> | undefined;

      expect(configAck).toBeDefined();
      expect(configAck!.agentId).toBe('agent-ack-test');
      expect(configAck!.messageId).toBeDefined();
    });

    it('stays in registering state until register.ack arrives', () => {
      const client = createClient();
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      expect(client.state).toBe('registering');

      // Without register.ack, state stays registering
      vi.advanceTimersByTime(10_000);
      expect(client.state).toBe('registering');

      // register.ack transitions to registered
      simulateRegisterAck(mock);
      expect(client.state).toBe('registered');
    });

    it('buffers messages while in registering state', () => {
      const client = createClient();
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      // State is 'registering' -- messages should be buffered
      const msg: AgentToOrchestratorMessage = {
        type: 'job.status',
        messageId: 'msg-buffered',
        runId: 'run-1',
        jobId: 'job-1',
        state: 'running',
        timestamp: Date.now(),
      };

      client.send(msg);
      expect(client.getBufferedCount()).toBe(1);

      // After register.ack, buffer is flushed
      simulateRegisterAck(mock);
      expect(client.getBufferedCount()).toBe(0);
    });
  });

  describe('in-flight job reporting', () => {
    it('includes inFlightJobs in agent.register when getInFlightJobs returns active jobs', () => {
      const client = createClient({
        getInFlightJobs: () => [
          { jobId: 'j1', runId: 'r1' },
          { jobId: 'j2', runId: 'r2' },
        ],
      });
      client.connect();

      const mock = getLatestMock();
      simulateOpen(mock);

      const sent = getSentMessages(mock);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: 'agent.register',
        agentId: 'agent-test-1',
        inFlightJobs: [
          { jobId: 'j1', runId: 'r1' },
          { jobId: 'j2', runId: 'r2' },
        ],
      });
    });

    it('omits inFlightJobs from agent.register when getInFlightJobs returns empty array', () => {
      const client = createClient({
        getInFlightJobs: () => [],
      });
      client.connect();

      const mock = getLatestMock();
      simulateOpen(mock);

      const sent = getSentMessages(mock);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: 'agent.register',
        agentId: 'agent-test-1',
      });
      // inFlightJobs should NOT be present
      expect((sent[0] as Record<string, unknown>).inFlightJobs).toBeUndefined();
    });

    it('omits inFlightJobs when getInFlightJobs callback is not provided', () => {
      const client = createClient(); // No getInFlightJobs
      client.connect();

      const mock = getLatestMock();
      simulateOpen(mock);

      const sent = getSentMessages(mock);
      expect(sent).toHaveLength(1);
      expect((sent[0] as Record<string, unknown>).inFlightJobs).toBeUndefined();
    });

    it('reports in-flight jobs on reconnect after disconnect', () => {
      let activeJobs: Array<{ jobId: string; runId: string }> = [];
      const client = createClient({
        getInFlightJobs: () => activeJobs,
      });

      // Initial connect (no in-flight jobs)
      const mock1 = registerClient(client);

      // Simulate a job starting
      activeJobs = [{ jobId: 'j1', runId: 'r1' }];

      // Disconnect unexpectedly
      mock1.readyState = 3;
      mock1.emit('close', 1006, Buffer.from('abnormal'));

      // Reconnect
      vi.advanceTimersByTime(2000);
      const mock2 = getLatestMock();
      simulateOpen(mock2);

      // The register message on reconnect should include in-flight jobs
      const sent = getSentMessages(mock2);
      const registerMsg = sent.find(
        (m) => (m as Record<string, unknown>).type === 'agent.register',
      );
      expect(registerMsg).toBeDefined();
      expect(registerMsg).toMatchObject({
        type: 'agent.register',
        inFlightJobs: [{ jobId: 'j1', runId: 'r1' }],
      });
    });
  });

  describe('gap marker on reconnection', () => {
    it('sends gap marker before replaying buffered events on reconnect', () => {
      const client = createClient();
      const mock1 = registerClient(client);

      // Disconnect unexpectedly
      mock1.readyState = 3;
      mock1.emit('close', 1006, Buffer.from('abnormal'));

      // Buffer an event while disconnected
      client.send({
        type: 'job.status',
        messageId: 'msg-buffered',
        runId: 'run-1',
        jobId: 'job-1',
        state: 'running',
        timestamp: Date.now(),
      });

      // Advance time to simulate outage duration
      vi.advanceTimersByTime(5000);

      // Reconnect
      const mock2 = getLatestMock();
      simulateOpen(mock2);

      // Clear sent messages before register.ack to isolate post-ack messages
      const preAckSent = [...mock2.sentMessages];
      mock2.sentMessages = [];
      simulateRegisterAck(mock2);

      const sent = getSentMessages(mock2);

      // Find the gap marker (agent.log message with gap marker text)
      const gapMarkerMsg = sent.find((m) => {
        const msg = m as Record<string, unknown>;
        if (msg.type !== 'agent.log') return false;
        const lines = msg.lines as string[];
        return lines.some((l: string) => l.includes('Orchestrator offline for'));
      });

      expect(gapMarkerMsg).toBeDefined();
      const gapLines = (gapMarkerMsg as Record<string, unknown>).lines as string[];
      expect(gapLines[0]).toContain('Orchestrator offline for');
      expect(gapLines[0]).toContain('1 buffered events');
      expect(gapLines[0]).toContain('0 buffered log lines');

      // Verify buffered event was also flushed
      expect(sent).toContainEqual(
        expect.objectContaining({ type: 'job.status', messageId: 'msg-buffered' }),
      );

      // Gap marker should appear BEFORE the buffered event
      const gapIdx = sent.findIndex((m) => {
        const msg = m as Record<string, unknown>;
        return (
          msg.type === 'agent.log' &&
          ((msg.lines as string[]) ?? []).some((l: string) => l.includes('Orchestrator offline'))
        );
      });
      const eventIdx = sent.findIndex((m) => (m as Record<string, unknown>).type === 'job.status');
      expect(gapIdx).toBeLessThan(eventIdx);
    });

    it('sends gap marker with log line counts when log buffer has content', () => {
      const client = createClient();
      const mock1 = registerClient(client);

      // Disconnect unexpectedly
      mock1.readyState = 3;
      mock1.emit('close', 1006, Buffer.from('abnormal'));

      // Buffer log lines while disconnected
      client.streamLog('log line 1');
      client.streamLog('log line 2');
      client.streamLog('log line 3');

      // Advance time
      vi.advanceTimersByTime(3000);

      // Reconnect
      const mock2 = getLatestMock();
      simulateOpen(mock2);
      mock2.sentMessages = [];
      simulateRegisterAck(mock2);

      const sent = getSentMessages(mock2);

      // Find the gap marker
      const gapMarkerMsg = sent.find((m) => {
        const msg = m as Record<string, unknown>;
        if (msg.type !== 'agent.log') return false;
        const lines = msg.lines as string[];
        return lines.some((l: string) => l.includes('Orchestrator offline for'));
      });

      expect(gapMarkerMsg).toBeDefined();
      const gapLines = (gapMarkerMsg as Record<string, unknown>).lines as string[];
      expect(gapLines[0]).toContain('3 buffered log lines');
    });

    it('includes dropped event/log counts in gap marker when buffer overflows', () => {
      // Use very small buffers to trigger overflow
      const client = createClient({
        maxBufferSize: 2,
        maxLogBufferLines: 2,
      });
      const mock1 = registerClient(client);

      // Disconnect unexpectedly
      mock1.readyState = 3;
      mock1.emit('close', 1006, Buffer.from('abnormal'));

      // Buffer more events than buffer can hold (overflow)
      for (let i = 0; i < 5; i++) {
        client.send({
          type: 'job.status',
          messageId: `msg-${i}`,
          runId: `run-${i}`,
          jobId: `job-${i}`,
          state: 'running',
          timestamp: Date.now(),
        });
      }

      // Buffer more log lines than buffer can hold (overflow)
      for (let i = 0; i < 5; i++) {
        client.streamLog(`overflow log line ${i}`);
      }

      // Reconnect
      vi.advanceTimersByTime(2000);
      const mock2 = getLatestMock();
      simulateOpen(mock2);
      mock2.sentMessages = [];
      simulateRegisterAck(mock2);

      const sent = getSentMessages(mock2);

      // Find the gap marker
      const gapMarkerMsg = sent.find((m) => {
        const msg = m as Record<string, unknown>;
        if (msg.type !== 'agent.log') return false;
        const lines = msg.lines as string[];
        return lines.some((l: string) => l.includes('Orchestrator offline for'));
      });

      expect(gapMarkerMsg).toBeDefined();
      const gapLines = (gapMarkerMsg as Record<string, unknown>).lines as string[];
      // 5 events added to buffer of size 2 -> 3 dropped
      expect(gapLines[0]).toContain('3 events dropped due to buffer overflow');
      // 5 log lines added to buffer of size 2 -> 3 dropped
      expect(gapLines[0]).toContain('3 log lines dropped due to buffer overflow');
    });

    it('resets dropped counts after gap marker is sent', () => {
      const client = createClient({
        maxBufferSize: 2,
        maxLogBufferLines: 2,
      });
      const mock1 = registerClient(client);

      // Disconnect
      mock1.readyState = 3;
      mock1.emit('close', 1006, Buffer.from('abnormal'));

      // Overflow buffers
      for (let i = 0; i < 5; i++) {
        client.send({
          type: 'job.status',
          messageId: `msg-${i}`,
          runId: `run-${i}`,
          jobId: `job-${i}`,
          state: 'running',
          timestamp: Date.now(),
        });
      }

      // Reconnect (triggers flush with gap marker)
      vi.advanceTimersByTime(2000);
      const mock2 = getLatestMock();
      simulateOpen(mock2);
      simulateRegisterAck(mock2);

      // Disconnect again
      mock2.readyState = 3;
      mock2.emit('close', 1006, Buffer.from('abnormal'));

      // Buffer one event (no overflow this time)
      client.send({
        type: 'job.status',
        messageId: 'msg-after-reset',
        runId: 'run-after',
        jobId: 'job-after',
        state: 'running',
        timestamp: Date.now(),
      });

      // Reconnect again
      vi.advanceTimersByTime(2000);
      const mock3 = getLatestMock();
      simulateOpen(mock3);
      mock3.sentMessages = [];
      simulateRegisterAck(mock3);

      const sent = getSentMessages(mock3);

      // Find the gap marker for this second reconnection
      const gapMarkerMsg = sent.find((m) => {
        const msg = m as Record<string, unknown>;
        if (msg.type !== 'agent.log') return false;
        const lines = msg.lines as string[];
        return lines.some((l: string) => l.includes('Orchestrator offline for'));
      });

      expect(gapMarkerMsg).toBeDefined();
      const gapLines = (gapMarkerMsg as Record<string, unknown>).lines as string[];
      // Should NOT mention dropped items (counts were reset)
      expect(gapLines[0]).not.toContain('dropped due to buffer overflow');
    });

    it('does not send gap marker when no items are buffered or dropped', () => {
      const client = createClient();
      const mock1 = registerClient(client);

      // Disconnect and immediately reconnect (no buffered items)
      mock1.readyState = 3;
      mock1.emit('close', 1006, Buffer.from('abnormal'));

      vi.advanceTimersByTime(2000);
      const mock2 = getLatestMock();
      simulateOpen(mock2);
      mock2.sentMessages = [];
      simulateRegisterAck(mock2);

      const sent = getSentMessages(mock2);

      // No gap marker should be sent
      const gapMarkerMsg = sent.find((m) => {
        const msg = m as Record<string, unknown>;
        if (msg.type !== 'agent.log') return false;
        const lines = msg.lines as string[];
        return lines.some((l: string) => l.includes('Orchestrator offline for'));
      });

      expect(gapMarkerMsg).toBeUndefined();
    });

    it('drains pending log batch into LogBuffer on close', () => {
      const client = createClient();
      const mock1 = registerClient(client);

      // Stream a log line (stays in pending batch, not sent yet due to 100ms timer)
      client.streamLog('pending line 1');
      client.streamLog('pending line 2');

      // Disconnect before log batch timer fires
      mock1.readyState = 3;
      mock1.emit('close', 1006, Buffer.from('abnormal'));

      // Reconnect
      vi.advanceTimersByTime(2000);
      const mock2 = getLatestMock();
      simulateOpen(mock2);
      mock2.sentMessages = [];
      simulateRegisterAck(mock2);

      const sent = getSentMessages(mock2);

      // Gap marker should mention 2 buffered log lines (drained from pending batch)
      const gapMarkerMsg = sent.find((m) => {
        const msg = m as Record<string, unknown>;
        if (msg.type !== 'agent.log') return false;
        const lines = msg.lines as string[];
        return lines.some((l: string) => l.includes('Orchestrator offline for'));
      });

      expect(gapMarkerMsg).toBeDefined();
      const gapLines = (gapMarkerMsg as Record<string, unknown>).lines as string[];
      expect(gapLines[0]).toContain('2 buffered log lines');

      // The actual log lines should also be replayed
      const logReplayMsg = sent.find((m) => {
        const msg = m as Record<string, unknown>;
        if (msg.type !== 'agent.log') return false;
        const lines = msg.lines as string[];
        return lines.includes('pending line 1');
      });
      expect(logReplayMsg).toBeDefined();
    });

    it('moves pending log batch to LogBuffer when ws closes before timer fires', () => {
      const client = createClient();
      const mock1 = registerClient(client);

      // Stream log lines (pending in batch, timer not fired yet)
      client.streamLog('batch line 1');
      client.streamLog('batch line 2');

      // Simulate ws transitioning to CLOSING state before timer fires:
      // Set readyState to CLOSED but do NOT emit 'close' yet, then fire the timer.
      mock1.readyState = 3; // CLOSED

      // Advance time to fire the log flush timer (100ms)
      // The sendLogBatch() should detect ws is not open and fall back to logBuffer
      vi.advanceTimersByTime(100);

      // Now emit the close event (which would normally drain pending batch,
      // but the timer already ran — the fix ensures lines went to logBuffer)
      mock1.emit('close', 1006, Buffer.from('abnormal'));

      // Reconnect
      vi.advanceTimersByTime(2000);
      const mock2 = getLatestMock();
      simulateOpen(mock2);
      mock2.sentMessages = [];
      simulateRegisterAck(mock2);

      const sent = getSentMessages(mock2);

      // The 2 log lines should be replayed via LogBuffer
      const logReplayMsg = sent.find((m) => {
        const msg = m as Record<string, unknown>;
        if (msg.type !== 'agent.log') return false;
        const lines = msg.lines as string[];
        return lines.includes('batch line 1');
      });
      expect(logReplayMsg).toBeDefined();
      const replayLines = (logReplayMsg as Record<string, unknown>).lines as string[];
      expect(replayLines).toContain('batch line 1');
      expect(replayLines).toContain('batch line 2');
    });
  });

  // ── `permessage-deflate` compression bomb defense (security invariant) ──
  //
  // Every WS endpoint that negotiates `permessage-deflate` MUST cap the maximum
  // decompressed message size via `maxPayload`. Client-side too: a rogue or
  // compromised orchestrator could send the agent a single compressed frame
  // that decompresses to ~100 MiB (ws@8.x default `maxPayload`) and OOM the
  // agent process. Single-tenant impact (the agent is a per-tenant data-plane
  // worker), but with auto-scaler thrash and dispatcher retries it can amplify
  // into queue starvation.
  //
  // Asserts the EXACT configured value (positive control) so any regression
  // that changes `maxPayload` is loud.
  describe('compression bomb defense (security invariant)', () => {
    it('caps maxPayload on the WebSocket constructor (= WS_MAX_PAYLOAD_BYTES)', () => {
      const client = createClient({ url: 'ws://orchestrator.example.com/ws/agent' });
      client.connect();

      const args = mockConstructorArgs[mockConstructorArgs.length - 1];
      expect(args).toBeDefined();
      const options = args![1] as Record<string, unknown> | undefined;
      expect(options).toBeDefined();

      expect(options!['maxPayload']).toBe(WS_MAX_PAYLOAD_BYTES);
    });
  });

  describe('user-facing cache relay (requestUserCache)', () => {
    it('restore op sends cache.user.restore.request and resolves on response', async () => {
      const client = createClient();
      const mock = registerClient(client);

      const promise = client.requestUserCache('job-1', {
        type: 'cache.request',
        requestId: 'ipc-1',
        op: 'restore',
        key: 'deps-v1',
        restoreKeys: ['deps-'],
      });

      const sent = getSentMessages(mock).find(
        (m) => (m as { type?: string }).type === 'cache.user.restore.request',
      ) as { messageId: string; jobId: string; key: string; restoreKeys: string[] };
      expect(sent).toMatchObject({ jobId: 'job-1', key: 'deps-v1', restoreKeys: ['deps-'] });

      simulateMessage(mock, {
        type: 'cache.user.restore.response',
        requestId: sent.messageId,
        hit: true,
        matchedKey: 'deps-v1',
        downloadUrl: 'https://s3/get',
        tarHash: 'deadbeef',
      });

      const response = await promise;
      expect(response).toEqual({
        type: 'cache.response',
        requestId: 'ipc-1',
        hit: true,
        matchedKey: 'deps-v1',
        downloadUrl: 'https://s3/get',
        tarHash: 'deadbeef',
      });
    });

    it('beginSave op sends cache.user.save.request and maps skip + uploadUrl', async () => {
      const client = createClient();
      const mock = registerClient(client);

      const promise = client.requestUserCache('job-1', {
        type: 'cache.request',
        requestId: 'ipc-2',
        op: 'beginSave',
        key: 'deps-v1',
      });

      const sent = getSentMessages(mock).find(
        (m) => (m as { type?: string }).type === 'cache.user.save.request',
      ) as { messageId: string; jobId: string; key: string };
      expect(sent).toMatchObject({ jobId: 'job-1', key: 'deps-v1' });

      simulateMessage(mock, {
        type: 'cache.user.save.response',
        requestId: sent.messageId,
        skip: false,
        uploadUrl: 'https://s3/put',
      });

      const response = await promise;
      expect(response).toEqual({
        type: 'cache.response',
        requestId: 'ipc-2',
        skip: false,
        uploadUrl: 'https://s3/put',
      });
    });

    it('completeSave op sends cache.user.save.complete fire-and-forget', async () => {
      const client = createClient();
      const mock = registerClient(client);

      const response = await client.requestUserCache('job-1', {
        type: 'cache.request',
        requestId: 'ipc-3',
        op: 'completeSave',
        key: 'deps-v1',
        tarHash: 'deadbeef',
        sizeBytes: 4096,
      });

      const sent = getSentMessages(mock).find(
        (m) => (m as { type?: string }).type === 'cache.user.save.complete',
      ) as { jobId: string; key: string; tarHash: string; sizeBytes: number };
      expect(sent).toMatchObject({
        jobId: 'job-1',
        key: 'deps-v1',
        tarHash: 'deadbeef',
        sizeBytes: 4096,
      });
      expect(response).toEqual({ type: 'cache.response', requestId: 'ipc-3' });
    });
  });

  describe('scaler credential claim (sendClaimCredentials)', () => {
    it('sends scaler.claim-credentials and resolves with the minted credentials', async () => {
      const client = createClient();
      const mock = registerClient(client);

      const promise = client.sendClaimCredentials('code-abc');

      const sent = getSentMessages(mock).find(
        (m) => (m as { type?: string }).type === 'scaler.claim-credentials',
      ) as { requestId: string; claimCode: string };
      expect(sent).toMatchObject({ claimCode: 'code-abc' });

      const credentials = {
        agentToken: 'kat_secret',
        agentId: 'a1',
        orchestratorUrl: 'wss://h/ws',
        labels: ['cloud=hetzner'],
      };
      simulateMessage(mock, {
        type: 'scaler.claim-credentials.response',
        requestId: sent.requestId,
        credentials,
      });

      await expect(promise).resolves.toEqual({ credentials, error: undefined });
    });

    it('resolves with an error field when the claim is rejected', async () => {
      const client = createClient();
      const mock = registerClient(client);

      const promise = client.sendClaimCredentials('bad-code');
      const sent = getSentMessages(mock).find(
        (m) => (m as { type?: string }).type === 'scaler.claim-credentials',
      ) as { requestId: string };

      simulateMessage(mock, {
        type: 'scaler.claim-credentials.response',
        requestId: sent.requestId,
        error: 'invalid claim code',
      });

      await expect(promise).resolves.toMatchObject({ error: 'invalid claim code' });
    });
  });

  describe('self-bootstrap claim exchange (scalerClaimCode) on open', () => {
    /** Flush pending microtasks (the awaited claim exchange continuation). */
    async function flush(times = 5): Promise<void> {
      for (let i = 0; i < times; i++) await Promise.resolve();
    }

    it('self-claims before registering, then registers with the minted identity', async () => {
      const client = createClient({
        scalerClaimCode: 'claim-abc',
        agentId: 'boot-tmp',
        labels: ['linux'],
      });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      // The claim frame goes out first — before any auth.request / agent.register.
      const claim = getSentMessages(mock).find(
        (m) => (m as { type?: string }).type === 'scaler.claim-credentials',
      ) as { requestId: string; claimCode: string };
      expect(claim).toMatchObject({ claimCode: 'claim-abc' });
      expect(
        getSentMessages(mock).some((m) =>
          ['auth.request', 'agent.register'].includes((m as { type?: string }).type ?? ''),
        ),
      ).toBe(false);

      // Orchestrator mints ephemeral credentials.
      const credentials = {
        agentToken: 'kat_minted',
        agentId: 'minted-agent',
        orchestratorUrl: 'wss://h/ws',
        labels: ['cloud=hetzner'],
      };
      simulateMessage(mock, {
        type: 'scaler.claim-credentials.response',
        requestId: claim.requestId,
        credentials,
      });
      await flush();

      // Now the client authenticates with the minted token.
      const auth = getSentMessages(mock).find(
        (m) => (m as { type?: string }).type === 'auth.request',
      ) as { token: string } | undefined;
      expect(auth).toMatchObject({ token: 'kat_minted' });
      expect(client.state).toBe('authenticating');

      // Complete the handshake: register uses the minted agentId + merged labels.
      simulateMessage(mock, { type: 'auth.success', connectionId: 'conn-boot' });
      await flush();
      const register = getSentMessages(mock).find(
        (m) => (m as { type?: string }).type === 'agent.register',
      ) as { agentId: string; labels: string[] } | undefined;
      expect(register).toBeDefined();
      expect(register!.agentId).toBe('minted-agent');
      expect(register!.labels).toEqual(expect.arrayContaining(['linux', 'cloud=hetzner']));
    });

    it('fails fast on a rejected claim code: no register, no reconnect, terminates the process', async () => {
      const client = createClient({ scalerClaimCode: 'expired-code', labels: ['linux'] });
      // server.ts wires this to a non-zero graceful shutdown; a one-shot agent
      // must terminate rather than let the health server hold it open.
      const onClaimFailedPermanently = vi.fn();
      client.onClaimFailedPermanently = onClaimFailedPermanently;
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      const claim = getSentMessages(mock).find(
        (m) => (m as { type?: string }).type === 'scaler.claim-credentials',
      ) as { requestId: string };

      simulateMessage(mock, {
        type: 'scaler.claim-credentials.response',
        requestId: claim.requestId,
        error: 'claim code expired',
      });
      await flush();

      // The handshake never proceeds.
      expect(
        getSentMessages(mock).some((m) =>
          ['auth.request', 'agent.register'].includes((m as { type?: string }).type ?? ''),
        ),
      ).toBe(false);
      expect(client.state).toBe('disconnected');
      expect(mock.closeCode).toBe(1000);

      // The permanent-failure callback fires exactly once with the reason, so
      // server.ts can exit the process non-zero.
      expect(onClaimFailedPermanently).toHaveBeenCalledTimes(1);
      expect(onClaimFailedPermanently).toHaveBeenCalledWith('claim code expired');

      // And the client does not reconnect-storm against a dead claim code.
      vi.advanceTimersByTime(300_000);
      expect(mockInstances.length).toBe(1);
    });

    it('fails permanently when the claim exchange itself errors (times out)', async () => {
      const client = createClient({ scalerClaimCode: 'lost-code', labels: ['linux'] });
      const onClaimFailedPermanently = vi.fn();
      client.onClaimFailedPermanently = onClaimFailedPermanently;
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      // No response ever arrives — the 15s claim RPC timeout rejects the exchange.
      vi.advanceTimersByTime(15_000);
      await flush();

      expect(
        getSentMessages(mock).some((m) =>
          ['auth.request', 'agent.register'].includes((m as { type?: string }).type ?? ''),
        ),
      ).toBe(false);
      expect(client.state).toBe('disconnected');
      expect(onClaimFailedPermanently).toHaveBeenCalledTimes(1);
      expect(onClaimFailedPermanently.mock.calls[0]![0]).toMatch(/claim exchange failed/);
    });

    it('ignores scalerClaimCode when a static token is present (no claim frame)', () => {
      const client = createClient({ scalerClaimCode: 'claim-abc', token: 'kat_static' });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      // A static token wins: the client authenticates directly, no claim exchange.
      expect(
        getSentMessages(mock).some(
          (m) => (m as { type?: string }).type === 'scaler.claim-credentials',
        ),
      ).toBe(false);
      expect(client.state).toBe('authenticating');
      const auth = getSentMessages(mock).find(
        (m) => (m as { type?: string }).type === 'auth.request',
      ) as { token: string } | undefined;
      expect(auth).toMatchObject({ token: 'kat_static' });
    });
  });

  describe('user-facing artifact relay (requestUserArtifact completeUpload)', () => {
    const ACK_CAPS = { artifactCompleteAck: true };

    /** The IPC completeUpload request the sandbox relays. */
    function completeRequest(requestId: string) {
      return {
        type: 'artifacts.request' as const,
        requestId,
        op: 'completeUpload' as const,
        name: 'bundle',
        sizeBytes: 4096,
        sha256: 'deadbeef',
        storageKey: 'artifacts/run-1/bundle.tar.gz',
      };
    }

    /** The `artifacts.upload.complete` frame the client sent. */
    function sentComplete(mock: MockWsInstance): { messageId: string } {
      return getSentMessages(mock).find(
        (m) => (m as { type?: string }).type === 'artifacts.upload.complete',
      ) as { messageId: string };
    }

    it('awaits the ack and resolves on committed', async () => {
      const client = createClient();
      const mock = registerClient(client, { capabilities: ACK_CAPS });

      const promise = client.requestUserArtifact('job-1', completeRequest('ipc-1'));
      const sent = sentComplete(mock);
      expect(sent).toMatchObject({ name: 'bundle', sha256: 'deadbeef' });

      simulateMessage(mock, {
        type: 'artifacts.upload.complete.ack',
        requestId: sent.messageId,
        outcome: 'committed',
      });

      await expect(promise).resolves.toEqual({
        type: 'artifacts.response',
        requestId: 'ipc-1',
      });
    });

    it('rejects on a failed ack so the workflow step fails', async () => {
      const client = createClient();
      const mock = registerClient(client, { capabilities: ACK_CAPS });

      const promise = client.requestUserArtifact('job-1', completeRequest('ipc-2'));
      const sent = sentComplete(mock);

      // Any reason relays verbatim: the agent is content-agnostic here, and the
      // orchestrator only ever sends a fixed, classified string (never raw
      // exception text), so this placeholder stands in for whichever literal it
      // picked. Deliberately NOT a copy of one of the orchestrator's literals —
      // they live in an orchestrator-internal module this package cannot import,
      // so a verbatim copy here would be a silent-drift duplicate.
      const reason = 'a fixed classified commit-failure reason';
      simulateMessage(mock, {
        type: 'artifacts.upload.complete.ack',
        requestId: sent.messageId,
        outcome: 'failed',
        reason,
      });

      await expect(promise).rejects.toThrow(reason);
    });

    it('rejects when the ack never arrives, before the sandbox request timeout', async () => {
      const client = createClient();
      const mock = registerClient(client, { capabilities: ACK_CAPS });

      // Capture the rejection before advancing the clock: the timer fires
      // inside advanceTimersByTimeAsync, so a handler attached afterwards
      // would surface as an unhandled rejection first.
      const settled = client
        .requestUserArtifact('job-1', completeRequest('ipc-3'))
        .then(() => null)
        .catch((err: Error) => err);
      expect(sentComplete(mock)).toBeDefined();

      // Strictly inside the sandbox's own 30s artifact-request timeout, so the
      // specific ack reason is what reaches the failing step.
      await vi.advanceTimersByTimeAsync(29_000);

      expect(await settled).toMatchObject({
        message: expect.stringContaining('upload-complete ack timed out'),
      });
    });

    it('stays fire-and-forget when the orchestrator does not advertise the capability', async () => {
      const client = createClient();
      const mock = registerClient(client);

      // Resolves with no ack at all — the pre-capability orchestrator behavior.
      await expect(client.requestUserArtifact('job-1', completeRequest('ipc-4'))).resolves.toEqual({
        type: 'artifacts.response',
        requestId: 'ipc-4',
      });
      expect(sentComplete(mock)).toBeDefined();
    });

    /**
     * Drop the socket unintentionally, let the backoff fire, and re-register.
     * Returns the mock for the new connection.
     */
    function reconnect(
      mock: MockWsInstance,
      /** `null` models an orchestrator that no longer advertises the capability. */
      capabilities: Record<string, unknown> | null = ACK_CAPS,
    ): MockWsInstance {
      mock.readyState = 3;
      mock.emit('close', 1006, Buffer.from('abnormal'));
      vi.advanceTimersByTime(2_000);
      const next = getLatestMock();
      simulateOpen(next);
      simulateRegisterAck(next, capabilities ? { capabilities } : {});
      return next;
    }

    it('holds an in-flight complete across an unintentional disconnect', async () => {
      // The commit is idempotent, so a dropped ack means "we did not hear the
      // answer" — failing here would fail a step whose artifact exists.
      const client = createClient();
      const mock = registerClient(client, { capabilities: ACK_CAPS });

      const settled = vi.fn();
      void client.requestUserArtifact('job-1', completeRequest('ipc-hold')).then(settled, settled);
      expect(sentComplete(mock)).toBeDefined();

      mock.readyState = 3;
      mock.emit('close', 1006, Buffer.from('abnormal'));
      await vi.advanceTimersByTimeAsync(0);

      expect(settled).not.toHaveBeenCalled();
    });

    it('still rejects an in-flight beginUpload on disconnect', async () => {
      // beginUpload mints a presigned PUT and is deliberately NOT resendable.
      const client = createClient();
      const mock = registerClient(client, { capabilities: ACK_CAPS });

      const promise = client.requestUserArtifact('job-1', {
        type: 'artifacts.request' as const,
        requestId: 'ipc-begin',
        op: 'beginUpload' as const,
        name: 'bundle',
        declaredSizeBytes: 4096,
      });

      mock.readyState = 3;
      mock.emit('close', 1006, Buffer.from('abnormal'));

      await expect(promise).rejects.toThrow('WebSocket disconnected');
    });

    it('rejects a held complete when the disconnect was intentional', async () => {
      // No reconnect is scheduled on a deliberate shutdown, so holding would
      // strand the step until the ack timer fired.
      const client = createClient();
      const mock = registerClient(client, { capabilities: ACK_CAPS });

      const settled = client
        .requestUserArtifact('job-1', completeRequest('ipc-intent'))
        .then(() => null)
        .catch((err: Error) => err);
      expect(sentComplete(mock)).toBeDefined();

      client.disconnect();
      // The mock defers its close event to setImmediate, which is faked here.
      await vi.advanceTimersByTimeAsync(0);

      expect(await settled).toMatchObject({ message: 'WebSocket disconnected' });
    });

    it('rejects a complete parked by an earlier drop once the agent shuts down', async () => {
      // The park is only a bet on a reconnect that is coming. A deliberate
      // shutdown after the park cancels it, so the step must fail closed then
      // rather than wait out the ack deadline (or die unsettled with the
      // process).
      const client = createClient();
      const mock = registerClient(client, { capabilities: ACK_CAPS });

      const settled = client
        .requestUserArtifact('job-1', completeRequest('ipc-park-shutdown'))
        .then(() => null)
        .catch((err: Error) => err);
      expect(sentComplete(mock)).toBeDefined();

      mock.readyState = 3;
      mock.emit('close', 1006, Buffer.from('abnormal'));
      await vi.advanceTimersByTimeAsync(0);

      client.disconnect();

      // Asserted without draining the mock's deferred close event on purpose:
      // the rejection has to come from `disconnect()` itself. A real socket that
      // is already CLOSED emits no second close, so a fix that only lived in the
      // close handler would strand this step.
      expect(await settled).toMatchObject({
        message: expect.stringContaining('may have been committed'),
      });
    });

    it('rejects a parked complete when the token is rejected and no reconnect is coming', async () => {
      // A permanent auth failure never reaches another register.ack, so the
      // parked complete would otherwise sit until its deadline.
      const client = createClient();
      const mock = registerClient(client, { capabilities: ACK_CAPS });

      const settled = client
        .requestUserArtifact('job-1', completeRequest('ipc-park-auth'))
        .then(() => null)
        .catch((err: Error) => err);
      expect(sentComplete(mock)).toBeDefined();

      mock.readyState = 3;
      mock.emit('close', 1006, Buffer.from('abnormal'));
      await vi.advanceTimersByTimeAsync(0);

      vi.advanceTimersByTime(2_000);
      const next = getLatestMock();
      simulateOpen(next);
      simulateMessage(next, { type: 'auth.failure', reason: 'token revoked' });
      await vi.advanceTimersByTimeAsync(0);

      expect(await settled).toMatchObject({
        message: expect.stringContaining('may have been committed'),
      });
    });

    it('re-sends a held complete after re-registering and resolves on the ack', async () => {
      const client = createClient();
      const mock = registerClient(client, { capabilities: ACK_CAPS });

      const promise = client.requestUserArtifact('job-1', completeRequest('ipc-resend'));
      const first = sentComplete(mock);

      const next = reconnect(mock);
      const resent = sentComplete(next);

      // A fresh correlation id and an otherwise byte-identical frame: a late ack
      // for the pre-disconnect send must not resolve the re-keyed pending.
      expect(resent.messageId).not.toBe(first.messageId);
      expect({ ...(resent as Record<string, unknown>), messageId: first.messageId }).toEqual(first);
      const settled = vi.fn();
      void promise.then(settled, settled);
      simulateMessage(next, {
        type: 'artifacts.upload.complete.ack',
        requestId: first.messageId,
        outcome: 'committed',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).not.toHaveBeenCalled();

      simulateMessage(next, {
        type: 'artifacts.upload.complete.ack',
        requestId: resent.messageId,
        outcome: 'committed',
      });

      await expect(promise).resolves.toEqual({
        type: 'artifacts.response',
        requestId: 'ipc-resend',
      });
    });

    it('gives up after the resend budget and says the artifact may have committed', async () => {
      const client = createClient();
      let mock = registerClient(client, { capabilities: ACK_CAPS });

      const settled = client
        .requestUserArtifact('job-1', completeRequest('ipc-budget'))
        .then(() => null)
        .catch((err: Error) => err);
      expect(sentComplete(mock)).toBeDefined();

      // One reconnect per resend, plus the one that exhausts the budget.
      for (let i = 0; i <= MAX_COMPLETE_RESEND_ATTEMPTS; i++) {
        mock = reconnect(mock);
      }

      // The wording matters: an operator must not be sent hunting for an
      // artifact that is in fact committed.
      expect(await settled).toMatchObject({
        message: expect.stringContaining('may have been committed'),
      });
    });

    it('fails closed when the reconnected orchestrator can no longer ack', async () => {
      // Resolving here would report success for a commit whose outcome we never
      // learned — the fail-open loss the ack exists to prevent.
      const client = createClient();
      const mock = registerClient(client, { capabilities: ACK_CAPS });

      const settled = client
        .requestUserArtifact('job-1', completeRequest('ipc-downgrade'))
        .then(() => null)
        .catch((err: Error) => err);
      expect(sentComplete(mock)).toBeDefined();

      reconnect(mock, null);

      expect(await settled).toMatchObject({
        message: expect.stringContaining('may have been committed'),
      });
    });

    it('does not restart the ack deadline across a resend', async () => {
      // Load-bearing: a restarted timer would let a flapping connection keep the
      // step alive indefinitely instead of failing on the original schedule.
      const client = createClient();
      const mock = registerClient(client, { capabilities: ACK_CAPS });

      const settled = client
        .requestUserArtifact('job-1', completeRequest('ipc-deadline'))
        .then(() => null)
        .catch((err: Error) => err);
      expect(sentComplete(mock)).toBeDefined();

      // 20s of waiting, then a reconnect (+2s of backoff), then 4s more — past
      // the 25s deadline, which the resend must not have pushed out.
      await vi.advanceTimersByTimeAsync(20_000);
      const next = reconnect(mock);
      expect(sentComplete(next)).toBeDefined();
      await vi.advanceTimersByTimeAsync(4_000);

      expect(await settled).toMatchObject({
        message: expect.stringContaining('upload-complete ack timed out'),
      });
    });

    /** The `artifacts.<kind>.request` frame the client sent. */
    function sentRequest(mock: MockWsInstance, kind: 'upload' | 'download'): { messageId: string } {
      return getSentMessages(mock).find(
        (m) => (m as { type?: string }).type === `artifacts.${kind}.request`,
      ) as { messageId: string };
    }

    it('maps a rejected upload response error onto rejectionDetail, not the relay error', async () => {
      const client = createClient();
      const mock = registerClient(client);

      const promise = client.requestUserArtifact('job-1', {
        type: 'artifacts.request',
        requestId: 'ipc-6',
        op: 'beginUpload',
        name: 'bundle',
        declaredSizeBytes: 100,
      });

      simulateMessage(mock, {
        type: 'artifacts.upload.response',
        requestId: sentRequest(mock, 'upload').messageId,
        outcome: 'rejected',
        error: 'the orchestrator hit an internal error while starting the upload',
      });

      const resolved = await promise;
      expect(resolved.uploadOutcome).toBe('rejected');
      expect(resolved.reason).toBeUndefined();
      expect(resolved.rejectionDetail).toBe(
        'the orchestrator hit an internal error while starting the upload',
      );
      // Must NOT populate the relay-failure field — that would make the sandbox
      // throw a transport error instead of rendering the rejection.
      expect(resolved.error).toBeUndefined();
    });

    it('maps a not_found download response error onto rejectionDetail', async () => {
      const client = createClient();
      const mock = registerClient(client);

      const promise = client.requestUserArtifact('job-1', {
        type: 'artifacts.request',
        requestId: 'ipc-7',
        op: 'download',
        name: 'bundle',
      });

      simulateMessage(mock, {
        type: 'artifacts.download.response',
        requestId: sentRequest(mock, 'download').messageId,
        outcome: 'not_found',
        error: 'artifact downloads are not configured on this orchestrator',
      });

      const resolved = await promise;
      expect(resolved.downloadOutcome).toBe('not_found');
      expect(resolved.rejectionDetail).toBe(
        'artifact downloads are not configured on this orchestrator',
      );
      expect(resolved.error).toBeUndefined();
    });

    it('leaves rejectionDetail unset on an enforcement rejection', async () => {
      const client = createClient();
      const mock = registerClient(client);

      const promise = client.requestUserArtifact('job-1', {
        type: 'artifacts.request',
        requestId: 'ipc-8',
        op: 'beginUpload',
        name: 'bundle',
        declaredSizeBytes: 100,
      });

      simulateMessage(mock, {
        type: 'artifacts.upload.response',
        requestId: sentRequest(mock, 'upload').messageId,
        outcome: 'rejected',
        reason: 'org_quota',
      });

      const resolved = await promise;
      expect(resolved.reason).toBe('org_quota');
      expect(resolved.rejectionDetail).toBeUndefined();
    });

    it('fails the step on the ack deadline when the orchestrator never comes back', async () => {
      // A held complete is not a hang: the original ack timer still owns the
      // deadline, so a genuinely unreachable orchestrator fails the step on
      // schedule instead of parking it forever.
      const client = createClient();
      const mock = registerClient(client, { capabilities: ACK_CAPS });

      const settled = client
        .requestUserArtifact('job-1', completeRequest('ipc-5'))
        .then(() => null)
        .catch((err: Error) => err);
      mock.readyState = 3;
      mock.emit('close', 1006, Buffer.from('gone'));

      await vi.advanceTimersByTimeAsync(26_000);

      expect(await settled).toMatchObject({
        message: expect.stringContaining('upload-complete ack timed out'),
      });
    });
  });
});
