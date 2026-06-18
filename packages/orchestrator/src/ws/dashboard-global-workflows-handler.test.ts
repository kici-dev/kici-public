import { describe, it, expect } from 'vitest';
import {
  DashboardGlobalWorkflowsHandler,
  buildPatch,
  rowToSettings,
} from './dashboard-global-workflows-handler.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';
import type { OrgSettings } from '../db/types.js';

const ORG = 'kiciStg00001';

function makeHandler(row: Record<string, unknown> | undefined) {
  const sent: unknown[] = [];
  const { db, mocks } = createMockDb({ selectFirstRow: row });
  const handler = new DashboardGlobalWorkflowsHandler({
    customerId: ORG,
    send: (msg) => sent.push(msg),
    db,
  });
  return { handler, sent, mocks };
}

describe('DashboardGlobalWorkflowsHandler', () => {
  describe('dashboard.global-workflows.get', () => {
    it('returns defaulted settings when no row exists', async () => {
      const { handler, sent } = makeHandler(undefined);
      const ok = await handler.handleMessage({
        type: 'dashboard.global-workflows.get',
        requestId: 'req-1',
      });
      expect(ok).toBe(true);
      expect(sent).toHaveLength(1);
      const msg = sent[0] as any;
      expect(msg.type).toBe('dashboard.global-workflows.get.response');
      expect(msg.requestId).toBe('req-1');
      expect(msg.settings).toMatchObject({
        customerId: ORG,
        enabled: false,
        allowedRepos: null,
        deniedRepos: null,
        elevatedRepos: null,
      });
      expect('routingKey' in msg.settings).toBe(false);
    });

    it('projects an existing row into the settings shape', async () => {
      const now = new Date('2026-04-17T10:00:00Z');
      const { handler, sent } = makeHandler({
        customer_id: ORG,
        global_workflows_enabled: true,
        global_workflow_allowed_repos: [{ pattern: 'myorg/ci-*' }],
        global_workflow_denied_repos: null,
        global_workflow_elevated_repos: [{ routingKey: 'github:42', pattern: 'myorg/ci-deploy' }],
        created_at: now,
        updated_at: now,
      });
      await handler.handleMessage({ type: 'dashboard.global-workflows.get', requestId: 'r' });
      const msg = sent[0] as any;
      expect(msg.settings.enabled).toBe(true);
      expect(msg.settings.allowedRepos).toEqual([{ pattern: 'myorg/ci-*' }]);
      expect(msg.settings.elevatedRepos).toEqual([
        { routingKey: 'github:42', pattern: 'myorg/ci-deploy' },
      ]);
      expect(msg.settings.createdAt).toBe('2026-04-17T10:00:00.000Z');
    });

    it('surfaces errors from the DB as error responses', async () => {
      const sent: unknown[] = [];
      const { db, mocks } = createMockDb();
      mocks.selectExecuteTakeFirst.mockRejectedValueOnce(new Error('boom'));
      const handler = new DashboardGlobalWorkflowsHandler({
        customerId: ORG,
        send: (msg) => sent.push(msg),
        db,
      });
      await handler.handleMessage({ type: 'dashboard.global-workflows.get', requestId: 'r' });
      const msg = sent[0] as any;
      expect(msg.error).toContain('boom');
    });
  });

  describe('dashboard.global-workflows.update', () => {
    it('upserts and re-reads the row on update', async () => {
      const updated = {
        customer_id: ORG,
        global_workflows_enabled: true,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: [{ pattern: 'myorg/blocked-*' }],
        global_workflow_elevated_repos: null,
        created_at: new Date('2026-04-17T10:00:00Z'),
        updated_at: new Date('2026-04-17T10:00:00Z'),
      };
      const { handler, sent, mocks } = makeHandler(updated);
      await handler.handleMessage({
        type: 'dashboard.global-workflows.update',
        requestId: 'req-1',
        enabled: true,
        deniedRepos: [{ pattern: 'myorg/blocked-*' }],
      });
      expect(mocks.insertInto).toHaveBeenCalledWith('org_settings');
      expect(mocks.onConflict).toHaveBeenCalled();
      const response = sent.at(-1) as any;
      expect(response.type).toBe('dashboard.global-workflows.update.response');
      expect(response.settings.deniedRepos).toEqual([{ pattern: 'myorg/blocked-*' }]);
    });

    it('setOrgId updates the customer_id used for queries', async () => {
      const { handler, mocks } = makeHandler(undefined);
      handler.setOrgId('kiciStg99999');
      await handler.handleMessage({ type: 'dashboard.global-workflows.get', requestId: 'r' });
      expect(mocks.selectWhere).toHaveBeenCalledWith('customer_id', '=', 'kiciStg99999');
    });
  });

  describe('buildPatch', () => {
    const existing: OrgSettings = {
      customer_id: ORG,
      global_workflows_enabled: true,
      global_workflow_allowed_repos: [{ pattern: 'myorg/*' }],
      global_workflow_denied_repos: null,
      global_workflow_elevated_repos: [{ pattern: 'myorg/deployer' }],
      created_at: new Date(),
      updated_at: new Date(),
    };

    it('preserves existing values when no fields are patched', () => {
      const patch = buildPatch(existing, {
        type: 'dashboard.global-workflows.update',
        requestId: 'r',
      });
      expect(patch).toEqual({
        enabled: true,
        allowedRepos: [{ pattern: 'myorg/*' }],
        deniedRepos: null,
        elevatedRepos: [{ pattern: 'myorg/deployer' }],
      });
    });

    it('applies an explicit deniedRepos list', () => {
      const patch = buildPatch(existing, {
        type: 'dashboard.global-workflows.update',
        requestId: 'r',
        deniedRepos: [{ pattern: 'myorg/blocked' }],
      });
      expect(patch.deniedRepos).toEqual([{ pattern: 'myorg/blocked' }]);
      expect(patch.allowedRepos).toEqual([{ pattern: 'myorg/*' }]);
    });

    it('preserves source-qualified entries verbatim', () => {
      const patch = buildPatch(existing, {
        type: 'dashboard.global-workflows.update',
        requestId: 'r',
        allowedRepos: [{ routingKey: 'github:42', pattern: 'myorg/ci-*' }],
      });
      expect(patch.allowedRepos).toEqual([{ routingKey: 'github:42', pattern: 'myorg/ci-*' }]);
    });

    it('clears a list when explicit null is passed', () => {
      const patch = buildPatch(existing, {
        type: 'dashboard.global-workflows.update',
        requestId: 'r',
        allowedRepos: null,
      });
      expect(patch.allowedRepos).toBeNull();
    });

    it('initializes from defaults when no existing row', () => {
      const patch = buildPatch(undefined, {
        type: 'dashboard.global-workflows.update',
        requestId: 'r',
        enabled: true,
      });
      expect(patch).toEqual({
        enabled: true,
        allowedRepos: null,
        deniedRepos: null,
        elevatedRepos: null,
      });
    });
  });

  describe('rowToSettings', () => {
    it('projects denied entries through verbatim', () => {
      const row: OrgSettings = {
        customer_id: ORG,
        global_workflows_enabled: true,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: [
          { routingKey: 'generic:kiciStg00001:src-b', pattern: 'myorg/blocked-*' },
        ],
        global_workflow_elevated_repos: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      const projected = rowToSettings(ORG, row);
      expect(projected.deniedRepos).toEqual([
        { routingKey: 'generic:kiciStg00001:src-b', pattern: 'myorg/blocked-*' },
      ]);
      expect(projected.allowedRepos).toBeNull();
    });

    it('returns defaulted shape when no row exists', () => {
      const projected = rowToSettings(ORG, undefined);
      expect(projected).toEqual({
        customerId: ORG,
        enabled: false,
        allowedRepos: null,
        deniedRepos: null,
        elevatedRepos: null,
        createdAt: null,
        updatedAt: null,
      });
    });
  });
});
