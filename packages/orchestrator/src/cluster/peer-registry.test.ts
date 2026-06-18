import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PeerRegistry } from './peer-registry.js';
import type { PeerHeartbeat } from '@kici-dev/engine';

describe('PeerRegistry', () => {
  let registry: PeerRegistry;

  beforeEach(() => {
    registry = new PeerRegistry();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-18T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── addPeer / removePeer lifecycle ──────────────────────────────────

  describe('addPeer / removePeer', () => {
    it('should add a peer and retrieve it', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: 'ws://192.168.1.10:8080',
        routingKeys: ['github:42'],
      });

      const peer = registry.getPeer('orch-1');
      expect(peer).toBeDefined();
      expect(peer!.instanceId).toBe('orch-1');
      expect(peer!.connectionId).toBe('conn-1');
      expect(peer!.address).toBe('ws://192.168.1.10:8080');
      expect(peer!.routingKeys).toEqual(['github:42']);
      expect(peer!.connected).toBe(true);
      expect(peer!.agents).toEqual([]);
      expect(peer!.draining).toBe(false);
      expect(peer!.capabilities).toEqual({ s3LogAccess: false });
      expect(peer!.term).toBe(0);
      expect(peer!.leaderId).toBeNull();
    });

    it('should reset capabilities on re-add (clean reconnect)', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: 'ws://192.168.1.10:8080',
        routingKeys: ['github:42'],
      });

      // Simulate heartbeat to add agents
      const heartbeat: PeerHeartbeat = {
        type: 'peer.heartbeat',
        instanceId: 'orch-1',
        term: 1,
        leaderId: 'orch-1',
        draining: false,
        agents: [
          {
            agentId: 'agent-1',
            labels: ['linux', 'x64'],
            activeJobs: 0,
            maxConcurrency: 2,
            platform: 'linux',
            arch: 'x64',
          },
        ],
        capabilities: { s3LogAccess: true },
        timestamp: Date.now(),
      };
      registry.updateHeartbeat('orch-1', heartbeat);

      // Disconnect first, then re-add (realistic reconnect scenario)
      registry.markDisconnected('orch-1');

      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-2',
        address: 'ws://192.168.1.10:8080',
        routingKeys: ['github:42', 'github:99'],
      });

      const peer = registry.getPeer('orch-1');
      expect(peer!.connectionId).toBe('conn-2');
      expect(peer!.routingKeys).toEqual(['github:42', 'github:99']);
      // Clean start — agents and capabilities reset
      expect(peer!.agents).toEqual([]);
      expect(peer!.draining).toBe(false);
      expect(peer!.capabilities).toEqual({ s3LogAccess: false });
      expect(peer!.scalerCapacity).toBeUndefined();
    });

    it('should remove a peer', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      expect(registry.getPeerCount()).toBe(1);

      registry.removePeer('orch-1');

      expect(registry.getPeer('orch-1')).toBeUndefined();
      expect(registry.getPeerCount()).toBe(0);
    });

    it('should handle removing a non-existent peer gracefully', () => {
      registry.removePeer('non-existent');
      expect(registry.getPeerCount()).toBe(0);
    });

    it('should handle null address', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      expect(registry.getPeer('orch-1')!.address).toBeNull();
    });
  });

  // ── updateHeartbeat ─────────────────────────────────────────────────

  describe('updateHeartbeat', () => {
    it('should update agent inventory from heartbeat', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      const heartbeat: PeerHeartbeat = {
        type: 'peer.heartbeat',
        instanceId: 'orch-1',
        term: 2,
        leaderId: 'orch-2',
        draining: true,
        agents: [
          {
            agentId: 'agent-1',
            labels: ['linux', 'gpu'],
            activeJobs: 1,
            maxConcurrency: 4,
            platform: 'linux',
            arch: 'x64',
          },
          {
            agentId: 'agent-2',
            labels: ['darwin'],
            activeJobs: 0,
            maxConcurrency: 2,
            platform: 'darwin',
            arch: 'arm64',
          },
        ],
        capabilities: { s3LogAccess: true, logRoutingOverride: 'direct' },
        timestamp: 1700000000000,
      };

      registry.updateHeartbeat('orch-1', heartbeat);

      const peer = registry.getPeer('orch-1');
      expect(peer!.agents).toHaveLength(2);
      expect(peer!.agents[0].agentId).toBe('agent-1');
      expect(peer!.agents[0].labels).toEqual(['linux', 'gpu']);
      expect(peer!.agents[0].activeJobs).toBe(1);
      expect(peer!.agents[0].maxConcurrency).toBe(4);
      expect(peer!.agents[1].agentId).toBe('agent-2');
      expect(peer!.draining).toBe(true);
      expect(peer!.capabilities).toEqual({
        s3LogAccess: true,
        logRoutingOverride: 'direct',
      });
      expect(peer!.term).toBe(2);
      expect(peer!.leaderId).toBe('orch-2');
      expect(peer!.lastHeartbeatAt).toBe(1700000000000);
    });

    it('carries the per-agent scaler binding (null for static agents)', () => {
      // Diagnostics groups a peer's agents under the correct scaler row, so the
      // heartbeat's per-agent scalerName must survive into the registry. Legacy
      // peers that omit the field surface as null (treated as static/stateful).
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      registry.updateHeartbeat('orch-1', {
        type: 'peer.heartbeat',
        instanceId: 'orch-1',
        term: 0,
        leaderId: null,
        draining: false,
        agents: [
          {
            agentId: 'scaler-agent',
            labels: ['linux'],
            activeJobs: 0,
            maxConcurrency: 1,
            platform: 'linux',
            arch: 'x64',
            scalerName: 'stg-container',
          },
          {
            agentId: 'static-agent',
            labels: ['linux'],
            activeJobs: 0,
            maxConcurrency: 1,
            platform: 'linux',
            arch: 'x64',
            // scalerName omitted — legacy / static agent.
          },
        ],
        capabilities: { s3LogAccess: false },
        timestamp: 1700000000000,
      });

      const peer = registry.getPeer('orch-1');
      expect(peer!.agents.find((a) => a.agentId === 'scaler-agent')!.scalerName).toBe(
        'stg-container',
      );
      expect(peer!.agents.find((a) => a.agentId === 'static-agent')!.scalerName).toBeNull();
    });

    it('should replace previous agent inventory on heartbeat update', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      // First heartbeat with 2 agents
      registry.updateHeartbeat('orch-1', {
        type: 'peer.heartbeat',
        instanceId: 'orch-1',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [
          {
            agentId: 'agent-1',
            labels: ['linux'],
            activeJobs: 0,
            maxConcurrency: 2,
            platform: 'linux',
            arch: 'x64',
          },
          {
            agentId: 'agent-2',
            labels: ['linux'],
            activeJobs: 0,
            maxConcurrency: 2,
            platform: 'linux',
            arch: 'x64',
          },
        ],
        capabilities: { s3LogAccess: false },
        timestamp: Date.now(),
      });

      expect(registry.getPeer('orch-1')!.agents).toHaveLength(2);

      // Second heartbeat with 1 agent (agent-2 went away)
      registry.updateHeartbeat('orch-1', {
        type: 'peer.heartbeat',
        instanceId: 'orch-1',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [
          {
            agentId: 'agent-1',
            labels: ['linux'],
            activeJobs: 1,
            maxConcurrency: 2,
            platform: 'linux',
            arch: 'x64',
          },
        ],
        capabilities: { s3LogAccess: false },
        timestamp: Date.now(),
      });

      expect(registry.getPeer('orch-1')!.agents).toHaveLength(1);
      expect(registry.getPeer('orch-1')!.agents[0].activeJobs).toBe(1);
    });

    it('should ignore heartbeat for unknown peer', () => {
      registry.updateHeartbeat('unknown', {
        type: 'peer.heartbeat',
        instanceId: 'unknown',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        timestamp: Date.now(),
      });

      expect(registry.getPeer('unknown')).toBeUndefined();
    });
  });

  // ── configVersion tracking ────────────────────────────────────────

  describe('configVersion', () => {
    it('should initialize configVersion to 0', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      expect(registry.getPeer('orch-1')!.configVersion).toBe(0);
    });

    it('should update configVersion from heartbeat', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      registry.updateHeartbeat('orch-1', {
        type: 'peer.heartbeat',
        instanceId: 'orch-1',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        configVersion: 5,
        timestamp: Date.now(),
      });

      expect(registry.getPeer('orch-1')!.configVersion).toBe(5);
    });

    it('should treat missing configVersion as 0 (backward compat)', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      registry.updateHeartbeat('orch-1', {
        type: 'peer.heartbeat',
        instanceId: 'orch-1',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        // no configVersion field
        timestamp: Date.now(),
      });

      expect(registry.getPeer('orch-1')!.configVersion).toBe(0);
    });

    it('should reset configVersion on reconnect (clean start)', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      registry.updateHeartbeat('orch-1', {
        type: 'peer.heartbeat',
        instanceId: 'orch-1',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        configVersion: 3,
        timestamp: Date.now(),
      });

      // Disconnect, then reconnect — starts clean
      registry.markDisconnected('orch-1');
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-2',
        address: null,
        routingKeys: [],
      });

      expect(registry.getPeer('orch-1')!.configVersion).toBe(0);
    });

    it('should call onConfigVersionBehind when peer has newer version', () => {
      const callback = vi.fn();
      const reg = new PeerRegistry({ onConfigVersionBehind: callback });
      reg.setLocalConfigVersion(2);

      reg.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      reg.updateHeartbeat('orch-1', {
        type: 'peer.heartbeat',
        instanceId: 'orch-1',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        configVersion: 5,
        timestamp: Date.now(),
      });

      expect(callback).toHaveBeenCalledWith(5);
    });

    it('should NOT call onConfigVersionBehind when versions are equal', () => {
      const callback = vi.fn();
      const reg = new PeerRegistry({ onConfigVersionBehind: callback });
      reg.setLocalConfigVersion(3);

      reg.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      reg.updateHeartbeat('orch-1', {
        type: 'peer.heartbeat',
        instanceId: 'orch-1',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        configVersion: 3,
        timestamp: Date.now(),
      });

      expect(callback).not.toHaveBeenCalled();
    });

    it('should NOT call onConfigVersionBehind when local version is 0 (unknown)', () => {
      const callback = vi.fn();
      const reg = new PeerRegistry({ onConfigVersionBehind: callback });
      // localConfigVersion defaults to 0

      reg.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      reg.updateHeartbeat('orch-1', {
        type: 'peer.heartbeat',
        instanceId: 'orch-1',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        configVersion: 5,
        timestamp: Date.now(),
      });

      expect(callback).not.toHaveBeenCalled();
    });

    it('should NOT call onConfigVersionBehind when peer version is 0 (legacy)', () => {
      const callback = vi.fn();
      const reg = new PeerRegistry({ onConfigVersionBehind: callback });
      reg.setLocalConfigVersion(3);

      reg.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      reg.updateHeartbeat('orch-1', {
        type: 'peer.heartbeat',
        instanceId: 'orch-1',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        configVersion: 0,
        timestamp: Date.now(),
      });

      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ── registryVersion tracking ────────────────────────────────────────

  describe('registryVersion', () => {
    it('should initialize registryVersion to 0', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      expect(registry.getPeer('orch-1')!.registryVersion).toBe(0);
    });

    it('should update registryVersion from heartbeat', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      registry.updateHeartbeat('orch-1', {
        type: 'peer.heartbeat',
        instanceId: 'orch-1',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        registryVersion: 7,
        timestamp: Date.now(),
      });

      expect(registry.getPeer('orch-1')!.registryVersion).toBe(7);
    });

    it('should treat missing registryVersion as 0 (backward compat)', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      registry.updateHeartbeat('orch-1', {
        type: 'peer.heartbeat',
        instanceId: 'orch-1',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        // no registryVersion field
        timestamp: Date.now(),
      });

      expect(registry.getPeer('orch-1')!.registryVersion).toBe(0);
    });

    it('should reset registryVersion on reconnect (clean start)', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      registry.updateHeartbeat('orch-1', {
        type: 'peer.heartbeat',
        instanceId: 'orch-1',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        registryVersion: 4,
        timestamp: Date.now(),
      });

      // Disconnect, then reconnect — starts clean
      registry.markDisconnected('orch-1');
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-2',
        address: null,
        routingKeys: [],
      });

      expect(registry.getPeer('orch-1')!.registryVersion).toBe(0);
    });

    it('should call onRegistryVersionBehind when peer has newer version', () => {
      const callback = vi.fn();
      const reg = new PeerRegistry({ onRegistryVersionBehind: callback });
      reg.setLocalRegistryVersion(2);

      reg.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      reg.updateHeartbeat('orch-1', {
        type: 'peer.heartbeat',
        instanceId: 'orch-1',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        registryVersion: 5,
        timestamp: Date.now(),
      });

      expect(callback).toHaveBeenCalledWith(5);
    });

    it('should NOT call onRegistryVersionBehind when versions are equal', () => {
      const callback = vi.fn();
      const reg = new PeerRegistry({ onRegistryVersionBehind: callback });
      reg.setLocalRegistryVersion(3);

      reg.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      reg.updateHeartbeat('orch-1', {
        type: 'peer.heartbeat',
        instanceId: 'orch-1',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        registryVersion: 3,
        timestamp: Date.now(),
      });

      expect(callback).not.toHaveBeenCalled();
    });

    it('should NOT call onRegistryVersionBehind when local version is 0 (unknown)', () => {
      const callback = vi.fn();
      const reg = new PeerRegistry({ onRegistryVersionBehind: callback });
      // localRegistryVersion defaults to 0

      reg.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      reg.updateHeartbeat('orch-1', {
        type: 'peer.heartbeat',
        instanceId: 'orch-1',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        registryVersion: 5,
        timestamp: Date.now(),
      });

      expect(callback).not.toHaveBeenCalled();
    });

    it('should NOT call onRegistryVersionBehind when peer version is 0 (legacy)', () => {
      const callback = vi.fn();
      const reg = new PeerRegistry({ onRegistryVersionBehind: callback });
      reg.setLocalRegistryVersion(3);

      reg.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      reg.updateHeartbeat('orch-1', {
        type: 'peer.heartbeat',
        instanceId: 'orch-1',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        registryVersion: 0,
        timestamp: Date.now(),
      });

      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ── findPeersWithCapacity ───────────────────────────────────────────

  describe('findPeersWithCapacity', () => {
    function addPeerWithAgents(
      instanceId: string,
      agents: Array<{
        agentId: string;
        labels: string[];
        activeJobs: number;
        maxConcurrency: number;
      }>,
      opts?: { draining?: boolean; connected?: boolean },
    ) {
      registry.addPeer({
        instanceId,
        connectionId: `conn-${instanceId}`,
        address: null,
        routingKeys: [],
      });

      registry.updateHeartbeat(instanceId, {
        type: 'peer.heartbeat',
        instanceId,
        term: 1,
        leaderId: null,
        draining: opts?.draining ?? false,
        agents: agents.map((a) => ({
          ...a,
          platform: 'linux',
          arch: 'x64',
        })),
        capabilities: { s3LogAccess: false },
        timestamp: Date.now(),
      });

      if (opts?.connected === false) {
        registry.markDisconnected(instanceId);
      }
    }

    it('should find peers with exact label match and capacity', () => {
      addPeerWithAgents('orch-1', [
        { agentId: 'a1', labels: ['linux', 'x64'], activeJobs: 0, maxConcurrency: 2 },
      ]);
      addPeerWithAgents('orch-2', [
        { agentId: 'a2', labels: ['linux', 'arm64'], activeJobs: 0, maxConcurrency: 2 },
      ]);

      const matches = registry.findPeersWithCapacity([['linux', 'x64']]);
      expect(matches).toHaveLength(1);
      expect(matches[0].instanceId).toBe('orch-1');
    });

    it('should match when agent labels are superset of required labels', () => {
      addPeerWithAgents('orch-1', [
        {
          agentId: 'a1',
          labels: ['linux', 'x64', 'gpu', 'cuda'],
          activeJobs: 0,
          maxConcurrency: 2,
        },
      ]);

      const matches = registry.findPeersWithCapacity([['linux', 'gpu']]);
      expect(matches).toHaveLength(1);
    });

    it('should not match when agent labels are subset of required labels', () => {
      addPeerWithAgents('orch-1', [
        { agentId: 'a1', labels: ['linux'], activeJobs: 0, maxConcurrency: 2 },
      ]);

      const matches = registry.findPeersWithCapacity([['linux', 'gpu']]);
      expect(matches).toHaveLength(0);
    });

    it('should match any of the label sets (OR semantics across sets)', () => {
      addPeerWithAgents('orch-1', [
        { agentId: 'a1', labels: ['darwin', 'arm64'], activeJobs: 0, maxConcurrency: 2 },
      ]);
      addPeerWithAgents('orch-2', [
        { agentId: 'a2', labels: ['linux', 'x64'], activeJobs: 0, maxConcurrency: 2 },
      ]);

      // Match either darwin+arm64 OR linux+x64
      const matches = registry.findPeersWithCapacity([
        ['darwin', 'arm64'],
        ['linux', 'x64'],
      ]);
      expect(matches).toHaveLength(2);
    });

    it('should exclude peers whose agents are at full capacity', () => {
      addPeerWithAgents('orch-1', [
        { agentId: 'a1', labels: ['linux'], activeJobs: 2, maxConcurrency: 2 },
      ]);

      const matches = registry.findPeersWithCapacity([['linux']]);
      expect(matches).toHaveLength(0);
    });

    it('should include peers with at least one agent with capacity', () => {
      addPeerWithAgents('orch-1', [
        { agentId: 'a1', labels: ['linux'], activeJobs: 2, maxConcurrency: 2 }, // full
        { agentId: 'a2', labels: ['linux'], activeJobs: 1, maxConcurrency: 3 }, // has capacity
      ]);

      const matches = registry.findPeersWithCapacity([['linux']]);
      expect(matches).toHaveLength(1);
    });

    it('should exclude draining peers', () => {
      addPeerWithAgents(
        'orch-1',
        [{ agentId: 'a1', labels: ['linux'], activeJobs: 0, maxConcurrency: 2 }],
        { draining: true },
      );

      const matches = registry.findPeersWithCapacity([['linux']]);
      expect(matches).toHaveLength(0);
    });

    it('should exclude disconnected peers', () => {
      addPeerWithAgents(
        'orch-1',
        [{ agentId: 'a1', labels: ['linux'], activeJobs: 0, maxConcurrency: 2 }],
        { connected: false },
      );

      const matches = registry.findPeersWithCapacity([['linux']]);
      expect(matches).toHaveLength(0);
    });

    it('should match empty label set (any agent with capacity)', () => {
      addPeerWithAgents('orch-1', [
        { agentId: 'a1', labels: ['linux', 'x64'], activeJobs: 0, maxConcurrency: 2 },
      ]);

      const matches = registry.findPeersWithCapacity([[]]);
      expect(matches).toHaveLength(1);
    });

    it('should return empty array for empty registry', () => {
      const matches = registry.findPeersWithCapacity([['linux']]);
      expect(matches).toHaveLength(0);
    });

    // ── Scaler-aware capacity checks ──────────────────────────────────

    it('should find peer with zero agents but scaler capacity for matching labels', () => {
      registry.addPeer({
        instanceId: 'orch-scaler',
        connectionId: 'conn-scaler',
        address: null,
        routingKeys: [],
      });

      // Heartbeat with zero agents but scaler capacity
      registry.updateHeartbeat('orch-scaler', {
        type: 'peer.heartbeat',
        instanceId: 'orch-scaler',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        scalerCapacity: [
          {
            labelSets: [['linux', 'x64']],
            maxAgents: 5,
            activeCount: 2,
          },
        ],
        timestamp: Date.now(),
      });

      const matches = registry.findPeersWithCapacity([['linux', 'x64']]);
      expect(matches).toHaveLength(1);
      expect(matches[0].instanceId).toBe('orch-scaler');
    });

    it('should NOT find peer with scaler capacity at max', () => {
      registry.addPeer({
        instanceId: 'orch-full',
        connectionId: 'conn-full',
        address: null,
        routingKeys: [],
      });

      registry.updateHeartbeat('orch-full', {
        type: 'peer.heartbeat',
        instanceId: 'orch-full',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        scalerCapacity: [
          {
            labelSets: [['linux', 'x64']],
            maxAgents: 3,
            activeCount: 3,
          },
        ],
        timestamp: Date.now(),
      });

      const matches = registry.findPeersWithCapacity([['linux', 'x64']]);
      expect(matches).toHaveLength(0);
    });

    it('should NOT find peer with scaler capacity for non-matching labels', () => {
      registry.addPeer({
        instanceId: 'orch-wrong',
        connectionId: 'conn-wrong',
        address: null,
        routingKeys: [],
      });

      registry.updateHeartbeat('orch-wrong', {
        type: 'peer.heartbeat',
        instanceId: 'orch-wrong',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        scalerCapacity: [
          {
            labelSets: [['darwin', 'arm64']],
            maxAgents: 5,
            activeCount: 0,
          },
        ],
        timestamp: Date.now(),
      });

      const matches = registry.findPeersWithCapacity([['linux', 'x64']]);
      expect(matches).toHaveLength(0);
    });

    it('should work via agent-only check when peer has no scalerCapacity (backward compat)', () => {
      addPeerWithAgents('orch-legacy', [
        { agentId: 'a1', labels: ['linux'], activeJobs: 0, maxConcurrency: 2 },
      ]);

      // Verify no scalerCapacity set
      expect(registry.getPeer('orch-legacy')!.scalerCapacity).toBeUndefined();

      const matches = registry.findPeersWithCapacity([['linux']]);
      expect(matches).toHaveLength(1);
      expect(matches[0].instanceId).toBe('orch-legacy');
    });

    // ── mandatoryLabels gate on peer scaler-capacity entries ────────────
    it('routes to peer with gated scaler when required labels include mandatory', () => {
      registry.addPeer({
        instanceId: 'orch-gpu',
        connectionId: 'conn-gpu',
        address: null,
        routingKeys: [],
      });
      registry.updateHeartbeat('orch-gpu', {
        type: 'peer.heartbeat',
        instanceId: 'orch-gpu',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        scalerCapacity: [
          {
            labelSets: [['linux', 'gpu']],
            maxAgents: 5,
            activeCount: 0,
            mandatoryLabels: ['gpu'],
          },
        ],
        timestamp: Date.now(),
      });

      const matches = registry.findPeersWithCapacity([['linux', 'gpu']]);
      expect(matches).toHaveLength(1);
      expect(matches[0].instanceId).toBe('orch-gpu');
    });

    it('blocks routing to gated peer when required labels miss the mandatory label', () => {
      registry.addPeer({
        instanceId: 'orch-gated',
        connectionId: 'conn-gated',
        address: null,
        routingKeys: [],
      });
      registry.updateHeartbeat('orch-gated', {
        type: 'peer.heartbeat',
        instanceId: 'orch-gated',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        scalerCapacity: [
          {
            labelSets: [['linux', 'gpu']],
            maxAgents: 5,
            activeCount: 0,
            mandatoryLabels: ['gpu'],
          },
        ],
        timestamp: Date.now(),
      });

      // Required labels are a subset of the labelSet, but missing the gate.
      const matches = registry.findPeersWithCapacity([['linux']]);
      expect(matches).toHaveLength(0);
    });

    it('routes to peer when scaler has no mandatoryLabels (backward compat with legacy peers)', () => {
      registry.addPeer({
        instanceId: 'orch-legacy',
        connectionId: 'conn-legacy',
        address: null,
        routingKeys: [],
      });
      registry.updateHeartbeat('orch-legacy', {
        type: 'peer.heartbeat',
        instanceId: 'orch-legacy',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        scalerCapacity: [
          {
            labelSets: [['linux', 'x64']],
            maxAgents: 5,
            activeCount: 0,
            // mandatoryLabels omitted — legacy peer or no gate.
          },
        ],
        timestamp: Date.now(),
      });

      const matches = registry.findPeersWithCapacity([['linux']]);
      expect(matches).toHaveLength(1);
      expect(matches[0].instanceId).toBe('orch-legacy');
    });

    it('empty required labels do not match a gated scaler (mirrors local matcher)', () => {
      registry.addPeer({
        instanceId: 'orch-gated',
        connectionId: 'conn-gated',
        address: null,
        routingKeys: [],
      });
      registry.updateHeartbeat('orch-gated', {
        type: 'peer.heartbeat',
        instanceId: 'orch-gated',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        scalerCapacity: [
          {
            labelSets: [['linux', 'gpu']],
            maxAgents: 5,
            activeCount: 0,
            mandatoryLabels: ['gpu'],
          },
        ],
        timestamp: Date.now(),
      });

      // Empty required labels: a gated scaler cannot match.
      const matches = registry.findPeersWithCapacity([[]]);
      expect(matches).toHaveLength(0);
    });
  });

  // ── findPeersWithLabels mandatoryLabels gate ──────────────────────────
  describe('findPeersWithLabels mandatoryLabels gate', () => {
    it('blocks gated peer when required labels miss the mandatory label', () => {
      registry.addPeer({
        instanceId: 'orch-gated',
        connectionId: 'conn-gated',
        address: null,
        routingKeys: [],
      });
      registry.updateHeartbeat('orch-gated', {
        type: 'peer.heartbeat',
        instanceId: 'orch-gated',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        scalerCapacity: [
          {
            labelSets: [['linux', 'gpu']],
            maxAgents: 5,
            activeCount: 5, // at capacity — irrelevant to findPeersWithLabels
            mandatoryLabels: ['gpu'],
          },
        ],
        timestamp: Date.now(),
      });

      // Without the gate label in required, the gated scaler is invisible
      // even though findPeersWithLabels ignores capacity.
      const matches = registry.findPeersWithLabels([['linux']]);
      expect(matches).toHaveLength(0);
    });

    it('exposes gated peer when required labels include the mandatory label', () => {
      registry.addPeer({
        instanceId: 'orch-gated',
        connectionId: 'conn-gated',
        address: null,
        routingKeys: [],
      });
      registry.updateHeartbeat('orch-gated', {
        type: 'peer.heartbeat',
        instanceId: 'orch-gated',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        scalerCapacity: [
          {
            labelSets: [['linux', 'gpu']],
            maxAgents: 5,
            activeCount: 5,
            mandatoryLabels: ['gpu'],
          },
        ],
        timestamp: Date.now(),
      });

      const matches = registry.findPeersWithLabels([['linux', 'gpu']]);
      expect(matches).toHaveLength(1);
    });
  });

  // ── markDisconnected / markConnected ────────────────────────────────

  describe('markDisconnected / markConnected', () => {
    it('should mark peer as disconnected and then reconnected', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      expect(registry.getPeer('orch-1')!.connected).toBe(true);

      registry.markDisconnected('orch-1');
      expect(registry.getPeer('orch-1')!.connected).toBe(false);

      // Peer still exists
      expect(registry.getPeerCount()).toBe(1);
      expect(registry.getConnectedPeerCount()).toBe(0);

      registry.markConnected('orch-1');
      expect(registry.getPeer('orch-1')!.connected).toBe(true);
      expect(registry.getConnectedPeerCount()).toBe(1);
    });

    it('should clear agents on disconnect ( capability eviction)', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      // Add agents via heartbeat
      registry.updateHeartbeat('orch-1', {
        type: 'peer.heartbeat',
        instanceId: 'orch-1',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [
          {
            agentId: 'agent-1',
            labels: ['linux', 'x64'],
            activeJobs: 0,
            maxConcurrency: 2,
            platform: 'linux',
            arch: 'x64',
          },
        ],
        capabilities: { s3LogAccess: false },
        scalerCapacity: [{ labelSets: [['linux']], maxAgents: 5, activeCount: 1 }],
        timestamp: Date.now(),
      });

      expect(registry.getPeer('orch-1')!.agents).toHaveLength(1);
      expect(registry.getPeer('orch-1')!.scalerCapacity).toHaveLength(1);

      registry.markDisconnected('orch-1');

      expect(registry.getPeer('orch-1')!.connected).toBe(false);
      expect(registry.getPeer('orch-1')!.agents).toEqual([]);
      expect(registry.getPeer('orch-1')!.scalerCapacity).toBeUndefined();
    });

    it('should handle marking non-existent peer gracefully', () => {
      registry.markDisconnected('non-existent');
      registry.markConnected('non-existent');
      expect(registry.getPeerCount()).toBe(0);
    });
  });

  // ── addPeer reconnect behavior ─────────────────────────────────────

  describe('addPeer reconnect (clean start)', () => {
    it('should start with empty agents on reconnect, not preserve stale data', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      // Populate agents via heartbeat
      registry.updateHeartbeat('orch-1', {
        type: 'peer.heartbeat',
        instanceId: 'orch-1',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [
          {
            agentId: 'agent-1',
            labels: ['macos', 'arm64'],
            activeJobs: 1,
            maxConcurrency: 2,
            platform: 'darwin',
            arch: 'arm64',
          },
        ],
        capabilities: { s3LogAccess: true },
        scalerCapacity: [{ labelSets: [['macos']], maxAgents: 3, activeCount: 2 }],
        timestamp: Date.now(),
      });

      expect(registry.getPeer('orch-1')!.agents).toHaveLength(1);
      expect(registry.getPeer('orch-1')!.scalerCapacity).toHaveLength(1);

      // Disconnect, then reconnect with new connection
      registry.markDisconnected('orch-1');
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-2',
        address: null,
        routingKeys: [],
      });

      const peer = registry.getPeer('orch-1')!;
      expect(peer.connectionId).toBe('conn-2');
      expect(peer.agents).toEqual([]);
      expect(peer.scalerCapacity).toBeUndefined();
      expect(peer.draining).toBe(false);
    });
  });

  // ── findPeersWithLabels ────────────────────────────────────────────

  describe('findPeersWithLabels', () => {
    function addPeerWithAgents(
      instanceId: string,
      agents: Array<{
        agentId: string;
        labels: string[];
        activeJobs: number;
        maxConcurrency: number;
      }>,
      opts?: {
        draining?: boolean;
        connected?: boolean;
        scalerCapacity?: Array<{
          labelSets: string[][];
          maxAgents: number;
          activeCount: number;
        }>;
      },
    ) {
      registry.addPeer({
        instanceId,
        connectionId: `conn-${instanceId}`,
        address: null,
        routingKeys: [],
      });

      registry.updateHeartbeat(instanceId, {
        type: 'peer.heartbeat',
        instanceId,
        term: 1,
        leaderId: null,
        draining: opts?.draining ?? false,
        agents: agents.map((a) => ({
          ...a,
          platform: 'linux',
          arch: 'x64',
        })),
        capabilities: { s3LogAccess: false },
        scalerCapacity: opts?.scalerCapacity,
        timestamp: Date.now(),
      });

      if (opts?.connected === false) {
        registry.markDisconnected(instanceId);
      }
    }

    it('should find peer with matching agent labels regardless of capacity', () => {
      addPeerWithAgents('orch-mac', [
        { agentId: 'a1', labels: ['macos', 'arm64'], activeJobs: 2, maxConcurrency: 2 },
      ]);

      // Agent is at full capacity, but findPeersWithLabels ignores capacity
      const matches = registry.findPeersWithLabels([['macos']]);
      expect(matches).toHaveLength(1);
      expect(matches[0].instanceId).toBe('orch-mac');
    });

    it('should find peer with matching scaler backend regardless of capacity', () => {
      addPeerWithAgents('orch-scaler', [], {
        scalerCapacity: [{ labelSets: [['macos', 'arm64']], maxAgents: 3, activeCount: 3 }],
      });

      // Scaler is at full capacity, but findPeersWithLabels ignores capacity
      const matches = registry.findPeersWithLabels([['macos']]);
      expect(matches).toHaveLength(1);
      expect(matches[0].instanceId).toBe('orch-scaler');
    });

    it('should exclude disconnected peers', () => {
      addPeerWithAgents(
        'orch-offline',
        [{ agentId: 'a1', labels: ['linux'], activeJobs: 0, maxConcurrency: 2 }],
        { connected: false },
      );

      const matches = registry.findPeersWithLabels([['linux']]);
      expect(matches).toHaveLength(0);
    });

    it('should exclude draining peers', () => {
      addPeerWithAgents(
        'orch-draining',
        [{ agentId: 'a1', labels: ['linux'], activeJobs: 0, maxConcurrency: 2 }],
        { draining: true },
      );

      const matches = registry.findPeersWithLabels([['linux']]);
      expect(matches).toHaveLength(0);
    });

    it('should match any peer when label set is empty', () => {
      addPeerWithAgents('orch-any', [
        { agentId: 'a1', labels: ['linux', 'x64'], activeJobs: 0, maxConcurrency: 2 },
      ]);

      const matches = registry.findPeersWithLabels([[]]);
      expect(matches).toHaveLength(1);
    });

    it('should return empty for no matching labels', () => {
      addPeerWithAgents('orch-linux', [
        { agentId: 'a1', labels: ['linux'], activeJobs: 0, maxConcurrency: 2 },
      ]);

      const matches = registry.findPeersWithLabels([['windows']]);
      expect(matches).toHaveLength(0);
    });
  });

  // ── isStale ─────────────────────────────────────────────────────────

  describe('isStale', () => {
    it('should return true when heartbeat is older than threshold', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      // Set heartbeat to 60 seconds ago
      registry.updateHeartbeat('orch-1', {
        type: 'peer.heartbeat',
        instanceId: 'orch-1',
        term: 1,
        leaderId: null,
        draining: false,
        agents: [],
        capabilities: { s3LogAccess: false },
        timestamp: Date.now() - 60_000,
      });

      expect(registry.isStale('orch-1', 30_000)).toBe(true);
      expect(registry.isStale('orch-1', 90_000)).toBe(false);
    });

    it('should return true for unknown peers', () => {
      expect(registry.isStale('unknown', 30_000)).toBe(true);
    });
  });

  // ── Counting methods ────────────────────────────────────────────────

  describe('getPeerCount / getConnectedPeerCount', () => {
    it('should count peers correctly', () => {
      expect(registry.getPeerCount()).toBe(0);
      expect(registry.getConnectedPeerCount()).toBe(0);

      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });
      registry.addPeer({
        instanceId: 'orch-2',
        connectionId: 'conn-2',
        address: null,
        routingKeys: [],
      });

      expect(registry.getPeerCount()).toBe(2);
      expect(registry.getConnectedPeerCount()).toBe(2);

      registry.markDisconnected('orch-1');

      expect(registry.getPeerCount()).toBe(2);
      expect(registry.getConnectedPeerCount()).toBe(1);
    });
  });

  // ── getAllPeers / getConnectedPeers ─────────────────────────────────

  describe('getAllPeers / getConnectedPeers', () => {
    it('should return all peers including disconnected', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });
      registry.addPeer({
        instanceId: 'orch-2',
        connectionId: 'conn-2',
        address: null,
        routingKeys: [],
      });

      registry.markDisconnected('orch-2');

      expect(registry.getAllPeers()).toHaveLength(2);
      expect(registry.getConnectedPeers()).toHaveLength(1);
      expect(registry.getConnectedPeers()[0].instanceId).toBe('orch-1');
    });

    it('should return empty arrays for empty registry', () => {
      expect(registry.getAllPeers()).toEqual([]);
      expect(registry.getConnectedPeers()).toEqual([]);
    });
  });

  // ── Role field ─────────────────────────────────────────────────────

  describe('role field', () => {
    it('addPeer with role=worker sets role on PeerInfo', () => {
      registry.addPeer({
        instanceId: 'worker-1',
        connectionId: 'conn-w1',
        address: 'ws://worker:8080',
        routingKeys: [],
        role: 'worker',
      });

      const peer = registry.getPeer('worker-1');
      expect(peer).toBeDefined();
      expect(peer!.role).toBe('worker');
    });

    it('addPeer without role defaults to coordinator', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: 'ws://orch:8080',
        routingKeys: [],
      });

      const peer = registry.getPeer('orch-1');
      expect(peer).toBeDefined();
      expect(peer!.role).toBe('coordinator');
    });

    it('getWorkerPeers returns only worker peers', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
        role: 'coordinator',
      });
      registry.addPeer({
        instanceId: 'worker-1',
        connectionId: 'conn-w1',
        address: null,
        routingKeys: [],
        role: 'worker',
      });
      registry.addPeer({
        instanceId: 'worker-2',
        connectionId: 'conn-w2',
        address: null,
        routingKeys: [],
        role: 'worker',
      });

      const workers = registry.getWorkerPeers();
      expect(workers).toHaveLength(2);
      expect(workers.map((w) => w.instanceId).sort()).toEqual(['worker-1', 'worker-2']);
    });

    it('getCoordinatorPeers returns only coordinator peers', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
        role: 'coordinator',
      });
      registry.addPeer({
        instanceId: 'orch-2',
        connectionId: 'conn-2',
        address: null,
        routingKeys: [],
      }); // defaults to coordinator
      registry.addPeer({
        instanceId: 'worker-1',
        connectionId: 'conn-w1',
        address: null,
        routingKeys: [],
        role: 'worker',
      });

      const coordinators = registry.getCoordinatorPeers();
      expect(coordinators).toHaveLength(2);
      expect(coordinators.map((c) => c.instanceId).sort()).toEqual(['orch-1', 'orch-2']);
    });
  });

  // ── Stale peer eviction ────────────────────────────────────────────

  describe('evictStalePeers', () => {
    it('marks peers with old heartbeat as disconnected', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      // Advance time past the stale timeout
      vi.advanceTimersByTime(70_000);

      registry.evictStalePeers(60_000);

      const peer = registry.getPeer('orch-1');
      expect(peer).toBeDefined();
      expect(peer!.connected).toBe(false);
      expect(peer!.agents).toEqual([]);
    });

    it('returns list of evicted instanceIds', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });
      registry.addPeer({
        instanceId: 'orch-2',
        connectionId: 'conn-2',
        address: null,
        routingKeys: [],
      });

      // Advance past timeout
      vi.advanceTimersByTime(70_000);

      const evicted = registry.evictStalePeers(60_000);
      expect(evicted.sort()).toEqual(['orch-1', 'orch-2']);
    });

    it('skips already-disconnected peers', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      registry.markDisconnected('orch-1');

      // Advance past timeout
      vi.advanceTimersByTime(70_000);

      const evicted = registry.evictStalePeers(60_000);
      expect(evicted).toEqual([]);
    });

    it('does not evict peers with recent heartbeats', () => {
      registry.addPeer({
        instanceId: 'orch-1',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      // Advance only 30s (under 60s threshold)
      vi.advanceTimersByTime(30_000);

      const evicted = registry.evictStalePeers(60_000);
      expect(evicted).toEqual([]);
      expect(registry.getPeer('orch-1')!.connected).toBe(true);
    });

    it('evicts only stale peers, keeps fresh ones', () => {
      registry.addPeer({
        instanceId: 'stale-peer',
        connectionId: 'conn-1',
        address: null,
        routingKeys: [],
      });

      // Advance 50s, then add a fresh peer
      vi.advanceTimersByTime(50_000);

      registry.addPeer({
        instanceId: 'fresh-peer',
        connectionId: 'conn-2',
        address: null,
        routingKeys: [],
      });

      // Advance another 20s (stale-peer = 70s, fresh-peer = 20s)
      vi.advanceTimersByTime(20_000);

      const evicted = registry.evictStalePeers(60_000);
      expect(evicted).toEqual(['stale-peer']);
      expect(registry.getPeer('stale-peer')!.connected).toBe(false);
      expect(registry.getPeer('fresh-peer')!.connected).toBe(true);
    });
  });
});
