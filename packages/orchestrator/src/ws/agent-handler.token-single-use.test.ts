/**
 * An ephemeral agent token must not be usable across distinct agentIds (ghost-agent
 * attack within the token's TTL + label-scope).
 *
 * Trust model: the scaler issues an ephemeral token bound to ONE scaler-spawned
 * agentId; `tokenStore.createEphemeral(agentId, labels, ttlMs)` records it in
 * `agent_tokens.created_by`. One token = one agent, for that agent's lifetime. Static
 * tokens are intentionally N-use (one operator PSK across many manually-registered
 * agents).
 *
 * The agentId-collision check only blocks "same agentId presents a different token",
 * and the label-scope check only bounds claimable labels. Without the register-time
 * binding check (`tokenCreatedBy === agentId` for an ephemeral token), a leaked
 * ephemeral token (env file on the scaler-spawned worker, memory dump, accidental
 * commit, log line) lets an attacker register a parallel `agent-ghost` within the TTL
 * and claim jobs, and the secrets dispatched with them, within the token's labels-scope.
 *
 * Static-token N-use stays a covered counter-test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PROTOCOL_VERSION, WS_CLOSE_AGENT_AUTH_FAILED } from '@kici-dev/engine';
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
 * `validate()` always returns one fixed row with production-shaped `agent_type` and
 * `created_by` (mirrors the token_hash -> row DB lookup).
 */
function tokenStoreFor(opts: {
  agentType: 'ephemeral' | 'static';
  createdBy: string | null;
  labels: string[] | null;
}): AgentTokenStore {
  return {
    validate: vi.fn().mockResolvedValue({
      id: 'tok-bound',
      token_prefix: 'kat_boundabc',
      labels: opts.labels === null ? null : JSON.stringify(opts.labels),
      agent_type: opts.agentType,
      created_at: new Date(),
      last_seen_at: null,
      created_by: opts.createdBy,
      revoked_at: null,
      expires_at: opts.agentType === 'ephemeral' ? new Date(Date.now() + 60 * 60 * 1000) : null,
    }),
    createEphemeral: vi.fn(),
    createStatic: vi.fn(),
    revoke: vi.fn(),
    list: vi.fn(),
    cleanupExpired: vi.fn(),
    consumeBootstrapToken: vi.fn().mockResolvedValue(true),
  } as unknown as AgentTokenStore;
}

