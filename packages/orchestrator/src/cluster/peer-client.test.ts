import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  WS_MAX_PAYLOAD_BYTES,
  ExecutionJobStatus,
  type JobReroute,
  type JobProgressAck,
  type PeerHeartbeat,
} from '@kici-dev/engine';
import {
  generateEcdhKeyPair,
  deriveSessionKey,
  encryptMessage,
  decryptMessage,
} from './peer-crypto.js';
import { chunkBuffer } from '@kici-dev/shared';
import { PeerClient, type PeerClientOptions } from './peer-client.js';
import { PeerAuthCoordinator } from './peer-auth-coordinator.js';
import { PeerRegistry } from './peer-registry.js';

// ── Hoisted mock state ──────────────────────────────────────────────

const { mockInstances, mockConstructorArgs } = vi.hoisted(() => {
  return {
    mockInstances: [] as import('node:events').EventEmitter[],
    // Each entry is the argv array a single `new WebSocket(...)` call received.
    // Used by the compression-bomb-defense invariant test.
    mockConstructorArgs: [] as unknown[][],
  };
});

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');

  class MockWS extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;

    readyState = 1; // OPEN
    sentMessages: string[] = [];
    closeCode?: number;
    closeReason?: string;

    constructor(...args: unknown[]) {
      super();
      mockConstructorArgs.push(args);
      mockInstances.push(this);
    }

    send(data: string): void {
      this.sentMessages.push(data);
    }

    close(code?: number, reason?: string): void {
      this.closeCode = code;
      this.closeReason = reason;
      this.readyState = 3;
      setImmediate(() => {
        this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
      });
    }
  }

  return {
    default: MockWS,
    WebSocket: MockWS,
  };
});

// ── Mock credential file I/O ────────────────────────────────────────

const mockReadCredentialFile = vi.fn().mockResolvedValue(null);
const mockWriteCredentialFile = vi.fn().mockResolvedValue(undefined);

vi.mock('./peer-credentials.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./peer-credentials.js')>();
  return {
    ...mod,
    readCredentialFile: (...args: any[]) => mockReadCredentialFile(...args),
    writeCredentialFile: (...args: any[]) => mockWriteCredentialFile(...args),
  };
});

// ── Mock fs/promises.unlink (used by the coordinator's credential delete) ──
const mockUnlink = vi.fn().mockResolvedValue(undefined);

vi.mock('node:fs/promises', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...mod,
    unlink: (...args: Parameters<typeof mod.unlink>) => mockUnlink(...args),
  };
});

// ── Typed helpers ───────────────────────────────────────────────────

interface MockWsInstance {
  readyState: number;
  sentMessages: string[];
  closeCode?: number;
  closeReason?: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  emit(event: string, ...args: unknown[]): boolean;
  on(event: string, listener: (...args: unknown[]) => void): MockWsInstance;
}

function getLatestMock(): MockWsInstance {
  return mockInstances[mockInstances.length - 1] as unknown as MockWsInstance;
}

function simulateOpen(mock: MockWsInstance): void {
  mock.emit('open');
}

// ── Test helpers ────────────────────────────────────────────────────

