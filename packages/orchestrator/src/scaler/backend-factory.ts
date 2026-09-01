/**
 * The single construction path for scaler backends.
 *
 * Both startup hosts (`orchestrator-core`, `worker-core`) and
 * `ScalerManager.reload` call this, so a backend built by a reload is built
 * exactly the way startup builds one. Host differences (DB-backed vs in-memory
 * IP allocation, event support) arrive as context fields rather than forked
 * code.
 */

import { randomUUID } from 'node:crypto';
import type { createLogger, ToolRequirement } from '@kici-dev/shared';
import type { AgentTokenStore } from '../agent/token-store.js';
import { ContainerScalerBackend } from './container-backend.js';
import { BareMetalScalerBackend } from './bare-metal-backend.js';
import { FirecrackerScalerBackend } from './firecracker-backend.js';
import { EventScalerBackend } from './event-backend.js';
import type { ScalerEventEmitterLike } from './event-backend.js';
import { ClaimStore, DEFAULT_CLAIM_TTL_SECONDS } from './claim-store.js';
import type { ScalerStateStore } from './scaler-state-store.js';
import type { IpAllocator } from './ip-allocator.js';
import { ScalerBackendType } from '@kici-dev/engine';
import type { ScalerBackend, ScalerConfig, ScalerEntry } from './types.js';

/** Network parameters an IP allocator needs, resolved from `scalerConfig.firecracker`. */
export interface IpAllocatorParams {
  cidr: string;
  gateway: string;
  netmask: string;
}

export interface BackendFactoryContext {
  /** The whole config — supplies `defaults.resources` and the firecracker network block. */
  scalerConfig: ScalerConfig;
  /**
   * Always supplied when available; the event backend's claim store needs it
   * regardless of the auth mode.
   */
  tokenStore?: AgentTokenStore;
  /** True when `config.agentAuth === 'token'`; gates token injection for the three local backends. */
  injectAgentToken: boolean;
  tokenTtlMs?: number;
  /** Live per-spawn resolver for the fleet-wide agent-token TTL. */
  tokenTtlProvider: () => Promise<number>;
  /** DB-backed on the leader, in-memory on the worker. */
  ipAllocator: (params: IpAllocatorParams) => IpAllocator;
  /**
   * The already-constructed scaler state store. The event backend's claim
   * store writes its pending-claim rows through it. Absent on the worker,
   * which has no database — and so no event backend either.
   */
  stateStore?: ScalerStateStore;
  /** Absent ⇒ the `event` type is unsupported on this host (worker mode). */
  eventEmitterProvider?: () => ScalerEventEmitterLike;
  logger: ReturnType<typeof createLogger>;
}

/** Tool requirements for a set of entries, for `validateRequiredTools` from `@kici-dev/shared`. */
export function requiredToolsFor(entries: ScalerEntry[]): ToolRequirement[] {
  return entries.flatMap((s) => {
    switch (s.type) {
      case ScalerBackendType.enum.container:
        return ContainerScalerBackend.getRequiredTools(s);
      case ScalerBackendType.enum['bare-metal']:
        return BareMetalScalerBackend.getRequiredTools(s);
      case ScalerBackendType.enum.firecracker:
        return FirecrackerScalerBackend.getRequiredTools(s);
      default:
        return [];
    }
  });
}

/**
 * Construct one backend. Returns null (with a warning) when the type is not
 * supported on this host — the worker has no event emitter, and `kubernetes`
 * is not implemented.
 */
export async function createScalerBackend(
  s: ScalerEntry,
  ctx: BackendFactoryContext,
): Promise<ScalerBackend | null> {
  const tokenStore = ctx.injectAgentToken ? ctx.tokenStore : undefined;
  const shared = {
    tokenStore,
    tokenTtlMs: ctx.tokenTtlMs,
    tokenTtlProvider: ctx.tokenTtlProvider,
    roles: s.roles,
  };

  if (s.type === ScalerBackendType.enum.container) {
    return ContainerScalerBackend.create({
      name: s.name,
      labelSets: s.labelSets,
      maxAgents: s.maxAgents,
      host: s.host,
      socketPath: s.socketPath,
      runtime: s.runtime,
      defaultResources: ctx.scalerConfig.defaults?.resources,
      extraHosts: s.extraHosts,
      networkIsolation: s.networkIsolation,
      ...shared,
    });
  }

  if (s.type === ScalerBackendType.enum['bare-metal']) {
    return new BareMetalScalerBackend({
      name: s.name,
      labelSets: s.labelSets,
      maxAgents: s.maxAgents,
      defaultResources: ctx.scalerConfig.defaults?.resources,
      enforceCgroups: s.enforceCgroups,
      ...shared,
    });
  }

  if (s.type === ScalerBackendType.enum.firecracker) {
    const fcNet = ctx.scalerConfig.firecracker;
    const cidr = fcNet?.cidr ?? '10.0.0.0/24';
    const gateway = fcNet?.gateway ?? '10.0.0.1';
    const netmask = fcNet?.netmask ?? '255.255.255.0';
    return new FirecrackerScalerBackend({
      name: s.name,
      labelSets: s.labelSets,
      maxAgents: s.maxAgents,
      ipAllocator: ctx.ipAllocator({ cidr, gateway, netmask }),
      firecrackerPath: s.firecrackerPath!,
      jailerPath: s.jailerPath!,
      kernelPath: s.kernelPath!,
      chrootBaseDir: s.chrootBaseDir,
      uid: s.uid!,
      gid: s.gid!,
      vcpuCount: s.vcpuCount,
      memSizeMib: s.memSizeMib,
      bridgeName: fcNet?.bridgeName ?? 'kici-br0',
      cidr,
      gateway,
      netmask,
      table: fcNet?.table ?? 'kici',
      autoProvisionHost: fcNet?.autoProvisionHost ?? true,
      // Rootless hosts reach `ip` / `chown` / `chmod` / `nft` through `sudo -n`.
      requireSudo: s.requireSudo,
      ...shared,
    });
  }

  if (s.type === ScalerBackendType.enum.event) {
    // The event backend performs no local compute: it emits scale-up /
    // scale-down events to a provisioning workflow and mints ephemeral
    // credentials lazily through its own claim store. Both the emitter and a
    // DB-backed state store are mandatory, so the worker cannot host one.
    const store = ctx.tokenStore;
    const provider = ctx.eventEmitterProvider;
    const stateStore = ctx.stateStore;
    if (!provider || !store || !stateStore) {
      ctx.logger.warn(
        `Event scaler "${s.name}" is not supported on this host (no event emitter); skipping`,
      );
      return null;
    }
    const claimStore = new ClaimStore({
      createEphemeral: (agentId, labels, ttlMs) => store.createEphemeral(agentId, labels, ttlMs),
      stateStore,
      scalerName: s.name,
      ttlDefaultSec: s.claimTtlSeconds ?? DEFAULT_CLAIM_TTL_SECONDS,
    });
    return new EventScalerBackend({
      entry: s,
      emitter: {
        emitScalerScaleUp: (payload, targets) => provider().emitScalerScaleUp(payload, targets),
        emitScalerScaleDown: (payload, targets) => provider().emitScalerScaleDown(payload, targets),
      },
      claimStore,
      requestId: () => randomUUID(),
    });
  }

  ctx.logger.warn(`Unsupported scaler type "${s.type}" for scaler "${s.name}", skipping`);
  return null;
}
