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
import {
  createTrustPolicyRoutes,
  PLATFORM_MANAGED_DIRECTORY_MESSAGE,
  PLATFORM_MANAGED_MESSAGE,
} from './admin-trust-policy.js';
import type { StoredTrustPolicy } from '../security/trust-policy-store.js';
import type { TrustPolicyStore } from '../security/trust-policy-store.js';
import {
  applyMemberRegistration,
  emptyTrustDirectory,
  removeMemberFromDirectory,
  type DirectoryMemberRegistration,
  type StoredTrustDirectory,
  type TrustDirectory,
  type TrustDirectoryStore,
} from '../security/trust-directory-store.js';
import { RbacEnforcer, type Role } from '../secrets/rbac.js';
import { DEFAULT_FORK_POLICY, TrustPolicyEnforcement } from '../security/trust-policy-gate.js';
import type { AccessLogRecord, AccessLogWriter } from '../audit/access-log.js';

const STORED: StoredTrustPolicy = {
  forkPolicy: 'reject',
  unknownContributorPolicy: 'hold',
  workflowChangePolicy: 'allow',
  approvalExpiryHours: 12,
  source: 'platform',
  updatedAt: new Date('2026-07-29T00:00:00Z'),
};

const STORED_DIRECTORY: StoredTrustDirectory = {
  identityLinks: [
    { userId: 'user-1', provider: 'github', providerUsername: 'alice', providerUserId: '4242' },
  ],
  memberCiTrustLevels: { 'user-1': 'admin' },
  teamMemberships: [{ teamName: 'platform', memberUserIds: ['user-1'] }],
  updatedAt: new Date('2026-08-27T00:00:00Z'),
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
  /** Cached approval directory the `directory` endpoint reads. */
  storedDirectory?: StoredTrustDirectory | null;
  /** Seeded principal. Defaults to a full `admin`. */
  role?: Role;
  routingKey?: string | null;
}) {
  const get = vi.fn().mockResolvedValue(opts.stored ?? null);
  const auditRows: AuditRow[] = [];

  // The directory fake holds real state and runs the REAL merge helpers, so a
  // route test proves what actually gets stored rather than that a stub was
  // called. `upsertLocalMember` / `removeLocalMember` stage their audit row
  // through the same `staged` transaction shape as the policy fake below, and
  // commit it only once `onWrite` resolved.
  let liveDirectory: StoredTrustDirectory | null = opts.storedDirectory ?? null;
  const loadDirectory = vi.fn(async () => liveDirectory);
  const commitDirectory = async (
    next: TrustDirectory,
    onWrite?: (trx: unknown, merged: TrustDirectory) => Promise<void>,
  ) => {
    const staged: AuditRow[] = [];
    await onWrite?.({ staged }, next);
    liveDirectory = { ...next, updatedAt: new Date('2026-08-28T00:00:00Z') };
    auditRows.push(...staged);
  };
  const upsertLocalMember = vi.fn(
    async (
      _orgId: string,
      registration: DirectoryMemberRegistration,
      onWrite?: (trx: unknown, merged: TrustDirectory) => Promise<void>,
    ) => {
      const merged = applyMemberRegistration(liveDirectory ?? emptyTrustDirectory(), registration);
      await commitDirectory(merged, onWrite);
      return merged;
    },
  );
  const removeLocalMember = vi.fn(
    async (
      _orgId: string,
      userId: string,
      onWrite?: (trx: unknown, merged: TrustDirectory, removed: boolean) => Promise<void>,
    ) => {
      const result = removeMemberFromDirectory(liveDirectory ?? emptyTrustDirectory(), userId);
      await commitDirectory(result.directory, (trx, merged) =>
        onWrite ? onWrite(trx, merged, result.removed) : Promise.resolve(),
      );
      return result;
    },
  );
  const directory = {
    load: loadDirectory,
    upsertLocalMember,
    removeLocalMember,
  } as unknown as TrustDirectoryStore;
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
    directory,
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
  return {
    app,
    get,
    upsertLocal,
    auditRows,
    accessLog,
    loadDirectory,
    upsertLocalMember,
    removeLocalMember,
  };
}

async function getDirectory(app: Hono, customerId = 'org-1') {
  const res = await app.request(`/trust-policy/directory?customerId=${customerId}`);
  return {
    status: res.status,
    body: (await res.json()) as {
      directory?: Record<string, unknown> | null;
      platformManaged?: boolean;
      error?: string;
    },
  };
}

async function getPolicy(app: Hono, customerId = 'org-1') {
  const res = await app.request(`/trust-policy?customerId=${customerId}`);
  return { status: res.status, body: (await res.json()) as { policy?: Record<string, unknown> } };
}

