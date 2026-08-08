/**
 * Tests for the `/api/v1/admin/trust-policy` admin routes.
 *
 * Two load-bearing assertions:
 *
 * 1. The PATCH refusal on a Platform-attached orchestrator. It is server-side,
 *    so a caller hitting the API directly cannot write a policy the next
 *    Platform push would silently clobber.
 * 2. RBAC. The harness mounts the routes under an OUTER Hono app whose
 *    middleware seeds `role` BEFORE the handlers run, and uses the real
 *    `RbacEnforcer` — mirroring `admin-cluster-settings.test.ts`. Seeding the
 *    role on the same instance the handlers are registered on runs the
 *    middleware too late (`c.get('role')` is undefined) and stubbing the
 *    enforcer makes every permission check a no-op, so the suite would be
 *    green about nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { OrchestratorMode } from '@kici-dev/engine';
import { createTrustPolicyRoutes, PLATFORM_MANAGED_MESSAGE } from './admin-trust-policy.js';
import type { StoredTrustPolicy } from '../security/trust-policy-store.js';
import type { TrustPolicyStore } from '../security/trust-policy-store.js';
import { RbacEnforcer, type Role } from '../secrets/rbac.js';
import { TrustPolicyEnforcement } from '../security/trust-policy-gate.js';
import type { AccessLogRecord, AccessLogWriter } from '../audit/access-log.js';

const STORED: StoredTrustPolicy = {
  forkPolicy: 'reject',
  unknownContributorPolicy: 'hold',
  workflowChangePolicy: 'allow',
  approvalExpiryHours: 12,
  source: 'platform',
  updatedAt: new Date('2026-07-29T00:00:00Z'),
};

/**
 * Rows the fake transaction accumulated, exposed for assertions. Typed as the
 * real `AccessLogRecord` so an assertion can only name fields the route
 * genuinely writes — a narrower local shape silently hid `actor`, which is the
 * whole point of the row.
 */
type AuditRow = AccessLogRecord;

function makeApp(opts: {
  mode: (typeof OrchestratorMode.options)[number];
  stored?: StoredTrustPolicy | null;
  upsertLocal?: ReturnType<typeof vi.fn>;
  /** Seeded principal. Defaults to a full `admin`. */
  role?: Role;
  routingKey?: string | null;
}) {
  const get = vi.fn().mockResolvedValue(opts.stored ?? null);
  const auditRows: AuditRow[] = [];
  // Mimics the real store: it runs the merge in a transaction and invokes
  // `onWrite` with that transaction, so a thrown audit write rolls the policy
  // write back. The fake commits by pushing to `auditRows` only if `onWrite`
  // resolved.
  const upsertLocal =
    opts.upsertLocal ??
    vi.fn(
      async (
        _orgId: string,
        patch: Record<string, unknown>,
        onWrite?: (trx: unknown, merged: Record<string, unknown>) => Promise<void>,
      ) => {
        const merged = {
          forkPolicy: 'hold',
          unknownContributorPolicy: 'hold',
          workflowChangePolicy: 'hold',
          approvalExpiryHours: 72,
          ...patch,
        };
        const staged: AuditRow[] = [];
        await onWrite?.({ staged }, merged);
        auditRows.push(...staged);
        return merged;
      },
    );
  const store = { get, upsertLocal } as unknown as TrustPolicyStore;
  const accessLog = {
    recordInTransaction: vi.fn(async (trx: { staged: AuditRow[] }, entry: AuditRow) => {
      trx.staged.push(entry);
    }),
  } as unknown as AccessLogWriter;

  const inner = createTrustPolicyRoutes({
    store,
    rbac: new RbacEnforcer(),
    mode: opts.mode,
    accessLog,
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('role' as never, (opts.role ?? 'admin') as never);
    c.set('userId' as never, 'tester' as never);
    c.set('routingKey' as never, (opts.routingKey ?? null) as never);
    await next();
  });
  app.route('/', inner);
  return { app, get, upsertLocal, auditRows, accessLog };
}

async function getPolicy(app: Hono, customerId = 'org-1') {
  const res = await app.request(`/trust-policy?customerId=${customerId}`);
  return { status: res.status, body: (await res.json()) as { policy?: Record<string, unknown> } };
}

