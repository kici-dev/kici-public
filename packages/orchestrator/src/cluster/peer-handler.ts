/**
 * WebSocket handler for incoming peer connections from other orchestrators.
 *
 * Accepts WS upgrade, performs ECDH key exchange for encrypted channel,
 * validates authentication via join token (first connect) or HMAC credential
 * proof (reconnection), registers the peer in PeerRegistry, and routes
 * messages bidirectionally. Sends periodic heartbeats to the connecting peer.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createLogger, sha256, toErrorMessage, ChunkRequestWaiter } from '@kici-dev/shared';
import {
  peerHelloResponseSchema,
  peerAuthRequestSchema,
  peerFromPeerMessageSchema,
  MIN_PROTOCOL_VERSION,
  WS_CLOSE_UNAUTHORIZED,
  WS_CLOSE_PROTOCOL_ERROR,
  WS_CLOSE_AUTH_TIMEOUT,
  WS_CLOSE_INVALID_MESSAGE,
  type PeerHeartbeat,
  type PeerToPeerMessage,
  type JobReroute,
  type JobProgress,
  type JobProgressAck,
  type PeerScalerEvent,
  type PeerJobCancel,
  type PeerLogChunk,
  type PeerCacheUploadRequest,
  type PeerCacheUploadResponse,
  type PeerConfigReload,
  type PeerConfigReloadResponse,
  type PeerLogsCollectRequest,
  type PeerLeaving,
  type PeerAgentTokenRevoke,
  type RaftVoteRequest,
  type RaftVoteResponse,
  type RaftAppendEntries,
} from '@kici-dev/engine';
import type { PeerRegistry } from './peer-registry.js';
import {
  generateEcdhKeyPair,
  deriveSessionKey,
  encryptMessage,
  decryptMessage,
} from './peer-crypto.js';
import type { PeerCredentialStore } from './peer-credentials.js';
import {
  deriveKeys,
  isTokenAlreadyUsedError,
  parseToken,
  type JoinTokenManager,
} from './join-token.js';

const logger = createLogger({ prefix: 'peer-handler' });

// Software version injected at build time by scripts/build-service.mjs.
declare const KICI_PKG_VERSION: string;
const SOFTWARE_VERSION = typeof KICI_PKG_VERSION !== 'undefined' ? KICI_PKG_VERSION : '0.0.0';

/**
 * Minimal WebSocket interface for peer connections.
 * Same pattern as agent/registry.ts WsLike, allowing mock testing.
 */
export interface PeerWsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  readyState: number;
}

export interface PeerHandlerDeps {
  /** Join token manager for validating first-time peer tokens. */
  tokenManager: JoinTokenManager;
  /** Credential store for session credential CRUD. */
  credentialStore: PeerCredentialStore;
  /** Accepted roles for connecting peers. Default: ['coordinator', 'worker'] (accept any). */
  acceptedRoles?: Array<'coordinator' | 'worker'>;
  /** This orchestrator's instance ID. */
  instanceId: string;
  /** Peer registry to track incoming peers. */
  peerRegistry: PeerRegistry;
  /** Callback to get this orchestrator's local agent inventory for heartbeats. */
  getLocalInventory: () => Omit<PeerHeartbeat, 'type'>;
  /** Heartbeat interval in ms. Default: 30000 (30s). */
  heartbeatIntervalMs?: number;
  /** Auth timeout in ms. Default: 15000 (15s). */
  authTimeoutMs?: number;
  /** Callback when a job reroute request is received from peer. */
  onJobReroute: (msg: JobReroute) => Promise<void>;
  /** Callback when a job progress update is received from peer. */
  onJobProgress: (msg: JobProgress, reply: (m: JobProgressAck) => void) => void;
  /** Callback when a scaler provisioning event is forwarded by a worker peer. */
  onPeerScalerEvent?: (msg: PeerScalerEvent) => void;
  /** Callback when a job cancel request is received from peer. */
  onJobCancel: (msg: PeerJobCancel) => void;
  /** Callback when a log chunk is received from a worker peer. */
  onPeerLogChunk?: (chunk: PeerLogChunk, peerId: string) => void;
  /** Callback when a cache upload request is received from a worker peer. */
  onPeerCacheUploadRequest?: (
    req: PeerCacheUploadRequest,
    peerId: string,
  ) => Promise<PeerCacheUploadResponse>;
  /** Callback for Raft vote requests. */
  onRaftVoteRequest?: (msg: RaftVoteRequest) => RaftVoteResponse;
  /** Callback for Raft vote responses (forwarded to Raft module). */
  onRaftVoteResponse?: (msg: RaftVoteResponse) => void;
  /** Callback for Raft append entries (leader heartbeat). */
  onRaftAppendEntries?: (msg: RaftAppendEntries) => void;
  /** Callback when a peer.leaving announcement is received. */
  onPeerLeaving?: (msg: PeerLeaving) => void;
  /**
   * Callback when a peer.agent-token.revoke announcement is received.
   * The local handler should call agentRegistry.disconnectByTokenId(tokenId)
   * to close every in-flight WS authenticated by the now-revoked token.
   */
  onAgentTokenRevoke?: (msg: PeerAgentTokenRevoke) => void;
  /**
   * Callback when a config reload request is received from a peer.
   * Should execute a local config reload and return the result fields,
   * which are sent back via peer.config.reload.response.
   *
   * If undefined, incoming reload requests are answered with success=false
   * and an error explaining that reload is unavailable on this peer.
   */
  onPeerConfigReload?: (msg: PeerConfigReload) => Promise<{
    success: boolean;
    version?: number;
    errors?: string[];
    restartRequired?: string[];
    fieldsChanged?: string[];
  }>;
  /**
   * Callback when a peer.logs.collect.request arrives from an incoming-dialed
   * peer. Builds this node's subtree bundle and streams it back through `send`
   * (peer.logs.collect.chunk frames, or a peer.logs.collect.error on failure).
   * If undefined, incoming collect requests are ignored.
   */
  onLogsCollectRequest?: (
    msg: PeerLogsCollectRequest,
    send: (out: PeerToPeerMessage) => boolean,
  ) => Promise<void>;
}

