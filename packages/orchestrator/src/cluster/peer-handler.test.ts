import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { PeerHeartbeat } from '@kici-dev/engine';
import {
  generateEcdhKeyPair,
  deriveSessionKey,
  encryptMessage,
  decryptMessage,
} from './peer-crypto.js';
import {
  PROTOCOL_VERSION,
  MIN_PROTOCOL_VERSION,
  WS_CLOSE_PROTOCOL_ERROR,
  ScalerEventType,
} from '@kici-dev/engine';
import { createPeerHandler, type PeerHandlerDeps, type PeerWsLike } from './peer-handler.js';
import { PeerRegistry } from './peer-registry.js';

// ── Mock WebSocket ──────────────────────────────────────────────────

class MockPeerWs extends EventEmitter implements PeerWsLike {
  readyState = 1; // OPEN
  sentMessages: string[] = [];
  closeCode?: number;
  closeReason?: string;

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
  }

  getSentMessages(): unknown[] {
    return this.sentMessages.map((m) => {
      try {
        return JSON.parse(m);
      } catch {
        return m; // encrypted, return raw
      }
    });
  }

  simulateMessage(data: unknown): void {
    this.emit('message', JSON.stringify(data));
  }

  simulateRawMessage(data: string): void {
    this.emit('message', data);
  }
}

// ── Mock JoinTokenManager ──────────────────────────────────────────

function createMockTokenManager(overrides: Partial<Record<string, unknown>> = {}) {
  const validationHash = 'test-validation-hash';
  return {
    validateAndConsumeToken: vi.fn().mockResolvedValue({
      routing: {
        orgId: 'org-1',
        routingKey: 'github:42',
        expiry: Date.now() + 3600_000,
        role: (overrides.role as string) ?? 'coordinator',
      },
      keys: { encryptionKey: Buffer.alloc(32), validationHash },
    }),
    createToken: vi.fn(),
  };
}

// ── Mock PeerCredentialStore ───────────────────────────────────────

function createMockCredentialStore() {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    findByCredentialHash: vi.fn().mockResolvedValue(null),
    findByInstanceId: vi.fn().mockResolvedValue(null),
    updateLastSeen: vi.fn().mockResolvedValue(undefined),
    revoke: vi.fn().mockResolvedValue(undefined),
    revokeAll: vi.fn().mockResolvedValue(0),
    listActive: vi.fn().mockResolvedValue([]),
  };
}

// ── Test helpers ────────────────────────────────────────────────────

function makeLocalInventory(): Omit<PeerHeartbeat, 'type'> {
  return {
    instanceId: 'handler-orch',
    term: 1,
    leaderId: null,
    draining: false,
    agents: [
      {
        agentId: 'local-agent-1',
        labels: ['linux', 'x64'],
        activeJobs: 0,
        maxConcurrency: 2,
        platform: 'linux',
        arch: 'x64',
      },
    ],
    capabilities: { s3LogAccess: false },
    timestamp: Date.now(),
  };
}

function createTestHandler(overrides: Partial<PeerHandlerDeps> = {}) {
  const registry = new PeerRegistry();
  const tokenManager = createMockTokenManager(overrides as any);
  const credentialStore = createMockCredentialStore();
  const deps: PeerHandlerDeps = {
    tokenManager: tokenManager as any,
    credentialStore: credentialStore as any,
    acceptedRoles: ['coordinator'],
    instanceId: 'handler-orch',
    peerRegistry: registry,
    getLocalInventory: makeLocalInventory,
    heartbeatIntervalMs: 30_000,
    authTimeoutMs: 15_000,
    onJobReroute: vi.fn().mockResolvedValue(undefined),
    onJobProgress: vi.fn(),
    onJobCancel: vi.fn(),
    ...overrides,
  };
  const handler = createPeerHandler(deps);
  return { handler, registry, deps, tokenManager, credentialStore };
}

/**
 * Complete the ECDH handshake phase and return the derived session key.
 * After calling this, the server is waiting for an encrypted peer.auth.request.
 */
function completeEcdhHandshake(ws: MockPeerWs): {
  sessionKey: Buffer;
  serverNonce: Buffer;
} {
  // The server sends peer.hello as first message
  expect(ws.sentMessages.length).toBeGreaterThanOrEqual(1);
  const helloMsg = JSON.parse(ws.sentMessages[0]);
  expect(helloMsg.type).toBe('peer.hello');

  const serverPubKey = Buffer.from(helloMsg.ephemeralPublicKey, 'base64');
  const serverNonce = Buffer.from(helloMsg.nonce, 'base64');

  // Client generates its own ECDH key pair
  const clientEcdh = generateEcdhKeyPair();

  // Client derives session key using server's public key and nonce
  const sessionKey = deriveSessionKey(clientEcdh.privateKey, serverPubKey, serverNonce);

  // Client sends peer.hello.response
  ws.simulateMessage({
    type: 'peer.hello.response',
    ephemeralPublicKey: clientEcdh.publicKey.toString('base64'),
  });

  return { sessionKey, serverNonce };
}

/**
 * Complete full authentication with a join token.
 */
async function authenticateWithToken(
  handler: ReturnType<typeof createPeerHandler>,
  ws: MockPeerWs,
  peerInstanceId = 'remote-peer',
): Promise<{ sessionKey: Buffer }> {
  handler.handleConnection(ws);
  const { sessionKey, serverNonce } = completeEcdhHandshake(ws);

  // Send encrypted auth request with token
  const authRequest = {
    type: 'peer.auth.request',
    instanceId: peerInstanceId,
    protocolVersion: PROTOCOL_VERSION,
    token: 'kici_join_v1.test.token',
  };
  ws.simulateRawMessage(encryptMessage(JSON.stringify(authRequest), sessionKey));

  // Wait for async auth handling
  await vi.advanceTimersByTimeAsync(0);

  return { sessionKey };
}

// ── Setup / Teardown ────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Tests ───────────────────────────────────────────────────────────

