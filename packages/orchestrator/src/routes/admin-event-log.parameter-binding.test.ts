/**
 * Event-log query parameter-binding tripwire (§4.6).
 *
 * The orchestrator's `GET /api/v1/admin/event-log` handler accepts a
 * dozen filter parameters from the query string (`orgId`, `routingKey`,
 * `event`, `action`, `status`, `from`, `to`, `deliveryId`, …) and
 * applies each one to the underlying SQL via Kysely's parameterized
 * `where()` API. Two failure modes would catastrophically widen the
 * attack surface:
 *
 *  1. **SQL injection.** If a future refactor swapped `.where('event',
 *     '=', event)` for `.whereRaw(\`event = '\${event}'\`)` (or a
 *     `sql\`event = '\${event}'\`` template literal that interpolated
 *     the user-supplied string into the SQL fragment), an attacker
 *     supplying `event=' OR 1=1 --` could escape the WHERE clause and
 *     dump rows beyond what their role would normally view, or
 *     UNION-pull data from other tables (admin_tokens, scoped_secrets,
 *     audit_log).
 *
 *  2. **Permission-after-query.** If the RBAC `event_log.read` check
 *     ran AFTER the `selectFrom('event_log')` query was built and
 *     executed, an unauthenticated caller could observe DB-level side
 *     effects (load on the event_log table, query timing) that an
 *     authenticated caller would. More important: it would allow the
 *     query to run at all for unauthorized callers, and a future bug
 *     might forget the role check entirely.
 *
 * Trust model (must hold):
 *
 *   For attacker A10 (operator-token holder), the parameter-binding
 *   gate is what prevents an authenticated-but-low-privilege role
 *   from escaping into restricted tables. Single-tenant orchestrator
 *   means there's no per-row authorization layer to leak via timing
 *   ("row exists but you can't see it"); any role with `event_log.read`
 *   sees ALL event_log rows by construction. The injection vector
 *   (cross-table read) and the order-of-operations vector (RBAC
 *   before DB work) are the two that matter.
 *
 *   For attacker A1 (external, unauthenticated), the bearer-token
 *   middleware (covered by §4.1) is the perimeter gate; this test
 *   layers the RBAC + parameter-binding invariants on top.
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

  // The base mock-db's selectTerminal does not include `.offset()`; the
  // event-log handler chains `.orderBy().limit().offset().execute()`,
  // so attach a self-returning offset spy onto the terminal. selectAll
  // / where / orderBy / limit all return the same terminal object, so
  // patching it once is sufficient for the whole chain.
  const terminal = mocks.selectAll() as Record<string, unknown>;
  if (!('offset' in terminal)) {
    terminal.offset = vi.fn().mockReturnValue(terminal);
  }
  // Reset the spurious selectAll invocation we caused above so it does
  // not contaminate any future call-count assertions.
  mocks.selectAll.mockClear();

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
        throw new PermissionDeniedError('test', 'event_log.read');
      }
    }),
  } as unknown as RbacEnforcer;

  const logStorage = { read: vi.fn() } as unknown as LogStorage;

  return { db, mocks, tokenManager, rbac, logStorage };
}

describe('§4.6 GET /api/v1/admin/event-log parameter-binding invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('SQL injection resistance — every filter is parameter-bound', () => {
    it('passes attacker-controlled filter values AS VALUES to Kysely .where(), never interpolated into SQL', async () => {
      const { db, mocks, tokenManager, rbac, logStorage } = makeDeps({});
      const app = createAdminEventLogRoutes({ db, tokenManager, rbac, logStorage });

      // A bouquet of injection-shaped strings, one per filter. If any of
      // these is interpolated into a SQL fragment instead of being
      // parameter-bound, the orchestrator is in serious trouble.
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

      // Collect every where() call. The handler runs the query twice
      // (data query + count query), so each filter is bound twice.
      const whereCalls = (mocks.selectWhere as ReturnType<typeof vi.fn>).mock.calls;

      // For every evil value, find the matching .where() call and
      // assert the value is the raw string, NOT an interpolated SQL
      // fragment. Kysely's `.where(column, op, value)` form is the
      // ONLY safe form: `value` is bound as a query parameter.
      const assertBound = (column: string, op: string, value: string) => {
        const matches = whereCalls.filter((c) => c[0] === column);
        expect(matches.length).toBeGreaterThan(0);
        // Both data and count queries should have produced this where
        // call (handler dedupes its filter logic across both queries).
        for (const call of matches) {
          expect(call[1]).toBe(op);
          // The critical assertion: the value must be the EXACT raw
          // string the attacker supplied. Any place that reshaped it
          // (string concat, template literal into SQL, etc.) would
          // fail this assertion.
          expect(call[2]).toBe(value);
          // Belt-and-suspenders: the value must NOT have been wrapped
          // in something that looks like a Kysely raw SQL fragment.
          // Raw SQL nodes from `sql\`\`` are objects, not strings.
          expect(typeof call[2]).toBe('string');
        }
      };

      assertBound('org_id', '=', evil.orgId);
      assertBound('routing_key', '=', evil.routingKey);
      assertBound('event', '=', evil.event);
      assertBound('action', '=', evil.action);
      assertBound('status', '=', evil.status);
      // delivery_id uses LIKE with the raw value wrapped in '%...%'.
      // The wrap is a Kysely-bound value (the % chars are part of the
      // pattern, but the value itself is parameter-bound — no SQL
      // interpolation).
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

      // Unauthorized — the handler's catch path returns the 403.
      expect(res.status).toBe(403);

      // The critical invariant: the DB was never queried. A future
      // refactor that built the query before the role check would
      // fail this assertion.
      expect(mocks.selectFrom).not.toHaveBeenCalled();

      // And the RBAC enforcer was called.
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
        // no Authorization header
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
