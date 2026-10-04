/**
 * Platform peer discovery for a coordinator.
 *
 * An address the Platform announces is a hint. The client dialled for it
 * counts as a peer only after mutual authentication succeeds and the server
 * reports the announced instance id. A target that fails mutual
 * authentication is dropped and dialled again only when the Platform
 * announces it again, at most once per redial window. A statically
 * configured client owns its peer: discovery never replaces it.
 *
 * A re-announcement at a different address for a connected peer is dialled as
 * a candidate, and replaces the working client only after it authenticates.
 * Discovered clients and candidates are capped, and a discovered client that
 * stays unconnected for the idle window is dropped; a peer that comes back
 * registers with the Platform again, which announces it again.
 */
import { createLogger } from '@kici-dev/shared';
import { OrchRole } from '@kici-dev/engine';
import { PeerDiscoveryMode } from '../config/schema.js';

const logger = createLogger({ prefix: 'peer-discovery' });

/** Discovered clients plus pending candidates, far above any real coordinator count. */
export const MAX_DISCOVERED_PEER_CLIENTS = 64;
/** A discovered client not connected for this long is dropped; a returning peer is announced again. */
export const DISCOVERED_PEER_IDLE_PRUNE_MS = 15 * 60_000;

/** The client state in which a peer is mutually authenticated. */
const CONNECTED_STATE = 'connected';

/** What discovery needs from a peer client. */
export interface DiscoveryPeerClient {
  readonly state: string;
  connect(): void;
  disconnect(): void;
}

/** Hooks a discovered client calls back. */
export interface DiscoveredClientHooks {
  /** Mutual authentication succeeded with the announced instance id. */
  onAuthenticated: () => void;
  /** Mutual authentication failed; the client closed and will not reconnect. */
  onMutualAuthFailed: () => void;
}

/** One peer the Platform announced. */
export interface PeerAnnouncement {
  instanceId?: string;
  address?: string | null;
  orchRole?: OrchRole;
}

export interface PeerDiscoveryDeps {
  mode: PeerDiscoveryMode;
  selfInstanceId: string;
  /** Every outbound peer client. Static clients sit under their URL until they authenticate. */
  peerClients: Map<string, DiscoveryPeerClient>;
  createClient: (
    address: string,
    expectedInstanceId: string,
    hooks: DiscoveredClientHooks,
  ) => DiscoveryPeerClient;
  /** Minimum time between dials of an address whose last discovered dial failed mutual authentication. */
  redialAfterFailureMs: number;
  maxClients?: number;
  idlePruneMs?: number;
  now?: () => number;
}

interface DiscoveredEntry {
  client: DiscoveryPeerClient;
  address: string;
  /** Last time this client was seen connected, or when it was created. */
  lastGoodAt: number;
}

