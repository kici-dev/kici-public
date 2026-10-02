/**
 * Forgetting a departed peer: `kici-admin peer forget <instance-id>`.
 *
 * Each coordinator keeps its own live peer registry, and nothing removes a
 * peer from it: a peer that left the cluster for good stays there as
 * disconnected. Forgetting drops it from the registry. It never touches the
 * peer's credential (that is `peer revoke`), so a peer that connects again
 * later is registered again as usual.
 */
import { randomUUID } from 'node:crypto';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import {
  PeerForgetOutcome,
  type PeerForgetRequest,
  type PeerForgetResponse,
} from '@kici-dev/engine';
import { z } from 'zod';
import type { PeerRegistry } from './peer-registry.js';
import {
  adopterIsLive,
  clusterViewSufficient,
  reaperFlapGraceMs,
} from '../scaler/event-provision-reaper.js';

const logger = createLogger({ prefix: 'peer-forget' });

/** What forgetting did on one coordinator. */
export interface PeerForgetResult {
  /** The coordinator that answered. */
  coordinator: string;
  outcome: PeerForgetOutcome;
  detail: string;
}

/** Local outcomes that stop a forget before it reaches any sibling. */
export const LOCAL_REFUSALS: ReadonlySet<PeerForgetOutcome> = new Set([
  PeerForgetOutcome.enum.connected,
  PeerForgetOutcome.enum.recent,
  PeerForgetOutcome.enum['acknowledgement-required'],
]);

/** A sibling's answer that never arrived, or a sibling no connection reached. */
export const PEER_FORGET_TIMEOUT = 'timeout';

/** The answer to a forget request a peer that is not a coordinator sent. */
export const PEER_FORGET_COORDINATORS_ONLY =
  'peer forget requests are accepted from coordinators only';

/** The answer of a peer with no forget handler wired. */
export const PEER_FORGET_UNHANDLED = 'peer forget requests are not handled by this peer';

/** Which window a coordinator keeps treating a silent peer as alive for. */
export const PeerLivenessWindowKind = z.enum([
  /** The peer stale window (`KICI_CLUSTER_PEER_STALE_TIMEOUT_MS`). */
  'stale-window',
  /**
   * The reroute flap grace (`reroute_flap_grace_ms`): how long a coordinator
   * waits on a disconnected peer before it force-fails a job rerouted to it or
   * fails a job instead of requeueing it for a coordinator that holds the key.
   */
  'reroute-grace',
  /**
   * The event-provision backstop's flap grace, which it gives a peer that
   * adopted provisions before it reads that peer as gone.
   */
  'adopter-grace',
]);
export type PeerLivenessWindowKind = z.infer<typeof PeerLivenessWindowKind>;

/** How long after its last heartbeat a coordinator still treats a peer as alive. */
export interface PeerLivenessWindow {
  kind: PeerLivenessWindowKind;
  windowMs: number;
}

/** What a coordinator reads to choose a peer's liveness window. */
export interface PeerLivenessSource {
  /** The peer stale window (`KICI_CLUSTER_PEER_STALE_TIMEOUT_MS`). */
  staleTimeoutMs: number;
  /** Reads the live `reroute_flap_grace_ms` setting. */
  rerouteFlapGraceMs: () => Promise<number>;
  /**
   * This coordinator's event-provision backstop, or null when it runs none.
   * `holdsAdoptedProvisions` reads whether a peer adopted provisions the
   * backstop judges by that peer's liveness.
   */
  backstop: { holdsAdoptedProvisions: (instanceId: string) => Promise<boolean> } | null;
}

/**
 * The longest window in which this coordinator still treats `instanceId` as
 * alive after its last heartbeat. Forgetting the peer inside it would cut that
 * grace short: every reader of the registry treats a peer it no longer knows
 * as gone at once.
 *
 * - A peer that adopted provisions gets the event-provision backstop's own
 *   grace (`reaperFlapGraceMs`), or the backstop tears its instances down.
 * - Any other peer gets the longer of the stale window and the reroute flap
 *   grace, which the rerouted-job guard and the master-key requeue give every
 *   disconnected peer whether or not this coordinator runs a backstop.
 */
