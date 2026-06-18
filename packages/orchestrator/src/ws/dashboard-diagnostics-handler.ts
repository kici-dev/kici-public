/**
 * Handles dashboard.diagnostics requests from Platform.
 *
 * Reads the AgentRegistry for connected agent info, extracts orchestrator
 * metadata from config, and computes label gap information from the job queue.
 *
 * Returns a response matching dashboardDiagnosticsResponseSchema.
 */

import {
  hostname,
  release,
  version as osVersion,
  totalmem,
  freemem,
  cpus,
  uptime,
  userInfo,
} from 'node:os';
import type { AgentEntry, AgentRegistry } from '../agent/registry.js';
import type { AppConfig } from '../config.js';
import type { ScalerManager } from '../scaler/manager.js';
import type { ScalerConfig, ScalerEntry } from '../scaler/types.js';
import type {
  DashboardDiagnosticsResponse,
  DashboardScalerCapacityResponse,
  DashboardScalerAgentsResponse,
} from '@kici-dev/engine';
import type { PeerRegistry } from '../cluster/peer-registry.js';
import type { RaftNode } from '../cluster/raft.js';

export interface DiagnosticsHandlerDeps {
  agentRegistry: AgentRegistry;
  config: AppConfig;
  /** Orchestrator version string (e.g. "0.0.1"). */
  version: string;
  /** Unique scaler backend types (e.g. ["container", "firecracker"]). */
  scalerBackends: string[];
  /** Optional job queue for queued job count. */
  jobQueue?: {
    getDepth(): Promise<number>;
  };
  /** Optional scaler manager for agent-to-scaler mapping. */
  scalerManager?: ScalerManager | null;
  /** Optional scaler config for scaler details. */
  scalerConfig?: ScalerConfig | null;
  /** Optional peer registry for cluster coordinator mode. */
  peerRegistry?: PeerRegistry | null;
  /** Optional Raft node for cluster election state. */
  raftNode?: RaftNode | null;
}

/**
 * Build a safe config subset for a scaler entry (no secrets like socketPath, uid, gid, etc).
 * Uses an explicit allowlist to prevent accidental secret leaks.
 */
export function buildSafeScalerConfig(entry: ScalerEntry): Record<string, unknown> {
  return {
    labelSets: entry.labelSets.map((ls) => ls.labels),
    runtime: entry.runtime ?? null,
    host: entry.host ?? null,
    warmPool: entry.warmPool
      ? {
          minIdle: entry.warmPool.size,
          maxIdle: entry.warmPool.size,
          enabled: entry.warmPool.enabled,
        }
      : null,
    networkIsolation: entry.networkIsolation ?? null,
    orchestratorUrl: entry.orchestratorUrl ?? null,
    extraHosts: entry.extraHosts ?? null,
  };
}

function buildDiagnosticsAgent(
  entry: AgentEntry,
  deps: DiagnosticsHandlerDeps,
): DashboardDiagnosticsResponse['agents'][number] {
  return {
    agentId: entry.agentId,
    labels: [...entry.labels],
    platform: entry.platform,
    arch: entry.arch,
    activeJobs: entry.activeJobs,
    maxConcurrency: entry.maxConcurrency,
    lastHeartbeatAt: entry.lastHeartbeatAt,
    registeredAt: entry.registeredAt,
    version: entry.version,
    hostname: entry.hostname,
    osRelease: entry.osRelease,
    osVersion: entry.osVersion,
    totalMemoryMb: entry.totalMemoryMb,
    cpuCount: entry.cpuCount,
    nodeVersion: entry.nodeVersion,
    runningAsUser: entry.runningAsUser,
    runningAsUid: entry.runningAsUid,
    memoryUsedMb: entry.memoryUsedMb,
    memoryAvailableMb: entry.memoryAvailableMb,
    uptimeSeconds: entry.uptimeSeconds,
    scalerName: deps.scalerManager?.getBackendForAgent(entry.agentId) ?? null,
  };
}

/**
 * Build a diagnostics response for the given request.
 * When includeAgents is false (default), agents[] is empty and aggregate fields are populated.
 */
