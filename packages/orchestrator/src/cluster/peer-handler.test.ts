import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { PeerHeartbeat, PeerLogChunk } from '@kici-dev/engine';
import {
  LogStream,
  PeerForgetOutcome,
  ScalerOrphansAction,
  ScalerReloadOutcome,
  ScalerVmStopOutcome,
} from '@kici-dev/engine';
import { createLogChunkSink } from '../reporting/log-chunk-sink.js';
import { normalizePeerLogChunk } from '../reporting/peer-log-normalize.js';
import type { LogWriter } from '../reporting/log-writer.js';
import type { StepLogBuffer } from '../reporting/step-log-buffer.js';
import {
  generateEcdhKeyPair,
  deriveSessionKey,
  encryptMessage,
  decryptMessage,
} from './peer-crypto.js';
import {
  PEER_MUTUAL_AUTH_REQUIRED_REASON,
  PROTOCOL_VERSION,
  MIN_PROTOCOL_VERSION,
  WS_CLOSE_INVALID_MESSAGE,
  WS_CLOSE_PROTOCOL_ERROR,
  WS_CLOSE_UNAUTHORIZED,
  ScalerEventType,
  jobRerouteSchema,
  type JobReroute,
} from '@kici-dev/engine';
import {
  createPeerHandler,
  shouldAdmitWorker,
  type PeerHandlerDeps,
  type PeerWsLike,
} from './peer-handler.js';
import { PeerRegistry } from './peer-registry.js';
import { TOKEN_ALREADY_USED_MESSAGE } from './join-token.js';
import {
  credentialPsk,
  makeTestJoinToken,
  refAppKey,
  refClientProof,
  refServerProof,
  refTranscriptHash,
  tokenPsk,
} from '../__test-helpers__/peer-mutual-auth.js';

// ── Capture the peer-handler logger (wraps the real one) ────────────

const loggerHolder = vi.hoisted(() => ({
  peerHandler: undefined as
    undefined | { info: (...a: unknown[]) => unknown; warn: (...a: unknown[]) => unknown },
}));

vi.mock('@kici-dev/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kici-dev/shared')>();
  return {
    ...actual,
    createLogger: (opts?: { prefix?: string }) => {
      const real = actual.createLogger(opts);
      if (opts?.prefix === 'peer-handler') loggerHolder.peerHandler = real as never;
      return real;
    },
  };
});

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

const TOKEN_ROUTING = { orgId: 'org-1', routingKey: 'github:42', expiry: Date.now() + 3_600_000 };

/** The join token the default token manager double holds a row for. */
const DEFAULT_TOKEN = makeTestJoinToken({ ...TOKEN_ROUTING, role: 'coordinator' });

type TokenRow = { tokenHash: string; role: 'coordinator' | 'worker' };

/**
 * Role and routing come from the token row, so the double answers with the
 * row's values. `resolveLiveTokenByRouting` offers every row to the caller's
 * proof check, as the real lookup does for rows sharing one routing triple.
 */
function createMockTokenManager(
  overrides: { role?: 'coordinator' | 'worker'; rows?: TokenRow[] } = {},
) {
  const rows: TokenRow[] = overrides.rows ?? [
    { tokenHash: DEFAULT_TOKEN.tokenHash, role: overrides.role ?? 'coordinator' },
  ];
  const claimed = (row: TokenRow) => ({
    tokenHash: row.tokenHash,
    role: row.role,
    routing: { ...TOKEN_ROUTING, role: row.role },
  });
  return {
    token: DEFAULT_TOKEN,
    rows,
    resolveLiveTokenByRouting: vi.fn(
      async (_claimed: unknown, accepts: (tokenHash: string) => boolean) => {
        for (const row of rows) {
          if (accepts(row.tokenHash)) return { status: 'live' as const, tokenHash: row.tokenHash };
        }
        return { status: 'unknown' as const };
      },
    ),
    claimByHash: vi.fn(async (tokenHash: string) => {
      const row = rows.find((r) => r.tokenHash === tokenHash);
      if (!row) throw new Error('Invalid join token');
      return claimed(row);
    }),
    readByHash: vi.fn(async (tokenHash: string) => {
      const row = rows.find((r) => r.tokenHash === tokenHash);
      return row ? { routing: claimed(row).routing, role: row.role } : null;
    }),
    createToken: vi.fn(),
  };
}

// ── Mock PeerCredentialStore ───────────────────────────────────────

function createMockCredentialStore() {
  return {
    save: vi.fn().mockResolvedValue({ revokedCount: 0 }),
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
        mandatoryLabels: [],
      },
    ],
    capabilities: { s3LogAccess: false },
    timestamp: Date.now(),
  };
}

