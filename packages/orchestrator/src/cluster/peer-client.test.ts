import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  WS_CLOSE_PROTOCOL_ERROR,
  WS_CLOSE_UNAUTHORIZED,
  WS_MAX_PAYLOAD_BYTES,
  jobRerouteSchema,
  ExecutionJobStatus,
  ScalerOrphansAction,
  ScalerVmStopOutcome,
  PeerForgetOutcome,
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
import {
  credentialPsk,
  makeTestJoinToken,
  refAppKey,
  refClientProof,
  refServerProof,
  refTranscriptHash,
  tokenPsk,
} from '../__test-helpers__/peer-mutual-auth.js';
import {
  NO_AUTH_METHOD_MESSAGE,
  PeerClient,
  PeerDialOrigin,
  PeerMutualAuthFailure,
  type PeerClientOptions,
} from './peer-client.js';
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

    terminate(): void {
      this.readyState = 3;
      setImmediate(() => {
        this.emit('close', 1006, Buffer.from(''));
      });
    }
  }

  return {
    default: MockWS,
    WebSocket: MockWS,
  };
});

// ── Capture the peer-client logger (wraps the real one) ────────────

const loggerHolder = vi.hoisted(() => ({
  peerClient: undefined as
    undefined | { warn: (...a: unknown[]) => unknown; debug: (...a: unknown[]) => unknown },
}));

