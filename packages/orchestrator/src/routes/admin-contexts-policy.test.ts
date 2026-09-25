import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createAdminContextRoutes } from './admin-contexts.js';
import { ContextStore } from '../contexts/context-store.js';
import { RbacEnforcer } from '../secrets/rbac.js';

/**
 * PATCH /contexts/:name/policy — how the handler forwards nullable protection
 * fields, and where it rejects a value the gates cannot survive.
 *
 * The store is stubbed at the prototype so `deps.db` is never touched: the
 * question here is which `updates` keys the handler builds, not what SQL the
 * store emits.
 */
function stubStore(): {
  getByName: ReturnType<typeof vi.spyOn>;
  update: ReturnType<typeof vi.spyOn>;
} {
  const getByName = vi
    .spyOn(ContextStore.prototype, 'getByName')
    .mockResolvedValue({ id: 'env-abc', name: 'production' } as never);
  const update = vi.spyOn(ContextStore.prototype, 'update').mockResolvedValue(null);
  return { getByName, update };
}

function buildTestApp(): Hono {
  const inner = createAdminContextRoutes({ db: {} as never, rbac: new RbacEnforcer() });
  const root = new Hono();
  root.use('*', async (c, next) => {
    c.set('role' as never, 'admin' as never);
    c.set('userId' as never, 'tester' as never);
    c.set('routingKey' as never, null as never);
    await next();
  });
  root.route('/', inner);
  return root;
}

function patchPolicy(body: Record<string, unknown>): Promise<Response> {
  return buildTestApp().request('http://localhost/contexts/production/policy', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orgId: 'org-1', contextName: 'production', ...body }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PATCH /contexts/:name/policy — clearing nullable fields', () => {
  it('forwards an explicit null hold expiry so the column is cleared', async () => {
    const { update } = stubStore();

    const res = await patchPolicy({ holdExpirySeconds: null });

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      'org-1',
      'env-abc',
      expect.objectContaining({ holdExpirySeconds: null }),
    );
  });

  it('round-trips a positive hold expiry unchanged', async () => {
    const { update } = stubStore();

    const res = await patchPolicy({ holdExpirySeconds: 30 });

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      'org-1',
      'env-abc',
      expect.objectContaining({ holdExpirySeconds: 30 }),
    );
  });

  it('clears every nullable protection field on the same request', async () => {
    // Anti-divergence pin: these three share one schema and one handler, so a
    // future edit that special-cases any of them shows up here.
    const { update } = stubStore();

    const res = await patchPolicy({
      requiredReviewers: null,
      waitTimerSeconds: null,
      holdExpirySeconds: null,
    });

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith('org-1', 'env-abc', {
      requiredReviewers: null,
      waitTimerSeconds: null,
      holdExpirySeconds: null,
    });
  });
});

describe('PATCH /contexts/:name/policy — zero hold expiry', () => {
  it('rejects a zero hold expiry without touching the store', async () => {
    // A 0-second expiry puts `holdUntil` at the current instant, so every
    // reviewer hold on the context is created already overdue and swept to
    // `expired` — cancelling the job the hold was meant to gate.
    const { update } = stubStore();

    const res = await patchPolicy({ holdExpirySeconds: 0 });

    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('still rejects a negative hold expiry', async () => {
    const { update } = stubStore();

    const res = await patchPolicy({ holdExpirySeconds: -1 });

    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps accepting a zero wait timer', async () => {
    // The wait-timer gate skips on `null` only, so a 0-second wait timer is a
    // coherent "release immediately" and must not be caught by the tightening.
    const { update } = stubStore();

    const res = await patchPolicy({ waitTimerSeconds: 0 });

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      'org-1',
      'env-abc',
      expect.objectContaining({ waitTimerSeconds: 0 }),
    );
  });
});

describe('repository patterns', () => {
  it('PATCH forwards repo patterns, and an empty list clears them', async () => {
    const { update } = stubStore();

    const set = await patchPolicy({ repoPatterns: ['acme/workflows'] });
    const cleared = await patchPolicy({ repoPatterns: [] });

    expect(set.status).toBe(200);
    expect(cleared.status).toBe(200);
    // fails-when: setPolicySchema strips repoPatterns, so the request carries no policy field
    expect(update).toHaveBeenNthCalledWith(1, 'org-1', 'env-abc', {
      repoPatterns: ['acme/workflows'],
    });
    expect(update).toHaveBeenNthCalledWith(2, 'org-1', 'env-abc', { repoPatterns: [] });
  });

  it('PATCH rejects repo patterns that are not an array of strings', async () => {
    const { update } = stubStore();

    const res = await patchPolicy({ repoPatterns: 'acme/*' });

    // fails-when: the schema accepts a bare string and the gate compares it character by character
    // breaks-if-wrong: the array form above must still reach the store
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('POST create forwards repo patterns to a new context', async () => {
    vi.spyOn(ContextStore.prototype, 'getByName').mockResolvedValue(null);
    const create = vi
      .spyOn(ContextStore.prototype, 'create')
      .mockResolvedValue({ id: 'env-new' } as never);

    const res = await buildTestApp().request('http://localhost/contexts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: 'org-1', name: 'deploy', repoPatterns: ['acme/*'] }),
    });

    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ name: 'deploy', repoPatterns: ['acme/*'] }),
    );
  });

  it('POST upsert forwards repo patterns to an existing context', async () => {
    const { update } = stubStore();

    const res = await buildTestApp().request('http://localhost/contexts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: 'org-1', name: 'production', repoPatterns: ['acme/*'] }),
    });

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      'org-1',
      'env-abc',
      expect.objectContaining({ repoPatterns: ['acme/*'] }),
    );
  });

  it('GET show returns the stored repo patterns', async () => {
    vi.spyOn(ContextStore.prototype, 'getByName').mockResolvedValue({
      id: 'env-abc',
      name: 'production',
      repo_patterns: ['acme/workflows'],
    } as never);
    const { BindingStore } = await import('../contexts/binding-store.js');
    const { VariableStore } = await import('../contexts/variable-store.js');
    vi.spyOn(BindingStore.prototype, 'list').mockResolvedValue([]);
    vi.spyOn(VariableStore.prototype, 'listVars').mockResolvedValue([]);

    const res = await buildTestApp().request('http://localhost/contexts/production?orgId=org-1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { context: { repo_patterns: string[] } };
    expect(body.context.repo_patterns).toEqual(['acme/workflows']);
  });
});