function createTestHandler(overrides: Partial<PeerHandlerDeps> = {}) {
  const registry = new PeerRegistry();
  const tokenManager =
    (overrides.tokenManager as unknown as ReturnType<typeof createMockTokenManager>) ??
    createMockTokenManager(overrides as any);
  const credentialStore =
    (overrides.credentialStore as unknown as ReturnType<typeof createMockCredentialStore>) ??
    createMockCredentialStore();
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

interface ClientHandshake {
  /** K_hs: the auth request and response travel under it. */
  sessionKey: Buffer;
  serverNonce: Buffer;
  /** TH, computed by the independent helper over the hello the server sent. */
  transcriptHash: Buffer;
}

/**
 * Complete the ECDH handshake phase as a client would. After this, the server
 * is waiting for a peer.auth.request under K_hs.
 */
function completeEcdhHandshake(ws: MockPeerWs): ClientHandshake {
  expect(ws.sentMessages.length).toBeGreaterThanOrEqual(1);
  const helloMsg = JSON.parse(ws.sentMessages[0]);
  expect(helloMsg.type).toBe('peer.hello');
  expect(helloMsg.authSchemes).toEqual(['mutual-v2']);

  const serverPubKey = Buffer.from(helloMsg.ephemeralPublicKey, 'base64');
  const serverNonce = Buffer.from(helloMsg.nonce, 'base64');
  const clientEcdh = generateEcdhKeyPair();
  const sessionKey = deriveSessionKey(clientEcdh.privateKey, serverPubKey, serverNonce);

  ws.simulateMessage({
    type: 'peer.hello.response',
    ephemeralPublicKey: clientEcdh.publicKey.toString('base64'),
  });

  return {
    sessionKey,
    serverNonce,
    transcriptHash: refTranscriptHash(
      serverPubKey,
      serverNonce,
      helloMsg.authSchemes,
      clientEcdh.publicKey,
    ),
  };
}

/** A presented join token's routing segment and stored hash; a malformed one becomes an unknown token. */
function asTestToken(token: string): { routingB64: string; tokenHash: string } {
  const parts = token.split('.');
  if (parts.length === 3 && parts[0] === 'kici_join_v1' && /^[0-9a-f]{64}$/.test(parts[2])) {
    return {
      routingB64: parts[1],
      tokenHash: createHash('sha256').update(Buffer.from(parts[2], 'hex')).digest('hex'),
    };
  }
  return makeTestJoinToken({ ...TOKEN_ROUTING, role: 'coordinator' });
}

/**
 * A mutual-v2 peer.auth.request under K_hs, as a client builds it. `token`
 * proves that join token; `credential` proves that credential; `proof` sends
 * a fixed credential-mode proof as-is.
 */
const sentProofs = new WeakMap<ClientHandshake, { psk: Buffer; clientProof: Buffer }>();

function authFrame(hs: ClientHandshake, req: Record<string, any>): string {
  const { token, proof, credential, ...rest } = req;
  let mode: 'credential' | 'token';
  let psk: Buffer | null = null;
  let tokenRouting = '';
  if (credential !== undefined) {
    mode = 'credential';
    psk = credentialPsk(credential);
  } else if (proof !== undefined) {
    mode = 'credential';
  } else if (token !== undefined) {
    mode = 'token';
    const t = asTestToken(token);
    psk = tokenPsk(t.tokenHash);
    tokenRouting = t.routingB64;
  } else {
    throw new Error('authFrame needs a token, a credential or a proof');
  }
  const clientProof =
    psk === null
      ? String(proof)
      : refClientProof({
          psk,
          th: hs.transcriptHash,
          mode,
          instanceId: req.instanceId,
          role: req.role ?? '',
          protocolVersion: req.protocolVersion,
          tokenRouting,
        }).toString('hex');
  if (psk) sentProofs.set(hs, { psk, clientProof: Buffer.from(clientProof, 'hex') });
  return encryptMessage(
    JSON.stringify({
      ...rest,
      scheme: 'mutual-v2',
      mode,
      clientProof,
      ...(mode === 'token' && { tokenRouting }),
    }),
    hs.sessionKey,
  );
}

/** K_app after the server accepted the request `authFrame` built on this handshake. */
function appKeyOf(ws: MockPeerWs, hs: ClientHandshake): Buffer {
  const sent = sentProofs.get(hs)!;
  const response = authResponseOf(ws, hs.sessionKey);
  expect(response?.accepted).toBe(true);
  return refAppKey({
    handshakeKey: hs.sessionKey,
    psk: sent.psk,
    th: hs.transcriptHash,
    clientProof: sent.clientProof,
    serverProof: Buffer.from(response.serverProof, 'hex'),
  });
}

/** The decrypted peer.auth.response the server sent under K_hs, or null. */
function authResponseOf(ws: MockPeerWs, handshakeKey: Buffer): any {
  for (const msg of ws.sentMessages.slice(1)) {
    try {
      const parsed = JSON.parse(decryptMessage(msg, handshakeKey));
      if (parsed.type === 'peer.auth.response') return parsed;
    } catch {
      // not under this key
    }
  }
  return null;
}

/**
 * Drive a full mutual-v2 authentication: `credential` mode proves the PSK
 * given, `token` mode proves a join token's hash with its routing segment.
 * On acceptance it checks the server proof with the independent helper and
 * returns K_app as `sessionKey`.
 */
async function authenticateV2(
  handler: ReturnType<typeof createPeerHandler>,
  ws: MockPeerWs,
  opts: {
    mode: 'credential' | 'token';
    psk: Buffer;
    peerInstanceId?: string;
    role?: 'coordinator' | 'worker';
    tokenRouting?: string;
    ip?: string;
  },
): Promise<{ sessionKey: Buffer; handshakeKey: Buffer; response: Record<string, any> }> {
  handler.handleConnection(ws, opts.ip);
  const hs = completeEcdhHandshake(ws);
  const peerInstanceId = opts.peerInstanceId ?? 'remote-peer';
  const role = opts.role ?? 'coordinator';
  const clientProof = refClientProof({
    psk: opts.psk,
    th: hs.transcriptHash,
    mode: opts.mode,
    instanceId: peerInstanceId,
    role,
    protocolVersion: PROTOCOL_VERSION,
    tokenRouting: opts.tokenRouting ?? '',
  });
  ws.simulateRawMessage(
    encryptMessage(
      JSON.stringify({
        type: 'peer.auth.request',
        instanceId: peerInstanceId,
        protocolVersion: PROTOCOL_VERSION,
        role,
        scheme: 'mutual-v2',
        mode: opts.mode,
        clientProof: clientProof.toString('hex'),
        ...(opts.tokenRouting && { tokenRouting: opts.tokenRouting }),
      }),
      hs.sessionKey,
    ),
  );
  await vi.advanceTimersByTimeAsync(0);
  const response = authResponseOf(ws, hs.sessionKey);
  if (!response?.accepted) {
    return { sessionKey: hs.sessionKey, handshakeKey: hs.sessionKey, response };
  }
  const serverProof = Buffer.from(response.serverProof, 'hex');
  // The server's proof, checked by an independent computation
  expect(
    serverProof.equals(
      refServerProof({
        psk: opts.psk,
        th: hs.transcriptHash,
        clientProof,
        serverInstanceId: 'handler-orch',
        grantedRole: response.role,
        sessionCredential: response.sessionCredential ?? null,
      }),
    ),
  ).toBe(true);
  return {
    sessionKey: refAppKey({
      handshakeKey: hs.sessionKey,
      psk: opts.psk,
      th: hs.transcriptHash,
      clientProof,
      serverProof,
    }),
    handshakeKey: hs.sessionKey,
    response,
  };
}

/** Token-mode options for a test join token. */
const tokenOpts = (t: { tokenHash: string; routingB64: string }) => ({
  mode: 'token' as const,
  psk: tokenPsk(t.tokenHash),
  tokenRouting: t.routingB64,
});

/**
 * Complete full authentication with the default join token. Returns K_app as
 * `sessionKey`, and K_hs as `handshakeKey`.
 */
async function authenticateWithToken(
  handler: ReturnType<typeof createPeerHandler>,
  ws: MockPeerWs,
  peerInstanceId = 'remote-peer',
): Promise<{ sessionKey: Buffer; handshakeKey: Buffer; response: Record<string, any> }> {
  return authenticateV2(handler, ws, { ...tokenOpts(DEFAULT_TOKEN), peerInstanceId });
}

/**
 * Connect a peer that authenticates with a worker join token while declaring
 * `declaredRole` (omitted: no role). Returns the handler, its registry, the
 * socket and K_app.
 */
async function connectWithWorkerToken(
  overrides: Partial<PeerHandlerDeps>,
  declaredRole?: 'worker' | 'coordinator',
) {
  const { handler, registry } = createTestHandler({
    ...overrides,
    tokenManager: createMockTokenManager({ role: 'worker' }) as any,
    acceptedRoles: ['coordinator', 'worker'],
  });
  const ws = new MockPeerWs();
  handler.handleConnection(ws);
  const hs = completeEcdhHandshake(ws);
  ws.simulateRawMessage(
    authFrame(hs, {
      type: 'peer.auth.request',
      instanceId: 'remote-peer',
      protocolVersion: PROTOCOL_VERSION,
      token: DEFAULT_TOKEN.token,
      ...(declaredRole ? { role: declaredRole } : {}),
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  return { handler, registry, ws, sessionKey: appKeyOf(ws, hs) };
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
      const hs = completeEcdhHandshake(ws);
      const { sessionKey } = hs;

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

      const { handshakeKey: sessionKey } = await authenticateWithToken(handler, ws);

      // The atomic claim should have fired with the token's hash, this
      // coordinator's instance ID as the consumedBy attribution, and the
      // joining peer's instanceId recorded as consumed_by_instance.
      expect(tokenManager.claimByHash).toHaveBeenCalledWith(
        DEFAULT_TOKEN.tokenHash,
        'handler-orch',
        'remote-peer',
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

    it('accepts a returning peer re-presenting its own consumed token with no prior credential', async () => {
      // Self-heal lockout recovery: a peer lost its credential (transient
      // outage / deleted credential file) and re-presents its still-valid
      // join token. The token manager now accepts the same-instance reuse
      // (returns routing instead of throwing), so the primary path issues a
      // fresh credential — no recovery branch, no redeploy. findByInstanceId
      // returns null (the credential is gone), proving the issuance comes
      // from the primary token path, not the credential-match recovery branch.
      const { handler, tokenManager, credentialStore } = createTestHandler();
      credentialStore.findByInstanceId.mockResolvedValue(null);
      const ws = new MockPeerWs();

      const { handshakeKey: sessionKey } = await authenticateWithToken(handler, ws);

      // The manager was asked to claim with the joining peer's instanceId.
      expect(tokenManager.claimByHash).toHaveBeenCalledWith(
        DEFAULT_TOKEN.tokenHash,
        'handler-orch',
        'remote-peer',
      );
      // A fresh credential was issued via the primary path.
      expect(credentialStore.save).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 'remote-peer', role: 'coordinator' }),
      );
      // The recovery branch's credential lookup never fired on the happy path.
      expect(credentialStore.findByInstanceId).not.toHaveBeenCalled();

      let authResponse: any = null;
      for (const msg of ws.sentMessages.slice(1)) {
        try {
          const parsed = JSON.parse(decryptMessage(msg, sessionKey));
          if (parsed.type === 'peer.auth.response') {
            authResponse = parsed;
            break;
          }
        } catch {
          /* not this message */
        }
      }
      expect(authResponse).not.toBeNull();
      expect(authResponse.accepted).toBe(true);
      expect(authResponse.sessionCredential).toBeDefined();
      expect(authResponse.sessionCredential.length).toBe(64);
    });

    it('rejects invalid join token', async () => {
      const tokenManager = createMockTokenManager();
      tokenManager.claimByHash.mockRejectedValue(new Error('Invalid join token'));
      const { handler } = createTestHandler({ tokenManager: tokenManager as any });
      const ws = new MockPeerWs();

      handler.handleConnection(ws);
      const hs = completeEcdhHandshake(ws);
      const { sessionKey } = hs;

      const authRequest = {
        type: 'peer.auth.request',
        instanceId: 'remote-peer',
        protocolVersion: PROTOCOL_VERSION,
        token: 'bad-token',
      };
      ws.simulateRawMessage(authFrame(hs, authRequest));

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
      const hs = completeEcdhHandshake(ws);
      const { sessionKey } = hs;

      const authRequest = {
        type: 'peer.auth.request',
        instanceId: 'remote-peer',
        protocolVersion: PROTOCOL_VERSION,
        token: DEFAULT_TOKEN.token,
      };
      ws.simulateRawMessage(authFrame(hs, authRequest));

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

  describe('token role comes from the token row', () => {
    // fails-when: the first-claim branch reads the role from the presented token.
    it('refuses a coordinator-only join when the row is a worker token, whatever the token says', async () => {
      const presented = makeTestJoinToken({ ...TOKEN_ROUTING, role: 'coordinator' });
      const tokenManager = createMockTokenManager({
        rows: [{ tokenHash: presented.tokenHash, role: 'worker' }],
      });
      const { handler, credentialStore } = createTestHandler({
        tokenManager: tokenManager as any,
        acceptedRoles: ['coordinator'],
      });
      const ws = new MockPeerWs();
      handler.handleConnection(ws);
      const hs = completeEcdhHandshake(ws);
      const { sessionKey } = hs;
      const token = presented.token;
      ws.simulateRawMessage(
        authFrame(hs, {
          type: 'peer.auth.request',
          instanceId: 'remote-peer',
          protocolVersion: PROTOCOL_VERSION,
          token,
        }),
      );
      await vi.advanceTimersByTimeAsync(0);

      let authResponse: any = null;
      for (const msg of ws.sentMessages.slice(1)) {
        try {
          const parsed = JSON.parse(decryptMessage(msg, sessionKey));
          if (parsed.type === 'peer.auth.response') authResponse = parsed;
        } catch {
          /* not this message */
        }
      }
      expect(authResponse?.accepted).toBe(false);
      expect(authResponse?.reason).toBe('Role mismatch');
      expect(credentialStore.save).not.toHaveBeenCalled();
    });

    it('saves the token hash and routing key the claim returns', async () => {
      const { handler, credentialStore } = createTestHandler();
      await authenticateWithToken(handler, new MockPeerWs());
      expect(credentialStore.save).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceTokenHash: DEFAULT_TOKEN.tokenHash,
          routingKeys: ['github:42'],
        }),
      );
    });
  });

  describe('idempotent token retry (multi-coord mesh race)', () => {
    // Helper: build a real-format token + matching validation hash so the
    // recovery path's parseToken()/tokenHashOf() call chain works end-to-end.
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

    const ALREADY_USED = TOKEN_ALREADY_USED_MESSAGE;

    async function presentAlreadyUsedToken(
      token: string,
      credentialStoreOverride?: ReturnType<typeof createMockCredentialStore>,
      acceptedRoles: Array<'coordinator' | 'worker'> = ['coordinator'],
      readByHashResult?: {
        routing: Record<string, unknown>;
        role: 'coordinator' | 'worker';
      } | null,
    ) {
      const tokenManager = createMockTokenManager({
        rows: [
          {
            tokenHash: asTestToken(token).tokenHash,
            role: readByHashResult?.role ?? 'coordinator',
          },
        ],
      });
      tokenManager.claimByHash.mockRejectedValue(new Error(ALREADY_USED));
      if (readByHashResult !== undefined)
        tokenManager.readByHash.mockResolvedValue(readByHashResult as never);
      const credentialStore = credentialStoreOverride ?? createMockCredentialStore();
      const { handler } = createTestHandler({
        tokenManager: tokenManager as any,
        credentialStore: credentialStore as any,
        acceptedRoles,
      });
      const ws = new MockPeerWs();

      handler.handleConnection(ws);
      const hs = completeEcdhHandshake(ws);
      const { sessionKey } = hs;

      ws.simulateRawMessage(
        authFrame(hs, {
          type: 'peer.auth.request',
          instanceId: 'remote-peer',
          protocolVersion: PROTOCOL_VERSION,
          token,
        }),
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
      expect(tokenManager.claimByHash).toHaveBeenCalledTimes(1);

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
      } = await presentAlreadyUsedToken(token, credentialStore, ['coordinator'], {
        routing: {
          orgId: 'org-1',
          routingKey: 'github:42',
          expiry: Date.now() + 3600_000,
          role: 'worker',
        },
        role: 'worker',
      });

      expect(cs.save).not.toHaveBeenCalled();
      expect(authResponse).not.toBeNull();
      expect(authResponse.accepted).toBe(false);
      expect(authResponse.reason).toBe('Role mismatch');
      expect(ws.closeCode).toBe(4001);
    });

    function activeCredential(sourceTokenHash: string) {
      return {
        id: 'cred-1',
        instanceId: 'remote-peer',
        credentialHash: 'previously-issued-hash',
        role: 'coordinator',
        routingKeys: ['github:42'],
        sourceTokenHash,
        createdAt: new Date(),
        lastSeenAt: null,
        lastValidatedBy: null,
        expiresAt: new Date(Date.now() + 86400_000),
        revokedAt: null,
      };
    }

    // fails-when: the retry branch reads the role from the presented token, not its row.
    it('refuses the idempotent retry when the row is a worker token, whatever the token says', async () => {
      const { token, validationHash } = makeRealToken('coordinator');
      const credentialStore = createMockCredentialStore();
      credentialStore.findByInstanceId.mockResolvedValue(activeCredential(validationHash));
      const {
        authResponse,
        credentialStore: cs,
        tokenManager,
      } = await presentAlreadyUsedToken(token, credentialStore, ['coordinator'], {
        routing: {
          orgId: 'org-1',
          routingKey: 'github:42',
          expiry: Date.now() + 3600_000,
          role: 'worker',
        },
        role: 'worker',
      });
      expect(tokenManager.readByHash).toHaveBeenCalledWith(validationHash);
      expect(authResponse.accepted).toBe(false);
      expect(authResponse.reason).toBe('Role mismatch');
      expect(cs.save).not.toHaveBeenCalled();
    });

    it('saves the routing key of the token row on an idempotent retry', async () => {
      const { token, validationHash } = makeRealToken('coordinator');
      const credentialStore = createMockCredentialStore();
      credentialStore.findByInstanceId.mockResolvedValue(activeCredential(validationHash));
      const { credentialStore: cs } = await presentAlreadyUsedToken(
        token,
        credentialStore,
        ['coordinator'],
        {
          routing: {
            orgId: 'org-1',
            routingKey: 'github:row',
            expiry: Date.now() + 3600_000,
            role: 'coordinator',
          },
          role: 'coordinator',
        },
      );
      expect(cs.save).toHaveBeenCalledWith(
        expect.objectContaining({ routingKeys: ['github:row'], sourceTokenHash: validationHash }),
      );
    });

    it('refuses the idempotent retry when the token row is gone', async () => {
      const { token, validationHash } = makeRealToken('coordinator');
      const credentialStore = createMockCredentialStore();
      credentialStore.findByInstanceId.mockResolvedValue(activeCredential(validationHash));
      const { authResponse, credentialStore: cs } = await presentAlreadyUsedToken(
        token,
        credentialStore,
        ['coordinator'],
        null,
      );
      expect(authResponse.accepted).toBe(false);
      expect(authResponse.reason).toBe('Invalid token');
      expect(cs.save).not.toHaveBeenCalled();
    });

    // fails-when: `sourceTokenHash: presentedHash` stays on the log line.
    it('logs a token fingerprint, never the token hash, on an idempotent retry', async () => {
      const infoSpy = vi.spyOn(loggerHolder.peerHandler!, 'info');
      const { token, validationHash } = makeRealToken('coordinator');
      const credentialStore = createMockCredentialStore();
      credentialStore.findByInstanceId.mockResolvedValue(activeCredential(validationHash));
      const { authResponse } = await presentAlreadyUsedToken(token, credentialStore);
      expect(authResponse.accepted).toBe(true);
      const call = infoSpy.mock.calls.find(([m]) => m === 'Peer idempotent token retry accepted');
      expect(call?.[1]).toMatchObject({
        tokenFingerprint: expect.stringMatching(/^[0-9a-f]{12}$/),
      });
      const logged = JSON.stringify(infoSpy.mock.calls);
      expect(logged).not.toContain(validationHash);
      expect(logged).not.toMatch(/"[0-9a-f]{64}"/);
      infoSpy.mockRestore();
    });

    it('does not trigger recovery for non-"already used" validation errors', async () => {
      const tokenManager = createMockTokenManager();
      tokenManager.claimByHash.mockRejectedValue(new Error('Join token has expired'));
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
      const hs = completeEcdhHandshake(ws);
      const { sessionKey } = hs;

      const { token } = makeRealToken();
      ws.simulateRawMessage(
        authFrame(hs, {
          type: 'peer.auth.request',
          instanceId: 'remote-peer',
          protocolVersion: PROTOCOL_VERSION,
          token,
        }),
      );
      await vi.advanceTimersByTimeAsync(0);

      // Recovery branch MUST NOT have run — expired is not a recoverable error
      expect(credentialStore.save).not.toHaveBeenCalled();
      expect(credentialStore.findByInstanceId).not.toHaveBeenCalled();
      expect(ws.closeCode).toBe(4001);
    });
  });

  describe('credential-based authentication', () => {
    it('accepts a valid credential proof', async () => {
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
      const hs = completeEcdhHandshake(ws);
      const { sessionKey } = hs;

      // A client proof over this handshake's transcript, built like the client does
      const authRequest = {
        type: 'peer.auth.request',
        instanceId: 'remote-peer',
        protocolVersion: PROTOCOL_VERSION,
        credential: rawCredential,
      };
      ws.simulateRawMessage(authFrame(hs, authRequest));

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

    it('rejects an invalid credential proof', async () => {
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
      const hs = completeEcdhHandshake(ws);
      const { sessionKey } = hs;

      const authRequest = {
        type: 'peer.auth.request',
        instanceId: 'remote-peer',
        protocolVersion: PROTOCOL_VERSION,
        proof: 'b'.repeat(64), // wrong proof
      };
      ws.simulateRawMessage(authFrame(hs, authRequest));

      await vi.advanceTimersByTimeAsync(0);

      expect(ws.closeCode).toBe(4001);
    });

    it('rejects when credential not found', async () => {
      const credentialStore = createMockCredentialStore();
      credentialStore.findByInstanceId.mockResolvedValue(null);

      const { handler } = createTestHandler({ credentialStore: credentialStore as any });
      const ws = new MockPeerWs();

      handler.handleConnection(ws);
      const hs = completeEcdhHandshake(ws);
      const { sessionKey } = hs;

      const authRequest = {
        type: 'peer.auth.request',
        instanceId: 'unknown-peer',
        protocolVersion: PROTOCOL_VERSION,
        proof: 'a'.repeat(64),
      };
      ws.simulateRawMessage(authFrame(hs, authRequest));

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
      tokenManager.claimByHash.mockRejectedValue(new Error('Invalid'));

      const { handler } = createTestHandler({ tokenManager: tokenManager as any });

      // Fail 5 times from same IP
      for (let i = 0; i < 5; i++) {
        const ws = new MockPeerWs();
        handler.handleConnection(ws, '192.168.1.100');
        const hs = completeEcdhHandshake(ws);
        const { sessionKey } = hs;
        const authRequest = {
          type: 'peer.auth.request',
          instanceId: `peer-${i}`,
          protocolVersion: PROTOCOL_VERSION,
          token: 'bad-token',
        };
        ws.simulateRawMessage(authFrame(hs, authRequest));
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
      tokenManager.claimByHash.mockRejectedValue(new Error('Invalid'));

      const { handler } = createTestHandler({ tokenManager: tokenManager as any });

      // Fail 5 times from different IPs
      for (let i = 0; i < 5; i++) {
        const ws = new MockPeerWs();
        handler.handleConnection(ws, `192.168.1.${i}`);
        const hs = completeEcdhHandshake(ws);
        const { sessionKey } = hs;
        const authRequest = {
          type: 'peer.auth.request',
          instanceId: `peer-${i}`,
          protocolVersion: PROTOCOL_VERSION,
          token: 'bad-token',
        };
        ws.simulateRawMessage(authFrame(hs, authRequest));
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
      tokenManager.claimByHash.mockRejectedValue(new Error('Invalid'));

      const { handler } = createTestHandler({ tokenManager: tokenManager as any });
      const sameInstanceId = 'attacker-instance';

      // Fail 5 times from different IPs but same instance ID
      for (let i = 0; i < 5; i++) {
        const ws = new MockPeerWs();
        handler.handleConnection(ws, `10.0.${i}.1`);
        const hs = completeEcdhHandshake(ws);
        const { sessionKey } = hs;
        const authRequest = {
          type: 'peer.auth.request',
          instanceId: sameInstanceId,
          protocolVersion: PROTOCOL_VERSION,
          token: 'bad-token',
        };
        ws.simulateRawMessage(authFrame(hs, authRequest));
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
      tokenManager.claimByHash.mockRejectedValue(new Error('Invalid'));

      const { handler } = createTestHandler({ tokenManager: tokenManager as any });

      // 5 failures from same IP and same instance ID
      for (let i = 0; i < 5; i++) {
        const ws = new MockPeerWs();
        handler.handleConnection(ws, '192.168.1.100');
        const hs = completeEcdhHandshake(ws);
        const { sessionKey } = hs;
        const authRequest = {
          type: 'peer.auth.request',
          instanceId: 'bad-peer',
          protocolVersion: PROTOCOL_VERSION,
          token: 'bad-token',
        };
        ws.simulateRawMessage(authFrame(hs, authRequest));
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
      tokenManager.claimByHash.mockRejectedValue(new Error('Invalid'));

      const { handler } = createTestHandler({ tokenManager: tokenManager as any });

      // Fail 5 times
      for (let i = 0; i < 5; i++) {
        const ws = new MockPeerWs();
        handler.handleConnection(ws, '192.168.1.100');
        const hs = completeEcdhHandshake(ws);
        const { sessionKey } = hs;
        const authRequest = {
          type: 'peer.auth.request',
          instanceId: `peer-${i}`,
          protocolVersion: PROTOCOL_VERSION,
          token: 'bad-token',
        };
        ws.simulateRawMessage(authFrame(hs, authRequest));
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
            mandatoryLabels: [],
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
        spawnRetry: { maxAttempts: 3, backoffMs: 0 },
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
        // The authenticated source-peer instanceId is threaded to the callback so
        // the coordinator can verify signal provenance against the tracked reroute.
        'remote-peer',
      );
    });

    it('routes encrypted job.progress to callback with the authenticated source peer id', async () => {
      const onJobProgress = vi.fn();
      const { handler } = createTestHandler({ onJobProgress });
      const ws = new MockPeerWs();

      const { sessionKey } = await authenticateWithToken(handler, ws);

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
      ws.simulateRawMessage(encryptMessage(JSON.stringify(jobProgress), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      expect(onJobProgress).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'job.progress', runId: 'run-1', jobId: 'job-1' }),
        'remote-peer', // the authenticated source id the handler must thread
        expect.any(Function),
      );
    });

    it('serves a peer.clusterSettings.request with the resolved snapshot + version', async () => {
      const onPeerClusterSettingsRequest = vi.fn().mockResolvedValue({
        version: 9,
        settings: { agentTokenTtlMs: 45_000, concurrencyWaitTimeoutMs: 900_000 },
      });
      const { handler } = createTestHandler({ onPeerClusterSettingsRequest });
      const ws = new MockPeerWs();

      const { sessionKey } = await authenticateWithToken(handler, ws);
      const before = ws.sentMessages.length;

      ws.simulateRawMessage(
        encryptMessage(
          JSON.stringify({ type: 'peer.clusterSettings.request', messageId: 'req-1' }),
          sessionKey,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(onPeerClusterSettingsRequest).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'peer.clusterSettings.request', messageId: 'req-1' }),
      );
      const reply = JSON.parse(decryptMessage(ws.sentMessages[before], sessionKey));
      expect(reply).toEqual({
        type: 'peer.clusterSettings.response',
        messageId: 'req-1',
        version: 9,
        settings: { agentTokenTtlMs: 45_000, concurrencyWaitTimeoutMs: 900_000 },
      });
    });

    it('does not reply to a peer.clusterSettings.request when no handler is configured', async () => {
      const { handler } = createTestHandler(); // no onPeerClusterSettingsRequest
      const ws = new MockPeerWs();

      const { sessionKey } = await authenticateWithToken(handler, ws);
      const before = ws.sentMessages.length;

      ws.simulateRawMessage(
        encryptMessage(
          JSON.stringify({ type: 'peer.clusterSettings.request', messageId: 'req-2' }),
          sessionKey,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);

      // No response frame — the worker keeps its boot-time config default.
      expect(ws.sentMessages.length).toBe(before);
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
      const hs = completeEcdhHandshake(ws);
      const { sessionKey } = hs;

      // Send auth request with role: 'worker'
      const authRequest = {
        type: 'peer.auth.request',
        instanceId: 'worker-peer',
        protocolVersion: PROTOCOL_VERSION,
        token: DEFAULT_TOKEN.token,
        role: 'worker',
      };
      ws.simulateRawMessage(authFrame(hs, authRequest));
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
    const findAuthResponse = (ws: MockPeerWs, sessionKey: Buffer): any => {
      for (const msg of ws.sentMessages.slice(1)) {
        try {
          const parsed = JSON.parse(decryptMessage(msg, sessionKey));
          if (parsed.type === 'peer.auth.response') return parsed;
        } catch {
          // not an encrypted frame
        }
      }
      return null;
    };

    const sendPeerAuth = async (protocolVersion: number) => {
      const { handler, registry } = createTestHandler();
      const ws = new MockPeerWs();
      handler.handleConnection(ws);
      const hs = completeEcdhHandshake(ws);
      const { sessionKey } = hs;
      const authRequest = {
        type: 'peer.auth.request',
        instanceId: 'remote-peer',
        protocolVersion,
        token: DEFAULT_TOKEN.token,
      };
      ws.simulateRawMessage(authFrame(hs, authRequest));
      await vi.advanceTimersByTimeAsync(0);
      return { ws, registry, authResponse: findAuthResponse(ws, sessionKey) };
    };

    it('rejects peer with protocol version one below the floor', async () => {
      // fails-when: MIN_PROTOCOL_VERSION drops below PROTOCOL_VERSION.
      const { ws, authResponse } = await sendPeerAuth(PROTOCOL_VERSION - 1);

      expect(authResponse).not.toBeNull();
      expect(authResponse.accepted).toBe(false);
      expect(authResponse.reason).toContain('Unsupported protocol version');
      expect(ws.closeCode).toBe(WS_CLOSE_PROTOCOL_ERROR);
    });

    it('rejects protocol version 3, the value every pre-R1 peer sends', async () => {
      // Every release before R1 shipped PROTOCOL_VERSION = 3, so a floor of 3
      // refuses no published build: a pre-R1 peer let through omits fields R1's
      // schemas require instead of being told at connect.
      //
      // fails-when: the floor stays at 3 — the relative probe above would then
      // drive 2 and still pass while a real pre-R1 peer connects.
      const { ws, registry, authResponse } = await sendPeerAuth(3);

      expect(authResponse?.accepted).toBe(false);
      expect(ws.closeCode).toBe(WS_CLOSE_PROTOCOL_ERROR);
      expect(registry.getPeer('remote-peer')).toBeUndefined();
    });

    it('accepts peer with protocol version equal to MIN_PROTOCOL_VERSION', async () => {
      const { handler, registry } = createTestHandler();
      const ws = new MockPeerWs();

      handler.handleConnection(ws);
      const hs = completeEcdhHandshake(ws);
      const { sessionKey } = hs;

      const authRequest = {
        type: 'peer.auth.request',
        instanceId: 'remote-peer',
        protocolVersion: MIN_PROTOCOL_VERSION,
        token: DEFAULT_TOKEN.token,
      };
      ws.simulateRawMessage(authFrame(hs, authRequest));
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
      const hs = completeEcdhHandshake(ws);
      const { sessionKey } = hs;

      const authRequest = {
        type: 'peer.auth.request',
        instanceId: 'remote-peer',
        protocolVersion: MIN_PROTOCOL_VERSION + 99, // future version
        token: DEFAULT_TOKEN.token,
      };
      ws.simulateRawMessage(authFrame(hs, authRequest));
      await vi.advanceTimersByTimeAsync(0);

      const peer = registry.getPeer('remote-peer');
      expect(peer).toBeDefined();
      expect(peer!.connected).toBe(true);
      expect(ws.closeCode).toBeUndefined();
    });

    it('includes softwareVersion in auth response for diagnostics', async () => {
      const { handler } = createTestHandler();
      const ws = new MockPeerWs();

      const { response: authResponse } = await authenticateWithToken(handler, ws);

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
          { text: 'Hello from worker', timestamp: Date.now(), stream: 'stdout' },
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

    it('persists a peer log chunk and forwards it to the platform', async () => {
      const appendChunk = vi.fn().mockResolvedValue(undefined);
      const forwardToPlatform = vi.fn();
      const addLines = vi.fn();

      const sink = createLogChunkSink({
        source: 'peer',
        stepLogBuffer: { addLines } as unknown as StepLogBuffer,
        logWriter: { appendChunk, trackPending: vi.fn() } as unknown as LogWriter,
        executionTracker: { resolveJobName: () => Promise.resolve('build') },
        forwardToPlatform,
      });

      // The normalize -> sink composition `orchestrator-core` installs on the
      // coordinator, driven here through a real encrypted `peer.log.chunk`
      // frame so the wire shape has to survive the handler's schema parse.
      const { handler } = createTestHandler({
        onPeerLogChunk: (chunk) => {
          for (const group of normalizePeerLogChunk(chunk)) sink(group);
        },
      });
      const ws = new MockPeerWs();
      const { sessionKey } = await authenticateWithToken(handler, ws);

      const chunk: PeerLogChunk = {
        type: 'peer.log.chunk',
        runId: 'run-1',
        jobId: 'job-1',
        stepIndex: 0,
        lines: [
          { text: 'out', timestamp: 100, stream: LogStream.enum.stdout },
          { text: 'err', timestamp: 100, stream: LogStream.enum.stderr },
        ],
      };

      ws.simulateRawMessage(encryptMessage(JSON.stringify(chunk), sessionKey));

      // The sink resolves the storage job name asynchronously before persisting,
      // so the appendChunk calls land on a later microtask — wait for them.
      await vi.waitFor(() => expect(appendChunk).toHaveBeenCalledTimes(2));

      expect(addLines).toHaveBeenCalledTimes(2);
      expect(appendChunk).toHaveBeenNthCalledWith(
        1,
        'run-1',
        'build',
        0,
        ['out'],
        100,
        'job-1',
        undefined,
        LogStream.enum.stdout,
      );
      expect(appendChunk).toHaveBeenNthCalledWith(
        2,
        'run-1',
        'build',
        0,
        ['err'],
        100,
        'job-1',
        undefined,
        LogStream.enum.stderr,
      );
      expect(forwardToPlatform).toHaveBeenCalledTimes(2);
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

  describe('peer forget routing', () => {
    function forgetResponse(ws: MockPeerWs, sessionKey: Buffer, countBefore: number): any {
      for (const msg of ws.sentMessages.slice(countBefore)) {
        try {
          const parsed = JSON.parse(decryptMessage(msg, sessionKey));
          if (parsed.type === 'peer.forget.response') return parsed;
        } catch {
          // ignore non-encrypted or other messages
        }
      }
      return null;
    }
    const request = {
      type: 'peer.forget.request',
      messageId: 'forget-1',
      instanceId: 'coord-gone',
    };

    // breaks-if-wrong: a coordinator's fan-out is answered
    it('answers a coordinator through onPeerForgetRequest', async () => {
      const onPeerForgetRequest = vi.fn(async () => ({
        outcome: PeerForgetOutcome.enum.forgotten,
        detail: 'coord-gone forgotten',
      }));
      const { handler } = createTestHandler({ onPeerForgetRequest });
      const ws = new MockPeerWs();
      const { sessionKey } = await authenticateWithToken(handler, ws);
      const countBefore = ws.sentMessages.length;

      ws.simulateRawMessage(encryptMessage(JSON.stringify(request), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      expect(onPeerForgetRequest).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 'coord-gone' }),
      );
      expect(forgetResponse(ws, sessionKey, countBefore)).toMatchObject({
        messageId: 'forget-1',
        outcome: PeerForgetOutcome.enum.forgotten,
      });
    });

    // fails-when: a peer holding a worker join token can make a coordinator forget a peer
    it('refuses a peer holding a worker join token, whatever role it declares', async () => {
      const onPeerForgetRequest = vi.fn();
      const { ws, sessionKey } = await connectWithWorkerToken(
        { onPeerForgetRequest },
        'coordinator',
      );
      const countBefore = ws.sentMessages.length;

      ws.simulateRawMessage(encryptMessage(JSON.stringify(request), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      expect(onPeerForgetRequest).not.toHaveBeenCalled();
      expect(forgetResponse(ws, sessionKey, countBefore)).toMatchObject({
        outcome: PeerForgetOutcome.enum.error,
        detail: 'peer forget requests are accepted from coordinators only',
      });
    });

    it('sendPeerForgetAndWait resolves with the response, or timeout', async () => {
      const { handler } = createTestHandler();
      const ws = new MockPeerWs();
      const { sessionKey } = await authenticateWithToken(handler, ws);

      const answered = handler.sendPeerForgetAndWait(
        'remote-peer',
        { ...request, messageId: 'f-ok' } as never,
        5_000,
      );
      ws.simulateRawMessage(
        encryptMessage(
          JSON.stringify({
            type: 'peer.forget.response',
            messageId: 'f-ok',
            outcome: PeerForgetOutcome.enum['not-found'],
            detail: 'x',
          }),
          sessionKey,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(await answered).toMatchObject({ outcome: PeerForgetOutcome.enum['not-found'] });

      const silent = handler.sendPeerForgetAndWait(
        'remote-peer',
        { ...request, messageId: 'f-late' } as never,
        500,
      );
      await vi.advanceTimersByTimeAsync(600);
      expect(await silent).toBe('timeout');
      expect(
        await handler.sendPeerForgetAndWait(
          'nobody',
          { ...request, messageId: 'f-none' } as never,
          500,
        ),
      ).toBeNull();
    });
  });

  describe('scaler reload routing', () => {
    /** The scaler reload response among what the handler sent after `countBefore`. */
    function reloadResponse(ws: MockPeerWs, sessionKey: Buffer, countBefore: number): any {
      for (const msg of ws.sentMessages.slice(countBefore)) {
        try {
          const parsed = JSON.parse(decryptMessage(msg, sessionKey));
          if (parsed.type === 'peer.scaler.reload.response') return parsed;
        } catch {
          // ignore non-encrypted or other messages
        }
      }
      return null;
    }

    const request = { type: 'peer.scaler.reload.request', messageId: 'reload-1' };
    const plan = {
      added: [],
      updated: ['linux'],
      unchanged: [],
      retired: [],
      resurrected: [],
      global: [],
    };

    // breaks-if-wrong: a coordinator-role peer's request is answered
    it('answers a request from a coordinator through onScalerReloadRequest', async () => {
      const onScalerReloadRequest = vi
        .fn()
        .mockResolvedValue({ outcome: ScalerReloadOutcome.enum.applied, plan });
      const { handler } = createTestHandler({ onScalerReloadRequest });
      const ws = new MockPeerWs();
      const { sessionKey } = await authenticateWithToken(handler, ws);
      const countBefore = ws.sentMessages.length;

      ws.simulateRawMessage(encryptMessage(JSON.stringify(request), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      expect(onScalerReloadRequest).toHaveBeenCalledTimes(1);
      expect(reloadResponse(ws, sessionKey, countBefore)).toEqual({
        type: 'peer.scaler.reload.response',
        messageId: 'reload-1',
        outcome: ScalerReloadOutcome.enum.applied,
        plan,
      });
    });

    // fails-when: a worker-sent peer.scaler.reload.request reaches the handler,
    // including one that declares itself a coordinator
    it.each([['worker'], ['coordinator']] as const)(
      'refuses a request from a peer holding a worker join token (declared role %s)',
      async (declaredRole) => {
        const onScalerReloadRequest = vi.fn();
        const { ws, sessionKey } = await connectWithWorkerToken(
          { onScalerReloadRequest },
          declaredRole,
        );
        const countBefore = ws.sentMessages.length;

        ws.simulateRawMessage(encryptMessage(JSON.stringify(request), sessionKey));
        await vi.advanceTimersByTimeAsync(0);

        expect(onScalerReloadRequest).not.toHaveBeenCalled();
        expect(reloadResponse(ws, sessionKey, countBefore)).toMatchObject({
          messageId: 'reload-1',
          outcome: ScalerReloadOutcome.enum.rejected,
          detail: 'scaler reload requests are accepted from coordinators only',
        });
      },
    );

    it('answers rejected when no handler is wired, and when the handler throws', async () => {
      for (const onScalerReloadRequest of [
        undefined,
        vi.fn().mockRejectedValue(new Error('boom')),
      ]) {
        const { handler } = createTestHandler({ onScalerReloadRequest });
        const ws = new MockPeerWs();
        const { sessionKey } = await authenticateWithToken(handler, ws);
        const countBefore = ws.sentMessages.length;

        ws.simulateRawMessage(encryptMessage(JSON.stringify(request), sessionKey));
        await vi.advanceTimersByTimeAsync(0);

        expect(reloadResponse(ws, sessionKey, countBefore)).toMatchObject({
          outcome: ScalerReloadOutcome.enum.rejected,
          ...(onScalerReloadRequest
            ? { errors: ['boom'] }
            : { detail: 'scaler reload requests are not handled by this peer' }),
        });
      }
    });

    it('sendScalerReloadAndWait returns null when the target is not connected', async () => {
      const { handler } = createTestHandler();
      expect(
        await handler.sendScalerReloadAndWait('nonexistent-peer', request as any, 1_000),
      ).toBeNull();
    });

    it('sendScalerReloadAndWait resolves with the matching response, or timeout', async () => {
      const { handler } = createTestHandler();
      const ws = new MockPeerWs();
      const { sessionKey } = await authenticateWithToken(handler, ws);

      const answered = handler.sendScalerReloadAndWait('remote-peer', request as any, 5_000);
      const unanswered = handler.sendScalerReloadAndWait(
        'remote-peer',
        { type: 'peer.scaler.reload.request', messageId: 'reload-2' },
        5_000,
      );
      ws.simulateRawMessage(
        encryptMessage(
          JSON.stringify({
            type: 'peer.scaler.reload.response',
            messageId: 'reload-1',
            outcome: ScalerReloadOutcome.enum['not-configured'],
          }),
          sessionKey,
        ),
      );
      await vi.advanceTimersByTimeAsync(5_000);

      expect(await answered).toMatchObject({
        messageId: 'reload-1',
        outcome: ScalerReloadOutcome.enum['not-configured'],
      });
      expect(await unanswered).toBe('timeout');
    });
  });

  describe('scaler orphans routing', () => {
    /** The scaler orphan response among what the handler sent after `countBefore`. */
    function orphansResponse(ws: MockPeerWs, sessionKey: Buffer, countBefore: number): any {
      for (const msg of ws.sentMessages.slice(countBefore)) {
        try {
          const parsed = JSON.parse(decryptMessage(msg, sessionKey));
          if (parsed.type === 'peer.scaler.orphans.response') return parsed;
        } catch {
          // ignore non-encrypted or other messages
        }
      }
      return null;
    }

    const request = {
      type: 'peer.scaler.orphans.request',
      messageId: 'orphans-1',
      action: ScalerOrphansAction.enum.stop,
      vmIds: ['scaler-firecracker-1'],
    };

    // breaks-if-wrong: a coordinator-role peer's request is answered
    it('answers a request from a coordinator through onScalerOrphansRequest', async () => {
      const onScalerOrphansRequest = vi.fn().mockResolvedValue({
        ok: true,
        firecrackerScalers: ['fc'],
        results: [
          {
            vmId: 'scaler-firecracker-1',
            outcome: ScalerVmStopOutcome.enum.stopped,
            detail: 'stopped',
          },
        ],
      });
      const { handler, registry } = createTestHandler({ onScalerOrphansRequest });
      const ws = new MockPeerWs();
      const { sessionKey } = await authenticateWithToken(handler, ws);
      expect(registry.getPeer('remote-peer')?.role).toBe('coordinator');
      const countBefore = ws.sentMessages.length;

      ws.simulateRawMessage(encryptMessage(JSON.stringify(request), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      expect(onScalerOrphansRequest).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'orphans-1', vmIds: ['scaler-firecracker-1'] }),
      );
      expect(orphansResponse(ws, sessionKey, countBefore)).toMatchObject({
        messageId: 'orphans-1',
        ok: true,
        results: [{ vmId: 'scaler-firecracker-1', outcome: ScalerVmStopOutcome.enum.stopped }],
      });
    });

    // fails-when: a worker can drive a coordinator's stop, including by declaring
    // itself a coordinator (or no role, which the registry reads as one)
    it.each([['worker'], ['coordinator'], [undefined]] as const)(
      'refuses a request from a peer holding a worker join token (declared role %s)',
      async (declaredRole) => {
        const onScalerOrphansRequest = vi.fn();
        const { registry, ws, sessionKey } = await connectWithWorkerToken(
          { onScalerOrphansRequest },
          declaredRole,
        );
        // The registry keeps the declared role; only the token's role is authenticated.
        expect(registry.getPeer('remote-peer')?.role).toBe(declaredRole ?? 'coordinator');
        const countBefore = ws.sentMessages.length;

        ws.simulateRawMessage(encryptMessage(JSON.stringify(request), sessionKey));
        await vi.advanceTimersByTimeAsync(0);

        expect(onScalerOrphansRequest).not.toHaveBeenCalled();
        expect(orphansResponse(ws, sessionKey, countBefore)).toMatchObject({
          messageId: 'orphans-1',
          ok: false,
          error: 'scaler orphan requests are accepted from coordinators only',
        });
      },
    );

    it('answers ok=false when no handler is wired', async () => {
      const { handler } = createTestHandler();
      const ws = new MockPeerWs();
      const { sessionKey } = await authenticateWithToken(handler, ws);
      const countBefore = ws.sentMessages.length;

      ws.simulateRawMessage(encryptMessage(JSON.stringify(request), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      expect(orphansResponse(ws, sessionKey, countBefore)).toMatchObject({
        ok: false,
        error: 'scaler orphan requests are not handled by this peer',
      });
    });

    it('answers ok=false with the message when the handler throws', async () => {
      const onScalerOrphansRequest = vi.fn().mockRejectedValue(new Error('probe failed'));
      const { handler } = createTestHandler({ onScalerOrphansRequest });
      const ws = new MockPeerWs();
      const { sessionKey } = await authenticateWithToken(handler, ws);
      const countBefore = ws.sentMessages.length;

      ws.simulateRawMessage(encryptMessage(JSON.stringify(request), sessionKey));
      await vi.advanceTimersByTimeAsync(0);

      expect(orphansResponse(ws, sessionKey, countBefore)).toMatchObject({
        ok: false,
        error: 'probe failed',
      });
    });

    it('sendScalerOrphansAndWait returns null when the target is not connected', async () => {
      const { handler } = createTestHandler();
      expect(
        await handler.sendScalerOrphansAndWait(
          'nonexistent-peer',
          {
            type: 'peer.scaler.orphans.request',
            messageId: 'x',
            action: ScalerOrphansAction.enum.list,
          },
          1_000,
        ),
      ).toBeNull();
    });

    it('sendScalerOrphansAndWait resolves with the matching response', async () => {
      const { handler } = createTestHandler();
      const ws = new MockPeerWs();
      const { sessionKey } = await authenticateWithToken(handler, ws);

      const promise = handler.sendScalerOrphansAndWait(
        'remote-peer',
        {
          type: 'peer.scaler.orphans.request',
          messageId: 'or-1',
          action: ScalerOrphansAction.enum.list,
        },
        5_000,
      );
      ws.simulateRawMessage(
        encryptMessage(
          JSON.stringify({
            type: 'peer.scaler.orphans.response',
            messageId: 'or-1',
            ok: true,
            firecrackerScalers: [],
            vms: [],
          }),
          sessionKey,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(await promise).toMatchObject({ messageId: 'or-1', ok: true });
    });

    it('sendScalerOrphansAndWait resolves timeout when no response arrives', async () => {
      const { handler } = createTestHandler();
      const ws = new MockPeerWs();
      await authenticateWithToken(handler, ws);

      const promise = handler.sendScalerOrphansAndWait(
        'remote-peer',
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

describe('shouldAdmitWorker', () => {
  it('never gates a coordinator peer', () => {
    expect(shouldAdmitWorker('coordinator', 0, 5)).toBe(true);
  });

  it('never gates a roleless peer (defaults to coordinator)', () => {
    expect(shouldAdmitWorker(undefined, 0, 5)).toBe(true);
  });

  it('admits a worker freely when no ceiling was ever received', () => {
    expect(shouldAdmitWorker('worker', null, 5)).toBe(true);
  });

  it('admits a worker below the ceiling', () => {
    expect(shouldAdmitWorker('worker', 2, 1)).toBe(true);
  });

  it('refuses a worker at the ceiling', () => {
    expect(shouldAdmitWorker('worker', 1, 1)).toBe(false);
  });

  it('refuses a worker at a zero ceiling', () => {
    expect(shouldAdmitWorker('worker', 0, 0)).toBe(false);
  });

  describe('mutual-v2 server', () => {
    /** A schema-valid job.reroute, so a negative assertion cannot pass on a dropped fixture. */
    function makeJobReroute(): JobReroute {
      return jobRerouteSchema.parse({
        type: 'job.reroute',
        spawnRetry: { maxAttempts: 3, backoffMs: 0 },
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

    /** A credential-mode request built against one handshake, so it can be replayed into another. */
    function credentialRequest(hs: ClientHandshake, psk: Buffer, peerInstanceId = 'remote-peer') {
      const clientProof = refClientProof({
        psk,
        th: hs.transcriptHash,
        mode: 'credential',
        instanceId: peerInstanceId,
        role: 'coordinator',
        protocolVersion: PROTOCOL_VERSION,
        tokenRouting: '',
      });
      return JSON.stringify({
        type: 'peer.auth.request',
        instanceId: peerInstanceId,
        protocolVersion: PROTOCOL_VERSION,
        role: 'coordinator',
        scheme: 'mutual-v2',
        mode: 'credential',
        clientProof: clientProof.toString('hex'),
      });
    }

    /** A credential store holding one live credential for remote-peer. */
    function storeWith(credential: string) {
      const credentialStore = createMockCredentialStore();
      credentialStore.findByInstanceId.mockResolvedValue({
        id: 'cred-1',
        instanceId: 'remote-peer',
        credentialHash: createHash('sha256').update(credential).digest('hex'),
        role: 'coordinator',
        routingKeys: ['github:42'],
        sourceTokenHash: null,
        createdAt: new Date(),
        lastSeenAt: null,
        expiresAt: new Date(Date.now() + 86_400_000),
        revokedAt: null,
      } as never);
      return credentialStore;
    }

    it('advertises mutual-v2 in peer.hello', () => {
      const { handler } = createTestHandler();
      const ws = new MockPeerWs();
      handler.handleConnection(ws);
      expect((ws.getSentMessages()[0] as { authSchemes: string[] }).authSchemes).toEqual([
        'mutual-v2',
      ]);
    });

    it('a frame under K_hs after acceptance is dropped; K_app frames are routed', async () => {
      const onJobReroute = vi.fn().mockResolvedValue(undefined);
      const { handler } = createTestHandler({ onJobReroute });
      const ws = new MockPeerWs();
      const { handshakeKey, sessionKey } = await authenticateWithToken(handler, ws);
      ws.simulateRawMessage(encryptMessage(JSON.stringify(makeJobReroute()), handshakeKey));
      await vi.advanceTimersByTimeAsync(0);
      // fails-when: the server keeps using K_hs after acceptance
      expect(onJobReroute).not.toHaveBeenCalled();
      ws.simulateRawMessage(encryptMessage(JSON.stringify(makeJobReroute()), sessionKey));
      await vi.advanceTimersByTimeAsync(0);
      expect(onJobReroute).toHaveBeenCalledTimes(1);
    });

    it('relay splice: a client auth request re-encrypted into a second session is refused with Invalid proof', async () => {
      const CRED = randomBytes(32).toString('hex');
      const psk = credentialPsk(CRED);
      const { handler } = createTestHandler({ credentialStore: storeWith(CRED) as never });
      // The genuine client's session with the relay: its request is bound to that transcript.
      const ws1 = new MockPeerWs();
      handler.handleConnection(ws1);
      const hs1 = completeEcdhHandshake(ws1);
      const request = credentialRequest(hs1, psk);
      // The relay's own session with the server: same request, re-encrypted.
      const ws2 = new MockPeerWs();
      handler.handleConnection(ws2);
      const hs2 = completeEcdhHandshake(ws2);
      ws2.simulateRawMessage(encryptMessage(request, hs2.sessionKey));
      await vi.advanceTimersByTimeAsync(0);
      // fails-when: the proof omits the ephemeral keys
      expect(authResponseOf(ws2, hs2.sessionKey)).toMatchObject({
        accepted: false,
        reason: 'Invalid proof',
      });
      expect(ws2.closeCode).toBe(WS_CLOSE_UNAUTHORIZED);
      // breaks-if-wrong: the same request on its own session is accepted
      ws1.simulateRawMessage(encryptMessage(request, hs1.sessionKey));
      await vi.advanceTimersByTimeAsync(0);
      expect(authResponseOf(ws1, hs1.sessionKey).accepted).toBe(true);
    });

    it.each([
      ['a proof field', { proof: 'ab'.repeat(32) }],
      ['a token field', { token: 'kici_join_v1.x.y' }],
      ['neither, and no scheme', {}],
    ])(
      'refuses an old-shape request carrying %s without charging the rate limit',
      async (_label, extra) => {
        const { handler } = createTestHandler();
        for (let i = 0; i < 6; i++) {
          const ws = new MockPeerWs();
          handler.handleConnection(ws, '10.0.0.9');
          const hs = completeEcdhHandshake(ws);
          ws.simulateRawMessage(
            encryptMessage(
              JSON.stringify({
                type: 'peer.auth.request',
                instanceId: 'old-peer',
                protocolVersion: PROTOCOL_VERSION,
                ...extra,
              }),
              hs.sessionKey,
            ),
          );
          await vi.advanceTimersByTimeAsync(0);
          // fails-when: the old shape is processed, or the reason is a divergence reason
          expect(authResponseOf(ws, hs.sessionKey)).toMatchObject({
            accepted: false,
            reason: PEER_MUTUAL_AUTH_REQUIRED_REASON,
          });
          expect(ws.closeCode).toBe(WS_CLOSE_PROTOCOL_ERROR);
        }
        // breaks-if-wrong: six refusals later, a v2 request from the same IP is still accepted
        const { response } = await authenticateV2(handler, new MockPeerWs(), {
          ...tokenOpts(DEFAULT_TOKEN),
          ip: '10.0.0.9',
        });
        expect(response.accepted).toBe(true);
      },
    );

    it('fix A: a worker token whose routing segment says coordinator gets the worker role', async () => {
      const t = makeTestJoinToken({ ...TOKEN_ROUTING, role: 'coordinator' }); // rewritten text
      const tokenManager = createMockTokenManager({
        rows: [{ tokenHash: t.tokenHash, role: 'worker' }],
      });
      const { handler, credentialStore } = createTestHandler({
        tokenManager: tokenManager as never,
        acceptedRoles: ['coordinator', 'worker'],
      });
      const { response } = await authenticateV2(handler, new MockPeerWs(), tokenOpts(t));
      // fails-when: the role is read from the token
      expect(response.role).toBe('worker');
      expect(credentialStore.save).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'worker' }),
      );
    });

    it('fix A on the idempotent-retry path: readByHash supplies the role', async () => {
      const t = makeTestJoinToken({ ...TOKEN_ROUTING, role: 'coordinator' });
      const tokenManager = createMockTokenManager({
        rows: [{ tokenHash: t.tokenHash, role: 'worker' }],
      });
      tokenManager.claimByHash.mockRejectedValueOnce(new Error(TOKEN_ALREADY_USED_MESSAGE));
      const credentialStore = createMockCredentialStore();
      credentialStore.findByInstanceId.mockResolvedValue({
        id: 'c',
        instanceId: 'remote-peer',
        credentialHash: 'x',
        role: 'worker',
        routingKeys: ['github:42'],
        sourceTokenHash: t.tokenHash,
        createdAt: new Date(),
        lastSeenAt: null,
        expiresAt: new Date(Date.now() + 86_400_000),
        revokedAt: null,
      } as never);
      const { handler } = createTestHandler({
        tokenManager: tokenManager as never,
        credentialStore: credentialStore as never,
        acceptedRoles: ['coordinator', 'worker'],
      });
      const { response } = await authenticateV2(handler, new MockPeerWs(), tokenOpts(t));
      expect(tokenManager.readByHash).toHaveBeenCalledWith(t.tokenHash);
      expect(response.role).toBe('worker');
      expect(credentialStore.save).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'worker' }),
      );
    });

    it('breaks-if-wrong: an unmodified coordinator token gets the coordinator role', async () => {
      const { handler } = createTestHandler();
      const { response } = await authenticateV2(
        handler,
        new MockPeerWs(),
        tokenOpts(DEFAULT_TOKEN),
      );
      expect(response).toMatchObject({ accepted: true, role: 'coordinator' });
    });

    it('same-millisecond tokens: the proof selects the right row and the other is not claimed', async () => {
      const a = makeTestJoinToken({ ...TOKEN_ROUTING, role: 'worker' });
      const b = makeTestJoinToken({ ...TOKEN_ROUTING, role: 'worker' });
      const tokenManager = createMockTokenManager({
        rows: [
          { tokenHash: a.tokenHash, role: 'worker' },
          { tokenHash: b.tokenHash, role: 'worker' },
        ],
      });
      const { handler } = createTestHandler({
        tokenManager: tokenManager as never,
        acceptedRoles: ['worker'],
      });
      const { response } = await authenticateV2(handler, new MockPeerWs(), {
        ...tokenOpts(b),
        role: 'worker',
      });
      expect(response.accepted).toBe(true);
      expect(tokenManager.claimByHash).toHaveBeenCalledTimes(1);
      expect(tokenManager.claimByHash).toHaveBeenCalledWith(
        b.tokenHash,
        'handler-orch',
        'remote-peer',
      );
    });

    it('caps the token candidates it checks per request', async () => {
      const t = makeTestJoinToken({ ...TOKEN_ROUTING, role: 'coordinator' });
      const decoys = Array.from({ length: 8 }, () => ({
        tokenHash: randomBytes(32).toString('hex'),
        role: 'coordinator' as const,
      }));
      // The right row sits ninth: past the cap, so it is never checked.
      const tokenManager = createMockTokenManager({
        rows: [...decoys, { tokenHash: t.tokenHash, role: 'coordinator' }],
      });
      const { handler } = createTestHandler({ tokenManager: tokenManager as never });
      const { response } = await authenticateV2(handler, new MockPeerWs(), tokenOpts(t));
      // fails-when: no cap
      expect(response).toMatchObject({ accepted: false, reason: 'Invalid token' });
      expect(tokenManager.claimByHash).not.toHaveBeenCalled();
    });

    it('accepts the right row at the cap', async () => {
      // breaks-if-wrong: the cap must not refuse the eighth candidate
      const t = makeTestJoinToken({ ...TOKEN_ROUTING, role: 'coordinator' });
      const decoys = Array.from({ length: 7 }, () => ({
        tokenHash: randomBytes(32).toString('hex'),
        role: 'coordinator' as const,
      }));
      const tokenManager = createMockTokenManager({
        rows: [...decoys, { tokenHash: t.tokenHash, role: 'coordinator' }],
      });
      const { handler } = createTestHandler({ tokenManager: tokenManager as never });
      const { response } = await authenticateV2(handler, new MockPeerWs(), tokenOpts(t));
      expect(response.accepted).toBe(true);
    });

    it('a token-mode request without tokenRouting is refused with Invalid token', async () => {
      const { handler } = createTestHandler();
      const { response } = await authenticateV2(handler, new MockPeerWs(), {
        mode: 'token',
        psk: tokenPsk(DEFAULT_TOKEN.tokenHash),
      });
      expect(response).toMatchObject({ accepted: false, reason: 'Invalid token' });
    });

    it('a malformed clientProof is refused with Invalid proof', async () => {
      const CRED = randomBytes(32).toString('hex');
      const { handler } = createTestHandler({ credentialStore: storeWith(CRED) as never });
      const ws = new MockPeerWs();
      handler.handleConnection(ws);
      const hs = completeEcdhHandshake(ws);
      ws.simulateRawMessage(
        authFrame(hs, {
          type: 'peer.auth.request',
          instanceId: 'remote-peer',
          protocolVersion: PROTOCOL_VERSION,
          proof: 'zz',
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(authResponseOf(ws, hs.sessionKey)).toMatchObject({
        accepted: false,
        reason: 'Invalid proof',
      });
    });

    it('a second frame while authentication is in flight closes the socket', async () => {
      const CRED = randomBytes(32).toString('hex');
      const credentialStore = storeWith(CRED);
      const stored = await credentialStore.findByInstanceId('remote-peer');
      let release!: () => void;
      credentialStore.findByInstanceId.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => resolve(stored);
          }),
      );
      const { handler, registry } = createTestHandler({
        credentialStore: credentialStore as never,
      });
      const ws = new MockPeerWs();
      handler.handleConnection(ws);
      const hs = completeEcdhHandshake(ws);
      ws.simulateRawMessage(
        encryptMessage(credentialRequest(hs, credentialPsk(CRED)), hs.sessionKey),
      );
      ws.simulateRawMessage(
        encryptMessage(credentialRequest(hs, credentialPsk(CRED)), hs.sessionKey),
      );
      // fails-when: the second frame is parsed as another auth request
      expect(ws.closeCode).toBe(WS_CLOSE_INVALID_MESSAGE);
      release();
      await vi.advanceTimersByTimeAsync(0);
      // The first request's acceptance does not register a peer on the closed socket.
      expect(registry.getPeer('remote-peer')).toBeUndefined();
    });

    it('records the inbound scheme and resets it on close', async () => {
      const { handler, registry } = createTestHandler();
      const ws = new MockPeerWs();
      await authenticateWithToken(handler, ws);
      expect(registry.getPeer('remote-peer')!.authScheme.inbound).toBe('mutual-v2');
      ws.emit('close');
      expect(registry.getPeer('remote-peer')!.authScheme.inbound).toBeNull();
    });

    it('never logs a proof, PSK or token hash', async () => {
      const infoSpy = vi.spyOn(loggerHolder.peerHandler!, 'info');
      const warnSpy = vi.spyOn(loggerHolder.peerHandler!, 'warn');
      try {
        const { handler } = createTestHandler();
        const { response } = await authenticateWithToken(handler, new MockPeerWs());
        // A refused request logs too.
        await authenticateV2(
          handler,
          new MockPeerWs(),
          tokenOpts(makeTestJoinToken({ ...TOKEN_ROUTING, role: 'coordinator' })),
        );
        const logged = JSON.stringify([...infoSpy.mock.calls, ...warnSpy.mock.calls]);
        expect(logged).not.toContain(DEFAULT_TOKEN.tokenHash);
        expect(logged).not.toContain(DEFAULT_TOKEN.secretHex);
        expect(logged).not.toContain(response.serverProof);
        expect(logged).not.toMatch(/[0-9a-f]{64}/);
      } finally {
        infoSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });

  describe('a peer that reconnects inbound', () => {
    it('the old socket closing does not drop the new connection', async () => {
      // fails-when: the close handler cleans up whatever connection holds the peer id
      const { handler, registry } = createTestHandler();
      const oldWs = new MockPeerWs();
      await authenticateWithToken(handler, oldWs);
      const newWs = new MockPeerWs();
      const { sessionKey } = await authenticateWithToken(handler, newWs);
      oldWs.emit('close');
      expect(registry.getPeer('remote-peer')!.connected).toBe(true);
      expect(registry.getPeer('remote-peer')!.authScheme.inbound).toBe('mutual-v2');
      expect(handler.getConnectionCount()).toBe(1);
      const before = newWs.sentMessages.length;
      expect(handler.sendToPeer('remote-peer', makeHeartbeatMessage())).toBe(true);
      expect(newWs.sentMessages.length).toBe(before + 1);
      expect(JSON.parse(decryptMessage(newWs.sentMessages[before], sessionKey)).type).toBe(
        'peer.heartbeat',
      );
    });

    it('the old socket stops sending heartbeats after it closes', async () => {
      const { handler } = createTestHandler();
      const oldWs = new MockPeerWs();
      await authenticateWithToken(handler, oldWs);
      await authenticateWithToken(handler, new MockPeerWs());
      oldWs.emit('close');
      oldWs.readyState = 1; // were the timer still armed, it would send here
      const before = oldWs.sentMessages.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(oldWs.sentMessages.length).toBe(before);
    });

    it('the current socket closing still drops the connection', async () => {
      // breaks-if-wrong: the guard must not swallow a real close
      const { handler, registry } = createTestHandler();
      const ws = new MockPeerWs();
      await authenticateWithToken(handler, ws);
      ws.emit('close');
      expect(registry.getPeer('remote-peer')!.connected).toBe(false);
      expect(handler.getConnectionCount()).toBe(0);
    });
  });
});

function makeHeartbeatMessage() {
  return {
    type: 'peer.heartbeat' as const,
    instanceId: 'handler-orch',
    term: 1,
    leaderId: null,
    draining: false,
    agents: [],
    capabilities: { s3LogAccess: false },
    timestamp: Date.now(),
  };
}
