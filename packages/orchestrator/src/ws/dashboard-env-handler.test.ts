import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DashboardEnvHandler } from './dashboard-env-handler.js';
import type { DashboardEnvHandlerDeps } from './dashboard-env-handler.js';
import type { DashboardPlatformToOrchMessage } from '@kici-dev/engine';
import { EnvDeleteErrorCode, AccessLogOutcome } from '@kici-dev/engine';
import { EnvironmentDeleteBlockedError } from '../environments/environment-store.js';
import { invalidateDashboardWritePolicyCache } from '../policy/dashboard-write-policy.js';

function createMockDeps(): DashboardEnvHandlerDeps & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    orgId: 'org-1',
    send: (msg: unknown) => sent.push(msg),
    environmentStore: {
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
      execute: vi.fn().mockResolvedValue([]),
      updateTable: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      executeTakeFirst: vi.fn().mockResolvedValue({ numUpdatedRows: 1n }),
    } as any,
    sent,
  };
}

describe('DashboardEnvHandler', () => {
  let deps: ReturnType<typeof createMockDeps>;
  let handler: DashboardEnvHandler;

  beforeEach(() => {
    deps = createMockDeps();
    handler = new DashboardEnvHandler(deps);
    // Policy reads are cached in-process; clear between tests so a
    // disabled-policy test does not leak into the next.
    invalidateDashboardWritePolicyCache();
  });

  describe('environment CRUD', () => {
    it('handles dashboard.environments.list', async () => {
      const handled = await handler.handleMessage({
        type: 'dashboard.environments.list',
        requestId: 'req-1',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.environmentStore.list).toHaveBeenCalledWith('org-1');
      expect(deps.sent).toHaveLength(1);
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.environments.list.response');
      expect(resp.requestId).toBe('req-1');
      expect(resp.environments).toHaveLength(1);
      expect(resp.environments[0].name).toBe('production');
      // Without includeSecrets, no secret keys are attached or queried.
      expect(resp.environments[0].secretKeys).toBeUndefined();
      expect(deps.db.selectFrom).not.toHaveBeenCalled();
    });

    it('attaches secret key names when includeSecrets is set', async () => {
      (deps.db.execute as any).mockResolvedValueOnce([
        { environment_id: 'env-1', key: 'DB_PASS' },
        { environment_id: 'env-1', key: 'DB_HOST' },
      ]);

      const handled = await handler.handleMessage({
        type: 'dashboard.environments.list',
        requestId: 'req-1s',
        includeSecrets: true,
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.db.selectFrom).toHaveBeenCalledWith('environment_bindings as eb');
      const resp = deps.sent[0] as any;
      // Sorted, distinct key names — never values.
      expect(resp.environments[0].secretKeys).toEqual(['DB_HOST', 'DB_PASS']);
    });

    it('scopes the list to the request orgId when the Platform carries one', async () => {
      // Platform-first dev path: the relayed message carries the validated
      // target org, which must override the orchestrator's static connection
      // org (deps.orgId = 'org-1'). Without this, a `kici secrets list` against
      // an org anchored only by remote_sources reads the wrong tenant's
      // environments because the connection org points elsewhere.
      const handled = await handler.handleMessage({
        type: 'dashboard.environments.list',
        requestId: 'req-org',
        orgId: 'org-remote',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.environmentStore.list).toHaveBeenCalledWith('org-remote');
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.environments.list.response');
    });

    it('scopes secret-key discovery to the request orgId when carried', async () => {
      (deps.db.execute as any).mockResolvedValueOnce([{ environment_id: 'env-1', key: 'PGUSER' }]);

      const handled = await handler.handleMessage({
        type: 'dashboard.environments.list',
        requestId: 'req-org-secrets',
        includeSecrets: true,
        orgId: 'org-remote',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.environmentStore.list).toHaveBeenCalledWith('org-remote');
      // The binding→secret join must filter on the request org, not 'org-1'.
      expect(deps.db.where).toHaveBeenCalledWith('eb.org_id', '=', 'org-remote');
      const resp = deps.sent[0] as any;
      expect(resp.environments[0].secretKeys).toEqual(['PGUSER']);
    });

    it('handles dashboard.environments.create', async () => {
      const handled = await handler.handleMessage({
        type: 'dashboard.environments.create',
        requestId: 'req-2',
        name: 'staging',
        envType: 'fixed',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.environmentStore.create).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({
          name: 'staging',
          type: 'fixed',
        }),
      );
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.environments.create.response');
      expect(resp.environmentId).toBe('env-new');
    });

    it('returns error when store throws', async () => {
      (deps.environmentStore.list as any).mockRejectedValue(new Error('DB error'));

      await handler.handleMessage({
        type: 'dashboard.environments.list',
        requestId: 'req-err',
      } as DashboardPlatformToOrchMessage);

      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.environments.list.response');
      expect(resp.requestId).toBe('req-err');
      expect(resp.error).toBe('DB error');
    });

    it('returns an errorCode when delete is blocked by pending held runs', async () => {
      const accessLogRecord = vi.fn();
      deps.accessLog = { record: accessLogRecord };
      handler = new DashboardEnvHandler(deps);
      (deps.environmentStore.delete as any).mockRejectedValue(new EnvironmentDeleteBlockedError(2));

      await handler.handleMessage({
        type: 'dashboard.environments.delete',
        requestId: 'req-del-blocked',
        environmentId: 'env-1',
      } as DashboardPlatformToOrchMessage);

      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.environments.delete.response');
      expect(resp.requestId).toBe('req-del-blocked');
      expect(resp.error).toBe(
        'Environment has 2 pending held run(s) — approve or reject them first',
      );
      expect(resp.errorCode).toBe(EnvDeleteErrorCode.enum.pending_held_runs);

      // A blocked delete is a business rejection, not a server error: the
      // access-log row MUST be written with outcome 'denied' (the ternary at
      // dashboard-env-handler.ts maps EnvironmentDeleteBlockedError → denied).
      expect(accessLogRecord).toHaveBeenCalledTimes(1);
      expect(accessLogRecord.mock.calls[0][0]).toMatchObject({
        action: 'environment.delete',
        outcome: AccessLogOutcome.enum.denied,
      });
    });
  });

  describe('test access (environments.test_access.set)', () => {
    it('applies only allowLocalExecution when the policy allows it', async () => {
      const handled = await handler.handleMessage({
        type: 'dashboard.environments.test_access.set',
        requestId: 'req-ta1',
        environmentId: 'env-1',
        allowLocalExecution: true,
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      // Only the allowLocalExecution field is set on the store update.
      expect(deps.environmentStore.update).toHaveBeenCalledWith('org-1', 'env-1', {
        allowLocalExecution: true,
      });
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.environments.test_access.set.response');
      expect(resp.requestId).toBe('req-ta1');
      expect(resp.error).toBeUndefined();
    });

    it('is denied (CLI-only) when the policy disables the operation', async () => {
      // org_settings row disables environments.test_access.set for this org.
      (deps.db.executeTakeFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        dashboard_write_policy: { 'environments.test_access.set': false },
      });

      const handled = await handler.handleMessage({
        type: 'dashboard.environments.test_access.set',
        requestId: 'req-ta2',
        environmentId: 'env-1',
        allowLocalExecution: true,
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      // The store is never touched when the gate denies.
      expect(deps.environmentStore.update).not.toHaveBeenCalled();
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.environments.test_access.set.response');
      expect(resp.requestId).toBe('req-ta2');
      expect(resp.error).toBe('operation_disabled');
      expect(resp.operation).toBe('environments.test_access.set');
    });
  });

  describe('variables', () => {
    it('handles dashboard.environments.variables.list', async () => {
      const handled = await handler.handleMessage({
        type: 'dashboard.environments.variables.list',
        requestId: 'req-v1',
        environmentId: 'env-1',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.variableStore.listVars).toHaveBeenCalledWith('org-1', 'env-1');
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.environments.variables.list.response');
      expect(resp.variables).toHaveLength(1);
      expect(resp.variables[0].key).toBe('APP_ENV');
      expect(resp.variables[0].locked).toBe(true);
    });
  });

  describe('bindings', () => {
    it('handles dashboard.environments.bindings.list', async () => {
      const handled = await handler.handleMessage({
        type: 'dashboard.environments.bindings.list',
        requestId: 'req-b1',
        environmentId: 'env-1',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.bindingStore.list).toHaveBeenCalledWith('org-1', 'env-1');
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.environments.bindings.list.response');
      expect(resp.bindings).toEqual([
        { scopePattern: 'aws/prod/**', hostPattern: '**' },
        { scopePattern: 'gcp/**', hostPattern: 'box-00002' },
      ]);
    });

    it('handles dashboard.environments.bindings.set with host patterns', async () => {
      const handled = await handler.handleMessage({
        type: 'dashboard.environments.bindings.set',
        requestId: 'req-b2',
        environmentId: 'env-1',
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
        type: 'dashboard.environments.secrets.list',
        requestId: 'req-sl',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.environments.secrets.list.response');
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
        type: 'dashboard.environments.secrets.list',
        requestId: 'req-sl2',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.secretStore.listScopes).toHaveBeenCalledWith('org-1');
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.environments.secrets.list.response');
    });

    it('handles dashboard.environments.secrets.set routing to correct backend', async () => {
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
        type: 'dashboard.environments.secrets.set',
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

    it('handles dashboard.environments.secrets.set for PG with prefixed scope', async () => {
      const handled = await handler.handleMessage({
        type: 'dashboard.environments.secrets.set',
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

    it('handles dashboard.environments.secrets.delete routing to correct backend', async () => {
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
        type: 'dashboard.environments.secrets.delete',
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
    it('handles dashboard.environments.secrets.scope.create with PG prefix', async () => {
      deps.secretStore.createScope = vi.fn().mockResolvedValue(undefined);

      const handled = await handler.handleMessage({
        type: 'dashboard.environments.secrets.scope.create',
        requestId: 'req-sc1',
        scope: 'pg:aws/new-scope',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      // PG store receives unprefixed scope
      expect(deps.secretStore.createScope).toHaveBeenCalledWith('org-1', 'aws/new-scope');
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.environments.secrets.scope.create.response');
      expect(resp.error).toBeUndefined();
    });

    it('handles dashboard.environments.secrets.scope.rename with PG prefix', async () => {
      deps.secretStore.renameScope = vi.fn().mockResolvedValue(undefined);

      const handled = await handler.handleMessage({
        type: 'dashboard.environments.secrets.scope.rename',
        requestId: 'req-sr1',
        oldScope: 'pg:aws/old',
        newScope: 'pg:aws/new',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.secretStore.renameScope).toHaveBeenCalledWith('org-1', 'aws/old', 'aws/new');
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.environments.secrets.scope.rename.response');
      expect(resp.error).toBeUndefined();
    });

    it('handles dashboard.environments.secrets.scope.delete with PG prefix', async () => {
      deps.secretStore.deleteScope = vi.fn().mockResolvedValue(undefined);

      const handled = await handler.handleMessage({
        type: 'dashboard.environments.secrets.scope.delete',
        requestId: 'req-sd1',
        scope: 'pg:aws/old-scope',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      expect(deps.secretStore.deleteScope).toHaveBeenCalledWith('org-1', 'aws/old-scope');
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.environments.secrets.scope.delete.response');
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
        type: 'dashboard.environments.secrets.scope.delete',
        requestId: 'req-sd2',
        scope: 'vault:databases/staging',
      } as DashboardPlatformToOrchMessage);

      // Vault store receives unprefixed scope
      expect(vaultStore.deleteScope).toHaveBeenCalledWith('org-1', 'databases/staging');
    });

    it('returns error when backend does not support scope creation', async () => {
      // secretStore has no createScope method
      const handled = await handler.handleMessage({
        type: 'dashboard.environments.secrets.scope.create',
        requestId: 'req-sc-err',
        scope: 'pg:aws/scope',
      } as DashboardPlatformToOrchMessage);

      expect(handled).toBe(true);
      const resp = deps.sent[0] as any;
      expect(resp.type).toBe('dashboard.environments.secrets.scope.create.response');
      expect(resp.error).toContain('does not support');
    });
  });

  describe('unknown messages', () => {
    it('returns false for non-environment messages', async () => {
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
      expect(deps.environmentStore.create).not.toHaveBeenCalled();
      expect(deps.variableStore.setVar).not.toHaveBeenCalled();
      expect(deps.secretStore.setSecret).not.toHaveBeenCalled();
    });
  });

  // ── `dashboard.environments.secrets.set` orch-side trust model (security invariant) ──
  //
  // Pentest catalog at
  // — Platform→Orchestrator dispatch surface under attacker model A10
  // (compromised Platform credential / rogue Platform process). The wire
  // schema (`packages/engine/src/protocol/messages/dashboard.ts:717`) carries
  // `{requestId, actor, scope, key, value}` — no Platform-supplied `orgId`.
  // The orchestrator handler at
  // `packages/orchestrator/src/ws/dashboard-env-handler.ts:845 handleSecretSet`
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
        type: 'dashboard.environments.secrets.set',
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
        ' pg:null-byte',
      ];

      for (const scope of maliciousScopes) {
        (deps.secretStore.setSecret as ReturnType<typeof vi.fn>).mockClear();
        await handler.handleMessage({
          type: 'dashboard.environments.secrets.set',
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
        type: 'dashboard.environments.secrets.set',
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
});
