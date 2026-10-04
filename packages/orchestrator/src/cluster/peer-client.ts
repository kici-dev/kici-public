/**
 * WebSocket client for outgoing peer-to-peer connections between orchestrators.
 *
 * Follows PlatformClient patterns closely:
 * - State machine: disconnected -> connecting -> handshaking -> authenticating -> connected
 * - Exponential backoff with jitter for reconnection
 * - Periodic heartbeat (30s default)
 * - Intentional disconnect flag to prevent reconnection
 *
 * Authentication is mutual-v2: after the ECDH key exchange the client proves
 * its credential (or, on first join, its join token) with an HMAC over the
 * handshake transcript, and accepts nothing until the server proves it holds
 * the same credential or token. The join token never leaves this host. Every
 * frame after acceptance uses an application key that needs the shared secret.
 * A server that does not offer mutual-v2 gets no proof at all.
 */

import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import {
  createLogger,
  getReconnectDelay,
  sha256,
  toErrorMessage,
  ChunkRequestWaiter,
} from '@kici-dev/shared';
import {
  PeerAuthMode,
  PeerAuthScheme,
  peerHelloSchema,
  peerFromPeerMessageSchema,
  WS_CLOSE_PROTOCOL_ERROR,
  WS_CLOSE_UNAUTHORIZED,
  WS_MAX_PAYLOAD_BYTES,
  type PeerAuthResponse,
  type PeerHeartbeat,
  type PeerToPeerMessage,
  type JobReroute,
  type JobProgress,
  type JobProgressAck,
  type PeerJobCancel,
  type PeerLogChunk,
  type PeerCacheUploadRequest,
  type PeerCacheUploadResponse,
  type PeerConfigReload,
  type PeerConfigReloadResponse,
  type PeerScalerOrphansRequest,
  type PeerForgetRequest,
  type PeerForgetResponse,
  type PeerScalerOrphansResponse,
  type PeerClusterSettingsRequest,
  type PeerClusterSettingsResponse,
  type PeerLogsCollectRequest,
  type PeerLeaving,
  type PeerAgentTokenRevoke,
  type RaftVoteRequest,
  type RaftVoteResponse,
  type RaftAppendEntries,
  PROTOCOL_VERSION,
} from '@kici-dev/engine';
import { PeerLinkDirection, type PeerRegistry } from './peer-registry.js';
import {
  PeerForgetWaiters,
  replyToPeerForgetRequest,
  type PEER_FORGET_TIMEOUT,
  type PeerForgetRequestHandler,
} from './peer-forget.js';
import {
  replyToScalerOrphansRequest,
  ScalerOrphansWaiters,
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
import { parseToken, tokenHashOf } from './join-token.js';
import type { CredentialFileData } from './peer-credentials.js';
import type { PeerAuthCoordinator } from './peer-auth-coordinator.js';
import { runDetached } from '../helpers/run-detached.js';

const logger = createLogger({ prefix: 'peer-client' });

/** Logged when this instance has neither a credential file nor a join token. */
export const NO_AUTH_METHOD_MESSAGE =
  'No peer auth method: this instance has no credential file and no join token';

const NO_AUTH_METHOD_REMEDY =
  'A coordinator issues its own credential unless an operator revoked it; a worker needs KICI_CLUSTER_JOIN_TOKEN';

/** Logged when a dialled server does not offer mutual authentication. */
export const PEER_MUTUAL_AUTH_UNSUPPORTED_MESSAGE =
  'Peer does not support mutual authentication; upgrade every orchestrator in the cluster';

/** The default for `handshakeTimeoutMs`, matching the server's own authentication timeout. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;

/** Where the address this client dials came from. */
export enum PeerDialOrigin {
  /** KICI_CLUSTER_PEERS or a worker's coordinator URLs: reconnects with backoff. */
  Static = 'static',
  /** A Platform announcement: a hint, dropped for good when mutual authentication fails. */
  Discovered = 'discovered',
}

/** Why a server failed mutual authentication. */
export enum PeerMutualAuthFailure {
  SchemeMissing = 'scheme-missing',
  ServerProofInvalid = 'server-proof-invalid',
  InstanceIdMissing = 'instance-id-missing',
  InstanceIdMismatch = 'instance-id-mismatch',
}

/** K_hs and TH of the handshake in flight. */
interface HandshakeState {
  handshakeKey: Buffer;
  transcriptHash: Buffer;
}

/** What this connection proved with, kept until the server's proof is checked. */
interface PendingProof {
  psk: Buffer;
  clientProof: Buffer;
  mode: PeerAuthMode;
}

// Software version injected at build time by scripts/build-service.mjs.
declare const KICI_PKG_VERSION: string;
const SOFTWARE_VERSION = typeof KICI_PKG_VERSION !== 'undefined' ? KICI_PKG_VERSION : '0.0.0';

type PeerConnectionState =
  'disconnected' | 'connecting' | 'handshaking' | 'authenticating' | 'connected';

export interface PeerClientOptions {
  /** WebSocket URL of the remote peer orchestrator. */
  url: string;
  /** Join token for first-time cluster join (optional if credential file exists). */
  joinToken?: string;
  /** Path to the credential file for reconnection. */
  credentialFile: string;
  /** Shared per-orchestrator coordinator that owns the credential file. */
  authCoordinator: PeerAuthCoordinator;
  /** This orchestrator's instance ID. */
  instanceId: string;
  /** Peer registry to update on heartbeats from remote peer. */
  peerRegistry: PeerRegistry;
  /**
   * Where the dialled address came from. A static target reconnects with
   * backoff after any failure; a discovered target that fails mutual
   * authentication is dropped. Default: static.
   */
  origin?: PeerDialOrigin;
  /** The instance id a discovered target was announced with; the server must report it. */
  expectedInstanceId?: string;
  /**
   * Closes a connection that has not completed authentication within this
   * many ms, after which the normal reconnect policy applies. Default: 15000.
   */
  handshakeTimeoutMs?: number;
  /** Called when a discovered target fails mutual authentication; the client then stays down. */
  onMutualAuthFailed?: (failure: PeerMutualAuthFailure) => void;
  /** Callback to get this orchestrator's local agent inventory for heartbeats. */
  getLocalInventory: () => Omit<PeerHeartbeat, 'type'>;
  /** Heartbeat interval in ms. Default: 30000 (30s). */
  heartbeatIntervalMs?: number;
  /** Maximum reconnect delay in ms. Default: 60000 (60s). */
  maxReconnectDelayMs?: number;
  /** Callback when a job reroute request is received from peer. */
  onJobReroute: (msg: JobReroute) => Promise<void>;
  /** Callback when a job progress update is received from peer. */
  onJobProgress: (msg: JobProgress, fromPeerId: string, reply: (m: JobProgressAck) => void) => void;
  /**
   * Callback invoked once this client reaches the `connected` state (initial
   * connect AND every reconnect). Carries this client's peer URL.
   */
  onConnected?: (url: string) => void;
  /** Callback when a coordinator ACKs a terminal job.progress this worker sent. */
  onJobProgressAck?: (msg: JobProgressAck) => void;
  /** This orchestrator's role. Default: 'coordinator'. */
  role?: 'coordinator' | 'worker';
  /** Callback when a job cancel request is received from peer. */
  onJobCancel: (msg: PeerJobCancel) => void;
  /** Callback when a log chunk is received from a peer (coordinator side). */
  onPeerLogChunk?: (chunk: PeerLogChunk) => void;
  /** Callback when a cache upload request is received from a peer (coordinator side). */
  onPeerCacheUploadRequest?: (req: PeerCacheUploadRequest) => Promise<PeerCacheUploadResponse>;
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
   * Callback when a config reload request is received from the peer.
   * Should execute a local config reload and return the result fields,
   * which are sent back via peer.config.reload.response.
   *
   * If undefined, incoming reload requests are answered with success=false.
   */
  onPeerConfigReload?: (msg: PeerConfigReload) => Promise<{
    success: boolean;
    version?: number;
    errors?: string[];
    restartRequired?: string[];
    fieldsChanged?: string[];
  }>;
  /**
   * Callback invoked once the remote peer accepts our auth handshake,
   * carrying the remote peer's instanceId. Used by callers that initially
   * register this client in `sub.peerClients` keyed by a placeholder (URL
   * or stale id) to re-key the map by the canonical instanceId so later
   * Platform-mediated discovery dedupes against the same client.
   */
  onAuthenticated?: (targetInstanceId: string) => void;
  /**
   * Callback when a peer.logs.collect.request is received from the peer. Builds
   * this node's subtree bundle and streams it back via the supplied `send`
   * (peer.logs.collect.chunk frames, or a peer.logs.collect.error on failure).
   * If undefined, incoming collect requests are ignored.
   */
  onLogsCollectRequest?: PeerLogsCollectResponder;
  /**
   * Answers a peer.scaler.orphans.request the connected coordinator forwarded
   * to this node (`kici-admin scaler orphans --target`). If undefined,
   * requests are answered with ok=false.
   */
  onScalerOrphansRequest?: ScalerOrphansRequestHandler;
  /**
   * Forgets a departed peer the connected coordinator forgot (`kici-admin peer
   * forget`). If undefined, requests are answered with outcome `error`.
   */
  onPeerForgetRequest?: PeerForgetRequestHandler;
}

/**
 * Builds a node's subtree bundle in response to a peer.logs.collect.request and
 * streams it back through `send`. Shared by PeerClient (outgoing-dialed peers)
 * and the peer handler (incoming-dialed peers).
 */
export type PeerLogsCollectResponder = (
  msg: PeerLogsCollectRequest,
  send: (out: PeerToPeerMessage) => boolean,
) => Promise<void>;

/**
 * Tracks pending ACKs for job.reroute messages.
 */
interface AckWaiter {
  resolve: (accepted: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Tracks pending cache upload responses.
 */
interface CacheWaiter {
  resolve: (response: PeerCacheUploadResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Tracks pending config reload responses.
 */
interface ConfigReloadWaiter {
  resolve: (response: PeerConfigReloadResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Tracks pending cluster-settings pull responses.
 */
interface ClusterSettingsWaiter {
  resolve: (response: PeerClusterSettingsResponse | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PeerClient {
  private ws: WebSocket | null = null;
  private _state: PeerConnectionState = 'disconnected';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  /** Whether this client already warned that it has no auth method; re-armed by an accepted auth. */
  private noAuthWarned = false;
  private intentionalDisconnect = false;
  private _targetInstanceId: string | null = null;
  /** The key the current frames use: K_hs while authenticating, K_app once connected. */
  private sessionKey: Buffer | null = null;
  /** The handshake in flight; cleared on acceptance or close. */
  private handshake: HandshakeState | null = null;
  /** The proof this connection sent, until the server's proof is checked. */
  private pendingProof: PendingProof | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly ackWaiters = new Map<string, AckWaiter>();
  private readonly cacheWaiters = new Map<string, CacheWaiter>();
  private readonly configReloadWaiters = new Map<string, ConfigReloadWaiter>();
  private readonly scalerOrphansWaiters = new ScalerOrphansWaiters();
  private readonly peerForgetWaiters = new PeerForgetWaiters();
  private readonly clusterSettingsWaiters = new Map<string, ClusterSettingsWaiter>();
  /** Correlates peer.logs.collect.request with the peer's chunked subtree response. */
  private readonly logsCollectWaiters = new ChunkRequestWaiter();

  private readonly url: string;
  private readonly authCoordinator: PeerAuthCoordinator;
  /** Set true between deciding token-join and receiving the auth response. */
  private isJoiner = false;
  /** complete() callback for the in-flight token-join, if this client is joiner. */
  private joinComplete: ((issued: CredentialFileData | null) => void) | null = null;
  /** The credential string this client last built a proof with. */
  private lastProvedCredential: string | null = null;
  private readonly instanceId: string;
  private readonly role: 'coordinator' | 'worker';
  private readonly peerRegistry: PeerRegistry;
  private readonly origin: PeerDialOrigin;
  private readonly expectedInstanceId?: string;
  private readonly handshakeTimeoutMs: number;
  private readonly onMutualAuthFailed?: (failure: PeerMutualAuthFailure) => void;
  private readonly getLocalInventory: () => Omit<PeerHeartbeat, 'type'>;
  private readonly heartbeatIntervalMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly onJobReroute: (msg: JobReroute) => Promise<void>;
  private readonly onJobProgress: (
    msg: JobProgress,
    fromPeerId: string,
    reply: (m: JobProgressAck) => void,
  ) => void;
  private readonly onConnected?: (url: string) => void;
  private readonly onJobProgressAck?: (msg: JobProgressAck) => void;
  private readonly onJobCancel: (msg: PeerJobCancel) => void;
  private readonly onPeerLogChunk?: (chunk: PeerLogChunk) => void;
  private readonly onPeerCacheUploadRequest?: (
    req: PeerCacheUploadRequest,
  ) => Promise<PeerCacheUploadResponse>;
  private readonly onRaftVoteRequest?: (msg: RaftVoteRequest) => RaftVoteResponse;
  private readonly onRaftVoteResponse?: (msg: RaftVoteResponse) => void;
  private readonly onRaftAppendEntries?: (msg: RaftAppendEntries) => void;
  private readonly onPeerLeaving?: (msg: PeerLeaving) => void;
  private readonly onAgentTokenRevoke?: (msg: PeerAgentTokenRevoke) => void;
  private readonly onPeerConfigReload?: (msg: PeerConfigReload) => Promise<{
    success: boolean;
    version?: number;
    errors?: string[];
    restartRequired?: string[];
    fieldsChanged?: string[];
  }>;
  private readonly onAuthenticated?: (targetInstanceId: string) => void;
  private readonly onLogsCollectRequest?: PeerLogsCollectResponder;
  private readonly onScalerOrphansRequest?: ScalerOrphansRequestHandler;
  private readonly onPeerForgetRequest?: PeerClientOptions['onPeerForgetRequest'];

  constructor(options: PeerClientOptions) {
    this.url = options.url;
    this.authCoordinator = options.authCoordinator;
    this.instanceId = options.instanceId;
    this.role = options.role ?? 'coordinator';
    this.peerRegistry = options.peerRegistry;
    this.origin = options.origin ?? PeerDialOrigin.Static;
    this.expectedInstanceId = options.expectedInstanceId;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.onMutualAuthFailed = options.onMutualAuthFailed;
    this.getLocalInventory = options.getLocalInventory;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 60_000;
    this.onJobReroute = options.onJobReroute;
    this.onJobProgress = options.onJobProgress;
    this.onConnected = options.onConnected;
    this.onJobProgressAck = options.onJobProgressAck;
    this.onJobCancel = options.onJobCancel;
    this.onPeerLogChunk = options.onPeerLogChunk;
    this.onPeerCacheUploadRequest = options.onPeerCacheUploadRequest;
    this.onRaftVoteRequest = options.onRaftVoteRequest;
    this.onRaftVoteResponse = options.onRaftVoteResponse;
    this.onRaftAppendEntries = options.onRaftAppendEntries;
    this.onPeerLeaving = options.onPeerLeaving;
    this.onAgentTokenRevoke = options.onAgentTokenRevoke;
    this.onPeerConfigReload = options.onPeerConfigReload;
    this.onAuthenticated = options.onAuthenticated;
    this.onLogsCollectRequest = options.onLogsCollectRequest;
    this.onScalerOrphansRequest = options.onScalerOrphansRequest;
    this.onPeerForgetRequest = options.onPeerForgetRequest;
  }

  /** Current connection state. */
  get state(): PeerConnectionState {
    return this._state;
  }

  /** The remote peer's instanceId (set after auth handshake). */
  get targetInstanceId(): string | null {
    return this._targetInstanceId;
  }

  /**
   * Initiate connection to the peer orchestrator.
   */
  connect(): void {
    if (this._state !== 'disconnected') {
      logger.warn('connect() called while not disconnected', { state: this._state });
      return;
    }

    this.intentionalDisconnect = false;
    this.doConnect();
  }

  /**
   * Gracefully disconnect. Does not trigger reconnection.
   */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.stopHeartbeat();
    this.cancelReconnect();
    this.clearAckWaiters();
    this.clearCacheWaiters();
    this.clearConfigReloadWaiters();
    this.clearClusterSettingsWaiters();
    this.scalerOrphansWaiters.rejectAll('Disconnected before the scaler orphan response arrived');
    this.peerForgetWaiters.rejectAll('Disconnected before the peer forget response arrived');
    this.logsCollectWaiters.rejectAll('peer disconnected');
    this.resetHandshake();

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    if (this._targetInstanceId) {
      this.peerRegistry.setAuthScheme(this._targetInstanceId, PeerLinkDirection.Outbound, null);
      this.peerRegistry.markDisconnected(this._targetInstanceId);
    }

    this._state = 'disconnected';
    this.sessionKey = null;
  }

  /**
   * Send a peer protocol message. Returns false if not connected.
   * Messages are encrypted with the session key.
   */
  send(msg: PeerToPeerMessage): boolean {
    if (
      this._state === 'connected' &&
      this.ws &&
      this.ws.readyState === WebSocket.OPEN &&
      this.sessionKey
    ) {
      this.ws.send(encryptMessage(JSON.stringify(msg), this.sessionKey));
      return true;
    }
    return false;
  }

  /**
   * Send a message and wait for an ACK response.
   * Used for job.reroute which expects job.reroute.ack.
   *
   * @returns true if accepted, false if rejected or timeout
   */
  async sendAndWaitAck(msg: JobReroute, timeoutMs: number = 10_000): Promise<boolean> {
    if (!this.send(msg)) return false;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.ackWaiters.delete(msg.messageId);
        resolve(false);
      }, timeoutMs);

      this.ackWaiters.set(msg.messageId, { resolve, timer });
    });
  }

  /**
   * Send a log chunk to the coordinator (worker -> coordinator relay).
   * Fire-and-forget: no ACK expected.
   */
  sendLogChunk(chunk: PeerLogChunk): boolean {
    return this.send(chunk);
  }

  /**
   * Send a peer.config.reload request to the connected peer and wait for the
   * matching peer.config.reload.response.
   *
   * @returns The response, or null if not connected. Resolves with success=false
   *   if the peer doesn't reply within the timeout.
   */
  async sendConfigReloadAndWait(
    msg: PeerConfigReload,
    timeoutMs: number = 15_000,
  ): Promise<PeerConfigReloadResponse | null> {
    if (!this.send(msg as PeerToPeerMessage)) return null;

    return new Promise<PeerConfigReloadResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.configReloadWaiters.delete(msg.messageId);
        resolve({
          type: 'peer.config.reload.response',
          messageId: msg.messageId,
          success: false,
          errors: [
            `Config reload to peer ${this._targetInstanceId ?? 'unknown'} timed out after ${timeoutMs}ms`,
          ],
        });
      }, timeoutMs);

      this.configReloadWaiters.set(msg.messageId, { resolve, timer });
    });
  }

  /**
   * Send a peer.forget.request to the connected peer and wait for the matching
   * response.
   *
   * @returns the response; null when not connected; `'timeout'` when no
   *   response arrived within `timeoutMs`.
   */
  async sendPeerForgetAndWait(
    msg: PeerForgetRequest,
    timeoutMs: number,
  ): Promise<PeerForgetResponse | null | typeof PEER_FORGET_TIMEOUT> {
    if (!this.send(msg as PeerToPeerMessage)) return null;
    return this.peerForgetWaiters.wait(msg.messageId, timeoutMs);
  }

  /**
   * Send a peer.scaler.orphans.request to the connected peer and wait for the
   * matching response.
   *
   * @returns the response; null when not connected; `'timeout'` when no
   *   response arrived within `timeoutMs`.
   */
  async sendScalerOrphansAndWait(
    msg: PeerScalerOrphansRequest,
    timeoutMs: number,
  ): Promise<PeerScalerOrphansResponse | null | typeof SCALER_ORPHANS_TIMEOUT> {
    if (!this.send(msg as PeerToPeerMessage)) return null;
    return this.scalerOrphansWaiters.wait(msg.messageId, timeoutMs);
  }

  /**
   * Send a peer.clusterSettings.request to the connected coordinator and wait for
   * the matching peer.clusterSettings.response carrying the worker-settings snapshot.
   *
   * @returns The response, or null if not connected or the coordinator doesn't reply
   *   within the timeout — the caller keeps its current (config-default) settings.
   */
  async sendClusterSettingsRequestAndWait(
    msg: PeerClusterSettingsRequest,
    timeoutMs: number = 10_000,
  ): Promise<PeerClusterSettingsResponse | null> {
    if (!this.send(msg as PeerToPeerMessage)) return null;

    return new Promise<PeerClusterSettingsResponse | null>((resolve) => {
      const timer = setTimeout(() => {
        this.clusterSettingsWaiters.delete(msg.messageId);
        resolve(null);
      }, timeoutMs);

      this.clusterSettingsWaiters.set(msg.messageId, { resolve, timer });
    });
  }

  /**
   * Send a peer.logs.collect.request to the connected peer and await its
   * reassembled subtree-bundle ZIP. Rejects on timeout, an error frame, or
   * peer disconnect.
   */
  sendLogsCollectAndWait(msg: PeerLogsCollectRequest, timeoutMs: number): Promise<Buffer> {
    const promise = this.logsCollectWaiters.add(msg.messageId, timeoutMs);
    if (!this.send(msg as PeerToPeerMessage)) {
      this.logsCollectWaiters.onError(msg.messageId, 'Not connected to peer');
    }
    return promise;
  }

  /**
   * Send a cache upload request to the coordinator and wait for a response
   * with a pre-signed URL.
   *
   * @returns The response with the uploadUrl, or rejects on timeout/disconnect.
   */
  async sendCacheUploadRequest(
    req: PeerCacheUploadRequest,
    timeoutMs: number = 10_000,
  ): Promise<PeerCacheUploadResponse> {
    if (!this.send(req)) {
      throw new Error('Not connected to coordinator');
    }

    return new Promise<PeerCacheUploadResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cacheWaiters.delete(req.messageId);
        reject(new Error('Cache upload request timed out'));
      }, timeoutMs);

      this.cacheWaiters.set(req.messageId, { resolve, reject, timer });
    });
  }

  /**
   * Calculate the reconnection delay with exponential backoff and jitter.
   */
  getReconnectDelay(): number {
    return getReconnectDelay(this.reconnectAttempts, this.maxReconnectDelayMs);
  }

  // --- Internal methods ---

  private doConnect(): void {
    this._state = 'connecting';

    try {
      this.ws = new WebSocket(this.url, {
        // Cap the maximum decompressed frame size so a rogue or
        // compromised peer orchestrator cannot OOM us via a compression bomb.
        // Without this, ws@8.x defaults to 100 MiB.
        maxPayload: WS_MAX_PAYLOAD_BYTES,
        perMessageDeflate: {
          concurrencyLimit: 10,
          threshold: 128, // Skip compressing tiny messages like heartbeats
        },
      });
    } catch (err) {
      logger.error('Failed to create peer WebSocket', {
        error: toErrorMessage(err),
      });
      this._state = 'disconnected';
      this.scheduleReconnect();
      return;
    }

    const ws = this.ws;
    this.armHandshakeTimer(ws);

    this.ws.on('open', () => {
      this._state = 'handshaking';
      logger.info('Connected to peer, waiting for ECDH handshake', { url: this.url });
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      logger.info('Peer connection closed', {
        code,
        reason: reason.toString(),
        targetInstanceId: this._targetInstanceId,
      });

      // A socket that disconnect() already released (or that a newer socket
      // replaced) closes late: disconnect() did the cleanup, and the peer may
      // be registered again by the client that replaced this one.
      if (this.ws !== ws) return;

      this._state = 'disconnected';
      this.stopHeartbeat();
      this.sessionKey = null;
      this.resetHandshake();
      // Fail any in-flight fleet collect — the chunked reply can't complete now.
      this.logsCollectWaiters.rejectAll('peer disconnected');

      if (this._targetInstanceId) {
        this.peerRegistry.setAuthScheme(this._targetInstanceId, PeerLinkDirection.Outbound, null);
        this.peerRegistry.markDisconnected(this._targetInstanceId);
      }

      if (!this.intentionalDisconnect) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err: Error) => {
      logger.error('Peer WebSocket error', { error: err.message });

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
    });
  }

  private handleMessage(data: WebSocket.Data): void {
    const raw = data.toString();

    if (this._state === 'handshaking') {
      this.handleHello(raw);
      return;
    }

    if (this._state === 'authenticating') {
      this.handleAuthResponse(raw);
      return;
    }

    if (this._state !== 'connected') return;

    // --- Connected: decrypt and route ---
    if (!this.sessionKey) return;

    let decrypted: string;
    try {
      decrypted = decryptMessage(raw, this.sessionKey);
    } catch {
      logger.warn('Failed to decrypt message from peer');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(decrypted);
    } catch {
      logger.warn('Malformed JSON from peer');
      return;
    }

    const msgResult = peerFromPeerMessageSchema.safeParse(parsed);
    if (!msgResult.success) {
      logger.warn('Invalid message from peer', { errors: msgResult.error.issues });
      return;
    }

    this.routeMessage(msgResult.data);
  }

  private armHandshakeTimer(ws: WebSocket): void {
    this.clearHandshakeTimer();
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.ws !== ws || this._state === 'connected') return;
      logger.warn('Peer handshake timed out', {
        url: this.url,
        state: this._state,
        timeoutMs: this.handshakeTimeoutMs,
      });
      this.releaseJoin();
      ws.terminate();
    }, this.handshakeTimeoutMs);
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  /** A token join in flight must be released so sibling clients stop waiting on it. */
  private releaseJoin(): void {
    const complete = this.joinComplete;
    this.isJoiner = false;
    this.joinComplete = null;
    complete?.(null);
  }

  /** Forget the handshake of a connection that closed or is being torn down. */
  private resetHandshake(): void {
    this.clearHandshakeTimer();
    this.handshake = null;
    this.pendingProof = null;
    this.releaseJoin();
  }

  /** Close a connection whose handshake broke the protocol. */
  private abortHandshake(reason: string): void {
    logger.warn('Closing peer connection during the handshake', { url: this.url, reason });
    this.handshake = null;
    this.pendingProof = null;
    this.releaseJoin();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(WS_CLOSE_PROTOCOL_ERROR, reason);
    }
  }

  /** Close a connection whose server failed mutual authentication. */
  private failMutualAuth(failure: PeerMutualAuthFailure, closeCode: number): void {
    logger.error('Peer failed mutual authentication', {
      url: this.url,
      failure,
      origin: this.origin,
    });
    this.handshake = null;
    this.pendingProof = null;
    this.releaseJoin();
    if (this.origin === PeerDialOrigin.Discovered) {
      // An announced address is a hint: it is dropped, and dialled again only
      // if the Platform announces it again.
      this.intentionalDisconnect = true;
      this.onMutualAuthFailed?.(failure);
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close(closeCode, failure);
  }

  /** The server's plaintext peer.hello: refuse it unless it offers mutual-v2. */
  private handleHello(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.abortHandshake('Malformed JSON during handshake');
      return;
    }
    const hello = peerHelloSchema.safeParse(parsed);
    if (!hello.success) {
      this.abortHandshake('Expected peer.hello');
      return;
    }
    const authSchemes = hello.data.authSchemes ?? [];
    if (!authSchemes.includes(PeerAuthScheme.enum['mutual-v2'])) {
      logger.error(PEER_MUTUAL_AUTH_UNSUPPORTED_MESSAGE, {
        url: this.url,
        advertised: authSchemes,
      });
      this.failMutualAuth(PeerMutualAuthFailure.SchemeMissing, WS_CLOSE_PROTOCOL_ERROR);
      return;
    }
    const serverPub = Buffer.from(hello.data.ephemeralPublicKey, 'base64');
    const nonce = Buffer.from(hello.data.nonce, 'base64');
    if (nonce.length !== HANDSHAKE_NONCE_BYTES) {
      this.abortHandshake('Invalid hello nonce');
      return;
    }
    const ecdh = generateEcdhKeyPair();
    let handshakeKey: Buffer;
    try {
      handshakeKey = deriveSessionKey(ecdh.privateKey, serverPub, nonce);
    } catch (err) {
      logger.error('ECDH key derivation failed', { error: toErrorMessage(err) });
      this.abortHandshake('Key derivation failed');
      return;
    }
    this.handshake = {
      handshakeKey,
      transcriptHash: peerTranscriptHash({
        serverEphemeralPublicKey: serverPub,
        serverNonce: nonce,
        authSchemes,
        clientEphemeralPublicKey: ecdh.publicKey,
      }),
    };
    this.sessionKey = handshakeKey;
    this.ws!.send(
      JSON.stringify({
        type: 'peer.hello.response',
        ephemeralPublicKey: ecdh.publicKey.toString('base64'),
      }),
    );
    this._state = 'authenticating';
    this.sendAuthRequest().catch((err) => {
      logger.error('Failed to send auth request', { error: toErrorMessage(err) });
      this.abortHandshake('Auth request failed');
    });
  }

  /**
   * The encrypted peer.auth.response. Any frame that is not one closes the
   * socket. An acceptance is checked synchronously, before any state change,
   * registry write or callback, so a frame pipelined behind an unproven
   * acceptance meets a client that is not connected.
   */
  private handleAuthResponse(raw: string): void {
    const hs = this.handshake;
    const proof = this.pendingProof;
    if (!hs || !proof) {
      this.abortHandshake('Frame before the auth request');
      return;
    }
    let msg: PeerAuthResponse;
    try {
      const parsed = peerFromPeerMessageSchema.safeParse(
        JSON.parse(decryptMessage(raw, hs.handshakeKey)),
      );
      if (!parsed.success || parsed.data.type !== 'peer.auth.response') {
        this.abortHandshake('Expected peer.auth.response');
        return;
      }
      msg = parsed.data;
    } catch {
      this.abortHandshake('Undecryptable frame during authentication');
      return;
    }

    if (!msg.accepted) {
      this.handshake = null;
      this.pendingProof = null;
      this.handleAuthRejected(msg.reason);
      return;
    }
    const failure = this.checkAcceptance(msg, hs, proof);
    if (failure) {
      this.failMutualAuth(failure, WS_CLOSE_UNAUTHORIZED);
      return;
    }
    this.sessionKey = deriveAppKey({
      handshakeKey: hs.handshakeKey,
      psk: proof.psk,
      transcriptHash: hs.transcriptHash,
      clientProof: proof.clientProof,
      serverProof: decodeProof(msg.serverProof!)!,
    });
    this.handshake = null;
    this.pendingProof = null;
    this.completeAcceptance(msg as PeerAuthResponse & { instanceId: string; role: string });
  }

  /** Returns why the acceptance fails mutual authentication, or null when it passes. */
  private checkAcceptance(
    msg: PeerAuthResponse,
    hs: HandshakeState,
    proof: PendingProof,
  ): PeerMutualAuthFailure | null {
    if (!msg.instanceId) return PeerMutualAuthFailure.InstanceIdMissing;
    const presented = msg.serverProof ? decodeProof(msg.serverProof) : null;
    if (!presented || !msg.role) return PeerMutualAuthFailure.ServerProofInvalid;
    if (proof.mode === PeerAuthMode.enum.token && !msg.sessionCredential) {
      return PeerMutualAuthFailure.ServerProofInvalid;
    }
    const expected = computeServerProof({
      psk: proof.psk,
      transcriptHash: hs.transcriptHash,
      clientProof: proof.clientProof,
      serverInstanceId: msg.instanceId,
      grantedRole: msg.role,
      sessionCredential: msg.sessionCredential ?? null,
    });
    if (!proofMatches(expected, presented)) return PeerMutualAuthFailure.ServerProofInvalid;
    if (this.expectedInstanceId && msg.instanceId !== this.expectedInstanceId) {
      return PeerMutualAuthFailure.InstanceIdMismatch;
    }
    return null;
  }

  /** The server proved itself: register the peer and start the connected session. */
  private completeAcceptance(msg: PeerAuthResponse & { instanceId: string; role: string }): void {
    this.clearHandshakeTimer();
    if (msg.softwareVersion) {
      logger.info('Coordinator software version', {
        localVersion: SOFTWARE_VERSION,
        coordinatorVersion: msg.softwareVersion,
      });
    }

    this._targetInstanceId = msg.instanceId;
    // Before addPeer: a caller that re-keys or promotes this client on
    // authentication disconnects the client it replaces here.
    this.onAuthenticated?.(msg.instanceId);
    logger.info('Peer auth accepted', {
      targetInstanceId: msg.instanceId,
      agentCount: msg.agents?.length ?? 0,
      scalerBackends: msg.scalerCapacity?.length ?? 0,
    });

    this._state = 'connected';
    this.reconnectAttempts = 0;
    this.noAuthWarned = false;

    // Persist the credential the server issued (first join), which its proof
    // covers. The coordinator owns the shared file; the joiner writes via complete().
    if (msg.sessionCredential && this.isJoiner && this.joinComplete) {
      this.joinComplete({
        instanceId: this.instanceId,
        credential: msg.sessionCredential,
        role: msg.role,
        issuedAt: new Date().toISOString(),
      });
    }
    this.isJoiner = false;
    this.joinComplete = null;

    this.peerRegistry.addPeer({
      instanceId: msg.instanceId,
      connectionId: randomUUID(),
      address: this.url,
      routingKeys: [],
    });
    this.peerRegistry.setAuthScheme(
      msg.instanceId,
      PeerLinkDirection.Outbound,
      PeerAuthScheme.enum['mutual-v2'],
    );

    // Populate registry with auth response capabilities
    if (msg.agents || msg.scalerCapacity) {
      this.peerRegistry.updateHeartbeat(msg.instanceId, {
        type: 'peer.heartbeat',
        instanceId: msg.instanceId,
        timestamp: Date.now(),
        term: 0,
        leaderId: null,
        draining: false,
        agents: msg.agents ?? [],
        capabilities: msg.capabilities ?? { s3LogAccess: false },
        scalerCapacity: msg.scalerCapacity,
      });
    }

    // Send immediate heartbeat
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.sessionKey) {
      const inventory = this.getLocalInventory();
      this.ws.send(
        encryptMessage(JSON.stringify({ type: 'peer.heartbeat', ...inventory }), this.sessionKey),
      );
    }

    this.startHeartbeat();
    this.onConnected?.(this.url);
  }

  /**
   * Handle a rejected peer.auth.response. For the three credential-divergence
   * reasons, delegate to the coordinator (which deletes the shared file only if
   * no sibling has refreshed it, preventing a revocation cascade). A failed
   * token-join releases the in-flight join so siblings can retry. Config-error
   * reasons (role mismatch / missing auth method / protocol version) skip the
   * coordinator entirely — deletion would not help.
   */
  private handleAuthRejected(reason: string | undefined): void {
    logger.error('Peer auth rejected', { reason });

    const wasJoiner = this.isJoiner;
    const joinComplete = this.joinComplete;
    const provedCredential = this.lastProvedCredential;
    this.isJoiner = false;
    this.joinComplete = null;
    this.lastProvedCredential = null;

    const credentialDivergence =
      reason === 'Invalid proof' ||
      reason === 'Unknown credential' ||
      reason === 'Credential revoked';

    const finish = (): void => {
      // A failed token-join must release the in-flight join so siblings retry.
      if (wasJoiner && joinComplete) joinComplete(null);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, 'Auth rejected');
      }
    };

    if (!credentialDivergence) {
      finish();
      return;
    }

    // Delegate the file decision to the coordinator before closing, so the
    // file operation completes before scheduleReconnect fires via the close
    // event listener (no sync-I/O race with the reconnect backoff).
    runDetached(
      logger,
      'Peer auth rejection handling',
      async () => {
        try {
          const action = await this.authCoordinator.reportRejection(
            provedCredential,
            reason as string,
          );
          logger.info('Coordinator rejection action', { reason, action });
        } catch (err) {
          logger.warn('Coordinator rejection handling failed', {
            error: toErrorMessage(err),
            reason,
          });
        } finally {
          finish();
        }
      },
      { reason },
    );
  }

  /**
   * Determine auth method and send encrypted auth request.
   *
   * Credentials are **identity-scoped**, not URL-scoped. A single orchestrator
   * runs N peer-clients (one per remote peer) and they all share the same
   * on-disk credential file. The credential represents "this orchestrator's
   * cluster membership credential", and the server (peer-handler) verifies it
   * by `instanceId` alone — not by the requester URL. So any peer-client
   * connecting to any peer can use the same credential, as long as the
   * `instanceId` on disk matches ours.
   *
   * The auth-method decision is delegated to the shared `PeerAuthCoordinator`,
   * which serializes sibling peer-clients so exactly one token-joins per
   * reconnect storm (the rest reuse the freshly-written credential). This
   * client never reads or writes the credential file directly.
   */
  private async sendAuthRequest(): Promise<void> {
    const hs = this.handshake;
    if (!hs || !this.ws) return;

    const decision = await this.authCoordinator.decideAuth();
    if (this.handshake !== hs || this._state !== 'authenticating' || !this.ws) {
      // The socket moved on while the decision was pending.
      if (decision.mode === 'token-join') decision.complete(null);
      return;
    }

    let psk: Buffer;
    let mode: PeerAuthMode;
    let tokenRouting = '';
    if (decision.mode === 'credential') {
      psk = Buffer.from(sha256(decision.credential.credential), 'hex');
      mode = PeerAuthMode.enum.credential;
      this.lastProvedCredential = decision.credential.credential;
      this.isJoiner = false;
      this.joinComplete = null;
    } else if (decision.mode === 'token-join') {
      try {
        const parsed = parseToken(decision.token);
        tokenRouting = parsed.routingB64;
        psk = Buffer.from(tokenHashOf(parsed.secretHex), 'hex');
      } catch (err) {
        logger.error('KICI_CLUSTER_JOIN_TOKEN is not a valid join token', {
          error: toErrorMessage(err),
        });
        decision.complete(null);
        this.abortHandshake('Invalid join token');
        return;
      }
      mode = PeerAuthMode.enum.token;
      this.isJoiner = true;
      this.joinComplete = decision.complete;
      this.lastProvedCredential = null;
    } else {
      const meta = {
        instanceId: this.instanceId,
        targetUrl: this.url,
        remedy: NO_AUTH_METHOD_REMEDY,
      };
      if (this.noAuthWarned) {
        logger.debug(NO_AUTH_METHOD_MESSAGE, meta);
      } else {
        this.noAuthWarned = true;
        logger.warn(NO_AUTH_METHOD_MESSAGE, meta);
      }
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, 'No auth method');
      }
      return;
    }

    const clientProof = computeClientProof({
      psk,
      transcriptHash: hs.transcriptHash,
      mode,
      clientInstanceId: this.instanceId,
      role: this.role,
      protocolVersion: PROTOCOL_VERSION,
      tokenRouting,
    });
    this.pendingProof = { psk, clientProof, mode };
    logger.info('Sending mutual-v2 auth request', {
      targetUrl: this.url,
      mode,
      ...(mode === PeerAuthMode.enum.token && { reason: 'no-credential-file' }),
    });
    this.ws.send(
      encryptMessage(
        JSON.stringify({
          type: 'peer.auth.request',
          instanceId: this.instanceId,
          protocolVersion: PROTOCOL_VERSION,
          softwareVersion: SOFTWARE_VERSION,
          role: this.role,
          scheme: PeerAuthScheme.enum['mutual-v2'],
          mode,
          clientProof: clientProof.toString('hex'),
          ...(mode === PeerAuthMode.enum.token && { tokenRouting }),
        }),
        hs.handshakeKey,
      ),
    );
  }

  private routeMessage(msg: PeerToPeerMessage): void {
    switch (msg.type) {
      case 'peer.heartbeat': {
        this.peerRegistry.updateHeartbeat(msg.instanceId, msg);
        break;
      }

      case 'job.reroute': {
        this.onJobReroute(msg).catch((err) => {
          logger.error('Error handling job reroute', {
            error: toErrorMessage(err),
          });
        });
        break;
      }

      case 'job.reroute.ack': {
        const waiter = this.ackWaiters.get(msg.messageId);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.ackWaiters.delete(msg.messageId);
          if (!msg.accepted) {
            logger.info('Reroute ACK rejected by peer', {
              targetInstanceId: this._targetInstanceId,
              reason: msg.reason,
            });
          }
          waiter.resolve(msg.accepted);
        }
        break;
      }

      case 'job.progress': {
        // job.progress only arrives on an authenticated connection, so the
        // remote peer's instanceId is set here; it is what the coordinator uses
        // to verify signal provenance against the tracked reroute target.
        if (this._targetInstanceId === null) {
          logger.warn('Dropping job.progress received before peer authentication completed');
          break;
        }
        this.onJobProgress(msg, this._targetInstanceId, (out) => this.send(out));
        break;
      }

      case 'job.progress.ack': {
        this.onJobProgressAck?.(msg);
        break;
      }

      case 'peer.job.cancel': {
        this.onJobCancel(msg);
        break;
      }

      case 'raft.vote.request': {
        if (this.onRaftVoteRequest) {
          const response = this.onRaftVoteRequest(msg);
          this.send(response);
        }
        break;
      }

      case 'raft.append.entries': {
        this.onRaftAppendEntries?.(msg);
        break;
      }

      case 'peer.log.chunk': {
        this.onPeerLogChunk?.(msg);
        break;
      }

      case 'peer.cache.upload.request': {
        // Coordinator receives cache upload request from worker peer
        if (this.onPeerCacheUploadRequest) {
          this.onPeerCacheUploadRequest(msg)
            .then((response) => {
              this.send(response);
            })
            .catch((err) => {
              logger.error('Error handling cache upload request', {
                error: toErrorMessage(err),
              });
            });
        }
        break;
      }

      case 'peer.cache.upload.response': {
        // Worker receives cache upload response from coordinator
        const waiter = this.cacheWaiters.get(msg.messageId);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.cacheWaiters.delete(msg.messageId);
          waiter.resolve(msg);
        }
        break;
      }

      case 'peer.auth.request': {
        // Should not receive auth request on outgoing connection
        logger.warn('Unexpected peer.auth.request on outgoing connection');
        break;
      }

      case 'raft.vote.response': {
        this.onRaftVoteResponse?.(msg);
        break;
      }

      case 'peer.leaving': {
        // Mark peer as disconnected in registry first, then notify Raft
        this.peerRegistry.markDisconnected(msg.instanceId);
        this.onPeerLeaving?.(msg);
        break;
      }

      case 'peer.agent-token.revoke': {
        this.onAgentTokenRevoke?.(msg);
        break;
      }

      case 'peer.config.reload': {
        // Execute reload locally and reply with response.
        const handler = this.onPeerConfigReload;
        const replyMessageId = msg.messageId;
        const sendReply = (response: Omit<PeerConfigReloadResponse, 'type' | 'messageId'>) => {
          this.send({
            type: 'peer.config.reload.response',
            messageId: replyMessageId,
            ...response,
          });
        };

        if (!handler) {
          sendReply({
            success: false,
            errors: ['Config reload handler not configured on target peer'],
          });
          break;
        }

        handler(msg)
          .then((result) => {
            sendReply(result);
          })
          .catch((err) => {
            logger.error('Error executing peer config reload', {
              error: toErrorMessage(err),
            });
            sendReply({ success: false, errors: [toErrorMessage(err)] });
          });
        break;
      }

      case 'peer.config.reload.response': {
        const waiter = this.configReloadWaiters.get(msg.messageId);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.configReloadWaiters.delete(msg.messageId);
          waiter.resolve(msg);
        }
        break;
      }

      case 'peer.scaler.orphans.request': {
        replyToScalerOrphansRequest(
          msg,
          this.onScalerOrphansRequest,
          (response) => {
            this.send(response);
          },
          { peerId: this._targetInstanceId },
        );
        break;
      }

      case 'peer.forget.request': {
        // This client dialled the peer, and only coordinators dial coordinators.
        replyToPeerForgetRequest(
          msg,
          this.onPeerForgetRequest,
          (response) => {
            this.send(response);
          },
          { peerId: this._targetInstanceId },
        );
        break;
      }

      case 'peer.forget.response': {
        this.peerForgetWaiters.resolve(msg);
        break;
      }

      case 'peer.scaler.orphans.response': {
        this.scalerOrphansWaiters.resolve(msg);
        break;
      }

      case 'peer.clusterSettings.response': {
        const waiter = this.clusterSettingsWaiters.get(msg.messageId);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.clusterSettingsWaiters.delete(msg.messageId);
          waiter.resolve(msg);
        }
        break;
      }

      case 'peer.logs.collect.request': {
        runDetached(
          logger,
          'Peer logs collect request',
          () => this.onLogsCollectRequest?.(msg, (out) => this.send(out)),
          { messageType: msg.type, peerId: this._targetInstanceId },
        );
        break;
      }

      case 'peer.logs.collect.chunk': {
        this.logsCollectWaiters.onChunk(msg.messageId, msg.seq, msg.dataB64, msg.isLast);
        break;
      }

      case 'peer.logs.collect.error': {
        this.logsCollectWaiters.onError(msg.messageId, msg.message);
        break;
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (
        this._state === 'connected' &&
        this.ws?.readyState === WebSocket.OPEN &&
        this.sessionKey
      ) {
        const inventory = this.getLocalInventory();
        this.ws.send(
          encryptMessage(
            JSON.stringify({
              type: 'peer.heartbeat',
              ...inventory,
            }),
            this.sessionKey,
          ),
        );
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    this.cancelReconnect();

    const delay = this.getReconnectDelay();
    this.reconnectAttempts++;

    logger.info('Scheduling peer reconnect', {
      attempt: this.reconnectAttempts,
      delayMs: Math.round(delay),
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.intentionalDisconnect) {
        this.doConnect();
      }
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearAckWaiters(): void {
    for (const [, waiter] of this.ackWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
    this.ackWaiters.clear();
  }

  private clearCacheWaiters(): void {
    for (const [, waiter] of this.cacheWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Disconnected'));
    }
    this.cacheWaiters.clear();
  }

  private clearConfigReloadWaiters(): void {
    for (const [, waiter] of this.configReloadWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({
        type: 'peer.config.reload.response',
        messageId: '',
        success: false,
        errors: ['Disconnected before peer config reload response received'],
      });
    }
    this.configReloadWaiters.clear();
  }

  private clearClusterSettingsWaiters(): void {
    for (const [, waiter] of this.clusterSettingsWaiters) {
      clearTimeout(waiter.timer);
      // Null result → the worker keeps its current (config-default) settings.
      waiter.resolve(null);
    }
    this.clusterSettingsWaiters.clear();
  }
}
