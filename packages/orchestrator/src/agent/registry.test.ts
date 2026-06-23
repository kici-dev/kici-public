import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentRegistry } from './registry.js';
import { mockWs } from '../__test-helpers__/mock-ws.js';

// ── Tests ───────────────────────────────────────────────────────

describe('AgentRegistry', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  describe('register', () => {
    it('adds agent and makes it findable by ID', () => {
      const ws = mockWs();
      registry.register('agent-1', ws, ['linux', 'docker'], 'linux', 'x64');

      const entry = registry.get('agent-1');
      expect(entry).toBeDefined();
      expect(entry!.agentId).toBe('agent-1');
      expect(entry!.ws).toBe(ws);
      expect(entry!.labels).toEqual(new Set(['linux', 'docker']));
      expect(entry!.activeJobs).toBe(0);
      expect(entry!.platform).toBe('linux');
      expect(entry!.arch).toBe('x64');
    });

    it('stores platform and arch from registration', () => {
      const ws = mockWs();
      registry.register('agent-arm', ws, ['linux'], 'darwin', 'arm64');

      const entry = registry.get('agent-arm');
      expect(entry).toBeDefined();
      expect(entry!.platform).toBe('darwin');
      expect(entry!.arch).toBe('arm64');
    });

    it('defaults platform to linux and arch to x64 when not provided', () => {
      const ws = mockWs();
      registry.register('agent-default', ws, ['linux']);

      const entry = registry.get('agent-default');
      expect(entry).toBeDefined();
      expect(entry!.platform).toBe('linux');
      expect(entry!.arch).toBe('x64');
    });

    it('records scalerManaged from registration metadata', () => {
      registry.register('a1', mockWs(), ['linux'], 'linux', 'x64', undefined, 1, {
        scalerManaged: true,
      });
      expect(registry.get('a1')?.scalerManaged).toBe(true);

      registry.register('a2', mockWs(), ['linux']);
      expect(registry.get('a2')?.scalerManaged).toBe(false);
    });

    it('records tokenAgentType from metadata', () => {
      registry.register('a1', mockWs(), ['linux'], 'linux', 'x64', undefined, 1, {
        tokenAgentType: 'static',
      });
      expect(registry.get('a1')?.tokenAgentType).toBe('static');

      registry.register('a2', mockWs(), ['linux']);
      expect(registry.get('a2')?.tokenAgentType).toBeNull();
    });
  });

  describe('host roster reconcile', () => {
    const makeStore = () => ({
      upsert: vi.fn().mockResolvedValue(undefined),
      markDisconnected: vi.fn().mockResolvedValue(undefined),
      stampLastSeen: vi.fn().mockResolvedValue(undefined),
    });

    it('upserts a roster row on register when a store is injected', async () => {
      const store = makeStore();
      const reg = new AgentRegistry({ rosterStore: store, instanceId: 'orch-A' });
      reg.register('a1', mockWs(), ['role:web'], 'linux', 'x64', undefined, 1, {
        tokenId: 'tok1',
        tokenAgentType: 'static',
        hostname: 'web-01',
      });
      await Promise.resolve(); // let the fire-and-forget settle
      expect(store.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'a1',
          tokenId: 'tok1',
          lifecycleClass: 'static',
          labels: ['role:web'],
          hostname: 'web-01',
          platform: 'linux',
          arch: 'x64',
          instanceId: 'orch-A',
        }),
      );
    });

    it('threads agent-reported properties into the roster upsert', async () => {
      const store = makeStore();
      const reg = new AgentRegistry({ rosterStore: store, instanceId: 'orch-A' });
      reg.register('a1', mockWs(), ['role:db'], 'linux', 'x64', undefined, 1, {
        tokenId: 'tok1',
        tokenAgentType: 'static',
        properties: { region: 'eu', cores: 8 },
      });
      await Promise.resolve();
      expect(store.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ properties: { region: 'eu', cores: 8 } }),
      );
    });

    it('defaults lifecycleClass to ephemeral when token agent_type unknown', async () => {
      const store = makeStore();
      const reg = new AgentRegistry({ rosterStore: store, instanceId: 'orch-A' });
      reg.register('a1', mockWs(), ['linux']);
      await Promise.resolve();
      expect(store.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ lifecycleClass: 'ephemeral' }),
      );
    });

    it('does nothing when no store is injected (back-compat)', () => {
      const reg = new AgentRegistry();
      expect(() => reg.register('a1', mockWs(), ['linux'])).not.toThrow();
    });

    it('marks the roster row disconnected on unregister', async () => {
      const store = makeStore();
      const reg = new AgentRegistry({ rosterStore: store, instanceId: 'orch-A' });
      reg.register('a1', mockWs(), ['linux']);
      reg.unregister('a1');
      await Promise.resolve();
      expect(store.markDisconnected).toHaveBeenCalledWith('a1', 'orch-A');
    });

    it('coarse-stamps last_seen at most once per throttle window', async () => {
      vi.useFakeTimers();
      try {
        const store = makeStore();
        const reg = new AgentRegistry({ rosterStore: store, instanceId: 'orch-A' });
        reg.register('a1', mockWs(), ['linux']);
        reg.updateHeartbeat('a1');
        reg.updateHeartbeat('a1'); // within window
        expect(store.stampLastSeen).not.toHaveBeenCalled();
        vi.advanceTimersByTime(120_000);
        reg.updateHeartbeat('a1');
        expect(store.stampLastSeen).toHaveBeenCalledTimes(1);
        expect(store.stampLastSeen).toHaveBeenCalledWith('a1', 'orch-A');
      } finally {
        vi.useRealTimers();
      }
    });

    it('makes agent findable by labels via findAvailable', () => {
      const ws = mockWs();
      registry.register('agent-1', ws, ['linux', 'docker']);

      const available = registry.findAvailable(['linux']);
      expect(available).toHaveLength(1);
      expect(available[0].agentId).toBe('agent-1');
    });

    it('updates existing entry on re-registration (agent reconnection)', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();

      registry.register('agent-1', ws1, ['linux']);
      registry.register('agent-1', ws2, ['linux', 'gpu']);

      const entry = registry.get('agent-1');
      expect(entry!.ws).toBe(ws2);
      expect(entry!.labels).toEqual(new Set(['linux', 'gpu']));
      expect(entry!.activeJobs).toBe(0); // Reset on re-register

      // Old WS should no longer be in reverse map
      expect(registry.getByWs(ws1)).toBeUndefined();
      expect(registry.getByWs(ws2)).toBeDefined();

      // Count should still be 1 (not 2)
      expect(registry.getActiveCount()).toBe(1);
    });
  });

  describe('unregister', () => {
    it('removes agent from all indexes', () => {
      const ws = mockWs();
      registry.register('agent-1', ws, ['linux', 'docker']);

      const removed = registry.unregister('agent-1');
      expect(removed).toBeDefined();
      expect(removed!.agentId).toBe('agent-1');

      expect(registry.get('agent-1')).toBeUndefined();
      expect(registry.getByWs(ws)).toBeUndefined();
      expect(registry.findAvailable(['linux'])).toHaveLength(0);
      expect(registry.getActiveCount()).toBe(0);
    });

    it('returns undefined for unknown agent', () => {
      const removed = registry.unregister('nonexistent');
      expect(removed).toBeUndefined();
    });
  });

  describe('unregisterByWs', () => {
    it('removes agent by WS reference', () => {
      const ws = mockWs();
      registry.register('agent-1', ws, ['linux']);

      const removed = registry.unregisterByWs(ws);
      expect(removed).toBeDefined();
      expect(removed!.agentId).toBe('agent-1');
      expect(registry.get('agent-1')).toBeUndefined();
      expect(registry.getActiveCount()).toBe(0);
    });

    it('returns undefined for unknown WS', () => {
      const ws = mockWs();
      expect(registry.unregisterByWs(ws)).toBeUndefined();
    });
  });

  describe('findAvailable', () => {
    it('requires ALL labels (intersection semantics)', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();

      registry.register('agent-1', ws1, ['linux', 'docker']);
      registry.register('agent-2', ws2, ['linux']);

      // Both have 'linux'
      expect(registry.findAvailable(['linux'])).toHaveLength(2);

      // Only agent-1 has both 'linux' and 'docker'
      const result = registry.findAvailable(['linux', 'docker']);
      expect(result).toHaveLength(1);
      expect(result[0].agentId).toBe('agent-1');
    });

    it('filters by idle status (activeJobs === 0)', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();

      registry.register('agent-1', ws1, ['linux']);
      registry.register('agent-2', ws2, ['linux']);

      // Make agent-1 busy
      registry.incrementActiveJobs('agent-1');

      const available = registry.findAvailable(['linux']);
      expect(available).toHaveLength(1);
      expect(available[0].agentId).toBe('agent-2');
    });

    it('returns empty when no agents match any required label', () => {
      const ws = mockWs();
      registry.register('agent-1', ws, ['linux']);

      expect(registry.findAvailable(['windows'])).toHaveLength(0);
    });

    it('returns empty when no agents registered', () => {
      expect(registry.findAvailable(['linux'])).toHaveLength(0);
    });

    it('returns all idle agents when no labels required', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();

      registry.register('agent-1', ws1, ['linux']);
      registry.register('agent-2', ws2, ['windows']);

      expect(registry.findAvailable([])).toHaveLength(2);
    });

    it('returns empty when all matching agents are busy', () => {
      const ws = mockWs();
      registry.register('agent-1', ws, ['linux']);
      registry.incrementActiveJobs('agent-1');

      expect(registry.findAvailable(['linux'])).toHaveLength(0);
    });

    it('excludes agents with excluded labels', () => {
      registry.register('agent-1', mockWs(), ['linux', 'gpu']);
      registry.register('agent-2', mockWs(), ['linux', 'docker']);

      const result = registry.findAvailable(['linux'], [], ['gpu']);
      expect(result).toHaveLength(1);
      expect(result[0].agentId).toBe('agent-2');
    });

    it('returns same results with empty excludeLabels (backward compat)', () => {
      registry.register('agent-1', mockWs(), ['linux', 'docker']);
      registry.register('agent-2', mockWs(), ['linux']);

      const withEmpty = registry.findAvailable(['linux'], [], []);
      const withoutParam = registry.findAvailable(['linux']);
      expect(withEmpty.map((e) => e.agentId).sort()).toEqual(
        withoutParam.map((e) => e.agentId).sort(),
      );
    });

    it('excludes agents matching any single excluded label', () => {
      registry.register('agent-1', mockWs(), ['linux', 'gpu']);
      registry.register('agent-2', mockWs(), ['linux', 'arm64']);
      registry.register('agent-3', mockWs(), ['linux', 'docker']);

      const result = registry.findAvailable(['linux'], [], ['gpu', 'arm64']);
      expect(result).toHaveLength(1);
      expect(result[0].agentId).toBe('agent-3');
    });

    it('excludes agents when no required labels but excludeLabels present', () => {
      registry.register('agent-1', mockWs(), ['linux', 'gpu']);
      registry.register('agent-2', mockWs(), ['linux']);

      const result = registry.findAvailable([], [], ['gpu']);
      expect(result).toHaveLength(1);
      expect(result[0].agentId).toBe('agent-2');
    });
  });

  describe('findAvailable with regex patterns', () => {
    it('findAvailable matches a regex pattern when no exact labels are given', () => {
      registry.register('a1', mockWs(), ['kici:host:box-01', 'role:web']);
      registry.register('a2', mockWs(), ['kici:host:web-09', 'role:web']);
      const got = registry.findAvailable(
        [],
        [{ kind: 'regex', source: '^kici:host:box-', flags: '' }],
      );
      expect(got.map((a) => a.agentId)).toEqual(['a1']);
    });

    it('findAvailable narrows by exact index then filters by regex', () => {
      registry.register('a1', mockWs(), ['role:web', 'kici:host:box-01']);
      registry.register('a2', mockWs(), ['role:db', 'kici:host:box-02']);
      const got = registry.findAvailable(
        ['role:web'],
        [{ kind: 'regex', source: '^kici:host:box-', flags: '' }],
      );
      expect(got.map((a) => a.agentId)).toEqual(['a1']);
    });

    it('excludePatterns disqualifies a matching agent', () => {
      registry.register('a1', mockWs(), ['role:web', 'kici:host:web-canary']);
      const got = registry.findAvailable(
        ['role:web'],
        [],
        [],
        [{ kind: 'regex', source: '-canary$', flags: '' }],
      );
      expect(got).toHaveLength(0);
    });

    it('pure-exact call path is unchanged (no patterns)', () => {
      registry.register('a1', mockWs(), ['role:web']);
      expect(registry.findAvailable(['role:web']).map((a) => a.agentId)).toEqual(['a1']);
    });
  });

  describe('mandatoryLabels gate (k8s-style taints)', () => {
    it('gated agent rejects jobs whose runsOn does not include every gate label', () => {
      // Gated agent: requires `gpu` to appear in runsOn even though
      // its label set already contains it.
      registry.register('gated', mockWs(), ['linux', 'gpu'], 'linux', 'x64', undefined, 1, {
        mandatoryLabels: ['gpu'],
      });

      // runsOn=['linux'] is a subset of the agent's labels but does NOT
      // include `gpu` — gate fails.
      expect(registry.findAvailable(['linux'])).toHaveLength(0);
      expect(registry.hasMatchingAgent(['linux'])).toBe(false);
    });

    it('gated agent accepts jobs whose runsOn includes every gate label', () => {
      registry.register('gated', mockWs(), ['linux', 'gpu'], 'linux', 'x64', undefined, 1, {
        mandatoryLabels: ['gpu'],
      });

      const available = registry.findAvailable(['linux', 'gpu']);
      expect(available).toHaveLength(1);
      expect(available[0].agentId).toBe('gated');
      expect(registry.hasMatchingAgent(['linux', 'gpu'])).toBe(true);
    });

    it('non-gated agent accepts both gated and non-gated runsOn', () => {
      // Static agent with no mandatoryLabels — historical behavior preserved.
      registry.register('static', mockWs(), ['linux', 'gpu']);

      // No gate, subset matching is enough.
      expect(registry.findAvailable(['linux'])).toHaveLength(1);
      expect(registry.findAvailable(['linux', 'gpu'])).toHaveLength(1);
      expect(registry.hasMatchingAgent(['linux'])).toBe(true);
      expect(registry.hasMatchingAgent(['linux', 'gpu'])).toBe(true);
    });

    it('rejects gated agent on empty runsOn (gate cannot be satisfied)', () => {
      registry.register('gated', mockWs(), ['linux', 'gpu'], 'linux', 'x64', undefined, 1, {
        mandatoryLabels: ['gpu'],
      });

      // Empty runsOn matches every agent BY SUBSET, but the gate cannot be
      // satisfied by an empty required-labels set.
      expect(registry.findAvailable([])).toHaveLength(0);
      expect(registry.hasMatchingAgent([])).toBe(false);
    });

    it('passes empty runsOn through to a non-gated agent', () => {
      registry.register('static', mockWs(), ['linux']);

      expect(registry.findAvailable([])).toHaveLength(1);
      expect(registry.hasMatchingAgent([])).toBe(true);
    });

    it('exclusion + gate compose: gated agent on a matching runsOn but excluded label loses', () => {
      registry.register('gated', mockWs(), ['linux', 'gpu', 'beta'], 'linux', 'x64', undefined, 1, {
        mandatoryLabels: ['gpu'],
      });

      // Even though gate passes, exclusion fails.
      expect(registry.findAvailable(['linux', 'gpu'], [], ['beta'])).toHaveLength(0);
      expect(registry.hasMatchingAgent(['linux', 'gpu'], [], ['beta'])).toBe(false);
    });

    it('mixed gated + non-gated agents: gate only applies to gated entries', () => {
      registry.register('gated', mockWs(), ['linux', 'gpu'], 'linux', 'x64', undefined, 1, {
        mandatoryLabels: ['gpu'],
      });
      registry.register('static', mockWs(), ['linux', 'gpu']);

      // runsOn=['linux'] only matches the static agent (gate blocks the gated one).
      const result = registry.findAvailable(['linux']);
      expect(result.map((e) => e.agentId).sort()).toEqual(['static']);
      expect(registry.hasMatchingAgent(['linux'])).toBe(true);

      // runsOn=['linux','gpu'] matches both.
      const both = registry.findAvailable(['linux', 'gpu']);
      expect(both.map((e) => e.agentId).sort()).toEqual(['gated', 'static']);
      expect(registry.hasMatchingAgent(['linux', 'gpu'])).toBe(true);
    });

    it('preserves the gate across re-registration when threaded explicitly', () => {
      registry.register('gated', mockWs(), ['linux', 'gpu'], 'linux', 'x64', undefined, 1, {
        mandatoryLabels: ['gpu'],
      });
      // Re-register with the same gate (mirrors the agent-handler.ts
      // re-register branch threading the existing entry's gate back through).
      registry.register('gated', mockWs(), ['linux', 'gpu'], 'linux', 'x64', undefined, 1, {
        mandatoryLabels: ['gpu'],
      });

      expect(registry.findAvailable(['linux'])).toHaveLength(0);
      expect(registry.findAvailable(['linux', 'gpu'])).toHaveLength(1);
    });
  });

  describe('incrementActiveJobs / decrementActiveJobs', () => {
    it('increments active jobs', () => {
      const ws = mockWs();
      registry.register('agent-1', ws, ['linux']);

      expect(registry.incrementActiveJobs('agent-1')).toBe(true);
      expect(registry.get('agent-1')!.activeJobs).toBe(1);
    });

    it('decrements active jobs', () => {
      const ws = mockWs();
      registry.register('agent-1', ws, ['linux']);
      registry.incrementActiveJobs('agent-1');

      expect(registry.decrementActiveJobs('agent-1')).toBe(true);
      expect(registry.get('agent-1')!.activeJobs).toBe(0);
    });

    it('does not decrement below zero', () => {
      const ws = mockWs();
      registry.register('agent-1', ws, ['linux']);

      expect(registry.decrementActiveJobs('agent-1')).toBe(true);
      expect(registry.get('agent-1')!.activeJobs).toBe(0);
    });

    it('returns false for unknown agent', () => {
      expect(registry.incrementActiveJobs('nonexistent')).toBe(false);
      expect(registry.decrementActiveJobs('nonexistent')).toBe(false);
    });
  });

  describe('updateHeartbeat', () => {
    it('updates lastHeartbeatAt', () => {
      const ws = mockWs();
      registry.register('agent-1', ws, ['linux']);
      const before = registry.get('agent-1')!.lastHeartbeatAt;

      // Small delay to ensure timestamp differs
      registry.updateHeartbeat('agent-1');
      const after = registry.get('agent-1')!.lastHeartbeatAt;

      expect(after).toBeGreaterThanOrEqual(before);
    });

    it('returns false for unknown agent', () => {
      expect(registry.updateHeartbeat('nonexistent')).toBe(false);
    });
  });

  describe('getByWs', () => {
    it('returns agent entry by WS reference', () => {
      const ws = mockWs();
      registry.register('agent-1', ws, ['linux']);

      const entry = registry.getByWs(ws);
      expect(entry).toBeDefined();
      expect(entry!.agentId).toBe('agent-1');
    });

    it('returns undefined for unknown WS', () => {
      expect(registry.getByWs(mockWs())).toBeUndefined();
    });
  });

  describe('getActiveCount', () => {
    it('reflects current registry size', () => {
      expect(registry.getActiveCount()).toBe(0);

      registry.register('agent-1', mockWs(), ['linux']);
      expect(registry.getActiveCount()).toBe(1);

      registry.register('agent-2', mockWs(), ['linux']);
      expect(registry.getActiveCount()).toBe(2);

      registry.unregister('agent-1');
      expect(registry.getActiveCount()).toBe(1);
    });
  });

  describe('getAllEntries', () => {
    it('iterates over all entries', () => {
      registry.register('agent-1', mockWs(), ['linux']);
      registry.register('agent-2', mockWs(), ['windows']);

      const entries = [...registry.getAllEntries()];
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.agentId).sort()).toEqual(['agent-1', 'agent-2']);
    });
  });

  // ── Token-id reverse index lifecycle ─────────────────
  //
  // The registry exposes `disconnectByTokenId(tokenId)` so the admin
  // DELETE /api/v1/agent-tokens/:id route can synchronously kick every
  // in-flight WS authenticated by a now-revoked token. The lifecycle
  // tests below pin the index's behavior across register / re-register
  // / unregister / kick.
  describe('disconnectByTokenId / token-id reverse index', () => {
    it('register populates the index and entry.tokenId reflects metadata', () => {
      const ws = mockWs();
      registry.register('agent-1', ws, ['linux'], 'linux', 'x64', undefined, 1, {
        tokenId: 'tok-A',
      });

      expect(registry.get('agent-1')!.tokenId).toBe('tok-A');
    });

    it('register with no tokenId leaves the entry tokenId null and the index unaffected', () => {
      registry.register('agent-1', mockWs(), ['linux']);

      expect(registry.get('agent-1')!.tokenId).toBeNull();
      expect(registry.disconnectByTokenId('tok-A')).toBe(0);
    });

    it('unregister cleans up the index (no orphaned set behind a dead agent)', () => {
      const ws = mockWs();
      registry.register('agent-1', ws, ['linux'], 'linux', 'x64', undefined, 1, {
        tokenId: 'tok-A',
      });

      registry.unregister('agent-1');

      // Re-registering under the same tokenId must succeed (the set was
      // not left "0-size and stuck" -- removeFromIndexes deletes empty sets)
      expect(registry.disconnectByTokenId('tok-A')).toBe(0);
    });

    it('disconnectByTokenId closes the WS and unregisters the agent, returns 1', () => {
      const ws = mockWs();
      registry.register('agent-1', ws, ['linux'], 'linux', 'x64', undefined, 1, {
        tokenId: 'tok-A',
      });

      const kicked = registry.disconnectByTokenId('tok-A');

      expect(kicked).toBe(1);
      expect(ws.close).toHaveBeenCalledWith(4010, 'Token revoked');
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'auth.failure', reason: 'Token revoked' }),
      );
      expect(registry.get('agent-1')).toBeUndefined();
      expect(registry.getActiveCount()).toBe(0);
    });

    it('disconnectByTokenId for an unknown tokenId returns 0 with no side effects', () => {
      const wsA = mockWs();
      registry.register('agent-1', wsA, ['linux'], 'linux', 'x64', undefined, 1, {
        tokenId: 'tok-A',
      });

      expect(registry.disconnectByTokenId('tok-NONEXISTENT')).toBe(0);
      expect(wsA.close).not.toHaveBeenCalled();
      expect(registry.get('agent-1')).toBeDefined();
    });

    it('two agents under the same tokenId are both kicked on revoke', () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register('agent-A', wsA, ['linux'], 'linux', 'x64', undefined, 1, {
        tokenId: 'tok-shared',
      });
      registry.register('agent-B', wsB, ['linux'], 'linux', 'x64', undefined, 1, {
        tokenId: 'tok-shared',
      });

      const kicked = registry.disconnectByTokenId('tok-shared');

      expect(kicked).toBe(2);
      expect(wsA.close).toHaveBeenCalledWith(4010, 'Token revoked');
      expect(wsB.close).toHaveBeenCalledWith(4010, 'Token revoked');
      expect(registry.getActiveCount()).toBe(0);
    });

    it('disconnectByTokenId only affects agents under the given tokenId', () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register('agent-A', wsA, ['linux'], 'linux', 'x64', undefined, 1, {
        tokenId: 'tok-A',
      });
      registry.register('agent-B', wsB, ['linux'], 'linux', 'x64', undefined, 1, {
        tokenId: 'tok-B',
      });

      const kicked = registry.disconnectByTokenId('tok-A');

      expect(kicked).toBe(1);
      expect(wsA.close).toHaveBeenCalled();
      expect(wsB.close).not.toHaveBeenCalled();
      expect(registry.get('agent-A')).toBeUndefined();
      expect(registry.get('agent-B')).toBeDefined();
    });

    it('re-register with a different tokenId moves the entry between buckets', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();

      registry.register('agent-1', ws1, ['linux'], 'linux', 'x64', undefined, 1, {
        tokenId: 'tok-OLD',
      });
      // Reconnect under a fresh tokenId (e.g. operator rotated tokens)
      registry.register('agent-1', ws2, ['linux'], 'linux', 'x64', undefined, 1, {
        tokenId: 'tok-NEW',
      });

      // Old token bucket no longer holds agent-1
      expect(registry.disconnectByTokenId('tok-OLD')).toBe(0);
      expect(ws1.close).not.toHaveBeenCalled();
      expect(ws2.close).not.toHaveBeenCalled();

      // New token bucket does
      expect(registry.disconnectByTokenId('tok-NEW')).toBe(1);
      expect(ws2.close).toHaveBeenCalledWith(4010, 'Token revoked');
    });

    it('does not send auth.failure to a non-OPEN WS but still closes and unregisters', () => {
      const ws = mockWs();
      ws.readyState = 3; // CLOSED
      registry.register('agent-1', ws, ['linux'], 'linux', 'x64', undefined, 1, {
        tokenId: 'tok-A',
      });

      const kicked = registry.disconnectByTokenId('tok-A');

      expect(kicked).toBe(1);
      expect(ws.send).not.toHaveBeenCalled();
      expect(ws.close).toHaveBeenCalledWith(4010, 'Token revoked');
      expect(registry.get('agent-1')).toBeUndefined();
    });
  });

  // sister to disconnectByTokenId: scheduleExpiryKick fires the
  // same kick path on natural TTL expiration. Closes the
  // `token-expiry-stale-ws` finding (sister to the revoke
  // `agent-token-revocation-stale-ws`).
  describe('scheduleExpiryKick / TTL kick timer', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('fires disconnectByTokenId when the TTL elapses', () => {
      const ws = mockWs();
      registry.register('agent-1', ws, ['linux'], 'linux', 'x64', undefined, 1, {
        tokenId: 'tok-A',
      });
      registry.scheduleExpiryKick('tok-A', new Date(Date.now() + 10_000));

      // Before TTL: WS still open, agent still registered.
      expect(ws.close).not.toHaveBeenCalled();
      expect(registry.get('agent-1')).toBeDefined();

      vi.advanceTimersByTime(10_001);

      expect(ws.close).toHaveBeenCalledWith(4010, 'Token revoked');
      expect(registry.get('agent-1')).toBeUndefined();
    });

    it('does NOT close the WS while the TTL is still in the future', () => {
      const ws = mockWs();
      registry.register('agent-1', ws, ['linux'], 'linux', 'x64', undefined, 1, {
        tokenId: 'tok-A',
      });
      registry.scheduleExpiryKick('tok-A', new Date(Date.now() + 60 * 60 * 1000));

      vi.advanceTimersByTime(70_000);

      expect(ws.close).not.toHaveBeenCalled();
      expect(registry.get('agent-1')).toBeDefined();
    });

    it('kicks immediately if expiresAt is already in the past', () => {
      const ws = mockWs();
      registry.register('agent-1', ws, ['linux'], 'linux', 'x64', undefined, 1, {
        tokenId: 'tok-A',
      });
      registry.scheduleExpiryKick('tok-A', new Date(Date.now() - 1));

      // Synchronous kick — no timer advance needed.
      expect(ws.close).toHaveBeenCalledWith(4010, 'Token revoked');
      expect(registry.get('agent-1')).toBeUndefined();
    });

    it('is idempotent: re-scheduling the same tokenId does not re-arm the timer', () => {
      const ws = mockWs();
      registry.register('agent-1', ws, ['linux'], 'linux', 'x64', undefined, 1, {
        tokenId: 'tok-A',
      });
      registry.scheduleExpiryKick('tok-A', new Date(Date.now() + 10_000));
      // A reconnect under the same token re-enters the schedule call.
      // Even with a longer expiresAt, the existing timer wins (the
      // token's expires_at doesn't change across reconnects, so this
      // is the safe behavior; if it ever did change, that's a token
      // re-issue, not a reconnect).
      registry.scheduleExpiryKick('tok-A', new Date(Date.now() + 60 * 60 * 1000));

      vi.advanceTimersByTime(10_001);

      // The original 10s timer fired.
      expect(ws.close).toHaveBeenCalledTimes(1);
    });

    it('disconnectByTokenId clears the pending TTL timer (no double-kick on revoke)', () => {
      const ws = mockWs();
      registry.register('agent-1', ws, ['linux'], 'linux', 'x64', undefined, 1, {
        tokenId: 'tok-A',
      });
      registry.scheduleExpiryKick('tok-A', new Date(Date.now() + 10_000));

      // Admin revokes before TTL elapses.
      registry.disconnectByTokenId('tok-A');
      expect(ws.close).toHaveBeenCalledTimes(1);

      // Advancing past the original TTL must not re-fire (timer cleared).
      vi.advanceTimersByTime(10_001);
      expect(ws.close).toHaveBeenCalledTimes(1);
    });

    it('the last agent unregistering naturally clears the TTL timer (no leak)', () => {
      const ws = mockWs();
      registry.register('agent-1', ws, ['linux'], 'linux', 'x64', undefined, 1, {
        tokenId: 'tok-A',
      });
      registry.scheduleExpiryKick('tok-A', new Date(Date.now() + 10_000));

      registry.unregister('agent-1');

      // Timer cleared — advancing past TTL must not call close on the
      // (now-orphan) ws reference.
      vi.advanceTimersByTime(10_001);
      expect(ws.close).not.toHaveBeenCalled();
    });

    it('two agents under the same token: TTL kicks both', () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register('agent-A', wsA, ['linux'], 'linux', 'x64', undefined, 1, {
        tokenId: 'tok-shared',
      });
      registry.register('agent-B', wsB, ['linux'], 'linux', 'x64', undefined, 1, {
        tokenId: 'tok-shared',
      });
      registry.scheduleExpiryKick('tok-shared', new Date(Date.now() + 10_000));

      vi.advanceTimersByTime(10_001);

      expect(wsA.close).toHaveBeenCalledWith(4010, 'Token revoked');
      expect(wsB.close).toHaveBeenCalledWith(4010, 'Token revoked');
      expect(registry.getActiveCount()).toBe(0);
    });

    it('one agent unregistering does not clear the timer while another is still using the token', () => {
      const wsA = mockWs();
      const wsB = mockWs();
      registry.register('agent-A', wsA, ['linux'], 'linux', 'x64', undefined, 1, {
        tokenId: 'tok-shared',
      });
      registry.register('agent-B', wsB, ['linux'], 'linux', 'x64', undefined, 1, {
        tokenId: 'tok-shared',
      });
      registry.scheduleExpiryKick('tok-shared', new Date(Date.now() + 10_000));

      // Agent A disconnects naturally (one of two agents under this token).
      registry.unregister('agent-A');

      vi.advanceTimersByTime(10_001);

      // Timer still fires for the surviving agent B.
      expect(wsA.close).not.toHaveBeenCalled(); // already gone via unregister
      expect(wsB.close).toHaveBeenCalledWith(4010, 'Token revoked');
      expect(registry.get('agent-B')).toBeUndefined();
    });
  });
});
