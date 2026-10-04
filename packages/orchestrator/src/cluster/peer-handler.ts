/**
 * WebSocket handler for incoming peer connections from other orchestrators.
 *
 * Accepts WS upgrade, performs ECDH key exchange, and authenticates the peer
 * with mutual-v2: `peer.hello` advertises the scheme, the peer proves its
 * credential (or, on first join, its join token) with an HMAC over the
 * handshake transcript, and this server answers with its own proof and
 * switches to the application key. A join token never arrives here: the peer
 * sends the token's routing segment, and the role and routing key come from
 * the join_tokens row. A request in the scheme earlier releases used is refused
 * with PEER_MUTUAL_AUTH_REQUIRED_REASON. Registers the peer in PeerRegistry and
 * routes messages bidirectionally. Sends periodic heartbeats to the peer.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createLogger, sha256, toErrorMessage, ChunkRequestWaiter } from '@kici-dev/shared';
import {
  PEER_MUTUAL_AUTH_REQUIRED_REASON,
  PeerAuthMode,
  PeerAuthScheme,
  peerHelloResponseSchema,
  peerAuthRequestSchema,
  peerFromPeerMessageSchema,
  MIN_PROTOCOL_VERSION,
  WS_CLOSE_UNAUTHORIZED,
  WS_CLOSE_PROTOCOL_ERROR,
  WS_CLOSE_AUTH_TIMEOUT,
  WS_CLOSE_INVALID_MESSAGE,
  WS_CLOSE_PLAN_LIMIT,
  type PeerAuthRequest,
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
  type PeerScalerOrphansRequest,
  type PeerForgetRequest,
  type PeerForgetResponse,
  PeerForgetOutcome,
  type PeerScalerOrphansResponse,
  type PeerClusterSettingsRequest,
  type WorkerClusterSettings,
  type PeerLogsCollectRequest,
  type PeerLeaving,
  type PeerAgentTokenRevoke,
  type RaftVoteRequest,
  type RaftVoteResponse,
  type RaftAppendEntries,
} from '@kici-dev/engine';
import { PeerLinkDirection, type PeerRegistry } from './peer-registry.js';
import {
  PeerForgetWaiters,
  PEER_FORGET_COORDINATORS_ONLY,
  replyToPeerForgetRequest,
  type PEER_FORGET_TIMEOUT,
  type PeerForgetRequestHandler,
} from './peer-forget.js';
import {
  replyToScalerOrphansRequest,
  ScalerOrphansWaiters,
  SCALER_ORPHANS_COORDINATORS_ONLY_ERROR,
  type SCALER_ORPHANS_TIMEOUT,
  type ScalerOrphansRequestHandler,
} from './scaler-orphans-peer.js';
import {
  HANDSHAKE_NONCE_BYTES,
  computeClientProof,
  computeServerProof,
  decodeProof,
  deriveAppKey,
  generateEcdhKeyPair,
  deriveSessionKey,
  encryptMessage,
  decryptMessage,
  peerTranscriptHash,
  proofMatches,
} from './peer-crypto.js';
import type { PeerCredentialStore } from './peer-credentials.js';
import {
  decodeJoinRouting,
  isTokenAlreadyUsedError,
  ResolvedJoinTokenStatus,
  tokenFingerprint,
  type JoinRoutingClaim,
  type JoinTokenManager,
} from './join-token.js';
import { runDetached } from '../helpers/run-detached.js';

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
  /**
   * The Platform-pushed worker ceiling this coordinator enforces, or `null`
   * when none was ever received (admit worker joins freely). Read at each
   * worker-peer admission. Served from the persisted PlanHeadroomStore, so it
   * survives a Platform disconnect — the coordinator keeps enforcing the last
   * known ceiling rather than resetting to unlimited.
   */
  getWorkerCeiling?: () => Promise<number | null>;
  /** Heartbeat interval in ms. Default: 30000 (30s). */
  heartbeatIntervalMs?: number;
  /** Auth timeout in ms. Default: 15000 (15s). */
  authTimeoutMs?: number;
  /** Callback when a job reroute request is received from peer. */
  onJobReroute: (msg: JobReroute) => Promise<void>;
  /** Callback when a job progress update is received from peer. */
  onJobProgress: (msg: JobProgress, fromPeerId: string, reply: (m: JobProgressAck) => void) => void;
  /** Callback when a scaler provisioning event is forwarded by a worker peer. */
  onPeerScalerEvent?: (msg: PeerScalerEvent, fromPeerId: string) => void;
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
   * Callback when a peer.clusterSettings.request arrives from a DB-less worker.
   * Resolves the worker-relevant settings snapshot (async DB read) and the
   * current cluster_settings version; the result is sent back via
   * peer.clusterSettings.response. If undefined, requests are answered with the
   * config-default snapshot at version 0.
   */
  onPeerClusterSettingsRequest?: (
    msg: PeerClusterSettingsRequest,
  ) => Promise<{ version: number; settings: WorkerClusterSettings }>;
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
  /**
   * Answers a peer.scaler.orphans.request a coordinator forwarded to this node
   * (`kici-admin scaler orphans --target`). A request from a peer that is not
   * a coordinator is refused before it reaches the handler. If undefined,
   * requests are answered with ok=false.
   */
  onScalerOrphansRequest?: ScalerOrphansRequestHandler;
  /**
   * Forgets a departed peer a sibling coordinator forgot (`kici-admin peer
   * forget`). A request from a peer that is not a coordinator is refused. If
   * undefined, requests are answered with outcome `error`.
   */
  onPeerForgetRequest?: PeerForgetRequestHandler;
}

