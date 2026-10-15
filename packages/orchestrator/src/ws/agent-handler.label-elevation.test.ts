/**
 * Regression: agent register-time labels are bounded by the token's
 * `agent_tokens.labels` authorization scope.
 *
 * The wire `agent.register.labels` MUST be a subset of that set; a label
 * outside it closes the WS with `WS_CLOSE_AGENT_AUTH_FAILED`. `labels === null`
 * is an unscoped token (minted without `--labels`) with no constraint. Without
 * the check, a `[ci, build]` token could register as `[ci, build, prod,
 * secret-vault]` and harvest `prod` secrets resolved at dispatch time.
 *
 * Production stores `agent_tokens.labels` as `text` holding
 * `JSON.stringify(string[])` (or `null`); the mock mirrors that encoding so a
 * storage-shape swap fails here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PROTOCOL_VERSION, resolveRoleLabels, WS_CLOSE_AGENT_AUTH_FAILED } from '@kici-dev/engine';
import { createAgentWsHandler } from './agent-handler.js';
import { authorizedAgentTokenLabels } from '../cli/commands/agent.js';
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

/** `labels` is JSON-encoded `string[]` or `null`, as production stores it. */
function tokenStoreWithLabels(authorizedLabels: string[] | null): AgentTokenStore {
  return {
    validate: vi.fn().mockResolvedValue({
      id: 'tok-scoped',
      token_prefix: 'kat_scopedab',
      labels: authorizedLabels === null ? null : JSON.stringify(authorizedLabels),
      agent_type: 'static',
      created_at: new Date(),
      last_seen_at: null,
      created_by: null,
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

describe('agent register-time label-scope enforcement', () => {
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

  it('rejects wire labels that exceed the token-bound authorized set', async () => {
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

    // A compromised agent with a `[ci, build]`-scoped token claims an elevated set
    // including `prod` and `secret-vault`.
    await handler.onMessage!(
      makeMessageEvent(
        registerMsg({
          agentId: 'agent-elevated',
          labels: ['ci', 'build', 'prod', 'secret-vault'],
        }),
      ),
      ws as any,
    );

    // The close reason names the elevated labels for operator debuggability.
    expect(registry.get('agent-elevated')).toBeUndefined();
    expect(ws.close).toHaveBeenCalledWith(
      WS_CLOSE_AGENT_AUTH_FAILED,
      expect.stringContaining('exceed token-bound scope'),
    );
    const closeReason = (ws.close as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] ?? '';
    expect(closeReason).toContain('prod');
    expect(closeReason).toContain('secret-vault');
  });

  it('rejects wire labels that have NO overlap with the token-bound set', async () => {
    // Every wire label is unauthorized: the check must not assume a shared label.
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
      makeMessageEvent(registerMsg({ agentId: 'agent-disjoint', labels: ['prod'] })),
      ws as any,
    );

    expect(registry.get('agent-disjoint')).toBeUndefined();
    expect(ws.close).toHaveBeenCalledWith(
      WS_CLOSE_AGENT_AUTH_FAILED,
      expect.stringContaining('exceed token-bound scope'),
    );
  });

  it('accepts a wire-label set that is a strict subset of the token-bound scope', async () => {
    // Voluntary scope-narrowing is legitimate routing: the check is subset,
    // not equality.
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
      makeMessageEvent(registerMsg({ agentId: 'agent-narrowed', labels: ['ci'] })),
      ws as any,
    );

    const entry = registry.get('agent-narrowed');
    expect(entry).toBeDefined();
    expect(entry!.labels).toEqual(new Set(['ci']));
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('admits an agent whose wire labels differ from the token scope only by case', async () => {
    // Label matching folds case; treating a case difference as elevation closes
    // the socket with an auth failure the operator cannot act on.
    const tokenStore = tokenStoreWithLabels(['GPU', 'Linux']);
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
      makeMessageEvent(registerMsg({ agentId: 'agent-mixed-case', labels: ['gpu', 'linux'] })),
      ws as any,
    );

    expect(ws.close).not.toHaveBeenCalled();
    const entry = registry.get('agent-mixed-case');
    expect(entry).toBeDefined();
    expect(entry!.labels).toEqual(new Set(['gpu', 'linux']));
  });

  it('stores the canonical form of a label the agent advertises in mixed case', async () => {
    // The registry is the matching domain, so it holds folded labels: a `docker`
    // selector must reach an agent that advertised `Docker`.
    const tokenStore = tokenStoreWithLabels(['Docker']);
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
      makeMessageEvent(registerMsg({ agentId: 'agent-canonical-store', labels: ['Docker'] })),
      ws as any,
    );

    expect(registry.get('agent-canonical-store')?.labels).toEqual(new Set(['docker']));
  });

  it('still refuses a mixed-case privileged-root claim from a non-root agent', async () => {
    // Control for the fold above: a Gate 0 that did not fold would miss
    // `KICI:PRIVILEGED:ROOT` and hand the agent root-demanding jobs. The token
    // authorizes the label, which isolates Gate 0 from Gate 1.
    const tokenStore = tokenStoreWithLabels(['KICI:PRIVILEGED:ROOT']);
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
        registerMsg({ agentId: 'agent-shouty-root', labels: ['KICI:PRIVILEGED:ROOT'] }),
      ),
      ws as any,
    );

    expect(registry.get('agent-shouty-root')).toBeUndefined();
    expect(ws.close).toHaveBeenCalledWith(
      WS_CLOSE_AGENT_AUTH_FAILED,
      expect.stringContaining('privileged-root token presented by non-root agent'),
    );
  });

  it('accepts wire labels verbatim when the token has no authorized-labels constraint (labels: null)', async () => {
    // Back-compat for unscoped tokens; removing it breaks every deployment
    // that holds one.
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
      makeMessageEvent(registerMsg({ agentId: 'agent-unscoped', labels: ['ci', 'build', 'prod'] })),
      ws as any,
    );

    const entry = registry.get('agent-unscoped');
    expect(entry).toBeDefined();
    expect(entry!.labels).toEqual(new Set(['ci', 'build', 'prod']));
  });
});

