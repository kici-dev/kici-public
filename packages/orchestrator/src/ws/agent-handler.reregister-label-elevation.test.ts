/**
 * Re-register-time labels are bounded by the token's `agent_tokens.labels`
 * scope, like the initial register.
 *
 * Trust model (must hold): the token-scope subset check of the FIRST
 * `agent.register` (Phase 2 / pendingRegistration block in `agent-handler.ts`)
 * MUST also run on every later `agent.register` on the same WS (the
 * re-register branch of the post-register switch). Otherwise a
 * `[ci, build]`-scoped agent re-registers with `[ci, build, prod, secret-vault]`,
 * `registry.register(...)` overwrites the authorized set with the wire labels,
 * and the next `job.dispatch.secrets` envelope carries prod-scoped secrets.
 *
 * Re-register also re-runs (a) the ephemeral identity binding
 * (`tokenCreatedBy === agentId`) and (b) the static-token agentId-collision
 * check; otherwise it could rebind the WS to any `msg.agentId` unvalidated.
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

function registerMsg(opts: { messageId?: string; agentId: string; labels: string[] }) {
  return {
    type: 'agent.register' as const,
    messageId: opts.messageId ?? 'msg-1',
    agentId: opts.agentId,
    labels: opts.labels,
  };
}

/**
 * Production storage shape: `labels` is JSON-encoded `string[]` or `null`.
 * Mirrors the helper in `agent-handler.label-elevation.test.ts`.
 */
function tokenStoreWithLabels(
  authorizedLabels: string[] | null,
  opts: {
    agent_type?: 'static' | 'ephemeral';
    created_by?: string | null;
  } = {},
): AgentTokenStore {
  return {
    validate: vi.fn().mockResolvedValue({
      id: 'tok-scoped',
      token_prefix: 'kat_scopedab',
      labels: authorizedLabels === null ? null : JSON.stringify(authorizedLabels),
      agent_type: opts.agent_type ?? 'static',
      created_at: new Date(),
      last_seen_at: null,
      created_by: opts.created_by ?? null,
      revoked_at: null,
      expires_at: null,
    }),
    createEphemeral: vi.fn(),
    createStatic: vi.fn(),
    revoke: vi.fn(),
    list: vi.fn(),
    cleanupExpired: vi.fn(),
  } as unknown as AgentTokenStore;
}