interface PeerConnection {
  peerInstanceId: string;
  ws: PeerWsLike;
  sessionKey: Buffer;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  /**
   * The role the peer's join token or credential carries. The registry keeps
   * the role the peer declares, which a worker could set to `coordinator`.
   */
  authenticatedRole: string;
}

/** The schemes this server lists in peer.hello, in order. */
export const ADVERTISED_PEER_AUTH_SCHEMES: readonly string[] = [PeerAuthScheme.enum['mutual-v2']];

/** Proof checks one token-mode request may cost: rows minted for one routing key in one millisecond. */
const MAX_TOKEN_CANDIDATES = 8;

/**
 * A peer.auth.request from a release before mutual authentication: it carries
 * a proof or a token, or names no scheme.
 */
export function isLegacyPeerAuthRequest(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  if (r.type !== 'peer.auth.request') return false;
  return 'proof' in r || 'token' in r || !('scheme' in r);
}

/** K_hs and TH of one connection's handshake. */
interface HandshakeState {
  handshakeKey: Buffer;
  transcriptHash: Buffer;
}

/** An accepted authentication. */
interface AcceptedAuth {
  /** The role the credential row or join-token row carries. */
  role: string;
  /** K_app: every frame after the acceptance. */
  appKey: Buffer;
}

/** A join-token row a token-mode peer proved, claimed for this peer. */
interface TokenGrant {
  role: 'coordinator' | 'worker';
  routingKey: string;
  trigger: 'token-join' | 'idempotent-token-retry';
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
/**
 * Whether a joining peer may be admitted against the plan ceiling.
 *
 * Only workers are gated: a coordinator peer holds its own Platform connection
 * and is counted there, and a peer advertising no role registers as a
 * coordinator (see PeerRegistry.addPeer), so neither is gated here. A `null`
 * ceiling — none ever received — admits freely. The ceiling is ABSOLUTE, so the
 * join is admitted only while the currently-connected worker count is below it.
 */
export function shouldAdmitWorker(
  role: string | undefined,
  ceiling: number | null,
  connectedWorkerCount: number,
): boolean {
  if (role !== 'worker') return true;
  if (ceiling === null) return true;
  return connectedWorkerCount < ceiling;
}

export function createPeerHandler(deps: PeerHandlerDeps) {
  const {
    tokenManager,
    credentialStore,
    acceptedRoles = ['coordinator', 'worker'],
    instanceId,
    peerRegistry,
    getLocalInventory,
    getWorkerCeiling,
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
    onPeerClusterSettingsRequest,
    onLogsCollectRequest,
    onScalerOrphansRequest,
    onPeerForgetRequest,
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

  /** Scaler orphan response waiters (server-side connections). */
  const scalerOrphansWaiters = new ScalerOrphansWaiters();
  /** Peer forget response waiters (server-side connections). */
  const peerForgetWaiters = new PeerForgetWaiters();

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
   * Gate a worker join against the Platform-pushed ceiling, before the
   * `accepted: true` response. Returns true when the join may proceed. A plan
   * rejection is NOT an auth failure, so it does not call recordFailedAuth and
   * must not consume the peer's rate-limit budget.
   */
  async function admitWorkerOrReject(
    role: string | undefined,
    ws: PeerWsLike,
    sessionKey: Buffer,
    peerInstanceId: string,
  ): Promise<boolean> {
    if (role !== 'worker') return true;
    const ceiling = getWorkerCeiling ? await getWorkerCeiling() : null;
    const connected = peerRegistry.getConnectedWorkerPeers().length;
    if (shouldAdmitWorker(role, ceiling, connected)) return true;

    const reason = `Plan limit: this organization allows ${(ceiling ?? 0) + 1} orchestrator(s), coordinators and workers combined`;
    logger.warn('Worker join refused by plan ceiling', {
      peerInstanceId,
      connected,
      ceiling,
    });
    sendEncryptedMessage(ws, sessionKey, {
      type: 'peer.auth.response',
      accepted: false,
      instanceId,
      reason,
    });
    ws.close(WS_CLOSE_PLAN_LIMIT, reason);
    return false;
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
    peerRegistry.setAuthScheme(conn.peerInstanceId, PeerLinkDirection.Inbound, null);
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
        onJobProgress(msg, conn.peerInstanceId, (out) =>
          sendEncryptedMessage(conn.ws, conn.sessionKey, out),
        );
        break;
      }

      case 'scaler.event': {
        onPeerScalerEvent?.(msg, conn.peerInstanceId);
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

      case 'peer.scaler.orphans.request': {
        const send = (response: PeerScalerOrphansResponse): void => {
          sendEncryptedMessage(conn.ws, conn.sessionKey, response);
        };
        // Only a coordinator forwards an operator's request: a worker never
        // needs to list or stop another node's VMs. The role is the one the
        // peer's credential carries, not the one it declares.
        if (conn.authenticatedRole !== 'coordinator') {
          logger.warn('Refused a scaler orphan request from a peer that is not a coordinator', {
            peerId: conn.peerInstanceId,
            role: conn.authenticatedRole,
            declaredRole: peerRegistry.getPeer(conn.peerInstanceId)?.role ?? 'unknown',
          });
          send({
            type: 'peer.scaler.orphans.response',
            messageId: msg.messageId,
            ok: false,
            error: SCALER_ORPHANS_COORDINATORS_ONLY_ERROR,
          });
          break;
        }
        replyToScalerOrphansRequest(msg, onScalerOrphansRequest, send, {
          peerId: conn.peerInstanceId,
        });
        break;
      }

      case 'peer.scaler.orphans.response': {
        scalerOrphansWaiters.resolve(msg);
        break;
      }

      case 'peer.forget.request': {
        const reply = (outcome: PeerForgetOutcome, detail: string): void => {
          sendEncryptedMessage(conn.ws, conn.sessionKey, {
            type: 'peer.forget.response',
            messageId: msg.messageId,
            outcome,
            detail,
          });
        };
        // Only a coordinator forwards an operator's forget, and the role is the
        // one the peer's credential carries.
        if (conn.authenticatedRole !== 'coordinator') {
          logger.warn('Refused a peer forget request from a peer that is not a coordinator', {
            peerId: conn.peerInstanceId,
            role: conn.authenticatedRole,
          });
          reply(PeerForgetOutcome.enum.error, PEER_FORGET_COORDINATORS_ONLY);
          break;
        }
        replyToPeerForgetRequest(
          msg,
          onPeerForgetRequest,
          (response) => {
            sendEncryptedMessage(conn.ws, conn.sessionKey, response);
          },
          { peerId: conn.peerInstanceId },
        );
        break;
      }

      case 'peer.forget.response': {
        peerForgetWaiters.resolve(msg);
        break;
      }

      case 'peer.clusterSettings.request': {
        // A DB-less worker pulls the worker-settings snapshot from a coordinator.
        // A peer with no handler (not a DB-backed coordinator) does not
        // reply — the worker times out and keeps its boot-time config default,
        // never a poisoned zero snapshot.
        if (!onPeerClusterSettingsRequest) break;
        const replyMessageId = msg.messageId;
        onPeerClusterSettingsRequest(msg)
          .then((resolved) => {
            sendEncryptedMessage(conn.ws, conn.sessionKey, {
              type: 'peer.clusterSettings.response',
              messageId: replyMessageId,
              ...resolved,
            });
          })
          .catch((err) => {
            logger.error('Error resolving peer cluster-settings request', {
              peerId: conn.peerInstanceId,
              error: toErrorMessage(err),
            });
          });
        break;
      }

      case 'peer.logs.collect.request': {
        runDetached(
          logger,
          'Peer logs collect request',
          () =>
            onLogsCollectRequest?.(msg, (out) => {
              sendEncryptedMessage(conn.ws, conn.sessionKey, out);
              return true;
            }),
          { messageType: msg.type, peerId: conn.peerInstanceId },
        );
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
    let closed = false;
    let authInFlight = false;
    let peerInstanceId: string | null = null;
    let sessionKey: Buffer | null = null;
    let hs: HandshakeState | null = null;
    /** This socket's connection once authenticated; a reconnect replaces it in `connections`. */
    let ownConn: PeerConnection | null = null;

    // Auth timeout: close if not authenticated within threshold
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        logger.warn('Peer auth timeout, closing connection');
        ws.close(WS_CLOSE_AUTH_TIMEOUT, 'Auth timeout');
      }
    }, authTimeoutMs);

    const fail = (code: number, reason: string): void => {
      closed = true;
      ws.close(code, reason);
      clearTimeout(authTimer);
    };

    // --- Step 1: ECDH handshake, advertising the schemes this server accepts ---
    const ecdh = generateEcdhKeyPair();
    const nonce = randomBytes(HANDSHAKE_NONCE_BYTES);

    sendPlainMessage(ws, {
      type: 'peer.hello',
      ephemeralPublicKey: ecdh.publicKey.toString('base64'),
      nonce: nonce.toString('base64'),
      authSchemes: ADVERTISED_PEER_AUTH_SCHEMES,
    });

    ws.on('message', (data: unknown) => {
      const raw = typeof data === 'string' ? data : String(data);

      if (!hs) {
        // --- Waiting for peer.hello.response (plaintext) ---
        hs = readHelloResponse(raw, ecdh, nonce, fail);
        return;
      }

      if (!authenticated) {
        // --- Waiting for peer.auth.request (under K_hs) ---
        if (authInFlight) {
          logger.warn('Peer sent a frame while its authentication was in flight', { ip });
          fail(WS_CLOSE_INVALID_MESSAGE, 'Frame during authentication');
          return;
        }
        const handshake = hs;
        const authMsg = readAuthRequest(ws, handshake, raw, ip, fail);
        if (!authMsg) return;

        authInFlight = true;
        handleAuth(ws, handshake, authMsg, ip)
          .then((accepted) => {
            authInFlight = false;
            if (accepted === null || closed) return;

            authenticated = true;
            peerInstanceId = authMsg.instanceId;
            sessionKey = accepted.appKey;
            clearTimeout(authTimer);
            ownConn = registerInboundPeer(ws, authMsg, accepted);
          })
          .catch((err) => {
            authInFlight = false;
            logger.error('Unexpected error during auth handling', {
              error: toErrorMessage(err),
            });
            fail(WS_CLOSE_UNAUTHORIZED, 'Auth error');
          });

        return;
      }

      // --- Authenticated: decrypt under K_app and route ---
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
      closed = true;
      clearTimeout(authTimer);

      if (peerInstanceId && ownConn) {
        logger.info('Peer disconnected', { peerInstanceId });
        if (ownConn.heartbeatTimer) {
          clearInterval(ownConn.heartbeatTimer);
          ownConn.heartbeatTimer = null;
        }
        // A peer that reconnected while this socket was still open owns the
        // entry now: only this socket's own connection is cleaned up.
        if (connections.get(peerInstanceId) === ownConn) {
          rejectLogsCollectForPeer(peerInstanceId);
          cleanupConnection(ownConn);
        }
      }
    });

    ws.on('error', (err: unknown) => {
      logger.error('Peer connection error', {
        error: toErrorMessage(err),
      });
    });
  }

