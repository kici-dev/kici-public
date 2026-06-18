/**
 * pentest repro: natural TTL expiry does not close in-flight agent
 * WS connections (sister finding to the revoke-stale-WS finding,
 * with `expires_at` passing naturally as the trigger instead of
 * `revoked_at`).
 *
 * Trust model the system claims to hold:
 *   When an ephemeral agent token's `expires_at` passes, every in-flight
 *   WS authenticated by that token MUST be closed within a bounded
 *   window. The agent must not retain data-plane access — job claims, log
 *   streaming, secret receipt — past the token's TTL.
 *
 *   Today the orchestrator's agent WS handler validates the token only
 *   once at the auth phase (agent-handler.ts:514, `tokenStore.validate`).
 * The revoke fix (`993bc3d9d`) added a synchronous local kick on
 *   the admin DELETE route, but there is NO equivalent kick path for
 *   natural TTL expiration: when `expires_at` passes without a revoke
 *   call, nothing closes the WS. An A10 attacker who stole an ephemeral
 *   token within its TTL connects, authenticates, and keeps the
 *   authenticated WS alive past expiry — same data-plane authority as
 *   before, even though the token is "expired" in the DB.
 *
 * The fix mirrors revoke's local-kick pattern with TTL as the
 *   trigger: at register-time, the agent WS handler schedules a
 *   per-token kick timer keyed on `tokenRow.expires_at` via
 *   `AgentRegistry.scheduleExpiryKick(...)`. When the timer fires,
 *   `disconnectByTokenId(tokenId)` closes every in-flight WS under
 *   that token. Static tokens have `expires_at = null` by design and
 *   are skipped at the call site.
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
 * Token store whose `validate()` mirrors production semantics: returns
 * the row only while `expires_at > now()`; returns null once the clock
 * has advanced past the token's TTL. The DB-equivalent is the WHERE
 * clause `expires_at IS NULL OR expires_at > now()` in
 * `AgentTokenStore.validate()`.
 *
 * The fix's most natural shape is a per-token kick timer scheduled at
 * auth time keyed on `expires_at`. Whatever the fix mechanism, on TTL
 * firing it must (a) close the WS with an auth-failure code and (b)
 * unregister the agent from the registry.
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
      // Mirror the production WHERE clause: row only matches while
      // expires_at is in the future.
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

describe(' ephemeral-token natural TTL expiry propagates to in-flight WS', () => {
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
    // Ephemeral token with a 10s TTL. The agent authenticates 9s before
    // expiry — past expiry, the in-flight WS must be kicked.
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

    // Sanity: registered, WS open.
    expect(registry.get('agent-expiring')).toBeDefined();
    expect(ws.close).not.toHaveBeenCalled();

    // Advance past the token's TTL. The fix's kick path (per-token
    // timer / cleanup-cycle disconnect / poll loop) must observe the
    // expiration and kick the WS within a bounded window. We give it
    // generous slack (60s past TTL) so an implementation with a 30s
    // poll interval still passes.
    await vi.advanceTimersByTimeAsync(70_000);

    // INVARIANT (, TTL): in-flight WS MUST be closed after natural
    // TTL expiry. Same architectural rule as the revoke fix; just
    // a different trigger.
    expect(ws.close).toHaveBeenCalled();
    expect(registry.get('agent-expiring')).toBeUndefined();
  });

  it('does NOT close in-flight WS while the ephemeral token is still within its TTL', async () => {
    // Counter-test: a token with TTL=1h must remain connected after the
    // same 70s advance used in the failing repro. Catches a regression
    // where the fix's kick mechanism fires too aggressively (e.g., a
    // poll loop that closes every WS instead of only the expired ones).
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
