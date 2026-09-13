import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { DashboardBackendsHandler } from './dashboard-backends-handler.js';
import type { BackendRegistry } from '../secrets/backend-registry.js';
import type { BackendHealthChecker } from '../secrets/backend-health.js';
import type { Database } from '../db/types.js';

describe('DashboardBackendsHandler', () => {
  describe('not-found results', () => {
    // The `error` field on the *.response messages is the internal-error
    // channel: the Platform maps any `error` to HTTP 500. A missing backend
    // must answer with the not-found sentinel WITHOUT `error` so the Platform
    // can serve the structured 404 its routes intend.
    let send: ReturnType<typeof vi.fn>;
    let registry: { getBackend: ReturnType<typeof vi.fn> };
    let healthChecker: Record<string, never>;
    let syncManager: { syncBackend: ReturnType<typeof vi.fn> };
    let handler: DashboardBackendsHandler;

    beforeEach(() => {
      send = vi.fn();
      registry = {
        getBackend: vi.fn().mockResolvedValue(null),
      };
      healthChecker = {};
      syncManager = {
        syncBackend: vi.fn().mockResolvedValue({ scopeCount: 0 }),
      };
      const db = {
        selectFrom: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          // Policy gate reads the org_settings row; undefined = permissive.
          executeTakeFirst: vi.fn().mockResolvedValue(undefined),
        }),
      };
      handler = new DashboardBackendsHandler({
        db: db as unknown as Kysely<Database>,
        registry: registry as unknown as BackendRegistry,
        healthChecker: healthChecker as unknown as BackendHealthChecker,
        syncManager: syncManager as never,
        send,
        orgId: 'cust-1',
      });
    });

    it('sync_one of a missing backend sends synced:false without error', async () => {
      await handler.handleMessage({
        type: 'dashboard.backends.sync.one',
        requestId: 'req-1',
        actor: { type: 'system', id: 'test' },
        name: 'missing-backend',
      } as never);
      expect(send).toHaveBeenCalledTimes(1);
      const sent = send.mock.calls[0][0];
      expect(sent).toMatchObject({
        type: 'dashboard.backends.sync.one.response',
        requestId: 'req-1',
        synced: false,
      });
      expect(sent).not.toHaveProperty('error');
    });

    it('get of a missing backend sends neither backend nor error', async () => {
      await handler.handleMessage({
        type: 'dashboard.backends.get',
        requestId: 'req-2',
        actor: { type: 'system', id: 'test' },
        name: 'missing-backend',
      } as never);
      expect(send).toHaveBeenCalledTimes(1);
      const sent = send.mock.calls[0][0];
      expect(sent).toMatchObject({ type: 'dashboard.backends.get.response', requestId: 'req-2' });
      expect(sent).not.toHaveProperty('error');
      expect(sent).not.toHaveProperty('backend');
    });
  });
});