  /** The peer's plaintext hello.response: derive K_hs and the transcript hash, or close. */
  function readHelloResponse(
    raw: string,
    ecdh: ReturnType<typeof generateEcdhKeyPair>,
    nonce: Buffer,
    fail: (code: number, reason: string) => void,
  ): HandshakeState | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn('Malformed JSON during ECDH handshake');
      return null;
    }

    const helloResp = peerHelloResponseSchema.safeParse(parsed);
    if (!helloResp.success) {
      logger.warn('Expected peer.hello.response, got invalid message');
      fail(WS_CLOSE_INVALID_MESSAGE, 'Expected hello response');
      return null;
    }

    const clientPub = Buffer.from(helloResp.data.ephemeralPublicKey, 'base64');
    try {
      return {
        handshakeKey: deriveSessionKey(ecdh.privateKey, clientPub, nonce),
        transcriptHash: peerTranscriptHash({
          serverEphemeralPublicKey: ecdh.publicKey,
          serverNonce: nonce,
          authSchemes: ADVERTISED_PEER_AUTH_SCHEMES,
          clientEphemeralPublicKey: clientPub,
        }),
      };
    } catch (err) {
      logger.warn('ECDH key derivation failed', { error: toErrorMessage(err) });
      fail(WS_CLOSE_INVALID_MESSAGE, 'Key derivation failed');
      return null;
    }
  }

  /**
   * The encrypted peer.auth.request, or null after closing the connection. A
   * request in the scheme earlier releases used is refused with
   * PEER_MUTUAL_AUTH_REQUIRED_REASON, which is not a failed authentication: an
   * old peer connects as soon as it is upgraded.
   */
  function readAuthRequest(
    ws: PeerWsLike,
    hs: HandshakeState,
    raw: string,
    ip: string,
    fail: (code: number, reason: string) => void,
  ): PeerAuthRequest | null {
    let decrypted: string;
    try {
      decrypted = decryptMessage(raw, hs.handshakeKey);
    } catch (err) {
      logger.warn('Failed to decrypt auth request', { error: toErrorMessage(err) });
      recordFailedAuth(ip);
      fail(WS_CLOSE_UNAUTHORIZED, 'Decryption failed');
      return null;
    }

    let authParsed: unknown;
    try {
      authParsed = JSON.parse(decrypted);
    } catch {
      logger.warn('Malformed JSON in decrypted auth request');
      fail(WS_CLOSE_INVALID_MESSAGE, 'Invalid auth format');
      return null;
    }

    if (isLegacyPeerAuthRequest(authParsed)) {
      const legacyId = (authParsed as { instanceId?: unknown }).instanceId;
      logger.warn(
        'Peer used an authentication scheme this release no longer accepts; upgrade every orchestrator in the cluster',
        { peerInstanceId: typeof legacyId === 'string' ? legacyId : null, ip },
      );
      sendEncryptedMessage(ws, hs.handshakeKey, {
        type: 'peer.auth.response',
        accepted: false,
        instanceId,
        reason: PEER_MUTUAL_AUTH_REQUIRED_REASON,
      });
      fail(WS_CLOSE_PROTOCOL_ERROR, PEER_MUTUAL_AUTH_REQUIRED_REASON);
      return null;
    }

    const authMsg = peerAuthRequestSchema.safeParse(authParsed);
    if (!authMsg.success) {
      logger.warn('Invalid peer.auth.request format', { errors: authMsg.error.issues });
      fail(WS_CLOSE_INVALID_MESSAGE, 'Invalid auth request');
      return null;
    }
    return authMsg.data;
  }

  /** Register an authenticated inbound peer and start its heartbeats under K_app. */
  function registerInboundPeer(
    ws: PeerWsLike,
    authMsg: PeerAuthRequest,
    accepted: AcceptedAuth,
  ): PeerConnection {
    const peerInstanceId = authMsg.instanceId;
    logger.info('Peer authenticated', { peerInstanceId });

    peerRegistry.addPeer({
      instanceId: peerInstanceId,
      connectionId: randomUUID(),
      address: null, // incoming connections don't have a known address
      routingKeys: [],
      role: authMsg.role,
    });
    peerRegistry.setAuthScheme(
      peerInstanceId,
      PeerLinkDirection.Inbound,
      PeerAuthScheme.enum['mutual-v2'],
    );

    // Send immediate heartbeat so peer has our full state
    const inventory = getLocalInventory();
    sendEncryptedMessage(ws, accepted.appKey, {
      type: 'peer.heartbeat',
      ...inventory,
    });

    const conn: PeerConnection = {
      peerInstanceId,
      ws,
      sessionKey: accepted.appKey,
      heartbeatTimer: null,
      authenticatedRole: accepted.role,
    };
    connections.set(peerInstanceId, conn);
    startHeartbeat(conn);
    return conn;
  }

  /** Refuse an authentication attempt; it counts against the rate limits. */
  function rejectAuth(
    ws: PeerWsLike,
    hs: HandshakeState,
    reason: string,
    ip: string,
    peerInstanceId: string,
  ): null {
    sendEncryptedMessage(ws, hs.handshakeKey, {
      type: 'peer.auth.response',
      accepted: false,
      instanceId,
      reason,
    });
    recordFailedAuth(ip, peerInstanceId);
    ws.close(WS_CLOSE_UNAUTHORIZED, reason);
    return null;
  }

  /** Answer an accepted peer with the server proof, and derive K_app. */
  function acceptAuth(
    ws: PeerWsLike,
    hs: HandshakeState,
    args: {
      psk: Buffer;
      clientProof: Buffer;
      grantedRole: string;
      sessionCredential: string | null;
    },
  ): AcceptedAuth {
    const serverProof = computeServerProof({
      psk: args.psk,
      transcriptHash: hs.transcriptHash,
      clientProof: args.clientProof,
      serverInstanceId: instanceId,
      grantedRole: args.grantedRole,
      sessionCredential: args.sessionCredential,
    });
    const inventory = getLocalInventory();
    sendEncryptedMessage(ws, hs.handshakeKey, {
      type: 'peer.auth.response',
      accepted: true,
      instanceId,
      role: args.grantedRole,
      serverProof: serverProof.toString('hex'),
      ...(args.sessionCredential !== null && { sessionCredential: args.sessionCredential }),
      softwareVersion: SOFTWARE_VERSION,
      agents: inventory.agents,
      scalerCapacity: inventory.scalerCapacity,
      capabilities: inventory.capabilities,
    });
    return {
      role: args.grantedRole,
      appKey: deriveAppKey({
        handshakeKey: hs.handshakeKey,
        psk: args.psk,
        transcriptHash: hs.transcriptHash,
        clientProof: args.clientProof,
        serverProof,
      }),
    };
  }

  /**
   * Validate a mutual-v2 auth request. Returns the accepted role and K_app, or
   * null when the request is rejected. The role the peer declares is bound
   * into its proof but not trusted; the accepted role comes from the
   * credential row or the join-token row.
   */
  async function handleAuth(
    ws: PeerWsLike,
    hs: HandshakeState,
    authMsg: PeerAuthRequest,
    ip: string,
  ): Promise<AcceptedAuth | null> {
    // Protocol version check (minimum-version semantics: future versions accepted)
    if (authMsg.protocolVersion < MIN_PROTOCOL_VERSION) {
      logger.warn('Peer protocol version below minimum', {
        peerInstanceId: authMsg.instanceId,
        received: authMsg.protocolVersion,
        minimum: MIN_PROTOCOL_VERSION,
      });
      sendEncryptedMessage(ws, hs.handshakeKey, {
        type: 'peer.auth.response',
        accepted: false,
        instanceId,
        reason: `Unsupported protocol version: ${authMsg.protocolVersion} < ${MIN_PROTOCOL_VERSION}`,
        softwareVersion: SOFTWARE_VERSION,
      });
      recordFailedAuth(ip, authMsg.instanceId);
      ws.close(WS_CLOSE_PROTOCOL_ERROR, 'Unsupported protocol version');
      return null;
    }

    if (authMsg.softwareVersion) {
      logger.info('Peer software version', {
        peerInstanceId: authMsg.instanceId,
        localVersion: SOFTWARE_VERSION,
        remoteVersion: authMsg.softwareVersion,
      });
    }

    const clientProof = decodeProof(authMsg.clientProof);
    if (!clientProof) return rejectAuth(ws, hs, 'Invalid proof', ip, authMsg.instanceId);
    return authMsg.mode === PeerAuthMode.enum.token
      ? authenticateToken(ws, hs, authMsg, clientProof, ip)
      : authenticateCredential(ws, hs, authMsg, clientProof, ip);
  }

  /** The client proof this request must carry for a given PSK. */
  function expectedClientProof(
    hs: HandshakeState,
    authMsg: PeerAuthRequest,
    psk: Buffer,
    tokenRouting: string,
  ): Buffer {
    return computeClientProof({
      psk,
      transcriptHash: hs.transcriptHash,
      mode: authMsg.mode,
      clientInstanceId: authMsg.instanceId,
      role: authMsg.role ?? '',
      protocolVersion: authMsg.protocolVersion,
      tokenRouting,
    });
  }

  /** Credential mode: the PSK is the stored credential hash for the peer's instance id. */
  async function authenticateCredential(
    ws: PeerWsLike,
    hs: HandshakeState,
    authMsg: PeerAuthRequest,
    clientProof: Buffer,
    ip: string,
  ): Promise<AcceptedAuth | null> {
    const stored = await credentialStore.findByInstanceId(authMsg.instanceId);
    if (!stored) {
      // No active credential row exists for this instanceId: a sibling/self
      // token-join revoked the shared credential, the credential expired, or
      // the peer's row lives in another cluster's database. The peer deletes
      // its credential file and falls back to its join token, or, for a
      // coordinator without one, issues itself a new credential unless an
      // operator revoked it.
      logger.warn('Peer credential not found', {
        peerInstanceId: authMsg.instanceId,
        authPath: 'credential-proof',
      });
      return rejectAuth(ws, hs, 'Unknown credential', ip, authMsg.instanceId);
    }

    if (stored.revokedAt) {
      logger.warn('Peer credential revoked', {
        peerInstanceId: authMsg.instanceId,
        authPath: 'credential-proof',
        revokedAt: stored.revokedAt.toISOString(),
      });
      return rejectAuth(ws, hs, 'Credential revoked', ip, authMsg.instanceId);
    }

    const psk = Buffer.from(stored.credentialHash, 'hex');
    if (!proofMatches(expectedClientProof(hs, authMsg, psk, ''), clientProof)) {
      logger.warn('Peer credential proof invalid', {
        peerInstanceId: authMsg.instanceId,
        authPath: 'credential-proof',
      });
      return rejectAuth(ws, hs, 'Invalid proof', ip, authMsg.instanceId);
    }

    // Update last seen (track which coordinator validated)
    await credentialStore.updateLastSeen(stored.credentialHash, instanceId);

    // Gate a worker join against the plan ceiling before accepting.
    if (!(await admitWorkerOrReject(stored.role, ws, hs.handshakeKey, authMsg.instanceId))) {
      return null;
    }
    return acceptAuth(ws, hs, {
      psk,
      clientProof,
      grantedRole: stored.role,
      sessionCredential: null,
    });
  }

  /**
   * Token mode: the peer sends its token's routing segment, never the token.
   * The routing fields select candidate rows, the proof selects the row (its
   * token hash is the PSK), and the role and routing key come from that row.
   */
  async function authenticateToken(
    ws: PeerWsLike,
    hs: HandshakeState,
    authMsg: PeerAuthRequest,
    clientProof: Buffer,
    ip: string,
  ): Promise<AcceptedAuth | null> {
    const routingB64 = authMsg.tokenRouting;
    if (!routingB64) return rejectAuth(ws, hs, 'Invalid token', ip, authMsg.instanceId);
    let claimedRouting: JoinRoutingClaim;
    try {
      claimedRouting = decodeJoinRouting(routingB64);
    } catch {
      return rejectAuth(ws, hs, 'Invalid token', ip, authMsg.instanceId);
    }

    let checked = 0;
    const resolved = await tokenManager.resolveLiveTokenByRouting(claimedRouting, (tokenHash) => {
      checked += 1;
      if (checked > MAX_TOKEN_CANDIDATES) return false;
      return proofMatches(
        expectedClientProof(hs, authMsg, Buffer.from(tokenHash, 'hex'), routingB64),
        clientProof,
      );
    });
    if (resolved.status !== ResolvedJoinTokenStatus.enum.live) {
      logger.warn('Peer token proof matched no live join token', {
        peerInstanceId: authMsg.instanceId,
        status: resolved.status,
      });
      return rejectAuth(ws, hs, 'Invalid token', ip, authMsg.instanceId);
    }

    const grant = await claimTokenGrant(resolved.tokenHash, authMsg.instanceId);
    if (!grant) return rejectAuth(ws, hs, 'Invalid token', ip, authMsg.instanceId);
    if (!acceptedRoles.includes(grant.role)) {
      logger.warn('Peer role mismatch', {
        peerInstanceId: authMsg.instanceId,
        accepted: acceptedRoles,
        actual: grant.role,
        trigger: grant.trigger,
      });
      return rejectAuth(ws, hs, 'Role mismatch', ip, authMsg.instanceId);
    }

    const credential = randomBytes(32).toString('hex');
    const saveResult = await credentialStore.save({
      instanceId: authMsg.instanceId,
      credentialHash: sha256(credential),
      role: grant.role,
      routingKeys: [grant.routingKey],
      sourceTokenHash: resolved.tokenHash,
    });

    // A token-join issues a fresh credential and revokes the prior active one
    // for this instanceId. Because that credential is shared across the
    // joining orchestrator's sibling peer-clients, a revokedCount > 0 here
    // invalidates those siblings' in-flight proofs — log it so a
    // revoke-driven sibling cascade is visible.
    logger.info(
      grant.trigger === 'token-join'
        ? 'Peer credential issued via token join'
        : 'Peer idempotent token retry accepted',
      {
        peerInstanceId: authMsg.instanceId,
        trigger: grant.trigger,
        tokenFingerprint: tokenFingerprint(resolved.tokenHash),
        revokedPriorCredentials: saveResult.revokedCount,
      },
    );

    // Gate a worker join against the plan ceiling before accepting.
    if (!(await admitWorkerOrReject(grant.role, ws, hs.handshakeKey, authMsg.instanceId))) {
      return null;
    }
    return acceptAuth(ws, hs, {
      psk: Buffer.from(resolved.tokenHash, 'hex'),
      clientProof,
      grantedRole: grant.role,
      sessionCredential: credential,
    });
  }

  /**
   * Claim the token row, or recover a sibling client's retry on a token this
   * peer already consumed. Role and routing key always come from the row.
   */
  async function claimTokenGrant(
    tokenHash: string,
    peerInstanceId: string,
  ): Promise<TokenGrant | null> {
    try {
      // Atomic claim: one UPDATE..WHERE consumed_at IS NULL wins across the
      // shared-DB mesh, so multiple coordinators never each issue a credential
      // for the same instanceId off one join token. The joining peer's
      // instanceId is recorded as consumed_by_instance, so the same peer can
      // prove its still-valid token again after losing its credential and
      // self-heal without a redeploy. `instanceId` is this coordinator's id.
      const row = await tokenManager.claimByHash(tokenHash, instanceId, peerInstanceId);
      return { role: row.role, routingKey: row.routing.routingKey, trigger: 'token-join' };
    } catch (err) {
      if (!isTokenAlreadyUsedError(err)) {
        logger.warn('Peer token validation failed', {
          peerInstanceId,
          tokenFingerprint: tokenFingerprint(tokenHash),
          error: toErrorMessage(err),
        });
        return null;
      }
    }
    // Idempotent mesh-join recovery: sibling peer-clients of one joining peer
    // race on its token, and only one wins the claim. The losers are the same
    // peer establishing its other mesh connections, so they get a fresh
    // credential when the peer already owns an unrevoked one issued from this
    // token. Anything else falls through to the rejection.
    const existing = await credentialStore.findByInstanceId(peerInstanceId);
    if (!existing || existing.revokedAt || existing.sourceTokenHash !== tokenHash) {
      logger.warn('Peer token was already used by another instance', {
        peerInstanceId,
        tokenFingerprint: tokenFingerprint(tokenHash),
      });
      return null;
    }
    const row = await tokenManager.readByHash(tokenHash);
    if (!row) return null;
    return {
      role: row.role,
      routingKey: row.routing.routingKey,
      trigger: 'idempotent-token-retry',
    };
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
   * Close a connected peer's socket by instanceId. Used by worker eviction to
   * disconnect a drained worker. No-op if the peer holds no connection here.
   */
  function closePeer(targetInstanceId: string, code: number, reason: string): void {
    const conn = connections.get(targetInstanceId);
    if (!conn) return;
    conn.ws.close(code, reason);
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
   * Send a peer.forget.request to a peer connected via this handler and wait
   * for the matching response.
   *
   * @returns the response; null when the peer is not connected via this
   *   handler; `'timeout'` when no response arrived within `timeoutMs`.
   */
  async function sendPeerForgetAndWait(
    targetInstanceId: string,
    msg: PeerForgetRequest,
    timeoutMs: number,
  ): Promise<PeerForgetResponse | null | typeof PEER_FORGET_TIMEOUT> {
    if (!sendToPeer(targetInstanceId, msg as PeerToPeerMessage)) return null;
    return peerForgetWaiters.wait(msg.messageId, timeoutMs);
  }

  /**
   * Send a peer.scaler.orphans.request to a peer connected via this handler
   * (incoming WS) and wait for the matching response.
   *
   * @returns the response; null when the peer is not connected via this
   *   handler; `'timeout'` when no response arrived within `timeoutMs`.
   */
  async function sendScalerOrphansAndWait(
    targetInstanceId: string,
    msg: PeerScalerOrphansRequest,
    timeoutMs: number,
  ): Promise<PeerScalerOrphansResponse | null | typeof SCALER_ORPHANS_TIMEOUT> {
    if (!sendToPeer(targetInstanceId, msg as PeerToPeerMessage)) return null;
    return scalerOrphansWaiters.wait(msg.messageId, timeoutMs);
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
    scalerOrphansWaiters.rejectAll('peer handler shutting down');
    peerForgetWaiters.rejectAll('peer handler shutting down');
    logsCollectWaiters.rejectAll('peer handler shutting down');
  }

  /**
   * Close all inbound peer WebSocket connections. Call this before stopping
   * the HTTP server during graceful shutdown, otherwise server.close() waits
   * indefinitely for upgraded WebSocket sockets to go idle — Node's
   * server.closeAllConnections() does NOT touch upgraded protocols (WS/HTTP2).
   * Without it, the 30s graceful shutdown timer force-exits the orchestrator
   * with status=1 on every restart while peers are connected.
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
    closePeer,
    sendAndWaitAck,
    sendConfigReloadAndWait,
    sendScalerOrphansAndWait,
    sendPeerForgetAndWait,
    sendLogsCollectAndWait,
    getConnectionCount,
    broadcastHeartbeat,
    broadcastAgentTokenRevoke,
    cleanup,
    closeAllInbound,
  };
}
