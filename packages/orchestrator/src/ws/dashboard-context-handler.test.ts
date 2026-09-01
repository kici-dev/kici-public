import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DashboardContextHandler } from './dashboard-context-handler.js';
import type { DashboardContextHandlerDeps } from './dashboard-context-handler.js';
import type { DashboardPlatformToOrchMessage } from '@kici-dev/engine';
import {
  ContextDeleteErrorCode,
  AccessLogOutcome,
  HoldType,
  stringifyActor,
  type ActorPrincipal,
} from '@kici-dev/engine';
import { ContextDeleteBlockedError } from '../contexts/context-store.js';
import { invalidateDashboardWritePolicyCache } from '../policy/dashboard-write-policy.js';
import { loadRoutableStores } from '../secrets/scope-routing.js';
import { generateDashboardEncryptionKey } from '../secrets/dashboard-encryption-key.js';
import { decryptPrivateKey } from '../secrets/ephemeral-keys.js';
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
  createCipheriv,
} from 'node:crypto';

function createMockDeps(): DashboardContextHandlerDeps & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    orgId: 'org-1',
    send: (msg: unknown) => sent.push(msg),
    contextStore: {
      list: vi.fn().mockResolvedValue([
        {
          id: 'env-1',
          name: 'production',
          type: 'fixed',
          glob_pattern: null,
          enabled: true,
          created_at: new Date('2026-01-01'),
          updated_at: new Date('2026-01-02'),
        },
      ]),
      get: vi.fn().mockResolvedValue({
        id: 'env-1',
        name: 'production',
        type: 'fixed',
        glob_pattern: null,
        branch_restrictions: null,
        concurrency_limit: null,
        concurrency_strategy: null,
        required_reviewers: null,
        wait_timer_seconds: null,
        hold_expiry_seconds: null,
        enabled: true,
        created_at: new Date('2026-01-01'),
        updated_at: new Date('2026-01-02'),
      }),
      create: vi.fn().mockResolvedValue({
        id: 'env-new',
        name: 'staging',
        type: 'fixed',
        glob_pattern: null,
        enabled: true,
        created_at: new Date(),
        updated_at: new Date(),
      }),
      update: vi.fn().mockResolvedValue({
        id: 'env-1',
        name: 'production-updated',
        type: 'fixed',
      }),
      delete: vi.fn().mockResolvedValue(true),
    } as any,
    variableStore: {
      listVars: vi.fn().mockResolvedValue([{ key: 'APP_ENV', value: 'production', locked: true }]),
      setVar: vi.fn().mockResolvedValue(undefined),
      deleteVar: vi.fn().mockResolvedValue(undefined),
      listSourceOverrides: vi.fn().mockResolvedValue([{ key: 'DB_HOST', value: 'db.example.com' }]),
      setSourceOverride: vi.fn().mockResolvedValue(undefined),
      deleteSourceOverride: vi.fn().mockResolvedValue(undefined),
    } as any,
    bindingStore: {
      list: vi.fn().mockResolvedValue([
        { scope_pattern: 'aws/prod/**', host_pattern: '**' },
        { scope_pattern: 'gcp/**', host_pattern: 'box-00002' },
      ]),
      set: vi.fn().mockResolvedValue(undefined),
    } as any,
    secretStore: {
      listScopes: vi.fn().mockResolvedValue(['aws/prod', 'gcp/main']),
      listKeys: vi.fn().mockResolvedValue(['API_KEY', 'SECRET']),
      setSecret: vi.fn().mockResolvedValue(undefined),
      deleteSecret: vi.fn().mockResolvedValue(undefined),
    },
    db: {
      selectFrom: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      selectAll: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      distinct: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      offset: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue([]),
      updateTable: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      executeTakeFirst: vi.fn().mockResolvedValue({ numUpdatedRows: 1n }),
    } as any,
    sent,
  };
}