export async function handleDiagnosticsRequest(
  deps: DiagnosticsHandlerDeps,
  requestId: string,
  includeAgents?: boolean,
): Promise<DashboardDiagnosticsResponse> {
  const { agentRegistry, config, version, scalerBackends } = deps;

  // Get process identity (username + UID)
  let runningAsUser: string | null = null;
  let runningAsUid: number | null = null;
  try {
    const info = userInfo();
    runningAsUser = info.username;
    runningAsUid = info.uid;
  } catch {
    // userInfo() can throw in some environments (e.g., containers without /etc/passwd)
  }

  // Build agents array + compute aggregates from registry
  const agents: DashboardDiagnosticsResponse['agents'] = [];
  let runningJobs = 0;
  let agentCount = 0;
  let statefulAgentCount = 0;

  for (const entry of agentRegistry.getAllEntries()) {
    agentCount++;
    runningJobs += entry.activeJobs;
    const scalerName = deps.scalerManager?.getBackendForAgent(entry.agentId) ?? null;
    if (scalerName === null) {
      statefulAgentCount++;
    }
    if (includeAgents) {
      agents.push(buildDiagnosticsAgent(entry, deps));
    }
  }

  // Get queued job count
  let queuedJobs = 0;
  if (deps.jobQueue) {
    try {
      queuedJobs = await deps.jobQueue.getDepth();
    } catch {
      // If queue query fails, report 0
    }
  }

  // Build scalers array from scaler config + computed status (includes auto-injected platform labels)
  const scalerStatus = deps.scalerManager?.getStatus();
  const scalers =
    deps.scalerConfig?.scalers.map((entry) => {
      const backend = scalerStatus?.backends.find((b) => b.name === entry.name);
      return {
        name: entry.name,
        type: entry.type,
        maxAgents: entry.maxAgents,
        activeAgents: backend?.activeCount ?? 0,
        // Use computed label sets from getStatus() which include auto-injected OS/arch labels
        labelSets: backend?.labelSets ?? entry.labelSets.map((ls) => ls.labels),
        config: buildSafeScalerConfig(entry),
        // Local-spawn backends (bare-metal, Firecracker, container on a local
        // runtime socket) statically surface this orchestrator's hostname as
        // their spawning host. Backends that provision elsewhere (remote
        // container runtime, future cloud backends) carry no host.
        ...(backend?.spawnsOnLocalHost ? { hosts: [hostname()] } : {}),
      };
    }) ?? undefined;

  // Build peers array from PeerRegistry (coordinator only, connected workers only)
  const peers =
    deps.peerRegistry
      ?.getWorkerPeers()
      .filter((p) => p.connected)
      .map((peer) => ({
        instanceId: peer.instanceId,
        role: peer.role as 'coordinator' | 'worker',
        connected: peer.connected,
        lastHeartbeatAt: peer.lastHeartbeatAt,
        draining: peer.draining,
        agents: peer.agents.map((a) => ({
          agentId: a.agentId,
          labels: [...a.labels],
          platform: a.platform,
          arch: a.arch,
          activeJobs: a.activeJobs,
          maxConcurrency: a.maxConcurrency,
          scalerName: a.scalerName ?? null,
        })),
        scalerCapacity: peer.scalerCapacity,
        // OS metadata from heartbeats
        hostname: peer.hostname,
        osRelease: peer.osRelease,
        totalMemoryMb: peer.totalMemoryMb,
        memoryUsedMb: peer.memoryUsedMb,
        memoryAvailableMb: peer.memoryAvailableMb,
        cpuCount: peer.cpuCount,
        uptimeSeconds: peer.uptimeSeconds,
        nodeVersion: peer.nodeVersion,
        runningAsUser: peer.runningAsUser,
        runningAsUid: peer.runningAsUid,
        version: peer.version,
        // Raft election state from peer heartbeats
        raftTerm: peer.term,
        raftLeaderId: peer.leaderId,
        // dependencyHealth will be forwarded here once PeerInfo includes it
      })) ?? undefined;

  return {
    type: 'dashboard.diagnostics.response',
    requestId,
    orchestrator: {
      version,
      mode: config.mode ?? null,
      role: config.cluster?.role ?? null,
      scalerBackends,
      runningJobs,
      queuedJobs,
      // Label gaps: empty array for now. The job queue doesn't expose
      // per-label queued job data yet. Can be enhanced when that API exists.
      pendingLabelGaps: [],
      // Orchestrator identity and OS metadata
      instanceId: config.instanceId,
      hostname: hostname(),
      osRelease: release(),
      osVersion: osVersion(),
      totalMemoryMb: Math.round(totalmem() / (1024 * 1024)),
      cpuCount: cpus().length,
      nodeVersion: process.versions.node,
      memoryUsedMb: Math.round((totalmem() - freemem()) / (1024 * 1024)),
      memoryAvailableMb: Math.round(freemem() / (1024 * 1024)),
      uptimeSeconds: Math.round(uptime()),
      runningAsUser,
      runningAsUid,
      // Raft election state
      raftRole: deps.raftNode?.getRole() ?? null,
      raftTerm: deps.raftNode?.getCurrentTerm() ?? null,
      raftLeaderId: deps.raftNode?.getLeaderId() ?? null,
      // Agent aggregates (always populated regardless of includeAgents)
      agentCount,
      statefulAgentCount,
    },
    agents,
    scalers,
    peers,
  };
}

/**
 * Build a per-scaler capacity response for the given request.
 * Reads ScalerManager status to get active/max counts per backend.
 */
export function handleScalerCapacityRequest(
  scalerManager: ScalerManager | null,
  requestId: string,
): DashboardScalerCapacityResponse {
  if (!scalerManager) {
    return {
      type: 'dashboard.scaler.capacity.response',
      requestId,
      scalers: [],
    };
  }

  const status = scalerManager.getStatus();
  const scalers = status.backends.map((backend) => ({
    scalerType: backend.type,
    name: backend.name,
    activeAgents: backend.activeCount,
    maxAgents: backend.maxAgents,
    // History snapshots not tracked yet -- return current value as single-point
    history: [backend.activeCount],
  }));

  return {
    type: 'dashboard.scaler.capacity.response',
    requestId,
    scalers,
  };
}

/**
 * Build a per-scaler agents response for the given request.
 * When scalerName is null, returns agents not bound to any scaler (stateful agents).
 */
export function handleScalerAgentsRequest(
  deps: DiagnosticsHandlerDeps,
  requestId: string,
  scalerName: string | null,
): DashboardScalerAgentsResponse {
  const agents: DashboardScalerAgentsResponse['agents'] = [];

  for (const entry of deps.agentRegistry.getAllEntries()) {
    const binding = deps.scalerManager?.getBackendForAgent(entry.agentId) ?? null;
    if (scalerName === null ? binding === null : binding === scalerName) {
      agents.push(buildDiagnosticsAgent(entry, deps));
    }
  }

  return {
    type: 'dashboard.scaler.agents.response',
    requestId,
    scalerName,
    agents,
  };
}
