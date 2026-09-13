/**
 * pentest repro: agent-token revocation does not close in-flight
 * agent WS connections.
 *
 * Trust model the system claims to hold:
 *   When an admin revokes an agent token (via
 *   `kici-admin agent token revoke <id>` -> DELETE /api/v1/agent-tokens/:id
 *   -> `tokenStore.revoke(id)`), every agent WS authenticated by that
 *   token MUST be closed within a bounded window. The agent must not
 *   retain data-plane access — job claims, log streaming, secret receipt
 *   — past the revocation.
 *
 *   Today the orchestrator's agent WS handler validates the token only
 *   once at the auth phase. After `register.ack` the WS stays open until
 *   the agent disconnects. `tokenStore.revoke(id)` writes `revoked_at` to
 *   the DB and returns; the existing connection is unaffected. An A10
 *   stolen-credential attacker retains data-plane access until they
 *   choose to drop the connection (typically days for a stable agent).
 *
 * This is the direct parallel of finding `orch-token-stale-revoke`
 *   (HIGH, fixed in `4fbfba7b4`) on the orch->Platform leg. The
 *   architectural fix on that leg added a synchronous local kick + a
 *   `kici:revoke-key` Valkey channel for cross-instance fan-out. The
 *   agent->orch leg is single-instance per tenant (the orchestrator is
 *   single-tenant) so the same wiring without the cross-instance hop is
 *   the natural fix shape.
 *
 * This test asserts the desired invariant (revocation propagates to
 * in-flight WS within a bounded window). It is currently expected to fail
 * (`it.fails`). When the fix lands, flip `it.fails` -> `it`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
 * Token store that:
 * - returns a valid token row on `validate(...)` initially
 * - flips its internal `revoked` flag on `revoke(...)` so subsequent
 *   `validate()` calls return null (mirrors production semantics: revoked_at IS NULL gate)
 *
 * Lets the test simulate a revocation that the fix's re-validation /
 * listener / kick path can observe.
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
 * Simulate the admin DELETE /api/v1/agent-tokens/:id flow at unit-test
 * scope. The real handler:
 *   1) calls `tokenStore.revoke(id)` (DB write)
 *   2) calls `agentRegistry.disconnectByTokenId(id)` (in-flight WS kick)
 *
 * The kick step is the fix; without it the WS stays open until the
 * agent itself disconnects.
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

describe(' agent-token revocation propagation to in-flight WS', () => {
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

    // Sanity: agent is registered and connection is open.
    expect(registry.get('agent-revoked')).toBeDefined();
    expect(ws.close).not.toHaveBeenCalled();

    // Admin revokes the token via the normal path: DB row update +
    // synchronous registry kick. Replicates what the real DELETE
    // /api/v1/agent-tokens/:id route does, without spinning up the
    // HTTP layer at unit-test scope.
    const { revoked, kicked } = await adminRevoke(registry, tokenStore, 'tok-revocable');
    expect(revoked).toBe(true);
    expect(isRevoked()).toBe(true);
    expect(kicked).toBe(1);

    // The kick is synchronous, so the close MUST already be visible
    // before any timers run. We still advance time as a guard against
    // any future async hop sneaking into the kick path.
    await vi.advanceTimersByTimeAsync(70_000);

    // INVARIANT: in-flight WS MUST be closed after revocation.
    expect(ws.close).toHaveBeenCalled();
    expect(registry.get('agent-revoked')).toBeUndefined();
  });

  // Sanity counter-test: a NON-revoked agent must remain connected after
  // the same elapsed time. Catches a regression where the fix's mechanism
  // closes WS too aggressively (e.g., closes every WS on every poll
  // because the validate predicate inverted).
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