export async function peerLivenessWindow(
  instanceId: string,
  source: PeerLivenessSource,
): Promise<PeerLivenessWindow> {
  const rerouteGraceMs = await source.rerouteFlapGraceMs();
  if (source.backstop && (await source.backstop.holdsAdoptedProvisions(instanceId))) {
    return {
      kind: PeerLivenessWindowKind.enum['adopter-grace'],
      windowMs: reaperFlapGraceMs(rerouteGraceMs, source.staleTimeoutMs),
    };
  }
  return rerouteGraceMs > source.staleTimeoutMs
    ? { kind: PeerLivenessWindowKind.enum['reroute-grace'], windowMs: rerouteGraceMs }
    : { kind: PeerLivenessWindowKind.enum['stale-window'], windowMs: source.staleTimeoutMs };
}

/** The checks a coordinator runs before it forgets a peer. */
export interface PeerForgetGuards {
  /**
   * How long after its last heartbeat the peer is still treated as alive. A
   * peer heard from inside it may be partitioned rather than gone, so it is kept.
   */
  liveness: PeerLivenessWindow;
  /**
   * This coordinator's event-provision backstop, or null when it runs none.
   * `configuredPeerCount` is the `KICI_CLUSTER_PEERS` count the backstop's
   * cluster-view check reads beside the live registry.
   */
  backstop: { configuredPeerCount: number } | null;
  /** The operator acknowledged that the forget may switch the backstop back on. */
  acknowledgeBackstop: boolean;
  /** The current time; tests pin it. */
  nowMs?: number;
}

/**
 * The guards for forgetting `instanceId` on one coordinator, built from its
 * cluster config, the live reroute flap grace and its event-provision
 * backstop. The backstop runs on every coordinator that runs a scaler manager.
 */
export async function peerForgetGuards(
  instanceId: string,
  cluster: { peerStaleTimeoutMs: number; peers: readonly unknown[] },
  liveness: Omit<PeerLivenessSource, 'staleTimeoutMs'>,
  acknowledgeBackstop: boolean,
): Promise<PeerForgetGuards> {
  return {
    liveness: await peerLivenessWindow(instanceId, {
      staleTimeoutMs: cluster.peerStaleTimeoutMs,
      ...liveness,
    }),
    backstop: liveness.backstop ? { configuredPeerCount: cluster.peers.length } : null,
    acknowledgeBackstop,
  };
}

/** Why a peer inside its liveness window is kept, naming the window. */
function livenessWindowName(liveness: PeerLivenessWindow): string {
  const seconds = Math.round(liveness.windowMs / 1000);
  switch (liveness.kind) {
    case PeerLivenessWindowKind.enum['adopter-grace']:
      return `the ${seconds} s grace the event-provision backstop gives a peer that adopted provisions`;
    case PeerLivenessWindowKind.enum['reroute-grace']:
      return `the ${seconds} s reroute flap grace (reroute_flap_grace_ms) a coordinator gives a disconnected peer`;
    case PeerLivenessWindowKind.enum['stale-window']:
      return `the ${seconds} s stale window`;
  }
}

/** What forgetting a peer that would switch the backstop back on does. */
export function backstopConsequence(instanceId: string): string {
  return (
    `${instanceId} is the last coordinator peer this coordinator knows: forgetting it switches ` +
    'the event-provision backstop back on, which tears down the instances of provisions whose ' +
    'agent it cannot see. If that coordinator is still running behind a network partition, ' +
    'its adopted instances are torn down.'
  );
}

/**
 * Whether forgetting `instanceId` switches the event-provision backstop back
 * on. The backstop stands down while it knows coordinator peers and is
 * connected to none (`canReapForCluster`): removing the last known one leaves
 * it nothing to wait for.
 */
