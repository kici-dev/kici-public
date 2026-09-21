import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createAdminContextRoutes } from './admin-contexts.js';
import { ContextStore } from '../contexts/context-store.js';
import { RbacEnforcer } from '../secrets/rbac.js';

/**
 * `minimumTrust` on the three bodies that carry it — create, policy, template.
 *
 * The trust gate compares against exactly one requirement (`'trusted'`), so the
 * routes must refuse every other spelling at the door: a value that passed the
 * body would be persisted verbatim and read back as a requirement the gate
 * never holds on. The store is stubbed at the prototype so `deps.db` is never
 * touched — the question is what the handler forwards, not what SQL runs.
 */
function stubStore(existing: boolean): {
  create: ReturnType<typeof vi.spyOn>;
  update: ReturnType<typeof vi.spyOn>;
} {
  vi.spyOn(ContextStore.prototype, 'getByName').mockResolvedValue(
    existing ? ({ id: 'env-abc', name: 'production' } as never) : null,
  );
  const create = vi
    .spyOn(ContextStore.prototype, 'create')
    .mockResolvedValue({ id: 'env-new' } as never);
  const update = vi.spyOn(ContextStore.prototype, 'update').mockResolvedValue(null);
  return { create, update };
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

function post(path: string, body: Record<string, unknown>): Promise<Response> | Response {
  return buildTestApp().request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function patchPolicy(body: Record<string, unknown>): Promise<Response> | Response {
  return buildTestApp().request('http://localhost/contexts/production/policy', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orgId: 'org-1', contextName: 'production', ...body }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

const bodies: ReadonlyArray<
  [label: string, send: (minimumTrust: unknown) => Promise<Response> | Response, existing: boolean]
> = [
  [
    'POST /contexts (create)',
    (minimumTrust) => post('/contexts', { orgId: 'org-1', name: 'production', minimumTrust }),
    false,
  ],
  [
    'POST /contexts (upsert of an existing context)',
    (minimumTrust) => post('/contexts', { orgId: 'org-1', name: 'production', minimumTrust }),
    true,
  ],
  ['PATCH /contexts/:name/policy', (minimumTrust) => patchPolicy({ minimumTrust }), true],
  [
    'POST /contexts/templates',
    (minimumTrust) =>
      post('/contexts/templates', { orgId: 'org-1', templateName: 'production', minimumTrust }),
    false,
  ],
];

describe.each(bodies)('%s — minimumTrust', (_label, send, existing) => {
  // fails-when: the body schema admits the removed `known` requirement again,
  // so it reaches the store and is persisted as a tier the gate never holds on
  it('refuses the removed known requirement with a structured 400', async () => {
    const { create, update } = stubStore(existing);

    const res = await send('known');

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Validation error' });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  // fails-when: the schema widens back to any string
  it('refuses a tier the gate does not compare against', async () => {
    const { create, update } = stubStore(existing);

    const res = await send('unknown');

    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  // breaks-if-wrong: the one live requirement must still reach the store
  it('forwards trusted to the store', async () => {
    const { create, update } = stubStore(existing);

    const res = await send('trusted');

    expect([200, 201]).toContain(res.status);
    const forwarded = existing ? update.mock.calls[0]?.[2] : create.mock.calls[0]?.[1];
    expect(forwarded).toMatchObject({ minimumTrust: 'trusted' });
  });

  // breaks-if-wrong: clearing the requirement must still reach the store as null
  it('forwards an explicit null so the requirement is cleared', async () => {
    const { create, update } = stubStore(existing);

    const res = await send(null);

    expect([200, 201]).toContain(res.status);
    const forwarded = existing ? update.mock.calls[0]?.[2] : create.mock.calls[0]?.[1];
    expect(forwarded).toMatchObject({ minimumTrust: null });
  });
});
