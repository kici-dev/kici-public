import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createAgentWsHandler,
  truncateCloseReason,
  type AgentWsHandlerDeps,
} from './agent-handler.js';
import { AgentRegistry } from '../agent/registry.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import type { AgentTokenStore } from '../agent/token-store.js';
import { OwnershipTracker } from '../agent/ownership-tracker.js';
import {
  WS_CLOSE_AUTH_TIMEOUT,
  WS_CLOSE_INVALID_MESSAGE,
  WS_CLOSE_AGENT_AUTH_FAILED,
  PRIVILEGED_ROOT_LABEL,
} from '@kici-dev/engine';
import { mockWs } from '../__test-helpers__/mock-ws.js';
import { DispatchCacheRefTracker } from '../cache/dispatch-cache-ref-tracker.js';
import type { UserCache } from '../cache/user-cache.js';
import { CacheRefScope } from '@kici-dev/engine';

/** Create a mock Dispatcher with controllable methods. */
function mockDispatcher(): Dispatcher {
  return {
    dispatch: vi.fn().mockResolvedValue({ status: 'queued', jobId: 'test' }),
    onAgentAvailable: vi.fn().mockResolvedValue(undefined),
    onAgentDisconnect: vi.fn().mockResolvedValue(undefined),
    onJobComplete: vi.fn(),
    markJobStarted: vi.fn(),
    onJobRejected: vi.fn().mockResolvedValue(undefined),
    releaseRebootPending: vi.fn().mockResolvedValue(undefined),
  } as unknown as Dispatcher;
}

/** Create a mock AgentTokenStore. */
function mockTokenStore(
  overrides: Partial<{
    validate: ReturnType<typeof vi.fn>;
    createEphemeral: ReturnType<typeof vi.fn>;
    cleanupExpired: ReturnType<typeof vi.fn>;
  }> = {},
): AgentTokenStore {
  return {
    validate:
      overrides.validate ??
      vi.fn().mockResolvedValue({
        id: 'tok-1',
        token_prefix: 'kat_abcd1234',
        labels: null,
        mandatory_labels: null,
        agent_type: 'static',
        created_at: new Date(),
        last_seen_at: null,
        created_by: null,
        revoked_at: null,
        expires_at: null,
      }),
    createEphemeral: overrides.createEphemeral ?? vi.fn(),
    createStatic: vi.fn(),
    revoke: vi.fn(),
    list: vi.fn(),
    cleanupExpired: overrides.cleanupExpired ?? vi.fn(),
  } as unknown as AgentTokenStore;
}

/** Create a MessageEvent-like object for testing. */
function makeMessageEvent(data: unknown): MessageEvent {
  return { data: JSON.stringify(data) } as MessageEvent;
}

/** Create a well-formed agent.register message. */
function registerMsg(overrides: Partial<{ agentId: string; labels: string[] }> = {}) {
  return {
    type: 'agent.register' as const,
    messageId: 'msg-1',
    agentId: overrides.agentId ?? 'agent-1',
    labels: overrides.labels ?? ['linux', 'docker'],
  };
}

