/**
 * A live agent id belongs to the agent token it registered with: a
 * registration under another token must not take it over. The coordinator
 * builds one WebSocket handler per connection (`app.ts` `upgradeWebSocket`),
 * so every test here drives each socket through its own handler over one
 * shared registry, as production does. The legitimate re-registrations — a
 * reconnect, a rotated or new token once the old connection has gone, a
 * revoked token's successor — must keep working.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import {
  PROTOCOL_VERSION,
  WS_CLOSE_INVALID_MESSAGE,
  WS_CLOSE_AGENT_AUTH_FAILED,
} from '@kici-dev/engine';
import { AGENT_ID_IN_USE, createAgentWsHandler, type AgentWsHandlerDeps } from './agent-handler.js';
import { AgentRegistry } from '../agent/registry.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import type { AgentTokenStore } from '../agent/token-store.js';
import { mockWs } from '../__test-helpers__/mock-ws.js';

/** Static agent tokens by bearer value; the row id is what the registry records. */
const TOKENS: Record<string, string> = {
  ['kat_' + 'a'.repeat(64)]: 'tok-a',
  ['kat_' + 'b'.repeat(64)]: 'tok-b',
};
const TOKEN_A = 'kat_' + 'a'.repeat(64);
const TOKEN_B = 'kat_' + 'b'.repeat(64);

function tokenStore(): AgentTokenStore {
  return {
    validate: vi.fn(async (token: string) =>
      TOKENS[token]
        ? {
            id: TOKENS[token],
            token_prefix: token.slice(0, 12),
            labels: null,
            agent_type: 'static',
            created_at: new Date(),
            last_seen_at: null,
            created_by: null,
            revoked_at: null,
            expires_at: null,
          }
        : null,
    ),
    consumeBootstrapToken: vi.fn().mockResolvedValue(true),
  } as unknown as AgentTokenStore;
}

/** A dispatcher whose disconnect triage unregisters the agent, as the real one does. */
function mockDispatcher(registry: AgentRegistry): Dispatcher {
  return {
    dispatch: vi.fn().mockResolvedValue({ status: 'queued', jobId: 'test' }),
    onAgentAvailable: vi.fn().mockResolvedValue(undefined),
    onAgentDisconnect: vi.fn(async (agentId: string) => {
      registry.unregister(agentId);
      return [];
    }),
    onJobComplete: vi.fn(),
    releaseRebootPending: vi.fn().mockResolvedValue(undefined),
    setDisconnectCleanup: vi.fn(),
  } as unknown as Dispatcher;
}

const event = (data: unknown) => ({ data: JSON.stringify(data) }) as MessageEvent;