const REGISTRATION = {
  customerId: 'org-1',
  userId: 'user-7',
  provider: 'github',
  providerUsername: 'carol',
  providerUserId: '7070',
  ciTrust: 'write',
};

async function patchDirectory(app: Hono, body: Record<string, unknown> = REGISTRATION) {
  const res = await app.request('/trust-policy/directory', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function deleteDirectory(app: Hono, query = 'customerId=org-1&userId=user-1') {
  const res = await app.request(`/trust-policy/directory?${query}`, { method: 'DELETE' });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
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
      forkPolicy: DEFAULT_FORK_POLICY,
      unknownContributorPolicy: 'hold',
      workflowChangePolicy: 'hold',
      source: null,
      effectiveDefault: true,
      enforcement: TrustPolicyEnforcement.enum.policy,
    });
  });

  it('reports the same fail-closed defaults in independent mode with no row', async () => {
    // An independent orchestrator has no upstream authority, which is a reason
    // to be stricter rather than more permissive: it gets the same policy, and
    // the values it reports are the ones actually applied.
    const { app } = makeApp({ mode: 'independent', stored: null });
    const { body } = await getPolicy(app);
    expect(body.policy).toMatchObject({
      forkPolicy: DEFAULT_FORK_POLICY,
      enforcement: TrustPolicyEnforcement.enum.policy,
      effectiveDefault: true,
      platformManaged: false,
    });
  });

  it('reports enforcement `policy` for every mode, with and without a row', async () => {
    // The field is deprecated and now constant; older `kici-admin` binaries key
    // their rendering off it, so it must never come back as anything else.
    for (const mode of OrchestratorMode.options) {
      for (const stored of [STORED, null]) {
        const { app } = makeApp({ mode, stored });
        const { body } = await getPolicy(app);
        expect(body.policy.enforcement).toBe(TrustPolicyEnforcement.enum.policy);
        expect(body.policy).toHaveProperty('forkPolicy');
      }
    }
  });

  it('accepts `ignore` as a fork policy', async () => {
    // The value an orchestrator with no stored row already applies, so it has
    // to be expressible by an operator who wants to pin it explicitly.
    const { app, upsertLocal } = makeApp({ mode: 'independent', stored: STORED });
    const { status } = await patchPolicy(app, { customerId: 'org-1', forkPolicy: 'ignore' });
    expect(status).toBe(200);
    expect(upsertLocal).toHaveBeenCalledWith(
      'org-1',
      { forkPolicy: 'ignore' },
      expect.any(Function),
    );
  });

  it('reads the policy for the requested org', async () => {
    const { app, get } = makeApp({ mode: 'independent', stored: STORED });
    await getPolicy(app, 'org-42');
    expect(get).toHaveBeenCalledWith('org-42');
  });
});

