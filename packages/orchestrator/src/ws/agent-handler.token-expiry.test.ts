/**
 * Regression: natural TTL expiry (`expires_at` passing, not `revoked_at`) must
 * close in-flight agent WS connections.
 *
 * Trust model: when an ephemeral agent token's `expires_at` passes, every
 * in-flight WS it authenticated MUST close within a bounded window; the agent
 * keeps no data-plane access (job claims, log streaming, secret receipt) past
 * the TTL.
 *
 * The handler validates the token only once, at auth. A revoke kicks in-flight
 * WS from the admin DELETE route, but natural expiry makes no revoke call, so
 * without an expiry kick a token stolen within its TTL could hold an
 * authenticated WS past expiry.
 *
 * At register time the handler schedules a per-token timer on
 * `tokenRow.expires_at` via `AgentRegistry.scheduleExpiryKick(...)`; on fire,
 * `disconnectByTokenId(tokenId)` closes every WS under that token. Static
 * tokens (`expires_at = null`) are skipped at the call site.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PROTOCOL_VERSION } from '@kici-dev/engine';
import { createAgentWsHandler } from './agent-handler.js';
import { AgentRegistry } from '../agent/registry.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import type { AgentTokenStore } from '../agent/token-store.js';
import { mockWs, makeMessageEvent } from '../__test-helpers__/mock-ws.js';

function mockDispatcher(): Dispatcher {
  return {
    dispatch: vi.fn().mockResolvedValue({ status: 'queued', jobId: 'test' }),
    onAgentAvailable: vi.fn().mockResolvedValue(undefined),
    onAgentDisconnect: vi.fn().mockResolvedValue(undefined),
    onJobComplete: vi.fn(),
    releaseRebootPending: vi.fn().mockResolvedValue(undefined),
  } as unknown as Dispatcher;
}

function authRequestMsg(token = 'kat_' + 'a'.repeat(64)) {
  return {
    type: 'auth.request' as const,
    token,
    protocolVersion: PROTOCOL_VERSION,
  };
}

function registerMsg(opts: { agentId: string; labels: string[] }) {
  return {
    type: 'agent.register' as const,
    messageId: 'msg-1',
    agentId: opts.agentId,
    labels: opts.labels,
  };
}

/**
 * Token store whose `validate()` mirrors `AgentTokenStore.validate()`'s
 * `expires_at IS NULL OR expires_at > now()`: null once the TTL has passed.
 *
 * On TTL firing the kick must (a) close the WS with an auth-failure code and
 * (b) unregister the agent.
 */
function expiringEphemeralTokenStore(opts: {
  agentId: string;
  ttlMs: number;
  labels: string[] | null;
}): { store: AgentTokenStore; expiresAt: Date } {
  const expiresAt = new Date(Date.now() + opts.ttlMs);
  const tokenRow = {
    id: 'tok-expiring',
    token_prefix: 'kat_expirabc',
    labels: opts.labels === null ? null : JSON.stringify(opts.labels),
    agent_type: 'ephemeral',
    created_at: new Date(),
    last_seen_at: null,
    created_by: opts.agentId,
    revoked_at: null,
    expires_at: expiresAt,
  };

  const store = {
    validate: vi.fn().mockImplementation(async () => {
      if (expiresAt.getTime() <= Date.now()) return null;
      return tokenRow;
    }),
    createEphemeral: vi.fn(),
    createStatic: vi.fn(),
    revoke: vi.fn(),
    list: vi.fn(),
    cleanupExpired: vi.fn(),
  } as unknown as AgentTokenStore;

  return { store, expiresAt };
}

describe('ephemeral-token natural TTL expiry propagates to in-flight WS', () => {
  let registry: AgentRegistry;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new AgentRegistry();
    dispatcher = mockDispatcher();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes in-flight agent WS within a bounded window when its ephemeral token expires naturally', async () => {
    const { store: tokenStore } = expiringEphemeralTokenStore({
      agentId: 'agent-expiring',
      ttlMs: 10_000,
      labels: ['ci'],
    });
    const handler = createAgentWsHandler({
      registry,
      dispatcher,
      agentAuthMode: 'token',
      tokenStore,
    });

    const ws = mockWs();
    handler.onOpen!(new Event('open'), ws as any);
    await handler.onMessage!(makeMessageEvent(authRequestMsg()), ws as any);
    await handler.onMessage!(
      makeMessageEvent(registerMsg({ agentId: 'agent-expiring', labels: ['ci'] })),
      ws as any,
    );

    expect(registry.get('agent-expiring')).toBeDefined();
    expect(ws.close).not.toHaveBeenCalled();

    // 60s of slack past the TTL, so a 30s poll-based kick would still pass.
    await vi.advanceTimersByTimeAsync(70_000);

    expect(ws.close).toHaveBeenCalled();
    expect(registry.get('agent-expiring')).toBeUndefined();
  });

  it('does NOT close in-flight WS while the ephemeral token is still within its TTL', async () => {
    // Counter-test: catches a kick that fires too broadly (e.g. closing every
    // WS instead of only the expired ones).
    const { store: tokenStore } = expiringEphemeralTokenStore({
      agentId: 'agent-stable',
      ttlMs: 60 * 60 * 1000, // 1h
      labels: ['ci'],
    });
    const handler = createAgentWsHandler({
      registry,
      dispatcher,
      agentAuthMode: 'token',
      tokenStore,
    });

    const ws = mockWs();
    handler.onOpen!(new Event('open'), ws as any);
    await handler.onMessage!(makeMessageEvent(authRequestMsg()), ws as any);
    await handler.onMessage!(
      makeMessageEvent(registerMsg({ agentId: 'agent-stable', labels: ['ci'] })),
      ws as any,
    );

    expect(registry.get('agent-stable')).toBeDefined();
    expect(ws.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(70_000);

    expect(ws.close).not.toHaveBeenCalled();
    expect(registry.get('agent-stable')).toBeDefined();
  });
});
