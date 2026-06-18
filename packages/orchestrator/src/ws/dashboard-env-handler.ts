/**
 * Dashboard environment handler for the orchestrator.
 *
 * Responds to dashboard.environments.* and dashboard.held-runs.* WS messages
 * from Platform by calling the appropriate stores (EnvironmentStore, VariableStore,
 * BindingStore, PgSecretStore) and sending typed responses.
 *
 * Each handler:
 * 1. Extracts orgId from the dependency context
 * 2. Calls the appropriate store method
 * 3. Returns a response message with requestId and data (or error)
 */
import { sql, type Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { HeldRunStore, ReleaseSignal } from '../environments/held-runs.js';
import type { TeamMembershipLookup } from '../approvals/approval-resolver.js';
import { applyDecision } from '../approvals/apply-decision.js';
import type {
  AccessLogAction,
  AccessLogOutcome,
  AccessLogTargetType,
  ActorPrincipal,
  DashboardPlatformToOrchMessage,
  EnvListRequest,
  EnvGetRequest,
  EnvCreateRequest,
  EnvUpdateRequest,
  EnvTestAccessSetRequest,
  EnvDeleteRequest,
  EnvVarsListRequest,
  EnvVarSetRequest,
  EnvVarDeleteRequest,
  EnvSourceOverridesListRequest,
  EnvSourceOverrideSetRequest,
  EnvSourceOverrideDeleteRequest,
  EnvBindingsListRequest,
  EnvBindingsSetRequest,
  EnvSecretsListRequest,
  EnvSecretSetRequest,
  EnvSecretDeleteRequest,
  EnvSecretScopeCreateRequest,
  EnvSecretScopeRenameRequest,
  EnvSecretScopeDeleteRequest,
  EnvHistoryRequest,
  HeldRunsListRequest,
  HeldRunApproveRequest,
  HeldRunRejectRequest,
} from '@kici-dev/engine';
import { EnvDeleteErrorCode } from '@kici-dev/engine';
import { EnvironmentDeleteBlockedError } from '../environments/environment-store.js';
import type { EnvironmentStore } from '../environments/environment-store.js';
import type { VariableStore } from '../environments/variable-store.js';
import type { BindingStore } from '../environments/binding-store.js';
import type { Database } from '../db/types.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import type { DashboardWriteOperation } from '@kici-dev/engine/protocol/dashboard-write-operations';
import {
  assertDashboardWriteAllowed,
  buildPolicyDeniedResponse,
  DashboardWritePolicyDisabledError,
} from '../policy/dashboard-write-policy.js';

const logger = createLogger({ prefix: 'dashboard-env-handler' });

/** Secret store interface (subset of PgSecretStore methods used here). */
interface SecretStoreForDashboard {
  listScopes(orgId: string): Promise<string[]>;
  listKeys(orgId: string, scope: string): Promise<string[]>;
  setSecret(orgId: string, scope: string, key: string, value: string): Promise<void>;
  deleteSecret(orgId: string, scope: string, key: string): Promise<void>;
  createScope?(orgId: string, scope: string): Promise<void>;
  renameScope?(orgId: string, oldScope: string, newScope: string): Promise<void>;
  deleteScope?(orgId: string, scope: string): Promise<void>;
}

export interface DashboardEnvHandlerDeps {
  /** Organization ID for all operations. */
  orgId: string;
  /** Send a response message back to Platform over the WS connection. */
  send: (msg: unknown) => void;
  environmentStore: EnvironmentStore;
  variableStore: VariableStore;
  bindingStore: BindingStore;
  secretStore: SecretStoreForDashboard;
  /** Load fresh backend stores from registry (creates new store instances with current credentials). */
  loadBackendStores?: () => Promise<Map<string, SecretStoreForDashboard>>;
  /** Database for held_runs queries. */
  db: Kysely<Database>;
  /** Access log writer — records one row per read / mutation with actor attribution. */
  accessLog?: AccessLogWriter;
  /** Routing key for access_log rows (null when not run-scoped). */
  routingKey?: string | null;
  /**
   * Held-run store + resume hook for the approve/reject flow. When present, the
   * approve/reject handlers route through the shared `applyDecision` applier
   * (eligibility check, real attribution, multi-clause accumulation, and the
   * resume-after-approval re-dispatch). When absent (legacy / tests), the
   * handlers fall back to the direct status flip.
   */
  approvals?: ApprovalHandlerDeps;
}

/** Dependencies enabling the resolver-backed approve/reject + resume path. */
export interface ApprovalHandlerDeps {
  store: HeldRunStore;
  /** Team name → member user ids (Plan-1 trust-policy cache). */
  teamMembershipLookup: TeamMembershipLookup;
  /** Re-dispatch a released job hold (consumes its pending context). */
  resumeJob: (signal: ReleaseSignal) => Promise<void>;
  /** Notify a waiting agent that a step hold released (step scope). */
  resumeStep?: (signal: ReleaseSignal) => Promise<void>;
  /** Notify a waiting agent that a step hold was rejected (step scope). */
  rejectStep?: (heldRunId: string, reason?: string) => Promise<void> | void;
  /** Resume a released workflow install-gate hold (workflow scope). */
  resumeWorkflow?: (signal: ReleaseSignal) => Promise<void>;
  /** Cancel a rejected workflow install-gate hold (workflow scope). */
  rejectWorkflow?: (runId: string) => Promise<void>;
}

/**
 * Handler for all dashboard environment and held run WS messages.
 *
 * Dispatches incoming messages by type and calls the appropriate store.
 */
export class DashboardEnvHandler {
  private readonly deps: DashboardEnvHandlerDeps;
  private routingKey: string | null;
  private readonly accessLog: AccessLogWriter | undefined;

  constructor(deps: DashboardEnvHandlerDeps) {
    this.deps = deps;
    this.routingKey = deps.routingKey ?? null;
    this.accessLog = deps.accessLog;
  }

  /** Update the orgId used for all operations (called when resolved from DB). */
  setOrgId(orgId: string): void {
    this.deps.orgId = orgId;
  }

  /** Update the routing key bound to access_log rows. */
  setRoutingKey(routingKey: string | null): void {
    this.routingKey = routingKey;
  }

  /**
   * Defense-in-depth dashboard-write policy gate. Returns true when the
   * operation is allowed and the caller should proceed. Returns false when
   * the policy is disabled — also records a `denied` access_log row and
   * sends a structured `operation_disabled` envelope back to Platform.
   */
  private async enforcePolicy(
    msg: { actor: ActorPrincipal; requestId: string },
    op: DashboardWriteOperation,
    responseType: string,
    action: AccessLogAction,
    target: { type: AccessLogTargetType; id: string } | null,
  ): Promise<boolean> {
    try {
      await assertDashboardWriteAllowed(this.deps.db, this.deps.orgId, op);
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
   * Write an access_log row for a handler invocation. Uses the handler's
   * bound orgId + routingKey, the msg.actor principal, and the handler-
   * specified action + target. Best-effort; the writer swallows failures.
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
      orgId: this.deps.orgId,
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
   * Route a dashboard message to the appropriate handler.
   * Returns true if the message was handled, false otherwise.
   */
  async handleMessage(msg: DashboardPlatformToOrchMessage): Promise<boolean> {
    switch (msg.type) {
      // Environment CRUD
      case 'dashboard.environments.list':
        await this.handleEnvList(msg);
        return true;
      case 'dashboard.environments.get':
        await this.handleEnvGet(msg);
        return true;
      case 'dashboard.environments.create':
        await this.handleEnvCreate(msg);
        return true;
      case 'dashboard.environments.update':
        await this.handleEnvUpdate(msg);
        return true;
      case 'dashboard.environments.test_access.set':
        await this.handleTestAccessSet(msg);
        return true;
      case 'dashboard.environments.delete':
        await this.handleEnvDelete(msg);
        return true;

      // Variables
      case 'dashboard.environments.variables.list':
        await this.handleVarsList(msg);
        return true;
      case 'dashboard.environments.variables.set':
        await this.handleVarSet(msg);
        return true;
      case 'dashboard.environments.variables.delete':
        await this.handleVarDelete(msg);
        return true;

      // Source overrides
      case 'dashboard.environments.source-overrides.list':
        await this.handleSourceOverridesList(msg);
        return true;
      case 'dashboard.environments.source-overrides.set':
        await this.handleSourceOverrideSet(msg);
        return true;
      case 'dashboard.environments.source-overrides.delete':
        await this.handleSourceOverrideDelete(msg);
        return true;

      // Bindings
      case 'dashboard.environments.bindings.list':
        await this.handleBindingsList(msg);
        return true;
      case 'dashboard.environments.bindings.set':
        await this.handleBindingsSet(msg);
        return true;

      // Secrets
      case 'dashboard.environments.secrets.list':
        await this.handleSecretsList(msg);
        return true;
      case 'dashboard.environments.secrets.set':
        await this.handleSecretSet(msg);
        return true;
      case 'dashboard.environments.secrets.delete':
        await this.handleSecretDelete(msg);
        return true;

      // Scope CRUD
      case 'dashboard.environments.secrets.scope.create':
        await this.handleScopeCreate(msg);
        return true;
      case 'dashboard.environments.secrets.scope.rename':
        await this.handleScopeRename(msg);
        return true;
      case 'dashboard.environments.secrets.scope.delete':
        await this.handleScopeDelete(msg);
        return true;

      // Environment history
      case 'dashboard.environments.history':
        await this.handleEnvHistory(msg);
        return true;

      // Held runs
      case 'dashboard.held-runs.list':
        await this.handleHeldRunsList(msg);
        return true;
      case 'dashboard.held-runs.approve':
        await this.handleHeldRunApprove(msg);
        return true;
      case 'dashboard.held-runs.reject':
        await this.handleHeldRunReject(msg);
        return true;

      default:
        return false;
    }
  }

  // ── Environment CRUD ──────────────────────────────────────────────

  private async handleEnvList(msg: EnvListRequest): Promise<void> {
    // Scope to the request's target org when the Platform carries one
    // (Platform-first dev path), falling back to the connection-level org for
    // the legacy customer-dashboard path. The orchestrator's DB only holds its
    // own tenant's rows, so honoring the requested org returns that org's data
    // or an empty list — never another tenant's secrets.
    const orgId = msg.orgId ?? this.deps.orgId;
    try {
      const envs = await this.deps.environmentStore.list(orgId);
      const secretKeysByEnv = msg.includeSecrets
        ? await this.loadSecretKeysByEnv(
            orgId,
            envs.map((e) => e.id),
          )
        : undefined;
      this.recordAccess(
        msg.actor,
        'environment.list.read',
        { type: 'environment', id: orgId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.environments.list.response',
        requestId: msg.requestId,
        environments: envs.map((e) => ({
          id: e.id,
          name: e.name,
          type: e.type,
          globPattern: e.glob_pattern,
          enabled: e.enabled,
          allowLocalExecution: e.allow_local_execution,
          createdAt:
            e.created_at instanceof Date ? e.created_at.toISOString() : String(e.created_at),
          updatedAt:
            e.updated_at instanceof Date ? e.updated_at.toISOString() : String(e.updated_at),
          ...(secretKeysByEnv && { secretKeys: secretKeysByEnv.get(e.id) ?? [] }),
        })),
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'environment.list.read',
        { type: 'environment', id: orgId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.environments.list.response', msg.requestId, err);
    }
  }

  /**
   * Map each environment id to the distinct secret key names reachable through
   * its scope bindings. Joins `environment_bindings` → `scoped_secrets` on the
   * scope pattern, excluding the `__empty__` sentinel. Returns key names only —
   * never values. Scoped to the caller-resolved org (the request's target org,
   * or the connection-level org on the legacy path).
   */
  private async loadSecretKeysByEnv(
    orgId: string,
    envIds: string[],
  ): Promise<Map<string, string[]>> {
    const byEnv = new Map<string, string[]>();
    if (envIds.length === 0) return byEnv;

    const rows = await this.deps.db
      .selectFrom('environment_bindings as eb')
      .innerJoin('scoped_secrets as ss', (join) =>
        join.onRef('ss.scope', '=', 'eb.scope_pattern').onRef('ss.org_id', '=', 'eb.org_id'),
      )
      .select(['eb.environment_id as environment_id', 'ss.key as key'])
      .where('eb.org_id', '=', orgId)
      .where('eb.environment_id', 'in', envIds)
      .where('ss.key', '!=', '__empty__')
      .distinct()
      .execute();

    const sets = new Map<string, Set<string>>();
    for (const r of rows as Array<{ environment_id: string; key: string }>) {
      let s = sets.get(r.environment_id);
      if (!s) {
        s = new Set();
        sets.set(r.environment_id, s);
      }
      s.add(r.key);
    }
    for (const [envId, keys] of sets) byEnv.set(envId, Array.from(keys).sort());
    return byEnv;
  }

  private async handleEnvGet(msg: EnvGetRequest): Promise<void> {
    try {
      const env = await this.deps.environmentStore.get(this.deps.orgId, msg.environmentId);
      if (!env) {
        this.recordAccess(
          msg.actor,
          'environment.get.read',
          { type: 'environment', id: msg.environmentId },
          msg.requestId,
          'allowed',
          'environment not found',
        );
        this.deps.send({
          type: 'dashboard.environments.get.response',
          requestId: msg.requestId,
          error: 'Environment not found',
        });
        return;
      }
      this.recordAccess(
        msg.actor,
        'environment.get.read',
        { type: 'environment', id: msg.environmentId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.environments.get.response',
        requestId: msg.requestId,
        environment: {
          id: env.id,
          name: env.name,
          type: env.type,
          globPattern: env.glob_pattern,
          branchRestrictions: env.branch_restrictions ?? null,
          concurrencyLimit: env.concurrency_limit,
          concurrencyStrategy: env.concurrency_strategy as 'queue' | 'cancel-pending' | null,
          requiredReviewers: env.required_reviewers != null ? Number(env.required_reviewers) : null,
          waitTimerSeconds: env.wait_timer_seconds,
          holdExpirySeconds: env.hold_expiry_seconds ?? null,
          enabled: env.enabled,
          allowLocalExecution: env.allow_local_execution,
          createdAt:
            env.created_at instanceof Date ? env.created_at.toISOString() : String(env.created_at),
          updatedAt:
            env.updated_at instanceof Date ? env.updated_at.toISOString() : String(env.updated_at),
        },
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'environment.get.read',
        { type: 'environment', id: msg.environmentId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.environments.get.response', msg.requestId, err);
    }
  }

  private async handleEnvCreate(msg: EnvCreateRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'environments.create',
        'dashboard.environments.create.response',
        'environment.create',
        { type: 'environment', id: msg.name },
      ))
    ) {
      return;
    }
    try {
      const env = await this.deps.environmentStore.create(this.deps.orgId, {
        name: msg.name,
        type: msg.envType,
        globPattern: msg.globPattern,
        branchRestrictions: msg.branchRestrictions,
        concurrencyLimit: msg.concurrencyLimit,
        concurrencyStrategy: msg.concurrencyStrategy,
        requiredReviewers:
          msg.requiredReviewers != null ? [String(msg.requiredReviewers)] : undefined,
        waitTimerSeconds: msg.waitTimerSeconds,
        holdExpirySeconds: msg.holdExpirySeconds,
        enabled: msg.enabled,
      });
      this.recordAccess(
        msg.actor,
        'environment.create',
        { type: 'environment', id: env.id },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.environments.create.response',
        requestId: msg.requestId,
        environmentId: env.id,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'environment.create',
        { type: 'environment', id: msg.name },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.environments.create.response', msg.requestId, err);
    }
  }

  private async handleEnvUpdate(msg: EnvUpdateRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'environments.update',
        'dashboard.environments.update.response',
        'environment.update',
        { type: 'environment', id: msg.environmentId },
      ))
    ) {
      return;
    }
    try {
      const u = msg.updates;
      const env = await this.deps.environmentStore.update(this.deps.orgId, msg.environmentId, {
        name: u.name,
        type: u.envType,
        globPattern: u.globPattern,
        branchRestrictions: u.branchRestrictions ?? undefined,
        concurrencyLimit: u.concurrencyLimit,
        concurrencyStrategy: u.concurrencyStrategy ?? undefined,
        requiredReviewers: u.requiredReviewers != null ? [String(u.requiredReviewers)] : undefined,
        waitTimerSeconds: u.waitTimerSeconds,
        holdExpirySeconds: u.holdExpirySeconds ?? undefined,
        enabled: u.enabled,
      });
      if (!env) {
        this.recordAccess(
          msg.actor,
          'environment.update',
          { type: 'environment', id: msg.environmentId },
          msg.requestId,
          'allowed',
          'environment not found',
        );
        this.deps.send({
          type: 'dashboard.environments.update.response',
          requestId: msg.requestId,
          error: 'Environment not found',
        });
        return;
      }
      this.recordAccess(
        msg.actor,
        'environment.update',
        { type: 'environment', id: msg.environmentId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.environments.update.response',
        requestId: msg.requestId,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'environment.update',
        { type: 'environment', id: msg.environmentId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.environments.update.response', msg.requestId, err);
    }
  }

  private async handleTestAccessSet(msg: EnvTestAccessSetRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'environments.test_access.set',
        'dashboard.environments.test_access.set.response',
        'environment.update',
        { type: 'environment', id: msg.environmentId },
      ))
    ) {
      return;
    }
    try {
      const env = await this.deps.environmentStore.update(this.deps.orgId, msg.environmentId, {
        allowLocalExecution: msg.allowLocalExecution,
      });
      if (!env) {
        this.recordAccess(
          msg.actor,
          'environment.update',
          { type: 'environment', id: msg.environmentId },
          msg.requestId,
          'allowed',
          'environment not found',
        );
        this.deps.send({
          type: 'dashboard.environments.test_access.set.response',
          requestId: msg.requestId,
          error: 'Environment not found',
        });
        return;
      }
      this.recordAccess(
        msg.actor,
        'environment.update',
        { type: 'environment', id: msg.environmentId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.environments.test_access.set.response',
        requestId: msg.requestId,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'environment.update',
        { type: 'environment', id: msg.environmentId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.environments.test_access.set.response', msg.requestId, err);
    }
  }

  private async handleEnvDelete(msg: EnvDeleteRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'environments.delete',
        'dashboard.environments.delete.response',
        'environment.delete',
        { type: 'environment', id: msg.environmentId },
      ))
    ) {
      return;
    }
    try {
      const deleted = await this.deps.environmentStore.delete(this.deps.orgId, msg.environmentId);
      if (!deleted) {
        this.recordAccess(
          msg.actor,
          'environment.delete',
          { type: 'environment', id: msg.environmentId },
          msg.requestId,
          'allowed',
          'environment not found',
        );
        this.deps.send({
          type: 'dashboard.environments.delete.response',
          requestId: msg.requestId,
          error: 'Environment not found',
        });
        return;
      }
      this.recordAccess(
        msg.actor,
        'environment.delete',
        { type: 'environment', id: msg.environmentId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.environments.delete.response',
        requestId: msg.requestId,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'environment.delete',
        { type: 'environment', id: msg.environmentId },
        msg.requestId,
        err instanceof EnvironmentDeleteBlockedError ? 'denied' : 'error',
        toErrorMessage(err),
      );
      if (err instanceof EnvironmentDeleteBlockedError) {
        this.deps.send({
          type: 'dashboard.environments.delete.response',
          requestId: msg.requestId,
          error: err.message,
          errorCode: EnvDeleteErrorCode.enum.pending_held_runs,
        });
        return;
      }
      this.sendError('dashboard.environments.delete.response', msg.requestId, err);
    }
  }

  // ── Variables ─────────────────────────────────────────────────────

  private async handleVarsList(msg: EnvVarsListRequest): Promise<void> {
    try {
      const vars = await this.deps.variableStore.listVars(this.deps.orgId, msg.environmentId);
      this.recordAccess(
        msg.actor,
        'env_var.list.read',
        { type: 'environment', id: msg.environmentId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.environments.variables.list.response',
        requestId: msg.requestId,
        variables: vars.map((v) => ({
          key: v.key,
          value: v.value,
          locked: v.locked,
        })),
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'env_var.list.read',
        { type: 'environment', id: msg.environmentId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.environments.variables.list.response', msg.requestId, err);
    }
  }

  private async handleVarSet(msg: EnvVarSetRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'variables.set',
        'dashboard.environments.variables.set.response',
        'env_var.set',
        { type: 'environment', id: `${msg.environmentId}:${msg.key}` },
      ))
    ) {
      return;
    }
    try {
      await this.deps.variableStore.setVar(
        this.deps.orgId,
        msg.environmentId,
        msg.key,
        msg.value,
        msg.locked,
      );
      this.recordAccess(
        msg.actor,
        'env_var.set',
        { type: 'environment', id: `${msg.environmentId}:${msg.key}` },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.environments.variables.set.response',
        requestId: msg.requestId,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'env_var.set',
        { type: 'environment', id: `${msg.environmentId}:${msg.key}` },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.environments.variables.set.response', msg.requestId, err);
    }
  }

  private async handleVarDelete(msg: EnvVarDeleteRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'variables.delete',
        'dashboard.environments.variables.delete.response',
        'env_var.delete',
        { type: 'environment', id: `${msg.environmentId}:${msg.key}` },
      ))
    ) {
      return;
    }
    try {
      await this.deps.variableStore.deleteVar(this.deps.orgId, msg.environmentId, msg.key);
      this.recordAccess(
        msg.actor,
        'env_var.delete',
        { type: 'environment', id: `${msg.environmentId}:${msg.key}` },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.environments.variables.delete.response',
        requestId: msg.requestId,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'env_var.delete',
        { type: 'environment', id: `${msg.environmentId}:${msg.key}` },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.environments.variables.delete.response', msg.requestId, err);
    }
  }

  // ── Source overrides ──────────────────────────────────────────────

  private async handleSourceOverridesList(msg: EnvSourceOverridesListRequest): Promise<void> {
    try {
      const overrides = await this.deps.variableStore.listSourceOverrides(
        this.deps.orgId,
        msg.environmentId,
        msg.routingKey,
      );
      this.recordAccess(
        msg.actor,
        'source_override.list.read',
        { type: 'environment', id: `${msg.environmentId}:${msg.routingKey}` },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.environments.source-overrides.list.response',
        requestId: msg.requestId,
        overrides: overrides.map((o) => ({
          key: o.key,
          value: o.value,
        })),
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'source_override.list.read',
        { type: 'environment', id: `${msg.environmentId}:${msg.routingKey}` },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.environments.source-overrides.list.response', msg.requestId, err);
    }
  }

  private async handleSourceOverrideSet(msg: EnvSourceOverrideSetRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'environments.source_overrides.set',
        'dashboard.environments.source-overrides.set.response',
        'source_override.set',
        { type: 'environment', id: `${msg.environmentId}:${msg.routingKey}:${msg.key}` },
      ))
    ) {
      return;
    }
    try {
      await this.deps.variableStore.setSourceOverride(
        this.deps.orgId,
        msg.environmentId,
        msg.routingKey,
        msg.key,
        msg.value,
      );
      this.recordAccess(
        msg.actor,
        'source_override.set',
        { type: 'environment', id: `${msg.environmentId}:${msg.routingKey}:${msg.key}` },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.environments.source-overrides.set.response',
        requestId: msg.requestId,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'source_override.set',
        { type: 'environment', id: `${msg.environmentId}:${msg.routingKey}:${msg.key}` },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.environments.source-overrides.set.response', msg.requestId, err);
    }
  }

  private async handleSourceOverrideDelete(msg: EnvSourceOverrideDeleteRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'environments.source_overrides.delete',
        'dashboard.environments.source-overrides.delete.response',
        'source_override.delete',
        { type: 'environment', id: `${msg.environmentId}:${msg.routingKey}:${msg.key}` },
      ))
    ) {
      return;
    }
    try {
      await this.deps.variableStore.deleteSourceOverride(
        this.deps.orgId,
        msg.environmentId,
        msg.routingKey,
        msg.key,
      );
      this.recordAccess(
        msg.actor,
        'source_override.delete',
        { type: 'environment', id: `${msg.environmentId}:${msg.routingKey}:${msg.key}` },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.environments.source-overrides.delete.response',
        requestId: msg.requestId,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'source_override.delete',
        { type: 'environment', id: `${msg.environmentId}:${msg.routingKey}:${msg.key}` },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.environments.source-overrides.delete.response', msg.requestId, err);
    }
  }

  // ── Bindings ──────────────────────────────────────────────────────

  private async handleBindingsList(msg: EnvBindingsListRequest): Promise<void> {
    try {
      const bindings = await this.deps.bindingStore.list(this.deps.orgId, msg.environmentId);
      this.recordAccess(
        msg.actor,
        'env_binding.list.read',
        { type: 'environment', id: msg.environmentId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.environments.bindings.list.response',
        requestId: msg.requestId,
        scopePatterns: bindings.map((b) => b.scope_pattern),
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'env_binding.list.read',
        { type: 'environment', id: msg.environmentId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.environments.bindings.list.response', msg.requestId, err);
    }
  }

  private async handleBindingsSet(msg: EnvBindingsSetRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'environments.bindings.set',
        'dashboard.environments.bindings.set.response',
        'env_binding.set',
        { type: 'environment', id: msg.environmentId },
      ))
    ) {
      return;
    }
    try {
      await this.deps.bindingStore.set(this.deps.orgId, msg.environmentId, msg.scopePatterns);
      this.recordAccess(
        msg.actor,
        'env_binding.set',
        { type: 'environment', id: msg.environmentId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.environments.bindings.set.response',
        requestId: msg.requestId,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'env_binding.set',
        { type: 'environment', id: msg.environmentId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.environments.bindings.set.response', msg.requestId, err);
    }
  }

  // ── Secrets ───────────────────────────────────────────────────────

  /** Load fresh backend stores, falling back to single secretStore wrapped in a Map. */
  private async getBackendStores(): Promise<Map<string, SecretStoreForDashboard>> {
    if (this.deps.loadBackendStores) {
      return this.deps.loadBackendStores();
    }
    return new Map([['pg', this.deps.secretStore]]);
  }

  /**
   * Resolve the correct backend store for a prefixed scope (e.g., 'vault:aws/prod').
   * Returns the store and the scope to pass to it.
   * All stores expect unprefixed scopes — the backend prefix is stripped.
   */
  private async resolveStoreForScope(prefixedScope: string): Promise<{
    store: SecretStoreForDashboard;
    scope: string;
  }> {
    const colonIdx = prefixedScope.indexOf(':');
    const stores = await this.getBackendStores();

    if (colonIdx >= 0) {
      const backendName = prefixedScope.slice(0, colonIdx);
      const store = stores.get(backendName);
      if (store) {
        return { store, scope: prefixedScope.slice(colonIdx + 1) };
      }
    }

    // Fallback: use the default secretStore with scope as-is
    return { store: this.deps.secretStore, scope: prefixedScope };
  }

  private async handleSecretsList(msg: EnvSecretsListRequest): Promise<void> {
    try {
      const orgId = this.deps.orgId;
      const stores = await this.getBackendStores();
      const secrets: Array<{
        scope: string;
        key: string;
        createdAt: string;
        updatedAt: string;
      }> = [];

      for (const [backendName, store] of stores) {
        let scopes: string[];
        try {
          scopes = await store.listScopes(orgId);
        } catch (err) {
          logger.warn('Failed to list scopes from backend, skipping', {
            backend: backendName,
            error: toErrorMessage(err),
          });
          continue;
        }

        for (const scope of scopes) {
          // Filter internal scopes — strip backend prefix before checking
          const colonIdx = scope.indexOf(':');
          const path = colonIdx >= 0 ? scope.slice(colonIdx + 1) : scope;
          if (path.startsWith('__')) continue;

          // PG scopes are stored unprefixed in the DB.
          // External backends also return raw scopes.
          // Always prefix with backend name for the frontend.
          const prefixedScope = scope.startsWith(`${backendName}:`)
            ? scope
            : `${backendName}:${scope}`;

          let keys: string[];
          try {
            keys = await store.listKeys(orgId, scope);
          } catch (err) {
            logger.warn('Failed to list keys from backend scope, skipping', {
              backend: backendName,
              scope,
              error: toErrorMessage(err),
            });
            continue;
          }

          if (keys.length === 0) {
            // Include empty scopes so the frontend shows the scope tree
            // (e.g., Vault directory scopes that contain sub-scopes but no direct keys)
            secrets.push({ scope: prefixedScope, key: '', createdAt: '', updatedAt: '' });
          } else {
            for (const key of keys) {
              secrets.push({ scope: prefixedScope, key, createdAt: '', updatedAt: '' });
            }
          }
        }
      }

      // Sort by scope then key for consistent ordering
      secrets.sort((a, b) => a.scope.localeCompare(b.scope) || a.key.localeCompare(b.key));

      this.recordAccess(
        msg.actor,
        'secret.list.read',
        { type: 'secret_scope', id: this.deps.orgId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.environments.secrets.list.response',
        requestId: msg.requestId,
        secrets,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'secret.list.read',
        { type: 'secret_scope', id: this.deps.orgId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.environments.secrets.list.response', msg.requestId, err);
    }
  }

  private async handleSecretSet(msg: EnvSecretSetRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'secrets.set',
        'dashboard.environments.secrets.set.response',
        'secret.set',
        { type: 'secret_scope', id: `${msg.scope}:${msg.key}` },
      ))
    ) {
      return;
    }
    try {
      const { store, scope } = await this.resolveStoreForScope(msg.scope);
      await store.setSecret(this.deps.orgId, scope, msg.key, msg.value);
      this.recordAccess(
        msg.actor,
        'secret.set',
        { type: 'secret_scope', id: `${msg.scope}:${msg.key}` },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.environments.secrets.set.response',
        requestId: msg.requestId,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'secret.set',
        { type: 'secret_scope', id: `${msg.scope}:${msg.key}` },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.environments.secrets.set.response', msg.requestId, err);
    }
  }

  private async handleSecretDelete(msg: EnvSecretDeleteRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'secrets.delete',
        'dashboard.environments.secrets.delete.response',
        'secret.delete',
        { type: 'secret_scope', id: `${msg.scope}:${msg.key}` },
      ))
    ) {
      return;
    }
    try {
      const { store, scope } = await this.resolveStoreForScope(msg.scope);
      await store.deleteSecret(this.deps.orgId, scope, msg.key);
      this.recordAccess(
        msg.actor,
        'secret.delete',
        { type: 'secret_scope', id: `${msg.scope}:${msg.key}` },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.environments.secrets.delete.response',
        requestId: msg.requestId,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'secret.delete',
        { type: 'secret_scope', id: `${msg.scope}:${msg.key}` },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.environments.secrets.delete.response', msg.requestId, err);
    }
  }

  // ── Scope CRUD ──────────────────────────────────────────────────

  private async handleScopeCreate(msg: EnvSecretScopeCreateRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'secrets.scope.create',
        'dashboard.environments.secrets.scope.create.response',
        'secret_scope.create',
        { type: 'secret_scope', id: msg.scope },
      ))
    ) {
      return;
    }
    try {
      const { store, scope } = await this.resolveStoreForScope(msg.scope);
      if (!store.createScope) {
        throw new Error('Backend does not support scope creation');
      }
      await store.createScope(this.deps.orgId, scope);
      this.recordAccess(
        msg.actor,
        'secret_scope.create',
        { type: 'secret_scope', id: msg.scope },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.environments.secrets.scope.create.response' as const,
        requestId: msg.requestId,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'secret_scope.create',
        { type: 'secret_scope', id: msg.scope },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.environments.secrets.scope.create.response', msg.requestId, err);
    }
  }

  private async handleScopeRename(msg: EnvSecretScopeRenameRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'secrets.scope.rename',
        'dashboard.environments.secrets.scope.rename.response',
        'secret_scope.rename',
        { type: 'secret_scope', id: `${msg.oldScope}->${msg.newScope}` },
      ))
    ) {
      return;
    }
    try {
      const { store, scope: oldScope } = await this.resolveStoreForScope(msg.oldScope);
      if (!store.renameScope) {
        throw new Error('Backend does not support scope rename');
      }
      const { scope: newScope } = await this.resolveStoreForScope(msg.newScope);
      await store.renameScope(this.deps.orgId, oldScope, newScope);
      this.recordAccess(
        msg.actor,
        'secret_scope.rename',
        { type: 'secret_scope', id: `${msg.oldScope}->${msg.newScope}` },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.environments.secrets.scope.rename.response' as const,
        requestId: msg.requestId,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'secret_scope.rename',
        { type: 'secret_scope', id: `${msg.oldScope}->${msg.newScope}` },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.environments.secrets.scope.rename.response', msg.requestId, err);
    }
  }

  private async handleScopeDelete(msg: EnvSecretScopeDeleteRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'secrets.scope.delete',
        'dashboard.environments.secrets.scope.delete.response',
        'secret_scope.delete',
        { type: 'secret_scope', id: msg.scope },
      ))
    ) {
      return;
    }
    try {
      const { store, scope } = await this.resolveStoreForScope(msg.scope);
      if (!store.deleteScope) {
        throw new Error('Backend does not support scope deletion');
      }
      await store.deleteScope(this.deps.orgId, scope);
      this.recordAccess(
        msg.actor,
        'secret_scope.delete',
        { type: 'secret_scope', id: msg.scope },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.environments.secrets.scope.delete.response' as const,
        requestId: msg.requestId,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'secret_scope.delete',
        { type: 'secret_scope', id: msg.scope },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.environments.secrets.scope.delete.response', msg.requestId, err);
    }
  }

  // ── Environment history ──────────────────────────────────────────

  private async handleEnvHistory(msg: EnvHistoryRequest): Promise<void> {
    try {
      const limit = msg.limit ?? 20;
      const offset = msg.offset ?? 0;

      const runs = await this.deps.db
        .selectFrom('execution_runs')
        .select([
          'id',
          'run_id',
          'workflow_name',
          'status',
          'ref',
          'sha',
          'started_at',
          'completed_at',
          'environment',
        ])
        .where('environment', '=', msg.environmentName)
        .orderBy('started_at', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();

      this.recordAccess(
        msg.actor,
        'environment.history.read',
        { type: 'environment', id: msg.environmentName },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.environments.history.response',
        requestId: msg.requestId,
        runs: runs.map((r) => ({
          id: r.id,
          runId: r.run_id,
          workflowName: r.workflow_name,
          status: r.status,
          branch: r.ref ?? null,
          commitSha: r.sha ?? null,
          startedAt:
            r.started_at instanceof Date
              ? r.started_at.toISOString()
              : String(r.started_at ?? null),
          completedAt: r.completed_at
            ? r.completed_at instanceof Date
              ? r.completed_at.toISOString()
              : String(r.completed_at)
            : null,
          environment: r.environment,
        })),
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'environment.history.read',
        { type: 'environment', id: msg.environmentName },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.environments.history.response', msg.requestId, err);
    }
  }

  // ── Held runs ─────────────────────────────────────────────────────

  private async handleHeldRunsList(msg: HeldRunsListRequest): Promise<void> {
    try {
      let query = this.deps.db
        .selectFrom('held_runs')
        .leftJoin('environments', 'environments.id', 'held_runs.environment_id')
        .leftJoin('execution_runs', 'execution_runs.run_id', 'held_runs.run_id')
        .select([
          'held_runs.id',
          'held_runs.run_id',
          'held_runs.job_id',
          'held_runs.environment_id',
          'environments.name as environment_name',
          'held_runs.hold_type',
          'held_runs.queue_type',
          'held_runs.status',
          'held_runs.reason',
          'held_runs.approved_by',
          'held_runs.created_at',
          'held_runs.resolved_at',
          'held_runs.expires_at',
          'held_runs.hold_scope',
          'held_runs.step_index',
          'held_runs.approval_requirement',
          'execution_runs.contributor_username',
          'execution_runs.trust_tier',
        ])
        .where('held_runs.org_id', '=', this.deps.orgId)
        .orderBy('held_runs.created_at', 'desc');

      if (msg.status) {
        query = query.where('held_runs.status', '=', msg.status);
      }
      if (msg.queueType) {
        query = query.where('held_runs.queue_type', '=', msg.queueType);
      }
      if (msg.runId) {
        query = query.where('held_runs.run_id', '=', msg.runId);
      }

      const rows = await query.execute();

      // Fetch per-hold decisions for multi-clause progress + attribution.
      const holdIds = rows.map((r) => r.id);
      const decisionRows =
        holdIds.length > 0
          ? await this.deps.db
              .selectFrom('held_run_approvals')
              .select([
                'held_run_id',
                'approver_user_id',
                'decision',
                'clauses_satisfied',
                'created_at',
              ])
              .where('held_run_id', 'in', holdIds)
              .orderBy('created_at', 'asc')
              .execute()
          : [];
      const decisionsByHold = new Map<string, typeof decisionRows>();
      for (const d of decisionRows) {
        const list = decisionsByHold.get(d.held_run_id) ?? [];
        list.push(d);
        decisionsByHold.set(d.held_run_id, list);
      }

      this.recordAccess(
        msg.actor,
        'held_run.list.read',
        { type: 'held_run', id: this.deps.orgId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.held-runs.list.response',
        requestId: msg.requestId,
        heldRuns: rows.map((r) => ({
          id: r.id,
          runId: r.run_id,
          environmentId: r.environment_id,
          environmentName: r.environment_name,
          holdType: r.hold_type,
          queueType: (r.queue_type ?? 'environment') as 'environment' | 'security',
          status: r.status as 'pending' | 'approved' | 'rejected' | 'expired',
          requestedAt:
            r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
          resolvedAt: r.resolved_at
            ? r.resolved_at instanceof Date
              ? r.resolved_at.toISOString()
              : String(r.resolved_at)
            : null,
          resolvedBy: r.approved_by,
          reason: r.reason,
          expiresAt: r.expires_at
            ? r.expires_at instanceof Date
              ? r.expires_at.toISOString()
              : String(r.expires_at)
            : null,
          contributorUsername: r.contributor_username ?? null,
          trustTier: r.trust_tier ?? null,
          jobId: r.job_id,
          holdScope: (r.hold_scope ?? 'job') as 'workflow' | 'job' | 'step',
          stepIndex: r.step_index ?? null,
          requirement:
            r.approval_requirement &&
            typeof r.approval_requirement === 'object' &&
            'clauses' in (r.approval_requirement as Record<string, unknown>)
              ? {
                  clauses:
                    (
                      r.approval_requirement as {
                        clauses?: Array<{ team: string } | { user: string }>;
                      }
                    ).clauses ?? [],
                  reason:
                    (r.approval_requirement as { reason?: string | null }).reason ??
                    r.reason ??
                    null,
                }
              : null,
          decisions: (decisionsByHold.get(r.id) ?? []).map((d) => ({
            approverUserId: d.approver_user_id,
            decision: d.decision as 'approve' | 'reject',
            clausesSatisfied: (d.clauses_satisfied ?? null) as Array<
              { team: string } | { user: string }
            > | null,
            createdAt:
              d.created_at instanceof Date ? d.created_at.toISOString() : String(d.created_at),
          })),
        })),
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'held_run.list.read',
        { type: 'held_run', id: this.deps.orgId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.held-runs.list.response', msg.requestId, err);
    }
  }

  /**
   * Resolve the actor's Keycloak sub for approval attribution. Only `user` and
   * `platform_operator` actors carry a `sub`; others fall back to a stable id.
   */
  private actorSub(actor: HeldRunApproveRequest['actor']): string {
    if (actor.type === 'user' || actor.type === 'platform_operator') return actor.sub;
    if (actor.type === 'api_key') return actor.ownerSub;
    if (actor.type === 'service_account') return `service:${actor.id}`;
    return `system:${actor.component}`;
  }

  /** Read org_settings.allow_self_approval (default true). */
  private async readAllowSelfApproval(): Promise<boolean> {
    try {
      const row = await this.deps.db
        .selectFrom('org_settings')
        .select('allow_self_approval')
        .where('customer_id', '=', this.deps.orgId)
        .executeTakeFirst();
      return row?.allow_self_approval ?? true;
    } catch {
      return true;
    }
  }

  /**
   * Route an approve/reject through the shared `applyDecision` applier:
   * eligibility check, real attribution, multi-clause accumulation, and the
   * resume-after-approval re-dispatch. Sends the matching response message.
   */
  private async applyApprovalDecision(
    msg: HeldRunApproveRequest | HeldRunRejectRequest,
    decision: 'approve' | 'reject',
  ): Promise<void> {
    const approvals = this.deps.approvals!;
    const responseType =
      decision === 'approve'
        ? 'dashboard.held-runs.approve.response'
        : 'dashboard.held-runs.reject.response';
    const auditAction = decision === 'approve' ? 'held_run.approve' : 'held_run.reject';
    const reason = decision === 'reject' ? (msg as HeldRunRejectRequest).reason : undefined;

    const result = await applyDecision(
      {
        orgId: this.deps.orgId,
        store: approvals.store,
        teamMembershipLookup: approvals.teamMembershipLookup,
        allowSelfApproval: await this.readAllowSelfApproval(),
        resolveTriggererSub: async (runId) => {
          const row = await this.deps.db
            .selectFrom('execution_runs')
            .select('triggered_by')
            .where('run_id', '=', runId)
            .executeTakeFirst();
          // triggered_by is stored as "user:sub" / "key:name"; strip the prefix.
          const raw = row?.triggered_by ?? undefined;
          return raw?.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
        },
        onJobRelease: (signal) => approvals.resumeJob(signal),
        onStepRelease: approvals.resumeStep ? (signal) => approvals.resumeStep!(signal) : undefined,
        onStepReject: approvals.rejectStep
          ? (heldRunId, reason) => approvals.rejectStep!(heldRunId, reason)
          : undefined,
        onWorkflowRelease: approvals.resumeWorkflow
          ? (signal) => approvals.resumeWorkflow!(signal)
          : undefined,
        onWorkflowReject: approvals.rejectWorkflow
          ? (runId) => approvals.rejectWorkflow!(runId)
          : undefined,
      },
      { heldRunId: msg.heldRunId, actorSub: this.actorSub(msg.actor), decision, reason },
    );

    if (!result.accepted) {
      this.recordAccess(
        msg.actor,
        auditAction,
        { type: 'held_run', id: msg.heldRunId },
        msg.requestId,
        result.status === 'ineligible' ? 'denied' : 'allowed',
        result.reason,
      );
      this.deps.send({ type: responseType, requestId: msg.requestId, error: result.reason });
      return;
    }

    this.recordAccess(
      msg.actor,
      auditAction,
      { type: 'held_run', id: msg.heldRunId },
      msg.requestId,
      'allowed',
      result.status === 'pending'
        ? `pending: ${result.remainingClauses} clause(s) remain`
        : undefined,
    );
    this.deps.send({ type: responseType, requestId: msg.requestId });
  }

  private async handleHeldRunApprove(msg: HeldRunApproveRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'held_runs.approve',
        'dashboard.held-runs.approve.response',
        'held_run.approve',
        { type: 'held_run', id: msg.heldRunId },
      ))
    ) {
      return;
    }
    try {
      if (this.deps.approvals) {
        await this.applyApprovalDecision(msg, 'approve');
        return;
      }
      const result = await this.deps.db
        .updateTable('held_runs')
        .set({
          status: 'approved',
          resolved_at: sql`now()`,
          approved_by: 'dashboard-user',
        })
        .where('id', '=', msg.heldRunId)
        .where('org_id', '=', this.deps.orgId)
        .where('status', '=', 'pending')
        .executeTakeFirst();

      if (!result || (result.numUpdatedRows ?? 0n) === 0n) {
        this.recordAccess(
          msg.actor,
          'held_run.approve',
          { type: 'held_run', id: msg.heldRunId },
          msg.requestId,
          'allowed',
          'held run not found or already resolved',
        );
        this.deps.send({
          type: 'dashboard.held-runs.approve.response',
          requestId: msg.requestId,
          error: 'Held run not found or already resolved',
        });
        return;
      }

      this.recordAccess(
        msg.actor,
        'held_run.approve',
        { type: 'held_run', id: msg.heldRunId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.held-runs.approve.response',
        requestId: msg.requestId,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'held_run.approve',
        { type: 'held_run', id: msg.heldRunId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.held-runs.approve.response', msg.requestId, err);
    }
  }

  private async handleHeldRunReject(msg: HeldRunRejectRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'held_runs.reject',
        'dashboard.held-runs.reject.response',
        'held_run.reject',
        { type: 'held_run', id: msg.heldRunId },
      ))
    ) {
      return;
    }
    try {
      if (this.deps.approvals) {
        await this.applyApprovalDecision(msg, 'reject');
        return;
      }
      const result = await this.deps.db
        .updateTable('held_runs')
        .set({
          status: 'rejected',
          resolved_at: sql`now()`,
          reason: msg.reason ?? 'Rejected via dashboard',
        })
        .where('id', '=', msg.heldRunId)
        .where('org_id', '=', this.deps.orgId)
        .where('status', '=', 'pending')
        .executeTakeFirst();

      if (!result || (result.numUpdatedRows ?? 0n) === 0n) {
        this.recordAccess(
          msg.actor,
          'held_run.reject',
          { type: 'held_run', id: msg.heldRunId },
          msg.requestId,
          'allowed',
          'held run not found or already resolved',
        );
        this.deps.send({
          type: 'dashboard.held-runs.reject.response',
          requestId: msg.requestId,
          error: 'Held run not found or already resolved',
        });
        return;
      }

      this.recordAccess(
        msg.actor,
        'held_run.reject',
        { type: 'held_run', id: msg.heldRunId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.held-runs.reject.response',
        requestId: msg.requestId,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'held_run.reject',
        { type: 'held_run', id: msg.heldRunId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.held-runs.reject.response', msg.requestId, err);
    }
  }

  // ── Helper ────────────────────────────────────────────────────────

  private sendError(type: string, requestId: string, err: unknown): void {
    const message = toErrorMessage(err);
    logger.error(`Error handling ${type}`, { requestId, error: message });
    this.deps.send({
      type,
      requestId,
      error: message,
    });
  }
}