function makeLocalInventory(): Omit<PeerHeartbeat, 'type'> {
  return {
    instanceId: 'local-orch',
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

function makeCoordinator(
  credentialFile: string,
  instanceId: string,
  joinToken?: string,
): PeerAuthCoordinator {
  return new PeerAuthCoordinator({ credentialFile, instanceId, joinToken });
}

function createPeerClient(overrides: Partial<PeerClientOptions> = {}): {
  client: PeerClient;
  registry: PeerRegistry;
} {
  const registry = new PeerRegistry();
  const credentialFile = overrides.credentialFile ?? '/tmp/test-credential';
  const instanceId = overrides.instanceId ?? 'local-orch';
  const joinToken = 'joinToken' in overrides ? overrides.joinToken : 'kici_join_v1.test.token';
  const client = new PeerClient({
    url: 'ws://192.168.1.10:8080/peer',
    joinToken: 'kici_join_v1.test.token',
    credentialFile: '/tmp/test-credential',
    authCoordinator:
      overrides.authCoordinator ?? makeCoordinator(credentialFile, instanceId, joinToken),
    instanceId: 'local-orch',
    peerRegistry: registry,
    getLocalInventory: makeLocalInventory,
    heartbeatIntervalMs: 30_000,
    maxReconnectDelayMs: 60_000,
    onJobReroute: vi.fn().mockResolvedValue(undefined),
    onJobProgress: vi.fn(),
    onJobCancel: vi.fn(),
    ...overrides,
  });
  return { client, registry };
}

/**
 * Simulate the server side of ECDH handshake and return the session key.
 * The server sends peer.hello, the client sends peer.hello.response.
 */
function simulateServerHandshake(mock: MockWsInstance): {
  sessionKey: Buffer;
  nonce: Buffer;
} {
  // Generate server's ECDH key pair
  const serverEcdh = generateEcdhKeyPair();
  const nonce = randomBytes(32);

  // Server sends peer.hello (plaintext)
  const helloMsg = {
    type: 'peer.hello',
    ephemeralPublicKey: serverEcdh.publicKey.toString('base64'),
    nonce: nonce.toString('base64'),
  };
  mock.emit('message', JSON.stringify(helloMsg));

  // Client should have sent peer.hello.response
  const lastSent = mock.sentMessages[mock.sentMessages.length - 1];
  const clientResponse = JSON.parse(lastSent);
  expect(clientResponse.type).toBe('peer.hello.response');

  // Derive session key from server's perspective
  const clientPubKey = Buffer.from(clientResponse.ephemeralPublicKey, 'base64');
  const sessionKey = deriveSessionKey(serverEcdh.privateKey, clientPubKey, nonce);

  return { sessionKey, nonce };
}

/**
 * Complete full ECDH + auth flow. Returns session key for further message exchange.
 */
async function authenticateClient(
  client: PeerClient,
  overrides: { withCredential?: boolean } = {},
): Promise<{ mock: MockWsInstance; sessionKey: Buffer }> {
  client.connect();
  const mock = getLatestMock();
  simulateOpen(mock);

  // Simulate server ECDH handshake
  const { sessionKey } = simulateServerHandshake(mock);

  // Wait for async auth request to be sent
  await vi.advanceTimersByTimeAsync(0);

  // Server sends encrypted auth response (accepted)
  const authResponse = {
    type: 'peer.auth.response',
    accepted: true,
    instanceId: 'remote-orch',
    agents: [],
    capabilities: { s3LogAccess: false },
  };
  mock.emit('message', encryptMessage(JSON.stringify(authResponse), sessionKey));

  // Wait for async credential write
  await vi.advanceTimersByTimeAsync(0);

  return { mock, sessionKey };
}

// ── Setup / Teardown ────────────────────────────────────────────────

beforeEach(() => {
  mockInstances.length = 0;
  mockConstructorArgs.length = 0;
  mockReadCredentialFile.mockResolvedValue(null);
  mockWriteCredentialFile.mockResolvedValue(undefined);
  mockUnlink.mockReset();
  mockUnlink.mockResolvedValue(undefined);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Tests ───────────────────────────────────────────────────────────

describe('PeerClient', () => {
  describe('ECDH handshake', () => {
    it('completes ECDH handshake and transitions to authenticating', async () => {
      const { client } = createPeerClient();
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      expect(client.state).toBe('handshaking');

      simulateServerHandshake(mock);

      // Wait for async sendAuthRequest
      await vi.advanceTimersByTimeAsync(0);

      expect(client.state).toBe('authenticating');
    });

    it('sends peer.hello.response with ephemeral public key', () => {
      const { client } = createPeerClient();
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      simulateServerHandshake(mock);

      // Find the hello response
      const helloResponse = mock.sentMessages
        .map((m) => {
          try {
            return JSON.parse(m);
          } catch {
            return null;
          }
        })
        .find((m) => m?.type === 'peer.hello.response');

      expect(helloResponse).toBeDefined();
      expect(helloResponse.ephemeralPublicKey).toBeDefined();
      expect(Buffer.from(helloResponse.ephemeralPublicKey, 'base64').length).toBeGreaterThan(0);
    });
  });

  describe('token-based authentication', () => {
    it('sends encrypted auth request with token', async () => {
      const { client } = createPeerClient({ joinToken: 'kici_join_v1.test.token' });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      const { sessionKey } = simulateServerHandshake(mock);

      // Wait for async auth request
      await vi.advanceTimersByTimeAsync(0);

      // Find the encrypted auth request (last message after hello.response)
      const lastMsg = mock.sentMessages[mock.sentMessages.length - 1];

      // It should be encrypted
      const decrypted = JSON.parse(decryptMessage(lastMsg, sessionKey));
      expect(decrypted.type).toBe('peer.auth.request');
      expect(decrypted.instanceId).toBe('local-orch');
      expect(decrypted.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(decrypted.token).toBe('kici_join_v1.test.token');
    });

    it('persists credential to file after receiving sessionCredential', async () => {
      const { client } = createPeerClient();
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      const { sessionKey } = simulateServerHandshake(mock);
      await vi.advanceTimersByTimeAsync(0);

      // Server sends auth response with sessionCredential
      const authResponse = {
        type: 'peer.auth.response',
        accepted: true,
        instanceId: 'remote-orch',
        sessionCredential: 'a'.repeat(64),
        role: 'coordinator',
      };
      mock.emit('message', encryptMessage(JSON.stringify(authResponse), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      expect(mockWriteCredentialFile).toHaveBeenCalledWith(
        '/tmp/test-credential',
        expect.objectContaining({
          instanceId: 'local-orch',
          credential: 'a'.repeat(64),
          role: 'coordinator',
        }),
      );
    });
  });

  describe('credential-based authentication', () => {
    it('sends HMAC proof when credential file exists', async () => {
      // Set up mock credential file
      mockReadCredentialFile.mockResolvedValue({
        instanceId: 'local-orch',
        credential: 'b'.repeat(64),
        role: 'coordinator',
        issuedAt: '2026-03-22T00:00:00Z',
      });

      const { client } = createPeerClient();
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      const { sessionKey, nonce } = simulateServerHandshake(mock);
      await vi.advanceTimersByTimeAsync(0);

      // Find the encrypted auth request
      const lastMsg = mock.sentMessages[mock.sentMessages.length - 1];
      const decrypted = JSON.parse(decryptMessage(lastMsg, sessionKey));

      expect(decrypted.type).toBe('peer.auth.request');
      expect(decrypted.proof).toBeDefined();
      expect(decrypted.token).toBeUndefined();

      // Verify the HMAC proof is correct
      const credentialHash = createHash('sha256').update('b'.repeat(64)).digest('hex');
      const nonceB64 = nonce.toString('base64');
      const expectedProof = createHmac('sha256', Buffer.from(credentialHash, 'hex'))
        .update(nonceB64 + ':' + 'local-orch')
        .digest('hex');

      expect(decrypted.proof).toBe(expectedProof);
    });

    it('reuses credential across different target peer URLs (identity-scoped, not URL-scoped)', async () => {
      // 4-coordinator mesh regression: credential file is written
      // once by the first successful peer-client. Sibling peer-clients on the
      // same orchestrator connecting to DIFFERENT target URLs must still
      // accept that credential, because the server-side verifies by
      // instanceId, not by requester URL. Plan 04 follow-up: the credential
      // file no longer records `coordinatorUrl` at all — identity scope alone.
      mockReadCredentialFile.mockResolvedValue({
        instanceId: 'local-orch',
        credential: 'b'.repeat(64),
        role: 'coordinator',
        issuedAt: '2026-03-22T00:00:00Z',
      });

      const { client } = createPeerClient({
        url: 'ws://different-host:8080/peer',
        joinToken: 'my-token',
      });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      const { sessionKey, nonce } = simulateServerHandshake(mock);
      await vi.advanceTimersByTimeAsync(0);

      const lastMsg = mock.sentMessages[mock.sentMessages.length - 1];
      const decrypted = JSON.parse(decryptMessage(lastMsg, sessionKey));

      expect(decrypted.type).toBe('peer.auth.request');
      // Should use credential-based auth, NOT fall back to token
      expect(decrypted.proof).toBeDefined();
      expect(decrypted.token).toBeUndefined();

      // Verify the HMAC proof is computed against our shared credential
      const credentialHash = createHash('sha256').update('b'.repeat(64)).digest('hex');
      const nonceB64 = nonce.toString('base64');
      const expectedProof = createHmac('sha256', Buffer.from(credentialHash, 'hex'))
        .update(nonceB64 + ':' + 'local-orch')
        .digest('hex');
      expect(decrypted.proof).toBe(expectedProof);
    });

    it('falls back to token when credential file has different instanceId', async () => {
      // Credential file was written by a DIFFERENT orchestrator (instanceId
      // mismatch) — we must not try to use it. Fall back to join token.
      mockReadCredentialFile.mockResolvedValue({
        instanceId: 'some-other-orch',
        credential: 'b'.repeat(64),
        role: 'coordinator',
        issuedAt: '2026-03-22T00:00:00Z',
      });

      const { client } = createPeerClient({ joinToken: 'my-token' });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      const { sessionKey } = simulateServerHandshake(mock);
      await vi.advanceTimersByTimeAsync(0);

      const lastMsg = mock.sentMessages[mock.sentMessages.length - 1];
      const decrypted = JSON.parse(decryptMessage(lastMsg, sessionKey));

      expect(decrypted.type).toBe('peer.auth.request');
      expect(decrypted.token).toBe('my-token');
      expect(decrypted.proof).toBeUndefined();
    });

    it('one credential file serves N peer-clients in a multi-coordinator mesh', async () => {
      // Simulate the 4-coordinator mesh scenario: orchestrator "local-orch"
      // has 3 peer-clients, each connecting to a different peer. They all
      // share the same on-disk credential file. Only the first one uses the
      // join token; the other two read the shared credential.
      //
      // plan 04 blocker: previously peer-client B would see
      // peer-client A's credential (written with A's coordinatorUrl), reject
      // it due to URL mismatch, fall back to the token, and get permanently
      // rejected because the token was already consumed.

      // Peer-client #1: no credential yet → uses join token → writes credential
      mockReadCredentialFile.mockResolvedValueOnce(null);

      const { client: client1 } = createPeerClient({
        url: 'ws://peer-a:8080/peer',
        joinToken: 'one-shot-token',
      });
      client1.connect();
      const mock1 = getLatestMock();
      simulateOpen(mock1);
      const { sessionKey: sk1 } = simulateServerHandshake(mock1);
      await vi.advanceTimersByTimeAsync(0);

      // Verify client #1 sent token-based auth
      const auth1 = JSON.parse(
        decryptMessage(mock1.sentMessages[mock1.sentMessages.length - 1], sk1),
      );
      expect(auth1.token).toBe('one-shot-token');
      expect(auth1.proof).toBeUndefined();

      // Server accepts and issues a sessionCredential. Client writes it.
      mock1.emit(
        'message',
        encryptMessage(
          JSON.stringify({
            type: 'peer.auth.response',
            accepted: true,
            instanceId: 'peer-a',
            sessionCredential: 'c'.repeat(64),
            role: 'coordinator',
          }),
          sk1,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);

      // Confirm the shared credential was written
      expect(mockWriteCredentialFile).toHaveBeenCalledWith(
        '/tmp/test-credential',
        expect.objectContaining({
          instanceId: 'local-orch',
          credential: 'c'.repeat(64),
        }),
      );

      // Peer-client #2 and #3 simulate reading that shared credential from disk
      // (as if sendAuthRequest ran immediately after #1 wrote the file).
      mockReadCredentialFile.mockResolvedValue({
        instanceId: 'local-orch',
        credential: 'c'.repeat(64),
        role: 'coordinator',
        issuedAt: '2026-04-11T00:00:00Z',
      });

      // Peer-client #2 → peer-b (DIFFERENT URL than what's in the cred file)
      const { client: client2 } = createPeerClient({
        url: 'ws://peer-b:8080/peer',
        joinToken: 'one-shot-token', // same token; if this fires, auth fails in prod
      });
      client2.connect();
      const mock2 = getLatestMock();
      simulateOpen(mock2);
      const { sessionKey: sk2 } = simulateServerHandshake(mock2);
      await vi.advanceTimersByTimeAsync(0);

      const auth2 = JSON.parse(
        decryptMessage(mock2.sentMessages[mock2.sentMessages.length - 1], sk2),
      );
      // Must be credential-based, NOT token fallback
      expect(auth2.proof).toBeDefined();
      expect(auth2.token).toBeUndefined();

      // Peer-client #3 → peer-c (yet another URL)
      const { client: client3 } = createPeerClient({
        url: 'ws://peer-c:8080/peer',
        joinToken: 'one-shot-token',
      });
      client3.connect();
      const mock3 = getLatestMock();
      simulateOpen(mock3);
      const { sessionKey: sk3 } = simulateServerHandshake(mock3);
      await vi.advanceTimersByTimeAsync(0);

      const auth3 = JSON.parse(
        decryptMessage(mock3.sentMessages[mock3.sentMessages.length - 1], sk3),
      );
      expect(auth3.proof).toBeDefined();
      expect(auth3.token).toBeUndefined();
    });
  });

  describe('auth rejection', () => {
    it('closes connection on auth rejection', async () => {
      const { client } = createPeerClient();
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      const { sessionKey } = simulateServerHandshake(mock);
      await vi.advanceTimersByTimeAsync(0);

      // Server sends encrypted auth rejection
      const authResponse = {
        type: 'peer.auth.response',
        accepted: false,
        reason: 'Invalid token',
      };
      mock.emit('message', encryptMessage(JSON.stringify(authResponse), sessionKey));

      expect(mock.closeCode).toBe(1000);
      expect(mock.closeReason).toBe('Auth rejected');
    });

    it.each([
      { reason: 'Invalid proof' },
      { reason: 'Unknown credential' },
      { reason: 'Credential revoked' },
    ])(
      'delegates to the coordinator and deletes a genuinely-stale credential file (reason="$reason")',
      async ({ reason }) => {
        // The on-disk credential matches the one this client proved with, so the
        // coordinator deletes it (no sibling refreshed it) before reconnecting.
        mockReadCredentialFile.mockResolvedValue({
          instanceId: 'local-orch',
          credential: 'still-current',
          role: 'coordinator',
          issuedAt: '2026-03-22T00:00:00Z',
        });
        const { client } = createPeerClient({ credentialFile: '/tmp/test-cred-stale' });
        client.connect();
        const mock = getLatestMock();
        simulateOpen(mock);

        const { sessionKey } = simulateServerHandshake(mock);
        await vi.advanceTimersByTimeAsync(0);

        mock.emit(
          'message',
          encryptMessage(
            JSON.stringify({ type: 'peer.auth.response', accepted: false, reason }),
            sessionKey,
          ),
        );

        // Coordinator's reportRejection runs async, then the close fires.
        await vi.advanceTimersByTimeAsync(0);
        expect(mockUnlink).toHaveBeenCalledWith('/tmp/test-cred-stale');
        expect(mock.closeCode).toBe(1000);
      },
    );

    it('does NOT delete a credential file a sibling refreshed (non-destructive rejection)', async () => {
      // The on-disk credential is FRESHER than the one this client proved with:
      // a sibling rewrote it. The coordinator must keep it and retry-credential.
      mockReadCredentialFile.mockResolvedValue({
        instanceId: 'local-orch',
        credential: 'fresh-from-sibling',
        role: 'coordinator',
        issuedAt: '2026-03-22T00:00:00Z',
      });
      const { client } = createPeerClient({ credentialFile: '/tmp/test-cred-fresh' });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      const { sessionKey } = simulateServerHandshake(mock);
      await vi.advanceTimersByTimeAsync(0);
      // Sibling rewrote the file AFTER this client computed its proof.
      mockReadCredentialFile.mockResolvedValue({
        instanceId: 'local-orch',
        credential: 'even-fresher',
        role: 'coordinator',
        issuedAt: '2026-03-23T00:00:00Z',
      });

      mock.emit(
        'message',
        encryptMessage(
          JSON.stringify({ type: 'peer.auth.response', accepted: false, reason: 'Invalid proof' }),
          sessionKey,
        ),
      );

      await vi.advanceTimersByTimeAsync(0);
      // File is NOT deleted — the sibling's refreshed credential is preserved.
      expect(mockUnlink).not.toHaveBeenCalled();
      expect(mock.closeCode).toBe(1000);
    });

    it.each([
      { reason: 'Role mismatch' },
      { reason: 'Missing auth method' },
      { reason: 'Unsupported protocol version: 0 < 1' },
    ])(
      'does NOT touch the credential file on config-error rejection (reason="$reason")',
      async ({ reason }) => {
        mockReadCredentialFile.mockResolvedValue({
          instanceId: 'local-orch',
          credential: 'still-current',
          role: 'coordinator',
          issuedAt: '2026-03-22T00:00:00Z',
        });
        const { client } = createPeerClient({ credentialFile: '/tmp/test-cred-cfg' });
        client.connect();
        const mock = getLatestMock();
        simulateOpen(mock);

        const { sessionKey } = simulateServerHandshake(mock);
        await vi.advanceTimersByTimeAsync(0);

        mock.emit(
          'message',
          encryptMessage(
            JSON.stringify({ type: 'peer.auth.response', accepted: false, reason }),
            sessionKey,
          ),
        );

        // Config errors skip the coordinator entirely — operator must intervene.
        await vi.advanceTimersByTimeAsync(0);
        expect(mockUnlink).not.toHaveBeenCalled();
        expect(mock.closeCode).toBe(1000);
      },
    );

    it('tolerates ENOENT when the credential file is already gone', async () => {
      mockReadCredentialFile.mockResolvedValue({
        instanceId: 'local-orch',
        credential: 'still-current',
        role: 'coordinator',
        issuedAt: '2026-03-22T00:00:00Z',
      });
      mockUnlink.mockImplementationOnce(() => {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        return Promise.reject(err);
      });
      const { client } = createPeerClient({ credentialFile: '/tmp/test-cred-missing' });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      const { sessionKey } = simulateServerHandshake(mock);
      await vi.advanceTimersByTimeAsync(0);

      mock.emit(
        'message',
        encryptMessage(
          JSON.stringify({ type: 'peer.auth.response', accepted: false, reason: 'Invalid proof' }),
          sessionKey,
        ),
      );

      // The coordinator swallows ENOENT and the connection still closes cleanly.
      await vi.advanceTimersByTimeAsync(0);
      expect(mock.closeCode).toBe(1000);
    });
  });

  describe('onAuthenticated callback', () => {
    it('fires with the remote peer instanceId on accepted auth response', async () => {
      const onAuthenticated = vi.fn();
      const { client } = createPeerClient({ onAuthenticated });
      await authenticateClient(client);

      expect(onAuthenticated).toHaveBeenCalledTimes(1);
      expect(onAuthenticated).toHaveBeenCalledWith('remote-orch');
    });

    it('does not fire on rejected auth response', async () => {
      const onAuthenticated = vi.fn();
      const { client } = createPeerClient({ onAuthenticated });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      const { sessionKey } = simulateServerHandshake(mock);
      await vi.advanceTimersByTimeAsync(0);

      mock.emit(
        'message',
        encryptMessage(
          JSON.stringify({
            type: 'peer.auth.response',
            accepted: false,
            reason: 'Invalid token',
          }),
          sessionKey,
        ),
      );

      expect(onAuthenticated).not.toHaveBeenCalled();
    });
  });

  describe('connected state', () => {
    it('transitions to connected on accepted auth response', async () => {
      const { client } = createPeerClient();
      const { mock, sessionKey } = await authenticateClient(client);

      expect(client.state).toBe('connected');
      expect(client.targetInstanceId).toBe('remote-orch');
    });

    it('registers peer in registry', async () => {
      const { client, registry } = createPeerClient();
      await authenticateClient(client);

      const peer = registry.getPeer('remote-orch');
      expect(peer).toBeDefined();
      expect(peer!.connected).toBe(true);
    });

    it('sends encrypted messages when connected', async () => {
      const { client } = createPeerClient();
      const { mock, sessionKey } = await authenticateClient(client);

      const countBefore = mock.sentMessages.length;

      const result = client.send({
        type: 'peer.heartbeat',
        instanceId: 'local-orch',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        timestamp: Date.now(),
      });

      expect(result).toBe(true);
      expect(mock.sentMessages.length).toBe(countBefore + 1);

      // Verify the message is encrypted
      const lastMsg = mock.sentMessages[mock.sentMessages.length - 1];
      const decrypted = JSON.parse(decryptMessage(lastMsg, sessionKey));
      expect(decrypted.type).toBe('peer.heartbeat');
    });

    it('returns false from send() when disconnected', () => {
      const { client } = createPeerClient();

      const result = client.send({
        type: 'peer.heartbeat',
        instanceId: 'local-orch',
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

  describe('message routing', () => {
    it('routes encrypted heartbeat to registry', async () => {
      const { client, registry } = createPeerClient();
      const { mock, sessionKey } = await authenticateClient(client);

      const heartbeat = {
        type: 'peer.heartbeat',
        instanceId: 'remote-orch',
        term: 2,
        leaderId: 'remote-orch',
        draining: false,
        agents: [
          {
            agentId: 'remote-agent',
            labels: ['linux', 'arm64'],
            activeJobs: 1,
            maxConcurrency: 4,
            platform: 'linux',
            arch: 'arm64',
          },
        ],
        capabilities: { s3LogAccess: true },
        timestamp: Date.now(),
      };
      mock.emit('message', encryptMessage(JSON.stringify(heartbeat), sessionKey));

      const peer = registry.getPeer('remote-orch');
      expect(peer!.agents).toHaveLength(1);
      expect(peer!.agents[0].agentId).toBe('remote-agent');
    });

    it('routes encrypted job.reroute to callback', async () => {
      const onJobReroute = vi.fn().mockResolvedValue(undefined);
      const { client } = createPeerClient({ onJobReroute });
      const { mock, sessionKey } = await authenticateClient(client);

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
      mock.emit('message', encryptMessage(JSON.stringify(reroute), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      expect(onJobReroute).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'job.reroute', messageId: 'msg-1' }),
      );
    });

    it('routes encrypted peer.agent-token.revoke to onAgentTokenRevoke callback', async () => {
      const onAgentTokenRevoke = vi.fn();
      const { client } = createPeerClient({ onAgentTokenRevoke });
      const { mock, sessionKey } = await authenticateClient(client);

      const revoke = {
        type: 'peer.agent-token.revoke',
        tokenId: 'tok-fanout-target',
        senderInstanceId: 'remote-orch',
      };
      mock.emit('message', encryptMessage(JSON.stringify(revoke), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      expect(onAgentTokenRevoke).toHaveBeenCalledTimes(1);
      expect(onAgentTokenRevoke).toHaveBeenCalledWith(revoke);
    });

    it('dispatches job.progress.ack to onJobProgressAck', () => {
      const onJobProgressAck = vi.fn();
      const { client } = createPeerClient({ onJobProgressAck });
      const ack: JobProgressAck = {
        type: 'job.progress.ack',
        runId: 'r1',
        jobId: 'j1',
        state: ExecutionJobStatus.enum.success,
      };
      // routeMessage is private; exercise it via a typed test seam.
      (client as unknown as { routeMessage(m: unknown): void }).routeMessage(ack);
      expect(onJobProgressAck).toHaveBeenCalledWith(ack);
    });
  });

  describe('onConnected callback', () => {
    it('fires with this peer URL once the client reaches the connected state', async () => {
      const onConnected = vi.fn();
      const { client } = createPeerClient({ onConnected });
      await authenticateClient(client);

      expect(client.state).toBe('connected');
      expect(onConnected).toHaveBeenCalledTimes(1);
      expect(onConnected).toHaveBeenCalledWith('ws://192.168.1.10:8080/peer');
    });

    it('does not fire on rejected auth response', async () => {
      const onConnected = vi.fn();
      const { client } = createPeerClient({ onConnected });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      const { sessionKey } = simulateServerHandshake(mock);
      await vi.advanceTimersByTimeAsync(0);

      mock.emit(
        'message',
        encryptMessage(
          JSON.stringify({ type: 'peer.auth.response', accepted: false, reason: 'Invalid token' }),
          sessionKey,
        ),
      );

      expect(onConnected).not.toHaveBeenCalled();
    });
  });

  describe('reconnection', () => {
    it('schedules reconnect on unexpected close', async () => {
      const { client } = createPeerClient();
      const { mock } = await authenticateClient(client);

      mock.readyState = 3;
      mock.emit('close', 1006, Buffer.from('abnormal'));

      expect(client.state).toBe('disconnected');

      vi.advanceTimersByTime(2000);

      expect(mockInstances.length).toBe(2);
    });

    it('does not reconnect after intentional disconnect', async () => {
      const { client } = createPeerClient();
      await authenticateClient(client);

      client.disconnect();

      vi.advanceTimersByTime(120_000);

      expect(mockInstances.length).toBe(1);
    });
  });

  describe('disconnect', () => {
    it('marks peer as disconnected in registry', async () => {
      const { client, registry } = createPeerClient();
      await authenticateClient(client);

      expect(registry.getPeer('remote-orch')!.connected).toBe(true);

      client.disconnect();

      expect(registry.getPeer('remote-orch')!.connected).toBe(false);
    });
  });

  describe('auth request includes softwareVersion and role', () => {
    it('includes softwareVersion and role in token-based auth request', async () => {
      const { client } = createPeerClient({ joinToken: 'kici_join_v1.test.token', role: 'worker' });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      const { sessionKey } = simulateServerHandshake(mock);
      await vi.advanceTimersByTimeAsync(0);

      const lastMsg = mock.sentMessages[mock.sentMessages.length - 1];
      const decrypted = JSON.parse(decryptMessage(lastMsg, sessionKey));

      expect(decrypted.type).toBe('peer.auth.request');
      expect(decrypted.softwareVersion).toBeDefined();
      expect(typeof decrypted.softwareVersion).toBe('string');
      expect(decrypted.role).toBe('worker');
    });

    it('defaults role to coordinator when not specified', async () => {
      const { client } = createPeerClient({ joinToken: 'kici_join_v1.test.token' });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      const { sessionKey } = simulateServerHandshake(mock);
      await vi.advanceTimersByTimeAsync(0);

      const lastMsg = mock.sentMessages[mock.sentMessages.length - 1];
      const decrypted = JSON.parse(decryptMessage(lastMsg, sessionKey));

      expect(decrypted.role).toBe('coordinator');
    });
  });

  describe('sendLogChunk', () => {
    it('encrypts and sends peer.log.chunk message', async () => {
      const { client } = createPeerClient();
      const { mock, sessionKey } = await authenticateClient(client);

      const countBefore = mock.sentMessages.length;

      const result = client.sendLogChunk({
        type: 'peer.log.chunk',
        runId: 'run-1',
        jobId: 'job-1',
        stepIndex: 0,
        lines: [{ text: 'Hello, world!', timestamp: Date.now() }],
      });

      expect(result).toBe(true);
      expect(mock.sentMessages.length).toBe(countBefore + 1);

      const lastMsg = mock.sentMessages[mock.sentMessages.length - 1];
      const decrypted = JSON.parse(decryptMessage(lastMsg, sessionKey));
      expect(decrypted.type).toBe('peer.log.chunk');
      expect(decrypted.runId).toBe('run-1');
      expect(decrypted.lines).toHaveLength(1);
    });
  });

  describe('sendCacheUploadRequest', () => {
    it('sends request and resolves on response', async () => {
      const { client } = createPeerClient();
      const { mock, sessionKey } = await authenticateClient(client);

      const req = {
        type: 'peer.cache.upload.request' as const,
        messageId: 'cache-req-1',
        runId: 'run-1',
        jobId: 'job-1',
        cacheType: 'source' as const,
        hash: 'abc123',
        sizeBytes: 1024,
      };

      const promise = client.sendCacheUploadRequest(req);

      // Simulate coordinator response
      const response = {
        type: 'peer.cache.upload.response',
        messageId: 'cache-req-1',
        runId: 'run-1',
        jobId: 'job-1',
        uploadUrl: 'https://s3.example.com/presigned-url',
      };
      mock.emit('message', encryptMessage(JSON.stringify(response), sessionKey));

      const result = await promise;
      expect(result.uploadUrl).toBe('https://s3.example.com/presigned-url');
      expect(result.messageId).toBe('cache-req-1');
    });

    it('rejects on timeout', async () => {
      const { client } = createPeerClient();
      await authenticateClient(client);

      const req = {
        type: 'peer.cache.upload.request' as const,
        messageId: 'cache-req-timeout',
        runId: 'run-1',
        jobId: 'job-1',
        cacheType: 'deps' as const,
        hash: 'def456',
        sizeBytes: 2048,
      };

      const promise = client.sendCacheUploadRequest(req, 5000);

      // Advance time past timeout
      vi.advanceTimersByTime(6000);

      await expect(promise).rejects.toThrow('Cache upload request timed out');
    });
  });

  describe('config reload routing', () => {
    it('handles incoming peer.config.reload by invoking onPeerConfigReload', async () => {
      const onPeerConfigReload = vi.fn().mockResolvedValue({
        success: true,
        version: 11,
        fieldsChanged: ['port'],
      });
      const { client } = createPeerClient({ onPeerConfigReload });
      const { mock, sessionKey } = await authenticateClient(client);
      const countBefore = mock.sentMessages.length;

      // Simulate coordinator-side request
      const reloadMsg = {
        type: 'peer.config.reload',
        messageId: 'rl-client-1',
        drain: false,
      };
      mock.emit('message', encryptMessage(JSON.stringify(reloadMsg), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      expect(onPeerConfigReload).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'peer.config.reload', messageId: 'rl-client-1' }),
      );

      // Find the reply
      let response: any = null;
      for (const msg of mock.sentMessages.slice(countBefore)) {
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
      expect(response.messageId).toBe('rl-client-1');
      expect(response.success).toBe(true);
      expect(response.version).toBe(11);
    });

    it('sendConfigReloadAndWait resolves with response', async () => {
      const { client } = createPeerClient();
      const { mock, sessionKey } = await authenticateClient(client);

      const promise = client.sendConfigReloadAndWait(
        { type: 'peer.config.reload', messageId: 'rl-out-1' },
        5_000,
      );

      const response = {
        type: 'peer.config.reload.response',
        messageId: 'rl-out-1',
        success: true,
        version: 4,
      };
      mock.emit('message', encryptMessage(JSON.stringify(response), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      const result = await promise;
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      expect(result!.version).toBe(4);
    });

    it('sendConfigReloadAndWait returns null when not connected', async () => {
      const { client } = createPeerClient();
      // Do not connect
      const result = await client.sendConfigReloadAndWait(
        { type: 'peer.config.reload', messageId: 'rl-disc' },
        500,
      );
      expect(result).toBeNull();
    });

    it('sendConfigReloadAndWait resolves with success=false on timeout', async () => {
      const { client } = createPeerClient();
      await authenticateClient(client);

      const promise = client.sendConfigReloadAndWait(
        { type: 'peer.config.reload', messageId: 'rl-timeout' },
        500,
      );

      await vi.advanceTimersByTimeAsync(600);

      const result = await promise;
      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.errors?.[0]).toMatch(/timed out/);
    });
  });

  describe('peer fleet log collection', () => {
    const collectReq = {
      type: 'peer.logs.collect.request' as const,
      messageId: 'lc-out-1',
      logWindowHours: 4,
      includeCoordinatorMesh: false,
      selection: { all: true, agentIds: [], workerInstanceIds: [] },
    };

    it('sendLogsCollectAndWait reassembles a chunked subtree bundle', async () => {
      const { client } = createPeerClient();
      const { mock, sessionKey } = await authenticateClient(client);
      const payload = Buffer.from('PK-subtree-zip'.repeat(20));

      const promise = client.sendLogsCollectAndWait(collectReq, 5_000);

      for (const f of chunkBuffer(payload)) {
        mock.emit(
          'message',
          encryptMessage(
            JSON.stringify({
              type: 'peer.logs.collect.chunk',
              messageId: 'lc-out-1',
              seq: f.seq,
              isLast: f.isLast,
              dataB64: f.dataB64,
            }),
            sessionKey,
          ),
        );
      }
      await vi.advanceTimersByTimeAsync(0);

      const result = await promise;
      expect(result.equals(payload)).toBe(true);
    });

    it('sendLogsCollectAndWait rejects on an error frame', async () => {
      const { client } = createPeerClient();
      const { mock, sessionKey } = await authenticateClient(client);

      const promise = client.sendLogsCollectAndWait(collectReq, 5_000);
      // Attach the rejection expectation before emitting so the rejection is
      // never momentarily unhandled.
      const assertion = expect(promise).rejects.toThrow('subtree build failed');
      mock.emit(
        'message',
        encryptMessage(
          JSON.stringify({
            type: 'peer.logs.collect.error',
            messageId: 'lc-out-1',
            message: 'subtree build failed',
          }),
          sessionKey,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await assertion;
    });

    it('sendLogsCollectAndWait rejects when not connected', async () => {
      const { client } = createPeerClient();
      // Not connected — the send fails and the waiter is rejected immediately.
      await expect(client.sendLogsCollectAndWait(collectReq, 500)).rejects.toThrow(
        /not connected/i,
      );
    });
  });

  // ── `permessage-deflate` compression bomb defense (security invariant) ──
  //
  // Invariant (per the pentest catalog at
  // every WS endpoint MUST cap `maxPayload`. PeerClient connects orchestrator-
  // to-orchestrator, so a rogue or compromised peer could otherwise OOM the
  // initiating orchestrator with a compression bomb. Pre- fix this site
  // had NO options at all (`new WebSocket(this.url)`).
  describe('compression bomb defense (security invariant)', () => {
    it('caps maxPayload on the WebSocket constructor (= WS_MAX_PAYLOAD_BYTES)', () => {
      const { client } = createPeerClient();
      client.connect();

      const args = mockConstructorArgs[mockConstructorArgs.length - 1];
      expect(args).toBeDefined();
      const options = args![1] as Record<string, unknown> | undefined;
      expect(options).toBeDefined();

      expect(options!['maxPayload']).toBe(WS_MAX_PAYLOAD_BYTES);
    });
  });
});