export class PeerDiscovery {
  private readonly discovered = new Map<string, DiscoveredEntry>();
  private readonly candidates = new Map<string, DiscoveredEntry>();
  /** Address -> when its last discovered dial failed mutual authentication. */
  private readonly failedAt = new Map<string, number>();
  private readonly maxClients: number;
  private readonly idlePruneMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: PeerDiscoveryDeps) {
    this.maxClients = deps.maxClients ?? MAX_DISCOVERED_PEER_CLIENTS;
    this.idlePruneMs = deps.idlePruneMs ?? DISCOVERED_PEER_IDLE_PRUNE_MS;
    this.now = deps.now ?? Date.now;
  }

  announce(peer: PeerAnnouncement): void {
    // Workers dial out to every coordinator and host no /ws/peer server.
    if (peer.orchRole === OrchRole.enum.worker) return;
    const { instanceId, address } = peer;
    if (!address || !instanceId || instanceId === this.deps.selfInstanceId) return;
    if (this.deps.mode === PeerDiscoveryMode.enum.static) {
      logger.info('Peer announcement not dialled: KICI_CLUSTER_PEER_DISCOVERY is static', {
        instanceId,
        address,
      });
      return;
    }
    this.pruneIdle();
    if (this.deps.peerClients.has(instanceId) && !this.discovered.has(instanceId)) {
      logger.debug('Peer announcement ignored: a statically configured client owns this peer', {
        instanceId,
      });
      return;
    }
    const failed = this.failedAt.get(address);
    if (failed !== undefined && this.now() - failed < this.deps.redialAfterFailureMs) {
      logger.info(
        'Peer announcement not dialled: this address recently failed mutual authentication',
        { instanceId, address },
      );
      return;
    }
    const existing = this.discovered.get(instanceId);
    if (existing && existing.client.state === CONNECTED_STATE) {
      if (existing.address !== address) this.dialCandidate(instanceId, address);
      return;
    }
    // Not connected: replace it at once, which also resets its reconnect backoff.
    if (existing) this.drop(instanceId);
    if (this.size() >= this.maxClients) {
      logger.warn('Peer announcement ignored: discovered peer client limit reached', {
        instanceId,
        limit: this.maxClients,
      });
      return;
    }
    this.dialDiscovered(instanceId, address);
  }

  /** A static client authenticated as this peer: discovery lets go of it. */
  releaseToStatic(instanceId: string): void {
    this.dropCandidate(instanceId);
    if (this.discovered.has(instanceId)) this.drop(instanceId);
  }

  /** Drop discovered clients and candidates that stayed unconnected for the idle window. */
  pruneIdle(): void {
    const now = this.now();
    for (const [instanceId, entry] of this.discovered) {
      if (entry.client.state === CONNECTED_STATE) {
        entry.lastGoodAt = now;
      } else if (now - entry.lastGoodAt > this.idlePruneMs) {
        logger.info('Dropping a discovered peer that has not connected within the idle window', {
          instanceId,
          address: entry.address,
        });
        this.drop(instanceId);
      }
    }
    for (const [instanceId, entry] of this.candidates) {
      if (entry.client.state !== CONNECTED_STATE && now - entry.lastGoodAt > this.idlePruneMs) {
        this.dropCandidate(instanceId);
      }
    }
    for (const [address, at] of this.failedAt) {
      if (now - at >= this.deps.redialAfterFailureMs) this.failedAt.delete(address);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => this.pruneIdle(),
      Math.max(1_000, Math.floor(this.idlePruneMs / 3)),
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const instanceId of [...this.candidates.keys()]) this.dropCandidate(instanceId);
  }

  private size(): number {
    return this.discovered.size + this.candidates.size;
  }

  private dialDiscovered(instanceId: string, address: string): void {
    const entry: DiscoveredEntry = { client: undefined as never, address, lastGoodAt: this.now() };
    entry.client = this.deps.createClient(address, instanceId, {
      onAuthenticated: () => {
        entry.lastGoodAt = this.now();
      },
      onMutualAuthFailed: () => {
        this.failedAt.set(address, this.now());
        if (this.discovered.get(instanceId) === entry) {
          this.discovered.delete(instanceId);
          if (this.deps.peerClients.get(instanceId) === entry.client) {
            this.deps.peerClients.delete(instanceId);
          }
        }
      },
    });
    this.discovered.set(instanceId, entry);
    this.deps.peerClients.set(instanceId, entry.client);
    entry.client.connect();
    logger.info('Dialling a discovered peer', { instanceId, address });
  }

  private dialCandidate(instanceId: string, address: string): void {
    const pending = this.candidates.get(instanceId);
    if (pending?.address === address) return;
    if (pending) this.dropCandidate(instanceId);
    if (this.size() >= this.maxClients) {
      logger.warn('Peer announcement ignored: discovered peer client limit reached', {
        instanceId,
        limit: this.maxClients,
      });
      return;
    }
    const entry: DiscoveredEntry = { client: undefined as never, address, lastGoodAt: this.now() };
    entry.client = this.deps.createClient(address, instanceId, {
      onAuthenticated: () => this.promote(instanceId, entry),
      onMutualAuthFailed: () => {
        this.failedAt.set(address, this.now());
        if (this.candidates.get(instanceId) === entry) this.candidates.delete(instanceId);
        logger.warn(
          'A new address announced for a connected peer failed mutual authentication; keeping the working link',
          { instanceId, address },
        );
      },
    });
    this.candidates.set(instanceId, entry);
    entry.client.connect();
    logger.info('Dialling a newly announced address for a connected peer', {
      instanceId,
      address,
    });
  }

  /**
   * The candidate authenticated. It runs before the candidate registers the
   * peer, so the replaced client disconnects first.
   */
  private promote(instanceId: string, entry: DiscoveredEntry): void {
    if (this.candidates.get(instanceId) !== entry) return;
    this.candidates.delete(instanceId);
    const previous = this.discovered.get(instanceId);
    entry.lastGoodAt = this.now();
    this.discovered.set(instanceId, entry);
    this.deps.peerClients.set(instanceId, entry.client);
    previous?.client.disconnect();
    logger.info('Moved a discovered peer to its newly announced address', {
      instanceId,
      address: entry.address,
    });
  }

  private drop(instanceId: string): void {
    const entry = this.discovered.get(instanceId);
    if (!entry) return;
    this.discovered.delete(instanceId);
    if (this.deps.peerClients.get(instanceId) === entry.client) {
      this.deps.peerClients.delete(instanceId);
    }
    entry.client.disconnect();
  }

  private dropCandidate(instanceId: string): void {
    const entry = this.candidates.get(instanceId);
    if (!entry) return;
    this.candidates.delete(instanceId);
    entry.client.disconnect();
  }
}
