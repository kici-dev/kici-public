/**
 * pentest repro: ephemeral agent token allows N-use across distinct
 * agentIds (ghost-agent attack within the token's TTL + label-scope).
 *
 * Trust model the system claims to hold:
 *   The scaler issues an ephemeral agent token bound to ONE scaler-spawned
 *   agentId. `tokenStore.createEphemeral(agentId, labels, ttlMs)` records
 *   the bound agentId in the `created_by` column of `agent_tokens`. The
 *   ephemeral token is issued for that one agent's lifetime — by design,
 *   one token = one agent. Static tokens are exempt: an operator-managed
 *   static token is intentionally N-use (the same PSK can be distributed
 *   across many manually-registered agents).
 *
 *   Today the orchestrator's agent WS handler does NOT enforce the
 *   ephemeral-token-to-agentId binding at register-time. The collision
 *   check at agent-handler.ts:616 only blocks "same agentId presents a
 *   different token"; an attacker with a stolen ephemeral token can
 *   register a fresh `agent-ghost` and freely claim jobs (and receive the
 *   secrets dispatched with them) within the token's labels-scope. The
 * fix narrowed the labels but left the agentId-binding gap open.
 *
 *   An A10 stolen-credential attack requires one ephemeral token leakage
 *   (env file read on the scaler-spawned VM/container/bare-metal worker,
 *   agent process memory dump, accidental commit, log line). Within the
 *   token's TTL, an attacker without this fix could mint a parallel
 *   ghost agent that the orchestrator treated as a peer of the
 *   legitimate one.
 *
 * Static-token N-use remains a covered counter-test: operators
 * deliberately distribute one static token across many agents, and that
 * path must keep working.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WS_CLOSE_AGENT_AUTH_FAILED } from '@kici-dev/engine';
import { createAgentWsHandler } from './agent-handler.js';
import { AgentRegistry } from '../agent/registry.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import type { AgentTokenStore } from '../agent/token-store.js';
import { mockWs } from '../__test-helpers__/mock-ws.js';

function mockDispatcher(): Dispatcher {
  return {
    dispatch: vi.fn().mockResolvedValue({ status: 'queued', jobId: 'test' }),
    onAgentAvailable: vi.fn().mockResolvedValue(undefined),
    onAgentDisconnect: vi.fn().mockResolvedValue(undefined),
    onJobComplete: vi.fn(),
    releaseRebootPending: vi.fn().mockResolvedValue(undefined),
  } as unknown as Dispatcher;
}

function makeMessageEvent(data: unknown): MessageEvent {
  return { data: JSON.stringify(data) } as MessageEvent;
}

function authRequestMsg(token = 'kat_' + 'a'.repeat(64)) {
  return {
    type: 'auth.request' as const,
    token,
    protocolVersion: 1,
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
 * Token store whose `validate(...)` returns a fixed token row with
 * `agent_type` and `created_by` populated to match the production
 * shape. The same row is returned for every `validate()` call (mirrors
 * the DB lookup: token_hash -> row).
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
  } as unknown as AgentTokenStore;
}

describe(' ephemeral-token single-use binding (created_by → agentId)', () => {
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

    // Sanity: agent-real is registered.
    expect(registry.get('agent-real')).toBeDefined();
    expect(wsReal.close).not.toHaveBeenCalled();

    // A10 attacker who stole the ephemeral token registers as a ghost
    // agent under a different agentId. Same labels-scope (so
    // doesn't catch it), same token (so the token validates), different
    // agentId (so the agentId-collision check at agent-handler.ts:616
    // doesn't fire).
    const wsGhost = mockWs();
    handler.onOpen!(new Event('open'), wsGhost as any);
    await handler.onMessage!(makeMessageEvent(authRequestMsg()), wsGhost as any);
    await handler.onMessage!(
      makeMessageEvent(registerMsg({ agentId: 'agent-ghost', labels: ['ci'] })),
      wsGhost as any,
    );

    // INVARIANT: an ephemeral token bound to `agent-real` MUST
    // refuse to register `agent-ghost`.
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
    // Counter-test: the legitimate scaler-spawned agent-real disconnects
    // (e.g. transient network blip) and reconnects within the token's
    // TTL. Same token, same agentId. Must succeed — agent reconnect is a
    // normal operational flow and the fix MUST NOT break it.
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

    // Same agentId reconnects on a fresh socket. Must be accepted.
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

  it('allows distinct agentIds to share a STATIC token (operator-issued N-use)', async () => {
    // Counter-test: static tokens are intentionally N-use. The operator
    // distributes one static PSK across many manually-registered agents.
    // The fix MUST NOT break this — only ephemeral tokens carry the
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