async function patchPolicy(app: Hono, body: Record<string, unknown>) {
  const res = await app.request('/trust-policy', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('trust-policy route harness', () => {
  it('actually seeds the role the handlers read', async () => {
    // Guards the defect this harness was rebuilt to remove: with the seeding
    // middleware registered after the handlers, `role` is undefined and the
    // real enforcer refuses everything — so an all-green suite would be green
    // about nothing. A 200 here proves the middleware runs first.
    const { app } = makeApp({ mode: 'independent', stored: STORED, role: 'owner' });
    const { status } = await getPolicy(app);
    expect(status).toBe(200);
  });
});

describe('GET /trust-policy', () => {
  it('requires customerId', async () => {
    const { app } = makeApp({ mode: 'independent' });
    const res = await app.request('/trust-policy');
    expect(res.status).toBe(400);
  });

  it('returns the stored policy with its provenance', async () => {
    const { app } = makeApp({ mode: 'platform', stored: STORED });
    const { body } = await getPolicy(app);
    expect(body.policy).toMatchObject({
      customerId: 'org-1',
      forkPolicy: 'reject',
      approvalExpiryHours: 12,
      source: 'platform',
      effectiveDefault: false,
      enforcement: TrustPolicyEnforcement.enum.policy,
      platformManaged: true,
    });
  });

  it('reports the fail-closed defaults when Platform-attached with no row', async () => {
    const { app } = makeApp({ mode: 'platform', stored: null });
    const { body } = await getPolicy(app);
    expect(body.policy).toMatchObject({
      forkPolicy: 'hold',
      unknownContributorPolicy: 'hold',
      workflowChangePolicy: 'hold',
      source: null,
      effectiveDefault: true,
      enforcement: TrustPolicyEnforcement.enum.policy,
    });
  });

  it('omits the policy fields in legacy mode rather than reporting unenforced values', async () => {
    // Legacy mode runs only the workflow-modification rule; no policy arm is in
    // force. Reporting `forkPolicy: 'hold'` here would tell an operator fork PRs
    // are being held when nothing holds them — the same false assurance this
    // whole feature exists to remove.
    const { app } = makeApp({ mode: 'independent', stored: null });
    const { body } = await getPolicy(app);
    expect(body.policy).toMatchObject({
      enforcement: TrustPolicyEnforcement.enum.legacy,
      effectiveDefault: true,
      platformManaged: false,
    });
    expect(body.policy).not.toHaveProperty('forkPolicy');
    expect(body.policy).not.toHaveProperty('unknownContributorPolicy');
    expect(body.policy).not.toHaveProperty('workflowChangePolicy');
    expect(body.policy).not.toHaveProperty('approvalExpiryHours');
  });

  it('reads the policy for the requested org', async () => {
    const { app, get } = makeApp({ mode: 'independent', stored: STORED });
    await getPolicy(app, 'org-42');
    expect(get).toHaveBeenCalledWith('org-42');
  });
});

describe('PATCH /trust-policy', () => {
  it.each(['platform', 'hybrid', 'observed'] as const)(
    'refuses with 409 on a %s-mode orchestrator',
    async (mode) => {
      const { app, upsertLocal } = makeApp({ mode });
      const { status, body } = await patchPolicy(app, {
        customerId: 'org-1',
        forkPolicy: 'allow',
      });
      expect(status).toBe(409);
      expect(body.error).toBe(PLATFORM_MANAGED_MESSAGE);
      // The refusal must happen before any write.
      expect(upsertLocal).not.toHaveBeenCalled();
    },
  );

  it('accepts a write in independent mode', async () => {
    const { app, upsertLocal } = makeApp({ mode: 'independent', stored: STORED });
    const { status } = await patchPolicy(app, { customerId: 'org-1', forkPolicy: 'allow' });
    expect(status).toBe(200);
    expect(upsertLocal).toHaveBeenCalledWith(
      'org-1',
      { forkPolicy: 'allow' },
      expect.any(Function),
    );
  });

  it('rejects an unknown policy value rather than storing it', async () => {
    const { app, upsertLocal } = makeApp({ mode: 'independent' });
    const { status } = await patchPolicy(app, { customerId: 'org-1', forkPolicy: 'whatever' });
    expect(status).not.toBe(200);
    expect(upsertLocal).not.toHaveBeenCalled();
  });

  it('rejects `allow` for the unknown-contributor policy (no such wire value)', async () => {
    const { app, upsertLocal } = makeApp({ mode: 'independent' });
    const { status } = await patchPolicy(app, {
      customerId: 'org-1',
      unknownContributorPolicy: 'allow',
    });
    expect(status).not.toBe(200);
    expect(upsertLocal).not.toHaveBeenCalled();
  });

  it('rejects a non-positive approval expiry', async () => {
    const { app, upsertLocal } = makeApp({ mode: 'independent' });
    const { status } = await patchPolicy(app, { customerId: 'org-1', approvalExpiryHours: 0 });
    expect(status).not.toBe(200);
    expect(upsertLocal).not.toHaveBeenCalled();
  });

  it('covers every orchestrator mode with an explicit accept/refuse verdict', async () => {
    // A mode added later must make a deliberate choice rather than silently
    // becoming writable.
    for (const mode of OrchestratorMode.options) {
      const { app } = makeApp({ mode, stored: STORED });
      const { status } = await patchPolicy(app, { customerId: 'org-1', forkPolicy: 'allow' });
      if (mode === 'independent') expect(status).toBe(200);
      else expect(status, `${mode} must refuse`).toBe(409);
    }
  });
});

describe('trust-policy RBAC', () => {
  it('refuses an auditor on PATCH', async () => {
    const { app, upsertLocal } = makeApp({ mode: 'independent', role: 'auditor' });
    const { status } = await patchPolicy(app, { customerId: 'org-1', forkPolicy: 'allow' });
    expect(status).toBe(403);
    expect(upsertLocal).not.toHaveBeenCalled();
  });

  it('refuses an auditor on GET', async () => {
    // The trust policy decides whether a fork PR runs at all, so it is not a
    // read-only-role surface; an auditor observes changes via access_log.
    const { app, get } = makeApp({ mode: 'independent', stored: STORED, role: 'auditor' });
    const { status } = await getPolicy(app);
    expect(status).toBe(403);
    expect(get).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'] as const)('allows %s on PATCH', async (role) => {
    const { app, upsertLocal } = makeApp({ mode: 'independent', role });
    const { status } = await patchPolicy(app, { customerId: 'org-1', forkPolicy: 'allow' });
    expect(status).toBe(200);
    expect(upsertLocal).toHaveBeenCalled();
  });

  it('refuses a routing-key-scoped principal on GET', async () => {
    // The policy is per-org, not per-routing-key; a scoped token has no org-wide
    // authority and must not read (or write) it.
    const { app, get } = makeApp({
      mode: 'independent',
      stored: STORED,
      routingKey: 'rk-scoped',
    });
    const { status } = await getPolicy(app);
    expect(status).toBe(403);
    expect(get).not.toHaveBeenCalled();
  });

  it('refuses a routing-key-scoped principal on PATCH', async () => {
    const { app, upsertLocal } = makeApp({ mode: 'independent', routingKey: 'rk-scoped' });
    const { status } = await patchPolicy(app, { customerId: 'org-1', forkPolicy: 'allow' });
    expect(status).toBe(403);
    expect(upsertLocal).not.toHaveBeenCalled();
  });
});

describe('trust-policy audit', () => {
  it('writes a trust_policy.updated row inside the policy transaction', async () => {
    const { app, auditRows, accessLog } = makeApp({ mode: 'independent' });
    const { status } = await patchPolicy(app, { customerId: 'org-9', forkPolicy: 'allow' });
    expect(status).toBe(200);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'trust_policy.updated',
      orgId: 'org-9',
      source: 'admin_http',
      outcome: 'allowed',
      meta: { patch: { forkPolicy: 'allow' }, policy: { forkPolicy: 'allow' } },
    });
    // Attribution is the reason this row exists: a policy that loosens
    // `forkPolicy` must name the principal that loosened it, taken from the
    // admin token the auth middleware resolved (`userId`), not a placeholder.
    expect(auditRows[0]?.actor).toEqual({ type: 'service_account', id: 'tester' });
    // The executor handed to the writer must be the store's transaction, not
    // the writer's own pool — otherwise the row commits independently of the
    // policy it audits.
    const trx = vi.mocked(accessLog.recordInTransaction).mock.calls[0]?.[0];
    expect(trx).toHaveProperty('staged');
  });

  it('writes no audit row when RBAC refuses', async () => {
    const { app, auditRows } = makeApp({ mode: 'independent', role: 'auditor' });
    await patchPolicy(app, { customerId: 'org-1', forkPolicy: 'allow' });
    expect(auditRows).toHaveLength(0);
  });

  it('writes no audit row when a Platform-attached orchestrator refuses', async () => {
    const { app, auditRows } = makeApp({ mode: 'platform' });
    await patchPolicy(app, { customerId: 'org-1', forkPolicy: 'allow' });
    expect(auditRows).toHaveLength(0);
  });
});