function forgetReArmsBackstop(
  registry: PeerRegistry,
  instanceId: string,
  backstop: { configuredPeerCount: number },
): boolean {
  const known = registry.getCoordinatorPeers();
  const connected = registry.getConnectedCoordinatorPeerCount();
  const isKnownCoordinator = known.some((peer) => peer.instanceId === instanceId);
  const before = clusterViewSufficient(
    Math.max(backstop.configuredPeerCount, known.length),
    connected,
  );
  const after = clusterViewSufficient(
    Math.max(backstop.configuredPeerCount, known.length - (isKnownCoordinator ? 1 : 0)),
    connected,
  );
  return !before && after;
}

/**
 * Drop `instanceId` from `registry` when it names a peer that left the
 * cluster. Kept, with the reason: a connected peer (its next heartbeat would
 * register it again), a peer heard from inside its liveness window (it may be
 * partitioned rather than gone; see `peerLivenessWindow`), and a peer whose removal would switch the
 * event-provision backstop back on, unless the request acknowledged that.
 */
export function forgetDepartedPeer(
  registry: PeerRegistry,
  selfInstanceId: string,
  instanceId: string,
  guards: PeerForgetGuards,
): Omit<PeerForgetResult, 'coordinator'> {
  if (instanceId === selfInstanceId) {
    return {
      outcome: PeerForgetOutcome.enum.error,
      detail: `${instanceId} is this coordinator; a coordinator does not forget itself`,
    };
  }
  const peer = registry.getPeer(instanceId);
  if (!peer) {
    return {
      outcome: PeerForgetOutcome.enum['not-found'],
      detail: `${instanceId} is not in this coordinator's peer registry`,
    };
  }
  if (peer.connected) {
    return {
      outcome: PeerForgetOutcome.enum.connected,
      detail: `${instanceId} is connected; only a peer that left the cluster can be forgotten`,
    };
  }
  const nowMs = guards.nowMs ?? Date.now();
  // The backstop's own liveness test, over the window it gives this peer.
  if (adopterIsLive(peer, nowMs, guards.liveness.windowMs)) {
    const silentMs = nowMs - peer.lastHeartbeatAt;
    return {
      outcome: PeerForgetOutcome.enum.recent,
      detail:
        `${instanceId} was last heard from ${Math.round(silentMs / 1000)} s ago ` +
        `(${new Date(peer.lastHeartbeatAt).toISOString()}), inside ` +
        `${livenessWindowName(guards.liveness)}; it may be partitioned rather than gone, ` +
        'so it is kept. Forget it once the window has passed.',
    };
  }
  if (
    guards.backstop &&
    !guards.acknowledgeBackstop &&
    forgetReArmsBackstop(registry, instanceId, guards.backstop)
  ) {
    return {
      outcome: PeerForgetOutcome.enum['acknowledgement-required'],
      detail: `${backstopConsequence(instanceId)} Acknowledge it to forget the peer.`,
    };
  }
  registry.removePeer(instanceId);
  return { outcome: PeerForgetOutcome.enum.forgotten, detail: `${instanceId} forgotten` };
}

/** Answers a forget request a sibling coordinator fanned out. */
export type PeerForgetRequestHandler = (
  msg: PeerForgetRequest,
) => Promise<{ outcome: PeerForgetOutcome; detail: string }>;

/**
 * Answer one forget request with `handler`. A coordinator with no handler
 * answers {@link PEER_FORGET_UNHANDLED}, and a handler that fails (its guards
 * read the database) answers `error`, so the peer is kept and the operator
 * sees why.
 */
export function replyToPeerForgetRequest(
  msg: PeerForgetRequest,
  handler: PeerForgetRequestHandler | undefined,
  send: (response: PeerForgetResponse) => void,
  logFields: Record<string, unknown> = {},
): void {
  const reply = (result: { outcome: PeerForgetOutcome; detail: string }): void => {
    send({ type: 'peer.forget.response', messageId: msg.messageId, ...result });
  };
  if (!handler) {
    reply({ outcome: PeerForgetOutcome.enum.error, detail: PEER_FORGET_UNHANDLED });
    return;
  }
  handler(msg).then(reply, (err: unknown) => {
    logger.error('Error answering a peer forget request', {
      ...logFields,
      instanceId: msg.instanceId,
      error: toErrorMessage(err),
    });
    reply({
      outcome: PeerForgetOutcome.enum.error,
      detail: `could not check ${msg.instanceId}, so it is kept: ${toErrorMessage(err)}`,
    });
  });
}

