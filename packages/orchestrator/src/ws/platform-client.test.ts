import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WS_MAX_PAYLOAD_BYTES, type OrchestratorToPlatformMessage } from '@kici-dev/engine';
import { PlatformClient, type PlatformClientOptions } from './platform-client.js';

// ── Hoisted mock state ──────────────────────────────────────────────

/**
 * vi.hoisted runs before any imports, making these values available
 * inside the vi.mock factory which is also hoisted.
 */
const { mockInstances, mockConstructorArgs } = vi.hoisted(() => {
  return {
    mockInstances: [] as import('node:events').EventEmitter[],
    // Each entry is the argv array a single `new WebSocket(...)` call received.
    // Used by the TLS-chain-trust invariant test to introspect the
    // options object the orchestrator passes to the underlying ws library.
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

// ── Test helpers ────────────────────────────────────────────────────

function createClient(overrides: Partial<PlatformClientOptions> = {}) {
  return new PlatformClient({
    url: 'ws://localhost:9999/ws',
    token: 'test-api-key',
    onWebhookRelay: vi.fn().mockResolvedValue(undefined),
    heartbeatIntervalMs: 30_000,
    maxReconnectDelayMs: 60_000,
    ...overrides,
  });
}

function authenticateClient(client: PlatformClient): MockWsInstance {
  client.connect();
  const mock = getLatestMock();
  simulateOpen(mock);
  simulateMessage(mock, {
    type: 'auth.success',
    connectionId: 'conn-123',
  });
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

describe('PlatformClient', () => {
  describe('connection lifecycle', () => {
    it('starts in disconnected state', () => {
      const client = createClient();
      expect(client.state).toBe('disconnected');
    });

    it('transitions: disconnected -> connecting -> authenticating on open', () => {
      const client = createClient();
      client.connect();

      expect(client.state).toBe('connecting');

      const mock = getLatestMock();
      simulateOpen(mock);

      expect(client.state).toBe('authenticating');
    });

    it('sends auth.request with capabilities on open', () => {
      const client = createClient();
      client.connect();

      const mock = getLatestMock();
      simulateOpen(mock);

      const sent = getSentMessages(mock);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({
        type: 'auth.request',
        token: 'test-api-key',
        protocolVersion: 1,
        capabilities: { orchRole: 'coordinator' },
      });
    });

    it('transitions to authenticated on auth.success', () => {
      const client = createClient();
      authenticateClient(client);
      expect(client.state).toBe('authenticated');
    });

    it('transitions to disconnected on close', () => {
      const client = createClient();
      const mock = authenticateClient(client);

      mock.readyState = 3; // CLOSED
      mock.emit('close', 1000, Buffer.from('normal'));

      expect(client.state).toBe('disconnected');
    });
  });

  describe('auth failure', () => {
    it('closes connection on auth.failure', () => {
      const client = createClient();
      client.connect();

      const mock = getLatestMock();
      simulateOpen(mock);

      simulateMessage(mock, {
        type: 'auth.failure',
        reason: 'Invalid API key',
      });

      expect(mock.closeCode).toBe(1000);
      expect(mock.closeReason).toBe('Auth failed');
    });
  });

  describe('capability exchange', () => {
    it('sends orchestrator capabilities in auth.request', () => {
      const client = createClient();
      client.connect();

      const mock = getLatestMock();
      simulateOpen(mock);

      // Verify auth.request was sent with capabilities
      expect(mock.sentMessages).toHaveLength(1);
      const authReq = JSON.parse(mock.sentMessages[0]);
      expect(authReq.type).toBe('auth.request');
      expect(authReq.capabilities).toBeDefined();
      expect(authReq.capabilities.orchRole).toBe('coordinator');
    });

    it('includes dashboardWrites in auth.request when supplied via options', () => {
      const client = createClient({
        orchCapabilities: {
          dashboardWrites: { 'secrets.set': false, 'variables.set': false },
        },
      });
      client.connect();

      const mock = getLatestMock();
      simulateOpen(mock);

      const authReq = JSON.parse(mock.sentMessages[0]);
      expect(authReq.type).toBe('auth.request');
      expect(authReq.capabilities.dashboardWrites).toEqual({
        'secrets.set': false,
        'variables.set': false,
      });
      expect(authReq.capabilities.orchRole).toBe('coordinator');
    });

    it('broadcastCapabilities sends orch.capabilities.update when authenticated', () => {
      const client = createClient();
      const mock = authenticateClient(client);
      mock.sentMessages = [];

      client.broadcastCapabilities({
        dashboardWrites: { 'secrets.set': false },
      });

      const sent = getSentMessages(mock);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({
        type: 'orch.capabilities.update',
        capabilities: {
          orchRole: 'coordinator',
          dashboardWrites: { 'secrets.set': false },
        },
      });
    });

    it('broadcastCapabilities buffers when not yet authenticated', () => {
      const client = createClient();

      client.broadcastCapabilities({
        dashboardWrites: { 'held_runs.approve': false },
      });

      expect(client.getBufferedCount()).toBe(1);
    });

    it('broadcastCapabilities accumulates updates across calls', () => {
      const client = createClient();
      const mock = authenticateClient(client);
      mock.sentMessages = [];

      client.broadcastCapabilities({ dashboardWrites: { 'secrets.set': false } });
      client.broadcastCapabilities({ dashboardWrites: { 'variables.set': false } });

      const sent = getSentMessages(mock) as Array<{
        type: string;
        capabilities: { dashboardWrites?: Record<string, boolean> };
      }>;
      expect(sent).toHaveLength(2);
      // Second broadcast replaces dashboardWrites with the new map; the
      // caller is responsible for merging on its side (server.ts passes
      // the full policy map every time).
      expect(sent[1].capabilities.dashboardWrites).toEqual({ 'variables.set': false });
      expect(sent[1].capabilities.orchRole).toBe('coordinator');
    });

    it('getCapabilities reflects merged state after broadcastCapabilities', () => {
      const client = createClient({
        orchCapabilities: {
          dashboardWrites: { 'secrets.set': false },
        },
      });
      expect(client.getCapabilities()).toEqual({
        orchRole: 'coordinator',
        dashboardWrites: { 'secrets.set': false },
      });

      client.broadcastCapabilities({ dashboardWrites: { 'secrets.delete': false } });
      expect(client.getCapabilities()).toEqual({
        orchRole: 'coordinator',
        dashboardWrites: { 'secrets.delete': false },
      });
    });
  });

  describe('send() and buffering', () => {
    it('sends immediately when authenticated', () => {
      const client = createClient();
      const mock = authenticateClient(client);
      mock.sentMessages = [];

      const msg: OrchestratorToPlatformMessage = {
        type: 'execution.event',
        messageId: 'msg-1',
        runId: 'run-1',
        event: 'started',
        data: {},
        timestamp: Date.now(),
      };

      client.send(msg);

      const sent = getSentMessages(mock);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ type: 'execution.event', runId: 'run-1' });
    });

    it('buffers messages when disconnected', () => {
      const client = createClient();

      const msg: OrchestratorToPlatformMessage = {
        type: 'execution.event',
        messageId: 'msg-1',
        runId: 'run-1',
        event: 'started',
        data: {},
        timestamp: Date.now(),
      };

      client.send(msg);
      expect(client.getBufferedCount()).toBe(1);
    });

    it('buffers messages when connecting (not yet authenticated)', () => {
      const client = createClient();
      client.connect();

      const msg: OrchestratorToPlatformMessage = {
        type: 'execution.event',
        messageId: 'msg-1',
        runId: 'run-1',
        event: 'started',
        data: {},
        timestamp: Date.now(),
      };

      client.send(msg);
      expect(client.getBufferedCount()).toBe(1);
    });
  });

  describe('buffer flush on auth success', () => {
    it('flushes buffered messages on successful authentication', () => {
      const client = createClient();

      client.send({
        type: 'execution.event',
        messageId: 'msg-1',
        runId: 'run-1',
        event: 'started',
        data: {},
        timestamp: 1000,
      });
      client.send({
        type: 'execution.event',
        messageId: 'msg-2',
        runId: 'run-2',
        event: 'finished',
        data: {},
        timestamp: 2000,
      });

      expect(client.getBufferedCount()).toBe(2);

      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      mock.sentMessages = [];

      simulateMessage(mock, {
        type: 'auth.success',
        appId: 42,
        connectionId: 'conn-123',
      });

      expect(client.getBufferedCount()).toBe(0);

      // auth.success also emits the presence source.register; the buffer
      // flush is the two execution events, in order.
      const sent = getSentMessages(mock);
      const events = sent.filter((m: any) => m.type === 'execution.event');
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: 'execution.event', messageId: 'msg-1' });
      expect(events[1]).toMatchObject({ type: 'execution.event', messageId: 'msg-2' });
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
      authenticateClient(client);

      client.disconnect();

      expect(client.state).toBe('disconnected');

      vi.advanceTimersByTime(120_000);

      expect(mockInstances.length).toBe(1);
    });

    it('reconnects on close code 4011 (cluster_name_conflict) so HA cluster siblings can recover', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit called with ${code}`);
      }) as never);

      const client = createClient();
      const mock = authenticateClient(client);

      mock.readyState = 3;
      mock.emit('close', 4011, Buffer.from('cluster_name_conflict'));

      expect(exitSpy).not.toHaveBeenCalled();
      expect(client.state).toBe('disconnected');

      vi.advanceTimersByTime(120_000);
      expect(mockInstances.length).toBeGreaterThan(1);

      exitSpy.mockRestore();
    });

    it('resets reconnect attempts on successful auth', () => {
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

      const attemptsBeforeAuth = mockInstances.length;

      vi.advanceTimersByTime(120_000);
      mock = getLatestMock();
      simulateOpen(mock);
      simulateMessage(mock, {
        type: 'auth.success',
        appId: 42,
        connectionId: 'conn-abc',
      });

      expect(client.state).toBe('authenticated');

      mock.readyState = 3;
      mock.emit('close', 1006, Buffer.from('abnormal'));

      // With reset, base delay ~1000-1500ms
      vi.advanceTimersByTime(2000);

      expect(mockInstances.length).toBe(attemptsBeforeAuth + 2);
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
    it('sends heartbeat messages periodically when authenticated', () => {
      const client = createClient({ heartbeatIntervalMs: 5000 });
      const mock = authenticateClient(client);
      mock.sentMessages = [];

      vi.advanceTimersByTime(5000);

      const sent = getSentMessages(mock);
      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent[0]).toMatchObject({ type: 'heartbeat' });
      expect(sent[0]).toHaveProperty('timestamp');
    });

    it('stops heartbeat on disconnect', () => {
      const client = createClient({ heartbeatIntervalMs: 5000 });
      const mock = authenticateClient(client);
      mock.sentMessages = [];

      client.disconnect();

      vi.advanceTimersByTime(10_000);

      expect(mock.sentMessages).toHaveLength(0);
    });
  });

  describe('source registration', () => {
    it('sends source.register after auth.success when providerSources configured', () => {
      const client = createClient({
        providerSources: [{ provider: 'github', routingKey: 'github:42' }],
      });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      // Clear auth.request message
      mock.sentMessages = [];

      simulateMessage(mock, {
        type: 'auth.success',
        connectionId: 'conn-123',
      });

      const sent = getSentMessages(mock);
      // Should have source.register message
      const registerMsg = sent.find((m: any) => m.type === 'source.register');
      expect(registerMsg).toBeDefined();
      expect((registerMsg as any).sources).toEqual([
        { provider: 'github', routingKey: 'github:42' },
      ]);
    });

    it('includes the deployment shape in source.register when configured', () => {
      const client = createClient({
        providerSources: [{ provider: 'github', routingKey: 'github:42' }],
        deployment: {
          mode: 'compose',
          containerName: 'kici-orchestrator',
          containerRuntime: 'podman',
        },
      });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);
      mock.sentMessages = [];

      simulateMessage(mock, { type: 'auth.success', connectionId: 'conn-123' });

      const sent = getSentMessages(mock);
      const registerMsg = sent.find((m: any) => m.type === 'source.register') as any;
      expect(registerMsg).toBeDefined();
      expect(registerMsg.deployment).toEqual({
        mode: 'compose',
        containerName: 'kici-orchestrator',
        containerRuntime: 'podman',
      });
    });

    it('omits deployment from source.register when not configured', () => {
      const client = createClient({
        providerSources: [{ provider: 'github', routingKey: 'github:42' }],
      });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);
      mock.sentMessages = [];

      simulateMessage(mock, { type: 'auth.success', connectionId: 'conn-123' });

      const sent = getSentMessages(mock);
      const registerMsg = sent.find((m: any) => m.type === 'source.register') as any;
      expect(registerMsg).toBeDefined();
      expect(registerMsg.deployment).toBeUndefined();
    });

    it('sends source.register with empty sources when no providerSources configured', () => {
      // A connected orchestrator with zero sources must still announce itself
      // so the Platform records it as connected (writes its
      // platform_connections row). It sends source.register with an empty
      // sources array rather than going silent.
      const client = createClient();
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      mock.sentMessages = [];

      simulateMessage(mock, {
        type: 'auth.success',
        connectionId: 'conn-123',
      });

      const sent = getSentMessages(mock);
      const registerMsg = sent.find((m: any) => m.type === 'source.register');
      expect(registerMsg).toBeDefined();
      expect((registerMsg as any).sources).toEqual([]);
    });

    it('sends multiple sources in one source.register message', () => {
      const client = createClient({
        providerSources: [
          { provider: 'github', routingKey: 'github:42' },
          { provider: 'github', routingKey: 'github:99' },
        ],
      });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);
      mock.sentMessages = [];

      simulateMessage(mock, {
        type: 'auth.success',
        connectionId: 'conn-123',
      });

      const sent = getSentMessages(mock);
      const registerMsg = sent.find((m: any) => m.type === 'source.register') as any;
      expect(registerMsg).toBeDefined();
      expect(registerMsg.sources).toHaveLength(2);
      expect(registerMsg.sources[0].routingKey).toBe('github:42');
      expect(registerMsg.sources[1].routingKey).toBe('github:99');
    });

    it('re-registers a source whose slug changed (same routing key)', () => {
      const client = createClient({
        providerSources: [
          {
            provider: 'github',
            routingKey: 'github:42',
            name: 'My App',
            subtype: 'github_app',
            slug: 'old-slug',
          },
        ],
      });
      const mock = authenticateClient(client);
      mock.sentMessages = [];

      // Same routing key + name, only the slug changed — must still re-register.
      client.updateSources([
        {
          provider: 'github',
          routingKey: 'github:42',
          name: 'My App',
          subtype: 'github_app',
          slug: 'new-slug',
        },
      ]);

      const sent = getSentMessages(mock);
      const registerMsg = sent.find((m: any) => m.type === 'source.register') as any;
      expect(registerMsg).toBeDefined();
      expect(registerMsg.sources).toHaveLength(1);
      expect(registerMsg.sources[0].routingKey).toBe('github:42');
      expect(registerMsg.sources[0].slug).toBe('new-slug');
    });

    it('does not re-register when name, slug and subtype are unchanged', () => {
      const src = {
        provider: 'github' as const,
        routingKey: 'github:42',
        name: 'My App',
        subtype: 'github_app' as const,
        slug: 'my-app',
      };
      const client = createClient({ providerSources: [src] });
      const mock = authenticateClient(client);
      mock.sentMessages = [];

      client.updateSources([{ ...src }]);

      const sent = getSentMessages(mock);
      expect(sent.find((m: any) => m.type === 'source.register')).toBeUndefined();
    });

    it('handles source.register.ack with accepted sources', () => {
      const client = createClient({
        providerSources: [{ provider: 'github', routingKey: 'github:42' }],
      });
      const mock = authenticateClient(client);

      // Should not throw or change state
      simulateMessage(mock, {
        type: 'source.register.ack',
        messageId: 'msg-ack-1',
        accepted: [{ routingKey: 'github:42', webhookUrl: null }],
        rejected: [],
      });

      expect(client.state).toBe('authenticated');
    });

    it('handles source.register.ack with rejected sources', () => {
      const client = createClient({
        providerSources: [{ provider: 'github', routingKey: 'github:42' }],
      });
      const mock = authenticateClient(client);

      simulateMessage(mock, {
        type: 'source.register.ack',
        messageId: 'msg-ack-1',
        accepted: [],
        rejected: [{ routingKey: 'github:42', reason: 'Duplicate routing key' }],
      });

      // Client remains authenticated even if sources rejected
      expect(client.state).toBe('authenticated');
    });

    it('registerSourceAndAwait resolves with the webhook URL from the ack', async () => {
      const client = createClient({
        providerSources: [{ provider: 'github', routingKey: 'github:42' }],
      });
      const mock = authenticateClient(client);

      const pending = client.registerSourceAndAwait(
        [
          { provider: 'github', routingKey: 'github:42' },
          { provider: 'github', routingKey: 'github:7' },
        ],
        'github:7',
      );

      simulateMessage(mock, {
        type: 'source.register.ack',
        messageId: 'msg-ack-2',
        accepted: [
          { routingKey: 'github:7', webhookUrl: 'https://api.kici.dev/webhook/org_x/github' },
        ],
        rejected: [],
      });

      await expect(pending).resolves.toBe('https://api.kici.dev/webhook/org_x/github');
    });

    it('registerSourceAndAwait resolves null when the Platform returns a null URL', async () => {
      const client = createClient({ providerSources: [] });
      const mock = authenticateClient(client);

      const pending = client.registerSourceAndAwait(
        [{ provider: 'github', routingKey: 'github:7' }],
        'github:7',
      );
      simulateMessage(mock, {
        type: 'source.register.ack',
        messageId: 'msg-ack-3',
        accepted: [{ routingKey: 'github:7', webhookUrl: null }],
        rejected: [],
      });

      await expect(pending).resolves.toBeNull();
    });

    it('registerSourceAndAwait rejects on timeout when no ack arrives', async () => {
      const client = createClient({ providerSources: [] });
      authenticateClient(client);

      const pending = client.registerSourceAndAwait(
        [{ provider: 'github', routingKey: 'github:7' }],
        'github:7',
        5000,
      );
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      vi.advanceTimersByTime(5000);
      await assertion;
    });

    it('registerSourceAndAwait rejects when the connection closes before the ack', async () => {
      const client = createClient({ providerSources: [] });
      const mock = authenticateClient(client);

      const pending = client.registerSourceAndAwait(
        [{ provider: 'github', routingKey: 'github:7' }],
        'github:7',
      );
      const assertion = expect(pending).rejects.toThrow(/connection closed/);
      mock.readyState = 3;
      mock.emit('close', 1006, Buffer.from('abnormal'));
      await assertion;
    });

    it('re-sends source.register on reconnection', () => {
      const client = createClient({
        providerSources: [{ provider: 'github', routingKey: 'github:42' }],
      });

      // First connection
      client.connect();
      let mock = getLatestMock();
      simulateOpen(mock);
      simulateMessage(mock, { type: 'auth.success', connectionId: 'conn-1' });

      // Disconnect
      mock.readyState = 3;
      mock.emit('close', 1006, Buffer.from('abnormal'));

      // Reconnect
      vi.advanceTimersByTime(2000);
      mock = getLatestMock();
      simulateOpen(mock);
      mock.sentMessages = [];

      simulateMessage(mock, { type: 'auth.success', connectionId: 'conn-2' });

      const sent = getSentMessages(mock);
      const registerMsg = sent.find((m: any) => m.type === 'source.register');
      expect(registerMsg).toBeDefined();
      expect((registerMsg as any).sources[0].routingKey).toBe('github:42');
    });
  });

  describe('instanceId and address in source.register', () => {
    it('includes instanceId in source.register when configured', () => {
      const client = createClient({
        providerSources: [{ provider: 'github', routingKey: 'github:42' }],
        instanceId: 'orch-abc',
      });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);
      mock.sentMessages = [];

      simulateMessage(mock, { type: 'auth.success', connectionId: 'conn-123' });

      const sent = getSentMessages(mock);
      const registerMsg = sent.find((m: any) => m.type === 'source.register') as any;
      expect(registerMsg).toBeDefined();
      expect(registerMsg.instanceId).toBe('orch-abc');
    });

    it('does not include instanceId when not configured', () => {
      const client = createClient({
        providerSources: [{ provider: 'github', routingKey: 'github:42' }],
      });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);
      mock.sentMessages = [];

      simulateMessage(mock, { type: 'auth.success', connectionId: 'conn-123' });

      const sent = getSentMessages(mock);
      const registerMsg = sent.find((m: any) => m.type === 'source.register') as any;
      expect(registerMsg).toBeDefined();
      expect(registerMsg.instanceId).toBeUndefined();
    });

    it('includes clusterName in source.register when configured', () => {
      const client = createClient({
        providerSources: [{ provider: 'github', routingKey: 'github:42' }],
        clusterName: 'production-arm',
      });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);
      mock.sentMessages = [];

      simulateMessage(mock, { type: 'auth.success', connectionId: 'conn-123' });

      const sent = getSentMessages(mock);
      const registerMsg = sent.find((m: any) => m.type === 'source.register') as any;
      expect(registerMsg).toBeDefined();
      expect(registerMsg.clusterName).toBe('production-arm');
    });

    it('does not include clusterName when not configured', () => {
      const client = createClient({
        providerSources: [{ provider: 'github', routingKey: 'github:42' }],
      });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);
      mock.sentMessages = [];

      simulateMessage(mock, { type: 'auth.success', connectionId: 'conn-123' });

      const sent = getSentMessages(mock);
      const registerMsg = sent.find((m: any) => m.type === 'source.register') as any;
      expect(registerMsg).toBeDefined();
      expect(registerMsg.clusterName).toBeUndefined();
    });
  });

  describe('peer.discover handling', () => {
    it('calls onPeerDiscover when peer.discover message received', () => {
      const onPeerDiscover = vi.fn();
      const client = createClient({ onPeerDiscover });
      const mock = authenticateClient(client);

      simulateMessage(mock, {
        type: 'peer.discover',
        peer: {
          connectionId: 'conn-peer-1',
          instanceId: 'peer-abc',
          address: 'ws://192.168.1.100:4000',
          routingKeys: ['github:42'],
        },
      });

      expect(onPeerDiscover).toHaveBeenCalledWith({
        connectionId: 'conn-peer-1',
        instanceId: 'peer-abc',
        address: 'ws://192.168.1.100:4000',
        routingKeys: ['github:42'],
      });
    });

    it('calls onPeerDiscover for each peer in source.register.ack', () => {
      const onPeerDiscover = vi.fn();
      const client = createClient({
        providerSources: [{ provider: 'github', routingKey: 'github:42' }],
        onPeerDiscover,
      });
      const mock = authenticateClient(client);

      simulateMessage(mock, {
        type: 'source.register.ack',
        messageId: 'msg-ack-1',
        accepted: [{ routingKey: 'github:42', webhookUrl: null }],
        rejected: [],
        peers: [
          {
            connectionId: 'conn-peer-1',
            instanceId: 'peer-abc',
            address: 'ws://192.168.1.100:4000',
            routingKeys: ['github:42'],
          },
          {
            connectionId: 'conn-peer-2',
            address: null,
            routingKeys: ['github:42'],
          },
        ],
      });

      expect(onPeerDiscover).toHaveBeenCalledTimes(2);
    });
  });

  describe('onAuthenticated callback', () => {
    it('calls onAuthenticated after source.register.ack is received', () => {
      const onAuthenticated = vi.fn();
      const client = createClient({
        providerSources: [{ provider: 'github', routingKey: 'github:42' }],
        onAuthenticated,
      });
      const mock = authenticateClient(client);

      // onAuthenticated should NOT be called yet (waiting for ACK)
      expect(onAuthenticated).not.toHaveBeenCalled();

      simulateMessage(mock, {
        type: 'source.register.ack',
        messageId: 'msg-ack-1',
        accepted: [{ routingKey: 'github:42', webhookUrl: null }],
        rejected: [],
      });

      expect(onAuthenticated).toHaveBeenCalledOnce();
    });

    it('calls onAuthenticated after the (empty) source.register.ack when no providerSources', () => {
      // With zero sources the client still announces via an empty
      // source.register, so onAuthenticated fires on its ack — not before.
      const onAuthenticated = vi.fn();
      const client = createClient({ onAuthenticated });
      const mock = authenticateClient(client);

      expect(onAuthenticated).not.toHaveBeenCalled();

      simulateMessage(mock, {
        type: 'source.register.ack',
        messageId: 'msg-ack-1',
        accepted: [],
        rejected: [],
      });

      expect(onAuthenticated).toHaveBeenCalledOnce();
    });
  });

  describe('error handling', () => {
    it('handles malformed JSON from server gracefully', () => {
      const client = createClient();
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      mock.emit('message', 'not-json{{{');

      expect(client.state).toBe('authenticating');
    });

    it('handles invalid protocol messages gracefully', () => {
      const client = createClient();
      const mock = authenticateClient(client);

      simulateMessage(mock, { type: 'unknown.type', foo: 'bar' });

      expect(client.state).toBe('authenticated');
    });

    it('answers a structured error for a malformed dashboard request (no silent drop)', () => {
      const client = createClient();
      const mock = authenticateClient(client);
      mock.sentMessages = [];

      // dashboard.environments.create requires `name`; an empty body fails the
      // primary schema. Without the response guarantee this message is dropped
      // and the Platform hangs until its 10s forward window lapses (504).
      simulateMessage(mock, { type: 'dashboard.environments.create', requestId: 'req-bad' });

      const sent = getSentMessages(mock);
      const resp = sent.find(
        (m) => (m as { type?: string }).type === 'dashboard.environments.create.response',
      ) as { requestId?: string; error?: string } | undefined;
      expect(resp).toBeDefined();
      expect(resp?.requestId).toBe('req-bad');
      expect(typeof resp?.error).toBe('string');
      expect(client.state).toBe('authenticated');
    });

    it('does NOT synthesize a response for a non-dashboard invalid message', () => {
      const client = createClient();
      const mock = authenticateClient(client);
      mock.sentMessages = [];

      simulateMessage(mock, { type: 'totally.unknown', requestId: 'req-x' });

      const sent = getSentMessages(mock);
      expect(sent.find((m) => (m as { type?: string }).type === 'totally.unknown.response')).toBe(
        undefined,
      );
      expect(client.state).toBe('authenticated');
    });
  });

  describe('stale.checkrun.cleanup handling', () => {
    it('calls onStaleCheckrunCleanup when message received', () => {
      const onStaleCheckrunCleanup = vi.fn();
      const client = createClient({ onStaleCheckrunCleanup });
      const mock = authenticateClient(client);

      simulateMessage(mock, {
        type: 'stale.checkrun.cleanup',
        runs: [
          {
            runId: 'run-1',
            provider: 'github',
            routingKey: 'github:42',
            repoIdentifier: 'owner/repo',
            sha: 'abc123',
            workflowName: 'ci',
            jobNames: ['test', 'lint'],
          },
        ],
      });

      expect(onStaleCheckrunCleanup).toHaveBeenCalledWith({
        type: 'stale.checkrun.cleanup',
        runs: [
          {
            runId: 'run-1',
            provider: 'github',
            routingKey: 'github:42',
            repoIdentifier: 'owner/repo',
            sha: 'abc123',
            workflowName: 'ci',
            jobNames: ['test', 'lint'],
          },
        ],
      });
    });

    it('does not crash when onStaleCheckrunCleanup is not provided', () => {
      const client = createClient();
      const mock = authenticateClient(client);

      simulateMessage(mock, {
        type: 'stale.checkrun.cleanup',
        runs: [],
      });

      expect(client.state).toBe('authenticated');
    });
  });

  // ── Dashboard env-message dispatch ─────────────────────────────────
  //
  // `dispatchPlatformMessage` in platform-client.ts ends with a
  // `default:` exhaustiveness assertion (`const _exhaustive: never =
  // msg`). Adding a new variant to `PlatformToOrchestratorMessage`
  // without a matching case fails `pnpm typecheck`, so the historical
  // bug class (silently-dropped dashboard messages — `dashboard.event-
  // log.payload.stream` and `dashboard.event-dlq.{list,count,retry,
  // discard}`) cannot recur.
  //
  // The dispatch tests below confirm the on-wire shape of new fall-
  // through cases still reaches `onDashboardEnvMessage` correctly.

  describe('dashboard env-message dispatch', () => {
    it('routes dashboard.event-log.payload.stream to onDashboardEnvMessage', () => {
      const onDashboardEnvMessage = vi.fn();
      const client = createClient({ onDashboardEnvMessage });
      const mock = authenticateClient(client);

      simulateMessage(mock, {
        type: 'dashboard.event-log.payload.stream',
        requestId: 'req-1',
        actor: { type: 'user', sub: 'sub-1' },
        orgId: 'kiciStg00001',
        deliveryId: 'delivery-1',
      });

      expect(onDashboardEnvMessage).toHaveBeenCalledTimes(1);
      expect(onDashboardEnvMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'dashboard.event-log.payload.stream',
          requestId: 'req-1',
          orgId: 'kiciStg00001',
          deliveryId: 'delivery-1',
        }),
      );
    });

    it('routes dashboard.event-dlq.list to onDashboardEnvMessage', () => {
      const onDashboardEnvMessage = vi.fn();
      const client = createClient({ onDashboardEnvMessage });
      const mock = authenticateClient(client);

      simulateMessage(mock, {
        type: 'dashboard.event-dlq.list',
        requestId: 'req-dlq-list',
        actor: { type: 'user', sub: 'sub-1' },
        orgId: 'kiciStg00001',
        limit: 50,
      });

      expect(onDashboardEnvMessage).toHaveBeenCalledTimes(1);
      expect(onDashboardEnvMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'dashboard.event-dlq.list',
          requestId: 'req-dlq-list',
          orgId: 'kiciStg00001',
          limit: 50,
        }),
      );
    });

    it('routes dashboard.event-dlq.count to onDashboardEnvMessage', () => {
      const onDashboardEnvMessage = vi.fn();
      const client = createClient({ onDashboardEnvMessage });
      const mock = authenticateClient(client);

      simulateMessage(mock, {
        type: 'dashboard.event-dlq.count',
        requestId: 'req-dlq-count',
        actor: { type: 'user', sub: 'sub-1' },
        orgId: 'kiciStg00001',
      });

      expect(onDashboardEnvMessage).toHaveBeenCalledTimes(1);
      expect(onDashboardEnvMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'dashboard.event-dlq.count',
          requestId: 'req-dlq-count',
          orgId: 'kiciStg00001',
        }),
      );
    });

    it('routes dashboard.event-dlq.retry to onDashboardEnvMessage', () => {
      const onDashboardEnvMessage = vi.fn();
      const client = createClient({ onDashboardEnvMessage });
      const mock = authenticateClient(client);

      simulateMessage(mock, {
        type: 'dashboard.event-dlq.retry',
        requestId: 'req-dlq-retry',
        actor: { type: 'user', sub: 'sub-1' },
        orgId: 'kiciStg00001',
        eventId: 'evt-1',
      });

      expect(onDashboardEnvMessage).toHaveBeenCalledTimes(1);
      expect(onDashboardEnvMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'dashboard.event-dlq.retry',
          requestId: 'req-dlq-retry',
          orgId: 'kiciStg00001',
          eventId: 'evt-1',
        }),
      );
    });

    it('routes dashboard.event-dlq.discard to onDashboardEnvMessage', () => {
      const onDashboardEnvMessage = vi.fn();
      const client = createClient({ onDashboardEnvMessage });
      const mock = authenticateClient(client);

      simulateMessage(mock, {
        type: 'dashboard.event-dlq.discard',
        requestId: 'req-dlq-discard',
        actor: { type: 'user', sub: 'sub-1' },
        orgId: 'kiciStg00001',
        eventId: 'evt-1',
      });

      expect(onDashboardEnvMessage).toHaveBeenCalledTimes(1);
      expect(onDashboardEnvMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'dashboard.event-dlq.discard',
          requestId: 'req-dlq-discard',
          orgId: 'kiciStg00001',
          eventId: 'evt-1',
        }),
      );
    });

    it('logs and does not crash when an unknown platform message type reaches the dispatcher', () => {
      const client = createClient();
      authenticateClient(client);

      // The Zod parse in handleMessage would reject this, so invoke the
      // private dispatcher directly. The default branch is the
      // belt-and-braces runtime guard sitting behind the compile-time
      // exhaustiveness assertion.
      const dispatcher = (
        client as unknown as { dispatchPlatformMessage(msg: unknown): void }
      ).dispatchPlatformMessage.bind(client);

      expect(() => dispatcher({ type: 'unknown.future.type' })).not.toThrow();
      expect(client.state).toBe('authenticated');
    });
  });

  // ── Chunked webhook.relay protocol ─────────────────────────────────

  describe('chunked webhook.relay protocol', () => {
    /**
     * Build a chunked relay scenario: drive a single inbound webhook through
     * `webhook.relay.start` + N `webhook.relay.chunk` frames and assert what
     * the orchestrator emits on the wire (plus what the wired callbacks see).
     */
    function makeStartFrame(messageId: string, body: string, chunkCount: number) {
      return {
        type: 'webhook.relay.start',
        messageId,
        routingKey: 'github:12345',
        deliveryId: `del-${messageId}`,
        event: 'push',
        action: null,
        signatureHeaderName: 'x-hub-signature-256',
        signatureHeader: 'sha256=deadbeef',
        clientIp: '10.0.0.1',
        // Default to JSON content-type so tests that supply JSON bodies get
        // a parsed payload from completeChunkedRelay. Tests for raw-body
        // routing override this header explicitly.
        headers: { 'x-github-event': 'push', 'content-type': 'application/json' },
        totalSize: Buffer.byteLength(body, 'utf8'),
        chunkCount,
      };
    }

    function makeChunk(messageId: string, sequence: number, data: string, final: boolean) {
      return {
        type: 'webhook.relay.chunk',
        messageId,
        sequence,
        data: Buffer.from(data, 'utf8').toString('base64'),
        final,
      };
    }

    it('reassembles a single-chunk stream and ACKs accepted', async () => {
      const onWebhookRelay = vi.fn().mockResolvedValue(undefined);
      const onVerifyInbound = vi.fn().mockResolvedValue({ result: 'accepted' as const });
      const client = createClient({ onWebhookRelay, onVerifyInbound });
      const mock = authenticateClient(client);

      const body = '{"foo":1}';
      simulateMessage(mock, makeStartFrame('m1', body, 1));
      // No ACK after start.
      const afterStart = getSentMessages(mock);
      expect(
        afterStart.find((m) => (m as { type: string }).type === 'webhook.ack'),
      ).toBeUndefined();

      simulateMessage(mock, makeChunk('m1', 0, body, true));

      // Allow the async completeChunkedRelay path to flush.
      // Advance well under the 30s heartbeat so interval doesn't loop, but
      // long enough to flush the async completeChunkedRelay microtask chain.
      await vi.advanceTimersByTimeAsync(100);

      expect(onVerifyInbound).toHaveBeenCalledTimes(1);
      const [meta, bodyBuf] = onVerifyInbound.mock.calls[0]!;
      expect(meta.routingKey).toBe('github:12345');
      expect(bodyBuf).toBeInstanceOf(Buffer);
      expect((bodyBuf as Buffer).toString('utf8')).toBe(body);

      const acks = getSentMessages(mock).filter(
        (m) => (m as { type: string }).type === 'webhook.ack',
      );
      expect(acks).toHaveLength(1);
      expect(acks[0]).toMatchObject({
        type: 'webhook.ack',
        messageId: 'm1',
        deliveryId: 'del-m1',
        result: 'accepted',
      });

      expect(onWebhookRelay).toHaveBeenCalledTimes(1);
      const relay = onWebhookRelay.mock.calls[0]![0] as { payload: unknown; routingKey: string };
      expect(relay.routingKey).toBe('github:12345');
      expect(relay.payload).toEqual({ foo: 1 });
    });

    it('reassembles a multi-chunk stream in order', async () => {
      const onWebhookRelay = vi.fn().mockResolvedValue(undefined);
      const onVerifyInbound = vi.fn().mockResolvedValue({ result: 'accepted' as const });
      const client = createClient({ onWebhookRelay, onVerifyInbound });
      const mock = authenticateClient(client);

      // Total body "abcdef" split into 3 chunks of 2.
      simulateMessage(mock, makeStartFrame('m2', 'abcdef', 3));
      simulateMessage(mock, makeChunk('m2', 0, 'ab', false));
      simulateMessage(mock, makeChunk('m2', 1, 'cd', false));
      // No ACK yet.
      expect(
        getSentMessages(mock).filter((m) => (m as { type: string }).type === 'webhook.ack'),
      ).toHaveLength(0);

      simulateMessage(mock, makeChunk('m2', 2, 'ef', true));
      // Advance well under the 30s heartbeat so interval doesn't loop, but
      // long enough to flush the async completeChunkedRelay microtask chain.
      await vi.advanceTimersByTimeAsync(100);

      const [, bodyBuf] = onVerifyInbound.mock.calls[0]!;
      expect((bodyBuf as Buffer).toString('utf8')).toBe('abcdef');
    });

    it('forwards onVerifyInbound rejection result to webhook.ack', async () => {
      const onWebhookRelay = vi.fn().mockResolvedValue(undefined);
      const onVerifyInbound = vi.fn().mockResolvedValue({
        result: 'rejected_signature' as const,
        reason: 'no rotation secret matched x-hub-signature-256',
      });
      const client = createClient({ onWebhookRelay, onVerifyInbound });
      const mock = authenticateClient(client);

      simulateMessage(mock, makeStartFrame('m3', 'x', 1));
      simulateMessage(mock, makeChunk('m3', 0, 'x', true));
      // Advance well under the 30s heartbeat so interval doesn't loop, but
      // long enough to flush the async completeChunkedRelay microtask chain.
      await vi.advanceTimersByTimeAsync(100);

      const acks = getSentMessages(mock).filter(
        (m) => (m as { type: string }).type === 'webhook.ack',
      );
      expect(acks).toHaveLength(1);
      expect(acks[0]).toMatchObject({
        type: 'webhook.ack',
        messageId: 'm3',
        deliveryId: 'del-m3',
        result: 'rejected_signature',
        reason: 'no rotation secret matched x-hub-signature-256',
      });
      // onWebhookRelay must NOT be invoked when verify rejects.
      expect(onWebhookRelay).not.toHaveBeenCalled();
    });

    it('ACKs rejected_misconfigured for an out-of-order chunk', async () => {
      const onWebhookRelay = vi.fn().mockResolvedValue(undefined);
      const onVerifyInbound = vi.fn().mockResolvedValue({ result: 'accepted' as const });
      const client = createClient({ onWebhookRelay, onVerifyInbound });
      const mock = authenticateClient(client);

      simulateMessage(mock, makeStartFrame('m4', 'aabb', 2));
      // Skip sequence 0, send 1 directly.
      simulateMessage(mock, makeChunk('m4', 1, 'bb', true));
      // Advance well under the 30s heartbeat so interval doesn't loop, but
      // long enough to flush the async completeChunkedRelay microtask chain.
      await vi.advanceTimersByTimeAsync(100);

      const acks = getSentMessages(mock).filter(
        (m) => (m as { type: string }).type === 'webhook.ack',
      );
      expect(acks).toHaveLength(1);
      expect(acks[0]).toMatchObject({
        type: 'webhook.ack',
        messageId: 'm4',
        result: 'rejected_misconfigured',
      });
      expect(onVerifyInbound).not.toHaveBeenCalled();
      expect(onWebhookRelay).not.toHaveBeenCalled();
    });

    it('ACKs rejected_misconfigured when chunk delivers more bytes than declared totalSize', async () => {
      // Declared totalSize=4 with chunkCount=2 but final chunk overflows.
      // (Schema-layer cap >25 MiB is exercised by the schema unit tests; this
      // test covers the orch-side defensive runtime check.)
      const client = createClient({
        onVerifyInbound: vi.fn().mockResolvedValue({ result: 'accepted' as const }),
      });
      const mock = authenticateClient(client);

      simulateMessage(mock, {
        ...makeStartFrame('m-overflow', 'aabb', 2),
        // Lie about totalSize -- chunks will deliver 6 bytes, declared 4.
        totalSize: 4,
      });
      simulateMessage(mock, makeChunk('m-overflow', 0, 'aa', false));
      simulateMessage(mock, makeChunk('m-overflow', 1, 'bbbb', true));
      await vi.advanceTimersByTimeAsync(100);

      const acks = getSentMessages(mock).filter(
        (m) => (m as { type: string }).type === 'webhook.ack',
      );
      expect(acks).toHaveLength(1);
      expect(acks[0]).toMatchObject({
        type: 'webhook.ack',
        messageId: 'm-overflow',
        result: 'rejected_misconfigured',
      });
    });

    it('ACKs rejected_misconfigured when an accepted body is not valid JSON', async () => {
      const onWebhookRelay = vi.fn().mockResolvedValue(undefined);
      const onVerifyInbound = vi.fn().mockResolvedValue({ result: 'accepted' as const });
      const client = createClient({ onWebhookRelay, onVerifyInbound });
      const mock = authenticateClient(client);

      simulateMessage(mock, makeStartFrame('m5', 'not-json', 1));
      simulateMessage(mock, makeChunk('m5', 0, 'not-json', true));
      // Advance well under the 30s heartbeat so interval doesn't loop, but
      // long enough to flush the async completeChunkedRelay microtask chain.
      await vi.advanceTimersByTimeAsync(100);

      const acks = getSentMessages(mock).filter(
        (m) => (m as { type: string }).type === 'webhook.ack',
      );
      expect(acks).toHaveLength(1);
      expect(acks[0]).toMatchObject({
        type: 'webhook.ack',
        messageId: 'm5',
        result: 'rejected_misconfigured',
        reason: 'webhook body is not valid JSON',
      });
      expect(onWebhookRelay).not.toHaveBeenCalled();
    });

    it('wraps non-JSON bodies as { rawBody, contentType } when content-type is not JSON', async () => {
      const onWebhookRelay = vi.fn().mockResolvedValue(undefined);
      const onVerifyInbound = vi.fn().mockResolvedValue({ result: 'accepted' as const });
      const client = createClient({ onWebhookRelay, onVerifyInbound });
      const mock = authenticateClient(client);

      const body = 'plain text payload';
      const start = {
        ...makeStartFrame('m-rawbody', body, 1),
        headers: { 'content-type': 'text/plain' },
      };
      simulateMessage(mock, start);
      simulateMessage(mock, makeChunk('m-rawbody', 0, body, true));

      await vi.advanceTimersByTimeAsync(100);

      expect(onWebhookRelay).toHaveBeenCalledTimes(1);
      const relay = onWebhookRelay.mock.calls[0]![0] as { payload: unknown };
      expect(relay.payload).toEqual({ rawBody: body, contentType: 'text/plain' });
    });

    it('ACKs rejected_misconfigured when no onVerifyInbound is wired', async () => {
      // No onVerifyInbound supplied.
      const client = createClient();
      const mock = authenticateClient(client);

      simulateMessage(mock, makeStartFrame('m6', '{}', 1));
      simulateMessage(mock, makeChunk('m6', 0, '{}', true));
      // Advance well under the 30s heartbeat so interval doesn't loop, but
      // long enough to flush the async completeChunkedRelay microtask chain.
      await vi.advanceTimersByTimeAsync(100);

      const acks = getSentMessages(mock).filter(
        (m) => (m as { type: string }).type === 'webhook.ack',
      );
      expect(acks).toHaveLength(1);
      expect(acks[0]).toMatchObject({
        type: 'webhook.ack',
        result: 'rejected_misconfigured',
        reason: 'orchestrator has no verifyInbound handler wired',
      });
    });
  });

  // ── TLS chain trust (intentional non-implementation, accepted-risk) ─
  //
  // Decision (2026-04-28): ACCEPTED RISK. The finding
  // (`tls-chain-trust-orch-platform`, HIGH) was closed as `accepted-risk`
  // rather than fixed via orch-side CA pinning. Rationale recorded in the
  // handover at `
  // isolation.md` (finding entry + chosen-mitigation bullet).
  //
  // Summary of the rejection: the threat (orch→Platform MITM with a
  // misissued leaf cert) requires extraordinary co-prerequisites — DNS/BGP
  // hijack of the Platform hostname AND a leaf cert for that hostname signed
  // by ANY system-trusted CA (e.g. ACME-DV via the same DNS hijack, coerced/
  // rogue public CA, customer-installed enterprise root). The bug is also a
  // single-tenant cred-theft enabler, not a customer-isolation breach (the
  // catalog's framing scope). Pinning only the orch leg leaves the dashboard,
  // `kici` developer CLI, `kici-admin` CLI, and provider-outbound legs on
  // system PKI, so a capable attacker just shifts to the weakest leg.
  // The chosen mitigation lives at the DNS layer instead (CAA record on
  // `kici.dev` restricting issuance to Let's Encrypt + HSTS-preload on
  // the Platform hostname) — which closes the misissuance vector for ALL
  // legs at once with ~zero recurring cost.
  //
  // The `it.fails` below is retained as a tripwire: today no `ca:` /
  // `checkServerIdentity:` / `agent:` is passed to the WebSocket constructor,
  // so the assertion fails and `it.fails` flips it green. If a future change
  // introduces any of those options (intentionally re-enabling pinning),
  // `it.fails` flips to red and forces a review of the accepted-risk
  // decision.
  describe('TLS chain trust (intentional non-implementation, accepted-risk)', () => {
    it.fails('orch lacks Platform CA pin — accepted-risk (2026-04-28)', () => {
      const client = createClient({ url: 'wss://platform.example.com/ws' });
      client.connect();

      // Inspect the options object passed to `new WebSocket(url, options)`.
      // The pin can be expressed in any of three accepted shapes:
      //   - `ca: <Buffer | string | (Buffer|string)[]>` — explicit CA bundle
      //   - `checkServerIdentity: <function>` — custom leaf verifier (e.g. SPKI pin)
      //   - `agent: <https.Agent>` carrying its own pinned roots
      // If the connect path adopts any of these, this assertion passes.
      const args = mockConstructorArgs[mockConstructorArgs.length - 1];
      expect(args).toBeDefined();
      const options = args![1] as Record<string, unknown> | undefined;
      expect(options).toBeDefined();

      const hasPin =
        options !== undefined &&
        ('ca' in options || 'checkServerIdentity' in options || 'agent' in options);

      expect(hasPin).toBe(true);
    });
  });

  // ── `permessage-deflate` compression bomb defense (security invariant) ──
  //
  // Invariant: every WS endpoint that negotiates `permessage-deflate`
  // MUST cap the maximum decompressed message size via `maxPayload`.
  // Client-side too: a rogue Platform impostor (a successful MITM with
  // a misissued cert) could otherwise blow up the orchestrator's RAM
  // with a single compressed frame that decompresses to ~100 MiB
  // (ws@8.x default maxPayload). The cap must be configured before
  // `auth.request` is sent so a hostile pre-auth peer cannot exhaust
  // resources before identity is established.
  //
  // Asserts the EXACT configured value (positive control, not just a ceiling)
  // so any regression that changes `maxPayload` is loud.
  describe('compression bomb defense (security invariant)', () => {
    it('caps maxPayload on the WebSocket constructor (= WS_MAX_PAYLOAD_BYTES)', () => {
      const client = createClient({ url: 'wss://platform.example.com/ws' });
      client.connect();

      const args = mockConstructorArgs[mockConstructorArgs.length - 1];
      expect(args).toBeDefined();
      const options = args![1] as Record<string, unknown> | undefined;
      expect(options).toBeDefined();

      expect(options!['maxPayload']).toBe(WS_MAX_PAYLOAD_BYTES);
    });
  });

  // ── Legacy single-frame `webhook.relay` MUST NOT bypass on-orch HMAC ──
  //
  // Invariant (per the pentest catalog at
  // the post-`012_drop_webhook_secret_columns` design makes the orchestrator's
  // `onVerifyInbound` (HMAC against pgSecretStore) the sole trust boundary
  // against a rogue Platform (A9) or compromised Platform credential (A10) —
  // Platform "never verifies webhook signatures and never stores customer
  // signing material". Every Platform→Orch path that reaches `processWebhook`
  // MUST therefore have passed `onVerifyInbound`.
  //
  // Enforcement: `webhookRelaySchema` is intentionally NOT a member of
  // `platformToOrchestratorMessageSchema`, so a forged single-frame
  // `{type:'webhook.relay', payload, ...}` from Platform fails Zod parse and
  // falls through `handleNonStandardMessage` (which only matches log-pull
  // and join-request), where it is logged and dropped. The chunked path
  // `webhook.relay.start` + `webhook.relay.chunk` is the sole legitimate
  // route from Platform to `onWebhookRelay`, and it goes through
  // `onVerifyInbound` first.
  describe('legacy single-frame webhook.relay HMAC bypass (security invariant)', () => {
    it('single-frame webhook.relay MUST NOT reach onWebhookRelay (HMAC bypass closed)', async () => {
      const onRelay = vi.fn().mockResolvedValue(undefined);
      const onVerify = vi.fn();
      const client = createClient({
        onWebhookRelay: onRelay,
        onVerifyInbound: onVerify,
      });
      authenticateClient(client);

      const mock = getLatestMock();
      // Forge a single-frame webhook.relay as a rogue Platform (A9/A10)
      // would. Payload is shaped to look like a GitHub push event so that,
      // post-dispatch, processWebhook would run trigger match against a
      // lock file and fan a job out to an agent — i.e. arbitrary workflow
      // code execution under the tenant's secrets.
      simulateMessage(mock, {
        type: 'webhook.relay',
        messageId: 'forged-1',
        routingKey: 'github:42',
        deliveryId: 'forged-del-1',
        event: 'push',
        action: null,
        payload: { ref: 'refs/heads/main', after: 'deadbeef' },
      });

      await vi.advanceTimersByTimeAsync(0);

      // Invariant: forged single-frame webhook.relay must not reach the
      // dispatcher pipeline. The Zod union no longer includes
      // `webhookRelaySchema`, so the parse fails and the message is dropped
      // without ever calling `onVerifyInbound` or `onWebhookRelay`.
      expect(onRelay).not.toHaveBeenCalled();
      expect(onVerify).not.toHaveBeenCalled();
    });
  });

  // ── `trust_policy.update` orch-side trust model (security invariant) ──
  //
  // Pentest catalog at
  // — Platform→Orchestrator dispatch surface under attacker model A10
  // (compromised Platform credential / rogue Platform process). The Platform
  // pushes `trust_policy.update` carrying `identityLinks` + `memberCiTrustLevels`
  // (consumed by `server.ts:798 onTrustPolicyUpdate` to update orchestrator
  // in-memory state) and `policy.{forkPolicy,unknownContributorPolicy,
  // workflowChangePolicy,approvalExpiryHours}` (received but DROPPED).
  //
  // The wire-side invariant pinned here: the message reaches
  // `onTrustPolicyUpdate` AS-IS. The orchestrator is then free to consume or
  // drop fields per the server.ts callback. The defense-in-depth invariant
  // (Platform-supplied data alone cannot fake `tier='trusted'`) is pinned in
  // `packages/orchestrator/src/security/trust-resolver.test.ts`.
  describe('trust_policy.update — wire dispatch surface (security invariant)', () => {
    it('full trust_policy.update message — including unused policy.* fields — is forwarded to onTrustPolicyUpdate as-is', async () => {
      const onTrustPolicyUpdate = vi.fn();
      const client = createClient({ onTrustPolicyUpdate });
      const mock = authenticateClient(client);

      // A rogue Platform (A10) pushes a maximally-permissive policy plus
      // forged identityLinks + admin ci_trust for an attacker. The wire
      // dispatcher just forwards; the orchestrator's onTrustPolicyUpdate
      // callback at server.ts:798 reads only identityLinks +
      // memberCiTrustLevels and drops policy.* fields. The defense-in-depth
      // protections live downstream in trust-resolver.ts (provider API gate)
      // and dispatch-matched-workflow.ts (per-environment minimumTrust).
      simulateMessage(mock, {
        type: 'trust_policy.update',
        orgId: 'org-1',
        policy: {
          forkPolicy: 'allow',
          unknownContributorPolicy: 'hold',
          workflowChangePolicy: 'allow',
          approvalExpiryHours: 1,
        },
        identityLinks: [
          {
            userId: 'forged-user',
            provider: 'github',
            providerUsername: 'attacker',
            providerUserId: '99999',
          },
        ],
        memberCiTrustLevels: { 'forged-user': 'admin' },
        teamMemberships: [{ teamName: 'leads', memberUserIds: ['u-1', 'u-2'] }],
      });

      expect(onTrustPolicyUpdate).toHaveBeenCalledOnce();
      const arg = onTrustPolicyUpdate.mock.calls[0][0];
      expect(arg.orgId).toBe('org-1');
      expect(arg.teamMemberships).toEqual([{ teamName: 'leads', memberUserIds: ['u-1', 'u-2'] }]);
      // policy.* fields ARE present on the wire — the orchestrator's
      // server.ts callback chooses to drop them. This test pins the wire
      // shape so a future schema-narrowing refactor that intentionally
      // drops policy.* from the schema (and thus the type-system) is a
      // visible breaking change.
      expect(arg.policy.forkPolicy).toBe('allow');
      expect(arg.policy.workflowChangePolicy).toBe('allow');
      expect(arg.identityLinks).toHaveLength(1);
      expect(arg.identityLinks[0].userId).toBe('forged-user');
      expect(arg.memberCiTrustLevels['forged-user']).toBe('admin');
    });
  });
});
