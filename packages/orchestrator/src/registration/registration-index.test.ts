/**
 * Tests for RegistrationIndex -- in-memory index with version-based reload.
 *
 * Uses a mock RegistrationStore to test index population and lookup behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { LockWorkflow } from '@kici-dev/engine';

import type { RegistrationRow, RegistrationStore } from './registration-store.js';
import { RegistrationIndex } from './registration-index.js';

// ── Mock helpers ────────────────────────────────────────────────

function makeLockWorkflow(name: string, triggerTypes: string[] = ['kici_event']): LockWorkflow {
  return {
    name,
    contentHash: 'sha256-test',
    compileSchemaVersion: 1,
    triggers: triggerTypes.map((t) => ({ _type: t, eventName: 'test' }) as any),
    jobs: [],
  };
}

function makeLockWebhookWorkflow(name: string, events: string[]): LockWorkflow {
  return {
    name,
    contentHash: 'sha256-test',
    compileSchemaVersion: 1,
    triggers: [
      {
        _type: 'webhook',
        events,
        actions: [],
      } as any,
    ],
    jobs: [],
  };
}

function makeRegistrationRow(overrides: Partial<RegistrationRow> = {}): RegistrationRow {
  return {
    id: 'reg-001',
    repo_identifier: 'owner/repo',
    workflow_name: 'on-deploy',
    lock_entry: makeLockWorkflow('on-deploy'),
    trigger_types: ['kici_event'],
    routing_key: 'github:42',
    provider_context: {},
    disabled: false,
    customerId: 'cust-default',
    commitSha: null,
    sourceFile: null,
    isGlobal: false,
    created_at: new Date('2026-02-25T10:00:00Z'),
    updated_at: new Date('2026-02-25T10:00:00Z'),
    ...overrides,
  };
}

function createMockStore(
  options: {
    rows?: RegistrationRow[];
    version?: number;
  } = {},
): RegistrationStore {
  const rows = options.rows ?? [];
  const version = options.version ?? 1;

  return {
    getAll: vi.fn().mockResolvedValue(rows),
    getVersion: vi.fn().mockResolvedValue(version),
    // Not needed for index tests but required by the type
    replaceAll: vi.fn(),
    getByRoutingKey: vi.fn(),
    getByRoutingKeyAndRepo: vi.fn(),
    deleteByRoutingKeyAndRepo: vi.fn(),
    bumpVersion: vi.fn(),
  } as unknown as RegistrationStore;
}

// ── Tests ──────────────────────────────────────────────────────────

describe('RegistrationIndex', () => {
  describe('loadFromDb', () => {
    it('should populate primary index (by routingKey:repo)', async () => {
      const rows = [
        makeRegistrationRow({
          id: 'reg-1',
          routing_key: 'github:42',
          repo_identifier: 'owner/repo-a',
          workflow_name: 'wf-1',
        }),
        makeRegistrationRow({
          id: 'reg-2',
          routing_key: 'github:42',
          repo_identifier: 'owner/repo-a',
          workflow_name: 'wf-2',
        }),
        makeRegistrationRow({
          id: 'reg-3',
          routing_key: 'github:99',
          repo_identifier: 'owner/repo-b',
          workflow_name: 'wf-3',
        }),
      ];
      const store = createMockStore({ rows, version: 3 });
      const index = new RegistrationIndex(store);

      await index.loadFromDb();

      // github:42:owner/repo-a should have 2 workflows
      const repo1 = index.getByRoutingKeyAndRepo('github:42', 'owner/repo-a');
      expect(repo1).toHaveLength(2);
      expect(repo1.map((r) => r.workflowName)).toEqual(['wf-1', 'wf-2']);

      // github:99:owner/repo-b should have 1 workflow
      const repo2 = index.getByRoutingKeyAndRepo('github:99', 'owner/repo-b');
      expect(repo2).toHaveLength(1);
      expect(repo2[0].workflowName).toBe('wf-3');

      // Version should be set
      expect(index.getVersion()).toBe(3);
    });

    it('should populate secondary index (by trigger type)', async () => {
      const rows = [
        makeRegistrationRow({
          id: 'reg-1',
          workflow_name: 'cron-job',
          trigger_types: ['schedule'],
          lock_entry: makeLockWorkflow('cron-job', ['schedule']),
        }),
        makeRegistrationRow({
          id: 'reg-2',
          workflow_name: 'event-handler',
          trigger_types: ['kici_event'],
          lock_entry: makeLockWorkflow('event-handler', ['kici_event']),
        }),
        makeRegistrationRow({
          id: 'reg-3',
          workflow_name: 'multi-trigger',
          trigger_types: ['kici_event', 'schedule'],
          lock_entry: makeLockWorkflow('multi-trigger', ['kici_event', 'schedule']),
        }),
      ];
      const store = createMockStore({ rows, version: 1 });
      const index = new RegistrationIndex(store);

      await index.loadFromDb();

      // kici_event should match 2 workflows
      const kiciEvents = index.getByTriggerType('kici_event');
      expect(kiciEvents).toHaveLength(2);
      expect(kiciEvents.map((r) => r.workflowName).sort()).toEqual([
        'event-handler',
        'multi-trigger',
      ]);

      // schedule should match 2 workflows
      const schedules = index.getByTriggerType('schedule');
      expect(schedules).toHaveLength(2);
      expect(schedules.map((r) => r.workflowName).sort()).toEqual(['cron-job', 'multi-trigger']);
    });

    it('should handle empty registration set', async () => {
      const store = createMockStore({ rows: [], version: 0 });
      const index = new RegistrationIndex(store);

      await index.loadFromDb();

      expect(index.getByTriggerType('kici_event')).toEqual([]);
      expect(index.getByRoutingKeyAndRepo('any', 'any')).toEqual([]);
      expect(index.getVersion()).toBe(0);
    });

    it('should clear previous data on reload', async () => {
      const store = createMockStore({
        rows: [makeRegistrationRow({ id: 'reg-1', workflow_name: 'wf-old' })],
        version: 1,
      });
      const index = new RegistrationIndex(store);

      await index.loadFromDb();
      expect(index.getByTriggerType('kici_event')).toHaveLength(1);

      // Now reload with empty set
      (store.getAll as any).mockResolvedValue([]);
      (store.getVersion as any).mockResolvedValue(2);
      await index.loadFromDb();

      expect(index.getByTriggerType('kici_event')).toEqual([]);
      expect(index.getVersion()).toBe(2);
    });
  });

  describe('refreshIfNeeded', () => {
    it('should reload when remote version is higher', async () => {
      const store = createMockStore({ rows: [], version: 5 });
      const index = new RegistrationIndex(store);

      // Version starts at 0, remote is 5 -> should reload
      await index.refreshIfNeeded(5);

      expect(store.getAll).toHaveBeenCalled();
      expect(store.getVersion).toHaveBeenCalled();
      expect(index.getVersion()).toBe(5);
    });

    it('should skip reload when remote version equals local version', async () => {
      const store = createMockStore({ rows: [], version: 3 });
      const index = new RegistrationIndex(store);

      // First load sets version to 3
      await index.loadFromDb();
      (store.getAll as any).mockClear();
      (store.getVersion as any).mockClear();

      // Same version -> should skip
      await index.refreshIfNeeded(3);

      expect(store.getAll).not.toHaveBeenCalled();
    });

    it('should skip reload when remote version is lower than local', async () => {
      const store = createMockStore({ rows: [], version: 5 });
      const index = new RegistrationIndex(store);

      await index.loadFromDb();
      (store.getAll as any).mockClear();

      // Lower version -> should skip
      await index.refreshIfNeeded(3);

      expect(store.getAll).not.toHaveBeenCalled();
    });
  });

  describe('getByTriggerType', () => {
    it('should return empty array for unknown trigger type', async () => {
      const store = createMockStore({ rows: [], version: 1 });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      expect(index.getByTriggerType('nonexistent')).toEqual([]);
    });

    it('should return correct entries for specific trigger type', async () => {
      const rows = [
        makeRegistrationRow({
          id: 'reg-1',
          workflow_name: 'webhook-handler',
          trigger_types: ['generic_webhook'],
          lock_entry: makeLockWorkflow('webhook-handler', ['generic_webhook']),
        }),
      ];
      const store = createMockStore({ rows, version: 1 });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      const result = index.getByTriggerType('generic_webhook');
      expect(result).toHaveLength(1);
      expect(result[0].workflowName).toBe('webhook-handler');
    });
  });

  describe('getCronSchedules', () => {
    it('should return all workflows with schedule trigger type', async () => {
      const rows = [
        makeRegistrationRow({
          id: 'reg-1',
          workflow_name: 'nightly-build',
          trigger_types: ['schedule'],
          lock_entry: makeLockWorkflow('nightly-build', ['schedule']),
        }),
        makeRegistrationRow({
          id: 'reg-2',
          workflow_name: 'hourly-check',
          trigger_types: ['schedule'],
          lock_entry: makeLockWorkflow('hourly-check', ['schedule']),
        }),
        makeRegistrationRow({
          id: 'reg-3',
          workflow_name: 'event-handler',
          trigger_types: ['kici_event'],
          lock_entry: makeLockWorkflow('event-handler', ['kici_event']),
        }),
      ];
      const store = createMockStore({ rows, version: 1 });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      const schedules = index.getCronSchedules();
      expect(schedules).toHaveLength(2);
      expect(schedules.map((s) => s.workflowName).sort()).toEqual([
        'hourly-check',
        'nightly-build',
      ]);
    });

    it('should return empty array when no schedules registered', async () => {
      const store = createMockStore({ rows: [], version: 1 });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      expect(index.getCronSchedules()).toEqual([]);
    });
  });

  describe('getByEventType', () => {
    let index: RegistrationIndex;

    beforeEach(async () => {
      const rows = [
        makeRegistrationRow({
          id: 'reg-1',
          workflow_name: 'on-wf-complete',
          trigger_types: ['workflow_complete'],
          lock_entry: makeLockWorkflow('on-wf-complete', ['workflow_complete']),
        }),
        makeRegistrationRow({
          id: 'reg-2',
          workflow_name: 'lifecycle-listener',
          trigger_types: ['lifecycle'],
          lock_entry: makeLockWorkflow('lifecycle-listener', ['lifecycle']),
        }),
        makeRegistrationRow({
          id: 'reg-3',
          workflow_name: 'event-handler',
          trigger_types: ['kici_event'],
          lock_entry: makeLockWorkflow('event-handler', ['kici_event']),
        }),
      ];
      const store = createMockStore({ rows, version: 1 });
      index = new RegistrationIndex(store);
      await index.loadFromDb();
    });

    it('should return direct matches for kici_event', () => {
      const result = index.getByEventType('kici_event');
      expect(result).toHaveLength(1);
      expect(result[0].workflowName).toBe('event-handler');
    });

    it('should merge workflow_complete with lifecycle triggers', () => {
      const result = index.getByEventType('workflow_complete');
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.workflowName).sort()).toEqual([
        'lifecycle-listener',
        'on-wf-complete',
      ]);
    });

    it('should merge job_complete with lifecycle triggers', () => {
      const result = index.getByEventType('job_complete');
      // Only lifecycle-listener matches (no direct job_complete registrations)
      expect(result).toHaveLength(1);
      expect(result[0].workflowName).toBe('lifecycle-listener');
    });

    it('should return empty array for unregistered event type', () => {
      expect(index.getByEventType('nonexistent')).toEqual([]);
    });
  });

  describe('getByRoutingKeyAndRepo', () => {
    it('should return empty array for unknown routingKey/repo pair', async () => {
      const store = createMockStore({ rows: [], version: 1 });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      expect(index.getByRoutingKeyAndRepo('unknown', 'unknown/repo')).toEqual([]);
    });
  });

  describe('disabled workflow filtering', () => {
    it('should exclude disabled workflows from getByTriggerType', async () => {
      const rows = [
        makeRegistrationRow({
          id: 'reg-1',
          workflow_name: 'active-wf',
          disabled: false,
        }),
        makeRegistrationRow({
          id: 'reg-2',
          workflow_name: 'disabled-wf',
          disabled: true,
        }),
      ];
      const store = createMockStore({ rows, version: 1 });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      const result = index.getByTriggerType('kici_event');
      expect(result).toHaveLength(1);
      expect(result[0].workflowName).toBe('active-wf');
    });

    it('should exclude disabled workflows from getCronSchedules', async () => {
      const rows = [
        makeRegistrationRow({
          id: 'reg-1',
          workflow_name: 'active-cron',
          trigger_types: ['schedule'],
          lock_entry: makeLockWorkflow('active-cron', ['schedule']),
          disabled: false,
        }),
        makeRegistrationRow({
          id: 'reg-2',
          workflow_name: 'disabled-cron',
          trigger_types: ['schedule'],
          lock_entry: makeLockWorkflow('disabled-cron', ['schedule']),
          disabled: true,
        }),
      ];
      const store = createMockStore({ rows, version: 1 });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      const result = index.getCronSchedules();
      expect(result).toHaveLength(1);
      expect(result[0].workflowName).toBe('active-cron');
    });

    it('should still include disabled workflows in getByRoutingKeyAndRepo (for dashboard listing)', async () => {
      const rows = [
        makeRegistrationRow({
          id: 'reg-1',
          workflow_name: 'active-wf',
          disabled: false,
        }),
        makeRegistrationRow({
          id: 'reg-2',
          workflow_name: 'disabled-wf',
          disabled: true,
        }),
      ];
      const store = createMockStore({ rows, version: 1 });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      const result = index.getByRoutingKeyAndRepo('github:42', 'owner/repo');
      expect(result).toHaveLength(2);
    });
  });

  describe('getGlobalByTriggerType', () => {
    it('should route workflows with isGlobal=true to global index', async () => {
      const rows = [
        makeRegistrationRow({
          id: 'global-1',
          workflow_name: 'security-scan',
          isGlobal: true,
          trigger_types: ['push'],
          lock_entry: makeLockWorkflow('security-scan', ['push']),
        }),
        makeRegistrationRow({
          id: 'local-1',
          workflow_name: 'ci',
          isGlobal: false,
          trigger_types: ['push'],
          lock_entry: makeLockWorkflow('ci', ['push']),
        }),
      ];
      const store = createMockStore({ rows, version: 1 });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      const globals = index.getGlobalByTriggerType('push', 'github:42');
      expect(globals).toHaveLength(1);
      expect(globals[0].workflowName).toBe('security-scan');
      expect(globals[0].isGlobal).toBe(true);
    });

    it('should return only global workflows with matching trigger type', async () => {
      const rows = [
        makeRegistrationRow({
          id: 'global-push',
          workflow_name: 'global-push',
          isGlobal: true,
          trigger_types: ['push'],
          lock_entry: makeLockWorkflow('global-push', ['push']),
        }),
        makeRegistrationRow({
          id: 'global-pr',
          workflow_name: 'global-pr',
          isGlobal: true,
          trigger_types: ['pr'],
          lock_entry: makeLockWorkflow('global-pr', ['pr']),
        }),
      ];
      const store = createMockStore({ rows, version: 1 });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      const pushGlobals = index.getGlobalByTriggerType('push', 'github:42');
      expect(pushGlobals).toHaveLength(1);
      expect(pushGlobals[0].workflowName).toBe('global-push');
    });

    it('should filter by routing key', async () => {
      const rows = [
        makeRegistrationRow({
          id: 'global-rk1',
          workflow_name: 'scan-rk1',
          isGlobal: true,
          trigger_types: ['push'],
          routing_key: 'github:42',
          lock_entry: makeLockWorkflow('scan-rk1', ['push']),
        }),
        makeRegistrationRow({
          id: 'global-rk2',
          workflow_name: 'scan-rk2',
          isGlobal: true,
          trigger_types: ['push'],
          routing_key: 'github:99',
          lock_entry: makeLockWorkflow('scan-rk2', ['push']),
        }),
      ];
      const store = createMockStore({ rows, version: 1 });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      const rk42 = index.getGlobalByTriggerType('push', 'github:42');
      expect(rk42).toHaveLength(1);
      expect(rk42[0].workflowName).toBe('scan-rk1');

      const rk99 = index.getGlobalByTriggerType('push', 'github:99');
      expect(rk99).toHaveLength(1);
      expect(rk99[0].workflowName).toBe('scan-rk2');
    });

    it('should exclude disabled global workflows', async () => {
      const rows = [
        makeRegistrationRow({
          id: 'global-disabled',
          workflow_name: 'scan-disabled',
          isGlobal: true,
          trigger_types: ['push'],
          disabled: true,
          lock_entry: makeLockWorkflow('scan-disabled', ['push']),
        }),
        makeRegistrationRow({
          id: 'global-enabled',
          workflow_name: 'scan-enabled',
          isGlobal: true,
          trigger_types: ['push'],
          disabled: false,
          lock_entry: makeLockWorkflow('scan-enabled', ['push']),
        }),
      ];
      const store = createMockStore({ rows, version: 1 });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      const globals = index.getGlobalByTriggerType('push', 'github:42');
      expect(globals).toHaveLength(1);
      expect(globals[0].workflowName).toBe('scan-enabled');
    });

    it('should return empty array for nonexistent trigger type', async () => {
      const rows = [
        makeRegistrationRow({
          id: 'global-1',
          workflow_name: 'scan',
          isGlobal: true,
          trigger_types: ['push'],
          lock_entry: makeLockWorkflow('scan', ['push']),
        }),
      ];
      const store = createMockStore({ rows, version: 1 });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      expect(index.getGlobalByTriggerType('nonexistent', 'github:42')).toEqual([]);
    });

    it('should clear global index on reload', async () => {
      const store = createMockStore({
        rows: [
          makeRegistrationRow({
            id: 'global-1',
            workflow_name: 'scan',
            isGlobal: true,
            trigger_types: ['push'],
            lock_entry: makeLockWorkflow('scan', ['push']),
          }),
        ],
        version: 1,
      });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      expect(index.getGlobalByTriggerType('push', 'github:42')).toHaveLength(1);

      // Reload with empty set
      (store.getAll as any).mockResolvedValue([]);
      (store.getVersion as any).mockResolvedValue(2);
      await index.loadFromDb();

      expect(index.getGlobalByTriggerType('push', 'github:42')).toEqual([]);
    });
  });

  describe('getById', () => {
    it('should return a registration by ID', async () => {
      const rows = [
        makeRegistrationRow({ id: 'reg-1', workflow_name: 'wf-1' }),
        makeRegistrationRow({ id: 'reg-2', workflow_name: 'wf-2' }),
      ];
      const store = createMockStore({ rows, version: 1 });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      const result = index.getById('reg-2');
      expect(result).toBeDefined();
      expect(result!.workflowName).toBe('wf-2');
    });

    it('should return undefined for unknown ID', async () => {
      const store = createMockStore({ rows: [], version: 1 });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      expect(index.getById('nonexistent')).toBeUndefined();
    });

    it('should include disabled registrations', async () => {
      const rows = [
        makeRegistrationRow({ id: 'reg-disabled', workflow_name: 'disabled-wf', disabled: true }),
      ];
      const store = createMockStore({ rows, version: 1 });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      const result = index.getById('reg-disabled');
      expect(result).toBeDefined();
      expect(result!.disabled).toBe(true);
    });
  });

  describe('getByOrgAndEvent (cross-source webhook lookup)', () => {
    it('Test A — happy path: returns all org-A registrations listening for `foo`', async () => {
      const rows = [
        makeRegistrationRow({
          id: 'reg-1',
          customerId: 'orgA',
          workflow_name: 'wf-1',
          trigger_types: ['webhook'],
          lock_entry: makeLockWebhookWorkflow('wf-1', ['foo']),
        }),
        makeRegistrationRow({
          id: 'reg-2',
          customerId: 'orgA',
          workflow_name: 'wf-2',
          trigger_types: ['webhook'],
          lock_entry: makeLockWebhookWorkflow('wf-2', ['foo']),
        }),
      ];
      const store = createMockStore({ rows, version: 1 });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      const result = index.getByOrgAndEvent('orgA', 'foo');
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.id).sort()).toEqual(['reg-1', 'reg-2']);
    });

    it('Test B — cross-org isolation (WHK-CROSS-02): orgA lookup never returns orgB rows', async () => {
      const rows = [
        makeRegistrationRow({
          id: 'reg-X',
          customerId: 'orgA',
          workflow_name: 'wf-X',
          trigger_types: ['webhook'],
          lock_entry: makeLockWebhookWorkflow('wf-X', ['foo']),
        }),
        makeRegistrationRow({
          id: 'reg-Y',
          customerId: 'orgB',
          workflow_name: 'wf-Y',
          trigger_types: ['webhook'],
          lock_entry: makeLockWebhookWorkflow('wf-Y', ['foo']),
        }),
      ];
      const store = createMockStore({ rows, version: 1 });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      const orgA = index.getByOrgAndEvent('orgA', 'foo');
      expect(orgA).toHaveLength(1);
      expect(orgA[0].id).toBe('reg-X');

      const orgB = index.getByOrgAndEvent('orgB', 'foo');
      expect(orgB).toHaveLength(1);
      expect(orgB[0].id).toBe('reg-Y');
    });

    it('Test C — disabled rows are excluded', async () => {
      const rows = [
        makeRegistrationRow({
          id: 'reg-active',
          customerId: 'orgA',
          workflow_name: 'wf-active',
          trigger_types: ['webhook'],
          lock_entry: makeLockWebhookWorkflow('wf-active', ['foo']),
          disabled: false,
        }),
        makeRegistrationRow({
          id: 'reg-disabled',
          customerId: 'orgA',
          workflow_name: 'wf-disabled',
          trigger_types: ['webhook'],
          lock_entry: makeLockWebhookWorkflow('wf-disabled', ['foo']),
          disabled: true,
        }),
      ];
      const store = createMockStore({ rows, version: 1 });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      const result = index.getByOrgAndEvent('orgA', 'foo');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('reg-active');
    });

    it('Test D — events array change via reload moves the row to the new key', async () => {
      const initial = [
        makeRegistrationRow({
          id: 'reg-1',
          customerId: 'orgA',
          workflow_name: 'wf-1',
          trigger_types: ['webhook'],
          lock_entry: makeLockWebhookWorkflow('wf-1', ['foo']),
        }),
      ];
      const store = createMockStore({ rows: initial, version: 1 });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      expect(index.getByOrgAndEvent('orgA', 'foo')).toHaveLength(1);
      expect(index.getByOrgAndEvent('orgA', 'bar')).toHaveLength(0);

      // Simulate an upsert that swapped events from ['foo'] to ['bar'].
      const updated = [
        makeRegistrationRow({
          id: 'reg-1',
          customerId: 'orgA',
          workflow_name: 'wf-1',
          trigger_types: ['webhook'],
          lock_entry: makeLockWebhookWorkflow('wf-1', ['bar']),
        }),
      ];
      (store.getAll as any).mockResolvedValue(updated);
      (store.getVersion as any).mockResolvedValue(2);
      await index.loadFromDb();

      expect(index.getByOrgAndEvent('orgA', 'foo')).toHaveLength(0);
      expect(index.getByOrgAndEvent('orgA', 'bar')).toHaveLength(1);
    });

    it('Test E — non-webhook triggers (e.g. kici_event only) are not present in the index', async () => {
      const rows = [
        makeRegistrationRow({
          id: 'reg-1',
          customerId: 'orgA',
          workflow_name: 'wf-1',
          // kici_event only — no webhook trigger
          trigger_types: ['kici_event'],
          lock_entry: makeLockWorkflow('wf-1', ['kici_event']),
        }),
      ];
      const store = createMockStore({ rows, version: 1 });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      // The kici_event trigger fixture uses eventName 'test'; even with that
      // exact string, the byOrgAndEvent index must be empty because the row
      // has no webhook trigger.
      expect(index.getByOrgAndEvent('orgA', 'test')).toHaveLength(0);
      expect(index.getByOrgAndEvent('orgA', 'foo')).toHaveLength(0);
    });

    it('Test F — single webhook trigger with multiple events is reachable via every event name', async () => {
      const rows = [
        makeRegistrationRow({
          id: 'reg-1',
          customerId: 'orgA',
          workflow_name: 'wf-multi',
          trigger_types: ['webhook'],
          lock_entry: makeLockWebhookWorkflow('wf-multi', ['foo', 'bar']),
        }),
      ];
      const store = createMockStore({ rows, version: 1 });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      const fooHits = index.getByOrgAndEvent('orgA', 'foo');
      const barHits = index.getByOrgAndEvent('orgA', 'bar');
      expect(fooHits).toHaveLength(1);
      expect(barHits).toHaveLength(1);
      expect(fooHits[0].id).toBe('reg-1');
      expect(barHits[0].id).toBe('reg-1');
    });

    it('returns empty array for unknown (org, event) pairs', async () => {
      const store = createMockStore({ rows: [], version: 1 });
      const index = new RegistrationIndex(store);
      await index.loadFromDb();
      expect(index.getByOrgAndEvent('orgA', 'foo')).toEqual([]);
    });
  });

  describe('loadFromDb version ordering', () => {
    it('should read version before rows to avoid TOCTOU race', async () => {
      const callOrder: string[] = [];
      const store = {
        getAll: vi.fn().mockImplementation(async () => {
          callOrder.push('getAll');
          return [];
        }),
        getVersion: vi.fn().mockImplementation(async () => {
          callOrder.push('getVersion');
          return 1;
        }),
        replaceAll: vi.fn(),
        getByRoutingKey: vi.fn(),
        getByRoutingKeyAndRepo: vi.fn(),
        deleteByRoutingKeyAndRepo: vi.fn(),
        bumpVersion: vi.fn(),
      } as unknown as RegistrationStore;

      const index = new RegistrationIndex(store);
      await index.loadFromDb();

      // getVersion must be called before getAll to avoid stale-data-with-new-version
      expect(callOrder).toEqual(['getVersion', 'getAll']);
    });
  });
});
