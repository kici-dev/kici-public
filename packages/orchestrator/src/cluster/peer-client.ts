/**
 * WebSocket client for outgoing peer-to-peer connections between orchestrators.
 *
 * Follows PlatformClient patterns closely:
 * - State machine: disconnected -> connecting -> handshaking -> authenticating -> connected
 * - Exponential backoff with jitter for reconnection
 * - Periodic heartbeat (30s default)
 * - Intentional disconnect flag to prevent reconnection
 *
 * Authentication uses ECDH key exchange followed by join token (first connect)
 * or HMAC credential proof (reconnection).
 */

import WebSocket from 'ws';
import { createHmac, randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import {
  createLogger,
  getReconnectDelay,
  sha256,
  toErrorMessage,
  ChunkRequestWaiter,
} from '@kici-dev/shared';
import {
  peerHelloSchema,
  peerFromPeerMessageSchema,
  WS_MAX_PAYLOAD_BYTES,
  type PeerHeartbeat,
  type PeerToPeerMessage,
  type JobReroute,
  type JobProgress,
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
  PROTOCOL_VERSION,
} from '@kici-dev/engine';
import type { PeerRegistry } from './peer-registry.js';
import {
  generateEcdhKeyPair,
  deriveSessionKey,
  encryptMessage,
  decryptMessage,
} from './peer-crypto.js';
import { readCredentialFile, writeCredentialFile } from './peer-credentials.js';

const logger = createLogger({ prefix: 'peer-client' });

// Software version injected at build time by scripts/build-service.mjs.
declare const KICI_PKG_VERSION: string;
const SOFTWARE_VERSION = typeof KICI_PKG_VERSION !== 'undefined' ? KICI_PKG_VERSION : '0.0.0';

type PeerConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'handshaking'
  | 'authenticating'
  | 'connected';

export interface PeerClientOptions {
  /** WebSocket URL of the remote peer orchestrator. */
  url: string;
  /** Join token for first-time cluster join (optional if credential file exists). */
  joinToken?: string;
  /** Path to the credential file for reconnection. */
  credentialFile: string;
  /** This orchestrator's instance ID. */
  instanceId: string;
  /** Peer registry to update on heartbeats from remote peer. */
  peerRegistry: PeerRegistry;
  /** Callback to get this orchestrator's local agent inventory for heartbeats. */
  getLocalInventory: () => Omit<PeerHeartbeat, 'type'>;
  /** Heartbeat interval in ms. Default: 30000 (30s). */
  heartbeatIntervalMs?: number;
  /** Maximum reconnect delay in ms. Default: 60000 (60s). */
  maxReconnectDelayMs?: number;
  /** Callback when a job reroute request is received from peer. */
  onJobReroute: (msg: JobReroute) => Promise<void>;
  /** Callback when a job progress update is received from peer. */
  onJobProgress: (msg: JobProgress) => void;
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

export class PeerClient {
  private ws: WebSocket | null = null;
  private _state: PeerConnectionState = 'disconnected';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private intentionalDisconnect = false;
  private _targetInstanceId: string | null = null;
  private sessionKey: Buffer | null = null;
  private readonly ackWaiters = new Map<string, AckWaiter>();
  private readonly cacheWaiters = new Map<string, CacheWaiter>();
  private readonly configReloadWaiters = new Map<string, ConfigReloadWaiter>();
  /** Correlates peer.logs.collect.request with the peer's chunked subtree response. */
  private readonly logsCollectWaiters = new ChunkRequestWaiter();

  private readonly url: string;
  private readonly joinToken?: string;
  private readonly credentialFile: string;
  private readonly instanceId: string;
  private readonly role: 'coordinator' | 'worker';
  private readonly peerRegistry: PeerRegistry;
  private readonly getLocalInventory: () => Omit<PeerHeartbeat, 'type'>;
  private readonly heartbeatIntervalMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly onJobReroute: (msg: JobReroute) => Promise<void>;
  private readonly onJobProgress: (msg: JobProgress) => void;
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

  constructor(options: PeerClientOptions) {
    this.url = options.url;
    this.joinToken = options.joinToken;
    this.credentialFile = options.credentialFile;
    this.instanceId = options.instanceId;
    this.role = options.role ?? 'coordinator';
    this.peerRegistry = options.peerRegistry;
    this.getLocalInventory = options.getLocalInventory;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 60_000;
    this.onJobReroute = options.onJobReroute;
    this.onJobProgress = options.onJobProgress;
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
    this.logsCollectWaiters.rejectAll('peer disconnected');

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    if (this._targetInstanceId) {
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
        //: cap maximum decompressed frame size so a rogue or
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

      this._state = 'disconnected';
      this.stopHeartbeat();
      this.sessionKey = null;
      // Fail any in-flight fleet collect — the chunked reply can't complete now.
      this.logsCollectWaiters.rejectAll('peer disconnected');

      if (this._targetInstanceId) {
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
      // --- Waiting for peer.hello from server ---
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        logger.warn('Malformed JSON during handshake');
        return;
      }

      const hello = peerHelloSchema.safeParse(parsed);
      if (!hello.success) {
        logger.warn('Expected peer.hello, got invalid message');
        return;
      }

      // Generate our ECDH key pair
      const ecdh = generateEcdhKeyPair();

      // Derive session key using server's public key and nonce
      const serverPubKey = Buffer.from(hello.data.ephemeralPublicKey, 'base64');
      const nonce = Buffer.from(hello.data.nonce, 'base64');

      try {
        this.sessionKey = deriveSessionKey(ecdh.privateKey, serverPubKey, nonce);
      } catch (err) {
        logger.error('ECDH key derivation failed', { error: toErrorMessage(err) });
        if (this.ws) this.ws.close(1000, 'Key derivation failed');
        return;
      }

      // Send peer.hello.response
      this.ws!.send(
        JSON.stringify({
          type: 'peer.hello.response',
          ephemeralPublicKey: ecdh.publicKey.toString('base64'),
        }),
      );

      // Now send auth request (encrypted)
      this._state = 'authenticating';
      this.sendAuthRequest(nonce).catch((err) => {
        logger.error('Failed to send auth request', { error: toErrorMessage(err) });
        if (this.ws) this.ws.close(1000, 'Auth request failed');
      });

      return;
    }

    if (this._state === 'authenticating') {
      // --- Waiting for peer.auth.response (encrypted) ---
      if (!this.sessionKey) {
        logger.warn('No session key for auth response decryption');
        return;
      }

      let decrypted: string;
      try {
        decrypted = decryptMessage(raw, this.sessionKey);
      } catch {
        logger.warn('Failed to decrypt auth response');
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(decrypted);
      } catch {
        logger.warn('Malformed JSON in decrypted auth response');
        return;
      }

      const msgResult = peerFromPeerMessageSchema.safeParse(parsed);
      if (!msgResult.success) {
        logger.warn('Invalid auth response', { errors: msgResult.error.issues });
        return;
      }

      if (msgResult.data.type !== 'peer.auth.response') {
        logger.warn('Expected peer.auth.response, got', { type: msgResult.data.type });
        return;
      }

      const msg = msgResult.data;

      if (msg.accepted) {
        if (msg.softwareVersion) {
          logger.info('Coordinator software version', {
            localVersion: SOFTWARE_VERSION,
            coordinatorVersion: msg.softwareVersion,
          });
        }

        this._targetInstanceId = msg.instanceId ?? null;
        if (msg.instanceId) {
          this.onAuthenticated?.(msg.instanceId);
        }
        logger.info('Peer auth accepted', {
          targetInstanceId: msg.instanceId,
          agentCount: msg.agents?.length ?? 0,
          scalerBackends: msg.scalerCapacity?.length ?? 0,
        });

        this._state = 'connected';
        this.reconnectAttempts = 0;

        // Persist credential if issued (first join)
        if (msg.sessionCredential) {
          writeCredentialFile(this.credentialFile, {
            instanceId: this.instanceId,
            credential: msg.sessionCredential,
            role: msg.role ?? 'coordinator',
            issuedAt: new Date().toISOString(),
          }).catch((err) => {
            logger.error('Failed to persist credential file', {
              error: toErrorMessage(err),
            });
          });
        }

        // Register peer in registry
        this.peerRegistry.addPeer({
          instanceId: msg.instanceId!,
          connectionId: randomUUID(),
          address: this.url,
          routingKeys: [],
        });

        // Populate registry with auth response capabilities
        if (msg.agents || msg.scalerCapacity) {
          this.peerRegistry.updateHeartbeat(msg.instanceId!, {
            type: 'peer.heartbeat',
            instanceId: msg.instanceId!,
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
            encryptMessage(
              JSON.stringify({ type: 'peer.heartbeat', ...inventory }),
              this.sessionKey,
            ),
          );
        }

        this.startHeartbeat();
      } else {
        logger.error('Peer auth rejected', { reason: msg.reason });

        // Defensive self-heal: if the server rejected our credential-based
        // proof (DB / file divergence — admin revoke, partial-write, any
        // future cause), delete the credential file so the next reconnect
        // falls back to token-based auth. The server's recovery branch in
        // peer-handler.ts then re-issues a fresh credential. Skip on
        // config-error rejections (role mismatch, missing auth method,
        // protocol-version) where deletion would not help. Use unlinkSync
        // so the file is gone before scheduleReconnect fires via the close
        // event listener — async unlink would race the 1s initial backoff.
        if (
          msg.reason === 'Invalid proof' ||
          msg.reason === 'Unknown credential' ||
          msg.reason === 'Credential revoked'
        ) {
          try {
            unlinkSync(this.credentialFile);
            logger.warn('Deleted stale credential file after server rejection', {
              reason: msg.reason,
            });
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT') {
              logger.warn('Failed to delete stale credential file', {
                error: toErrorMessage(err),
                path: this.credentialFile,
              });
            }
          }
        }

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.close(1000, 'Auth rejected');
        }
      }
      return;
    }

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
   * (4-coordinator mesh) bug history: the previous gate was
   * `cred.coordinatorUrl === this.coordinatorUrl`, which broke the moment a
   * second peer-client on the same orchestrator tried to authenticate to a
   * different peer URL — it would see the first peer-client's credential,
   * reject it (URL mismatch), fall through to the join token, and get
   * permanently rejected because the token had already been consumed by the
   * first peer-client. The Option B fix (commit 79f93da4) keyed the match on
   * `instanceId`; this follow-up (Plan 04 Task 1 cleanup) drops the
   * `coordinatorUrl` field from the credential file schema entirely because
   * it was dead weight once the match switched to identity scope.
   */
  private async sendAuthRequest(nonce: Buffer): Promise<void> {
    if (!this.sessionKey || !this.ws) return;

    // Try to read existing credential file (shared across all peer-clients
    // for this orchestrator).
    const cred = await readCredentialFile(this.credentialFile);

    if (cred && cred.instanceId === this.instanceId) {
      // Credential-based auth (reconnection OR sibling peer-client reuse).
      // The credential is matched on our own instanceId, not the target peer
      // URL — see method doc above.
      const credentialHash = sha256(cred.credential);
      const nonceB64 = nonce.toString('base64');
      const proof = createHmac('sha256', Buffer.from(credentialHash, 'hex'))
        .update(nonceB64 + ':' + this.instanceId)
        .digest('hex');

      const authRequest = {
        type: 'peer.auth.request',
        instanceId: this.instanceId,
        protocolVersion: PROTOCOL_VERSION,
        proof,
        softwareVersion: SOFTWARE_VERSION,
        role: this.role,
      };

      logger.info('Sending credential-based auth request', {
        targetUrl: this.url,
        credentialInstanceId: cred.instanceId,
      });
      this.ws.send(encryptMessage(JSON.stringify(authRequest), this.sessionKey));
    } else if (this.joinToken) {
      // Token-based auth (first join)
      const authRequest = {
        type: 'peer.auth.request',
        instanceId: this.instanceId,
        protocolVersion: PROTOCOL_VERSION,
        token: this.joinToken,
        softwareVersion: SOFTWARE_VERSION,
        role: this.role,
      };

      logger.info('Sending token-based auth request');
      this.ws.send(encryptMessage(JSON.stringify(authRequest), this.sessionKey));
    } else {
      logger.error('No auth method available: no credential file and no join token');
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, 'No auth method');
      }
    }
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
        this.onJobProgress(msg);
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

      case 'peer.logs.collect.request': {
        void this.onLogsCollectRequest?.(msg, (out) => this.send(out));
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
}
