import { describe, it, expect } from 'vitest';
import {
  DashboardGlobalWorkflowsHandler,
  buildPatch,
  rowToSettings,
} from './dashboard-global-workflows-handler.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';
import type { OrgSettings } from '../db/types.js';
import { globalWorkflowsUpdateRequestSchema } from '@kici-dev/engine/protocol/dashboard-global-workflows';
import type {
  ClusterSettingRead,
  ClusterSettingsReader,
} from '../cluster/cluster-settings-reader.js';

const ORG = 'kiciStg00001';
const ACTOR = { type: 'user', sub: 'u1' } as const;

/** A ClusterSettingsReader stand-in that returns a fixed read outcome. */
function fakeClusterSettings(read: ClusterSettingRead<boolean>) {
  return { tryGetBoolean: async () => read } as unknown as ClusterSettingsReader;
}

interface HandlerOpts {
  row?: Record<string, unknown>;
  /** Stored cluster switch value; `null` means unset → configured default. */
  clusterEnabled?: boolean | null;
  /** Applies when the cluster column is NULL. */
  defaultEnabled?: boolean;
  /** When true, the cluster read reports `{ ok: false }`. */
  clusterUnreadable?: boolean;
}

function makeHandler(opts: HandlerOpts = {}) {
  const sent: unknown[] = [];
  const { db, mocks } = createMockDb({ selectFirstRow: opts.row });
  const read: ClusterSettingRead<boolean> = opts.clusterUnreadable
    ? { ok: false }
    : { ok: true, value: opts.clusterEnabled ?? null };
  const handler = new DashboardGlobalWorkflowsHandler({
    customerId: ORG,
    send: (msg) => sent.push(msg),
    db,
    clusterSettings: fakeClusterSettings(read),
    globalWorkflowsEnabledDefault: opts.defaultEnabled ?? false,
  });
  return { handler, sent, mocks };
}