/**
 * Sends one forget request to a sibling coordinator and waits for its answer.
 * Resolves null when no connection reached the sibling, and
 * {@link PEER_FORGET_TIMEOUT} when it did not answer within `timeoutMs`.
 */
export type SendPeerForget = (
  siblingInstanceId: string,
  msg: PeerForgetRequest,
  timeoutMs: number,
) => Promise<PeerForgetResponse | null | typeof PEER_FORGET_TIMEOUT>;

/**
 * Forget `instanceId` on this coordinator, then on every connected sibling
 * coordinator, each of which holds its own registry. A peer this coordinator
 * still has connected is refused and not fanned out. The first result is this
 * coordinator's.
 */
export async function forgetAcrossCoordinators(
  registry: PeerRegistry,
  selfInstanceId: string,
  instanceId: string,
  timeoutMs: number,
  guards: PeerForgetGuards,
  send: SendPeerForget,
): Promise<PeerForgetResult[]> {
  const local: PeerForgetResult = {
    coordinator: selfInstanceId,
    ...forgetDepartedPeer(registry, selfInstanceId, instanceId, guards),
  };
  // A peer this coordinator keeps for a reason the operator must act on is not
  // fanned out: nothing changes anywhere.
  if (LOCAL_REFUSALS.has(local.outcome)) return [local];
  const siblings = registry
    .getCoordinatorPeers()
    .filter((peer) => peer.connected && peer.instanceId !== instanceId);
  const remote = await Promise.all(
    siblings.map(async (peer): Promise<PeerForgetResult> => {
      const response = await send(
        peer.instanceId,
        {
          type: 'peer.forget.request',
          messageId: randomUUID(),
          instanceId,
          ...(guards.acknowledgeBackstop ? { acknowledgeBackstop: true } : {}),
        },
        timeoutMs,
      );
      if (response === null || response === PEER_FORGET_TIMEOUT) {
        return {
          coordinator: peer.instanceId,
          outcome: PeerForgetOutcome.enum.error,
          detail:
            response === null
              ? 'no connection reached this coordinator'
              : `no answer within ${timeoutMs} ms; it may run a version without peer forget`,
        };
      }
      return { coordinator: peer.instanceId, outcome: response.outcome, detail: response.detail };
    }),
  );
  return [local, ...remote];
}

/**
 * The coordinator peers the cluster expects but this coordinator has no live
 * link to: registered coordinators whose connection is down.
 */
export function disconnectedCoordinatorIds(
  registry: PeerRegistry,
  selfInstanceId: string,
): string[] {
  return registry
    .getCoordinatorPeers()
    .filter((peer) => !peer.connected && peer.instanceId !== selfInstanceId)
    .map((peer) => peer.instanceId)
    .sort();
}

/** Pending forget requests sent to siblings, keyed by message id. */
export class PeerForgetWaiters {
  private readonly waiters = new Map<
    string,
    {
      resolve: (response: PeerForgetResponse | typeof PEER_FORGET_TIMEOUT) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /** Wait for the response to `messageId`, or {@link PEER_FORGET_TIMEOUT}. */
  wait(
    messageId: string,
    timeoutMs: number,
  ): Promise<PeerForgetResponse | typeof PEER_FORGET_TIMEOUT> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(messageId);
        resolve(PEER_FORGET_TIMEOUT);
      }, timeoutMs);
      timer.unref?.();
      this.waiters.set(messageId, { resolve, timer });
    });
  }

  /** Hand a response to the request waiting for it. An unknown id is dropped. */
  resolve(response: PeerForgetResponse): void {
    const waiter = this.waiters.get(response.messageId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(response.messageId);
    waiter.resolve(response);
  }

  /** End every pending wait with an `error` response naming `reason`. */
  rejectAll(reason: string): void {
    for (const [messageId, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({
        type: 'peer.forget.response',
        messageId,
        outcome: PeerForgetOutcome.enum.error,
        detail: reason,
      });
    }
    this.waiters.clear();
  }
}