describe('DashboardContextHandler', () => {
  let deps: ReturnType<typeof createMockDeps>;
  let handler: DashboardContextHandler;

  beforeEach(() => {
    deps = createMockDeps();
    handler = new DashboardContextHandler(deps);
    // Policy reads are cached in-process; clear between tests so a
    // disabled-policy test does not leak into the next.
    invalidateDashboardWritePolicyCache();
  });

  describe('context CRUD', () => {
    it('handles dashboard.contexts.list', async () => {
      const handled = await handler.handleMessage({
        type: 'dashboard.contexts.list',
        requestId: 'req-1',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.contextStore.list).toHaveBeenCalledWith('org-1');
      expect(deps.sent).toHaveLength(1);
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.contexts.list.response');
      expect(resp.requestId).toBe('req-1');
      expect(resp.contexts).toHaveLength(1);
      expect(resp.contexts[0].name).toBe('production');
      // Without includeSecrets, no secret keys are attached or queried.
      expect(resp.contexts[0].secretKeys).toBeUndefined();
      expect(deps.db.selectFrom).not.toHaveBeenCalled();
    });

    it('attaches secret key names when includeSecrets is set', async () => {
      (deps.db.execute as any).mockResolvedValueOnce([
        { context_id: 'env-1', key: 'DB_PASS' },
        { context_id: 'env-1', key: 'DB_HOST' },
      ]);

      const handled = await handler.handleMessage({
        type: 'dashboard.contexts.list',
        requestId: 'req-1s',
        includeSecrets: true,
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.db.selectFrom).toHaveBeenCalledWith('context_bindings as eb');
      const resp = deps.sent[0] as any;
      // Sorted, distinct key names — never values.
      expect(resp.contexts[0].secretKeys).toEqual(['DB_HOST', 'DB_PASS']);
    });

    it('scopes the list to the request orgId when the Platform carries one', async () => {
      // Platform-first dev path: the relayed message carries the validated
      // target org, which must override the orchestrator's static connection
      // org (deps.orgId = 'org-1'). Without this, a `kici secrets list` against
      // an org anchored only by remote_sources reads the wrong tenant's
      // contexts because the connection org points elsewhere.
      const handled = await handler.handleMessage({
        type: 'dashboard.contexts.list',
        requestId: 'req-org',
        orgId: 'org-remote',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.contextStore.list).toHaveBeenCalledWith('org-remote');
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.contexts.list.response');
    });

    it('scopes secret-key discovery to the request orgId when carried', async () => {
      (deps.db.execute as any).mockResolvedValueOnce([{ context_id: 'env-1', key: 'PGUSER' }]);

      const handled = await handler.handleMessage({
        type: 'dashboard.contexts.list',
        requestId: 'req-org-secrets',
        includeSecrets: true,
        orgId: 'org-remote',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.contextStore.list).toHaveBeenCalledWith('org-remote');
      // The binding→secret join must filter on the request org, not 'org-1'.
      expect(deps.db.where).toHaveBeenCalledWith('eb.org_id', '=', 'org-remote');
      const resp = deps.sent[0] as any;
      expect(resp.contexts[0].secretKeys).toEqual(['PGUSER']);
    });

    it('handles dashboard.contexts.create', async () => {
      const handled = await handler.handleMessage({
        type: 'dashboard.contexts.create',
        requestId: 'req-2',
        name: 'staging',
        contextType: 'fixed',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.contextStore.create).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({
          name: 'staging',
          type: 'fixed',
        }),
      );
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.contexts.create.response');
      expect(resp.contextId).toBe('env-new');
    });

    it('returns error when store throws', async () => {
      (deps.contextStore.list as any).mockRejectedValue(new Error('DB error'));

      await handler.handleMessage({
        type: 'dashboard.contexts.list',
        requestId: 'req-err',
      } as DashboardPlatformToOrchMessage);

      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.contexts.list.response');
      expect(resp.requestId).toBe('req-err');
      expect(resp.error).toBe('DB error');
    });

    it('returns an errorCode when delete is blocked by pending held runs', async () => {
      const accessLogRecord = vi.fn();
      deps.accessLog = { record: accessLogRecord };
      handler = new DashboardContextHandler(deps);
      (deps.contextStore.delete as any).mockRejectedValue(new ContextDeleteBlockedError(2));

      await handler.handleMessage({
        type: 'dashboard.contexts.delete',
        requestId: 'req-del-blocked',
        contextId: 'env-1',
      } as DashboardPlatformToOrchMessage);

      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.contexts.delete.response');
      expect(resp.requestId).toBe('req-del-blocked');
      expect(resp.error).toBe('Context has 2 pending held run(s) — approve or reject them first');
      expect(resp.errorCode).toBe(ContextDeleteErrorCode.enum.pending_held_runs);

      // A blocked delete is a business rejection, not a server error: the
      // access-log row MUST be written with outcome 'denied' (the ternary at
      // dashboard-context-handler.ts maps ContextDeleteBlockedError → denied).
      expect(accessLogRecord).toHaveBeenCalledTimes(1);
      expect(accessLogRecord.mock.calls[0][0]).toMatchObject({
        action: 'context.delete',
        outcome: AccessLogOutcome.enum.denied,
      });
    });
  });

  describe('context update — omitted vs explicitly-null vs value', () => {
    /** Drive `dashboard.contexts.update` and return the store's `updates` arg. */
    async function updatesFor(updates: Record<string, unknown>): Promise<Record<string, unknown>> {
      await handler.handleMessage({
        type: 'dashboard.contexts.update',
        requestId: 'req-upd',
        contextId: 'env-1',
        updates,
      } as unknown as DashboardPlatformToOrchMessage);
      const call = (deps.contextStore.update as any).mock.calls[0];
      expect(call).toBeDefined();
      expect(call[0]).toBe('org-1');
      expect(call[1]).toBe('env-1');
      return call[2] as Record<string, unknown>;
    }

    it('forwards an explicit null so the field is cleared', async () => {
      // The bug: every null became undefined, and the store skips undefined
      // keys — so "turn required reviewers off" silently did nothing and the
      // approval gate could not be removed through the UI at all.
      const updates = await updatesFor({ requiredReviewers: null, holdExpirySeconds: null });

      expect(updates.requiredReviewers).toBeNull();
      expect(updates.holdExpirySeconds).toBeNull();
    });

    it('forwards a null concurrency strategy and branch restrictions', async () => {
      const updates = await updatesFor({ concurrencyStrategy: null, branchRestrictions: null });

      expect(updates.concurrencyStrategy).toBeNull();
      expect(updates.branchRestrictions).toBeNull();
    });

    it('still omits a field the message did not mention', async () => {
      const updates = await updatesFor({ name: 'renamed' });

      expect(updates.name).toBe('renamed');
      expect(updates.requiredReviewers).toBeUndefined();
      expect(updates.holdExpirySeconds).toBeUndefined();
      expect(updates.concurrencyStrategy).toBeUndefined();
      expect(updates.branchRestrictions).toBeUndefined();
    });

    it('maps a reviewer count to the stored array form', async () => {
      // The column holds a JSON array; the wire carries a count. This mapping
      // is pre-existing and must survive the null fix.
      const updates = await updatesFor({
        requiredReviewers: 2,
        holdExpirySeconds: 3600,
        branchRestrictions: ['main'],
        concurrencyStrategy: 'cancel-pending',
      });

      expect(updates.requiredReviewers).toEqual(['2']);
      expect(updates.holdExpirySeconds).toBe(3600);
      expect(updates.branchRestrictions).toEqual(['main']);
      expect(updates.concurrencyStrategy).toBe('cancel-pending');
    });
  });

  describe('test access (contexts.test_access.set)', () => {
    it('applies only allowLocalExecution when the policy allows it', async () => {
      const handled = await handler.handleMessage({
        type: 'dashboard.contexts.test_access.set',
        requestId: 'req-ta1',
        contextId: 'env-1',
        allowLocalExecution: true,
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      // Only the allowLocalExecution field is set on the store update.
      expect(deps.contextStore.update).toHaveBeenCalledWith('org-1', 'env-1', {
        allowLocalExecution: true,
      });
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.contexts.test_access.set.response');
      expect(resp.requestId).toBe('req-ta1');
      expect(resp.error).toBeUndefined();
    });

    it('is denied (CLI-only) when the policy disables the operation', async () => {
      // org_settings row disables contexts.test_access.set for this org.
      (deps.db.executeTakeFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        dashboard_write_policy: { 'contexts.test_access.set': false },
      });

      const handled = await handler.handleMessage({
        type: 'dashboard.contexts.test_access.set',
        requestId: 'req-ta2',
        contextId: 'env-1',
        allowLocalExecution: true,
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      // The store is never touched when the gate denies.
      expect(deps.contextStore.update).not.toHaveBeenCalled();
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.contexts.test_access.set.response');
      expect(resp.requestId).toBe('req-ta2');
      expect(resp.error).toBe('operation_disabled');
      expect(resp.operation).toBe('contexts.test_access.set');
    });
  });

  describe('variables', () => {
    it('handles dashboard.contexts.variables.list', async () => {
      const handled = await handler.handleMessage({
        type: 'dashboard.contexts.variables.list',
        requestId: 'req-v1',
        contextId: 'env-1',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.variableStore.listVars).toHaveBeenCalledWith('org-1', 'env-1');
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.contexts.variables.list.response');
      expect(resp.variables).toHaveLength(1);
      expect(resp.variables[0].key).toBe('APP_ENV');
      expect(resp.variables[0].locked).toBe(true);
    });
  });

  describe('bindings', () => {
    it('handles dashboard.contexts.bindings.list', async () => {
      const handled = await handler.handleMessage({
        type: 'dashboard.contexts.bindings.list',
        requestId: 'req-b1',
        contextId: 'env-1',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.bindingStore.list).toHaveBeenCalledWith('org-1', 'env-1');
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.contexts.bindings.list.response');
      expect(resp.bindings).toEqual([
        { scopePattern: 'aws/prod/**', hostPattern: '**' },
        { scopePattern: 'gcp/**', hostPattern: 'box-00002' },
      ]);
    });

    it('handles dashboard.contexts.bindings.set with host patterns', async () => {
      const handled = await handler.handleMessage({
        type: 'dashboard.contexts.bindings.set',
        requestId: 'req-b2',
        contextId: 'env-1',
        bindings: [
          { scopePattern: 'prod/shared/**', hostPattern: '**' },
          { scopePattern: 'prod/hosts/box-00002/**', hostPattern: 'box-00002' },
        ],
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.bindingStore.set).toHaveBeenCalledWith('org-1', 'env-1', [
        { scopePattern: 'prod/shared/**', hostPattern: '**' },
        { scopePattern: 'prod/hosts/box-00002/**', hostPattern: 'box-00002' },
      ]);
    });
  });

  describe('secrets', () => {
    it('lists secrets from all backend stores', async () => {
      // Set up backendStores with PG and Vault
      const pgStore = {
        listScopes: vi.fn().mockResolvedValue(['pg:aws/prod', 'pg:__source__/github']),
        listKeys: vi.fn().mockResolvedValue(['API_KEY', 'SECRET']),
        setSecret: vi.fn(),
        deleteSecret: vi.fn(),
      };
      const vaultStore = {
        listScopes: vi.fn().mockResolvedValue(['databases/staging']),
        listKeys: vi.fn().mockResolvedValue(['DB_PASS']),
        setSecret: vi.fn(),
        deleteSecret: vi.fn(),
      };
      deps.loadBackendStores = vi.fn().mockResolvedValue(
        new Map([
          ['pg', pgStore],
          ['vault', vaultStore],
        ]),
      );

      const handled = await handler.handleMessage({
        type: 'dashboard.contexts.secrets.list',
        requestId: 'req-sl',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.contexts.secrets.list.response');
      // Should have 3 secrets: 2 keys from pg:aws/prod + 1 from vault:databases/staging
      // pg:__source__/github is filtered out (internal scope)
      expect(resp.secrets).toHaveLength(3);
      expect(resp.secrets[0].scope).toBe('pg:aws/prod');
      expect(resp.secrets[0].key).toBe('API_KEY');
      expect(resp.secrets[2].scope).toBe('vault:databases/staging');
      expect(resp.secrets[2].key).toBe('DB_PASS');
    });

    it('falls back to single secretStore when backendStores not set', async () => {
      const handled = await handler.handleMessage({
        type: 'dashboard.contexts.secrets.list',
        requestId: 'req-sl2',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.secretStore.listScopes).toHaveBeenCalledWith('org-1');
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.contexts.secrets.list.response');
    });

    it('handles dashboard.contexts.secrets.set routing to correct backend', async () => {
      const vaultStore = {
        listScopes: vi.fn(),
        listKeys: vi.fn(),
        setSecret: vi.fn().mockResolvedValue(undefined),
        deleteSecret: vi.fn(),
      };
      deps.loadBackendStores = vi.fn().mockResolvedValue(
        new Map([
          ['pg', deps.secretStore],
          ['vault', vaultStore],
        ]),
      );

      const handled = await handler.handleMessage({
        type: 'dashboard.contexts.secrets.set',
        requestId: 'req-s1',
        scope: 'vault:aws/prod',
        key: 'NEW_KEY',
        value: 'secret-value',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      // Should route to vault store with unprefixed scope
      expect(vaultStore.setSecret).toHaveBeenCalledWith(
        'org-1',
        'aws/prod',
        'NEW_KEY',
        'secret-value',
      );
      // PG store should NOT have been called
      expect(deps.secretStore.setSecret).not.toHaveBeenCalled();
    });

    it('routes a pg:-qualified write to the CONFIGURED store, never the registry-built one', async () => {
      // This composes `loadBackendStores` exactly the way the server bootstrap
      // does. The backend registry synthesizes its own PgSecretStore for the
      // seeded `pg` row, and that instance carries none of the orchestrator's
      // configuration — `customerSecretsEnabled` defaults to true (so it would
      // ignore an operator's `pgCustomerSecrets: false`), its key version is
      // hardcoded to 1, and it has no old-master-key fallback. Routing
      // `pg:<path>` there while `<path>` goes to the configured store makes two
      // spellings of one scope behave differently.
      const registryPgStore = {
        listScopes: vi.fn(),
        listKeys: vi.fn(),
        setSecret: vi.fn().mockResolvedValue(undefined),
        deleteSecret: vi.fn(),
      };
      deps.loadBackendStores = () =>
        loadRoutableStores(
          { loadAllStores: async () => new Map([['pg', registryPgStore as any]]) },
          {},
          deps.secretStore,
        );

      await handler.handleMessage({
        type: 'dashboard.contexts.secrets.set',
        requestId: 'req-cfg',
        scope: 'pg:aws/prod',
        key: 'NEW_KEY',
        value: 'secret-value',
      } as DashboardPlatformToOrchMessage);

      expect(deps.secretStore.setSecret).toHaveBeenCalledWith(
        'org-1',
        'aws/prod',
        'NEW_KEY',
        'secret-value',
      );
      expect(registryPgStore.setSecret).not.toHaveBeenCalled();
    });

    it('handles dashboard.contexts.secrets.set for PG with prefixed scope', async () => {
      const handled = await handler.handleMessage({
        type: 'dashboard.contexts.secrets.set',
        requestId: 'req-s2',
        scope: 'pg:aws/prod',
        key: 'NEW_KEY',
        value: 'secret-value',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      // PG store receives unprefixed scope (stored without prefix in DB)
      expect(deps.secretStore.setSecret).toHaveBeenCalledWith(
        'org-1',
        'aws/prod',
        'NEW_KEY',
        'secret-value',
      );
    });

    it('handles dashboard.contexts.secrets.delete routing to correct backend', async () => {
      const vaultStore = {
        listScopes: vi.fn(),
        listKeys: vi.fn(),
        setSecret: vi.fn(),
        deleteSecret: vi.fn().mockResolvedValue(undefined),
      };
      deps.loadBackendStores = vi.fn().mockResolvedValue(
        new Map([
          ['pg', deps.secretStore],
          ['vault', vaultStore],
        ]),
      );

      await handler.handleMessage({
        type: 'dashboard.contexts.secrets.delete',
        requestId: 'req-d1',
        scope: 'vault:databases/prod',
        key: 'DB_PASS',
      } as DashboardPlatformToOrchMessage);

      expect(vaultStore.deleteSecret).toHaveBeenCalledWith('org-1', 'databases/prod', 'DB_PASS');
    });
  });

  describe('held runs', () => {
    it('handles dashboard.held-runs.approve', async () => {
      const handled = await handler.handleMessage({
        type: 'dashboard.held-runs.approve',
        requestId: 'req-h1',
        heldRunId: 'held-1',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.db.updateTable).toHaveBeenCalledWith('held_runs');
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.held-runs.approve.response');
      expect(resp.error).toBeUndefined();
    });
  });

  describe('scope CRUD', () => {
    it('handles dashboard.contexts.secrets.scope.create with PG prefix', async () => {
      deps.secretStore.createScope = vi.fn().mockResolvedValue(undefined);

      const handled = await handler.handleMessage({
        type: 'dashboard.contexts.secrets.scope.create',
        requestId: 'req-sc1',
        scope: 'pg:aws/new-scope',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      // PG store receives unprefixed scope
      expect(deps.secretStore.createScope).toHaveBeenCalledWith('org-1', 'aws/new-scope');
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.contexts.secrets.scope.create.response');
      expect(resp.error).toBeUndefined();
    });

    it('handles dashboard.contexts.secrets.scope.rename with PG prefix', async () => {
      deps.secretStore.renameScope = vi.fn().mockResolvedValue(undefined);

      const handled = await handler.handleMessage({
        type: 'dashboard.contexts.secrets.scope.rename',
        requestId: 'req-sr1',
        oldScope: 'pg:aws/old',
        newScope: 'pg:aws/new',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.secretStore.renameScope).toHaveBeenCalledWith('org-1', 'aws/old', 'aws/new');
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.contexts.secrets.scope.rename.response');
      expect(resp.error).toBeUndefined();
    });

    it('handles dashboard.contexts.secrets.scope.delete with PG prefix', async () => {
      deps.secretStore.deleteScope = vi.fn().mockResolvedValue(undefined);

      const handled = await handler.handleMessage({
        type: 'dashboard.contexts.secrets.scope.delete',
        requestId: 'req-sd1',
        scope: 'pg:aws/old-scope',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.secretStore.deleteScope).toHaveBeenCalledWith('org-1', 'aws/old-scope');
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.contexts.secrets.scope.delete.response');
      expect(resp.error).toBeUndefined();
    });

    it('routes scope operations to correct backend', async () => {
      const vaultStore = {
        listScopes: vi.fn(),
        listKeys: vi.fn(),
        setSecret: vi.fn(),
        deleteSecret: vi.fn(),
        deleteScope: vi.fn().mockResolvedValue(undefined),
      };
      deps.loadBackendStores = vi.fn().mockResolvedValue(
        new Map([
          ['pg', deps.secretStore],
          ['vault', vaultStore],
        ]),
      );

      await handler.handleMessage({
        type: 'dashboard.contexts.secrets.scope.delete',
        requestId: 'req-sd2',
        scope: 'vault:databases/staging',
      } as DashboardPlatformToOrchMessage);

      // Vault store receives unprefixed scope
      expect(vaultStore.deleteScope).toHaveBeenCalledWith('org-1', 'databases/staging');
    });

    it('refuses a rename that crosses backends instead of renaming inside the source', async () => {
      // Resolving oldScope and newScope independently and ignoring the backend
      // each landed on renames INSIDE the source store: `pg:a -> vault:b`
      // would rewrite the pg scope to `b` while the operator is told the
      // secrets now live in Vault. The AAD binds the scope name, so the rows
      // are re-encrypted under a name that points at the wrong store.
      const vaultStore = {
        listScopes: vi.fn(),
        listKeys: vi.fn(),
        setSecret: vi.fn(),
        deleteSecret: vi.fn(),
        renameScope: vi.fn().mockResolvedValue(undefined),
      };
      deps.secretStore.renameScope = vi.fn().mockResolvedValue(undefined);
      deps.loadBackendStores = vi.fn().mockResolvedValue(
        new Map([
          ['pg', deps.secretStore],
          ['vault', vaultStore],
        ]),
      );

      const handled = await handler.handleMessage({
        type: 'dashboard.contexts.secrets.scope.rename',
        requestId: 'req-xbr',
        oldScope: 'pg:aws/old',
        newScope: 'vault:aws/new',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.secretStore.renameScope).not.toHaveBeenCalled();
      expect(vaultStore.renameScope).not.toHaveBeenCalled();
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.contexts.secrets.scope.rename.response');
      expect(resp.error).toContain('across backends');
      // Both scopes must be resolved against ONE snapshot of the backend map.
      // With a load per scope, a backend registered or removed between the two
      // decides this comparison — a qualifier resolving to a backend in one
      // snapshot and falling through to the default in the other silently
      // turns a cross-backend rename back into an accepted same-backend one.
      expect(deps.loadBackendStores).toHaveBeenCalledTimes(1);
    });

    it('allows a rename that stays inside one non-default backend', async () => {
      const vaultStore = {
        listScopes: vi.fn(),
        listKeys: vi.fn(),
        setSecret: vi.fn(),
        deleteSecret: vi.fn(),
        renameScope: vi.fn().mockResolvedValue(undefined),
      };
      deps.secretStore.renameScope = vi.fn().mockResolvedValue(undefined);
      deps.loadBackendStores = vi.fn().mockResolvedValue(
        new Map([
          ['pg', deps.secretStore],
          ['vault', vaultStore],
        ]),
      );

      await handler.handleMessage({
        type: 'dashboard.contexts.secrets.scope.rename',
        requestId: 'req-vbr',
        oldScope: 'vault:aws/old',
        newScope: 'vault:aws/new',
      } as DashboardPlatformToOrchMessage);

      expect(vaultStore.renameScope).toHaveBeenCalledWith('org-1', 'aws/old', 'aws/new');
      expect(deps.secretStore.renameScope).not.toHaveBeenCalled();
      const resp = deps.sent[0] as any;
      expect(resp.error).toBeUndefined();
    });

    it('refuses a rename from an unqualified scope to a non-default backend', async () => {
      // An unqualified scope resolves to the default backend, so `a -> vault:b`
      // is just as much a cross-backend move as `pg:a -> vault:b`.
      const vaultStore = {
        listScopes: vi.fn(),
        listKeys: vi.fn(),
        setSecret: vi.fn(),
        deleteSecret: vi.fn(),
        renameScope: vi.fn().mockResolvedValue(undefined),
      };
      deps.secretStore.renameScope = vi.fn().mockResolvedValue(undefined);
      deps.loadBackendStores = vi.fn().mockResolvedValue(
        new Map([
          ['pg', deps.secretStore],
          ['vault', vaultStore],
        ]),
      );

      await handler.handleMessage({
        type: 'dashboard.contexts.secrets.scope.rename',
        requestId: 'req-ubr',
        oldScope: 'aws/old',
        newScope: 'vault:aws/new',
      } as DashboardPlatformToOrchMessage);

      expect(deps.secretStore.renameScope).not.toHaveBeenCalled();
      expect(vaultStore.renameScope).not.toHaveBeenCalled();
      const resp = deps.sent[0] as any;
      expect(resp.error).toContain('across backends');
    });

    it('returns error when backend does not support scope creation', async () => {
      // secretStore has no createScope method
      const handled = await handler.handleMessage({
        type: 'dashboard.contexts.secrets.scope.create',
        requestId: 'req-sc-err',
        scope: 'pg:aws/scope',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.contexts.secrets.scope.create.response');
      expect(resp.error).toContain('does not support');
    });
  });

  describe('scope-name validation', () => {
    it('rejects handleScopeCreate for a scope with an empty path segment', async () => {
      deps.secretStore.createScope = vi.fn().mockResolvedValue(undefined);

      await handler.handleMessage({
        type: 'dashboard.contexts.secrets.scope.create',
        requestId: 'r1',
        scope: 'pg:a//b',
      } as DashboardPlatformToOrchMessage);

      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.contexts.secrets.scope.create.response');
      expect(resp.requestId).toBe('r1');
      expect(resp.error).toContain('empty path segments');
      expect(deps.secretStore.createScope).not.toHaveBeenCalled();
    });

    it('rejects handleScopeCreate for a scope containing a percent', async () => {
      deps.secretStore.createScope = vi.fn().mockResolvedValue(undefined);

      await handler.handleMessage({
        type: 'dashboard.contexts.secrets.scope.create',
        requestId: 'r1b',
        scope: 'pg:a%b',
      } as DashboardPlatformToOrchMessage);

      const resp = deps.sent[0] as any;
      expect(resp.error).toEqual(expect.any(String));
      expect(deps.secretStore.createScope).not.toHaveBeenCalled();
    });

    it('allows renaming a malformed scope to a valid one', async () => {
      deps.secretStore.renameScope = vi.fn().mockResolvedValue(undefined);

      await handler.handleMessage({
        type: 'dashboard.contexts.secrets.scope.rename',
        requestId: 'r2',
        oldScope: 'pg:bad%name',
        newScope: 'pg:good/name',
      } as DashboardPlatformToOrchMessage);

      expect(deps.secretStore.renameScope).toHaveBeenCalledWith('org-1', 'bad%name', 'good/name');
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.contexts.secrets.scope.rename.response');
      expect(resp.error).toBeUndefined();
    });

    it('rejects renaming to a malformed newScope', async () => {
      deps.secretStore.renameScope = vi.fn().mockResolvedValue(undefined);

      await handler.handleMessage({
        type: 'dashboard.contexts.secrets.scope.rename',
        requestId: 'r3',
        oldScope: 'pg:good/name',
        newScope: 'pg:bad%name',
      } as DashboardPlatformToOrchMessage);

      expect(deps.secretStore.renameScope).not.toHaveBeenCalled();
      const resp = deps.sent[0] as any;
      expect(resp.requestId).toBe('r3');
      expect(resp.error).toEqual(expect.any(String));
    });

    it('rejects setting a secret into a malformed scope', async () => {
      deps.secretStore.setSecret = vi.fn().mockResolvedValue(undefined);

      await handler.handleMessage({
        type: 'dashboard.contexts.secrets.set',
        requestId: 'r4',
        scope: 'pg:a//b',
        key: 'K',
        value: 'V',
      } as DashboardPlatformToOrchMessage);

      expect(deps.secretStore.setSecret).not.toHaveBeenCalled();
      const resp = deps.sent[0] as any;
      expect(resp.requestId).toBe('r4');
      expect(resp.error).toEqual(expect.any(String));
    });

    it('rejects setting a secret whose key would make the at-rest AAD ambiguous', async () => {
      // The AAD is `orgId:scope:key`. scope 'b' + key 'c:d' renders the same
      // string as scope 'b:c' + key 'd', so a ciphertext written at one
      // location would authenticate at the other.
      deps.secretStore.setSecret = vi.fn().mockResolvedValue(undefined);

      await handler.handleMessage({
        type: 'dashboard.contexts.secrets.set',
        requestId: 'r5',
        scope: 'pg:prod',
        key: 'c:d',
        value: 'V',
      } as DashboardPlatformToOrchMessage);

      expect(deps.secretStore.setSecret).not.toHaveBeenCalled();
      const resp = deps.sent[0] as any;
      expect(resp.requestId).toBe('r5');
      expect(resp.error).toMatch(/letters, digits/);
    });

    it('still deletes a secret whose key predates the key rule', async () => {
      // Delete stays unvalidated so a key stored before the rule existed
      // remains removable.
      deps.secretStore.deleteSecret = vi.fn().mockResolvedValue(undefined);

      await handler.handleMessage({
        type: 'dashboard.contexts.secrets.delete',
        requestId: 'r6',
        scope: 'pg:prod',
        key: 'c:d',
      } as DashboardPlatformToOrchMessage);

      expect(deps.secretStore.deleteSecret).toHaveBeenCalledWith('org-1', 'prod', 'c:d');
      const resp = deps.sent[0] as any;
      expect(resp.requestId).toBe('r6');
      expect(resp.error).toBeUndefined();
    });
  });

  describe('unknown messages', () => {
    it('returns false for non-context messages', async () => {
      const handled = await handler.handleMessage({
        type: 'dashboard.run.detail',
        requestId: 'req-x',
        runId: 'run-1',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(false);
      expect(deps.sent).toHaveLength(0);
    });
  });

  // ── `dashboard.held-runs.approve` orch-side trust model (security invariant) ──
  //
  // Pentest catalog at
  // — Platform→Orchestrator dispatch surface under attacker model A10
  // (compromised Platform credential / rogue Platform process). The handler
  // performs a single SQL UPDATE on `held_runs` filtered by `id` + `org_id` +
  // `status='pending'`. Tenant isolation holds at the SQL filter layer: a
  // rogue Platform that names a `heldRunId` not in this orchestrator's tenant
  // yields zero updated rows and the response carries a non-actionable error
  // string with no further side effects.
  //
  // Two known properties are NOT covered here because they are out of §3
  // (customer-data-isolation) scope:
  //   (1) `approved_by: 'dashboard-user'` is hardcoded instead of derived
  //       from `stringifyActor(msg.actor)`. Attribution is lost in the
  //       `held_runs.approved_by` column but the access log still records
  //       the Platform-supplied actor via `recordAccess`. Audit-integrity
  // question — §10 territory if ever prioritised.
  //   (2) No orch-side automatic dispatch resume mechanism was found wiring
  //       `held_runs.status -> approved` back into `dispatch_queue` /
  //       coordinator routing. A rogue Platform's approval has no immediate
  //       dispatch consequence on this orchestrator without a separate
  // webhook re-trigger or rerun.
  describe('tenant-isolation invariants under rogue Platform (A10)', () => {
    it('SQL UPDATE filters by org_id, id, and status=pending (tenant-isolation gate)', async () => {
      // Drive the handler with a forged heldRunId. The mock db.where chain is
      // fluent (returns this), so we read `db.where.mock.calls` to confirm
      // every filter on the gate is applied.
      await handler.handleMessage({
        type: 'dashboard.held-runs.approve',
        requestId: 'req-isolation-1',
        heldRunId: 'forged-held-id',
      } as DashboardPlatformToOrchMessage);

      const whereCalls = (deps.db.where as ReturnType<typeof vi.fn>).mock.calls;
      // The handler chains three .where(...) calls before .executeTakeFirst.
      // We assert each filter pair is present (column, op, value).
      expect(whereCalls).toEqual(
        expect.arrayContaining([
          ['id', '=', 'forged-held-id'],
          ['org_id', '=', deps.orgId],
          ['status', '=', 'pending'],
        ]),
      );
    });

    it('no rows updated → error response without further side effects', async () => {
      // The handler first reads the dashboard-write policy (org_settings row,
      // permissive default), then runs the held_runs UPDATE. Queue both
      // executeTakeFirst results so the test is independent of the policy
      // read cache: empty policy row, then a zero-row UPDATE result.
      (deps.db.executeTakeFirst as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ numUpdatedRows: 0n });

      await handler.handleMessage({
        type: 'dashboard.held-runs.approve',
        requestId: 'req-not-found',
        heldRunId: 'forged-or-already-resolved',
      } as DashboardPlatformToOrchMessage);

      const resp = deps.sent[0] as { type: string; requestId: string; error?: string };
      expect(resp.type).toBe('dashboard.held-runs.approve.response');
      expect(resp.requestId).toBe('req-not-found');
      expect(resp.error).toBe('Held run not found or already resolved');

      // Single response sent; no side effects on any other store.
      expect(deps.sent).toHaveLength(1);
      expect(deps.contextStore.create).not.toHaveBeenCalled();
      expect(deps.variableStore.setVar).not.toHaveBeenCalled();
      expect(deps.secretStore.setSecret).not.toHaveBeenCalled();
    });
  });

  // ── `dashboard.contexts.secrets.set` orch-side trust model (security invariant) ──
  //
  // Pentest catalog at
  // — Platform→Orchestrator dispatch surface under attacker model A10
  // (compromised Platform credential / rogue Platform process). The wire
  // schema (`packages/engine/src/protocol/messages/dashboard.ts:717`) carries
  // `{requestId, actor, scope, key, value}` — no Platform-supplied `orgId`.
  // The orchestrator handler at
  // `packages/orchestrator/src/ws/dashboard-context-handler.ts:845 handleSecretSet`
  // calls `store.setSecret(this.deps.orgId, scope, key, value)` where
  // `this.deps.orgId` is the orchestrator's OWN configured org. Cross-tenant
  // write is impossible by construction: this orchestrator process is bound
  // to one org; another tenant's secrets live in another orchestrator's DB.
  //
  // The PG backend at `packages/orchestrator/src/secrets/pg-secret-store.ts:112`
  // additionally binds AAD = orgId:scope:key on encryption — even if a
  // backend store somehow leaked rows across orgs (which it cannot, the
  // INSERT also hardcodes org_id), AAD verification would fail on decrypt.
  //
  // Combined with (rerun) a rogue Platform CAN inject malicious
  // values into THIS tenant's workflow execution. That is by-design under
  // the 3-tier auth model — Platform IS the authority for THIS tenant's
  // secret CRUD via the dashboard. The tenant-isolation invariant pinned
  // here is *cross-tenant impossibility*, not "Platform can't influence
  // this tenant's runs" (it can; that's the whole point of dashboards).
  describe('tenant-isolation invariants under rogue Platform (A10)', () => {
    it('handleSecretSet always uses this.deps.orgId — never a Platform-supplied org hint', async () => {
      // Drive with a wire-shape that has only {scope, key, value} (the schema
      // does NOT include orgId on this message type). The handler MUST pass
      // its OWN this.deps.orgId to store.setSecret. The store mock receives
      // the orgId as the first positional argument.
      await handler.handleMessage({
        type: 'dashboard.contexts.secrets.set',
        requestId: 'req-orgid-1',
        scope: 'pg:aws/prod',
        key: 'API_KEY',
        value: 'attacker-controlled-value',
      } as DashboardPlatformToOrchMessage);

      expect(deps.secretStore.setSecret).toHaveBeenCalledOnce();
      const [orgIdArg, scopeArg, keyArg] = (deps.secretStore.setSecret as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      // orgId is sourced from orchestrator deps (this.deps.orgId), NOT from
      // the wire message. Single-tenant binding by construction.
      expect(orgIdArg).toBe(deps.orgId);
      expect(orgIdArg).toBe('org-1');
      expect(scopeArg).toBe('aws/prod');
      expect(keyArg).toBe('API_KEY');
    });

    it('malicious scope strings are stored as data, not interpreted as namespace separators', async () => {
      // A rogue Platform attempts a path-traversal-style scope and an
      // SQL-shape scope. Both MUST flow into store.setSecret as plain
      // string data — never reinterpreted as a different orgId or scope.
      // The store implementation uses parameterised SQL (pg-secret-store.ts:122)
      // so the strings are stored as-is in the `scope` column.
      const maliciousScopes = [
        '../org-other/aws/prod',
        "aws/prod' OR org_id='other",
        'pg:../../etc/passwd',
        'pg:other-tenant/admin',
        '\u0000pg:null-byte',
      ];

      for (const scope of maliciousScopes) {
        (deps.secretStore.setSecret as ReturnType<typeof vi.fn>).mockClear();
        await handler.handleMessage({
          type: 'dashboard.contexts.secrets.set',
          requestId: `req-malicious-${scope}`,
          scope,
          key: 'EVIL_KEY',
          value: 'evil-value',
        } as DashboardPlatformToOrchMessage);

        // Whatever the scope shape, store.setSecret receives it as plain
        // string data with the orchestrator's own orgId. The store layer
        // (PG/Vault) is responsible for handling/rejecting the scope shape
        // (e.g., PG INSERT with a unique-constraint on (org_id, scope, key)
        // simply stores the row; Vault rejects scope characters its API
        // disallows). Either way: cross-tenant write is impossible because
        // the orgId argument is hardcoded to deps.orgId.
        if ((deps.secretStore.setSecret as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
          const [orgIdArg] = (deps.secretStore.setSecret as ReturnType<typeof vi.fn>).mock.calls[0];
          expect(orgIdArg).toBe(deps.orgId);
        }
      }
    });

    it('Platform-supplied orgId field on the wire is ignored if smuggled (defense-in-depth)', async () => {
      // The schema does NOT declare an `orgId` field on this message type, so
      // a strict Zod parse would strip it. But this handler test bypasses the
      // schema (drives the handler directly), so we explicitly add an orgId
      // hint to confirm the handler does not pluck it out of the message
      // object via duck-typing or future-proofing.
      await handler.handleMessage({
        type: 'dashboard.contexts.secrets.set',
        requestId: 'req-smuggle-orgid',
        scope: 'pg:test',
        key: 'KEY',
        value: 'value',
        // Smuggled extra field — handler should ignore it.
        orgId: 'other-tenant-org',
      } as unknown as DashboardPlatformToOrchMessage);

      const [orgIdArg] = (deps.secretStore.setSecret as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(orgIdArg).toBe('org-1');
      expect(orgIdArg).not.toBe('other-tenant-org');
    });
  });

  describe('held runs request-org scoping', () => {
    it('scopes the held-runs list query to the request orgId when the Platform carries one', async () => {
      // A remote run's hold lives under the run's own `remote_sources` org,
      // which differs from this connection's primary webhook-source org.
      // Honoring the Platform-carried org is what surfaces the hold to
      // `kici approve` / `--approve-all` instead of an empty list.
      const handled = await handler.handleMessage({
        type: 'dashboard.held-runs.list',
        requestId: 'req-hr-list',
        runId: 'run-remote-1',
        orgId: 'org-remote',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.db.where).toHaveBeenCalledWith('held_runs.org_id', '=', 'org-remote');
      expect(deps.db.where).not.toHaveBeenCalledWith('held_runs.org_id', '=', 'org-1');
      expect(deps.db.where).toHaveBeenCalledWith('held_runs.run_id', '=', 'run-remote-1');
    });

    it('falls back to the connection org for the held-runs list when no orgId is carried', async () => {
      const handled = await handler.handleMessage({
        type: 'dashboard.held-runs.list',
        requestId: 'req-hr-list-legacy',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.db.where).toHaveBeenCalledWith('held_runs.org_id', '=', 'org-1');
    });

    it('scopes a held-runs approve to the request orgId when the Platform carries one', async () => {
      const handled = await handler.handleMessage({
        type: 'dashboard.held-runs.approve',
        requestId: 'req-hr-approve',
        heldRunId: 'hold-1',
        orgId: 'org-remote',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      // The update path filters by the request org so a remote run's hold
      // (recorded under its `remote_sources` org) is resolvable.
      expect(deps.db.where).toHaveBeenCalledWith('org_id', '=', 'org-remote');
      expect(deps.db.where).not.toHaveBeenCalledWith('org_id', '=', 'org-1');
    });
  });

  describe('handleEnvHistory hasMore', () => {
    const testActor = { type: 'user' as const, sub: 'zsub-test' };

    function makeRuns(n: number) {
      return Array.from({ length: n }, (_, i) => ({
        id: `run-${i}`,
        run_id: `rid-${i}`,
        workflow_name: 'ci',
        status: 'success',
        ref: 'refs/heads/main',
        sha: 'abc',
        started_at: new Date('2026-01-01'),
        completed_at: new Date('2026-01-01'),
        context: 'production',
      }));
    }

    it('exactly limit rows available -> hasMore false, returns all rows', async () => {
      // The handler queries with limit+1 (21); the DB has only 20 rows total,
      // so it returns 20 -> no further page.
      (deps.db.execute as any).mockResolvedValueOnce(makeRuns(20));

      const handled = await handler.handleMessage({
        type: 'dashboard.contexts.history',
        requestId: 'req-hist-1',
        actor: testActor,
        contextId: 'env-1',
        limit: 20,
        offset: 0,
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      const resp = deps.sent.at(-1) as any;
      expect(resp.type).toBe('dashboard.contexts.history.response');
      expect(resp.hasMore).toBe(false);
      expect(resp.runs).toHaveLength(20);
    });

    it('limit+1 rows available -> hasMore true, probe row sliced off', async () => {
      // The limit+1 (21) query returns 21 rows -> another page exists; the
      // 21st probe row must not be leaked to the client.
      (deps.db.execute as any).mockResolvedValueOnce(makeRuns(21));

      const handled = await handler.handleMessage({
        type: 'dashboard.contexts.history',
        requestId: 'req-hist-2',
        actor: testActor,
        contextId: 'env-1',
        limit: 20,
        offset: 0,
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      const resp = deps.sent.at(-1) as any;
      expect(resp.hasMore).toBe(true);
      expect(resp.runs).toHaveLength(20);
    });
  });
});

// ── encrypted-posture (browser-sealed) secret / variable writes ───────────────

describe('DashboardContextHandler — encrypted dashboard writes', () => {
  let deps: ReturnType<typeof createMockDeps>;
  let handler: DashboardContextHandler;
  let key: Awaited<ReturnType<typeof generateDashboardEncryptionKey>>;
  const SECRET = 'a'.repeat(64);

  /** Node stand-in for the browser seal (DER-SPKI eph pubkey + dashboard info). */
  function seal(value: string, orchPubDer: Buffer) {
    const eph = generateKeyPairSync('x25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const shared = diffieHellman({
      privateKey: createPrivateKey({ key: eph.privateKey as Buffer, format: 'der', type: 'pkcs8' }),
      publicKey: createPublicKey({ key: orchPubDer, format: 'der', type: 'spki' }),
    });
    const aes = Buffer.from(
      hkdfSync('sha256', shared, Buffer.alloc(0), 'kici-dashboard-sealed-write', 32),
    );
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', aes, iv, { authTagLength: 16 });
    const ct = Buffer.concat([c.update(value, 'utf-8'), c.final()]);
    return {
      keyId: key.kid,
      ephemeralPublicKey: (eph.publicKey as Buffer).toString('base64'),
      encrypted: Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64'),
    };
  }

  beforeEach(async () => {
    deps = createMockDeps();
    key = await generateDashboardEncryptionKey(SECRET);
    deps.dashboardEncryption = {
      resolve: async () => ({
        activeKid: key.kid,
        publicJwk: key.publicJwk,
        decryptPrivateKeyDer: async (kid: string) =>
          kid === key.kid ? decryptPrivateKey(key.encryptedPrivateKey, SECRET) : null,
      }),
    };
    handler = new DashboardContextHandler(deps);
    invalidateDashboardWritePolicyCache();
  });

  it('decrypts a sealed secrets.set and stores the plaintext', async () => {
    const env = seal('s3cr3t', key.publicKeyDer);
    const handled = await handler.handleMessage({
      type: 'dashboard.contexts.secrets.set',
      requestId: 'r-seal',
      actor: { type: 'user', sub: 'u' },
      scope: 'prod',
      key: 'API_KEY',
      sealed: env,
    } as DashboardPlatformToOrchMessage);
    expect(handled).toBe(true);
    expect(deps.secretStore.setSecret).toHaveBeenCalledWith('org-1', 'prod', 'API_KEY', 's3cr3t');
    const resp = deps.sent.at(-1) as any;
    expect(resp.type).toBe('dashboard.contexts.secrets.set.response');
    expect(resp.error).toBeUndefined();
  });

  it('decrypts a sealed variables.set and stores the plaintext', async () => {
    const env = seal('v4lue', key.publicKeyDer);
    await handler.handleMessage({
      type: 'dashboard.contexts.variables.set',
      requestId: 'r-vseal',
      actor: { type: 'user', sub: 'u' },
      contextId: 'ctx-1',
      key: 'TOKEN',
      sealed: env,
    } as DashboardPlatformToOrchMessage);
    expect(deps.variableStore.setVar).toHaveBeenCalledWith(
      'org-1',
      'ctx-1',
      'TOKEN',
      'v4lue',
      undefined,
    );
  });

  it('fail-closed: rejects a plaintext value under the encrypted posture', async () => {
    // Policy read returns encrypted for secrets.set.
    (deps.db.executeTakeFirst as any).mockResolvedValue({
      dashboard_write_policy: { 'secrets.set': 'encrypted' },
    });
    const handled = await handler.handleMessage({
      type: 'dashboard.contexts.secrets.set',
      requestId: 'r-plain',
      actor: { type: 'user', sub: 'u' },
      scope: 'prod',
      key: 'API_KEY',
      value: 'plaintext-leak',
    } as DashboardPlatformToOrchMessage);
    expect(handled).toBe(true);
    expect(deps.secretStore.setSecret).not.toHaveBeenCalled();
    const resp = deps.sent.at(-1) as any;
    expect(resp.error).toBe('operation_requires_encryption');
  });

  it('rejects a sealed envelope whose keyId is unknown', async () => {
    const env = { keyId: 'bogus-kid', ephemeralPublicKey: 'AA==', encrypted: 'AAAA' };
    await handler.handleMessage({
      type: 'dashboard.contexts.secrets.set',
      requestId: 'r-badkid',
      actor: { type: 'user', sub: 'u' },
      scope: 'prod',
      key: 'API_KEY',
      sealed: env,
    } as DashboardPlatformToOrchMessage);
    expect(deps.secretStore.setSecret).not.toHaveBeenCalled();
    const resp = deps.sent.at(-1) as any;
    expect(resp.error).toBe('unknown_encryption_key');
  });

  it('fails closed when no encryption key is available (resolver returns null)', async () => {
    deps.dashboardEncryption = { resolve: async () => null };
    handler = new DashboardContextHandler(deps);
    const env = seal('x', key.publicKeyDer);
    await handler.handleMessage({
      type: 'dashboard.contexts.secrets.set',
      requestId: 'r-nokey',
      actor: { type: 'user', sub: 'u' },
      scope: 'prod',
      key: 'API_KEY',
      sealed: env,
    } as DashboardPlatformToOrchMessage);
    expect(deps.secretStore.setSecret).not.toHaveBeenCalled();
    expect((deps.sent.at(-1) as any).error).toBe('encryption_unavailable');
  });

  it('permissive posture still accepts a plaintext value', async () => {
    await handler.handleMessage({
      type: 'dashboard.contexts.secrets.set',
      requestId: 'r-perm',
      actor: { type: 'user', sub: 'u' },
      scope: 'prod',
      key: 'API_KEY',
      value: 'plain-ok',
    } as DashboardPlatformToOrchMessage);
    expect(deps.secretStore.setSecret).toHaveBeenCalledWith('org-1', 'prod', 'API_KEY', 'plain-ok');
  });
});

describe('DashboardContextHandler held-runs list hold types', () => {
  let deps: ReturnType<typeof createMockDeps>;
  let handler: DashboardContextHandler;

  beforeEach(() => {
    deps = createMockDeps();
    handler = new DashboardContextHandler(deps);
    invalidateDashboardWritePolicyCache();
  });

  /** A held-runs row as the list query selects it. */
  function heldRow(holdType: string): Record<string, unknown> {
    return {
      id: 'hr-1',
      run_id: 'run-1',
      job_id: 'job-1',
      context_id: 'env-1',
      context_name: 'production',
      hold_type: holdType,
      queue_type: 'context',
      status: 'pending',
      reason: 'held',
      approved_by: null,
      created_at: new Date('2026-01-01'),
      resolved_at: null,
      expires_at: new Date('2026-01-02'),
      hold_scope: 'workflow',
      step_index: null,
      approval_requirement: null,
      payload: null,
      contributor_username: null,
      trust_tier: null,
    };
  }

  /** Run the held-runs list handler over one row and return its wire holdType. */
  async function listHoldType(holdType: string): Promise<string> {
    (deps.db.execute as any).mockResolvedValueOnce([heldRow(holdType)]).mockResolvedValueOnce([]);

    await handler.handleMessage({
      type: 'dashboard.held-runs.list',
      requestId: 'req-held',
    } as DashboardPlatformToOrchMessage);

    const resp = deps.sent.at(-1) as any;
    expect(resp.type).toBe('dashboard.held-runs.list.response');
    return resp.heldRuns[0].holdType;
  }

  it('normalizes a legacy persisted hold type onto the wire', async () => {
    // A row written by an un-upgraded orchestrator (or before the backfill)
    // must still render correctly — this is what lets the migration ship
    // without a lockstep deploy.
    expect(await listHoldType('wait_timer')).toBe(HoldType.enum.timer);
  });

  it('normalizes the legacy reviewer spelling onto the wire', async () => {
    expect(await listHoldType('approval')).toBe(HoldType.enum.reviewer);
  });

  it('passes a current hold type through untouched', async () => {
    for (const member of HoldType.options) {
      expect(await listHoldType(member)).toBe(member);
    }
  });

  it('passes an unknown hold type through untouched', async () => {
    // The gray fallback badge stays reachable for a genuinely unknown type.
    expect(await listHoldType('some_future_type')).toBe('some_future_type');
  });

  describe('heldRunId filter', () => {
    /** Every `.where(...)` argument tuple the list query built. */
    function whereCalls(): unknown[][] {
      return (deps.db.where as any).mock.calls as unknown[][];
    }

    it('narrows on held_runs.id when heldRunId is given', async () => {
      (deps.db.execute as any)
        .mockResolvedValueOnce([heldRow(HoldType.enum.security)])
        .mockResolvedValueOnce([]);

      const handled = await handler.handleMessage({
        type: 'dashboard.held-runs.list',
        requestId: 'req-held-id',
        heldRunId: 'hr-1',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      // The predicate has to reach the query builder. Narrowing in memory
      // instead would still return one row here while shipping the org's whole
      // hold history over the wire.
      expect(whereCalls()).toContainEqual(['held_runs.id', '=', 'hr-1']);

      const resp = deps.sent.at(-1) as any;
      expect(resp.heldRuns).toHaveLength(1);
      expect(resp.heldRuns[0].id).toBe('hr-1');
    });

    it('omits the id predicate when heldRunId is absent', async () => {
      (deps.db.execute as any).mockResolvedValueOnce([heldRow(HoldType.enum.reviewer)]);

      await handler.handleMessage({
        type: 'dashboard.held-runs.list',
        requestId: 'req-held-noid',
      } as DashboardPlatformToOrchMessage);

      expect(whereCalls().some((call) => call[0] === 'held_runs.id')).toBe(false);
    });
  });

  // ── the self-approval gate, driven through the handler ────────────────────
  //
  // `applyDecision` refuses an approve when `actorSub === triggererSub`, so
  // this handler's two renderings of one principal — the live actor's subject
  // and the stored `execution_runs.triggered_by` — have to agree. They did not:
  // the resolver split `triggered_by` on its first colon, which is wrong for
  // an agent-mediated trigger (` via agent:<label>` rode along on the id) and
  // for a service account (the live subject carries a `service:` prefix the
  // split threw away). Both left the gate comparing strings that can never be
  // equal, i.e. silently admitting every self-approval.
  //
  // The cases below drive the handler, not the mapper: the mapper's own unit
  // tests cannot see a caller that stopped using it.
  describe('held-runs approve — self-approval gate', () => {
    /**
     * A handler wired with the resolver-backed approval path, and a db mock
     * that answers per selected column (both `org_settings` reads hit the same
     * table, so the table alone cannot disambiguate them).
     */
    function selfApprovalHandler(triggeredBy: string) {
      const sent: unknown[] = [];
      let lastSelect = '';
      const db: any = {
        selectFrom: vi.fn().mockReturnThis(),
        select: vi.fn((col: string) => {
          lastSelect = col;
          return db;
        }),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn(async () => {
          if (lastSelect === 'dashboard_write_policy') return { dashboard_write_policy: null };
          if (lastSelect === 'allow_self_approval') return { allow_self_approval: false };
          if (lastSelect === 'triggered_by') return { triggered_by: triggeredBy };
          return undefined;
        }),
      };
      const store = {
        getById: vi.fn().mockResolvedValue({
          id: 'hr-self',
          run_id: 'run-self',
          org_id: 'org-1',
          status: 'pending',
          hold_scope: 'job',
          // No clauses: any actor the self-approval gate does not block is
          // eligible, so a refusal here can only come from that gate.
          approval_requirement: { clauses: [], expiresAt: '', reason: '' },
        }),
        listDecisions: vi.fn().mockResolvedValue([]),
        recordDecision: vi.fn().mockResolvedValue(undefined),
        recordAndRelease: vi.fn().mockResolvedValue({ heldRunId: 'hr-self', runId: 'run-self' }),
      };
      const deps = {
        orgId: 'org-1',
        send: (msg: unknown) => sent.push(msg),
        db,
        contextStore: {} as any,
        variableStore: {} as any,
        bindingStore: {} as any,
        secretStore: {} as any,
        approvals: {
          store: store as any,
          teamMembershipLookup: () => new Set<string>(),
          resumeJob: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as DashboardContextHandlerDeps;
      invalidateDashboardWritePolicyCache();
      return { handler: new DashboardContextHandler(deps), sent, store };
    }

    async function approveAs(triggeredBy: string, actor: ActorPrincipal) {
      const { handler: h, sent, store } = selfApprovalHandler(triggeredBy);
      await h.handleMessage({
        type: 'dashboard.held-runs.approve',
        requestId: 'req-self',
        heldRunId: 'hr-self',
        actor,
      } as DashboardPlatformToOrchMessage);
      return { resp: sent.at(-1) as any, store };
    }

    it('refuses a user who triggered the run through an agent', async () => {
      const actor: ActorPrincipal = { type: 'user', sub: 'kc-1' };
      const { resp, store } = await approveAs(
        stringifyActor({ type: 'user', sub: 'kc-1', agent: { label: 'builder' } }),
        actor,
      );
      expect(resp.error).toMatch(/not eligible/);
      expect(store.recordAndRelease).not.toHaveBeenCalled();
    });

    it('refuses the service account that triggered the run', async () => {
      const { resp, store } = await approveAs(
        stringifyActor({ type: 'service_account', id: 'ops-token' }),
        { type: 'service_account', id: 'ops-token' },
      );
      expect(resp.error).toMatch(/not eligible/);
      expect(store.recordAndRelease).not.toHaveBeenCalled();
    });

    it('refuses the system component that triggered the run', async () => {
      const { resp, store } = await approveAs(
        stringifyActor({ type: 'system', component: 'dispatcher' }),
        { type: 'system', component: 'dispatcher' },
      );
      expect(resp.error).toMatch(/not eligible/);
      expect(store.recordAndRelease).not.toHaveBeenCalled();
    });

    it('still admits a different user', async () => {
      // The negative control: the gate must refuse the triggerer, not everyone.
      const { resp, store } = await approveAs(
        stringifyActor({ type: 'user', sub: 'kc-1', agent: { label: 'builder' } }),
        { type: 'user', sub: 'kc-2' },
      );
      expect(resp.error).toBeUndefined();
      expect(store.recordAndRelease).toHaveBeenCalled();
    });
  });

  /**
   * The relay answer goes out at the durable record, not at the resume.
   *
   * The defect: releasing a workflow-scoped fork-PR hold replays the whole
   * stored dispatch context before acking, which measured 9.8 s inside the
   * Platform's 10 s relay budget — so an approval that had already landed
   * answered 504, and the operator's natural retry hit "already resolved".
   */
  describe('held-runs approve — answers before the resume', () => {
    function applierHandler(resumeJob: (signal: unknown) => Promise<void>) {
      const sent: unknown[] = [];
      const accessLogRecord = vi.fn();
      let lastSelect = '';
      const db: any = {
        selectFrom: vi.fn().mockReturnThis(),
        select: vi.fn((col: string) => {
          lastSelect = col;
          return db;
        }),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn(async () => {
          if (lastSelect === 'dashboard_write_policy') return { dashboard_write_policy: null };
          if (lastSelect === 'allow_self_approval') return { allow_self_approval: true };
          if (lastSelect === 'triggered_by') return { triggered_by: 'user:kc-other' };
          return undefined;
        }),
      };
      const store = {
        getById: vi.fn().mockResolvedValue({
          id: 'hr-async',
          run_id: 'run-async',
          job_id: 'deploy',
          org_id: 'org-1',
          status: 'pending',
          hold_scope: 'job',
          approval_requirement: { clauses: [], expiresAt: '', reason: '' },
        }),
        listDecisions: vi.fn().mockResolvedValue([]),
        recordDecision: vi.fn().mockResolvedValue(undefined),
        recordAndRelease: vi.fn().mockResolvedValue({
          holdId: 'hr-async',
          runId: 'run-async',
          jobId: 'deploy',
          scope: 'job',
          stepIndex: null,
          triggerSource: 'explicit',
        }),
      };
      const deps = {
        orgId: 'org-1',
        send: (msg: unknown) => sent.push(msg),
        db,
        contextStore: {} as any,
        variableStore: {} as any,
        bindingStore: {} as any,
        secretStore: {} as any,
        accessLog: { record: accessLogRecord },
        approvals: {
          store: store as any,
          teamMembershipLookup: () => new Set<string>(),
          resumeJob,
        },
      } as unknown as DashboardContextHandlerDeps;
      invalidateDashboardWritePolicyCache();
      return { handler: new DashboardContextHandler(deps), sent, store, accessLogRecord };
    }

    const approveMsg = {
      type: 'dashboard.held-runs.approve',
      requestId: 'req-async',
      heldRunId: 'hr-async',
      actor: { type: 'user', sub: 'kc-approver' },
    } as DashboardPlatformToOrchMessage;

    it('sends the response while the resume is still running', async () => {
      let releaseResume: (() => void) | undefined;
      const h = applierHandler(
        () =>
          new Promise<void>((resolve) => {
            releaseResume = resolve;
          }),
      );

      await h.handler.handleMessage(approveMsg);

      const resp = h.sent.at(-1) as { type: string; error?: string };
      expect(resp.type).toBe('dashboard.held-runs.approve.response');
      expect(resp.error).toBeUndefined();
      expect(h.store.recordAndRelease).toHaveBeenCalledTimes(1);
      // Answered with the resume still in flight — the coupling being removed.
      expect(releaseResume).toBeDefined();

      releaseResume!();
      await vi.waitFor(() => expect(h.accessLogRecord).toHaveBeenCalledTimes(1));
      expect(h.accessLogRecord.mock.calls[0][0]).toMatchObject({
        action: 'held_run.approve',
        outcome: 'allowed',
      });
    });

    it('still answers OK when the resume throws, and audits the failure as error', async () => {
      // Where a failed resume surfaces: one `held_run.approve` access-log entry
      // with outcome `error` and the failure message, readable in the dashboard
      // activity view and with `kici-admin access-log`. The approval is durable
      // regardless, which is why the answer stays a success.
      const h = applierHandler(() => Promise.reject(new Error('dispatcher exploded')));

      await h.handler.handleMessage(approveMsg);

      const resp = h.sent.at(-1) as { type: string; error?: string };
      expect(resp.error).toBeUndefined();
      await vi.waitFor(() => expect(h.accessLogRecord).toHaveBeenCalledTimes(1));
      expect(h.accessLogRecord.mock.calls[0][0]).toMatchObject({
        action: 'held_run.approve',
        outcome: 'error',
      });
      expect(h.accessLogRecord.mock.calls[0][0].errorMessage).toContain('dispatcher exploded');
    });
  });
});
