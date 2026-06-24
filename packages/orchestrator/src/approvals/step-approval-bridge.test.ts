import { describe, it, expect, vi } from 'vitest';
import { HoldScope, TriggerSource } from '@kici-dev/engine';

import { StepApprovalBridge } from './step-approval-bridge.js';
import type { HeldRunStore } from '../environments/held-runs.js';

function fakeStore(createId = 'hold-1'): {
  store: HeldRunStore;
  createHold: ReturnType<typeof vi.fn>;
} {
  const createHold = vi.fn().mockResolvedValue({ id: createId });
  const store = { createHold } as unknown as HeldRunStore;
  return { store, createHold };
}

describe('StepApprovalBridge', () => {
  it('creates a step-scoped hold and resolves on approve', async () => {
    const { store, createHold } = fakeStore();
    const bridge = new StepApprovalBridge({
      store,
      resolveOrgId: () => 'org-1',
      resolveExpirySeconds: async () => 3600,
    });

    const pending = bridge.request({
      agentId: 'agent-1',
      runId: 'run-1',
      jobId: 'deploy',
      stepIndex: 2,
      stepName: 'apply',
      clauses: [{ team: 'leads' }],
      reason: 'gate',
    });

    // Let the createHold promise settle so the resolver is registered.
    await Promise.resolve();
    await Promise.resolve();

    expect(createHold).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({
        runId: 'run-1',
        jobId: 'deploy',
        scope: HoldScope.enum.step,
        stepIndex: 2,
        triggerSource: TriggerSource.enum.explicit,
      }),
    );
    expect(bridge.size()).toBe(1);

    expect(bridge.resolve('hold-1', 'approved')).toBe(true);
    await expect(pending).resolves.toEqual({ outcome: 'approved' });
    expect(bridge.size()).toBe(0);
  });

  it('passes a drift payload through to createHold', async () => {
    const { store, createHold } = fakeStore('hold-payload');
    const bridge = new StepApprovalBridge({
      store,
      resolveOrgId: () => 'org-1',
      resolveExpirySeconds: async () => 3600,
    });
    const payload = { summaryMarkdown: '## drift', drift: { want: 1 } };

    const pending = bridge.request({
      agentId: 'agent-1',
      runId: 'run-1',
      jobId: 'deploy',
      stepIndex: 3,
      stepName: 'apply',
      clauses: [{ team: 'ops' }],
      reason: 'prod patch',
      payload,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(createHold).toHaveBeenCalledWith('org-1', expect.objectContaining({ payload }));
    bridge.resolve('hold-payload', 'approved');
    await expect(pending).resolves.toEqual({ outcome: 'approved' });
  });

  it('omits payload from createHold for a non-drift hold', async () => {
    const { store, createHold } = fakeStore('hold-nopayload');
    const bridge = new StepApprovalBridge({
      store,
      resolveOrgId: () => 'org-1',
      resolveExpirySeconds: async () => 3600,
    });
    bridge.request({
      agentId: 'agent-1',
      runId: 'r',
      jobId: 'j',
      stepIndex: 0,
      stepName: 's',
      clauses: [],
      reason: 'gate',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect('payload' in createHold.mock.calls[0][1]).toBe(false);
  });

  it('resolves with the reject reason', async () => {
    const { store } = fakeStore('hold-2');
    const bridge = new StepApprovalBridge({
      store,
      resolveOrgId: () => 'org-1',
      resolveExpirySeconds: async () => 3600,
    });
    const pending = bridge.request({
      agentId: 'agent-1',
      runId: 'r',
      jobId: 'j',
      stepIndex: 0,
      stepName: 's',
      clauses: [],
      reason: 'gate',
    });
    await Promise.resolve();
    await Promise.resolve();
    bridge.resolve('hold-2', 'rejected', 'nope');
    await expect(pending).resolves.toEqual({ outcome: 'rejected', reason: 'nope' });
  });

  it('uses the SDK timeout over the org default when present', async () => {
    const resolveExpirySeconds = vi.fn().mockResolvedValue(3600);
    const { store, createHold } = fakeStore('hold-3');
    const bridge = new StepApprovalBridge({
      store,
      resolveOrgId: () => 'org-1',
      resolveExpirySeconds,
    });
    bridge.request({
      agentId: 'a',
      runId: 'r',
      jobId: 'j',
      stepIndex: 0,
      stepName: 's',
      clauses: [],
      reason: 'gate',
      timeoutSeconds: 120,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolveExpirySeconds).not.toHaveBeenCalled();
    const requirement = createHold.mock.calls[0][1].requirement;
    const ttlMs = new Date(requirement.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(60_000);
    expect(ttlMs).toBeLessThanOrEqual(120_000);
  });

  it('emits a held_run.request audit row on step-hold creation', async () => {
    const { store } = fakeStore('hold-audit');
    const record = vi.fn().mockResolvedValue(undefined);
    const bridge = new StepApprovalBridge({
      store,
      resolveOrgId: () => 'org-1',
      resolveExpirySeconds: async () => 3600,
      accessLogWriter: { record } as never,
      routingKey: 'github:42',
    });
    bridge.request({
      agentId: 'a',
      runId: 'run-9',
      jobId: 'deploy',
      stepIndex: 3,
      stepName: 'apply',
      clauses: [{ team: 'leads' }],
      reason: 'gate',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-1',
        routingKey: 'github:42',
        actor: { type: 'system', component: 'dispatcher' },
        action: 'held_run.request',
        target: { type: 'held_run', id: 'hold-audit' },
        outcome: 'allowed',
      }),
    );
  });

  it('rejects a disconnected agent and drops the resolver', async () => {
    const { store } = fakeStore('hold-4');
    const bridge = new StepApprovalBridge({
      store,
      resolveOrgId: () => 'org-1',
      resolveExpirySeconds: async () => 3600,
    });
    const pending = bridge.request({
      agentId: 'gone',
      runId: 'r',
      jobId: 'j',
      stepIndex: 0,
      stepName: 's',
      clauses: [],
      reason: 'gate',
    });
    await Promise.resolve();
    await Promise.resolve();
    bridge.failAgent('gone');
    await expect(pending).rejects.toThrow('agent disconnected');
    expect(bridge.size()).toBe(0);
    // A late resolve for the dropped hold is a no-op.
    expect(bridge.resolve('hold-4', 'approved')).toBe(false);
  });
});
