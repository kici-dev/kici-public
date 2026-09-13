import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { JoinRequest } from '@kici-dev/engine';
import { JoinHandler } from './join-handler.js';
import { deriveKeys, encryptBundle, decryptBundle, parseToken } from './join-token.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

function createMockTokenManager(
  opts: {
    valid?: boolean;
    expired?: boolean;
    consumed?: boolean;
  } = {},
) {
  const { valid = true, expired = false, consumed = false } = opts;

  return {
    validateAndConsumeToken: vi.fn().mockImplementation(async (token: string) => {
      if (!valid) throw new Error('Invalid join token');
      if (expired)
        throw new Error(
          'Join token has expired. Generate a new token with: kici admin create-join-token',
        );
      if (consumed)
        throw new Error(
          'Join token has already been used. Generate a new token with: kici admin create-join-token',
        );

      const parsed = parseToken(token);
      const keys = deriveKeys(Buffer.from(parsed.secretHex, 'hex'));
      return { routing: parsed.routing, keys };
    }),
    createToken: vi.fn(),
  };
}

function createTestToken() {
  const routing = { orgId: 'org-1', routingKey: 'github:42', expiry: Date.now() + 3600_000 };
  const routingB64 = Buffer.from(JSON.stringify(routing)).toString('base64url');
  const secretHex = randomBytes(32).toString('hex');
  return `kici_join_v1.${routingB64}.${secretHex}`;
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

  it('handleJoinRequest with valid token returns success=true and encrypted bundle', async () => {
    const token = createTestToken();
    const handler = new JoinHandler({
      db: mockDb.db as any,
      sharedConfigStore: createMockSharedConfigStore() as any,
      clusterIdentity: createMockClusterIdentity() as any,
      databaseUrl: 'postgres://localhost:5432/kici',
    });

    // Override the internal token manager with our mock
    (handler as any).tokenManager = createMockTokenManager();

    const request: JoinRequest = { type: 'join.request', token };
    const response = await handler.handleJoinRequest(request);

    expect(response.type).toBe('join.response');
    expect(response.success).toBe(true);
    expect(response.encryptedBundle).toBeDefined();
    expect(typeof response.encryptedBundle).toBe('string');
  });

  it('handleJoinRequest with expired token returns success=false with expiry error', async () => {
    const token = createTestToken();
    const handler = new JoinHandler({
      db: mockDb.db as any,
      sharedConfigStore: createMockSharedConfigStore() as any,
      clusterIdentity: createMockClusterIdentity() as any,
      databaseUrl: 'postgres://localhost:5432/kici',
    });

    (handler as any).tokenManager = createMockTokenManager({ expired: true });

    const request: JoinRequest = { type: 'join.request', token };
    const response = await handler.handleJoinRequest(request);

    expect(response.success).toBe(false);
    expect(response.error).toContain('expired');
  });

  it('handleJoinRequest with consumed token returns success=false with consumed error', async () => {
    const token = createTestToken();
    const handler = new JoinHandler({
      db: mockDb.db as any,
      sharedConfigStore: createMockSharedConfigStore() as any,
      clusterIdentity: createMockClusterIdentity() as any,
      databaseUrl: 'postgres://localhost:5432/kici',
    });

    (handler as any).tokenManager = createMockTokenManager({ consumed: true });

    const request: JoinRequest = { type: 'join.request', token };
    const response = await handler.handleJoinRequest(request);

    expect(response.success).toBe(false);
    expect(response.error).toContain('already been used');
  });

  it('handleJoinRequest with invalid token format returns success=false with format error', async () => {
    const handler = new JoinHandler({
      db: mockDb.db as any,
      sharedConfigStore: createMockSharedConfigStore() as any,
      clusterIdentity: createMockClusterIdentity() as any,
      databaseUrl: 'postgres://localhost:5432/kici',
    });

    (handler as any).tokenManager = createMockTokenManager({ valid: false });

    const request: JoinRequest = { type: 'join.request', token: 'bad-token' };
    const response = await handler.handleJoinRequest(request);

    expect(response.success).toBe(false);
    expect(response.error).toContain('Invalid');
  });

  it('buildConfigBundle includes databaseUrl, storage, clusterId but not PSK', async () => {
    const handler = new JoinHandler({
      db: mockDb.db as any,
      sharedConfigStore: createMockSharedConfigStore() as any,
      clusterIdentity: createMockClusterIdentity('my-cluster-id') as any,
      databaseUrl: 'postgres://localhost:5432/kici',
    });

    const bundle = await handler.buildConfigBundle();

    expect(bundle.databaseUrl).toBe('postgres://localhost:5432/kici');
    expect(bundle.storage).toEqual({ type: 's3', bucket: 'my-bucket', region: 'us-east-1' });
    expect(bundle.clusterId).toBe('my-cluster-id');
    expect(bundle.secretKey).toBe('secret-key-123');
    // PSK must NOT be in the config bundle
    expect((bundle as any).clusterPsk).toBeUndefined();
  });

  it('encrypted bundle can be decrypted with token-derived key to recover config', async () => {
    const token = createTestToken();
    const parsed = parseToken(token);
    const keys = deriveKeys(Buffer.from(parsed.secretHex, 'hex'));

    const handler = new JoinHandler({
      db: mockDb.db as any,
      sharedConfigStore: createMockSharedConfigStore() as any,
      clusterIdentity: createMockClusterIdentity() as any,
      databaseUrl: 'postgres://localhost:5432/kici',
    });

    (handler as any).tokenManager = createMockTokenManager();

    const request: JoinRequest = { type: 'join.request', token };
    const response = await handler.handleJoinRequest(request);

    expect(response.success).toBe(true);
    const encryptedBuf = Buffer.from(response.encryptedBundle!, 'base64');
    const decrypted = decryptBundle(encryptedBuf, keys.encryptionKey) as any;

    expect(decrypted.databaseUrl).toBe('postgres://localhost:5432/kici');
    expect(decrypted.clusterId).toBe('cluster-uuid-123');
    expect(decrypted.clusterPsk).toBeUndefined();
  });

  it('token is marked consumed after successful join', async () => {
    const token = createTestToken();
    const mockTokenMgr = createMockTokenManager();

    const handler = new JoinHandler({
      db: mockDb.db as any,
      sharedConfigStore: createMockSharedConfigStore() as any,
      clusterIdentity: createMockClusterIdentity() as any,
      databaseUrl: 'postgres://localhost:5432/kici',
    });

    (handler as any).tokenManager = mockTokenMgr;

    const request: JoinRequest = { type: 'join.request', token };
    const response = await handler.handleJoinRequest(request);

    expect(response.success).toBe(true);
    // The atomic claim fires exactly once and is itself the consume step.
    expect(mockTokenMgr.validateAndConsumeToken).toHaveBeenCalledTimes(1);
    // It must carry a joiner-attribution string for audit, used both as the
    // consumedBy label and the consuming instanceId (the bootstrap join.request
    // carries no peer instanceId on the wire).
    expect(mockTokenMgr.validateAndConsumeToken).toHaveBeenCalledWith(
      token,
      expect.stringMatching(/^joiner:/),
      expect.stringMatching(/^joiner:/),
    );
  });

  it('config bundle does not contain PSK even when SharedConfig has one', async () => {
    const handler = new JoinHandler({
      db: mockDb.db as any,
      sharedConfigStore: createMockSharedConfigStore() as any,
      clusterIdentity: createMockClusterIdentity() as any,
      databaseUrl: 'postgres://localhost:5432/kici',
    });

    const bundle = await handler.buildConfigBundle();

    // PSK should never appear in the config bundle
    expect((bundle as any).clusterPsk).toBeUndefined();
    expect((bundle as any).psk).toBeUndefined();
    expect((bundle as any).pskOld).toBeUndefined();
  });

  it('handleJoinRequest echoes messageId from request in response', async () => {
    const token = createTestToken();
    const handler = new JoinHandler({
      db: mockDb.db as any,
      sharedConfigStore: createMockSharedConfigStore() as any,
      clusterIdentity: createMockClusterIdentity() as any,
      databaseUrl: 'postgres://localhost:5432/kici',
    });

    (handler as any).tokenManager = createMockTokenManager();

    // Success case
    const request: JoinRequest = { type: 'join.request', token, messageId: 'msg-123' };
    const response = await handler.handleJoinRequest(request);
    expect(response.messageId).toBe('msg-123');

    // Error case
    (handler as any).tokenManager = createMockTokenManager({ expired: true });
    const request2: JoinRequest = { type: 'join.request', token, messageId: 'msg-456' };
    const response2 = await handler.handleJoinRequest(request2);
    expect(response2.messageId).toBe('msg-456');
  });
});