/** Create an auth.request message. */
function authRequestMsg(token = 'kat_' + 'a'.repeat(64)) {
  return {
    type: 'auth.request' as const,
    token,
    protocolVersion: 1,
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe('createAgentWsHandler', () => {
  let registry: AgentRegistry;
  let dispatcher: Dispatcher;
  let onJobStatus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new AgentRegistry();
    dispatcher = mockDispatcher();
    onJobStatus = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Unauthenticated mode (agentAuthMode='none') ──────────────

  describe('unauthenticated mode (agentAuthMode=none)', () => {
    function createHandler(extraDeps: Partial<AgentWsHandlerDeps> = {}) {
      return createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
        ...extraDeps,
      });
    }

    it('registers agent in registry and calls onAgentAvailable', async () => {
      const handler = createHandler();
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      const entry = registry.get('agent-1');
      expect(entry).toBeDefined();
      expect(entry!.agentId).toBe('agent-1');
      expect(entry!.labels).toEqual(new Set(['linux', 'docker']));
      expect(dispatcher.onAgentAvailable).toHaveBeenCalledWith('agent-1');
    });

    it('passes runningAsUser and runningAsUid to registry on initial registration', async () => {
      const handler = createHandler();
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(
        makeMessageEvent({
          ...registerMsg({ agentId: 'agent-uid' }),
          runningAsUser: 'ci-runner',
          runningAsUid: 1001,
        }),
        ws as any,
      );

      const entry = registry.get('agent-uid');
      expect(entry).toBeDefined();
      expect(entry!.runningAsUser).toBe('ci-runner');
      expect(entry!.runningAsUid).toBe(1001);
    });

    it('stores agentId on WS context for disconnect handling', async () => {
      const handler = createHandler();
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      handler.onClose!(new CloseEvent('close'), ws as any);
      expect(dispatcher.onAgentDisconnect).toHaveBeenCalledWith('agent-1');
    });

    it('closes connection if no register within 10s', async () => {
      const handler = createHandler();
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      vi.advanceTimersByTime(10_000);

      expect(ws.close).toHaveBeenCalledWith(WS_CLOSE_AUTH_TIMEOUT, 'Registration timeout');
    });

    it('does not close if register arrives within timeout', async () => {
      const handler = createHandler();
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      vi.advanceTimersByTime(10_000);
      expect(ws.close).not.toHaveBeenCalled();
    });

    it('rejects non-register first message', async () => {
      const handler = createHandler();
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(
        makeMessageEvent({ type: 'heartbeat', timestamp: Date.now() }),
        ws as any,
      );

      expect(ws.close).toHaveBeenCalledWith(
        WS_CLOSE_INVALID_MESSAGE,
        'First message must be agent.register',
      );
    });

    it('sends register.ack after registration', async () => {
      const handler = createHandler();
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(
        makeMessageEvent(registerMsg({ agentId: 'agent-ack', labels: ['linux'] })),
        ws as any,
      );

      const sentCalls = (ws.send as ReturnType<typeof vi.fn>).mock.calls;
      const ackMsg = sentCalls
        .map((call: unknown[]) => JSON.parse(call[0] as string))
        .find((m: Record<string, unknown>) => m.type === 'register.ack');

      expect(ackMsg).toEqual({
        type: 'register.ack',
        agentId: 'agent-ack',
        labels: ['linux'],
        scalerManaged: false,
      });
    });
  });

  // ── Authenticated mode (agentAuthMode='token') ────────────────

  describe('authenticated mode (agentAuthMode=token)', () => {
    function createHandler(extraDeps: Partial<AgentWsHandlerDeps> = {}) {
      return createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'token',
        tokenStore: mockTokenStore(),
        onJobStatus,
        ...extraDeps,
      });
    }

    it('happy path: auth.request -> auth.success -> agent.register -> register.ack', async () => {
      const handler = createHandler();
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);

      // Send auth.request
      await handler.onMessage!(makeMessageEvent(authRequestMsg()), ws as any);

      // Check auth.success was sent
      const sentAfterAuth = (ws.send as ReturnType<typeof vi.fn>).mock.calls;
      const authSuccess = sentAfterAuth
        .map((call: unknown[]) => JSON.parse(call[0] as string))
        .find((m: Record<string, unknown>) => m.type === 'auth.success');
      expect(authSuccess).toBeDefined();
      expect(authSuccess!.connectionId).toBeDefined();

      // Send agent.register
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      // Check agent is registered
      const entry = registry.get('agent-1');
      expect(entry).toBeDefined();

      // Check register.ack was sent
      const sentAfterReg = (ws.send as ReturnType<typeof vi.fn>).mock.calls;
      const registerAck = sentAfterReg
        .map((call: unknown[]) => JSON.parse(call[0] as string))
        .find((m: Record<string, unknown>) => m.type === 'register.ack');
      expect(registerAck).toBeDefined();
      expect(registerAck!.agentId).toBe('agent-1');
    });

    // ── Privileged-root taint (token mandatory_labels) ──────────

    /** A validated token row carrying authorized labels + a taint set. */
    function privilegedRootTokenRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'tok-root',
        token_prefix: 'kat_root0000',
        labels: JSON.stringify(['linux', PRIVILEGED_ROOT_LABEL]),
        mandatory_labels: JSON.stringify([PRIVILEGED_ROOT_LABEL]),
        agent_type: 'static',
        created_at: new Date(),
        last_seen_at: null,
        created_by: 'cli:admin',
        revoked_at: null,
        expires_at: null,
        ...overrides,
      };
    }

    /** Drive auth.request -> agent.register with a custom register payload. */
    async function authAndRegister(
      tokenRow: Record<string, unknown>,
      register: { agentId: string; labels: string[]; runningAsUid?: number },
    ) {
      const ts = mockTokenStore({ validate: vi.fn().mockResolvedValue(tokenRow) });
      const handler = createHandler({ tokenStore: ts });
      const ws = mockWs();
      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(authRequestMsg()), ws as any);
      await handler.onMessage!(
        makeMessageEvent({
          type: 'agent.register',
          messageId: 'reg-1',
          agentId: register.agentId,
          labels: register.labels,
          ...(register.runningAsUid !== undefined ? { runningAsUid: register.runningAsUid } : {}),
        }),
        ws as any,
      );
      return ws;
    }

    it('static agent inherits token mandatory_labels and is confined by the taint', async () => {
      await authAndRegister(privilegedRootTokenRow(), {
        agentId: 'agent-root',
        labels: ['linux', PRIVILEGED_ROOT_LABEL],
        runningAsUid: 0,
      });

      const entry = registry.get('agent-root');
      expect(entry).toBeDefined();
      expect([...entry!.mandatoryLabels]).toEqual([PRIVILEGED_ROOT_LABEL]);

      // A plain job (no privileged:root) must NOT match the tainted agent.
      expect(registry.findAvailable(['linux']).map((e) => e.agentId)).not.toContain('agent-root');
      // A root-demanding job MUST match it.
      expect(
        registry.findAvailable(['linux', PRIVILEGED_ROOT_LABEL]).map((e) => e.agentId),
      ).toContain('agent-root');
    });

    it('accepts a privileged-root agent running as root (uid 0)', async () => {
      await authAndRegister(privilegedRootTokenRow(), {
        agentId: 'agent-root',
        labels: ['linux', PRIVILEGED_ROOT_LABEL],
        runningAsUid: 0,
      });
      expect(registry.get('agent-root')).toBeDefined();
    });

    it('rejects a privileged-root token presented by a non-root agent (uid != 0)', async () => {
      const ws = await authAndRegister(privilegedRootTokenRow(), {
        agentId: 'agent-root',
        labels: ['linux', PRIVILEGED_ROOT_LABEL],
        runningAsUid: 1000,
      });
      expect(registry.get('agent-root')).toBeUndefined();
      const close = (ws.close as ReturnType<typeof vi.fn>).mock.calls.at(-1);
      expect(close?.[0]).toBe(WS_CLOSE_AGENT_AUTH_FAILED);
      expect(String(close?.[1])).toMatch(/privileged-root.*non-root|uid/i);
    });

    it('rejects a privileged-root claim when uid is absent (cannot verify)', async () => {
      const ws = await authAndRegister(privilegedRootTokenRow(), {
        agentId: 'agent-root',
        labels: ['linux', PRIVILEGED_ROOT_LABEL],
        // no runningAsUid
      });
      expect(registry.get('agent-root')).toBeUndefined();
      const close = (ws.close as ReturnType<typeof vi.fn>).mock.calls.at(-1);
      expect(close?.[0]).toBe(WS_CLOSE_AGENT_AUTH_FAILED);
    });

    it('rejects a privileged-root advertised label by a non-root agent even without a taint', async () => {
      // The honesty gate keys off the advertised label too: an agent that
      // advertises kici:privileged:root (authorized by a token that lists it as
      // a label but mints no taint) must still be uid 0.
      const ws = await authAndRegister(privilegedRootTokenRow({ mandatory_labels: null }), {
        agentId: 'agent-root',
        labels: ['linux', PRIVILEGED_ROOT_LABEL],
        runningAsUid: 1000,
      });
      expect(registry.get('agent-root')).toBeUndefined();
      const close = (ws.close as ReturnType<typeof vi.fn>).mock.calls.at(-1);
      expect(close?.[0]).toBe(WS_CLOSE_AGENT_AUTH_FAILED);
    });

    it('rejects invalid token -> auth.failure + WS close 4010', async () => {
      const ts = mockTokenStore({ validate: vi.fn().mockResolvedValue(null) });
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'token',
        tokenStore: ts,
        onJobStatus,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(authRequestMsg('kat_bad_token')), ws as any);

      const sentCalls = (ws.send as ReturnType<typeof vi.fn>).mock.calls;
      const authFailure = sentCalls
        .map((call: unknown[]) => JSON.parse(call[0] as string))
        .find((m: Record<string, unknown>) => m.type === 'auth.failure');
      expect(authFailure).toBeDefined();
      expect(authFailure!.reason).toContain('Invalid or expired token');
      expect(ws.close).toHaveBeenCalledWith(WS_CLOSE_AGENT_AUTH_FAILED, 'Authentication failed');
    });

    it('auth timeout (no auth.request within 5s) -> WS close 4002', async () => {
      const handler = createHandler();
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      vi.advanceTimersByTime(5_000);

      expect(ws.close).toHaveBeenCalledWith(WS_CLOSE_AUTH_TIMEOUT, 'Auth timeout');
    });

    it('agent.register without prior auth.request (when auth enabled) -> rejected', async () => {
      const handler = createHandler();
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);

      // Send agent.register directly (should fail because auth.request is expected)
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      // Should be rejected because auth.request was not received first
      const sentCalls = (ws.send as ReturnType<typeof vi.fn>).mock.calls;
      const authFailure = sentCalls
        .map((call: unknown[]) => JSON.parse(call[0] as string))
        .find((m: Record<string, unknown>) => m.type === 'auth.failure');
      expect(authFailure).toBeDefined();
      expect(ws.close).toHaveBeenCalledWith(WS_CLOSE_AGENT_AUTH_FAILED, 'Invalid auth message');
    });

    it('agentId collision (different token) -> rejected', async () => {
      const ts = mockTokenStore();
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'token',
        tokenStore: ts,
        onJobStatus,
      });

      // First agent registers successfully
      const ws1 = mockWs();
      handler.onOpen!(new Event('open'), ws1 as any);
      await handler.onMessage!(makeMessageEvent(authRequestMsg()), ws1 as any);
      await handler.onMessage!(makeMessageEvent(registerMsg({ agentId: 'agent-1' })), ws1 as any);
      expect(registry.get('agent-1')).toBeDefined();

      // Second agent tries to register with same agentId but different tokenId
      (ts.validate as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'tok-2', // Different token ID
        token_prefix: 'kat_bbbb2222',
        labels: null,
        agent_type: 'static',
        created_at: new Date(),
        last_seen_at: null,
        created_by: null,
        revoked_at: null,
        expires_at: null,
      });

      const ws2 = mockWs();
      handler.onOpen!(new Event('open'), ws2 as any);
      await handler.onMessage!(makeMessageEvent(authRequestMsg('kat_different')), ws2 as any);
      await handler.onMessage!(makeMessageEvent(registerMsg({ agentId: 'agent-1' })), ws2 as any);

      expect(ws2.close).toHaveBeenCalledWith(
        WS_CLOSE_INVALID_MESSAGE,
        'AgentId already registered with a different token',
      );
    });

    it('agentId reconnection (same token) -> WS reference replaced', async () => {
      const ts = mockTokenStore();
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'token',
        tokenStore: ts,
        onJobStatus,
      });

      // First connection
      const ws1 = mockWs();
      handler.onOpen!(new Event('open'), ws1 as any);
      await handler.onMessage!(makeMessageEvent(authRequestMsg()), ws1 as any);
      await handler.onMessage!(makeMessageEvent(registerMsg({ agentId: 'agent-1' })), ws1 as any);
      expect(registry.get('agent-1')).toBeDefined();

      // Same agent reconnects with same token (same tokenId 'tok-1')
      const ws2 = mockWs();
      handler.onOpen!(new Event('open'), ws2 as any);
      await handler.onMessage!(makeMessageEvent(authRequestMsg()), ws2 as any);
      await handler.onMessage!(makeMessageEvent(registerMsg({ agentId: 'agent-1' })), ws2 as any);

      // Should succeed -- WS reference replaced
      expect(ws2.close).not.toHaveBeenCalled();
      expect(registry.get('agent-1')).toBeDefined();
    });

    it('disconnect during pendingAuth cleans up', () => {
      const handler = createHandler();
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      handler.onClose!(new CloseEvent('close'), ws as any);

      // Should not call dispatcher
      expect(dispatcher.onAgentDisconnect).not.toHaveBeenCalled();
    });

    it('disconnect during pendingRegistration cleans up', async () => {
      const handler = createHandler();
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(authRequestMsg()), ws as any);
      handler.onClose!(new CloseEvent('close'), ws as any);

      // Should not call dispatcher
      expect(dispatcher.onAgentDisconnect).not.toHaveBeenCalled();
    });
  });

  // ── Common behavior tests (shared across both modes) ──────────

  describe('agent.status', () => {
    it('does not clobber the authoritative registry count from the self-report', async () => {
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      const entry = registry.get('agent-1')!;
      // Registry says the agent is busy (a dispatch is in flight). A stale
      // self-report of 0 must NOT re-open the slot.
      entry.activeJobs = 1;

      await handler.onMessage!(
        makeMessageEvent({
          type: 'agent.status',
          messageId: 'msg-2',
          agentId: 'agent-1',
          activeJobs: 0,
        }),
        ws as any,
      );

      // Registry count is authoritative — unchanged by the self-report.
      expect(entry.activeJobs).toBe(1);
      // No spare capacity (1/1), so no drain beyond the register-time one.
      expect(dispatcher.onAgentAvailable).toHaveBeenCalledTimes(1);
    });

    it('triggers a queue drain whenever the registry shows spare capacity', async () => {
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      const entry = registry.get('agent-1')!;
      entry.activeJobs = 0;

      await handler.onMessage!(
        makeMessageEvent({
          type: 'agent.status',
          messageId: 'msg-2',
          agentId: 'agent-1',
          activeJobs: 1,
        }),
        ws as any,
      );

      // Registry shows capacity (0/1), so the drain fires again (idempotent).
      expect(dispatcher.onAgentAvailable).toHaveBeenCalledTimes(2);
    });
  });

  describe('job.status with success', () => {
    it('decrements activeJobs and triggers queue drain', async () => {
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      await handler.onMessage!(
        makeMessageEvent({
          type: 'job.status',
          messageId: 'msg-3',
          runId: 'run-1',
          jobId: 'job-1',
          state: 'success',
          timestamp: Date.now(),
        }),
        ws as any,
      );

      expect(dispatcher.onJobComplete).toHaveBeenCalledWith('agent-1', 'job-1');
      expect(dispatcher.onAgentAvailable).toHaveBeenCalledTimes(2);
    });
  });

  describe('job.status with failed', () => {
    it('decrements activeJobs and forwards to Platform', async () => {
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      const timestamp = Date.now();

      await handler.onMessage!(
        makeMessageEvent({
          type: 'job.status',
          messageId: 'msg-4',
          runId: 'run-2',
          jobId: 'job-2',
          state: 'failed',
          timestamp,
          data: { error: 'Build failed' },
        }),
        ws as any,
      );

      expect(dispatcher.onJobComplete).toHaveBeenCalledWith('agent-1', 'job-2');
      expect(onJobStatus).toHaveBeenCalledWith('agent-1', {
        runId: 'run-2',
        jobId: 'job-2',
        state: 'failed',
        timestamp,
        data: { error: 'Build failed' },
      });
    });
  });

  describe('heartbeat', () => {
    it('updates registry timestamp', async () => {
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      const beforeHeartbeat = registry.get('agent-1')!.lastHeartbeatAt;
      vi.advanceTimersByTime(5000);

      await handler.onMessage!(
        makeMessageEvent({ type: 'heartbeat', timestamp: Date.now() }),
        ws as any,
      );

      const afterHeartbeat = registry.get('agent-1')!.lastHeartbeatAt;
      expect(afterHeartbeat).toBeGreaterThanOrEqual(beforeHeartbeat);
    });
  });

  describe('provenance.upload.complete', () => {
    it('initializes the bundle metadata sidecar before recording the attestation', async () => {
      // The agent uploads the bundle via a presigned PUT (data object only).
      // CacheStorage.get is metadata-gated, so the handler MUST write the
      // metadata sidecar via initMeta(key) before the dashboard read can inline
      // the bundle — otherwise the P1.7 attestations API reads it back as
      // missing and returns an empty list despite a recorded DB row.
      const dispatchCacheRefs = new DispatchCacheRefTracker();
      dispatchCacheRefs.record('job-prov', { runId: 'run-prov' });

      const initMeta = vi.fn().mockResolvedValue(undefined);
      const provenanceStorage = { initMeta } as unknown as AgentWsHandlerDeps['provenanceStorage'];

      const recordedKeys: string[] = [];
      const onProvenanceUpload = vi.fn(async (record: { storageKey: string }) => {
        // initMeta must already have run by the time the DB row is recorded.
        expect(initMeta).toHaveBeenCalledTimes(1);
        recordedKeys.push(record.storageKey);
      });

      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        dispatchCacheRefs,
        provenanceStorage,
        onProvenanceUpload,
      });
      const ws = mockWs();
      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      await handler.onMessage!(
        makeMessageEvent({
          type: 'provenance.upload.complete',
          messageId: 'msg-prov',
          jobId: 'job-prov',
          subjectName: 'artifact.bin',
          subjectDigest: 'a'.repeat(64),
          mediaType: 'application/vnd.kici.provenance.bundle+json;version=0.1',
        }),
        ws as any,
      );

      const expectedKey = `provenance/run-prov/job-prov/${'a'.repeat(64)}.kici.json`;
      expect(initMeta).toHaveBeenCalledWith(expectedKey);
      expect(onProvenanceUpload).toHaveBeenCalledTimes(1);
      expect(recordedKeys).toEqual([expectedKey]);
    });
  });

  describe('invalid message', () => {
    it('logs warning and closes connection for malformed JSON', async () => {
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      await handler.onMessage!({ data: 'not json {{{' } as MessageEvent, ws as any);
      expect(ws.close).toHaveBeenCalledWith(WS_CLOSE_INVALID_MESSAGE, 'Malformed JSON');
    });

    it('closes connection for invalid message format after registration', async () => {
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      await handler.onMessage!(makeMessageEvent({ type: 'unknown.type', foo: 'bar' }), ws as any);
      expect(ws.close).toHaveBeenCalledWith(WS_CLOSE_INVALID_MESSAGE, 'Invalid message');
    });
  });

  describe('disconnect', () => {
    it('calls onAgentDisconnect and unregisters', async () => {
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      expect(registry.get('agent-1')).toBeDefined();
      handler.onClose!(new CloseEvent('close'), ws as any);
      expect(dispatcher.onAgentDisconnect).toHaveBeenCalledWith('agent-1');
    });

    it('handles disconnect before registration (pending state)', async () => {
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      handler.onClose!(new CloseEvent('close'), ws as any);

      expect(dispatcher.onAgentDisconnect).not.toHaveBeenCalled();
    });

    it('cleans up pendingBuilds, pendingInits, and pendingDynamics on disconnect', async () => {
      const failedJobIds = ['job-1', 'job-2', 'job-3'];
      const disconnectDispatcher = {
        ...dispatcher,
        onAgentDisconnect: vi.fn().mockResolvedValue(failedJobIds),
      } as unknown as Dispatcher;

      const pendingBuilds = { cleanup: vi.fn() };
      const pendingInits = { cleanup: vi.fn() };
      const pendingDynamics = { cleanup: vi.fn() };

      const handler = createAgentWsHandler({
        registry,
        dispatcher: disconnectDispatcher,
        agentAuthMode: 'none',
        onJobStatus,
        pendingBuilds: pendingBuilds as any,
        pendingInits: pendingInits as any,
        pendingDynamics: pendingDynamics as any,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);
      handler.onClose!(new CloseEvent('close'), ws as any);

      // Wait for the async onAgentDisconnect to resolve
      await vi.waitFor(() => {
        expect(disconnectDispatcher.onAgentDisconnect).toHaveBeenCalledWith('agent-1');
      });

      // All three trackers should be cleaned up for each failed job
      for (const jobId of failedJobIds) {
        expect(pendingBuilds.cleanup).toHaveBeenCalledWith(jobId);
        expect(pendingInits.cleanup).toHaveBeenCalledWith(jobId);
        expect(pendingDynamics.cleanup).toHaveBeenCalledWith(jobId);
      }
    });
  });

  describe('scaler lifecycle callbacks', () => {
    it('calls onScalerAgentRegistered on registration', async () => {
      const onScalerAgentRegistered = vi.fn();
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
        onScalerAgentRegistered,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(
        makeMessageEvent(registerMsg({ agentId: 'scaler-agent-1', labels: ['linux', 'docker'] })),
        ws as any,
      );

      expect(onScalerAgentRegistered).toHaveBeenCalledWith('scaler-agent-1', ['linux', 'docker']);
    });

    it('calls onScalerAgentDisconnected on disconnect', async () => {
      const onScalerAgentDisconnected = vi.fn();
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
        onScalerAgentDisconnected,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      handler.onClose!(new CloseEvent('close'), ws as any);
      expect(onScalerAgentDisconnected).toHaveBeenCalledWith('agent-1');
    });

    it('calls onScalerJobComplete on job completion', async () => {
      const onScalerJobComplete = vi.fn();
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
        onScalerJobComplete,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      await handler.onMessage!(
        makeMessageEvent({
          type: 'job.status',
          messageId: 'msg-7',
          runId: 'run-1',
          jobId: 'job-1',
          state: 'success',
          timestamp: Date.now(),
        }),
        ws as any,
      );

      expect(onScalerJobComplete).toHaveBeenCalledWith('agent-1');
    });

    it('does not crash when scaler callbacks are not provided', async () => {
      const handler = createAgentWsHandler({ registry, dispatcher, agentAuthMode: 'none' });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      await handler.onMessage!(
        makeMessageEvent({
          type: 'job.status',
          messageId: 'msg-8',
          runId: 'run-1',
          jobId: 'job-1',
          state: 'success',
          timestamp: Date.now(),
        }),
        ws as any,
      );

      handler.onClose!(new CloseEvent('close'), ws as any);
      expect(dispatcher.onJobComplete).toHaveBeenCalled();
      expect(dispatcher.onAgentDisconnect).toHaveBeenCalled();
    });
  });

  describe('job.status with cancelled state', () => {
    it('decrements activeJobs and forwards to Platform', async () => {
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      const timestamp = Date.now();

      await handler.onMessage!(
        makeMessageEvent({
          type: 'job.status',
          messageId: 'msg-6',
          runId: 'run-3',
          jobId: 'job-3',
          state: 'cancelled',
          timestamp,
        }),
        ws as any,
      );

      expect(dispatcher.onJobComplete).toHaveBeenCalledWith('agent-1', 'job-3');
      expect(onJobStatus).toHaveBeenCalledWith('agent-1', {
        runId: 'run-3',
        jobId: 'job-3',
        state: 'cancelled',
        timestamp,
        data: undefined,
      });
    });
  });

  describe('config.ack', () => {
    it('calls onConfigAck callback when config.ack is received', async () => {
      const onConfigAck = vi.fn();
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
        onConfigAck,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      await handler.onMessage!(
        makeMessageEvent({
          type: 'config.ack',
          messageId: 'config-ack-1',
          agentId: 'agent-1',
        }),
        ws as any,
      );

      expect(onConfigAck).toHaveBeenCalledWith('agent-1');
    });
  });

  describe('cache.upload.request', () => {
    it('returns upload URL for source cache type', async () => {
      const mockSourceCache = {
        getUploadUrl: vi.fn().mockResolvedValue('https://s3.example.com/upload-bundle'),
      };
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
        sourceCache: mockSourceCache as any,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);
      (ws.send as ReturnType<typeof vi.fn>).mockClear();

      await handler.onMessage!(
        makeMessageEvent({
          type: 'cache.upload.request',
          messageId: 'upload-req-1',
          jobId: 'job-1',
          cacheType: 'source',
          contentHash: 'abc123hash',
          platform: 'linux',
          arch: 'x64',
        }),
        ws as any,
      );

      expect(mockSourceCache.getUploadUrl).toHaveBeenCalledWith('abc123hash');
      const sentCalls = (ws.send as ReturnType<typeof vi.fn>).mock.calls;
      const response = JSON.parse(sentCalls[0][0]);
      expect(response).toEqual({
        type: 'cache.upload.response',
        requestId: 'upload-req-1',
        uploadUrl: 'https://s3.example.com/upload-bundle',
      });
    });
  });

  // ── User-cache WS handlers (Task 7) ─────────────────────────────

  describe('user-cache WS handlers', () => {
    /** A UserCache-shaped stub recording the refs it was called with. */
    function mockUserCache(
      overrides: Partial<{
        restore: ReturnType<typeof vi.fn>;
        beginSave: ReturnType<typeof vi.fn>;
        commitSave: ReturnType<typeof vi.fn>;
      }> = {},
    ): UserCache {
      return {
        restore: overrides.restore ?? vi.fn().mockResolvedValue({ hit: false }),
        beginSave: overrides.beginSave ?? vi.fn().mockResolvedValue({ skip: false }),
        commitSave: overrides.commitSave ?? vi.fn().mockResolvedValue(undefined),
      } as unknown as UserCache;
    }

    /** Build a handler with an owning ownership-tracker + a populated dispatch-cache-ref tracker. */
    function setup(
      opts: {
        owned?: boolean;
        userCache?: UserCache;
        dispatchCacheRefs?: DispatchCacheRefTracker;
        recordRef?: boolean;
      } = {},
    ) {
      const isJobOwnedByAgent = vi.fn().mockReturnValue(opts.owned ?? true);
      const tracker = new OwnershipTracker({ isJobOwnedByAgent, onDisconnect: vi.fn() });
      const dispatchCacheRefs = opts.dispatchCacheRefs ?? new DispatchCacheRefTracker();
      if (opts.recordRef !== false) {
        dispatchCacheRefs.record('job-1', {
          orgId: 'org-1',
          repoId: 'owner/repo',
          cacheRefScope: CacheRefScope.enum.shared,
          runId: 'run-1',
        });
      }
      const userCache = opts.userCache ?? mockUserCache();
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
        ownershipTracker: tracker,
        userCache,
        dispatchCacheRefs,
      });
      return { handler, userCache, dispatchCacheRefs };
    }

    async function register(
      handler: ReturnType<typeof createAgentWsHandler>,
      ws: ReturnType<typeof mockWs>,
    ) {
      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);
      (ws.send as ReturnType<typeof vi.fn>).mockClear();
    }

    it('cache.user.restore.request resolves the ref server-side and replies with the stub result', async () => {
      const restore = vi.fn().mockResolvedValue({
        hit: true,
        matchedKey: 'k1',
        downloadUrl: 'mem://k1',
        tarHash: 'deadbeef',
      });
      const { handler, userCache } = setup({ userCache: mockUserCache({ restore }) });
      const ws = mockWs();
      await register(handler, ws);

      await handler.onMessage!(
        makeMessageEvent({
          type: 'cache.user.restore.request',
          messageId: 'm1',
          jobId: 'job-1',
          key: 'k1',
          restoreKeys: ['k-'],
        }),
        ws as any,
      );

      // The handler resolves org/repo/scope/runId from the tracker, NOT the wire.
      expect(userCache.restore).toHaveBeenCalledWith({
        org: 'org-1',
        repo: 'owner/repo',
        scope: 'shared',
        runId: 'run-1',
        key: 'k1',
        restoreKeys: ['k-'],
      });
      const response = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(response).toEqual({
        type: 'cache.user.restore.response',
        requestId: 'm1',
        hit: true,
        matchedKey: 'k1',
        downloadUrl: 'mem://k1',
        tarHash: 'deadbeef',
      });
    });

    it('SECURITY: a wire-supplied org/repo/scope cannot influence the resolved ref', async () => {
      const restore = vi.fn().mockResolvedValue({ hit: false });
      const { handler, userCache } = setup({ userCache: mockUserCache({ restore }) });
      const ws = mockWs();
      await register(handler, ws);

      // Attacker stuffs forged namespacing onto the wire message.
      await handler.onMessage!(
        makeMessageEvent({
          type: 'cache.user.restore.request',
          messageId: 'm1',
          jobId: 'job-1',
          key: 'k1',
          // forged fields — must be ignored entirely
          org: 'victim-org',
          repo: 'victim/repo',
          scope: 'shared',
          orgId: 'victim-org',
          repoId: 'victim/repo',
          cacheRefScope: 'shared',
          runId: 'victim-run',
        }),
        ws as any,
      );

      const callArg = (userCache.restore as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.org).toBe('org-1');
      expect(callArg.repo).toBe('owner/repo');
      expect(callArg.scope).toBe('shared');
      expect(callArg.runId).toBe('run-1');
    });

    it('cache.user.restore.request for an unowned job is dropped (no reply, no restore)', async () => {
      const { handler, userCache } = setup({ owned: false });
      const ws = mockWs();
      await register(handler, ws);

      await handler.onMessage!(
        makeMessageEvent({
          type: 'cache.user.restore.request',
          messageId: 'm1',
          jobId: 'job-1',
          key: 'k1',
        }),
        ws as any,
      );

      expect(userCache.restore).not.toHaveBeenCalled();
      expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    });

    it('cache.user.restore.request for an unknown jobId fails closed (miss reply, no restore)', async () => {
      const { handler, userCache } = setup({ recordRef: false });
      const ws = mockWs();
      await register(handler, ws);

      await handler.onMessage!(
        makeMessageEvent({
          type: 'cache.user.restore.request',
          messageId: 'm1',
          jobId: 'job-1',
          key: 'k1',
        }),
        ws as any,
      );

      expect(userCache.restore).not.toHaveBeenCalled();
      const response = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(response).toEqual({
        type: 'cache.user.restore.response',
        requestId: 'm1',
        hit: false,
      });
    });

    it('cache.user.save.request replies skip:true when the key already exists', async () => {
      const beginSave = vi.fn().mockResolvedValue({ skip: true });
      const { handler, userCache } = setup({ userCache: mockUserCache({ beginSave }) });
      const ws = mockWs();
      await register(handler, ws);

      await handler.onMessage!(
        makeMessageEvent({
          type: 'cache.user.save.request',
          messageId: 'm1',
          jobId: 'job-1',
          key: 'k1',
        }),
        ws as any,
      );

      expect(userCache.beginSave).toHaveBeenCalledWith({
        org: 'org-1',
        repo: 'owner/repo',
        scope: 'shared',
        runId: 'run-1',
        key: 'k1',
      });
      const response = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(response).toEqual({
        type: 'cache.user.save.response',
        requestId: 'm1',
        skip: true,
      });
    });

    it('cache.user.save.request replies with uploadUrl and threads the tempKey to commit', async () => {
      const beginSave = vi.fn().mockResolvedValue({
        skip: false,
        uploadUrl: 'put://tmp',
        tempKey: 'cache/org-1/.tmp-x.tar.gz',
      });
      const commitSave = vi.fn().mockResolvedValue(undefined);
      const { handler, userCache } = setup({
        userCache: mockUserCache({ beginSave, commitSave }),
      });
      const ws = mockWs();
      await register(handler, ws);

      await handler.onMessage!(
        makeMessageEvent({
          type: 'cache.user.save.request',
          messageId: 'm1',
          jobId: 'job-1',
          key: 'k1',
        }),
        ws as any,
      );
      const saveResp = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(saveResp).toEqual({
        type: 'cache.user.save.response',
        requestId: 'm1',
        skip: false,
        uploadUrl: 'put://tmp',
      });

      await handler.onMessage!(
        makeMessageEvent({
          type: 'cache.user.save.complete',
          messageId: 'm2',
          jobId: 'job-1',
          key: 'k1',
          tarHash: 'deadbeef',
          sizeBytes: 1234,
        }),
        ws as any,
      );

      expect(userCache.commitSave).toHaveBeenCalledWith({
        org: 'org-1',
        repo: 'owner/repo',
        scope: 'shared',
        runId: 'run-1',
        key: 'k1',
        tarHash: 'deadbeef',
        sizeBytes: 1234,
        tempKey: 'cache/org-1/.tmp-x.tar.gz',
      });
    });

    it('cache.user.save.complete for an unowned job does not commit', async () => {
      const { handler, userCache } = setup({ owned: false });
      const ws = mockWs();
      await register(handler, ws);

      await handler.onMessage!(
        makeMessageEvent({
          type: 'cache.user.save.complete',
          messageId: 'm1',
          jobId: 'job-1',
          key: 'k1',
          tarHash: 'deadbeef',
          sizeBytes: 10,
        }),
        ws as any,
      );

      expect(userCache.commitSave).not.toHaveBeenCalled();
    });

    it('drops the dispatch-cache ref when the job completes', async () => {
      const owned = new OwnershipTracker({
        isJobOwnedByAgent: vi.fn().mockReturnValue(true),
        onDisconnect: vi.fn(),
      });
      const dispatchCacheRefs = new DispatchCacheRefTracker();
      dispatchCacheRefs.record('job-1', { runId: 'run-1' });
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
        ownershipTracker: owned,
        userCache: mockUserCache(),
        dispatchCacheRefs,
      });
      const ws = mockWs();
      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      expect(dispatchCacheRefs.get('job-1')).toBeDefined();

      await handler.onMessage!(
        makeMessageEvent({
          type: 'job.status',
          messageId: 'm1',
          runId: 'run-1',
          jobId: 'job-1',
          state: 'success',
          timestamp: Date.now(),
        }),
        ws as any,
      );

      expect(dispatchCacheRefs.get('job-1')).toBeUndefined();
    });
  });

  // ── Ownership validation tests ──────────────────────────────────

  describe('ownership validation', () => {
    function createHandlerWithOwnership(
      ownershipOpts: { owned?: boolean; threshold?: number } = {},
      extraDeps: Partial<AgentWsHandlerDeps> = {},
    ) {
      const isJobOwnedByAgent = vi.fn().mockReturnValue(ownershipOpts.owned ?? false);
      const onDisconnect = vi.fn();
      const tracker = new OwnershipTracker({
        isJobOwnedByAgent,
        onDisconnect,
        violationThreshold: ownershipOpts.threshold ?? 5,
      });
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
        ownershipTracker: tracker,
        ...extraDeps,
      });
      return { handler, tracker, isJobOwnedByAgent, onDisconnect };
    }

    it('job.status from owning agent is processed normally', async () => {
      const { handler } = createHandlerWithOwnership({ owned: true });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      await handler.onMessage!(
        makeMessageEvent({
          type: 'job.status',
          messageId: 'msg-own-1',
          runId: 'run-1',
          jobId: 'job-1',
          state: 'success',
          timestamp: Date.now(),
        }),
        ws as any,
      );

      expect(dispatcher.onJobComplete).toHaveBeenCalledWith('agent-1', 'job-1');
      expect(onJobStatus).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ jobId: 'job-1', state: 'success' }),
      );
    });

    it('job.status from non-owning agent is silently dropped', async () => {
      const { handler } = createHandlerWithOwnership({ owned: false });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      await handler.onMessage!(
        makeMessageEvent({
          type: 'job.status',
          messageId: 'msg-noown-1',
          runId: 'run-1',
          jobId: 'job-1',
          state: 'success',
          timestamp: Date.now(),
        }),
        ws as any,
      );

      expect(dispatcher.onJobComplete).not.toHaveBeenCalled();
      expect(onJobStatus).not.toHaveBeenCalled();
    });

    it('log.chunk from non-owning agent is silently dropped', async () => {
      const onLogChunk = vi.fn();
      const { handler } = createHandlerWithOwnership({ owned: false }, { onLogChunk });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      await handler.onMessage!(
        makeMessageEvent({
          type: 'log.chunk',
          messageId: 'msg-log-1',
          runId: 'run-1',
          jobId: 'job-1',
          stepIndex: 0,
          lines: ['hello world'],
          timestamp: Date.now(),
        }),
        ws as any,
      );

      expect(onLogChunk).not.toHaveBeenCalled();
    });

    it('step.status from non-owning agent is silently dropped', async () => {
      const onStepStatus = vi.fn();
      const { handler } = createHandlerWithOwnership({ owned: false }, { onStepStatus });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      await handler.onMessage!(
        makeMessageEvent({
          type: 'step.status',
          messageId: 'msg-step-1',
          runId: 'run-1',
          jobId: 'job-1',
          stepIndex: 0,
          stepName: 'build',
          state: 'running',
          timestamp: Date.now(),
        }),
        ws as any,
      );

      expect(onStepStatus).not.toHaveBeenCalled();
    });

    it('job.heartbeat from non-owning agent is silently dropped', async () => {
      const onJobHeartbeat = vi.fn();
      const { handler } = createHandlerWithOwnership({ owned: false }, { onJobHeartbeat });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      await handler.onMessage!(
        makeMessageEvent({
          type: 'job.heartbeat',
          messageId: 'msg-hb-1',
          runId: 'run-1',
          jobId: 'job-1',
          timestamp: Date.now(),
        }),
        ws as any,
      );

      expect(onJobHeartbeat).not.toHaveBeenCalled();
    });

    it('escalation disconnects agent after threshold violations', async () => {
      const { handler, onDisconnect } = createHandlerWithOwnership({
        owned: false,
        threshold: 3,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      for (let i = 0; i < 3; i++) {
        await handler.onMessage!(
          makeMessageEvent({
            type: 'job.status',
            messageId: `msg-esc-${i}`,
            runId: 'run-1',
            jobId: `job-${i}`,
            state: 'running',
            timestamp: Date.now(),
          }),
          ws as any,
        );
      }

      expect(onDisconnect).toHaveBeenCalledWith('agent-1', 'Too many ownership violations');
    });

    it('grace window: message accepted during grace period', async () => {
      // Use a dynamic ownership check that starts false then becomes true
      const isJobOwnedByAgent = vi.fn().mockReturnValue(true);
      const onDisconnect = vi.fn();
      const tracker = new OwnershipTracker({ isJobOwnedByAgent, onDisconnect });
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
        ownershipTracker: tracker,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      // Send job.status for a job that passes ownership check (simulating grace window)
      await handler.onMessage!(
        makeMessageEvent({
          type: 'job.status',
          messageId: 'msg-grace-1',
          runId: 'run-1',
          jobId: 'job-grace-1',
          state: 'running',
          timestamp: Date.now(),
        }),
        ws as any,
      );

      expect(onJobStatus).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ jobId: 'job-grace-1' }),
      );
    });

    it('cleanup on disconnect removes violation tracking', async () => {
      const isJobOwnedByAgent = vi.fn().mockReturnValue(false);
      const onDisconnect = vi.fn();
      const tracker = new OwnershipTracker({
        isJobOwnedByAgent,
        onDisconnect,
        violationThreshold: 3,
      });
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        ownershipTracker: tracker,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      // Two violations
      await handler.onMessage!(
        makeMessageEvent({
          type: 'job.status',
          messageId: 'msg-v1',
          runId: 'run-1',
          jobId: 'job-v1',
          state: 'running',
          timestamp: Date.now(),
        }),
        ws as any,
      );
      await handler.onMessage!(
        makeMessageEvent({
          type: 'job.status',
          messageId: 'msg-v2',
          runId: 'run-1',
          jobId: 'job-v2',
          state: 'running',
          timestamp: Date.now(),
        }),
        ws as any,
      );

      // Disconnect (should cleanup violations)
      handler.onClose!(new CloseEvent('close'), ws as any);

      // Verify cleanup was called (dispatcher.onAgentDisconnect is called)
      expect(dispatcher.onAgentDisconnect).toHaveBeenCalledWith('agent-1');
    });

    it('calls onSecretOutputs when job succeeds with secretOutputs', async () => {
      const onSecretOutputs = vi.fn().mockResolvedValue(undefined);
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
        onSecretOutputs,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      await handler.onMessage!(
        makeMessageEvent({
          type: 'job.status',
          messageId: 'msg-secret-1',
          runId: 'run-1',
          jobId: 'job-1',
          state: 'success',
          timestamp: Date.now(),
          secretOutputs: {
            API_KEY: {
              agentPublicKey: 'dGVzdC1wdWJsaWMta2V5',
              encrypted: 'dGVzdC1lbmNyeXB0ZWQ=',
            },
          },
        }),
        ws as any,
      );

      // onSecretOutputs should have been called with the right args
      // (fire-and-forget, so we need to wait a tick for the promise)
      await vi.waitFor(() => {
        expect(onSecretOutputs).toHaveBeenCalledTimes(1);
      });
      expect(onSecretOutputs).toHaveBeenCalledWith('run-1', 'job-1', {
        API_KEY: {
          agentPublicKey: 'dGVzdC1wdWJsaWMta2V5',
          encrypted: 'dGVzdC1lbmNyeXB0ZWQ=',
        },
      });
    });

    it('does not call onSecretOutputs when state is not success', async () => {
      const onSecretOutputs = vi.fn().mockResolvedValue(undefined);
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
        onSecretOutputs,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      await handler.onMessage!(
        makeMessageEvent({
          type: 'job.status',
          messageId: 'msg-secret-2',
          runId: 'run-1',
          jobId: 'job-1',
          state: 'failed',
          timestamp: Date.now(),
          secretOutputs: {
            API_KEY: {
              agentPublicKey: 'dGVzdC1wdWJsaWMta2V5',
              encrypted: 'dGVzdC1lbmNyeXB0ZWQ=',
            },
          },
        }),
        ws as any,
      );

      // onSecretOutputs is only called for state === 'success', so it should not be called
      expect(onSecretOutputs).not.toHaveBeenCalled();
    });

    it('does not call onSecretOutputs when no secretOutputs in message', async () => {
      const onSecretOutputs = vi.fn().mockResolvedValue(undefined);
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
        onSecretOutputs,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      await handler.onMessage!(
        makeMessageEvent({
          type: 'job.status',
          messageId: 'msg-secret-3',
          runId: 'run-1',
          jobId: 'job-1',
          state: 'success',
          timestamp: Date.now(),
        }),
        ws as any,
      );

      // No secretOutputs in message, so callback should not be called
      expect(onSecretOutputs).not.toHaveBeenCalled();
    });

    it('handles onSecretOutputs rejection gracefully (does not crash handler)', async () => {
      const onSecretOutputs = vi.fn().mockRejectedValue(new Error('Decryption failed'));
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
        onSecretOutputs,
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      // Should not throw even though onSecretOutputs rejects
      await handler.onMessage!(
        makeMessageEvent({
          type: 'job.status',
          messageId: 'msg-secret-4',
          runId: 'run-1',
          jobId: 'job-1',
          state: 'success',
          timestamp: Date.now(),
          secretOutputs: {
            TOKEN: {
              agentPublicKey: 'dGVzdC1wdWJsaWMta2V5',
              encrypted: 'dGVzdC1lbmNyeXB0ZWQ=',
            },
          },
        }),
        ws as any,
      );

      // Job should still complete normally
      expect(dispatcher.onJobComplete).toHaveBeenCalledWith('agent-1', 'job-1');
      expect(dispatcher.onAgentAvailable).toHaveBeenCalled();
    });

    it('no ownership tracker: messages pass through unchanged', async () => {
      // Without ownershipTracker, handler should work normally (backward compat)
      const handler = createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
        // No ownershipTracker
      });
      const ws = mockWs();

      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);

      await handler.onMessage!(
        makeMessageEvent({
          type: 'job.status',
          messageId: 'msg-notrack-1',
          runId: 'run-1',
          jobId: 'job-1',
          state: 'success',
          timestamp: Date.now(),
        }),
        ws as any,
      );

      expect(dispatcher.onJobComplete).toHaveBeenCalledWith('agent-1', 'job-1');
    });
  });

  // ── Agent run.event and job.context forwarding ──────────────

  describe('run.event and job.context forwarding', () => {
    function createHandler(extraDeps: Partial<AgentWsHandlerDeps> = {}) {
      return createAgentWsHandler({
        registry,
        dispatcher,
        agentAuthMode: 'none',
        onJobStatus,
        ...extraDeps,
      });
    }

    async function registerAgent(handler: ReturnType<typeof createAgentWsHandler>) {
      const ws = mockWs();
      handler.onOpen!(new Event('open'), ws as any);
      await handler.onMessage!(makeMessageEvent(registerMsg()), ws as any);
      return ws;
    }

    it('forwards run.event from agent to onRunEvent callback', async () => {
      const onRunEvent = vi.fn();
      const handler = createHandler({ onRunEvent });
      const ws = await registerAgent(handler);

      await handler.onMessage!(
        makeMessageEvent({
          type: 'run.event',
          runId: 'run-1',
          eventType: 'agent.execution.start',
          timestampMs: 1234567890,
          sourceService: 'agent',
          jobId: 'job-1',
          metadata: { foo: 'bar' },
          durationMs: null,
        }),
        ws as any,
      );

      expect(onRunEvent).toHaveBeenCalledOnce();
      expect(onRunEvent).toHaveBeenCalledWith('agent-1', {
        runId: 'run-1',
        eventType: 'agent.execution.start',
        timestampMs: 1234567890,
        sourceService: 'agent',
        jobId: 'job-1',
        metadata: { foo: 'bar' },
        durationMs: undefined,
      });
    });

    it('forwards job.context from agent to onJobContext callback', async () => {
      const onJobContext = vi.fn();
      const handler = createHandler({ onJobContext });
      const ws = await registerAgent(handler);

      await handler.onMessage!(
        makeMessageEvent({
          type: 'job.context',
          runId: 'run-1',
          jobId: 'job-1',
          context: {
            runtime: { nodeVersion: 'v24.0.0', os: 'linux', arch: 'x64' },
            sandboxType: 'bare-metal',
          },
        }),
        ws as any,
      );

      expect(onJobContext).toHaveBeenCalledOnce();
      expect(onJobContext).toHaveBeenCalledWith('agent-1', {
        runId: 'run-1',
        jobId: 'job-1',
        context: {
          runtime: { nodeVersion: 'v24.0.0', os: 'linux', arch: 'x64' },
          sandboxType: 'bare-metal',
        },
      });
    });

    it('silently drops run.event when no onRunEvent callback configured', async () => {
      const handler = createHandler(); // no onRunEvent
      const ws = await registerAgent(handler);

      await handler.onMessage!(
        makeMessageEvent({
          type: 'run.event',
          runId: 'run-1',
          eventType: 'agent.execution.start',
          timestampMs: 1234567890,
          sourceService: 'agent',
          jobId: null,
        }),
        ws as any,
      );

      // Connection should NOT be closed (message silently dropped, not rejected by Zod)
      expect(ws.close).not.toHaveBeenCalled();
    });
  });
});

describe('truncateCloseReason', () => {
  it('passes short reasons through unchanged', () => {
    expect(truncateCloseReason('short reason')).toBe('short reason');
  });

  it('caps a long reason at 123 UTF-8 bytes (RFC 6455 close-reason limit)', () => {
    const long = 'Agent labels exceed token-bound scope: ' + 'kici:role:builder,'.repeat(20);
    const out = truncateCloseReason(long);
    expect(Buffer.from(out, 'utf-8').length).toBeLessThanOrEqual(123);
  });

  it('does not leave a trailing partial multi-byte char when truncating', () => {
    const out = truncateCloseReason('é'.repeat(200)); // 2 bytes each
    expect(Buffer.from(out, 'utf-8').length).toBeLessThanOrEqual(123);
    expect(out).not.toContain('�');
  });
});