describe('DashboardGlobalWorkflowsHandler', () => {
  describe('dashboard.global-workflows.get', () => {
    it('returns defaulted settings when no row exists', async () => {
      const { handler, sent } = makeHandler({ row: undefined });
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

    it('reports the effective cluster value on get, with no org row', async () => {
      const { handler, sent } = makeHandler({ clusterEnabled: true, row: undefined });
      await handler.handleMessage({ type: 'dashboard.global-workflows.get', requestId: 'r1' });
      expect((sent[0] as any).settings.enabled).toBe(true);
    });

    it('reports the effective cluster value on get, ignoring the org row entirely', async () => {
      const { handler, sent } = makeHandler({
        clusterEnabled: false,
        row: { customer_id: ORG, global_workflow_allowed_repos: null },
      });
      await handler.handleMessage({ type: 'dashboard.global-workflows.get', requestId: 'r1' });
      expect((sent[0] as any).settings.enabled).toBe(false);
    });

    it('falls back to the configured default when the cluster column is NULL', async () => {
      const { handler, sent } = makeHandler({
        clusterEnabled: null,
        defaultEnabled: true,
        row: undefined,
      });
      await handler.handleMessage({ type: 'dashboard.global-workflows.get', requestId: 'r1' });
      expect((sent[0] as any).settings.enabled).toBe(true);
    });

    it('projects an existing row into the settings shape', async () => {
      const now = new Date('2026-04-17T10:00:00Z');
      const { handler, sent } = makeHandler({
        clusterEnabled: true,
        row: {
          customer_id: ORG,
          global_workflow_allowed_repos: [{ pattern: 'myorg/ci-*' }],
          global_workflow_denied_repos: null,
          global_workflow_elevated_repos: [{ routingKey: 'github:42', pattern: 'myorg/ci-deploy' }],
          created_at: now,
          updated_at: now,
        },
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
        clusterSettings: fakeClusterSettings({ ok: true, value: null }),
        globalWorkflowsEnabledDefault: false,
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
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: [{ pattern: 'myorg/blocked-*' }],
        global_workflow_elevated_repos: null,
        created_at: new Date('2026-04-17T10:00:00Z'),
        updated_at: new Date('2026-04-17T10:00:00Z'),
      };
      const { handler, sent, mocks } = makeHandler({ clusterEnabled: true, row: updated });
      await handler.handleMessage({
        type: 'dashboard.global-workflows.update',
        requestId: 'req-1',
        deniedRepos: [{ pattern: 'myorg/blocked-*' }],
      });
      expect(mocks.insertInto).toHaveBeenCalledWith('org_settings');
      expect(mocks.onConflict).toHaveBeenCalled();
      const response = sent.at(-1) as any;
      expect(response.type).toBe('dashboard.global-workflows.update.response');
      expect(response.settings.deniedRepos).toEqual([{ pattern: 'myorg/blocked-*' }]);
      // The master switch is fleet-wide and read-only, projected from the cluster.
      expect(response.settings.enabled).toBe(true);
    });

    it('refuses an update carrying a negated pattern, naming it, and writes nothing', async () => {
      const { handler, sent, mocks } = makeHandler({ clusterEnabled: true, row: undefined });
      await handler.handleMessage({
        type: 'dashboard.global-workflows.update',
        requestId: 'req-neg',
        actor: ACTOR,
        deniedRepos: [{ pattern: '!myorg/blocked' }],
      });
      const response = sent.at(-1) as any;
      expect(response.type).toBe('dashboard.global-workflows.update.response');
      expect(response.requestId).toBe('req-neg');
      expect(response.settings).toBeUndefined();
      expect(response.error).toContain('!myorg/blocked');
      expect(mocks.insertInto).not.toHaveBeenCalled();
    });

    it('refuses a negative-lookahead entry on the allow list', async () => {
      const { handler, sent, mocks } = makeHandler({ clusterEnabled: true, row: undefined });
      await handler.handleMessage({
        type: 'dashboard.global-workflows.update',
        requestId: 'req-allow',
        actor: ACTOR,
        // picomatch compiles this into a real inversion, so storing it would
        // allow every repository in every organization but the one it names.
        allowedRepos: [{ pattern: '(?!myorg/legacy)**' }],
      });
      expect((sent.at(-1) as any).error).toContain('(?!myorg/legacy)**');
      expect(mocks.insertInto).not.toHaveBeenCalled();
    });

    it('refuses a negated entry on the elevated list', async () => {
      const { handler, sent, mocks } = makeHandler({ clusterEnabled: true, row: undefined });
      await handler.handleMessage({
        type: 'dashboard.global-workflows.update',
        requestId: 'req-elev',
        actor: ACTOR,
        elevatedRepos: [{ pattern: 'myorg/[^a]*' }],
      });
      expect((sent.at(-1) as any).error).toContain('myorg/[^a]*');
      expect(mocks.insertInto).not.toHaveBeenCalled();
    });

    it('accepts ordinary globs, including a dot-prefixed repo name', async () => {
      const { handler, sent, mocks } = makeHandler({ clusterEnabled: true, row: undefined });
      await handler.handleMessage({
        type: 'dashboard.global-workflows.update',
        requestId: 'req-ok',
        actor: ACTOR,
        allowedRepos: [{ pattern: 'myorg/*' }, { pattern: 'myorg/.github' }],
        deniedRepos: [{ pattern: '**' }],
      });
      expect((sent.at(-1) as any).error).toBeUndefined();
      expect(mocks.insertInto).toHaveBeenCalledWith('org_settings');
    });

    it('an update carrying enabled fails schema validation', () => {
      const parsed = globalWorkflowsUpdateRequestSchema.safeParse({
        type: 'dashboard.global-workflows.update',
        requestId: 'r1',
        actor: { type: 'user', id: 'u1' },
        enabled: true,
      });
      expect(parsed.success).toBe(false);
    });

    it('setOrgId updates the customer_id used for queries', async () => {
      const { handler, mocks } = makeHandler({ row: undefined });
      handler.setOrgId('kiciStg99999');
      await handler.handleMessage({ type: 'dashboard.global-workflows.get', requestId: 'r' });
      expect(mocks.selectWhere).toHaveBeenCalledWith('customer_id', '=', 'kiciStg99999');
    });
  });

  describe('buildPatch', () => {
    const existing: OrgSettings = {
      customer_id: ORG,
      global_workflow_allowed_repos: [{ pattern: 'myorg/*' }],
      global_workflow_denied_repos: null,
      global_workflow_elevated_repos: [{ pattern: 'myorg/deployer' }],
      created_at: new Date(),
      updated_at: new Date(),
    } as unknown as OrgSettings;

    it('preserves existing values when no fields are patched', () => {
      const patch = buildPatch(existing, {
        type: 'dashboard.global-workflows.update',
        requestId: 'r',
      });
      expect(patch).toEqual({
        allowedRepos: [{ pattern: 'myorg/*' }],
        deniedRepos: null,
        elevatedRepos: [{ pattern: 'myorg/deployer' }],
      });
    });

    it('no longer carries an enabled field', () => {
      const patch = buildPatch(undefined, {
        type: 'dashboard.global-workflows.update',
        requestId: 'r',
        allowedRepos: [{ pattern: 'myorg/*' }],
      });
      expect(patch).not.toHaveProperty('enabled');
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
      });
      expect(patch).toEqual({
        allowedRepos: null,
        deniedRepos: null,
        elevatedRepos: null,
      });
    });
  });

  describe('rowToSettings', () => {
    it('projects denied entries through verbatim and carries the supplied enabled', () => {
      const row = {
        customer_id: ORG,
        global_workflow_allowed_repos: null,
        global_workflow_denied_repos: [
          { routingKey: 'generic:kiciStg00001:src-b', pattern: 'myorg/blocked-*' },
        ],
        global_workflow_elevated_repos: null,
        created_at: new Date(),
        updated_at: new Date(),
      } as unknown as OrgSettings;
      const projected = rowToSettings(ORG, row, true);
      expect(projected.enabled).toBe(true);
      expect(projected.deniedRepos).toEqual([
        { routingKey: 'generic:kiciStg00001:src-b', pattern: 'myorg/blocked-*' },
      ]);
      expect(projected.allowedRepos).toBeNull();
    });

    it('returns defaulted shape when no row exists, with the supplied enabled', () => {
      const projected = rowToSettings(ORG, undefined, false);
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