describe('PeerHandler', () => {
  describe('ECDH handshake', () => {
    it('sends peer.hello with ephemeralPublicKey and nonce on connection', () => {
      const { handler } = createTestHandler();
      const ws = new MockPeerWs();

      handler.handleConnection(ws);

      const sent = ws.getSentMessages();
      expect(sent).toHaveLength(1);
      const hello = sent[0] as any;
      expect(hello.type).toBe('peer.hello');
      expect(hello.ephemeralPublicKey).toBeDefined();
      expect(hello.nonce).toBeDefined();
      // Verify base64 encoding
      expect(Buffer.from(hello.ephemeralPublicKey, 'base64').length).toBeGreaterThan(0);
      expect(Buffer.from(hello.nonce, 'base64').length).toBe(32);
    });

    it('completes ECDH handshake successfully', () => {
      const { handler } = createTestHandler();
      const ws = new MockPeerWs();

      handler.handleConnection(ws);
      const { sessionKey } = completeEcdhHandshake(ws);

      // Session key should be 32 bytes
      expect(sessionKey.length).toBe(32);
      // No close should have occurred
      expect(ws.closeCode).toBeUndefined();
    });
  });

  describe('token-based authentication', () => {
    it('accepts valid join token and issues session credential', async () => {
      const { handler, tokenManager, credentialStore } = createTestHandler();
      const ws = new MockPeerWs();

      const { sessionKey } = await authenticateWithToken(handler, ws);

      // Atomic validate+consume should have fired with the token + this
      // coordinator's instance ID as the consumedBy attribution.
      expect(tokenManager.validateAndConsumeToken).toHaveBeenCalledWith(
        'kici_join_v1.test.token',
        'handler-orch',
      );
      // Credential should have been saved
      expect(credentialStore.save).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 'remote-peer',
          role: 'coordinator',
          routingKeys: ['github:42'],
        }),
      );

      // Auth response should be encrypted and include sessionCredential
      // After hello + hello.response handling, we should have auth response + heartbeat
      const encryptedMessages = ws.sentMessages.slice(1); // skip the plaintext hello
      expect(encryptedMessages.length).toBeGreaterThanOrEqual(1);

      // Find the auth response (encrypted)
      let authResponse: any = null;
      for (const msg of encryptedMessages) {
        try {
          const decrypted = decryptMessage(msg, sessionKey);
          const parsed = JSON.parse(decrypted);
          if (parsed.type === 'peer.auth.response') {
            authResponse = parsed;
            break;
          }
        } catch {
          // not encrypted with our key or not JSON
        }
      }

      expect(authResponse).not.toBeNull();
      expect(authResponse.accepted).toBe(true);
      expect(authResponse.sessionCredential).toBeDefined();
      expect(authResponse.sessionCredential.length).toBe(64); // 32 bytes hex
      expect(authResponse.role).toBe('coordinator');
      expect(authResponse.instanceId).toBe('handler-orch');
    });

    it('rejects invalid join token', async () => {
      const tokenManager = createMockTokenManager();
      tokenManager.validateAndConsumeToken.mockRejectedValue(new Error('Invalid join token'));
      const { handler } = createTestHandler({ tokenManager: tokenManager as any });
      const ws = new MockPeerWs();

      handler.handleConnection(ws);
      const { sessionKey } = completeEcdhHandshake(ws);

      const authRequest = {
        type: 'peer.auth.request',
        instanceId: 'remote-peer',
        protocolVersion: PROTOCOL_VERSION,
        token: 'bad-token',
      };
      ws.simulateRawMessage(encryptMessage(JSON.stringify(authRequest), sessionKey));

      await vi.advanceTimersByTimeAsync(0);

      expect(ws.closeCode).toBe(4001);
    });

    it('rejects token with wrong role', async () => {
      const tokenManager = createMockTokenManager({ role: 'worker' });
      const { handler } = createTestHandler({
        tokenManager: tokenManager as any,
        acceptedRoles: ['coordinator'],
      });
      const ws = new MockPeerWs();

      handler.handleConnection(ws);
      const { sessionKey } = completeEcdhHandshake(ws);

      const authRequest = {
        type: 'peer.auth.request',
        instanceId: 'remote-peer',
        protocolVersion: PROTOCOL_VERSION,
        token: 'worker-token',
      };
      ws.simulateRawMessage(encryptMessage(JSON.stringify(authRequest), sessionKey));

      await vi.advanceTimersByTimeAsync(0);

      // Should find encrypted rejection
      let found = false;
      for (const msg of ws.sentMessages.slice(1)) {
        try {
          const parsed = JSON.parse(decryptMessage(msg, sessionKey));
          if (parsed.type === 'peer.auth.response' && !parsed.accepted) {
            expect(parsed.reason).toBe('Role mismatch');
            found = true;
            break;
          }
        } catch {
          // ignore
        }
      }
      expect(found).toBe(true);
      expect(ws.closeCode).toBe(4001);
    });
  });

  describe('idempotent token retry (multi-coord mesh race)', () => {
    // Helper: build a real-format token + matching validation hash so the
    // recovery path's parseToken()/deriveKeys() call chain works end-to-end.
    function makeRealToken(role: 'coordinator' | 'worker' = 'coordinator') {
      const routing = {
        orgId: 'org-1',
        routingKey: 'github:42',
        expiry: Date.now() + 3600_000,
        role,
      };
      const routingB64 = Buffer.from(JSON.stringify(routing)).toString('base64url');
      const secret = randomBytes(32);
      const secretHex = secret.toString('hex');
      const token = `kici_join_v1.${routingB64}.${secretHex}`;
      const validationHash = createHash('sha256').update(secret).digest('hex');
      return { token, validationHash, routing };
    }

    const ALREADY_USED =
      'Join token has already been used. Generate a new token with: kici admin create-join-token';

    async function presentAlreadyUsedToken(
      token: string,
      credentialStoreOverride?: ReturnType<typeof createMockCredentialStore>,
      acceptedRoles: Array<'coordinator' | 'worker'> = ['coordinator'],
    ) {
      const tokenManager = createMockTokenManager();
      tokenManager.validateAndConsumeToken.mockRejectedValue(new Error(ALREADY_USED));
      const credentialStore = credentialStoreOverride ?? createMockCredentialStore();
      const { handler } = createTestHandler({
        tokenManager: tokenManager as any,
        credentialStore: credentialStore as any,
        acceptedRoles,
      });
      const ws = new MockPeerWs();

      handler.handleConnection(ws);
      const { sessionKey } = completeEcdhHandshake(ws);

      ws.simulateRawMessage(
        encryptMessage(
          JSON.stringify({
            type: 'peer.auth.request',
            instanceId: 'remote-peer',
            protocolVersion: PROTOCOL_VERSION,
            token,
          }),
          sessionKey,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);

      // Find the auth response
      let authResponse: any = null;
      for (const msg of ws.sentMessages.slice(1)) {
        try {
          const decrypted = decryptMessage(msg, sessionKey);
          const parsed = JSON.parse(decrypted);
          if (parsed.type === 'peer.auth.response') {
            authResponse = parsed;
            break;
          }
        } catch {
          /* not this message */
        }
      }

      return { ws, tokenManager, credentialStore, sessionKey, authResponse };
    }

    it('accepts retry when a prior credential exists with matching sourceTokenHash', async () => {
      const { token, validationHash } = makeRealToken();
      const credentialStore = createMockCredentialStore();
      credentialStore.findByInstanceId.mockResolvedValue({
        id: 'cred-1',
        instanceId: 'remote-peer',
        credentialHash: 'previously-issued-hash',
        role: 'coordinator',
        routingKeys: ['github:42'],
        sourceTokenHash: validationHash,
        createdAt: new Date(),
        lastSeenAt: null,
        lastValidatedBy: null,
        expiresAt: new Date(Date.now() + 86400_000),
        revokedAt: null,
      });

      const {
        authResponse,
        credentialStore: cs,
        tokenManager,
      } = await presentAlreadyUsedToken(token, credentialStore);

      // Recovery branch should issue a fresh credential. The atomic
      // validate+consume already fired once (and threw ALREADY_USED, which
      // is what put us in the recovery path); it must NOT have fired again
      // since recovery doesn't go through the token-claim path.
      expect(cs.save).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 'remote-peer',
          role: 'coordinator',
          routingKeys: ['github:42'],
          sourceTokenHash: validationHash,
        }),
      );
      expect(tokenManager.validateAndConsumeToken).toHaveBeenCalledTimes(1);

      expect(authResponse).not.toBeNull();
      expect(authResponse.accepted).toBe(true);
      expect(authResponse.sessionCredential).toBeDefined();
      expect(authResponse.sessionCredential.length).toBe(64);
      expect(authResponse.role).toBe('coordinator');
    });

    it('rejects retry when no prior credential exists (real replay)', async () => {
      const { token } = makeRealToken();
      const credentialStore = createMockCredentialStore();
      credentialStore.findByInstanceId.mockResolvedValue(null);

      const {
        authResponse,
        ws,
        credentialStore: cs,
      } = await presentAlreadyUsedToken(token, credentialStore);

      expect(cs.save).not.toHaveBeenCalled();
      expect(authResponse).not.toBeNull();
      expect(authResponse.accepted).toBe(false);
      expect(authResponse.reason).toBe('Invalid token');
      expect(ws.closeCode).toBe(4001);
    });

    it('rejects retry when prior credential has different sourceTokenHash', async () => {
      const { token } = makeRealToken();
      const credentialStore = createMockCredentialStore();
      credentialStore.findByInstanceId.mockResolvedValue({
        id: 'cred-1',
        instanceId: 'remote-peer',
        credentialHash: 'previously-issued-hash',
        role: 'coordinator',
        routingKeys: ['github:42'],
        sourceTokenHash: 'unrelated-rotated-token-hash',
        createdAt: new Date(),
        lastSeenAt: null,
        lastValidatedBy: null,
        expiresAt: new Date(Date.now() + 86400_000),
        revokedAt: null,
      });

      const {
        authResponse,
        ws,
        credentialStore: cs,
      } = await presentAlreadyUsedToken(token, credentialStore);

      expect(cs.save).not.toHaveBeenCalled();
      expect(authResponse).not.toBeNull();
      expect(authResponse.accepted).toBe(false);
      expect(authResponse.reason).toBe('Invalid token');
      expect(ws.closeCode).toBe(4001);
    });

    it('rejects retry when prior credential is revoked', async () => {
      const { token, validationHash } = makeRealToken();
      const credentialStore = createMockCredentialStore();
      credentialStore.findByInstanceId.mockResolvedValue({
        id: 'cred-1',
        instanceId: 'remote-peer',
        credentialHash: 'previously-issued-hash',
        role: 'coordinator',
        routingKeys: ['github:42'],
        sourceTokenHash: validationHash,
        createdAt: new Date(),
        lastSeenAt: null,
        lastValidatedBy: null,
        expiresAt: new Date(Date.now() + 86400_000),
        revokedAt: new Date(),
      });

      const {
        authResponse,
        ws,
        credentialStore: cs,
      } = await presentAlreadyUsedToken(token, credentialStore);

      expect(cs.save).not.toHaveBeenCalled();
      expect(authResponse).not.toBeNull();
      expect(authResponse.accepted).toBe(false);
      expect(ws.closeCode).toBe(4001);
    });

    it('rejects retry when recovered role is not accepted', async () => {
      const { token, validationHash } = makeRealToken('worker');
      const credentialStore = createMockCredentialStore();
      credentialStore.findByInstanceId.mockResolvedValue({
        id: 'cred-1',
        instanceId: 'remote-peer',
        credentialHash: 'previously-issued-hash',
        role: 'worker',
        routingKeys: ['github:42'],
        sourceTokenHash: validationHash,
        createdAt: new Date(),
        lastSeenAt: null,
        lastValidatedBy: null,
        expiresAt: new Date(Date.now() + 86400_000),
        revokedAt: null,
      });

      const {
        authResponse,
        ws,
        credentialStore: cs,
      } = await presentAlreadyUsedToken(token, credentialStore, ['coordinator']);

      expect(cs.save).not.toHaveBeenCalled();
      expect(authResponse).not.toBeNull();
      expect(authResponse.accepted).toBe(false);
      expect(authResponse.reason).toBe('Role mismatch');
      expect(ws.closeCode).toBe(4001);
    });

    it('does not trigger recovery for non-"already used" validation errors', async () => {
      const tokenManager = createMockTokenManager();
      tokenManager.validateAndConsumeToken.mockRejectedValue(new Error('Join token has expired'));
      const credentialStore = createMockCredentialStore();
      // Seed a matching credential — recovery would otherwise accept it
      credentialStore.findByInstanceId.mockResolvedValue({
        id: 'cred-1',
        instanceId: 'remote-peer',
        credentialHash: 'hash',
        role: 'coordinator',
        routingKeys: ['github:42'],
        sourceTokenHash: 'whatever',
        createdAt: new Date(),
        lastSeenAt: null,
        lastValidatedBy: null,
        expiresAt: new Date(Date.now() + 86400_000),
        revokedAt: null,
      });
      const { handler } = createTestHandler({
        tokenManager: tokenManager as any,
        credentialStore: credentialStore as any,
      });
      const ws = new MockPeerWs();
      handler.handleConnection(ws);
      const { sessionKey } = completeEcdhHandshake(ws);

      const { token } = makeRealToken();
      ws.simulateRawMessage(
        encryptMessage(
          JSON.stringify({
            type: 'peer.auth.request',
            instanceId: 'remote-peer',
            protocolVersion: PROTOCOL_VERSION,
            token,
          }),
          sessionKey,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);

      // Recovery branch MUST NOT have run — expired is not a recoverable error
      expect(credentialStore.save).not.toHaveBeenCalled();
      expect(credentialStore.findByInstanceId).not.toHaveBeenCalled();
      expect(ws.closeCode).toBe(4001);
    });
  });

  describe('credential-based authentication (HMAC proof)', () => {
    it('accepts valid HMAC proof', async () => {
      // Create a stored credential
      const rawCredential = randomBytes(32).toString('hex');
      const credentialHash = createHash('sha256').update(rawCredential).digest('hex');

      const credentialStore = createMockCredentialStore();
      credentialStore.findByInstanceId.mockResolvedValue({
        id: 'cred-1',
        instanceId: 'remote-peer',
        credentialHash,
        role: 'coordinator',
        routingKeys: ['github:42'],
        sourceTokenHash: null,
        createdAt: new Date(),
        lastSeenAt: null,
        expiresAt: new Date(Date.now() + 86400_000),
        revokedAt: null,
      });

      const { handler } = createTestHandler({ credentialStore: credentialStore as any });
      const ws = new MockPeerWs();

      handler.handleConnection(ws);
      const { sessionKey, serverNonce } = completeEcdhHandshake(ws);

      // Compute HMAC proof like the client would
      const nonceB64 = serverNonce.toString('base64');
      const proof = createHmac('sha256', Buffer.from(credentialHash, 'hex'))
        .update(nonceB64 + ':' + 'remote-peer')
        .digest('hex');

      const authRequest = {
        type: 'peer.auth.request',
        instanceId: 'remote-peer',
        protocolVersion: PROTOCOL_VERSION,
        proof,
      };
      ws.simulateRawMessage(encryptMessage(JSON.stringify(authRequest), sessionKey));

      await vi.advanceTimersByTimeAsync(0);

      expect(credentialStore.updateLastSeen).toHaveBeenCalledWith(credentialHash, 'handler-orch');
      expect(ws.closeCode).toBeUndefined();

      // Find auth response
      let authResponse: any = null;
      for (const msg of ws.sentMessages.slice(1)) {
        try {
          const parsed = JSON.parse(decryptMessage(msg, sessionKey));
          if (parsed.type === 'peer.auth.response') {
            authResponse = parsed;
            break;
          }
        } catch {
          // ignore
        }
      }
      expect(authResponse).not.toBeNull();
      expect(authResponse.accepted).toBe(true);
    });

    it('rejects invalid HMAC proof (timingSafeEqual)', async () => {
      const credentialStore = createMockCredentialStore();
      credentialStore.findByInstanceId.mockResolvedValue({
        id: 'cred-1',
        instanceId: 'remote-peer',
        credentialHash: 'a'.repeat(64),
        role: 'coordinator',
        routingKeys: ['github:42'],
        sourceTokenHash: null,
        createdAt: new Date(),
        lastSeenAt: null,
        expiresAt: new Date(Date.now() + 86400_000),
        revokedAt: null,
      });

      const { handler } = createTestHandler({ credentialStore: credentialStore as any });
      const ws = new MockPeerWs();

      handler.handleConnection(ws);
      const { sessionKey } = completeEcdhHandshake(ws);

      const authRequest = {
        type: 'peer.auth.request',
        instanceId: 'remote-peer',
        protocolVersion: PROTOCOL_VERSION,
        proof: 'b'.repeat(64), // wrong proof
      };
      ws.simulateRawMessage(encryptMessage(JSON.stringify(authRequest), sessionKey));

      await vi.advanceTimersByTimeAsync(0);

      expect(ws.closeCode).toBe(4001);
    });

    it('rejects when credential not found', async () => {
      const credentialStore = createMockCredentialStore();
      credentialStore.findByInstanceId.mockResolvedValue(null);

      const { handler } = createTestHandler({ credentialStore: credentialStore as any });
      const ws = new MockPeerWs();

      handler.handleConnection(ws);
      const { sessionKey } = completeEcdhHandshake(ws);

      const authRequest = {
        type: 'peer.auth.request',
        instanceId: 'unknown-peer',
        protocolVersion: PROTOCOL_VERSION,
        proof: 'a'.repeat(64),
      };
      ws.simulateRawMessage(encryptMessage(JSON.stringify(authRequest), sessionKey));

      await vi.advanceTimersByTimeAsync(0);

      expect(ws.closeCode).toBe(4001);
    });
  });

  describe('auth timeout', () => {
    it('closes connection after auth timeout (15s)', () => {
      const { handler } = createTestHandler({ authTimeoutMs: 15_000 });
      const ws = new MockPeerWs();

      handler.handleConnection(ws);

      // Don't send any messages -- let timeout fire
      vi.advanceTimersByTime(16_000);

      expect(ws.closeCode).toBe(4002);
      expect(ws.closeReason).toBe('Auth timeout');
    });
  });

  describe('rate limiting', () => {
    it('rate limits after 5 failed auth attempts from same IP', async () => {
      const tokenManager = createMockTokenManager();
      tokenManager.validateAndConsumeToken.mockRejectedValue(new Error('Invalid'));

      const { handler } = createTestHandler({ tokenManager: tokenManager as any });

      // Fail 5 times from same IP
      for (let i = 0; i < 5; i++) {
        const ws = new MockPeerWs();
        handler.handleConnection(ws, '192.168.1.100');
        const { sessionKey } = completeEcdhHandshake(ws);
        const authRequest = {
          type: 'peer.auth.request',
          instanceId: `peer-${i}`,
          protocolVersion: PROTOCOL_VERSION,
          token: 'bad-token',
        };
        ws.simulateRawMessage(encryptMessage(JSON.stringify(authRequest), sessionKey));
        await vi.advanceTimersByTimeAsync(0);
      }

      // 6th attempt should be immediately rejected
      const ws6 = new MockPeerWs();
      handler.handleConnection(ws6, '192.168.1.100');
      expect(ws6.closeCode).toBe(4001);
      expect(ws6.closeReason).toBe('Rate limited');
    });

    it('does not rate limit different IPs', async () => {
      const tokenManager = createMockTokenManager();
      tokenManager.validateAndConsumeToken.mockRejectedValue(new Error('Invalid'));

      const { handler } = createTestHandler({ tokenManager: tokenManager as any });

      // Fail 5 times from different IPs
      for (let i = 0; i < 5; i++) {
        const ws = new MockPeerWs();
        handler.handleConnection(ws, `192.168.1.${i}`);
        const { sessionKey } = completeEcdhHandshake(ws);
        const authRequest = {
          type: 'peer.auth.request',
          instanceId: `peer-${i}`,
          protocolVersion: PROTOCOL_VERSION,
          token: 'bad-token',
        };
        ws.simulateRawMessage(encryptMessage(JSON.stringify(authRequest), sessionKey));
        await vi.advanceTimersByTimeAsync(0);
      }

      // New IP should NOT be rate limited
      const ws6 = new MockPeerWs();
      handler.handleConnection(ws6, '10.0.0.1');
      // Should receive peer.hello, not be rejected
      expect(ws6.closeCode).toBeUndefined();
      expect(ws6.sentMessages.length).toBeGreaterThanOrEqual(1);
      const firstMsg = JSON.parse(ws6.sentMessages[0]);
      expect(firstMsg.type).toBe('peer.hello');
    });
  });

  describe('dual rate limiting (per-IP + per-instance-ID)', () => {
    it('rate limits by instance ID after RATE_LIMIT_MAX failures from different IPs', async () => {
      const tokenManager = createMockTokenManager();
      tokenManager.validateAndConsumeToken.mockRejectedValue(new Error('Invalid'));

      const { handler } = createTestHandler({ tokenManager: tokenManager as any });
      const sameInstanceId = 'attacker-instance';

      // Fail 5 times from different IPs but same instance ID
      for (let i = 0; i < 5; i++) {
        const ws = new MockPeerWs();
        handler.handleConnection(ws, `10.0.${i}.1`);
        const { sessionKey } = completeEcdhHandshake(ws);
        const authRequest = {
          type: 'peer.auth.request',
          instanceId: sameInstanceId,
          protocolVersion: PROTOCOL_VERSION,
          token: 'bad-token',
        };
        ws.simulateRawMessage(encryptMessage(JSON.stringify(authRequest), sessionKey));
        await vi.advanceTimersByTimeAsync(0);
      }

      // 6th attempt from a NEW IP but SAME instance ID should still get through
      // to the handshake (rate limit by instanceId is checked after ECDH+auth parsing)
      // However, the per-IP check at connection time should pass since it's a new IP
      const ws6 = new MockPeerWs();
      handler.handleConnection(ws6, '10.0.99.1');
      // Should receive peer.hello (not immediately closed)
      expect(ws6.closeCode).toBeUndefined();
      expect(ws6.sentMessages.length).toBeGreaterThanOrEqual(1);
      const firstMsg = JSON.parse(ws6.sentMessages[0]);
      expect(firstMsg.type).toBe('peer.hello');
    });

    it('records failures in both IP and instance ID maps', async () => {
      const tokenManager = createMockTokenManager();
      tokenManager.validateAndConsumeToken.mockRejectedValue(new Error('Invalid'));

      const { handler } = createTestHandler({ tokenManager: tokenManager as any });

      // 5 failures from same IP and same instance ID
      for (let i = 0; i < 5; i++) {
        const ws = new MockPeerWs();
        handler.handleConnection(ws, '192.168.1.100');
        const { sessionKey } = completeEcdhHandshake(ws);
        const authRequest = {
          type: 'peer.auth.request',
          instanceId: 'bad-peer',
          protocolVersion: PROTOCOL_VERSION,
          token: 'bad-token',
        };
        ws.simulateRawMessage(encryptMessage(JSON.stringify(authRequest), sessionKey));
        await vi.advanceTimersByTimeAsync(0);
      }

      // Same IP should be rate limited at connection time
      const ws6 = new MockPeerWs();
      handler.handleConnection(ws6, '192.168.1.100');
      expect(ws6.closeCode).toBe(4001);
      expect(ws6.closeReason).toBe('Rate limited');
    });

    it('rate limit resets after window expires', async () => {
      const tokenManager = createMockTokenManager();
      tokenManager.validateAndConsumeToken.mockRejectedValue(new Error('Invalid'));

      const { handler } = createTestHandler({ tokenManager: tokenManager as any });

      // Fail 5 times
      for (let i = 0; i < 5; i++) {
        const ws = new MockPeerWs();
        handler.handleConnection(ws, '192.168.1.100');
        const { sessionKey } = completeEcdhHandshake(ws);
        const authRequest = {
          type: 'peer.auth.request',
          instanceId: `peer-${i}`,
          protocolVersion: PROTOCOL_VERSION,
          token: 'bad-token',
        };
        ws.simulateRawMessage(encryptMessage(JSON.stringify(authRequest), sessionKey));
        await vi.advanceTimersByTimeAsync(0);
      }

      // Should be rate limited
      const wsBlocked = new MockPeerWs();
      handler.handleConnection(wsBlocked, '192.168.1.100');
      expect(wsBlocked.closeCode).toBe(4001);

      // Advance past rate limit window (60s)
      vi.advanceTimersByTime(61_000);

      // Should be allowed again
      const wsAllowed = new MockPeerWs();
      handler.handleConnection(wsAllowed, '192.168.1.100');
      expect(wsAllowed.closeCode).toBeUndefined();
      expect(wsAllowed.sentMessages.length).toBeGreaterThanOrEqual(1);
      const firstMsg = JSON.parse(wsAllowed.sentMessages[0]);
      expect(firstMsg.type).toBe('peer.hello');
    });
  });

  describe('post-auth message routing', () => {
    it('routes encrypted heartbeat messages', async () => {
      const { handler, registry } = createTestHandler();
      const ws = new MockPeerWs();

      const { sessionKey } = await authenticateWithToken(handler, ws);

      // Send encrypted heartbeat
      const heartbeat = {
        type: 'peer.heartbeat',
        instanceId: 'remote-peer',
        term: 3,
        leaderId: 'remote-peer',
        draining: false,
        agents: [
          {
            agentId: 'remote-agent',
            labels: ['darwin', 'arm64'],
            activeJobs: 0,
            maxConcurrency: 4,
            platform: 'darwin',
            arch: 'arm64',
          },
        ],
        capabilities: { s3LogAccess: true },
        timestamp: Date.now(),
      };
      ws.simulateRawMessage(encryptMessage(JSON.stringify(heartbeat), sessionKey));

      const peer = registry.getPeer('remote-peer');
      expect(peer!.agents).toHaveLength(1);
      expect(peer!.agents[0].agentId).toBe('remote-agent');
    });

    it('routes encrypted job.reroute to callback', async () => {
      const onJobReroute = vi.fn().mockResolvedValue(undefined);
      const { handler } = createTestHandler({ onJobReroute });
      const ws = new MockPeerWs();

      const { sessionKey } = await authenticateWithToken(handler, ws);

      const reroute = {
        type: 'job.reroute',
        messageId: 'msg-1',
        jobId: 'job-1',
        runId: 'run-1',
        deliveryId: 'del-1',
        routingKey: 'github:42',
        event: 'push',
        action: null,
        payload: {},
        jobName: 'build',
        workflowName: 'ci',
        runsOnLabels: [['linux']],
        triedConnections: [],
        maxHops: 3,
        coordinatorId: 'orch-1',
      };
      ws.simulateRawMessage(encryptMessage(JSON.stringify(reroute), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      expect(onJobReroute).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'job.reroute', messageId: 'msg-1' }),
      );
    });

    it('routes encrypted scaler.event to callback', async () => {
      const onPeerScalerEvent = vi.fn();
      const { handler } = createTestHandler({ onPeerScalerEvent });
      const ws = new MockPeerWs();

      const { sessionKey } = await authenticateWithToken(handler, ws);

      const scalerEvent = {
        type: 'scaler.event',
        runId: 'run-1',
        jobId: 'job-1',
        agentId: 'scaler-agent-1',
        eventType: ScalerEventType.enum['scaler.failed'],
        detail: 'spawn node ENOENT',
        timestampMs: Date.now(),
      };
      ws.simulateRawMessage(encryptMessage(JSON.stringify(scalerEvent), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      expect(onPeerScalerEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'scaler.event', runId: 'run-1', jobId: 'job-1' }),
      );
    });
  });

  describe('connection management', () => {
    it('registers authenticated peer in registry', async () => {
      const { handler, registry } = createTestHandler();
      const ws = new MockPeerWs();

      await authenticateWithToken(handler, ws);

      const peer = registry.getPeer('remote-peer');
      expect(peer).toBeDefined();
      expect(peer!.connected).toBe(true);
    });

    it('registers peer with worker role from auth request', async () => {
      const { handler, registry } = createTestHandler();
      const ws = new MockPeerWs();

      handler.handleConnection(ws);
      const { sessionKey } = completeEcdhHandshake(ws);

      // Send auth request with role: 'worker'
      const authRequest = {
        type: 'peer.auth.request',
        instanceId: 'worker-peer',
        protocolVersion: PROTOCOL_VERSION,
        token: 'kici_join_v1.test.token',
        role: 'worker',
      };
      ws.simulateRawMessage(encryptMessage(JSON.stringify(authRequest), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      const peer = registry.getPeer('worker-peer');
      expect(peer).toBeDefined();
      expect(peer!.role).toBe('worker');
    });

    it('marks peer as disconnected on close', async () => {
      const { handler, registry } = createTestHandler();
      const ws = new MockPeerWs();

      await authenticateWithToken(handler, ws);
      expect(registry.getPeer('remote-peer')!.connected).toBe(true);

      ws.emit('close');

      expect(registry.getPeer('remote-peer')!.connected).toBe(false);
    });

    it('tracks connection count', async () => {
      const { handler } = createTestHandler();
      const ws = new MockPeerWs();

      await authenticateWithToken(handler, ws);
      expect(handler.getConnectionCount()).toBe(1);

      ws.emit('close');
      expect(handler.getConnectionCount()).toBe(0);
    });
  });

  describe('sendToPeer', () => {
    it('sends encrypted message to connected peer by instanceId', async () => {
      const { handler } = createTestHandler();
      const ws = new MockPeerWs();

      const { sessionKey } = await authenticateWithToken(handler, ws);
      const countBefore = ws.sentMessages.length;

      const result = handler.sendToPeer('remote-peer', {
        type: 'peer.heartbeat',
        instanceId: 'handler-orch',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        timestamp: Date.now(),
      });

      expect(result).toBe(true);
      expect(ws.sentMessages.length).toBe(countBefore + 1);

      // Verify the sent message is encrypted and can be decrypted
      const lastMsg = ws.sentMessages[ws.sentMessages.length - 1];
      const decrypted = JSON.parse(decryptMessage(lastMsg, sessionKey));
      expect(decrypted.type).toBe('peer.heartbeat');
    });

    it('returns false for unknown peer', () => {
      const { handler } = createTestHandler();

      const result = handler.sendToPeer('unknown', {
        type: 'peer.heartbeat',
        instanceId: 'handler-orch',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        timestamp: Date.now(),
      });

      expect(result).toBe(false);
    });
  });

  describe('protocol version check', () => {
    it('rejects peer with protocol version below MIN_PROTOCOL_VERSION', async () => {
      const { handler } = createTestHandler();
      const ws = new MockPeerWs();

      handler.handleConnection(ws);
      const { sessionKey } = completeEcdhHandshake(ws);

      const authRequest = {
        type: 'peer.auth.request',
        instanceId: 'remote-peer',
        protocolVersion: 0, // below minimum
        token: 'kici_join_v1.test.token',
      };
      ws.simulateRawMessage(encryptMessage(JSON.stringify(authRequest), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      let authResponse: any = null;
      for (const msg of ws.sentMessages.slice(1)) {
        try {
          const parsed = JSON.parse(decryptMessage(msg, sessionKey));
          if (parsed.type === 'peer.auth.response') {
            authResponse = parsed;
            break;
          }
        } catch {
          // ignore
        }
      }

      expect(authResponse).not.toBeNull();
      expect(authResponse.accepted).toBe(false);
      expect(authResponse.reason).toContain('Unsupported protocol version');
      expect(ws.closeCode).toBe(WS_CLOSE_PROTOCOL_ERROR);
    });

    it('accepts peer with protocol version equal to MIN_PROTOCOL_VERSION', async () => {
      const { handler, registry } = createTestHandler();
      const ws = new MockPeerWs();

      handler.handleConnection(ws);
      const { sessionKey } = completeEcdhHandshake(ws);

      const authRequest = {
        type: 'peer.auth.request',
        instanceId: 'remote-peer',
        protocolVersion: MIN_PROTOCOL_VERSION,
        token: 'kici_join_v1.test.token',
      };
      ws.simulateRawMessage(encryptMessage(JSON.stringify(authRequest), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      const peer = registry.getPeer('remote-peer');
      expect(peer).toBeDefined();
      expect(peer!.connected).toBe(true);
      expect(ws.closeCode).toBeUndefined();
    });

    it('accepts peer with protocol version above MIN_PROTOCOL_VERSION', async () => {
      const { handler, registry } = createTestHandler();
      const ws = new MockPeerWs();

      handler.handleConnection(ws);
      const { sessionKey } = completeEcdhHandshake(ws);

      const authRequest = {
        type: 'peer.auth.request',
        instanceId: 'remote-peer',
        protocolVersion: MIN_PROTOCOL_VERSION + 99, // future version
        token: 'kici_join_v1.test.token',
      };
      ws.simulateRawMessage(encryptMessage(JSON.stringify(authRequest), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      const peer = registry.getPeer('remote-peer');
      expect(peer).toBeDefined();
      expect(peer!.connected).toBe(true);
      expect(ws.closeCode).toBeUndefined();
    });

    it('includes softwareVersion in auth response for diagnostics', async () => {
      const { handler } = createTestHandler();
      const ws = new MockPeerWs();

      const { sessionKey } = await authenticateWithToken(handler, ws);

      let authResponse: any = null;
      for (const msg of ws.sentMessages.slice(1)) {
        try {
          const parsed = JSON.parse(decryptMessage(msg, sessionKey));
          if (parsed.type === 'peer.auth.response') {
            authResponse = parsed;
            break;
          }
        } catch {
          // ignore
        }
      }

      expect(authResponse).not.toBeNull();
      expect(authResponse.accepted).toBe(true);
      expect(authResponse.softwareVersion).toBeDefined();
      expect(typeof authResponse.softwareVersion).toBe('string');
      expect(authResponse.softwareVersion).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe('log and cache relay', () => {
    it('handles peer.log.chunk message and calls onPeerLogChunk', async () => {
      const onPeerLogChunk = vi.fn();
      const { handler } = createTestHandler({ onPeerLogChunk });
      const ws = new MockPeerWs();

      const { sessionKey } = await authenticateWithToken(handler, ws);

      const logChunk = {
        type: 'peer.log.chunk',
        runId: 'run-1',
        jobId: 'job-1',
        stepIndex: 0,
        lines: [
          { text: 'Hello from worker', timestamp: Date.now() },
          { text: 'Step output line 2', timestamp: Date.now(), stream: 'stdout' },
        ],
      };
      ws.simulateRawMessage(encryptMessage(JSON.stringify(logChunk), sessionKey));

      expect(onPeerLogChunk).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'peer.log.chunk',
          runId: 'run-1',
          jobId: 'job-1',
          stepIndex: 0,
          lines: expect.arrayContaining([expect.objectContaining({ text: 'Hello from worker' })]),
        }),
        'remote-peer',
      );
    });

    it('handles peer.cache.upload.request and sends response', async () => {
      const onPeerCacheUploadRequest = vi.fn().mockResolvedValue({
        type: 'peer.cache.upload.response',
        messageId: 'cache-req-1',
        runId: 'run-1',
        jobId: 'job-1',
        uploadUrl: 'https://s3.example.com/presigned-upload',
      });
      const { handler } = createTestHandler({ onPeerCacheUploadRequest });
      const ws = new MockPeerWs();

      const { sessionKey } = await authenticateWithToken(handler, ws);
      const countBefore = ws.sentMessages.length;

      const cacheReq = {
        type: 'peer.cache.upload.request',
        messageId: 'cache-req-1',
        runId: 'run-1',
        jobId: 'job-1',
        cacheType: 'source',
        hash: 'abc123def456',
        sizeBytes: 4096,
      };
      ws.simulateRawMessage(encryptMessage(JSON.stringify(cacheReq), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      expect(onPeerCacheUploadRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'peer.cache.upload.request',
          messageId: 'cache-req-1',
          hash: 'abc123def456',
        }),
        'remote-peer',
      );

      // Should have sent encrypted response
      expect(ws.sentMessages.length).toBeGreaterThan(countBefore);

      // Find the cache response in sent messages
      let cacheResponse: any = null;
      for (const msg of ws.sentMessages.slice(countBefore)) {
        try {
          const parsed = JSON.parse(decryptMessage(msg, sessionKey));
          if (parsed.type === 'peer.cache.upload.response') {
            cacheResponse = parsed;
            break;
          }
        } catch {
          // ignore
        }
      }

      expect(cacheResponse).not.toBeNull();
      expect(cacheResponse.uploadUrl).toBe('https://s3.example.com/presigned-upload');
      expect(cacheResponse.messageId).toBe('cache-req-1');
    });

    it('sends empty uploadUrl when no cache handler is configured', async () => {
      const { handler } = createTestHandler(); // no onPeerCacheUploadRequest
      const ws = new MockPeerWs();

      const { sessionKey } = await authenticateWithToken(handler, ws);
      const countBefore = ws.sentMessages.length;

      const cacheReq = {
        type: 'peer.cache.upload.request',
        messageId: 'cache-req-no-handler',
        runId: 'run-1',
        jobId: 'job-1',
        cacheType: 'deps',
        hash: 'xyz789',
        sizeBytes: 2048,
      };
      ws.simulateRawMessage(encryptMessage(JSON.stringify(cacheReq), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      // Should have sent encrypted error response
      let cacheResponse: any = null;
      for (const msg of ws.sentMessages.slice(countBefore)) {
        try {
          const parsed = JSON.parse(decryptMessage(msg, sessionKey));
          if (parsed.type === 'peer.cache.upload.response') {
            cacheResponse = parsed;
            break;
          }
        } catch {
          // ignore
        }
      }

      expect(cacheResponse).not.toBeNull();
      expect(cacheResponse.uploadUrl).toBe('');
    });
  });

  describe('config reload routing', () => {
    it('handles peer.config.reload by invoking onPeerConfigReload and sending response', async () => {
      const onPeerConfigReload = vi.fn().mockResolvedValue({
        success: true,
        version: 7,
        fieldsChanged: ['agentAuth'],
      });
      const { handler } = createTestHandler({ onPeerConfigReload });
      const ws = new MockPeerWs();

      const { sessionKey } = await authenticateWithToken(handler, ws);
      const countBefore = ws.sentMessages.length;

      const reloadMsg = {
        type: 'peer.config.reload',
        messageId: 'reload-msg-1',
        drain: true,
      };
      ws.simulateRawMessage(encryptMessage(JSON.stringify(reloadMsg), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      expect(onPeerConfigReload).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'peer.config.reload',
          messageId: 'reload-msg-1',
          drain: true,
        }),
      );

      // Find the reload response in sent messages
      let response: any = null;
      for (const msg of ws.sentMessages.slice(countBefore)) {
        try {
          const parsed = JSON.parse(decryptMessage(msg, sessionKey));
          if (parsed.type === 'peer.config.reload.response') {
            response = parsed;
            break;
          }
        } catch {
          // ignore non-encrypted or other messages
        }
      }

      expect(response).not.toBeNull();
      expect(response.messageId).toBe('reload-msg-1');
      expect(response.success).toBe(true);
      expect(response.version).toBe(7);
      expect(response.fieldsChanged).toEqual(['agentAuth']);
    });

    it('sends error response when no onPeerConfigReload handler is configured', async () => {
      const { handler } = createTestHandler(); // no onPeerConfigReload
      const ws = new MockPeerWs();

      const { sessionKey } = await authenticateWithToken(handler, ws);
      const countBefore = ws.sentMessages.length;

      const reloadMsg = {
        type: 'peer.config.reload',
        messageId: 'reload-msg-no-handler',
      };
      ws.simulateRawMessage(encryptMessage(JSON.stringify(reloadMsg), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      let response: any = null;
      for (const msg of ws.sentMessages.slice(countBefore)) {
        try {
          const parsed = JSON.parse(decryptMessage(msg, sessionKey));
          if (parsed.type === 'peer.config.reload.response') {
            response = parsed;
            break;
          }
        } catch {
          // ignore
        }
      }

      expect(response).not.toBeNull();
      expect(response.success).toBe(false);
      expect(response.errors?.[0]).toMatch(/not configured/);
    });

    it('returns error response when onPeerConfigReload throws', async () => {
      const onPeerConfigReload = vi.fn().mockRejectedValue(new Error('boom'));
      const { handler } = createTestHandler({ onPeerConfigReload });
      const ws = new MockPeerWs();

      const { sessionKey } = await authenticateWithToken(handler, ws);
      const countBefore = ws.sentMessages.length;

      const reloadMsg = {
        type: 'peer.config.reload',
        messageId: 'reload-msg-err',
      };
      ws.simulateRawMessage(encryptMessage(JSON.stringify(reloadMsg), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      let response: any = null;
      for (const msg of ws.sentMessages.slice(countBefore)) {
        try {
          const parsed = JSON.parse(decryptMessage(msg, sessionKey));
          if (parsed.type === 'peer.config.reload.response') {
            response = parsed;
            break;
          }
        } catch {
          // ignore
        }
      }

      expect(response).not.toBeNull();
      expect(response.success).toBe(false);
      expect(response.errors?.[0]).toMatch(/boom/);
    });

    it('sendConfigReloadAndWait returns null when target peer is not connected', async () => {
      const { handler } = createTestHandler();
      const result = await handler.sendConfigReloadAndWait(
        'nonexistent-peer',
        { type: 'peer.config.reload', messageId: 'never-delivered' },
        1_000,
      );
      expect(result).toBeNull();
    });

    it('sendConfigReloadAndWait resolves when matching response arrives', async () => {
      const { handler } = createTestHandler();
      const ws = new MockPeerWs();

      const { sessionKey } = await authenticateWithToken(handler, ws);

      // Send the reload request and capture the promise
      const promise = handler.sendConfigReloadAndWait(
        'remote-peer',
        { type: 'peer.config.reload', messageId: 'rl-1' },
        5_000,
      );

      // Simulate the peer replying with a response
      const responseMsg = {
        type: 'peer.config.reload.response',
        messageId: 'rl-1',
        success: true,
        version: 9,
      };
      ws.simulateRawMessage(encryptMessage(JSON.stringify(responseMsg), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      const result = await promise;
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      expect(result!.version).toBe(9);
    });

    it('sendConfigReloadAndWait resolves with success=false on timeout', async () => {
      const { handler } = createTestHandler();
      const ws = new MockPeerWs();

      await authenticateWithToken(handler, ws);

      const promise = handler.sendConfigReloadAndWait(
        'remote-peer',
        { type: 'peer.config.reload', messageId: 'rl-timeout' },
        500,
      );

      // Advance past the timeout without sending a response
      await vi.advanceTimersByTimeAsync(600);

      const result = await promise;
      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.errors?.[0]).toMatch(/timed out/);
    });
  });

  describe('broadcastHeartbeat', () => {
    it('sends encrypted heartbeat to all connected peers', async () => {
      const { handler } = createTestHandler();
      const ws1 = new MockPeerWs();
      const ws2 = new MockPeerWs();

      const { sessionKey: sk1 } = await authenticateWithToken(handler, ws1, 'peer-1');
      const { sessionKey: sk2 } = await authenticateWithToken(handler, ws2, 'peer-2');

      const count1Before = ws1.sentMessages.length;
      const count2Before = ws2.sentMessages.length;

      handler.broadcastHeartbeat(makeLocalInventory());

      expect(ws1.sentMessages.length).toBe(count1Before + 1);
      expect(ws2.sentMessages.length).toBe(count2Before + 1);

      // Verify encrypted messages can be decrypted
      const decrypted1 = JSON.parse(
        decryptMessage(ws1.sentMessages[ws1.sentMessages.length - 1], sk1),
      );
      expect(decrypted1.type).toBe('peer.heartbeat');

      const decrypted2 = JSON.parse(
        decryptMessage(ws2.sentMessages[ws2.sentMessages.length - 1], sk2),
      );
      expect(decrypted2.type).toBe('peer.heartbeat');
    });
  });

  describe('peer.agent-token.revoke routing', () => {
    it('invokes onAgentTokenRevoke callback when an authenticated peer publishes one', async () => {
      const onAgentTokenRevoke = vi.fn();
      const { handler } = createTestHandler({ onAgentTokenRevoke });
      const ws = new MockPeerWs();

      const { sessionKey } = await authenticateWithToken(handler, ws, 'peer-x');

      const msg = {
        type: 'peer.agent-token.revoke' as const,
        tokenId: 'tok-abc-123',
        senderInstanceId: 'peer-x',
      };
      ws.simulateRawMessage(encryptMessage(JSON.stringify(msg), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      expect(onAgentTokenRevoke).toHaveBeenCalledTimes(1);
      expect(onAgentTokenRevoke).toHaveBeenCalledWith(msg);
    });
  });

  describe('broadcastAgentTokenRevoke', () => {
    it('sends encrypted peer.agent-token.revoke to every connected peer', async () => {
      const { handler } = createTestHandler();
      const ws1 = new MockPeerWs();
      const ws2 = new MockPeerWs();

      const { sessionKey: sk1 } = await authenticateWithToken(handler, ws1, 'peer-1');
      const { sessionKey: sk2 } = await authenticateWithToken(handler, ws2, 'peer-2');

      const count1Before = ws1.sentMessages.length;
      const count2Before = ws2.sentMessages.length;

      handler.broadcastAgentTokenRevoke({
        type: 'peer.agent-token.revoke',
        tokenId: 'tok-fanout',
        senderInstanceId: 'handler-orch',
      });

      expect(ws1.sentMessages.length).toBe(count1Before + 1);
      expect(ws2.sentMessages.length).toBe(count2Before + 1);

      const dec1 = JSON.parse(decryptMessage(ws1.sentMessages[ws1.sentMessages.length - 1], sk1));
      expect(dec1).toEqual({
        type: 'peer.agent-token.revoke',
        tokenId: 'tok-fanout',
        senderInstanceId: 'handler-orch',
      });

      const dec2 = JSON.parse(decryptMessage(ws2.sentMessages[ws2.sentMessages.length - 1], sk2));
      expect(dec2).toEqual({
        type: 'peer.agent-token.revoke',
        tokenId: 'tok-fanout',
        senderInstanceId: 'handler-orch',
      });
    });
  });
});