vi.mock('@kici-dev/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kici-dev/shared')>();
  return {
    ...actual,
    createLogger: (opts?: { prefix?: string }) => {
      const real = actual.createLogger(opts);
      if (opts?.prefix === 'peer-client') loggerHolder.peerClient = real as never;
      return real;
    },
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

/** A join token in the production format; the client parses it now. */
const TEST_TOKEN = makeTestJoinToken({
  orgId: 'org-1',
  routingKey: 'github:42',
  expiry: Date.now() + 3_600_000,
  role: 'coordinator',
});
/** A second token, for the tests that tell two tokens apart. */
const ONE_SHOT_TOKEN = makeTestJoinToken({
  orgId: 'org-1',
  routingKey: 'github:43',
  expiry: Date.now() + 3_600_000,
  role: 'coordinator',
});
const TOKEN_HASH_BY_ROUTING = new Map([
  [TEST_TOKEN.routingB64, TEST_TOKEN.tokenHash],
  [ONE_SHOT_TOKEN.routingB64, ONE_SHOT_TOKEN.tokenHash],
]);

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
        mandatoryLabels: [],
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
  const joinToken = 'joinToken' in overrides ? overrides.joinToken : TEST_TOKEN.token;
  const client = new PeerClient({
    url: 'ws://192.168.1.10:8080/peer',
    joinToken: TEST_TOKEN.token,
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

interface ServerHandshake {
  /** K_hs: the auth request and response travel under it. */
  sessionKey: Buffer;
  nonce: Buffer;
  /** TH, computed by the independent helper over the hello the test sent. */
  transcriptHash: Buffer;
}

/**
 * Play the server's peer.hello (advertising mutual-v2 unless told otherwise)
 * and read the client's peer.hello.response.
 */
function simulateServerHandshake(
  mock: MockWsInstance,
  opts: { authSchemes?: string[] | null } = {},
): ServerHandshake {
  const serverEcdh = generateEcdhKeyPair();
  const nonce = randomBytes(32);
  const authSchemes = opts.authSchemes === undefined ? ['mutual-v2'] : opts.authSchemes;

  mock.emit(
    'message',
    JSON.stringify({
      type: 'peer.hello',
      ephemeralPublicKey: serverEcdh.publicKey.toString('base64'),
      nonce: nonce.toString('base64'),
      ...(authSchemes && { authSchemes }),
    }),
  );

  const clientResponse = JSON.parse(mock.sentMessages[mock.sentMessages.length - 1]);
  expect(clientResponse.type).toBe('peer.hello.response');
  const clientPub = Buffer.from(clientResponse.ephemeralPublicKey, 'base64');
  return {
    sessionKey: deriveSessionKey(serverEcdh.privateKey, clientPub, nonce),
    nonce,
    transcriptHash: refTranscriptHash(serverEcdh.publicKey, nonce, authSchemes ?? [], clientPub),
  };
}

/** The client's decrypted peer.auth.request (the last frame it sent). */
function readAuthRequest(mock: MockWsInstance, handshakeKey: Buffer): Record<string, any> {
  return JSON.parse(decryptMessage(mock.sentMessages[mock.sentMessages.length - 1], handshakeKey));
}

/** The PSK the client proved with: its token hash, or sha256 of its credential file. */
async function pskFor(authRequest: Record<string, any>): Promise<Buffer> {
  if (authRequest.mode === 'token') {
    return tokenPsk(TOKEN_HASH_BY_ROUTING.get(authRequest.tokenRouting)!);
  }
  const file = await mockReadCredentialFile.getMockImplementation()?.();
  return credentialPsk(file.credential);
}

interface AcceptOptions {
  psk?: Buffer;
  remoteInstanceId?: string;
  grantedRole?: string;
  /** Defaults to a fresh credential in token mode, none in credential mode. */
  sessionCredential?: string | null;
  /** null sends no serverProof; a Buffer sends that proof instead of the right one. */
  serverProof?: Buffer | null;
}

/** Send the server's accepted response for a handshake already played; returns K_app. */
async function acceptOn(
  mock: MockWsInstance,
  hs: ServerHandshake,
  opts: AcceptOptions = {},
): Promise<Buffer> {
  const authRequest = readAuthRequest(mock, hs.sessionKey);
  const psk = opts.psk ?? (await pskFor(authRequest));
  const clientProof = Buffer.from(String(authRequest.clientProof), 'hex');
  const remoteInstanceId = opts.remoteInstanceId ?? 'remote-orch';
  const grantedRole = opts.grantedRole ?? 'coordinator';
  const sessionCredential =
    opts.sessionCredential !== undefined
      ? opts.sessionCredential
      : authRequest.mode === 'token'
        ? randomBytes(32).toString('hex')
        : null;
  const rightProof = refServerProof({
    psk,
    th: hs.transcriptHash,
    clientProof,
    serverInstanceId: remoteInstanceId,
    grantedRole,
    sessionCredential,
  });
  const serverProof = opts.serverProof === undefined ? rightProof : opts.serverProof;
  mock.emit(
    'message',
    encryptMessage(
      JSON.stringify({
        type: 'peer.auth.response',
        accepted: true,
        instanceId: remoteInstanceId,
        role: grantedRole,
        ...(serverProof && { serverProof: serverProof.toString('hex') }),
        ...(sessionCredential !== null && { sessionCredential }),
        agents: [],
        capabilities: { s3LogAccess: false },
      }),
      hs.sessionKey,
    ),
  );
  await vi.advanceTimersByTimeAsync(0);
  return refAppKey({
    handshakeKey: hs.sessionKey,
    psk,
    th: hs.transcriptHash,
    clientProof,
    serverProof: rightProof,
  });
}

/**
 * Complete the full ECDH + mutual-v2 flow. Returns K_app as `sessionKey` for
 * further message exchange, and K_hs as `handshakeKey`.
 */
async function authenticateClient(
  client: PeerClient,
  opts: AcceptOptions = {},
): Promise<{
  mock: MockWsInstance;
  sessionKey: Buffer;
  handshakeKey: Buffer;
  hs: ServerHandshake;
}> {
  client.connect();
  const mock = getLatestMock();
  simulateOpen(mock);
  const hs = simulateServerHandshake(mock);
  await vi.advanceTimersByTimeAsync(0);
  const sessionKey = await acceptOn(mock, hs, opts);
  return { mock, sessionKey, handshakeKey: hs.sessionKey, hs };
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
      const { client } = createPeerClient();
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
      expect(decrypted).toMatchObject({
        scheme: 'mutual-v2',
        mode: 'token',
        tokenRouting: TEST_TOKEN.routingB64,
      });
      expect(decrypted).not.toHaveProperty('token');
      expect(decrypted).not.toHaveProperty('proof');
    });

    it('proves the token with a client proof bound to the transcript', async () => {
      const { client } = createPeerClient();
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);
      const hs = simulateServerHandshake(mock);
      await vi.advanceTimersByTimeAsync(0);
      const decrypted = readAuthRequest(mock, hs.sessionKey);
      // breaks-if-wrong: the server recomputes this exact proof from its own view
      expect(decrypted.clientProof).toBe(
        refClientProof({
          psk: tokenPsk(TEST_TOKEN.tokenHash),
          th: hs.transcriptHash,
          mode: 'token',
          instanceId: 'local-orch',
          role: 'coordinator',
          protocolVersion: PROTOCOL_VERSION,
          tokenRouting: TEST_TOKEN.routingB64,
        }).toString('hex'),
      );
    });

    it('persists credential to file after receiving sessionCredential', async () => {
      const { client } = createPeerClient();
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      const hs = simulateServerHandshake(mock);
      await vi.advanceTimersByTimeAsync(0);

      // Server accepts with a sessionCredential its proof covers
      await acceptOn(mock, hs, { sessionCredential: 'a'.repeat(64) });

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

      const hs = simulateServerHandshake(mock);
      await vi.advanceTimersByTimeAsync(0);

      const decrypted = readAuthRequest(mock, hs.sessionKey);
      expect(decrypted.type).toBe('peer.auth.request');
      expect(decrypted.mode).toBe('credential');
      expect(decrypted).not.toHaveProperty('token');
      expect(decrypted).not.toHaveProperty('tokenRouting');
      expect(decrypted.clientProof).toBe(
        refClientProof({
          psk: credentialPsk('b'.repeat(64)),
          th: hs.transcriptHash,
          mode: 'credential',
          instanceId: 'local-orch',
          role: 'coordinator',
          protocolVersion: PROTOCOL_VERSION,
          tokenRouting: '',
        }).toString('hex'),
      );
    });

    it('reuses credential across different target peer URLs (identity-scoped, not URL-scoped)', async () => {
      // 4-coordinator mesh regression: credential file is written
      // once by the first successful peer-client. Sibling peer-clients on the
      // same orchestrator connecting to DIFFERENT target URLs must still
      // accept that credential, because the server-side verifies by
      // instanceId, not by requester URL. The credential
      // file no longer records `coordinatorUrl` at all — identity scope alone.
      mockReadCredentialFile.mockResolvedValue({
        instanceId: 'local-orch',
        credential: 'b'.repeat(64),
        role: 'coordinator',
        issuedAt: '2026-03-22T00:00:00Z',
      });

      const { client } = createPeerClient({
        url: 'ws://different-host:8080/peer',
        joinToken: ONE_SHOT_TOKEN.token,
      });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      const hs = simulateServerHandshake(mock);
      await vi.advanceTimersByTimeAsync(0);

      const decrypted = readAuthRequest(mock, hs.sessionKey);
      expect(decrypted.type).toBe('peer.auth.request');
      // Should use credential-based auth, NOT fall back to token
      expect(decrypted.mode).toBe('credential');
      expect(decrypted.clientProof).toBe(
        refClientProof({
          psk: credentialPsk('b'.repeat(64)),
          th: hs.transcriptHash,
          mode: 'credential',
          instanceId: 'local-orch',
          role: 'coordinator',
          protocolVersion: PROTOCOL_VERSION,
          tokenRouting: '',
        }).toString('hex'),
      );
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

      const { client } = createPeerClient({ joinToken: ONE_SHOT_TOKEN.token });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);

      const { sessionKey } = simulateServerHandshake(mock);
      await vi.advanceTimersByTimeAsync(0);

      const lastMsg = mock.sentMessages[mock.sentMessages.length - 1];
      const decrypted = JSON.parse(decryptMessage(lastMsg, sessionKey));

      expect(decrypted.type).toBe('peer.auth.request');
      expect(decrypted.mode).toBe('token');
      expect(decrypted.tokenRouting).toBe(ONE_SHOT_TOKEN.routingB64);
    });

    it('one credential file serves N peer-clients in a multi-coordinator mesh', async () => {
      // Simulate the 4-coordinator mesh scenario: orchestrator "local-orch"
      // has 3 peer-clients, each connecting to a different peer. They all
      // share the same on-disk credential file. Only the first one uses the
      // join token; the other two read the shared credential.
      //
      // Regression: peer-client B would see
      // peer-client A's credential (written with A's coordinatorUrl), reject
      // it due to URL mismatch, fall back to the token, and get permanently
      // rejected because the token was already consumed.

      // Peer-client #1: no credential yet → uses join token → writes credential
      mockReadCredentialFile.mockResolvedValueOnce(null);

      const { client: client1 } = createPeerClient({
        url: 'ws://peer-a:8080/peer',
        joinToken: ONE_SHOT_TOKEN.token,
      });
      client1.connect();
      const mock1 = getLatestMock();
      simulateOpen(mock1);
      const hs1 = simulateServerHandshake(mock1);
      await vi.advanceTimersByTimeAsync(0);

      // Verify client #1 sent token-based auth
      const auth1 = readAuthRequest(mock1, hs1.sessionKey);
      expect(auth1.mode).toBe('token');
      expect(auth1.tokenRouting).toBe(ONE_SHOT_TOKEN.routingB64);

      // Server accepts and issues a sessionCredential. Client writes it.
      await acceptOn(mock1, hs1, { remoteInstanceId: 'peer-a', sessionCredential: 'c'.repeat(64) });

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
        joinToken: ONE_SHOT_TOKEN.token, // same token; if this fires, auth fails in prod
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
      expect(auth2.mode).toBe('credential');

      // Peer-client #3 → peer-c (yet another URL)
      const { client: client3 } = createPeerClient({
        url: 'ws://peer-c:8080/peer',
        joinToken: ONE_SHOT_TOKEN.token,
      });
      client3.connect();
      const mock3 = getLatestMock();
      simulateOpen(mock3);
      const { sessionKey: sk3 } = simulateServerHandshake(mock3);
      await vi.advanceTimersByTimeAsync(0);

      const auth3 = JSON.parse(
        decryptMessage(mock3.sentMessages[mock3.sentMessages.length - 1], sk3),
      );
      expect(auth3.mode).toBe('credential');
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
            mandatoryLabels: [],
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

    it('routes encrypted job.progress to callback with the authenticated target peer id', async () => {
      const onJobProgress = vi.fn();
      const { client } = createPeerClient({ onJobProgress });
      const { mock, sessionKey } = await authenticateClient(client);

      const jobProgress = {
        type: 'job.progress',
        kind: 'job',
        runId: 'run-1',
        jobId: 'job-1',
        jobName: 'build',
        stepIndex: 0,
        stepName: '',
        state: 'running',
        timestamp: Date.now(),
      };
      mock.emit('message', encryptMessage(JSON.stringify(jobProgress), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      expect(onJobProgress).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'job.progress', runId: 'run-1', jobId: 'job-1' }),
        // `_targetInstanceId` set at the auth handshake — the coordinator uses it
        // to verify signal provenance against the tracked reroute target.
        'remote-orch',
        expect.any(Function),
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

    it('resolves a cluster-settings pull with the leader response', async () => {
      const { client } = createPeerClient();
      const { mock, sessionKey } = await authenticateClient(client);

      const pending = client.sendClusterSettingsRequestAndWait({
        type: 'peer.clusterSettings.request',
        messageId: 'cs-1',
      });

      const response = {
        type: 'peer.clusterSettings.response',
        messageId: 'cs-1',
        version: 4,
        settings: { agentTokenTtlMs: 42_000 },
      };
      mock.emit('message', encryptMessage(JSON.stringify(response), sessionKey));

      await expect(pending).resolves.toEqual(response);
    });

    it('sendClusterSettingsRequestAndWait returns null when not connected', async () => {
      const { client } = createPeerClient();
      await expect(
        client.sendClusterSettingsRequestAndWait({
          type: 'peer.clusterSettings.request',
          messageId: 'cs-x',
        }),
      ).resolves.toBeNull();
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

  describe('no auth method', () => {
    // fails-when: the warning sits outside the once-guard and fires per reconnect.
    // breaks-if-wrong: the first attempt warns, and an accepted auth re-arms it.
    it('warns once per client across reconnects and again after an accepted auth', async () => {
      const warn = vi.spyOn(loggerHolder.peerClient!, 'warn');
      const debug = vi.spyOn(loggerHolder.peerClient!, 'debug');
      const noAuthCalls = (spy: typeof warn) =>
        spy.mock.calls.filter(([message]) => message === NO_AUTH_METHOD_MESSAGE).length;

      const { client } = createPeerClient({ joinToken: undefined });

      async function attempt(): Promise<MockWsInstance> {
        const mock = getLatestMock();
        simulateOpen(mock);
        simulateServerHandshake(mock);
        await vi.advanceTimersByTimeAsync(0);
        return mock;
      }

      client.connect();
      const first = await attempt();
      expect(first.closeReason).toBe('No auth method');
      await vi.advanceTimersByTimeAsync(60_000);
      const second = await attempt();
      expect(second).not.toBe(first);
      expect(second.closeReason).toBe('No auth method');
      expect(noAuthCalls(warn)).toBe(1);
      expect(noAuthCalls(debug)).toBe(1);

      mockReadCredentialFile.mockResolvedValue({
        instanceId: 'local-orch',
        credential: 'c'.repeat(64),
        role: 'coordinator',
        issuedAt: new Date(0).toISOString(),
      });
      await vi.advanceTimersByTimeAsync(60_000);
      const third = getLatestMock();
      simulateOpen(third);
      const thirdHs = simulateServerHandshake(third);
      await vi.advanceTimersByTimeAsync(0);
      await acceptOn(third, thirdHs);
      expect(client.state).toBe('connected');

      mockReadCredentialFile.mockResolvedValue(null);
      third.readyState = 3;
      third.emit('close', 1006, Buffer.from('abnormal'));
      await vi.advanceTimersByTimeAsync(60_000);
      await attempt();
      expect(noAuthCalls(warn)).toBe(2);
      warn.mockRestore();
      debug.mockRestore();
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
      const { client } = createPeerClient({ role: 'worker' });
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
      const { client } = createPeerClient();
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

  describe('peer forget routing', () => {
    it('answers a request through onPeerForgetRequest, and waits for a response', async () => {
      const onPeerForgetRequest = vi.fn(async () => ({
        outcome: PeerForgetOutcome.enum.forgotten,
        detail: 'coord-gone forgotten',
      }));
      const { client } = createPeerClient({ onPeerForgetRequest });
      const { mock, sessionKey } = await authenticateClient(client);
      const countBefore = mock.sentMessages.length;

      mock.emit(
        'message',
        encryptMessage(
          JSON.stringify({
            type: 'peer.forget.request',
            messageId: 'fc-1',
            instanceId: 'coord-gone',
          }),
          sessionKey,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      const replies = mock.sentMessages
        .slice(countBefore)
        .map((m: string) => {
          try {
            return JSON.parse(decryptMessage(m, sessionKey));
          } catch {
            return null;
          }
        })
        .filter((m: any) => m?.type === 'peer.forget.response');
      expect(replies).toEqual([
        expect.objectContaining({ messageId: 'fc-1', outcome: PeerForgetOutcome.enum.forgotten }),
      ]);

      const pending = client.sendPeerForgetAndWait(
        { type: 'peer.forget.request', messageId: 'fc-out', instanceId: 'coord-gone' },
        5_000,
      );
      mock.emit(
        'message',
        encryptMessage(
          JSON.stringify({
            type: 'peer.forget.response',
            messageId: 'fc-out',
            outcome: PeerForgetOutcome.enum.forgotten,
            detail: 'ok',
          }),
          sessionKey,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(await pending).toMatchObject({ outcome: PeerForgetOutcome.enum.forgotten });
    });

    it('answers error when no forget handler is wired', async () => {
      const { client } = createPeerClient();
      const { mock, sessionKey } = await authenticateClient(client);
      const countBefore = mock.sentMessages.length;
      mock.emit(
        'message',
        encryptMessage(
          JSON.stringify({ type: 'peer.forget.request', messageId: 'fc-2', instanceId: 'x' }),
          sessionKey,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      const reply = mock.sentMessages
        .slice(countBefore)
        .map((m: string) => JSON.parse(decryptMessage(m, sessionKey)))
        .find((m: any) => m.type === 'peer.forget.response');
      expect(reply).toMatchObject({
        outcome: PeerForgetOutcome.enum.error,
        detail: 'peer forget requests are not handled by this peer',
      });
    });
  });

  describe('scaler orphans routing', () => {
    function orphansReply(mock: any, sessionKey: Buffer, countBefore: number): any {
      for (const msg of mock.sentMessages.slice(countBefore)) {
        try {
          const parsed = JSON.parse(decryptMessage(msg, sessionKey));
          if (parsed.type === 'peer.scaler.orphans.response') return parsed;
        } catch {
          // ignore
        }
      }
      return null;
    }

    it('answers an incoming request through onScalerOrphansRequest', async () => {
      const onScalerOrphansRequest = vi.fn().mockResolvedValue({
        ok: true,
        firecrackerScalers: ['fc'],
        vms: [],
      });
      const { client } = createPeerClient({ onScalerOrphansRequest });
      const { mock, sessionKey } = await authenticateClient(client);
      const countBefore = mock.sentMessages.length;

      mock.emit(
        'message',
        encryptMessage(
          JSON.stringify({
            type: 'peer.scaler.orphans.request',
            messageId: 'or-client-1',
            action: ScalerOrphansAction.enum.list,
          }),
          sessionKey,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(onScalerOrphansRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'or-client-1',
          action: ScalerOrphansAction.enum.list,
        }),
      );
      expect(orphansReply(mock, sessionKey, countBefore)).toMatchObject({
        messageId: 'or-client-1',
        ok: true,
        firecrackerScalers: ['fc'],
      });
    });

    it('answers ok=false when no handler is wired', async () => {
      const { client } = createPeerClient();
      const { mock, sessionKey } = await authenticateClient(client);
      const countBefore = mock.sentMessages.length;

      mock.emit(
        'message',
        encryptMessage(
          JSON.stringify({
            type: 'peer.scaler.orphans.request',
            messageId: 'or-client-2',
            action: ScalerOrphansAction.enum.list,
          }),
          sessionKey,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(orphansReply(mock, sessionKey, countBefore)).toMatchObject({
        ok: false,
        error: 'scaler orphan requests are not handled by this peer',
      });
    });

    it('sendScalerOrphansAndWait resolves with the matching response', async () => {
      const { client } = createPeerClient();
      const { mock, sessionKey } = await authenticateClient(client);

      const promise = client.sendScalerOrphansAndWait(
        {
          type: 'peer.scaler.orphans.request',
          messageId: 'or-out-1',
          action: ScalerOrphansAction.enum.stop,
          vmIds: ['vm-1'],
        },
        5_000,
      );
      mock.emit(
        'message',
        encryptMessage(
          JSON.stringify({
            type: 'peer.scaler.orphans.response',
            messageId: 'or-out-1',
            ok: true,
            results: [
              { vmId: 'vm-1', outcome: ScalerVmStopOutcome.enum.stopped, detail: 'stopped' },
            ],
          }),
          sessionKey,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(await promise).toMatchObject({ ok: true, results: [{ vmId: 'vm-1' }] });
    });

    it('sendScalerOrphansAndWait returns null when not connected', async () => {
      const { client } = createPeerClient();
      expect(
        await client.sendScalerOrphansAndWait(
          {
            type: 'peer.scaler.orphans.request',
            messageId: 'or-disc',
            action: ScalerOrphansAction.enum.list,
          },
          500,
        ),
      ).toBeNull();
    });

    it('sendScalerOrphansAndWait resolves timeout when no response arrives', async () => {
      const { client } = createPeerClient();
      await authenticateClient(client);

      const promise = client.sendScalerOrphansAndWait(
        {
          type: 'peer.scaler.orphans.request',
          messageId: 'or-timeout',
          action: ScalerOrphansAction.enum.list,
        },
        500,
      );
      await vi.advanceTimersByTimeAsync(600);

      expect(await promise).toBe('timeout');
    });

    it('a disconnect ends a pending wait with ok=false', async () => {
      const { client } = createPeerClient();
      await authenticateClient(client);

      const promise = client.sendScalerOrphansAndWait(
        {
          type: 'peer.scaler.orphans.request',
          messageId: 'or-dropped',
          action: ScalerOrphansAction.enum.list,
        },
        5_000,
      );
      client.disconnect();

      expect(await promise).toMatchObject({ messageId: 'or-dropped', ok: false });
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
  // Invariant: every WS endpoint MUST cap `maxPayload`. PeerClient connects
  // orchestrator-to-orchestrator, so a rogue or compromised peer could
  // otherwise OOM the initiating orchestrator with a compression bomb.
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

  describe('mutual-v2 client', () => {
    /** A schema-valid job.reroute, so a negative assertion cannot pass on a dropped fixture. */
    function makeJobReroute(): JobReroute {
      return jobRerouteSchema.parse({
        type: 'job.reroute',
        messageId: `msg-${randomBytes(4).toString('hex')}`,
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
      });
    }

    /** Accept with a caller-chosen serverProof built from the server's view of the handshake. */
    async function acceptWith(
      client: PeerClient,
      makeProof: (hs: ServerHandshake, authRequest: Record<string, any>) => Buffer,
      extra: Record<string, unknown> = {},
    ): Promise<MockWsInstance> {
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);
      const hs = simulateServerHandshake(mock);
      await vi.advanceTimersByTimeAsync(0);
      const authRequest = readAuthRequest(mock, hs.sessionKey);
      mock.emit(
        'message',
        encryptMessage(
          JSON.stringify({
            type: 'peer.auth.response',
            accepted: true,
            instanceId: 'remote-orch',
            role: 'coordinator',
            serverProof: makeProof(hs, authRequest).toString('hex'),
            sessionCredential: 'issued',
            agents: [],
            capabilities: { s3LogAccess: false },
            ...extra,
          }),
          hs.sessionKey,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      return mock;
    }

    it('refuses a server that accepts without a serverProof and routes nothing (adversarial server)', async () => {
      const onJobReroute = vi.fn().mockResolvedValue(undefined);
      const onAuthenticated = vi.fn();
      const onConnected = vi.fn();
      const { client, registry } = createPeerClient({ onJobReroute, onAuthenticated, onConnected });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);
      const hs = simulateServerHandshake(mock);
      await vi.advanceTimersByTimeAsync(0);
      const authRequest = readAuthRequest(mock, hs.sessionKey);
      const psk = await pskFor(authRequest);
      const clientProof = Buffer.from(String(authRequest.clientProof), 'hex');
      // The key a client that skipped the check would switch to.
      const wouldBeAppKey = refAppKey({
        handshakeKey: hs.sessionKey,
        psk,
        th: hs.transcriptHash,
        clientProof,
        serverProof: randomBytes(32),
      });
      // Pipelined in one tick: an unproven acceptance, then job.reroute under K_hs and K_app.
      mock.emit(
        'message',
        encryptMessage(
          JSON.stringify({
            type: 'peer.auth.response',
            accepted: true,
            instanceId: 'remote-orch',
            role: 'coordinator',
            sessionCredential: 'issued',
            agents: [],
            capabilities: { s3LogAccess: false },
          }),
          hs.sessionKey,
        ),
      );
      mock.emit('message', encryptMessage(JSON.stringify(makeJobReroute()), hs.sessionKey));
      mock.emit('message', encryptMessage(JSON.stringify(makeJobReroute()), wouldBeAppKey));
      await vi.advanceTimersByTimeAsync(0);
      // fails-when: the client accepts without checking serverProof
      expect(client.state).not.toBe('connected');
      expect(registry.getPeer('remote-orch')).toBeUndefined();
      expect(onAuthenticated).not.toHaveBeenCalled();
      expect(onConnected).not.toHaveBeenCalled();
      expect(onJobReroute).not.toHaveBeenCalled();
      expect(mock.closeCode).toBe(WS_CLOSE_UNAUTHORIZED);
      expect(mockWriteCredentialFile).not.toHaveBeenCalled();
    });

    it('accepts a correct serverProof and routes job.reroute under K_app', async () => {
      // breaks-if-wrong: the same flow with a proof computed by test code reaches connected
      const onJobReroute = vi.fn().mockResolvedValue(undefined);
      const { client, registry } = createPeerClient({ onJobReroute });
      const { mock, sessionKey, handshakeKey } = await authenticateClient(client);
      expect(client.state).toBe('connected');
      expect(registry.getPeer('remote-orch')!.authScheme.outbound).toBe('mutual-v2');
      // A frame under K_hs after acceptance is not routed.
      mock.emit('message', encryptMessage(JSON.stringify(makeJobReroute()), handshakeKey));
      await vi.advanceTimersByTimeAsync(0);
      expect(onJobReroute).not.toHaveBeenCalled();
      mock.emit('message', encryptMessage(JSON.stringify(makeJobReroute()), sessionKey));
      await vi.advanceTimersByTimeAsync(0);
      expect(onJobReroute).toHaveBeenCalledTimes(1);
    });

    it('resets the outbound scheme when the connection closes', async () => {
      const { client, registry } = createPeerClient();
      const { mock } = await authenticateClient(client);
      mock.readyState = 3;
      mock.emit('close', 1006, Buffer.from('abnormal'));
      expect(registry.getPeer('remote-orch')!.authScheme.outbound).toBeNull();
    });

    it.each([
      [
        'a reflected clientProof',
        (_hs: ServerHandshake, req: Record<string, any>) =>
          Buffer.from(String(req.clientProof), 'hex'),
      ],
      ['a random proof', () => randomBytes(32)],
      [
        'a proof under the wrong key',
        (hs: ServerHandshake, req: Record<string, any>) =>
          refServerProof({
            psk: randomBytes(32),
            th: hs.transcriptHash,
            clientProof: Buffer.from(String(req.clientProof), 'hex'),
            serverInstanceId: 'remote-orch',
            grantedRole: 'coordinator',
            sessionCredential: 'issued',
          }),
      ],
      [
        'a proof over another transcript',
        (_hs: ServerHandshake, req: Record<string, any>) =>
          refServerProof({
            psk: tokenPsk(TEST_TOKEN.tokenHash),
            th: randomBytes(32),
            clientProof: Buffer.from(String(req.clientProof), 'hex'),
            serverInstanceId: 'remote-orch',
            grantedRole: 'coordinator',
            sessionCredential: 'issued',
          }),
      ],
      [
        'a proof that does not cover the issued credential',
        (hs: ServerHandshake, req: Record<string, any>) =>
          refServerProof({
            psk: tokenPsk(TEST_TOKEN.tokenHash),
            th: hs.transcriptHash,
            clientProof: Buffer.from(String(req.clientProof), 'hex'),
            serverInstanceId: 'remote-orch',
            grantedRole: 'coordinator',
            sessionCredential: 'another-credential',
          }),
      ],
    ])('refuses %s', async (_label, makeProof) => {
      const { client, registry } = createPeerClient();
      const mock = await acceptWith(client, makeProof);
      expect(client.state).not.toBe('connected');
      expect(registry.getPeer('remote-orch')).toBeUndefined();
      expect(mock.closeCode).toBe(WS_CLOSE_UNAUTHORIZED);
      expect(mockWriteCredentialFile).not.toHaveBeenCalled();
    });

    it('refuses an acceptance without instanceId', async () => {
      const { client } = createPeerClient();
      const mock = await acceptWith(client, () => randomBytes(32), { instanceId: undefined });
      expect(client.state).not.toBe('connected');
      expect(mock.closeCode).toBe(WS_CLOSE_UNAUTHORIZED);
    });

    it('refuses a discovered target that answers with another instance id, and does not redial it', async () => {
      const onMutualAuthFailed = vi.fn();
      const { client, registry } = createPeerClient({
        origin: PeerDialOrigin.Discovered,
        expectedInstanceId: 'announced-id',
        onMutualAuthFailed,
      });
      await authenticateClient(client, { remoteInstanceId: 'someone-else' });
      // fails-when: expectedInstanceId is not enforced
      expect(client.state).not.toBe('connected');
      expect(registry.getPeer('someone-else')).toBeUndefined();
      expect(onMutualAuthFailed).toHaveBeenCalledWith(PeerMutualAuthFailure.InstanceIdMismatch);
      const sockets = mockInstances.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(mockInstances.length).toBe(sockets);
    });

    it('a discovered target that answers with the announced instance id connects', async () => {
      // breaks-if-wrong: the instance-id check must pass a genuine announced peer
      const { client } = createPeerClient({
        origin: PeerDialOrigin.Discovered,
        expectedInstanceId: 'remote-orch',
      });
      await authenticateClient(client);
      expect(client.state).toBe('connected');
    });

    it('a hello without mutual-v2 gets no auth request and a close', async () => {
      const { client } = createPeerClient();
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);
      mock.emit(
        'message',
        JSON.stringify({
          type: 'peer.hello',
          ephemeralPublicKey: generateEcdhKeyPair().publicKey.toString('base64'),
          nonce: randomBytes(32).toString('base64'),
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      // fails-when: the client proceeds without the scheme
      expect(mock.sentMessages).toHaveLength(0);
      expect(mock.closeCode).toBe(WS_CLOSE_PROTOCOL_ERROR);
    });

    it('a static client refused for the missing scheme reconnects with backoff', async () => {
      const { client } = createPeerClient();
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);
      mock.emit(
        'message',
        JSON.stringify({
          type: 'peer.hello',
          ephemeralPublicKey: generateEcdhKeyPair().publicKey.toString('base64'),
          nonce: randomBytes(32).toString('base64'),
          authSchemes: ['mutual-v1'],
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(mock.closeCode).toBe(WS_CLOSE_PROTOCOL_ERROR);
      const sockets = mockInstances.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(mockInstances.length).toBeGreaterThan(sockets);
    });

    it('a hello with a short nonce gets no auth request', async () => {
      const { client } = createPeerClient();
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);
      mock.emit(
        'message',
        JSON.stringify({
          type: 'peer.hello',
          ephemeralPublicKey: generateEcdhKeyPair().publicKey.toString('base64'),
          nonce: randomBytes(16).toString('base64'),
          authSchemes: ['mutual-v2'],
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(mock.sentMessages).toHaveLength(0);
      expect(mock.closeCode).toBe(WS_CLOSE_PROTOCOL_ERROR);
    });

    it('proceeds when the hello lists an unknown scheme beside mutual-v2', async () => {
      // Both sides hash the raw advertised list, so the proofs verify.
      const { client } = createPeerClient();
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);
      const hs = simulateServerHandshake(mock, { authSchemes: ['mutual-v3', 'mutual-v2'] });
      await vi.advanceTimersByTimeAsync(0);
      await acceptOn(mock, hs);
      expect(client.state).toBe('connected');
    });

    it('never sends the token or its secret in token mode', async () => {
      const { client } = createPeerClient();
      const { mock, handshakeKey, sessionKey } = await authenticateClient(client);
      const plaintexts = mock.sentMessages.map((m) => {
        for (const key of [handshakeKey, sessionKey]) {
          try {
            return decryptMessage(m, key);
          } catch {
            // not under this key
          }
        }
        return m;
      });
      // fails-when: the raw token is sent
      for (const text of plaintexts) {
        expect(text).not.toContain(TEST_TOKEN.secretHex);
        expect(text).not.toContain(TEST_TOKEN.tokenHash);
      }
      // sentMessages[1] is the auth request, right after the hello.response.
      expect(JSON.parse(decryptMessage(mock.sentMessages[1], handshakeKey))).toMatchObject({
        mode: 'token',
        tokenRouting: TEST_TOKEN.routingB64,
      });
    });

    it('a token join writes the issued credential through joinComplete', async () => {
      // breaks-if-wrong: the credential the server issued, bound into serverProof, is persisted
      const { client } = createPeerClient();
      await authenticateClient(client, { sessionCredential: 'issued-cred' });
      await vi.advanceTimersByTimeAsync(0);
      expect(mockWriteCredentialFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ credential: 'issued-cred' }),
      );
    });

    it('refuses a token-mode acceptance without a sessionCredential', async () => {
      const { client } = createPeerClient();
      const { mock } = await authenticateClient(client, { sessionCredential: null });
      expect(client.state).not.toBe('connected');
      expect(mock.closeCode).toBe(WS_CLOSE_UNAUTHORIZED);
      expect(mockWriteCredentialFile).not.toHaveBeenCalled();
    });

    it('refuses a token that is not a valid join token before sending anything secret', async () => {
      const { client } = createPeerClient({ joinToken: 'kici_join_v1.not-a.token' });
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);
      simulateServerHandshake(mock);
      await vi.advanceTimersByTimeAsync(0);
      expect(mock.sentMessages).toHaveLength(1); // the hello.response only
      expect(mock.closeCode).toBe(WS_CLOSE_PROTOCOL_ERROR);
    });

    it('closes on an undecryptable frame while authenticating', async () => {
      const { client } = createPeerClient();
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);
      simulateServerHandshake(mock);
      await vi.advanceTimersByTimeAsync(0);
      mock.emit('message', 'not-a-ciphertext');
      await vi.advanceTimersByTimeAsync(0);
      expect(mock.closeCode).toBe(WS_CLOSE_PROTOCOL_ERROR);
    });

    it('closes on an unexpected frame type while authenticating', async () => {
      const { client } = createPeerClient();
      client.connect();
      const mock = getLatestMock();
      simulateOpen(mock);
      const hs = simulateServerHandshake(mock);
      await vi.advanceTimersByTimeAsync(0);
      mock.emit('message', encryptMessage(JSON.stringify(makeJobReroute()), hs.sessionKey));
      await vi.advanceTimersByTimeAsync(0);
      expect(mock.closeCode).toBe(WS_CLOSE_PROTOCOL_ERROR);
      expect(client.state).not.toBe('connected');
    });

    it('closes a server silent after open at handshakeTimeoutMs and schedules a reconnect', async () => {
      const { client } = createPeerClient({ handshakeTimeoutMs: 15_000 });
      client.connect();
      simulateOpen(getLatestMock());
      await vi.advanceTimersByTimeAsync(14_999);
      expect(getLatestMock().readyState).toBe(1);
      // fails-when: no handshake timer
      await vi.advanceTimersByTimeAsync(1);
      expect((mockInstances[0] as unknown as MockWsInstance).readyState).toBe(3);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(mockInstances.length).toBeGreaterThanOrEqual(2);
    });

    it('a server that completes inside the timeout is not closed', async () => {
      // breaks-if-wrong: the timer must not close a connected client
      const { client } = createPeerClient({ handshakeTimeoutMs: 15_000 });
      await authenticateClient(client);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(client.state).toBe('connected');
      expect(getLatestMock().readyState).toBe(1);
    });

    it('a timer armed for an earlier socket never closes a later one', async () => {
      const { client } = createPeerClient({
        handshakeTimeoutMs: 15_000,
        maxReconnectDelayMs: 1_000,
      });
      client.connect();
      const first = getLatestMock();
      simulateOpen(first);
      await vi.advanceTimersByTimeAsync(5_000);
      first.close(1006, 'server went away');
      await vi.advanceTimersByTimeAsync(1_000);
      const second = getLatestMock();
      expect(second).not.toBe(first);
      simulateOpen(second);
      const hs = simulateServerHandshake(second);
      await vi.advanceTimersByTimeAsync(0);
      await acceptOn(second, hs);
      expect(client.state).toBe('connected');
      await vi.advanceTimersByTimeAsync(10_000); // past the first socket's deadline
      expect(second.readyState).toBe(1);
      expect(client.state).toBe('connected');
    });
  });

  describe('a replaced client', () => {
    it('a disconnected client whose socket closes late does not mark its successor disconnected', async () => {
      // fails-when: the late close event of the old socket runs markDisconnected
      const registry = new PeerRegistry();
      const { client: first } = createPeerClient({ peerRegistry: registry });
      const { mock: firstSocket } = await authenticateClient(first);
      const { client: second } = createPeerClient({ peerRegistry: registry });
      first.disconnect();
      await authenticateClient(second);
      // The first socket's close event arrives only now, after the successor registered.
      firstSocket.emit('close', 1000, Buffer.from('Client disconnect'));
      await vi.advanceTimersByTimeAsync(0);
      expect(second.state).toBe('connected');
      expect(registry.getPeer('remote-orch')!.connected).toBe(true);
      expect(registry.getPeer('remote-orch')!.authScheme.outbound).toBe('mutual-v2');
    });

    it('a close of the current socket still marks the peer disconnected and reconnects', async () => {
      // breaks-if-wrong: the guard must not swallow a real close
      const { client, registry } = createPeerClient();
      const { mock } = await authenticateClient(client);
      mock.readyState = 3;
      mock.emit('close', 1006, Buffer.from('abnormal'));
      expect(registry.getPeer('remote-orch')!.connected).toBe(false);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(mockInstances.length).toBeGreaterThan(1);
    });
  });
});
