import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  INVALID_JOIN_REQUEST_MESSAGE,
  JOIN_PROTOCOL_V1_REMOVED_MESSAGE,
  JoinErrorCode,
  OrchRole,
} from '@kici-dev/engine';
import { JOIN_INTERNAL_ERROR_MESSAGE, JoinHandler } from './join-handler.js';
import {
  INVALID_JOIN_TOKEN_MESSAGE,
  ResolvedJoinTokenStatus,
  TOKEN_ALREADY_USED_MESSAGE,
  TOKEN_EXPIRED_MESSAGE,
  tokenHashOf,
  type ResolvedJoinToken,
} from './join-token.js';
import {
  createJoinRequest,
  openJoinResponse,
  type SealedJoinResponse,
} from './join-protocol-v2.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

const loggerHolder = vi.hoisted(() => ({
  joinHandler: undefined as
    undefined | { info: (...a: unknown[]) => unknown; warn: (...a: unknown[]) => unknown },
}));

vi.mock('@kici-dev/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kici-dev/shared')>();
  return {
    ...actual,
    createLogger: (opts?: { prefix?: string }) => {
      const real = actual.createLogger(opts);
      if (opts?.prefix === 'join-handler') loggerHolder.joinHandler = real as never;
      return real;
    },
  };
});

const ROUTING = { orgId: 'org-1', routingKey: 'github:42', expiry: 1_759_400_000_000 };

/** Token manager double: resolve/claim spies; the real crypto runs in the handler. */
function mockTokenManager(opts: {
  tokenHash: string;
  resolve?: ResolvedJoinToken;
  claimError?: string;
}) {
  return {
    resolveLiveTokenByRouting: vi.fn(
      async (_claim: unknown, accepts: (h: string) => boolean) =>
        opts.resolve ??
        (accepts(opts.tokenHash)
          ? { status: ResolvedJoinTokenStatus.enum.live, tokenHash: opts.tokenHash }
          : { status: ResolvedJoinTokenStatus.enum.unknown }),
    ),
    claimByHash: vi.fn(async () => {
      if (opts.claimError) throw new Error(opts.claimError);
      return {
        tokenHash: opts.tokenHash,
        role: OrchRole.enum.coordinator,
        routing: { ...ROUTING, role: OrchRole.enum.coordinator },
      };
    }),
  };
}

function v2Request(secretHex = randomBytes(32).toString('hex'), routing: object = ROUTING) {
  const routingB64 = Buffer.from(JSON.stringify(routing)).toString('base64url');
  const tokenHash = tokenHashOf(secretHex);
  const { fields, state } = createJoinRequest({
    routingB64,
    tokenHash: Buffer.from(tokenHash, 'hex'),
  });
  return {
    frame: { type: 'join.request' as const, messageId: 'm-1', ...fields },
    state,
    tokenHash,
  };
}

function createMockSharedConfigStore(config: Record<string, any> = {}) {
  return {
    getLatest: vi.fn().mockResolvedValue({
      config: {
        storage: { type: 's3', bucket: 'my-bucket', region: 'us-east-1' },
        secrets: { key: 'secret-key-123' },
        cluster: { joinToken: 'existing-token' },
        ...config,
      },
      version: 1,
    }),
    save: vi.fn().mockResolvedValue(2),
    getCurrentVersion: vi.fn().mockResolvedValue(1),
  };
}

function createMockClusterIdentity(clusterId = 'cluster-uuid-123') {
  return {
    getClusterId: vi.fn().mockResolvedValue(clusterId),
    validateS3Sentinel: vi.fn(),
  };
}