/**
 * Regression: a token minted by `kici-admin agent register --labels …` must
 * admit the real agent that presents it.
 *
 * An agent derives its `kici:role:*` labels from its host, which the mint site
 * cannot know, so the minted scope carries the whole role namespace. Without
 * that, the documented `--labels linux,x64,gpu` example mints a token every
 * real agent is refused on with close code 4010. These tests drive the REAL
 * gate with the REAL mint-side scope, so neither half can drift alone.
 */
describe('a CLI-minted label scope admits the agent that presents it', () => {
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

  /** The token is minted as `kici-admin agent register --labels linux,x64`. */
  async function registerAgainstCliMintedToken(agentId: string, labels: string[]) {
    const tokenStore = tokenStoreWithLabels(
      authorizedAgentTokenLabels(['linux', 'x64'], undefined)!,
    );
    const handler = createAgentWsHandler({
      registry,
      dispatcher,
      agentAuthMode: 'token',
      tokenStore,
    });

    const ws = mockWs();
    handler.onOpen!(new Event('open'), ws as any);
    await handler.onMessage!(makeMessageEvent(authRequestMsg()), ws as any);
    await handler.onMessage!(makeMessageEvent(registerMsg({ agentId, labels })), ws as any);
    return ws;
  }

  it('admits an agent advertising its host-derived role labels', async () => {
    const ws = await registerAgainstCliMintedToken('agent-with-roles', [
      'linux',
      'x64',
      ...resolveRoleLabels(undefined),
    ]);

    expect(ws.close).not.toHaveBeenCalled();
    expect(registry.get('agent-with-roles')).toBeDefined();
  });

  it('still refuses an agent advertising a label the operator did not authorize', async () => {
    // The control: authorizing the role namespace must not authorize everything.
    // A fix that widened the scope wholesale would pass the case above and fail here.
    const ws = await registerAgainstCliMintedToken('agent-elevating-gpu', [
      'linux',
      'x64',
      ...resolveRoleLabels(undefined),
      'gpu',
    ]);

    expect(registry.get('agent-elevating-gpu')).toBeUndefined();
    expect(ws.close).toHaveBeenCalledWith(
      WS_CLOSE_AGENT_AUTH_FAILED,
      expect.stringContaining('gpu'),
    );
  });
});
