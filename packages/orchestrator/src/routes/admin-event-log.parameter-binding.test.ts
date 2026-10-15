/**
 * Event-log query parameter-binding tripwire.
 *
 * `GET /api/v1/admin/event-log` applies each query-string filter (`orgId`,
 * `routingKey`, `event`, `action`, `status`, `from`, `to`, `deliveryId`, …)
 * through Kysely's parameterized `where()`. Two failure modes would widen the
 * attack surface:
 *
 *  1. **SQL injection.** Swapping `.where('event', '=', event)` for
 *     `.whereRaw(\`event = '\${event}'\`)` (or an interpolating `sql\`\``
 *     template) would let `event=' OR 1=1 --` escape the WHERE clause, dump
 *     rows beyond the role's view, or UNION-pull other tables (admin_tokens,
 *     scoped_secrets, audit_log).
 *
 *  2. **Permission-after-query.** An RBAC `event_log.read` check AFTER the
 *     query is built and executed lets the query run for unauthorized callers,
 *     exposes DB-level side effects (table load, query timing), and leaves a
 *     forgotten role check undetected.
 *
 * Trust model (must hold): for an operator-token holder, parameter binding is
 * what keeps a low-privilege role out of restricted tables. A single-tenant
 * orchestrator has no per-row authorization to leak via timing; any role with
 * `event_log.read` sees ALL event_log rows by construction. So injection
 * (cross-table read) and order of operations (RBAC before DB work) are the two
 * vectors that matter. For an unauthenticated attacker the bearer-token
 * middleware is the perimeter; this test layers RBAC + binding on top.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAdminEventLogRoutes } from './admin-event-log.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';
import { PermissionDeniedError } from '../secrets/rbac.js';
import type { TokenManager } from '../secrets/token-manager.js';
import type { RbacEnforcer } from '../secrets/rbac.js';
import type { LogStorage } from '../reporting/log-storage.js';

function makeDeps(opts: { rolePermitted?: boolean; selectRows?: unknown[] }) {
  const { rolePermitted = true, selectRows = [] } = opts;

  const { db, mocks } = createMockDb({ selectRows, countResult: { count: 0 } });

  const tokenManager = {
    validate: vi.fn().mockResolvedValue({
      id: 'tok-test',
      role: 'admin',
      label: 'test',
      routingKey: undefined,
    }),
  } as unknown as TokenManager;

  const rbac = {
    requirePermission: vi.fn().mockImplementation(() => {
      if (!rolePermitted) {
        throw new PermissionDeniedError('auditor', 'event_log.read');
      }
    }),
  } as unknown as RbacEnforcer;

  const logStorage = { read: vi.fn() } as unknown as LogStorage;

  return { db, mocks, tokenManager, rbac, logStorage };
}

describe('GET /api/v1/admin/event-log parameter-binding invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('SQL injection resistance — every filter is parameter-bound', () => {
    it('passes attacker-controlled filter values AS VALUES to Kysely .where(), never interpolated into SQL', async () => {
      const { db, mocks, tokenManager, rbac, logStorage } = makeDeps({});
      const app = createAdminEventLogRoutes({ db, tokenManager, rbac, logStorage });

      // One injection-shaped string per filter.
      const evil = {
        orgId: "org-1' OR '1'='1",
        routingKey: "github:42'; DROP TABLE admin_tokens; --",
        event: "' UNION SELECT token_hash FROM admin_tokens --",
        action: "created'; DELETE FROM event_log; --",
        status: "matched' OR 1=1 --",
        deliveryId: "abc' UNION SELECT 1 --",
      };
      const qs = new URLSearchParams(evil).toString();

      const res = await app.request(`/api/v1/admin/event-log?${qs}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer test-token' },
      });

      expect(res.status).toBe(200);

      // The handler runs a data query and a count query, so each filter is
      // bound twice.
      const whereCalls = (mocks.selectWhere as ReturnType<typeof vi.fn>).mock.calls;

      // `.where(column, op, value)` is the ONLY safe form: `value` is bound as
      // a query parameter.
      const assertBound = (column: string, op: string, value: string) => {
        const matches = whereCalls.filter((c) => c[0] === column);
        expect(matches.length).toBeGreaterThan(0);
        for (const call of matches) {
          expect(call[1]).toBe(op);
          // The EXACT raw string: any reshaping (concat, template into SQL)
          // fails here.
          expect(call[2]).toBe(value);
          // Raw SQL nodes from `sql\`\`` are objects, not strings.
          expect(typeof call[2]).toBe('string');
        }
      };

      assertBound('org_id', '=', evil.orgId);
      assertBound('routing_key', '=', evil.routingKey);
      assertBound('event', '=', evil.event);
      assertBound('action', '=', evil.action);
      assertBound('status', '=', evil.status);
      // delivery_id uses LIKE with the raw value wrapped in '%...%', still
      // parameter-bound.
      const deliveryIdCalls = whereCalls.filter((c) => c[0] === 'delivery_id');
      expect(deliveryIdCalls.length).toBeGreaterThan(0);
      for (const call of deliveryIdCalls) {
        expect(call[1]).toBe('like');
        expect(call[2]).toBe(`%${evil.deliveryId}%`);
        expect(typeof call[2]).toBe('string');
      }
    });
  });

  describe('RBAC fires before any DB work', () => {
    it('rejects unauthorized callers without ever calling selectFrom', async () => {
      const { db, mocks, tokenManager, rbac, logStorage } = makeDeps({
        rolePermitted: false,
      });
      const app = createAdminEventLogRoutes({ db, tokenManager, rbac, logStorage });

      const res = await app.request('/api/v1/admin/event-log', {
        method: 'GET',
        headers: { Authorization: 'Bearer test-token' },
      });

      expect(res.status).toBe(403);

      // The DB was never queried: building the query before the role check
      // fails here.
      expect(mocks.selectFrom).not.toHaveBeenCalled();

      expect(vi.mocked(rbac.requirePermission)).toHaveBeenCalledWith('admin', 'event_log.read');
    });

    it('on the authorized path, requirePermission runs before selectFrom (call-order)', async () => {
      const { db, mocks, tokenManager, rbac, logStorage } = makeDeps({});
      const app = createAdminEventLogRoutes({ db, tokenManager, rbac, logStorage });

      const res = await app.request('/api/v1/admin/event-log?orgId=org-1', {
        method: 'GET',
        headers: { Authorization: 'Bearer test-token' },
      });

      expect(res.status).toBe(200);
      expect(vi.mocked(rbac.requirePermission)).toHaveBeenCalled();
      expect(mocks.selectFrom).toHaveBeenCalled();

      const rbacOrder = vi.mocked(rbac.requirePermission).mock.invocationCallOrder[0];
      const selectFromOrder = (mocks.selectFrom as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0];

      expect(rbacOrder).toBeLessThan(selectFromOrder);
    });
  });

  describe('Bearer-token middleware fires before RBAC + DB work', () => {
    it('rejects requests with no Authorization header without calling RBAC or DB', async () => {
      const { db, mocks, tokenManager, rbac, logStorage } = makeDeps({});
      const app = createAdminEventLogRoutes({ db, tokenManager, rbac, logStorage });

      const res = await app.request('/api/v1/admin/event-log', {
        method: 'GET',
      });

      expect(res.status).toBe(401);
      expect(vi.mocked(tokenManager.validate)).not.toHaveBeenCalled();
      expect(vi.mocked(rbac.requirePermission)).not.toHaveBeenCalled();
      expect(mocks.selectFrom).not.toHaveBeenCalled();
    });

    it('rejects an invalid bearer token (validate returns null)', async () => {
      const { db, mocks, tokenManager, rbac, logStorage } = makeDeps({});
      vi.mocked(tokenManager.validate).mockResolvedValueOnce(null);
      const app = createAdminEventLogRoutes({ db, tokenManager, rbac, logStorage });

      const res = await app.request('/api/v1/admin/event-log', {
        method: 'GET',
        headers: { Authorization: 'Bearer bogus' },
      });

      expect(res.status).toBe(401);
      expect(vi.mocked(rbac.requirePermission)).not.toHaveBeenCalled();
      expect(mocks.selectFrom).not.toHaveBeenCalled();
    });
  });
});