describe('agent re-register-time label-scope enforcement', () => {
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

  it('rejects elevated wire labels on re-register (registry must NOT be overwritten with the elevated set)', async () => {
    const tokenStore = tokenStoreWithLabels(['ci', 'build']);
    const handler = createAgentWsHandler({
      registry,
      dispatcher,
      agentAuthMode: 'token',
      tokenStore,
    });

    const ws = mockWs();
    handler.onOpen!(new Event('open'), ws as any);
    await handler.onMessage!(makeMessageEvent(authRequestMsg()), ws as any);

    // First register passes: wire labels are a subset of the token-bound set.
    await handler.onMessage!(
      makeMessageEvent(
        registerMsg({ messageId: 'msg-1', agentId: 'agent-1', labels: ['ci', 'build'] }),
      ),
      ws as any,
    );
    const afterFirst = registry.get('agent-1');
    expect(afterFirst).toBeDefined();
    expect(afterFirst!.labels).toEqual(new Set(['ci', 'build']));

    // Second register on the SAME WS attempts label elevation.
    await handler.onMessage!(
      makeMessageEvent(
        registerMsg({
          messageId: 'msg-2',
          agentId: 'agent-1',
          labels: ['ci', 'build', 'prod', 'secret-vault'],
        }),
      ),
      ws as any,
    );

    // The registry's labels MUST stay bounded by the token scope.
    const afterReregister = registry.get('agent-1');
    expect(afterReregister).toBeDefined();
    expect(afterReregister!.labels).toEqual(new Set(['ci', 'build']));
  });

  it('closes the WS with WS_CLOSE_AGENT_AUTH_FAILED on re-register elevation (no silent overwrite)', async () => {
    const tokenStore = tokenStoreWithLabels(['ci', 'build']);
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
      makeMessageEvent(
        registerMsg({ messageId: 'msg-1', agentId: 'agent-1', labels: ['ci', 'build'] }),
      ),
      ws as any,
    );
    // Sanity: clean first-register, no close.
    expect(ws.close).not.toHaveBeenCalled();

    await handler.onMessage!(
      makeMessageEvent(
        registerMsg({
          messageId: 'msg-2',
          agentId: 'agent-1',
          labels: ['ci', 'build', 'prod', 'secret-vault'],
        }),
      ),
      ws as any,
    );

    // Elevation is loud: the auth-failed close code, never a silent registry
    // overwrite that looks like a normal reconnect.
    expect(ws.close).toHaveBeenCalledWith(
      WS_CLOSE_AGENT_AUTH_FAILED,
      expect.stringContaining('exceed token-bound scope'),
    );
  });

  it('accepts a strict-subset re-register (voluntary scope-narrowing remains legitimate)', async () => {
    // Positive control: narrowing on re-register (e.g. a scaler-managed agent
    // dropping a transient label before draining) MUST be accepted — the check
    // is subset, not equality.
    const tokenStore = tokenStoreWithLabels(['ci', 'build', 'prod']);
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
      makeMessageEvent(
        registerMsg({ messageId: 'msg-1', agentId: 'agent-1', labels: ['ci', 'build', 'prod'] }),
      ),
      ws as any,
    );
    await handler.onMessage!(
      makeMessageEvent(registerMsg({ messageId: 'msg-2', agentId: 'agent-1', labels: ['ci'] })),
      ws as any,
    );

    const entry = registry.get('agent-1');
    expect(entry).toBeDefined();
    expect(entry!.labels).toEqual(new Set(['ci']));
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('accepts re-register wire labels verbatim when the token has no authorized-labels constraint (labels: null)', async () => {
    // Back-compat carve-out: a `null` `agent_tokens.labels` (tokens issued before
    // it was enforced) accepts any wire labels at register AND re-register.
    const tokenStore = tokenStoreWithLabels(null);
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
      makeMessageEvent(registerMsg({ messageId: 'msg-1', agentId: 'agent-1', labels: ['ci'] })),
      ws as any,
    );
    await handler.onMessage!(
      makeMessageEvent(
        registerMsg({
          messageId: 'msg-2',
          agentId: 'agent-1',
          labels: ['ci', 'build', 'prod', 'secret-vault'],
        }),
      ),
      ws as any,
    );

    const entry = registry.get('agent-1');
    expect(entry).toBeDefined();
    expect(entry!.labels).toEqual(new Set(['ci', 'build', 'prod', 'secret-vault']));
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('rejects re-register with a different agentId for ephemeral tokens (tokenCreatedBy binding)', async () => {
    // The ephemeral identity binding from Phase 2 (`tokenCreatedBy === agentId`)
    // also runs on re-register; otherwise a leaked ephemeral token bound to
    // 'agent-original' could re-register as another agentId on the same WS.
    const tokenStore = tokenStoreWithLabels(null, {
      agent_type: 'ephemeral',
      created_by: 'agent-original',
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

    // First register honors the binding: agentId === tokenCreatedBy.
    await handler.onMessage!(
      makeMessageEvent(
        registerMsg({ messageId: 'msg-1', agentId: 'agent-original', labels: ['ci'] }),
      ),
      ws as any,
    );
    expect(registry.get('agent-original')).toBeDefined();
    expect(ws.close).not.toHaveBeenCalled();

    // Re-register attempts to claim a different agentId on the same WS.
    await handler.onMessage!(
      makeMessageEvent(
        registerMsg({ messageId: 'msg-2', agentId: 'agent-impersonated', labels: ['ci'] }),
      ),
      ws as any,
    );

    // Rejected: the impersonated agentId never enters the registry.
    expect(registry.get('agent-impersonated')).toBeUndefined();
    expect(ws.close).toHaveBeenCalledWith(
      WS_CLOSE_AGENT_AUTH_FAILED,
      expect.stringContaining('Ephemeral token bound to a different agentId'),
    );
  });
});
