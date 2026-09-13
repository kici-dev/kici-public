/**
 * Dashboard backends handler for the orchestrator.
 *
 * Responds to dashboard.backends.* WS messages from Platform by calling the
 * backend registry, health checker, and sync manager, then sending typed responses.
 */
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type {
  AccessLogAction,
  AccessLogOutcome,
  AccessLogTargetType,
  ActorPrincipal,
  BackendSyncManager,
  BackendDescriptor,
  AddBackendParams,
  DashboardPlatformToOrchMessage,
  BackendsListRequest,
  BackendGetRequest,
  BackendsSyncAllRequest,
  BackendSyncRequest,
  BackendTestRequest,
} from '@kici-dev/engine';
import type { BackendRegistry } from '../secrets/backend-registry.js';
import type { BackendHealthChecker } from '../secrets/backend-health.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { DashboardWriteOperation } from '@kici-dev/engine/protocol/dashboard-write-operations';
import {
  assertDashboardWriteAllowed,
  buildPolicyDeniedResponse,
  DashboardWritePolicyDisabledError,
} from '../policy/dashboard-write-policy.js';

const logger = createLogger({ prefix: 'dashboard-backends-handler' });

interface DashboardBackendsHandlerDeps {
  /** Send a response message back to Platform over the WS connection. */
  send: (msg: unknown) => void;
  registry: BackendRegistry;
  healthChecker: BackendHealthChecker;
  syncManager?: BackendSyncManager;
  /** Database — required for dashboard-write policy lookups. */
  db: Kysely<Database>;
  /** Access log writer — records one row per read / mutation with actor attribution. */
  accessLog?: AccessLogWriter;
  /** Org ID for access_log rows (null when the orchestrator isn't org-scoped). */
  orgId?: string | null;
  /** Routing key for access_log rows (null when not run-scoped). */
  routingKey?: string | null;
}

/**
 * Convert a BackendDescriptor to a JSON-safe object (dates to ISO strings).
 */
