/**
 * regression: agent re-register-time label scope is bounded by the
 * token's `agent_tokens.labels` authorization scope, just like the
 * initial-register-time check.
 *
 * Trust model (must hold):
 *   The token-scope subset enforcement that runs at the FIRST
 *   `agent.register` (Phase 2 / pendingRegistration block in
 *   `agent-handler.ts`) MUST also run on every subsequent
 *   `agent.register` arriving on the same registered WS connection
 *   (the re-register branch inside the post-register switch). Without
 *   this, an authenticated agent with a `[ci, build]`-scoped token can
 *   register cleanly with `[ci, build]`, then send a second
 *   `agent.register` with `[ci, build, prod, secret-vault]` on the same
 *   WS — the re-register branch calls `registry.register(...)` with the
 *   wire-supplied labels directly, silently overwriting the previously
 *   authorized label set. The agent then receives prod-scoped secrets
 *   in the next `job.dispatch.secrets` envelope.
 *
 *   The re-register path also guards (a) the ephemeral identity-binding
 *   check (`tokenCreatedBy === agentId` for ephemeral tokens) and
 *   (b) the static-token agentId-collision check. Both gates currently
 *   only run on the first register; a re-register can supply any
 *   `msg.agentId` and rebind the WS to it without re-validation.
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

function registerMsg(opts: { messageId?: string; agentId: string; labels: string[] }) {
  return {
    type: 'agent.register' as const,
    messageId: opts.messageId ?? 'msg-1',
    agentId: opts.agentId,
    labels: opts.labels,
  };
}

/**
 * Build a token store whose `validate()` returns a token row matching the
 * production storage shape: `labels` is JSON-encoded `string[]` or `null`.
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

    // Second register on the SAME WS attempts label elevation. The
    // re-register branch in agent-handler.ts must re-run the same
    // token-scope check that the initial-register Phase 2 block runs.
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

    // Registry's labels MUST stay bounded by the token scope after the
    // elevation attempt — the re-register branch re-runs the same
    // token-scope subset gate the first register ran.
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

    // Re-register elevation is loud — the WS is closed with the
    // auth-failed close code rather than silently overwriting the
    // registry entry on what would otherwise look like a normal
    // reconnect.
    expect(ws.close).toHaveBeenCalledWith(
      WS_CLOSE_AGENT_AUTH_FAILED,
      expect.stringContaining('exceed token-bound scope'),
    );
  });

  it('accepts a strict-subset re-register (voluntary scope-narrowing remains legitimate)', async () => {
    // Positive control: an agent that voluntarily narrows its label set on
    // re-register (e.g. a scaler-managed agent dropping a transient label
    // before draining) MUST continue to be accepted. The fix is a
    // subset-not-equality check.
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
    // Back-compat carve-out: tokens issued before `agent_tokens.labels`
    // became an enforced authorization signal (column value `null`)
    // continue to accept any wire labels at register AND re-register
    // time. The fix must preserve this exception for both paths.
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
    // Adjacent gap: the ephemeral identity-binding check in Phase 2
    // (`tokenCreatedBy === agentId`) is also bypassed on re-register.
    // An A5 holding a leaked ephemeral token bound to agentId
    // 'agent-original' could re-register as a different agentId on the
    // same WS. Post-fix expectation: the re-register branch re-runs the
    // identity-binding check and closes the WS with auth-failed.
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

    // The re-register is rejected and the impersonated agentId never
    // enters the registry — the re-register branch re-runs the same
    // ephemeral identity-binding gate the first register ran.
    expect(registry.get('agent-impersonated')).toBeUndefined();
    expect(ws.close).toHaveBeenCalledWith(
      WS_CLOSE_AGENT_AUTH_FAILED,
      expect.stringContaining('Ephemeral token bound to a different agentId'),
    );
  });
});
