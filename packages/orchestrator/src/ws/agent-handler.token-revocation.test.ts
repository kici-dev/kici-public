/**
 * Regression: agent-token revocation must close in-flight agent WS connections.
 *
 * When an admin revokes an agent token (`kici-admin agent token revoke <id>` ->
 * DELETE /api/v1/agent-tokens/:id -> `tokenStore.revoke(id)`), every agent WS
 * authenticated by it MUST close within a bounded window: no job claims, log
 * streaming or secret receipt past the revocation.
 *
 * The handler validates the token only at the auth phase, and `revoke(id)` only
 * writes `revoked_at`. So the revoke route also kicks every in-flight WS under
 * the token (`AgentRegistry.disconnectByTokenId`), and cluster peers get the
 * kick through a `peer.agent-token.revoke` broadcast. Without the kick, a stolen
 * token keeps data-plane access until the attacker drops the connection.
 *
 * The orch->Platform leg holds the same invariant: revoking an orchestrator API
 * key kicks its open WS, with a `kici:revoke-key` Valkey channel for
 * cross-instance fan-out.
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
 * After `revoke(...)`, `validate()` returns null, mirroring the production
 * `revoked_at IS NULL` gate.
 */
function makeRevocableTokenStore(authorizedLabels: string[] | null): {
  store: AgentTokenStore;
  revoke: () => Promise<boolean>;
  isRevoked: () => boolean;
} {
  let revoked = false;
  const tokenRow = {
    id: 'tok-revocable',
    token_prefix: 'kat_revocab',
    labels: authorizedLabels === null ? null : JSON.stringify(authorizedLabels),
    agent_type: 'static',
    created_at: new Date(),
    last_seen_at: null,
    created_by: null,
    revoked_at: null as Date | null,
    expires_at: null,
  };

  const store = {
    validate: vi.fn().mockImplementation(async () => (revoked ? null : tokenRow)),
    createEphemeral: vi.fn(),
    createStatic: vi.fn(),
    revoke: vi.fn().mockImplementation(async () => {
      revoked = true;
      tokenRow.revoked_at = new Date();
      return true;
    }),
    list: vi.fn(),
    cleanupExpired: vi.fn(),
  } as unknown as AgentTokenStore;

  return {
    store,
    revoke: async () => {
      const r = await store.revoke('tok-revocable');
      return r;
    },
    isRevoked: () => revoked,
  };
}

/**
 * Mirrors the DELETE /api/v1/agent-tokens/:id route: the DB write, then the
 * in-flight WS kick, which is what closes the WS.
 */
async function adminRevoke(
  registry: AgentRegistry,
  store: { revoke: () => Promise<boolean> },
  tokenId: string,
): Promise<{ revoked: boolean; kicked: number }> {
  const revoked = await store.revoke();
  if (!revoked) return { revoked: false, kicked: 0 };
  const kicked = registry.disconnectByTokenId(tokenId);
  return { revoked, kicked };
}

describe('agent-token revocation propagation to in-flight WS', () => {
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

  it('closes in-flight agent WS within a bounded window when its auth token is revoked', async () => {
    const { store: tokenStore, isRevoked } = makeRevocableTokenStore(null);
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
      makeMessageEvent(registerMsg({ agentId: 'agent-revoked', labels: ['ci'] })),
      ws as any,
    );

    expect(registry.get('agent-revoked')).toBeDefined();
    expect(ws.close).not.toHaveBeenCalled();

    const { revoked, kicked } = await adminRevoke(registry, tokenStore, 'tok-revocable');
    expect(revoked).toBe(true);
    expect(isRevoked()).toBe(true);
    expect(kicked).toBe(1);

    // The kick is synchronous; advancing time guards against a future async
    // hop in the kick path.
    await vi.advanceTimersByTimeAsync(70_000);

    // INVARIANT: in-flight WS MUST be closed after revocation.
    expect(ws.close).toHaveBeenCalled();
    expect(registry.get('agent-revoked')).toBeUndefined();
  });

  // Counter-test: catches a kick that closes WS too aggressively (e.g. an
  // inverted validate predicate).
  it('does NOT close in-flight WS when the token has not been revoked', async () => {
    const { store: tokenStore } = makeRevocableTokenStore(null);
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
