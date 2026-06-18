/**
 * Behaviour test for the orch-side dashboard-write policy gate. Wires a
 * real `DashboardEnvHandler` with a stubbed `db` that returns a policy
 * row disabling `secrets.set`, drives the mutating handler, and asserts
 * that:
 *
 * 1. The structured `operation_disabled` envelope is sent back to
 *    Platform (no exception bubbles out).
 * 2. The underlying secret store is never invoked (defense-in-depth
 *    short-circuit fires before any state mutation).
 *
 * Pairs with `dashboard-write-coverage.test.ts` (static-grep invariant)
 * — the coverage test guards which operations are gated; this test
 * guards what the gate actually does at runtime.
 */
import { describe, it, expect, vi } from 'vitest';
import { DashboardEnvHandler, type DashboardEnvHandlerDeps } from '../ws/dashboard-env-handler.js';
import { invalidateDashboardWritePolicyCache } from './dashboard-write-policy.js';

function buildDepsWithDisabledPolicy(disabled: Record<string, boolean>): {
  deps: DashboardEnvHandlerDeps;
  sent: unknown[];
  setSecret: ReturnType<typeof vi.fn>;
  deleteSecret: ReturnType<typeof vi.fn>;
} {
  const sent: unknown[] = [];
  const setSecret = vi.fn().mockResolvedValue(undefined);
  const deleteSecret = vi.fn().mockResolvedValue(undefined);

  // The policy module calls:
  //   db.selectFrom('org_settings').select('dashboard_write_policy')
  //     .where('customer_id', '=', customerId).executeTakeFirst();
  const db = {
    selectFrom: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    executeTakeFirst: vi.fn().mockResolvedValue({ dashboard_write_policy: disabled }),
  };

  const deps: DashboardEnvHandlerDeps = {
    orgId: 'org-disabled',
    send: (msg) => sent.push(msg),
    environmentStore: {} as never,
    variableStore: {} as never,
    bindingStore: {} as never,
    secretStore: {
      listScopes: vi.fn().mockResolvedValue([]),
      listKeys: vi.fn().mockResolvedValue([]),
      setSecret,
      deleteSecret,
    },
    db: db as never,
  };

  return { deps, sent, setSecret, deleteSecret };
}

describe('orch-side dashboard-write policy gate (behaviour)', () => {
  it('short-circuits secrets.set when policy has the op disabled', async () => {
    invalidateDashboardWritePolicyCache();
    const { deps, sent, setSecret } = buildDepsWithDisabledPolicy({ 'secrets.set': false });
    const handler = new DashboardEnvHandler(deps);

    await handler.handleMessage({
      type: 'dashboard.environments.secrets.set',
      requestId: 'req-1',
      actor: { type: 'user', id: 'u-1', sub: 'sub-1' },
      scope: 'pg:aws/prod',
      key: 'API_KEY',
      value: 'plaintext-from-dashboard',
    } as never);

    expect(setSecret).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    const response = sent[0] as Record<string, unknown>;
    expect(response.type).toBe('dashboard.environments.secrets.set.response');
    expect(response.error).toBe('operation_disabled');
    expect(response.operation).toBe('secrets.set');
    expect(response.cliEquivalent).toBe('kici-admin secret set');
    expect(response.requestId).toBe('req-1');
  });

  it('short-circuits secrets.delete when policy has the op disabled', async () => {
    invalidateDashboardWritePolicyCache();
    const { deps, sent, deleteSecret } = buildDepsWithDisabledPolicy({
      'secrets.delete': false,
    });
    const handler = new DashboardEnvHandler(deps);

    await handler.handleMessage({
      type: 'dashboard.environments.secrets.delete',
      requestId: 'req-2',
      actor: { type: 'user', id: 'u-1', sub: 'sub-1' },
      scope: 'pg:aws/prod',
      key: 'API_KEY',
    } as never);

    expect(deleteSecret).not.toHaveBeenCalled();
    const response = sent[0] as Record<string, unknown>;
    expect(response.error).toBe('operation_disabled');
    expect(response.operation).toBe('secrets.delete');
  });

  it('allows the operation when policy is permissive (default)', async () => {
    invalidateDashboardWritePolicyCache();
    // Empty policy row → permissive default. The setSecret stub should fire.
    const { deps, sent, setSecret } = buildDepsWithDisabledPolicy({});
    const handler = new DashboardEnvHandler(deps);

    await handler.handleMessage({
      type: 'dashboard.environments.secrets.set',
      requestId: 'req-3',
      actor: { type: 'user', id: 'u-1', sub: 'sub-1' },
      scope: 'pg:aws/prod',
      key: 'API_KEY',
      value: 'plaintext-from-dashboard',
    } as never);

    expect(setSecret).toHaveBeenCalledOnce();
    const response = sent[0] as Record<string, unknown>;
    expect(response.error).toBeUndefined();
    expect(response.type).toBe('dashboard.environments.secrets.set.response');
  });
});