interface PeerConnection {
  peerInstanceId: string;
  ws: PeerWsLike;
  sessionKey: Buffer;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

/** Rate limit tracking per IP. */
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/** Max failed auth attempts per IP within the window. */
const RATE_LIMIT_MAX = 5;
/** Rate limit window in ms. */
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Create a handler function for incoming peer WebSocket connections.
 *
 * Returns `handleConnection(ws, remoteIp?)` which should be called when a new
 * WebSocket connection is upgraded on the peer endpoint.
 */
export function createPeerHandler(deps: PeerHandlerDeps) {
  const {
    tokenManager,
    credentialStore,
    acceptedRoles = ['coordinator', 'worker'],
    instanceId,
    peerRegistry,
    getLocalInventory,
    heartbeatIntervalMs = 30_000,
    authTimeoutMs = 15_000,
    onJobReroute,
    onJobProgress,
    onPeerScalerEvent,
    onJobCancel,
    onPeerLogChunk,
    onPeerCacheUploadRequest,
    onRaftVoteRequest,
    onRaftVoteResponse,
    onRaftAppendEntries,
    onPeerLeaving,
    onAgentTokenRevoke,
    onPeerConfigReload,
    onLogsCollectRequest,
  } = deps;

  /** Active peer connections by instanceId. */
  const connections = new Map<string, PeerConnection>();

  /** ACK waiters for sendAndWaitAck (server-side connections). Keyed by messageId. */
  const ackWaiters = new Map<
    string,
    { resolve: (accepted: boolean) => void; timer: ReturnType<typeof setTimeout> }
  >();

  /**
   * Config reload response waiters (server-side connections). Keyed by messageId.
   * Resolved when a peer.config.reload.response arrives.
   */
  const configReloadWaiters = new Map<
    string,
    {
      resolve: (response: PeerConfigReloadResponse) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /** Correlates peer.logs.collect.request with the peer's chunked subtree response. */
  const logsCollectWaiters = new ChunkRequestWaiter();
  /** messageId -> target peer instanceId, so a peer's disconnect rejects only its collects. */
  const logsCollectTargets = new Map<string, string>();

  /** Rate limiting for failed auth attempts by IP. */
  const rateLimitsByIp = new Map<string, RateLimitEntry>();
  /** Rate limiting for failed auth attempts by instance ID. */
  const rateLimitsByInstanceId = new Map<string, RateLimitEntry>();

  /**
   * Check if a key is rate-limited in the given map.
   */
  function checkLimit(map: Map<string, RateLimitEntry>, key: string): boolean {
    const now = Date.now();
    const entry = map.get(key);
    if (!entry) return false;
    if (now > entry.resetAt) {
      map.delete(key);
      return false;
    }
    return entry.count >= RATE_LIMIT_MAX;
  }

  /**
   * Record a failed attempt in the given map.
   */
  function recordLimit(map: Map<string, RateLimitEntry>, key: string): void {
    const now = Date.now();
    const entry = map.get(key);
    if (!entry || now > entry.resetAt) {
      map.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    } else {
      entry.count++;
    }
  }

  /**
   * Check rate limit for a given IP and optional instance ID.
   * Returns true if either dimension is rate-limited.
   */
  function isRateLimited(ip: string, instanceId?: string): boolean {
    if (checkLimit(rateLimitsByIp, ip)) return true;
    if (instanceId && checkLimit(rateLimitsByInstanceId, instanceId)) return true;
    return false;
  }

  /**
   * Record a failed auth attempt for rate limiting in both dimensions.
   */
  function recordFailedAuth(ip: string, instanceId?: string): void {
    recordLimit(rateLimitsByIp, ip);
    if (instanceId) recordLimit(rateLimitsByInstanceId, instanceId);
  }

  /** Periodic cleanup of expired rate limit entries. */
  const rateLimitCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitsByIp) {
      if (now > entry.resetAt) rateLimitsByIp.delete(key);
    }
    for (const [key, entry] of rateLimitsByInstanceId) {
      if (now > entry.resetAt) rateLimitsByInstanceId.delete(key);
    }
  }, 5 * 60_000);

  /**
   * Send a plaintext message on a peer WebSocket (pre-ECDH).
   */
  function sendPlainMessage(ws: PeerWsLike, msg: Record<string, unknown>): void {
    ws.send(JSON.stringify(msg));
  }

  /**
   * Send an encrypted typed message on a peer WebSocket (post-ECDH).
   */
  function sendEncryptedMessage(
    ws: PeerWsLike,
    sessionKey: Buffer,
    msg: PeerToPeerMessage | Record<string, unknown>,
  ): void {
    ws.send(encryptMessage(JSON.stringify(msg), sessionKey));
  }

  /**
   * Start sending periodic heartbeats to the peer.
   */
  function startHeartbeat(conn: PeerConnection): void {
    conn.heartbeatTimer = setInterval(() => {
      if (conn.ws.readyState === 1 /* OPEN */) {
        const inventory = getLocalInventory();
        sendEncryptedMessage(conn.ws, conn.sessionKey, {
          type: 'peer.heartbeat',
          ...inventory,
        });
      }
    }, heartbeatIntervalMs);
  }

  /**
   * Clean up a peer connection (heartbeat timer, registry update).
   */
  function cleanupConnection(conn: PeerConnection): void {
    if (conn.heartbeatTimer) {
      clearInterval(conn.heartbeatTimer);
      conn.heartbeatTimer = null;
    }
    peerRegistry.markDisconnected(conn.peerInstanceId);
    connections.delete(conn.peerInstanceId);
  }

  /**
   * Route an authenticated message from a peer.
   */
  function routeMessage(conn: PeerConnection, msg: PeerToPeerMessage): void {
    switch (msg.type) {
      case 'peer.heartbeat': {
        peerRegistry.updateHeartbeat(msg.instanceId, msg);
        break;
      }

      case 'job.reroute': {
        onJobReroute(msg).catch((err) => {
          logger.error('Error handling job reroute from peer', {
            error: toErrorMessage(err),
          });
        });
        break;
      }

      case 'job.reroute.ack': {
        // Resolve any pending ack waiter for this message
        const waiter = ackWaiters.get(msg.messageId);
        if (waiter) {
          clearTimeout(waiter.timer);
          ackWaiters.delete(msg.messageId);
          waiter.resolve(msg.accepted);
        }
        break;
      }

      case 'job.progress': {
        onJobProgress(msg, (out) => sendEncryptedMessage(conn.ws, conn.sessionKey, out));
        break;
      }

      case 'scaler.event': {
        onPeerScalerEvent?.(msg);
        break;
      }

      case 'peer.job.cancel': {
        onJobCancel(msg);
        break;
      }

      case 'raft.vote.request': {
        if (onRaftVoteRequest) {
          const response = onRaftVoteRequest(msg);
          sendEncryptedMessage(conn.ws, conn.sessionKey, response);
        }
        break;
      }

      case 'raft.append.entries': {
        onRaftAppendEntries?.(msg);
        break;
      }

      case 'peer.log.chunk': {
        onPeerLogChunk?.(msg, conn.peerInstanceId);
        break;
      }

      case 'peer.cache.upload.request': {
        if (onPeerCacheUploadRequest) {
          onPeerCacheUploadRequest(msg, conn.peerInstanceId)
            .then((response) => {
              sendEncryptedMessage(conn.ws, conn.sessionKey, response);
            })
            .catch((err) => {
              logger.error('Error handling cache upload request from peer', {
                peerId: conn.peerInstanceId,
                error: toErrorMessage(err),
              });
              // Send error response with empty URL
              sendEncryptedMessage(conn.ws, conn.sessionKey, {
                type: 'peer.cache.upload.response',
                messageId: msg.messageId,
                runId: msg.runId,
                jobId: msg.jobId,
                uploadUrl: '',
              });
            });
        } else {
          // No handler -- send error response
          sendEncryptedMessage(conn.ws, conn.sessionKey, {
            type: 'peer.cache.upload.response',
            messageId: msg.messageId,
            runId: msg.runId,
            jobId: msg.jobId,
            uploadUrl: '',
          });
        }
        break;
      }

      case 'peer.cache.upload.response': {
        // Should not receive cache upload response on incoming connection (coordinator side)
        logger.warn('Unexpected peer.cache.upload.response on incoming connection');
        break;
      }

      case 'peer.auth.request': {
        // Should not receive auth request after authentication
        logger.warn('Unexpected peer.auth.request after authentication');
        break;
      }

      case 'peer.auth.response': {
        // Should not receive auth response on incoming connection
        logger.warn('Unexpected peer.auth.response on incoming connection');
        break;
      }

      case 'raft.vote.response': {
        onRaftVoteResponse?.(msg);
        break;
      }

      case 'peer.leaving': {
        // Mark peer as disconnected in registry first, then notify Raft
        peerRegistry.markDisconnected(msg.instanceId);
        onPeerLeaving?.(msg);
        break;
      }

      case 'peer.agent-token.revoke': {
        onAgentTokenRevoke?.(msg);
        break;
      }

      case 'peer.config.reload': {
        // Execute reload locally and reply with response.
        const handler = onPeerConfigReload;
        const replyMessageId = msg.messageId;
        const sendResponse = (response: Omit<PeerConfigReloadResponse, 'type' | 'messageId'>) => {
          sendEncryptedMessage(conn.ws, conn.sessionKey, {
            type: 'peer.config.reload.response',
            messageId: replyMessageId,
            ...response,
          });
        };

        if (!handler) {
          sendResponse({
            success: false,
            errors: ['Config reload handler not configured on target peer'],
          });
          break;
        }

        handler(msg)
          .then((result) => {
            sendResponse(result);
          })
          .catch((err) => {
            logger.error('Error executing peer config reload', {
              peerId: conn.peerInstanceId,
              error: toErrorMessage(err),
            });
            sendResponse({ success: false, errors: [toErrorMessage(err)] });
          });
        break;
      }

      case 'peer.config.reload.response': {
        const waiter = configReloadWaiters.get(msg.messageId);
        if (waiter) {
          clearTimeout(waiter.timer);
          configReloadWaiters.delete(msg.messageId);
          waiter.resolve(msg);
        }
        break;
      }

      case 'peer.logs.collect.request': {
        void onLogsCollectRequest?.(msg, (out) => {
          sendEncryptedMessage(conn.ws, conn.sessionKey, out);
          return true;
        });
        break;
      }

      case 'peer.logs.collect.chunk': {
        logsCollectWaiters.onChunk(msg.messageId, msg.seq, msg.dataB64, msg.isLast);
        break;
      }

      case 'peer.logs.collect.error': {
        logsCollectWaiters.onError(msg.messageId, msg.message);
        break;
      }
    }
  }

  /**
   * Handle a new incoming peer WebSocket connection.
   * @param ws - WebSocket connection
   * @param remoteIp - Remote IP address for rate limiting (optional)
   */
  function handleConnection(ws: PeerWsLike, remoteIp?: string): void {
    const ip = remoteIp ?? 'unknown';

    // Check rate limiting
    if (isRateLimited(ip)) {
      logger.warn('Rate limited peer connection attempt', { ip });
      ws.close(WS_CLOSE_UNAUTHORIZED, 'Rate limited');
      return;
    }

    let authenticated = false;
    let peerInstanceId: string | null = null;
    let sessionKey: Buffer | null = null;
    let handshakeNonce: Buffer | null = null;

    // Auth timeout: close if not authenticated within threshold
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        logger.warn('Peer auth timeout, closing connection');
        ws.close(WS_CLOSE_AUTH_TIMEOUT, 'Auth timeout');
      }
    }, authTimeoutMs);

    // --- Step 1: ECDH handshake (Layer 1) ---
    // Generate ephemeral key pair and send peer.hello
    const ecdh = generateEcdhKeyPair();
    const nonce = randomBytes(32);
    handshakeNonce = nonce;

    sendPlainMessage(ws, {
      type: 'peer.hello',
      ephemeralPublicKey: ecdh.publicKey.toString('base64'),
      nonce: nonce.toString('base64'),
    });

    // State: waiting for peer.hello.response, then peer.auth.request (encrypted)
    let ecdhComplete = false;

    ws.on('message', (data: unknown) => {
      const raw = typeof data === 'string' ? data : String(data);

      if (!ecdhComplete) {
        // --- Waiting for peer.hello.response (plaintext) ---
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          logger.warn('Malformed JSON during ECDH handshake');
          return;
        }

        const helloResp = peerHelloResponseSchema.safeParse(parsed);
        if (!helloResp.success) {
          logger.warn('Expected peer.hello.response, got invalid message');
          ws.close(WS_CLOSE_INVALID_MESSAGE, 'Expected hello response');
          clearTimeout(authTimer);
          return;
        }

        // Derive session key
        try {
          sessionKey = deriveSessionKey(
            ecdh.privateKey,
            Buffer.from(helloResp.data.ephemeralPublicKey, 'base64'),
            nonce,
          );
        } catch (err) {
          logger.warn('ECDH key derivation failed', { error: toErrorMessage(err) });
          ws.close(WS_CLOSE_INVALID_MESSAGE, 'Key derivation failed');
          clearTimeout(authTimer);
          return;
        }

        ecdhComplete = true;
        return;
      }

      if (!authenticated) {
        // --- Waiting for peer.auth.request (encrypted) ---
        if (!sessionKey) {
          logger.warn('No session key for auth decryption');
          ws.close(WS_CLOSE_INVALID_MESSAGE, 'No session key');
          clearTimeout(authTimer);
          return;
        }

        let decrypted: string;
        try {
          decrypted = decryptMessage(raw, sessionKey);
        } catch (err) {
          logger.warn('Failed to decrypt auth request', { error: toErrorMessage(err) });
          recordFailedAuth(ip);
          ws.close(WS_CLOSE_UNAUTHORIZED, 'Decryption failed');
          clearTimeout(authTimer);
          return;
        }

        let authParsed: unknown;
        try {
          authParsed = JSON.parse(decrypted);
        } catch {
          logger.warn('Malformed JSON in decrypted auth request');
          ws.close(WS_CLOSE_INVALID_MESSAGE, 'Invalid auth format');
          clearTimeout(authTimer);
          return;
        }

        const authMsg = peerAuthRequestSchema.safeParse(authParsed);
        if (!authMsg.success) {
          logger.warn('Invalid peer.auth.request format', { errors: authMsg.error.issues });
          ws.close(WS_CLOSE_INVALID_MESSAGE, 'Invalid auth request');
          clearTimeout(authTimer);
          return;
        }

        // Handle auth asynchronously
        handleAuth(ws, sessionKey, handshakeNonce!, authMsg.data, ip)
          .then((result) => {
            if (!result) return;

            authenticated = true;
            peerInstanceId = authMsg.data.instanceId;
            clearTimeout(authTimer);

            logger.info('Peer authenticated', { peerInstanceId });

            // Register in peer registry
            peerRegistry.addPeer({
              instanceId: peerInstanceId,
              connectionId: randomUUID(),
              address: null, // incoming connections don't have a known address
              routingKeys: [],
              role: authMsg.data.role,
            });

            // Send immediate heartbeat so peer has our full state
            const inventory = getLocalInventory();
            sendEncryptedMessage(ws, sessionKey!, {
              type: 'peer.heartbeat',
              ...inventory,
            });

            // Start periodic heartbeats
            const conn: PeerConnection = {
              peerInstanceId,
              ws,
              sessionKey: sessionKey!,
              heartbeatTimer: null,
            };
            connections.set(peerInstanceId, conn);
            startHeartbeat(conn);
          })
          .catch((err) => {
            logger.error('Unexpected error during auth handling', {
              error: toErrorMessage(err),
            });
            ws.close(WS_CLOSE_UNAUTHORIZED, 'Auth error');
            clearTimeout(authTimer);
          });

        return;
      }

      // --- Authenticated: decrypt and route ---
      if (!sessionKey) return;

      let decrypted: string;
      try {
        decrypted = decryptMessage(raw, sessionKey);
      } catch {
        logger.warn('Failed to decrypt message from authenticated peer');
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(decrypted);
      } catch {
        logger.warn('Malformed JSON from peer connection');
        return;
      }

      const msgResult = peerFromPeerMessageSchema.safeParse(parsed);
      if (!msgResult.success) {
        logger.warn('Invalid message from peer', { errors: msgResult.error.issues });
        return;
      }

      const conn = connections.get(peerInstanceId!);
      if (conn) {
        routeMessage(conn, msgResult.data);
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);

      if (peerInstanceId) {
        logger.info('Peer disconnected', { peerInstanceId });
        rejectLogsCollectForPeer(peerInstanceId);
        const conn = connections.get(peerInstanceId);
        if (conn) {
          cleanupConnection(conn);
        }
      }
    });

    ws.on('error', (err: unknown) => {
      logger.error('Peer connection error', {
        error: toErrorMessage(err),
      });
    });
  }

  /**
   * Validate auth request (token or credential proof).
   * Returns true if accepted, false if rejected.
   */
  async function handleAuth(
    ws: PeerWsLike,
    sessionKey: Buffer,
    nonce: Buffer,
    authMsg: {
      instanceId: string;
      protocolVersion: number;
      token?: string;
      proof?: string;
      softwareVersion?: string;
      role?: 'coordinator' | 'worker';
    },
    ip: string,
  ): Promise<boolean> {
    // Protocol version check (minimum-version semantics: future versions accepted)
    if (authMsg.protocolVersion < MIN_PROTOCOL_VERSION) {
      logger.warn('Peer protocol version below minimum', {
        peerInstanceId: authMsg.instanceId,
        received: authMsg.protocolVersion,
        minimum: MIN_PROTOCOL_VERSION,
      });
      sendEncryptedMessage(ws, sessionKey, {
        type: 'peer.auth.response',
        accepted: false,
        instanceId,
        reason: `Unsupported protocol version: ${authMsg.protocolVersion} < ${MIN_PROTOCOL_VERSION}`,
        softwareVersion: SOFTWARE_VERSION,
      });
      recordFailedAuth(ip, authMsg.instanceId);
      ws.close(WS_CLOSE_PROTOCOL_ERROR, 'Unsupported protocol version');
      return false;
    }

    if (authMsg.softwareVersion) {
      logger.info('Peer software version', {
        peerInstanceId: authMsg.instanceId,
        localVersion: SOFTWARE_VERSION,
        remoteVersion: authMsg.softwareVersion,
      });
    }

    if (authMsg.token) {
      // --- Token-based auth (first join) ---
      try {
        // Atomic validate+consume: one UPDATE..WHERE consumed_at IS NULL
        // wins the claim across the shared-DB mesh; every other concurrent
        // caller throws TOKEN_ALREADY_USED and is handled by the recovery
        // branch below. The atomicity is what keeps multiple coordinators
        // from each issuing their own credential for the same instanceId
        // off a single join token.
        //
        // The joining peer's instanceId (authMsg.instanceId) is recorded as
        // consumed_by_instance so the SAME peer can re-present its still-valid
        // join token after losing its credential (transient outage / deleted
        // credential file) and self-heal without a redeploy. `instanceId` here
        // is the local coordinator's own id (the consumedBy / consumer).
        const result = await tokenManager.validateAndConsumeToken(
          authMsg.token,
          instanceId,
          authMsg.instanceId,
        );

        // Enforce role
        if (!acceptedRoles.includes(result.routing.role)) {
          logger.warn('Peer role mismatch', {
            peerInstanceId: authMsg.instanceId,
            accepted: acceptedRoles,
            actual: result.routing.role,
          });
          sendEncryptedMessage(ws, sessionKey, {
            type: 'peer.auth.response',
            accepted: false,
            instanceId,
            reason: 'Role mismatch',
          });
          recordFailedAuth(ip, authMsg.instanceId);
          ws.close(WS_CLOSE_UNAUTHORIZED, 'Role mismatch');
          return false;
        }

        // Generate session credential
        const credential = randomBytes(32).toString('hex');
        const credentialHash = sha256(credential);

        // Save credential to DB
        const saveResult = await credentialStore.save({
          instanceId: authMsg.instanceId,
          credentialHash,
          role: result.routing.role,
          routingKeys: [result.routing.routingKey],
          sourceTokenHash: result.keys.validationHash,
        });

        // A token-join issues a fresh credential and revokes the prior active
        // one for this instanceId. Because that credential is shared across the
        // joining orchestrator's sibling peer-clients, a revokedCount > 0 here
        // invalidates those siblings' in-flight proofs — log it so a
        // revoke-driven sibling cascade is visible.
        logger.info('Peer credential issued via token join', {
          peerInstanceId: authMsg.instanceId,
          trigger: 'token-join',
          revokedPriorCredentials: saveResult.revokedCount,
        });

        // Get local inventory for auth response
        const inventory = getLocalInventory();

        // Send auth response with credential, capabilities, and software version
        sendEncryptedMessage(ws, sessionKey, {
          type: 'peer.auth.response',
          accepted: true,
          sessionCredential: credential,
          role: result.routing.role,
          instanceId,
          softwareVersion: SOFTWARE_VERSION,
          agents: inventory.agents,
          scalerCapacity: inventory.scalerCapacity,
          capabilities: inventory.capabilities,
        });

        return true;
      } catch (err) {
        // Idempotent mesh-join recovery: when sibling peer-clients on the
        // same peer identity race on a single join token across a shared-DB
        // multi-coordinator mesh, only one wins the atomic claim in
        // validateAndConsumeToken and the rest hit "already been used".
        // The losers are not attackers — they are the same peer trying to
        // establish its other mesh WS connections. Verify that the peer
        // already owns a non-revoked credential whose source_token_hash
        // matches the presented token, and if so issue a fresh per-coord
        // credential without re-consuming the token. Anything else
        // (expired, unknown, parse errors, unknown instance,
        // sourceTokenHash mismatch) falls through to the original
        // rejection path so real replays still log the warning.
        if (isTokenAlreadyUsedError(err)) {
          try {
            const parsed = parseToken(authMsg.token);
            const presentedHash = deriveKeys(Buffer.from(parsed.secretHex, 'hex')).validationHash;
            const existing = await credentialStore.findByInstanceId(authMsg.instanceId);
            if (existing && !existing.revokedAt && existing.sourceTokenHash === presentedHash) {
              // Enforce role on the recovery path too
              if (!acceptedRoles.includes(parsed.routing.role)) {
                logger.warn('Peer role mismatch on token retry', {
                  peerInstanceId: authMsg.instanceId,
                  accepted: acceptedRoles,
                  actual: parsed.routing.role,
                });
                sendEncryptedMessage(ws, sessionKey, {
                  type: 'peer.auth.response',
                  accepted: false,
                  instanceId,
                  reason: 'Role mismatch',
                });
                recordFailedAuth(ip, authMsg.instanceId);
                ws.close(WS_CLOSE_UNAUTHORIZED, 'Role mismatch');
                return false;
              }

              const credential = randomBytes(32).toString('hex');
              const credentialHash = sha256(credential);
              const retrySave = await credentialStore.save({
                instanceId: authMsg.instanceId,
                credentialHash,
                role: parsed.routing.role,
                routingKeys: [parsed.routing.routingKey],
                sourceTokenHash: presentedHash,
              });

              logger.info('Peer idempotent token retry accepted', {
                peerInstanceId: authMsg.instanceId,
                sourceTokenHash: presentedHash,
                trigger: 'idempotent-token-retry',
                revokedPriorCredentials: retrySave.revokedCount,
              });

              const inventory = getLocalInventory();
              sendEncryptedMessage(ws, sessionKey, {
                type: 'peer.auth.response',
                accepted: true,
                sessionCredential: credential,
                role: parsed.routing.role,
                instanceId,
                softwareVersion: SOFTWARE_VERSION,
                agents: inventory.agents,
                scalerCapacity: inventory.scalerCapacity,
                capabilities: inventory.capabilities,
              });
              return true;
            }
          } catch (recoveryErr) {
            logger.warn('Peer token idempotent recovery failed', {
              peerInstanceId: authMsg.instanceId,
              error: toErrorMessage(recoveryErr),
            });
            // Fall through to rejection
          }
        }
        logger.warn('Peer token validation failed', {
          peerInstanceId: authMsg.instanceId,
          error: toErrorMessage(err),
        });
        sendEncryptedMessage(ws, sessionKey, {
          type: 'peer.auth.response',
          accepted: false,
          instanceId,
          reason: 'Invalid token',
        });
        recordFailedAuth(ip, authMsg.instanceId);
        ws.close(WS_CLOSE_UNAUTHORIZED, 'Invalid token');
        return false;
      }
    } else if (authMsg.proof) {
      // --- Credential-based auth (reconnection) ---
      const stored = await credentialStore.findByInstanceId(authMsg.instanceId);

      if (!stored) {
        // A peer presented an HMAC proof but no active credential row exists
        // for its instanceId — typically because a sibling/self token-join just
        // revoked the shared credential. The peer will delete its credential
        // file and fall back to its join token on reconnect.
        logger.warn('Peer credential not found', {
          peerInstanceId: authMsg.instanceId,
          authPath: 'credential-proof',
        });
        sendEncryptedMessage(ws, sessionKey, {
          type: 'peer.auth.response',
          accepted: false,
          instanceId,
          reason: 'Unknown credential',
        });
        recordFailedAuth(ip, authMsg.instanceId);
        ws.close(WS_CLOSE_UNAUTHORIZED, 'Unknown credential');
        return false;
      }

      if (stored.revokedAt) {
        logger.warn('Peer credential revoked', {
          peerInstanceId: authMsg.instanceId,
          authPath: 'credential-proof',
          revokedAt: stored.revokedAt.toISOString(),
        });
        sendEncryptedMessage(ws, sessionKey, {
          type: 'peer.auth.response',
          accepted: false,
          instanceId,
          reason: 'Credential revoked',
        });
        recordFailedAuth(ip, authMsg.instanceId);
        ws.close(WS_CLOSE_UNAUTHORIZED, 'Credential revoked');
        return false;
      }

      // HMAC proof verification:
      // proof = HMAC-SHA256(key=credentialHash_bytes, data=nonce_b64 + ':' + instanceId)
      const nonceB64 = nonce.toString('base64');
      const expectedProof = createHmac('sha256', Buffer.from(stored.credentialHash, 'hex'))
        .update(nonceB64 + ':' + authMsg.instanceId)
        .digest();

      const proofBuffer = Buffer.from(authMsg.proof, 'hex');

      if (
        proofBuffer.length !== expectedProof.length ||
        !timingSafeEqual(proofBuffer, expectedProof)
      ) {
        logger.warn('Peer HMAC proof invalid', {
          peerInstanceId: authMsg.instanceId,
          authPath: 'credential-proof',
        });
        sendEncryptedMessage(ws, sessionKey, {
          type: 'peer.auth.response',
          accepted: false,
          instanceId,
          reason: 'Invalid proof',
        });
        recordFailedAuth(ip, authMsg.instanceId);
        ws.close(WS_CLOSE_UNAUTHORIZED, 'Invalid proof');
        return false;
      }

      // Update last seen (track which coordinator validated)
      await credentialStore.updateLastSeen(stored.credentialHash, instanceId);

      // Get local inventory for auth response
      const inventory = getLocalInventory();

      // Send auth response with capabilities and software version
      sendEncryptedMessage(ws, sessionKey, {
        type: 'peer.auth.response',
        accepted: true,
        instanceId,
        softwareVersion: SOFTWARE_VERSION,
        agents: inventory.agents,
        scalerCapacity: inventory.scalerCapacity,
        capabilities: inventory.capabilities,
      });

      return true;
    } else {
      // Neither token nor proof provided
      logger.warn('Peer auth request missing token and proof', {
        peerInstanceId: authMsg.instanceId,
      });
      sendEncryptedMessage(ws, sessionKey, {
        type: 'peer.auth.response',
        accepted: false,
        instanceId,
        reason: 'Missing auth method',
      });
      recordFailedAuth(ip, authMsg.instanceId);
      ws.close(WS_CLOSE_UNAUTHORIZED, 'Missing auth method');
      return false;
    }
  }

  /**
   * Send a message to a connected peer by instanceId.
   * Returns false if peer is not connected via this handler.
   */
  function sendToPeer(targetInstanceId: string, msg: PeerToPeerMessage): boolean {
    const conn = connections.get(targetInstanceId);
    if (!conn || conn.ws.readyState !== 1 /* OPEN */) return false;
    sendEncryptedMessage(conn.ws, conn.sessionKey, msg);
    return true;
  }

  /**
   * Get the count of authenticated incoming peer connections.
   */
  function getConnectionCount(): number {
    return connections.size;
  }

  /**
   * Broadcast a heartbeat to all connected inbound peers.
   * Used by orchestrator-core for event-driven heartbeat broadcasts.
   */
  function broadcastHeartbeat(inventory: Omit<PeerHeartbeat, 'type'>): void {
    for (const conn of connections.values()) {
      if (conn.ws.readyState === 1 /* OPEN */) {
        sendEncryptedMessage(conn.ws, conn.sessionKey, {
          type: 'peer.heartbeat',
          ...inventory,
        } as PeerToPeerMessage);
      }
    }
  }

  /**
   * Broadcast a peer.agent-token.revoke notification to every connected
   * inbound peer. The originating orchestrator already kicked locally; this
   * fan-out closes the matching in-flight WS on every other peer.
   */
  function broadcastAgentTokenRevoke(msg: PeerAgentTokenRevoke): void {
    for (const conn of connections.values()) {
      if (conn.ws.readyState === 1 /* OPEN */) {
        sendEncryptedMessage(conn.ws, conn.sessionKey, msg);
      }
    }
  }

  /**
   * Send a job.reroute message via a server-side connection and wait for ACK.
   * Used by RunCoordinator for peers that connected TO this coordinator (incoming WS).
   *
   * @returns true if accepted, false if rejected or timeout
   */
  async function sendAndWaitAck(
    targetInstanceId: string,
    msg: JobReroute,
    timeoutMs: number = 10_000,
  ): Promise<boolean> {
    if (!sendToPeer(targetInstanceId, msg as PeerToPeerMessage)) return false;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        ackWaiters.delete(msg.messageId);
        resolve(false);
      }, timeoutMs);

      ackWaiters.set(msg.messageId, { resolve, timer });
    });
  }

  /**
   * Send a peer.config.reload to a peer connected via this handler (incoming
   * WS) and wait for the matching peer.config.reload.response.
   *
   * @returns The PeerConfigReloadResponse if delivered, or null if the peer
   *   is not connected via this handler. Resolves with `success=false` if the
   *   timeout elapses without a response.
   */
  async function sendConfigReloadAndWait(
    targetInstanceId: string,
    msg: PeerConfigReload,
    timeoutMs: number = 15_000,
  ): Promise<PeerConfigReloadResponse | null> {
    if (!sendToPeer(targetInstanceId, msg as PeerToPeerMessage)) return null;

    return new Promise<PeerConfigReloadResponse>((resolve) => {
      const timer = setTimeout(() => {
        configReloadWaiters.delete(msg.messageId);
        resolve({
          type: 'peer.config.reload.response',
          messageId: msg.messageId,
          success: false,
          errors: [`Config reload to peer ${targetInstanceId} timed out after ${timeoutMs}ms`],
        });
      }, timeoutMs);

      configReloadWaiters.set(msg.messageId, { resolve, timer });
    });
  }

  /**
   * Send a peer.logs.collect.request to a peer connected via this handler
   * (incoming WS) and await its reassembled subtree-bundle ZIP. Rejects on
   * timeout, an error frame, or peer disconnect.
   */
  function sendLogsCollectAndWait(
    targetInstanceId: string,
    msg: PeerLogsCollectRequest,
    timeoutMs: number,
  ): Promise<Buffer> {
    logsCollectTargets.set(msg.messageId, targetInstanceId);
    const promise = logsCollectWaiters
      .add(msg.messageId, timeoutMs)
      .finally(() => logsCollectTargets.delete(msg.messageId));
    if (!sendToPeer(targetInstanceId, msg as PeerToPeerMessage)) {
      logsCollectWaiters.onError(msg.messageId, `Peer ${targetInstanceId} not connected`);
    }
    return promise;
  }

  /** Reject any in-flight collect awaiting a subtree from the disconnected peer. */
  function rejectLogsCollectForPeer(targetInstanceId: string): void {
    for (const [messageId, target] of logsCollectTargets) {
      if (target === targetInstanceId) logsCollectWaiters.onError(messageId, 'peer disconnected');
    }
  }

  /**
   * Clean up rate limit maps and timers. Call on shutdown.
   */
  function cleanup(): void {
    clearInterval(rateLimitCleanupTimer);
    rateLimitsByIp.clear();
    rateLimitsByInstanceId.clear();
    for (const [, waiter] of configReloadWaiters) {
      clearTimeout(waiter.timer);
    }
    configReloadWaiters.clear();
    logsCollectWaiters.rejectAll('peer handler shutting down');
  }

  /**
   * Close all inbound peer WebSocket connections. Call this before stopping
   * the HTTP server during graceful shutdown, otherwise server.close() waits
   * indefinitely for upgraded WebSocket sockets to go idle — Node's
   * server.closeAllConnections() does NOT touch upgraded protocols (WS/HTTP2).
   * Leaving this out caused the 30s graceful shutdown timer to force-exit the
   * orchestrator with status=1 on every restart in the E2E HA chaos tests.
   */
  function closeAllInbound(): void {
    for (const [, conn] of connections) {
      try {
        if (conn.heartbeatTimer) {
          clearInterval(conn.heartbeatTimer);
          conn.heartbeatTimer = null;
        }
        conn.ws.close(1001, 'Server shutting down');
      } catch {
        // swallow per-connection errors — shutdown is best-effort
      }
    }
    connections.clear();
  }

  return {
    handleConnection,
    sendToPeer,
    sendAndWaitAck,
    sendConfigReloadAndWait,
    sendLogsCollectAndWait,
    getConnectionCount,
    broadcastHeartbeat,
    broadcastAgentTokenRevoke,
    cleanup,
    closeAllInbound,
  };
}