describe('JoinHandler', () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  function newHandler(tokenManager?: ReturnType<typeof mockTokenManager>) {
    const handler = new JoinHandler({
      db: mockDb.db as any,
      sharedConfigStore: createMockSharedConfigStore() as any,
      clusterIdentity: createMockClusterIdentity() as any,
      databaseUrl: 'postgres://localhost:5432/kici',
    });
    if (tokenManager) (handler as any).tokenManager = tokenManager;
    return handler;
  }

  // breaks-if-wrong: an untouched v2 exchange succeeds and the joiner opens the bundle.
  it('answers a v2 request with a sealed bundle only the joiner opens', async () => {
    const { frame, state, tokenHash } = v2Request();
    const tm = mockTokenManager({ tokenHash });
    const response = await newHandler(tm).handleJoinRequest(frame);

    expect(response).toMatchObject({
      type: 'join.response',
      messageId: 'm-1',
      success: true,
      joinProtocol: 2,
    });
    expect(response.serverPublicKey).toBeTypeOf('string');
    expect(response.serverNonce).toBeTypeOf('string');
    expect(response.serverProof).toMatch(/^[0-9a-f]{64}$/);
    expect(openJoinResponse(state, response as SealedJoinResponse)).toEqual({
      databaseUrl: 'postgres://localhost:5432/kici',
      storage: { type: 's3', bucket: 'my-bucket', region: 'us-east-1' },
      secretKey: 'secret-key-123',
      clusterId: 'cluster-uuid-123',
    });
    expect(tm.claimByHash).toHaveBeenCalledTimes(1);
    expect(tm.claimByHash).toHaveBeenCalledWith(tokenHash, 'joiner:github:42', 'joiner:github:42');
  });

  // fails-when: the handler parses or looks up before classifying.
  it('refuses a version-1 frame without any lookup', async () => {
    const tm = mockTokenManager({ tokenHash: 'x' });
    const response = await newHandler(tm).handleJoinRequest({
      type: 'join.request',
      messageId: 'm',
      token: 'kici_join_v1.a.b',
    });
    expect(response).toEqual({
      type: 'join.response',
      messageId: 'm',
      success: false,
      errorCode: JoinErrorCode.enum.join_protocol_v1_removed,
      error: JOIN_PROTOCOL_V1_REMOVED_MESSAGE,
    });
    expect(tm.resolveLiveTokenByRouting).not.toHaveBeenCalled();
    expect(tm.claimByHash).not.toHaveBeenCalled();
    expect(mockDb.mocks.selectFrom).not.toHaveBeenCalled();
    expect(mockDb.mocks.updateTable).not.toHaveBeenCalled();
  });

  it('refuses a version-1 frame that also carries v2 fields', async () => {
    const { frame, tokenHash } = v2Request();
    const tm = mockTokenManager({ tokenHash });
    const response = await newHandler(tm).handleJoinRequest({
      ...frame,
      token: 'kici_join_v1.a.b',
    });
    expect(response.errorCode).toBe(JoinErrorCode.enum.join_protocol_v1_removed);
    expect(tm.resolveLiveTokenByRouting).not.toHaveBeenCalled();
  });

  // fails-when: the proof is not verified before the claim, or T1 omits E_j.
  it('refuses a frame whose joiner key differs from the key its proof covers', async () => {
    const secretHex = randomBytes(32).toString('hex');
    const a = v2Request(secretHex);
    const b = v2Request(secretHex);
    const tm = mockTokenManager({ tokenHash: a.tokenHash });
    const response = await newHandler(tm).handleJoinRequest({
      ...a.frame,
      joinerPublicKey: b.frame.joinerPublicKey,
    });
    expect(response).toMatchObject({
      success: false,
      errorCode: JoinErrorCode.enum.invalid_token,
      error: INVALID_JOIN_TOKEN_MESSAGE,
    });
    expect(tm.claimByHash).not.toHaveBeenCalled();
  });

  it('maps unknown and expired lookups without claiming', async () => {
    const { frame, tokenHash } = v2Request();
    const unknown = mockTokenManager({
      tokenHash,
      resolve: { status: ResolvedJoinTokenStatus.enum.unknown },
    });
    expect(await newHandler(unknown).handleJoinRequest(frame)).toMatchObject({
      errorCode: JoinErrorCode.enum.invalid_token,
      error: INVALID_JOIN_TOKEN_MESSAGE,
    });
    expect(unknown.claimByHash).not.toHaveBeenCalled();

    const expired = mockTokenManager({
      tokenHash,
      resolve: { status: ResolvedJoinTokenStatus.enum.expired },
    });
    expect(await newHandler(expired).handleJoinRequest(frame)).toMatchObject({
      errorCode: JoinErrorCode.enum.token_expired,
      error: TOKEN_EXPIRED_MESSAGE,
    });
    expect(expired.claimByHash).not.toHaveBeenCalled();
  });

  it.each([
    [TOKEN_ALREADY_USED_MESSAGE, JoinErrorCode.enum.token_already_used],
    [TOKEN_EXPIRED_MESSAGE, JoinErrorCode.enum.token_expired],
    [INVALID_JOIN_TOKEN_MESSAGE, JoinErrorCode.enum.invalid_token],
  ])('maps the claim error %s to its code', async (message, code) => {
    const { frame, tokenHash } = v2Request();
    const response = await newHandler(
      mockTokenManager({ tokenHash, claimError: message }),
    ).handleJoinRequest(frame);
    expect(response).toMatchObject({
      success: false,
      errorCode: code,
      error: message,
      messageId: 'm-1',
    });
  });

  // fails-when: the handler echoes an unmapped error (a database error naming a host) to the
  //   unauthenticated requester.
  // breaks-if-wrong: the mapped claim errors keep their own message and code (test above).
  it('answers an internal failure with a generic message and no error code', async () => {
    const { frame, tokenHash } = v2Request();
    const response = await newHandler(
      mockTokenManager({ tokenHash, claimError: 'connection refused to db.internal:5432' }),
    ).handleJoinRequest(frame);
    expect(response).toEqual({
      type: 'join.response',
      messageId: 'm-1',
      success: false,
      error: JOIN_INTERNAL_ERROR_MESSAGE,
    });
    expect(JSON.stringify(response)).not.toContain('db.internal');
  });

  it('answers a malformed routing part or a non-X25519 key with invalid_request', async () => {
    const { frame, tokenHash } = v2Request();
    const tm = mockTokenManager({ tokenHash });
    const handler = newHandler(tm);
    expect(await handler.handleJoinRequest({ ...frame, routing: 'bm90LWpzb24' })).toMatchObject({
      errorCode: JoinErrorCode.enum.invalid_request,
      error: INVALID_JOIN_REQUEST_MESSAGE,
      messageId: 'm-1',
    });
    expect(
      await handler.handleJoinRequest({
        ...frame,
        joinerPublicKey: randomBytes(44).toString('base64'),
      }),
    ).toMatchObject({ errorCode: JoinErrorCode.enum.invalid_request });
    expect(
      await handler.handleJoinRequest({ type: 'join.request', messageId: 'm-2', joinProtocol: 2 }),
    ).toMatchObject({ errorCode: JoinErrorCode.enum.invalid_request, messageId: 'm-2' });
    expect(tm.resolveLiveTokenByRouting).not.toHaveBeenCalled();
  });

  // fails-when: the token hash (the join key root) is logged.
  it('logs a token fingerprint, never the token hash', async () => {
    const { frame, tokenHash } = v2Request();
    const handler = newHandler(mockTokenManager({ tokenHash }));
    const infoSpy = vi.spyOn(loggerHolder.joinHandler!, 'info');
    const warnSpy = vi.spyOn(loggerHolder.joinHandler!, 'warn');
    await handler.handleJoinRequest(frame);

    const call = infoSpy.mock.calls.find(([m]) => m === 'Join request accepted');
    expect(call?.[1]).toMatchObject({
      routingKey: 'github:42',
      clusterId: 'cluster-uuid-123',
      tokenFingerprint: expect.stringMatching(/^[0-9a-f]{12}$/),
    });
    const logged = JSON.stringify([...infoSpy.mock.calls, ...warnSpy.mock.calls]);
    expect(logged).not.toContain(tokenHash);
    expect(logged).not.toMatch(/"[0-9a-f]{64}"/);
  });

  // fails-when: a cluster whose shared configuration holds no secrets.key hands a joiner
  //   no KICI_SECRET_KEY, although the joined orchestrator needs the cluster's key.
  it("buildConfigBundle falls back to the orchestrator's own secrets key", async () => {
    const store = createMockSharedConfigStore();
    store.getLatest.mockResolvedValue({ config: { storage: { type: 's3' } }, version: 1 });
    const handler = new JoinHandler({
      db: mockDb.db as any,
      sharedConfigStore: store as any,
      clusterIdentity: createMockClusterIdentity() as any,
      databaseUrl: 'postgres://localhost:5432/kici',
      secretKey: 'running-key',
    });
    expect((await handler.buildConfigBundle()).secretKey).toBe('running-key');
  });

  // breaks-if-wrong: a secrets.key the operator set in the shared configuration still wins.
  it('buildConfigBundle prefers the shared secrets.key', async () => {
    const handler = new JoinHandler({
      db: mockDb.db as any,
      sharedConfigStore: createMockSharedConfigStore() as any,
      clusterIdentity: createMockClusterIdentity() as any,
      databaseUrl: 'postgres://localhost:5432/kici',
      secretKey: 'running-key',
    });
    expect((await handler.buildConfigBundle()).secretKey).toBe('secret-key-123');
  });

  it('buildConfigBundle includes databaseUrl, storage, secretKey and clusterId, never a PSK', async () => {
    const handler = new JoinHandler({
      db: mockDb.db as any,
      sharedConfigStore: createMockSharedConfigStore({ cluster: { psk: 'p' } }) as any,
      clusterIdentity: createMockClusterIdentity('my-cluster-id') as any,
      databaseUrl: 'postgres://localhost:5432/kici',
    });

    const bundle = await handler.buildConfigBundle();

    expect(bundle).toEqual({
      databaseUrl: 'postgres://localhost:5432/kici',
      storage: { type: 's3', bucket: 'my-bucket', region: 'us-east-1' },
      secretKey: 'secret-key-123',
      clusterId: 'my-cluster-id',
    });
  });
});