describe('a live agent id cannot be taken over by another agent token', () => {
  let registry: AgentRegistry;
  let store: AgentTokenStore;
  let onScalerAgentRegistered: Mock<NonNullable<AgentWsHandlerDeps['onScalerAgentRegistered']>>;

  beforeEach(() => {
    registry = new AgentRegistry();
    store = tokenStore();
    onScalerAgentRegistered = vi.fn<NonNullable<AgentWsHandlerDeps['onScalerAgentRegistered']>>();
    onScalerAgentRegistered.mockResolvedValue(null);
  });

  /** One connection's handler, as the coordinator builds per socket. */
  function connection() {
    const handler = createAgentWsHandler({
      registry,
      dispatcher: mockDispatcher(registry),
      agentAuthMode: 'token',
      tokenStore: store,
      onScalerAgentRegistered,
    });
    const ws = mockWs();
    handler.onOpen!(new Event('open'), ws as any);
    return { handler, ws };
  }

  /** Authenticate with `token` and register as `agentId`; resolves when handled. */
  async function register(
    conn: ReturnType<typeof connection>,
    token: string,
    agentId = 'agent-1',
  ): Promise<void> {
    await conn.handler.onMessage!(
      event({ type: 'auth.request', token, protocolVersion: PROTOCOL_VERSION }),
      conn.ws as any,
    );
    await conn.handler.onMessage!(
      event({ type: 'agent.register', messageId: 'm', agentId, labels: ['linux'] }),
      conn.ws as any,
    );
  }

  function sentFrames(ws: ReturnType<typeof mockWs>): Array<Record<string, unknown>> {
    return (ws.send as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string) as Record<string, unknown>,
    );
  }

  it('refuses a registration under another token while the id is live', async () => {
    // fails-when: the collision check reads per-connection state, so the second
    //   connection's handler sees no binding and the registration takes the id over
    // breaks-if-wrong: the live registration stays bound to its own socket
    const live = connection();
    await register(live, TOKEN_A);
    const intruder = connection();
    await register(intruder, TOKEN_B);

    expect(intruder.ws.close).toHaveBeenCalledWith(
      WS_CLOSE_INVALID_MESSAGE,
      'AgentId already registered with a different token',
    );
    // A retryable code: a legitimate successor waiting for the old connection
    // to go keeps retrying.
    expect(intruder.ws.close).not.toHaveBeenCalledWith(
      WS_CLOSE_AGENT_AUTH_FAILED,
      expect.anything(),
    );
    expect(sentFrames(intruder.ws)).toContainEqual(
      expect.objectContaining({ type: 'error', code: AGENT_ID_IN_USE }),
    );
    expect(registry.get('agent-1')?.ws).toBe(live.ws);
    expect(registry.get('agent-1')?.tokenId).toBe('tok-a');
  });

  it('refuses another token while the id is still registering on another connection', async () => {
    // fails-when: only the live registration is checked, so two tokens that race
    //   through the scaler lookup both register and the later one wins
    let release!: () => void;
    onScalerAgentRegistered.mockReturnValueOnce(
      new Promise<null>((r) => {
        release = () => r(null);
      }),
    );
    const first = connection();
    const firstRegistering = register(first, TOKEN_A);
    await vi.waitFor(() => expect(onScalerAgentRegistered).toHaveBeenCalledTimes(1));

    const second = connection();
    await register(second, TOKEN_B);
    release();
    await firstRegistering;

    expect(second.ws.close).toHaveBeenCalledWith(
      WS_CLOSE_INVALID_MESSAGE,
      'AgentId already registered with a different token',
    );
    expect(registry.get('agent-1')?.ws).toBe(first.ws);
  });

  it('lets the same token reconnect on a new connection', async () => {
    // breaks-if-wrong: a reconnect after a network drop presents the same token
    const before = connection();
    await register(before, TOKEN_A);
    const after = connection();
    await register(after, TOKEN_A);

    expect(after.ws.close).not.toHaveBeenCalled();
    expect(registry.get('agent-1')?.ws).toBe(after.ws);
  });

  it('lets a rotated token register once the old connection has closed', async () => {
    // breaks-if-wrong: an agent restarted with a new token after its old process
    //   exited registers at once
    const old = connection();
    await register(old, TOKEN_A);
    old.handler.onClose!(new CloseEvent('close'), old.ws as any);

    const rotated = connection();
    await register(rotated, TOKEN_B);

    expect(rotated.ws.close).not.toHaveBeenCalled();
    expect(registry.get('agent-1')?.tokenId).toBe('tok-b');
  });

  it('lets a rotated token in on retry once the heartbeat timeout drops a half-open connection', async () => {
    // breaks-if-wrong: the refused successor gets the id as soon as the old
    //   registration is gone, with no operator action
    const old = connection();
    await register(old, TOKEN_A);
    const refused = connection();
    await register(refused, TOKEN_B);
    expect(refused.ws.close).toHaveBeenCalled();

    // The heartbeat monitor unregisters a silent agent through the dispatcher.
    registry.unregister('agent-1');
    const retry = connection();
    await register(retry, TOKEN_B);

    expect(retry.ws.close).not.toHaveBeenCalled();
    expect(registry.get('agent-1')?.tokenId).toBe('tok-b');
  });

  it('lets a successor register once the old token is revoked', async () => {
    // breaks-if-wrong: revoking the old token frees its agent ids at once
    const old = connection();
    await register(old, TOKEN_A);
    registry.disconnectByTokenId('tok-a');

    const successor = connection();
    await register(successor, TOKEN_B);

    expect(successor.ws.close).not.toHaveBeenCalled();
    expect(registry.get('agent-1')?.tokenId).toBe('tok-b');
  });

  it('keeps the token binding when a live socket registers again', async () => {
    // fails-when: the re-register drops the entry's token id, so revoking the
    //   token no longer disconnects the socket and another token can take the id
    const live = connection();
    await register(live, TOKEN_A);
    await live.handler.onMessage!(
      event({ type: 'agent.register', messageId: 'm2', agentId: 'agent-1', labels: ['linux'] }),
      live.ws as any,
    );
    expect(live.ws.close).not.toHaveBeenCalled();
    expect(registry.get('agent-1')?.tokenId).toBe('tok-a');

    const intruder = connection();
    await register(intruder, TOKEN_B);
    expect(intruder.ws.close).toHaveBeenCalledWith(
      WS_CLOSE_INVALID_MESSAGE,
      'AgentId already registered with a different token',
    );

    expect(registry.disconnectByTokenId('tok-a')).toBe(1);
    expect(live.ws.close).toHaveBeenCalledWith(WS_CLOSE_AGENT_AUTH_FAILED, 'Token revoked');
  });

  it('still lets a socket with no token auth register again', async () => {
    // breaks-if-wrong: with agent auth off the entry carries no token, and a
    //   second register on the same socket keeps working
    const handler = createAgentWsHandler({
      registry,
      dispatcher: mockDispatcher(registry),
      agentAuthMode: 'none',
      onScalerAgentRegistered,
    });
    const ws = mockWs();
    handler.onOpen!(new Event('open'), ws as any);
    for (const messageId of ['m1', 'm2']) {
      await handler.onMessage!(
        event({ type: 'agent.register', messageId, agentId: 'agent-1', labels: ['linux'] }),
        ws as any,
      );
    }
    expect(ws.close).not.toHaveBeenCalled();
    expect(registry.get('agent-1')?.ws).toBe(ws);
    expect(registry.get('agent-1')?.tokenId).toBeNull();
  });

  it('still lets one static token serve many agent ids', async () => {
    // breaks-if-wrong: an operator-distributed static token is N-use by design
    const one = connection();
    await register(one, TOKEN_A, 'agent-1');
    const two = connection();
    await register(two, TOKEN_A, 'agent-2');

    expect(two.ws.close).not.toHaveBeenCalled();
    expect(registry.get('agent-2')?.tokenId).toBe('tok-a');
  });
});