function descriptorToJson(d: BackendDescriptor): Record<string, unknown> {
  return {
    id: d.id,
    name: d.name,
    backendType: d.backendType,
    scopeFilter: d.scopeFilter,
    syncIntervalMs: d.syncIntervalMs,
    enabled: d.enabled,
    healthStatus: d.healthStatus,
    scopeCount: d.scopeCount,
    lastSyncAt: d.lastSyncAt?.toISOString() ?? null,
    lastSyncError: d.lastSyncError,
    lastHealthCheckAt: d.lastHealthCheckAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

/**
 * Handler for all dashboard backend WS messages.
 *
 * Dispatches incoming messages by type and calls the appropriate backend services.
 */
export class DashboardBackendsHandler {
  private readonly deps: DashboardBackendsHandlerDeps;
  private orgId: string | null;
  private routingKey: string | null;
  private readonly accessLog: AccessLogWriter | undefined;

  constructor(deps: DashboardBackendsHandlerDeps) {
    this.deps = deps;
    this.orgId = deps.orgId ?? null;
    this.routingKey = deps.routingKey ?? null;
    this.accessLog = deps.accessLog;
  }

  /**
   * Update the bound orgId + routingKey. Called from server.ts after resolving
   * the single tenant org from the `sources` / `generic_webhook_sources` table.
   */
  setOrgContext(orgId: string | null, routingKey: string | null): void {
    this.orgId = orgId;
    this.routingKey = routingKey;
  }

  /**
   * Defense-in-depth dashboard-write policy gate. Returns true when the
   * operation is allowed and the caller should proceed. Returns false
   * when the policy is disabled — also records a `denied` access_log row
   * and emits a structured `operation_disabled` envelope on the WS.
   *
   * Fails open when no org is bound — the orch hasn't resolved a
   * customer yet, so there's nothing to look up.
   */
  private async enforcePolicy(
    msg: { actor: ActorPrincipal; requestId: string },
    op: DashboardWriteOperation,
    responseType: string,
    action: AccessLogAction,
    target: { type: AccessLogTargetType; id: string } | null,
  ): Promise<boolean> {
    if (!this.orgId) return true;
    try {
      await assertDashboardWriteAllowed(this.deps.db, this.orgId, op);
      return true;
    } catch (err) {
      if (err instanceof DashboardWritePolicyDisabledError) {
        this.recordAccess(
          msg.actor,
          action,
          target,
          msg.requestId,
          'denied',
          `operation_disabled:${err.operation}`,
        );
        this.deps.send(buildPolicyDeniedResponse(op, responseType, msg.requestId));
        return false;
      }
      throw err;
    }
  }

  /**
   * Write an access_log row for a handler invocation. Best-effort; the writer
   * swallows failures.
   */
  private recordAccess(
    actor: ActorPrincipal,
    action: AccessLogAction,
    target: { type: AccessLogTargetType; id: string } | null,
    requestId: string | null,
    outcome: AccessLogOutcome,
    errorMessage?: string | null,
  ): void {
    if (!this.accessLog) return;
    void this.accessLog.record({
      orgId: this.orgId,
      routingKey: this.routingKey,
      actor,
      action,
      target,
      requestId,
      source: 'platform_proxy',
      outcome,
      errorMessage: errorMessage ?? null,
    });
  }

  /**
   * Route a dashboard backends message to the appropriate handler.
   * Returns true if the message was handled, false otherwise.
   */
  async handleMessage(msg: DashboardPlatformToOrchMessage): Promise<boolean> {
    switch (msg.type) {
      case 'dashboard.backends.list':
        await this.handleList(msg);
        return true;
      case 'dashboard.backends.get':
        await this.handleGet(msg);
        return true;
      case 'dashboard.backends.sync':
        await this.handleSyncAll(msg);
        return true;
      case 'dashboard.backends.sync.one':
        await this.handleSyncOne(msg);
        return true;
      case 'dashboard.backends.test':
        await this.handleTest(msg);
        return true;
      default:
        return false;
    }
  }

  private async handleList(msg: BackendsListRequest): Promise<void> {
    try {
      const backends = await this.deps.registry.listBackends();
      this.recordAccess(msg.actor, 'backend.list.read', null, msg.requestId, 'allowed');
      this.deps.send({
        type: 'dashboard.backends.list.response',
        requestId: msg.requestId,
        backends: backends.map(descriptorToJson),
      });
    } catch (err) {
      logger.error('Failed to list backends', { error: toErrorMessage(err) });
      this.recordAccess(
        msg.actor,
        'backend.list.read',
        null,
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.deps.send({
        type: 'dashboard.backends.list.response',
        requestId: msg.requestId,
        error: 'Failed to list backends',
      });
    }
  }

  private async handleGet(msg: BackendGetRequest): Promise<void> {
    try {
      const backend = await this.deps.registry.getBackend(msg.name);
      if (!backend) {
        this.recordAccess(
          msg.actor,
          'backend.get.read',
          { type: 'backend', id: msg.name },
          msg.requestId,
          'allowed',
          'backend not found',
        );
        // Not-found is signalled by the absent `backend` field — `error`
        // is reserved for internal errors (Platform maps it to HTTP 500).
        this.deps.send({
          type: 'dashboard.backends.get.response',
          requestId: msg.requestId,
        });
        return;
      }
      this.recordAccess(
        msg.actor,
        'backend.get.read',
        { type: 'backend', id: msg.name },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.backends.get.response',
        requestId: msg.requestId,
        backend: descriptorToJson(backend),
      });
    } catch (err) {
      logger.error('Failed to get backend', { name: msg.name, error: toErrorMessage(err) });
      this.recordAccess(
        msg.actor,
        'backend.get.read',
        { type: 'backend', id: msg.name },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.deps.send({
        type: 'dashboard.backends.get.response',
        requestId: msg.requestId,
        error: 'Failed to get backend',
      });
    }
  }

  private async handleSyncAll(msg: BackendsSyncAllRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'backends.sync',
        'dashboard.backends.sync.response',
        'backend.sync',
        null,
      ))
    ) {
      return;
    }
    try {
      if (!this.deps.syncManager) {
        this.recordAccess(
          msg.actor,
          'backend.sync',
          null,
          msg.requestId,
          'error',
          'sync manager not available',
        );
        this.deps.send({
          type: 'dashboard.backends.sync.response',
          requestId: msg.requestId,
          error: 'Sync manager not available',
        });
        return;
      }
      const results = await this.deps.syncManager.syncAllBackends();
      this.recordAccess(msg.actor, 'backend.sync', null, msg.requestId, 'allowed');
      this.deps.send({
        type: 'dashboard.backends.sync.response',
        requestId: msg.requestId,
        results,
      });
    } catch (err) {
      logger.error('Failed to sync all backends', { error: toErrorMessage(err) });
      this.recordAccess(
        msg.actor,
        'backend.sync',
        null,
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.deps.send({
        type: 'dashboard.backends.sync.response',
        requestId: msg.requestId,
        error: 'Failed to sync all backends',
      });
    }
  }

  private async handleSyncOne(msg: BackendSyncRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'backends.sync_one',
        'dashboard.backends.sync.one.response',
        'backend.sync.one',
        { type: 'backend', id: msg.name },
      ))
    ) {
      return;
    }
    try {
      if (!this.deps.syncManager) {
        this.recordAccess(
          msg.actor,
          'backend.sync.one',
          { type: 'backend', id: msg.name },
          msg.requestId,
          'error',
          'sync manager not available',
        );
        this.deps.send({
          type: 'dashboard.backends.sync.one.response',
          requestId: msg.requestId,
          error: 'Sync manager not available',
        });
        return;
      }
      const backend = await this.deps.registry.getBackend(msg.name);
      if (!backend) {
        this.recordAccess(
          msg.actor,
          'backend.sync.one',
          { type: 'backend', id: msg.name },
          msg.requestId,
          'allowed',
          'backend not found',
        );
        // Not-found is signalled by `synced: false` alone — the `error`
        // field is the internal-error channel, which the Platform maps to
        // HTTP 500. Omitting it lets the Platform serve a structured 404.
        this.deps.send({
          type: 'dashboard.backends.sync.one.response',
          requestId: msg.requestId,
          synced: false,
        });
        return;
      }
      const result = await this.deps.syncManager.syncBackend(msg.name);
      this.recordAccess(
        msg.actor,
        'backend.sync.one',
        { type: 'backend', id: msg.name },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.backends.sync.one.response',
        requestId: msg.requestId,
        synced: true,
        scopeCount: result.scopeCount,
      });
    } catch (err) {
      logger.error('Failed to sync backend', { name: msg.name, error: toErrorMessage(err) });
      this.recordAccess(
        msg.actor,
        'backend.sync.one',
        { type: 'backend', id: msg.name },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.deps.send({
        type: 'dashboard.backends.sync.one.response',
        requestId: msg.requestId,
        error: `Failed to sync backend: ${toErrorMessage(err)}`,
      });
    }
  }

  private async handleTest(msg: BackendTestRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'backends.test',
        'dashboard.backends.test.response',
        'backend.test',
        { type: 'backend', id: msg.name },
      ))
    ) {
      return;
    }
    try {
      const backend = await this.deps.registry.getBackend(msg.name);
      if (!backend) {
        this.recordAccess(
          msg.actor,
          'backend.test',
          { type: 'backend', id: msg.name },
          msg.requestId,
          'allowed',
          'backend not found',
        );
        this.deps.send({
          type: 'dashboard.backends.test.response',
          requestId: msg.requestId,
          error: 'Backend not found',
        });
        return;
      }
      const config = await this.deps.registry.getBackendConfig(msg.name);
      if (!config) {
        this.recordAccess(
          msg.actor,
          'backend.test',
          { type: 'backend', id: msg.name },
          msg.requestId,
          'error',
          'backend config not found',
        );
        this.deps.send({
          type: 'dashboard.backends.test.response',
          requestId: msg.requestId,
          error: 'Backend config not found',
        });
        return;
      }
      const params: AddBackendParams = {
        name: backend.name,
        backendType: backend.backendType,
        config,
        scopeFilter: backend.scopeFilter,
        syncIntervalMs: backend.syncIntervalMs,
      };
      const result = await this.deps.healthChecker.testConnection(params);
      this.recordAccess(
        msg.actor,
        'backend.test',
        { type: 'backend', id: msg.name },
        msg.requestId,
        result.ok ? 'allowed' : 'error',
        result.error ?? null,
      );
      this.deps.send({
        type: 'dashboard.backends.test.response',
        requestId: msg.requestId,
        ok: result.ok,
        latencyMs: result.latencyMs,
        ...(result.error && { error: result.error }),
      });
    } catch (err) {
      logger.error('Failed to test backend', { name: msg.name, error: toErrorMessage(err) });
      this.recordAccess(
        msg.actor,
        'backend.test',
        { type: 'backend', id: msg.name },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.deps.send({
        type: 'dashboard.backends.test.response',
        requestId: msg.requestId,
        error: `Failed to test backend: ${toErrorMessage(err)}`,
      });
    }
  }
}
