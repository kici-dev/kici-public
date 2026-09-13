import { describe, it, expect, vi } from 'vitest';
import { HoldScope, TriggerSource } from '@kici-dev/engine';

import { StepApprovalBridge } from './step-approval-bridge.js';
import type { HeldRunStore } from '../contexts/held-runs.js';

function fakeStore(createId = 'hold-1'): {
  store: HeldRunStore;
  createHold: ReturnType<typeof vi.fn>;
} {
  const createHold = vi.fn().mockResolvedValue({ id: createId });
  const store = { createHold } as unknown as HeldRunStore;
  return { store, createHold };
}

/**
 * Let `request()`'s in-flight chain run to the point where it parks on the
 * pending-approval promise.
 *
 * `request()` is deliberately not awaited here — it only settles once someone
 * calls `resolve()` — so its hold creation and audit write have to be waited for
 * some other way. Counting microtask ticks (`await Promise.resolve()` twice) is
 * not that way: it pins the assertions to the exact number of `await`s the
 * implementation happens to traverse today. Adding one behaviour-neutral `await`
 * to `request()` breaks five of these tests, which means they were measuring the
 * implementation's shape rather than its effect.
 *
 * Every mock in this file settles on the microtask queue with no timer or I/O in
 * it, so yielding one macrotask turn drains the whole chain however long it is —
 * deterministically, not by racing it.
 */
async function settleRequest(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
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

    await settleRequest();

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
    await settleRequest();

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
    await settleRequest();
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
    await settleRequest();
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
    await settleRequest();
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
    await settleRequest();
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
    await settleRequest();
    bridge.failAgent('gone');
    await expect(pending).rejects.toThrow('agent disconnected');
    expect(bridge.size()).toBe(0);
    // A late resolve for the dropped hold is a no-op.
    expect(bridge.resolve('hold-4', 'approved')).toBe(false);
  });
});

describe('StepApprovalBridge.request timeout guard', () => {
  it('rejects an invalid timeout without creating a hold', async () => {
    const { store, createHold } = fakeStore();
    const bridge = new StepApprovalBridge({
      store,
      resolveOrgId: () => 'org-1',
      resolveExpirySeconds: async () => 86400,
    });

    const res = await bridge.request({
      agentId: 'agent-1',
      runId: 'run-1',
      jobId: 'deploy',
      stepIndex: 0,
      stepName: 'apply',
      clauses: [],
      reason: 'gate',
      timeoutSeconds: 0,
    });

    expect(res.outcome).toBe('rejected');
    expect(createHold).not.toHaveBeenCalled();
    expect(bridge.size()).toBe(0);
  });

  it('creates a hold for a valid timeout', async () => {
    const { store, createHold } = fakeStore();
    const bridge = new StepApprovalBridge({
      store,
      resolveOrgId: () => 'org-1',
      resolveExpirySeconds: async () => 86400,
    });

    bridge.request({
      agentId: 'agent-1',
      runId: 'run-1',
      jobId: 'deploy',
      stepIndex: 0,
      stepName: 'apply',
      clauses: [],
      reason: 'gate',
      timeoutSeconds: 120,
    });
    await settleRequest();

    expect(createHold).toHaveBeenCalledTimes(1);
  });
});