describe('GET /trust-policy/directory', () => {
  it('requires customerId', async () => {
    const { app } = makeApp({ mode: 'platform' });
    const res = await app.request('/trust-policy/directory');
    expect(res.status).toBe(400);
  });

  it('returns the cached directory with an ISO timestamp', async () => {
    const { app } = makeApp({ mode: 'platform', storedDirectory: STORED_DIRECTORY });
    const { status, body } = await getDirectory(app);
    expect(status).toBe(200);
    expect(body.directory).toMatchObject({
      customerId: 'org-1',
      identityLinks: STORED_DIRECTORY.identityLinks,
      memberCiTrustLevels: { 'user-1': 'admin' },
      teamMemberships: STORED_DIRECTORY.teamMemberships,
      updatedAt: '2026-08-27T00:00:00.000Z',
    });
    expect(body.platformManaged).toBe(true);
  });

  it('returns a null directory rather than 404 when nothing was ever pushed', async () => {
    // The absence IS the answer an operator is asking for — "no directory is
    // cached, so no approval can be attributed" — so it is a 200 carrying null,
    // not an error the CLI would print as a failure.
    const { app } = makeApp({ mode: 'platform', storedDirectory: null });
    const { status, body } = await getDirectory(app);
    expect(status).toBe(200);
    expect(body.directory).toBeNull();
  });

  it('reads the directory for the requested org', async () => {
    const { app, loadDirectory } = makeApp({
      mode: 'platform',
      storedDirectory: STORED_DIRECTORY,
    });
    await getDirectory(app, 'org-42');
    expect(loadDirectory).toHaveBeenCalledWith('org-42');
  });

  it('reports platformManaged per mode', async () => {
    for (const mode of OrchestratorMode.options) {
      const { app } = makeApp({ mode, storedDirectory: STORED_DIRECTORY });
      const { body } = await getDirectory(app);
      expect(body.platformManaged, `${mode}`).toBe(mode !== 'independent');
    }
  });

  it('exposes exactly two write verbs, both member-scoped', async () => {
    // PATCH and DELETE act on ONE member. There is deliberately no whole-
    // document writer: a PUT would let an operator replace the directory
    // wholesale, which is the Platform push's own semantics and would silently
    // drop `teamMemberships` the operator cannot see from the CLI.
    const { app } = makeApp({ mode: 'independent', storedDirectory: STORED_DIRECTORY });
    for (const method of ['PUT', 'POST']) {
      const res = await app.request('/trust-policy/directory?customerId=org-1', {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status, `${method} must not be routed`).toBe(404);
    }
    // …and the two that ARE routed answer, rather than 404.
    expect((await patchDirectory(app)).status).toBe(200);
    expect((await deleteDirectory(app)).status).toBe(200);
  });

  it('refuses an auditor', async () => {
    const { app, loadDirectory } = makeApp({
      mode: 'platform',
      storedDirectory: STORED_DIRECTORY,
      role: 'auditor',
    });
    const { status } = await getDirectory(app);
    expect(status).toBe(403);
    expect(loadDirectory).not.toHaveBeenCalled();
  });

  it('refuses a routing-key-scoped principal', async () => {
    // Same reasoning as the policy: the directory is per-org, and a scoped token
    // carries no org-wide authority. The guard is registered per exact path, so
    // this also pins that the nested path did not slip past it.
    const { app, loadDirectory } = makeApp({
      mode: 'platform',
      storedDirectory: STORED_DIRECTORY,
      routingKey: 'rk-scoped',
    });
    const { status } = await getDirectory(app);
    expect(status).toBe(403);
    expect(loadDirectory).not.toHaveBeenCalled();
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

describe('PATCH /trust-policy/directory', () => {
  it('registers a member on an independent orchestrator', async () => {
    const { app, upsertLocalMember } = makeApp({ mode: 'independent' });
    const { status, body } = await patchDirectory(app);
    expect(status).toBe(200);
    expect(upsertLocalMember).toHaveBeenCalledWith(
      'org-1',
      {
        userId: 'user-7',
        provider: 'github',
        providerUsername: 'carol',
        providerUserId: '7070',
        ciTrust: 'write',
      },
      expect.any(Function),
    );
    // The response is the merged directory, so the operator sees the effect of
    // their own write without a second call.
    expect(body.directory.identityLinks).toEqual([
      { userId: 'user-7', provider: 'github', providerUsername: 'carol', providerUserId: '7070' },
    ]);
    expect(body.directory.memberCiTrustLevels).toEqual({ 'user-7': 'write' });
    expect(body.platformManaged).toBe(false);
  });

  it('merges into a directory that already has members', async () => {
    const { app } = makeApp({ mode: 'independent', storedDirectory: STORED_DIRECTORY });
    const { body } = await patchDirectory(app);
    expect(body.directory.identityLinks).toHaveLength(2);
    expect(body.directory.memberCiTrustLevels).toEqual({ 'user-1': 'admin', 'user-7': 'write' });
    // Teams are not operator-writable through this route and must survive it.
    expect(body.directory.teamMemberships).toEqual(STORED_DIRECTORY.teamMemberships);
  });

  it('refuses on a Platform-attached orchestrator with the directory message', async () => {
    const { app, upsertLocalMember, auditRows } = makeApp({ mode: 'platform' });
    const { status, body } = await patchDirectory(app);
    expect(status).toBe(409);
    expect(body.error).toBe(PLATFORM_MANAGED_DIRECTORY_MESSAGE);
    // Not merely reported — the write must not have happened, because the next
    // push would silently clobber it.
    expect(upsertLocalMember).not.toHaveBeenCalled();
    expect(auditRows).toHaveLength(0);
  });

  it('covers every orchestrator mode with an explicit accept/refuse verdict', async () => {
    // Mirrors the policy PATCH's own mode sweep: a mode added later must make a
    // deliberate choice rather than silently becoming writable.
    for (const mode of OrchestratorMode.options) {
      const { app } = makeApp({ mode });
      const { status } = await patchDirectory(app);
      if (mode === 'independent') expect(status, `${mode} must accept`).toBe(200);
      else expect(status, `${mode} must refuse`).toBe(409);
    }
  });

  it('rejects a registration with no provider numeric id', async () => {
    // `findIdentityLink` matches on the numeric id alone, so a link without one
    // is inert. Refuse at the door rather than storing something that can never
    // authorize anybody.
    const { app, upsertLocalMember } = makeApp({ mode: 'independent' });
    for (const bad of [{ providerUserId: '' }, { providerUserId: undefined }]) {
      const { status } = await patchDirectory(app, { ...REGISTRATION, ...bad });
      expect(status).toBe(400);
    }
    expect(upsertLocalMember).not.toHaveBeenCalled();
  });

  it('rejects a CI trust level outside the four known ones', async () => {
    const { app, upsertLocalMember } = makeApp({ mode: 'independent' });
    const { status } = await patchDirectory(app, { ...REGISTRATION, ciTrust: 'superuser' });
    expect(status).toBe(400);
    expect(upsertLocalMember).not.toHaveBeenCalled();
  });

  it('writes a trust_directory.updated row inside the directory transaction', async () => {
    const { app, auditRows, accessLog } = makeApp({ mode: 'independent' });
    await patchDirectory(app);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'trust_directory.updated',
      orgId: 'org-1',
      source: 'admin_http',
      outcome: 'allowed',
      meta: { operation: 'register', registration: { userId: 'user-7', ciTrust: 'write' } },
    });
    // Attribution: granting `write` CI trust is all it takes to release a
    // security hold, so the row must name the principal that granted it.
    expect(auditRows[0]?.actor).toEqual({ type: 'service_account', id: 'tester' });
    const trx = vi.mocked(accessLog.recordInTransaction).mock.calls[0]?.[0];
    expect(trx).toHaveProperty('staged');
  });

  it('refuses an auditor and a routing-key-scoped principal', async () => {
    for (const opts of [{ role: 'auditor' as const }, { routingKey: 'rk-scoped' }]) {
      const { app, upsertLocalMember, auditRows } = makeApp({ mode: 'independent', ...opts });
      const { status } = await patchDirectory(app);
      expect(status).toBe(403);
      expect(upsertLocalMember).not.toHaveBeenCalled();
      expect(auditRows).toHaveLength(0);
    }
  });
});

describe('DELETE /trust-policy/directory', () => {
  it('removes a registered member and reports that something went', async () => {
    const { app, removeLocalMember } = makeApp({
      mode: 'independent',
      storedDirectory: STORED_DIRECTORY,
    });
    const { status, body } = await deleteDirectory(app);
    expect(status).toBe(200);
    expect(removeLocalMember).toHaveBeenCalledWith('org-1', 'user-1', expect.any(Function));
    expect(body.removed).toBe(true);
    expect(body.directory.identityLinks).toEqual([]);
    expect(body.directory.memberCiTrustLevels).toEqual({});
    expect(body.directory.teamMemberships).toEqual(STORED_DIRECTORY.teamMemberships);
  });

  it('is idempotent for a member that was never registered', async () => {
    const { app, auditRows } = makeApp({ mode: 'independent' });
    const { status, body } = await deleteDirectory(app, 'customerId=org-1&userId=ghost');
    expect(status).toBe(200);
    expect(body.removed).toBe(false);
    // The audit row reports the same verdict the caller got. A hardcoded `true`
    // here would record a revocation that never happened.
    expect(auditRows[0]).toMatchObject({ meta: { removed: false } });
  });

  it('requires both query params', async () => {
    const { app, removeLocalMember } = makeApp({ mode: 'independent' });
    expect((await deleteDirectory(app, 'userId=user-1')).status).toBe(400);
    expect((await deleteDirectory(app, 'customerId=org-1')).status).toBe(400);
    expect(removeLocalMember).not.toHaveBeenCalled();
  });

  it('covers every orchestrator mode with an explicit accept/refuse verdict', async () => {
    for (const mode of OrchestratorMode.options) {
      const { app } = makeApp({ mode, storedDirectory: STORED_DIRECTORY });
      const { status, body } = await deleteDirectory(app);
      if (mode === 'independent') expect(status, `${mode} must accept`).toBe(200);
      else {
        expect(status, `${mode} must refuse`).toBe(409);
        expect(body.error).toBe(PLATFORM_MANAGED_DIRECTORY_MESSAGE);
      }
    }
  });

  it('writes a trust_directory.updated row inside the directory transaction', async () => {
    const { app, auditRows } = makeApp({
      mode: 'independent',
      storedDirectory: STORED_DIRECTORY,
    });
    await deleteDirectory(app);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'trust_directory.updated',
      orgId: 'org-1',
      meta: { operation: 'revoke', userId: 'user-1', removed: true },
    });
  });

  it('refuses an auditor and a routing-key-scoped principal', async () => {
    for (const opts of [{ role: 'auditor' as const }, { routingKey: 'rk-scoped' }]) {
      const { app, removeLocalMember, auditRows } = makeApp({ mode: 'independent', ...opts });
      const { status } = await deleteDirectory(app);
      expect(status).toBe(403);
      expect(removeLocalMember).not.toHaveBeenCalled();
      expect(auditRows).toHaveLength(0);
    }
  });
});