describe('ephemeral-token single-use binding (created_by → agentId)', () => {
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

  it('rejects a second agentId registering with an ephemeral token already bound to another agentId', async () => {
    const tokenStore = tokenStoreFor({
      agentType: 'ephemeral',
      createdBy: 'agent-real',
      labels: ['ci'],
    });
    const handler = createAgentWsHandler({
      registry,
      dispatcher,
      agentAuthMode: 'token',
      tokenStore,
    });

    // Legitimate scaler-spawned agent registers as `agent-real`.
    const wsReal = mockWs();
    handler.onOpen!(new Event('open'), wsReal as any);
    await handler.onMessage!(makeMessageEvent(authRequestMsg()), wsReal as any);
    await handler.onMessage!(
      makeMessageEvent(registerMsg({ agentId: 'agent-real', labels: ['ci'] })),
      wsReal as any,
    );

    expect(registry.get('agent-real')).toBeDefined();
    expect(wsReal.close).not.toHaveBeenCalled();

    // Stolen token, ghost agentId: same labels-scope and token pass those checks, and a
    // different agentId dodges the collision check.
    const wsGhost = mockWs();
    handler.onOpen!(new Event('open'), wsGhost as any);
    await handler.onMessage!(makeMessageEvent(authRequestMsg()), wsGhost as any);
    await handler.onMessage!(
      makeMessageEvent(registerMsg({ agentId: 'agent-ghost', labels: ['ci'] })),
      wsGhost as any,
    );

    // INVARIANT: an ephemeral token bound to `agent-real` MUST refuse `agent-ghost`.
    expect(registry.get('agent-ghost')).toBeUndefined();
    expect(wsGhost.close).toHaveBeenCalledWith(
      WS_CLOSE_AGENT_AUTH_FAILED,
      expect.stringMatching(/ephemeral token bound to a different agentId/i),
    );

    // The legitimate agent must remain unaffected.
    expect(registry.get('agent-real')).toBeDefined();
    expect(wsReal.close).not.toHaveBeenCalled();
  });

  it('allows the bound agentId to reconnect with the same ephemeral token', async () => {
    // Counter-test: agent-real reconnects within the TTL with the same token and
    // agentId (e.g. a network blip). The binding check MUST NOT break reconnect.
    const tokenStore = tokenStoreFor({
      agentType: 'ephemeral',
      createdBy: 'agent-real',
      labels: ['ci'],
    });
    const handler = createAgentWsHandler({
      registry,
      dispatcher,
      agentAuthMode: 'token',
      tokenStore,
    });

    const wsFirst = mockWs();
    handler.onOpen!(new Event('open'), wsFirst as any);
    await handler.onMessage!(makeMessageEvent(authRequestMsg()), wsFirst as any);
    await handler.onMessage!(
      makeMessageEvent(registerMsg({ agentId: 'agent-real', labels: ['ci'] })),
      wsFirst as any,
    );
    expect(registry.get('agent-real')).toBeDefined();

    const wsReconnect = mockWs();
    handler.onOpen!(new Event('open'), wsReconnect as any);
    await handler.onMessage!(makeMessageEvent(authRequestMsg()), wsReconnect as any);
    await handler.onMessage!(
      makeMessageEvent(registerMsg({ agentId: 'agent-real', labels: ['ci'] })),
      wsReconnect as any,
    );

    expect(registry.get('agent-real')).toBeDefined();
    expect(wsReconnect.close).not.toHaveBeenCalled();
  });

  it('allows an init-runner to register as its bare target id with a bootstrap token', async () => {
    // A single-use bootstrap (init-runner) token binds `bootstrap:<targetAgentId>`
    // (mintBootstrapToken); the init-runner registers as the bare `<targetAgentId>`, so
    // Gate 2 must strip the `bootstrap:` prefix.
    const tokenStore = tokenStoreFor({
      agentType: 'ephemeral',
      createdBy: 'bootstrap:fresh-box-1',
      labels: ['kici:init'],
    });
    const handler = createAgentWsHandler({
      registry,
      dispatcher,
      agentAuthMode: 'token',
      tokenStore,
    });

    const wsInit = mockWs();
    handler.onOpen!(new Event('open'), wsInit as any);
    await handler.onMessage!(makeMessageEvent(authRequestMsg()), wsInit as any);
    await handler.onMessage!(
      makeMessageEvent(registerMsg({ agentId: 'fresh-box-1', labels: ['kici:init'] })),
      wsInit as any,
    );

    expect(registry.get('fresh-box-1')).toBeDefined();
    expect(wsInit.close).not.toHaveBeenCalled();
  });

  it('rejects a bootstrap token registering as an agentId other than its target', async () => {
    // The bootstrap token is bound to `fresh-box-1`; a stolen token trying to
    // register a different id must still be refused after prefix-stripping.
    const tokenStore = tokenStoreFor({
      agentType: 'ephemeral',
      createdBy: 'bootstrap:fresh-box-1',
      labels: ['kici:init'],
    });
    const handler = createAgentWsHandler({
      registry,
      dispatcher,
      agentAuthMode: 'token',
      tokenStore,
    });

    const wsGhost = mockWs();
    handler.onOpen!(new Event('open'), wsGhost as any);
    await handler.onMessage!(makeMessageEvent(authRequestMsg()), wsGhost as any);
    await handler.onMessage!(
      makeMessageEvent(registerMsg({ agentId: 'fresh-box-2', labels: ['kici:init'] })),
      wsGhost as any,
    );

    expect(registry.get('fresh-box-2')).toBeUndefined();
    expect(wsGhost.close).toHaveBeenCalledWith(
      WS_CLOSE_AGENT_AUTH_FAILED,
      expect.stringMatching(/ephemeral token bound to a different agentId: expected fresh-box-1/i),
    );
  });

  it('allows distinct agentIds to share a STATIC token (operator-issued N-use)', async () => {
    // Counter-test: static tokens are intentionally N-use; only ephemeral tokens carry the
    // agentId-binding invariant.
    const tokenStore = tokenStoreFor({
      agentType: 'static',
      createdBy: 'cli:admin',
      labels: ['ci'],
    });
    const handler = createAgentWsHandler({
      registry,
      dispatcher,
      agentAuthMode: 'token',
      tokenStore,
    });

    const wsA = mockWs();
    handler.onOpen!(new Event('open'), wsA as any);
    await handler.onMessage!(makeMessageEvent(authRequestMsg()), wsA as any);
    await handler.onMessage!(
      makeMessageEvent(registerMsg({ agentId: 'agent-a', labels: ['ci'] })),
      wsA as any,
    );

    const wsB = mockWs();
    handler.onOpen!(new Event('open'), wsB as any);
    await handler.onMessage!(makeMessageEvent(authRequestMsg()), wsB as any);
    await handler.onMessage!(
      makeMessageEvent(registerMsg({ agentId: 'agent-b', labels: ['ci'] })),
      wsB as any,
    );

    // Both agents are registered; neither WS is closed.
    expect(registry.get('agent-a')).toBeDefined();
    expect(registry.get('agent-b')).toBeDefined();
    expect(wsA.close).not.toHaveBeenCalled();
    expect(wsB.close).not.toHaveBeenCalled();
  });
});
