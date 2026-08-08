/**
 * Dashboard context handler for the orchestrator.
 *
 * Responds to dashboard.contexts.* and dashboard.held-runs.* WS messages
 * from Platform by calling the appropriate stores (ContextStore, VariableStore,
 * BindingStore, PgSecretStore) and sending typed responses.
 *
 * Each handler:
 * 1. Extracts orgId from the dependency context
 * 2. Calls the appropriate store method
 * 3. Returns a response message with requestId and data (or error)
 */
import { sql, type Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { HeldRunStatus } from '../contexts/held-runs.js';
import type { HeldRunStore, ReleaseSignal } from '../contexts/held-runs.js';
import type { TeamMembershipLookup } from '../approvals/approval-resolver.js';
import { applyDecision } from '../approvals/apply-decision.js';
import type {
  AccessLogAction,
  AccessLogOutcome,
  AccessLogTargetType,
  ActorPrincipal,
  DashboardPlatformToOrchMessage,
  ContextListRequest,
  ContextGetRequest,
  ContextCreateRequest,
  ContextUpdateRequest,
  ContextTestAccessSetRequest,
  ContextDeleteRequest,
  ContextVarsListRequest,
  ContextVarSetRequest,
  ContextVarDeleteRequest,
  ContextSourceOverridesListRequest,
  ContextSourceOverrideSetRequest,
  ContextSourceOverrideDeleteRequest,
  ContextBindingsListRequest,
  ContextBindingsSetRequest,
  ContextSecretsListRequest,
  ContextSecretSetRequest,
  ContextSecretDeleteRequest,
  ContextSecretScopeCreateRequest,
  ContextSecretScopeRenameRequest,
  ContextSecretScopeDeleteRequest,
  ContextHistoryRequest,
  HeldRunsListRequest,
  HeldRunApproveRequest,
  HeldRunRejectRequest,
  ConcurrencyStrategy,
} from '@kici-dev/engine';
import {
  ApprovalDecision,
  ContextDeleteErrorCode,
  HeldRunQueueType,
  HoldScope,
  assertValidScopeName,
  normalizePersistedHoldType,
} from '@kici-dev/engine';
import { ContextDeleteBlockedError } from '../contexts/context-store.js';
import type { ContextStore } from '../contexts/context-store.js';
import type { VariableStore } from '../contexts/variable-store.js';
import type { BindingStore } from '../contexts/binding-store.js';
import type { Database } from '../db/types.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import type { DashboardWriteOperation } from '@kici-dev/engine/protocol/dashboard-write-operations';
import {
  assertDashboardWriteAllowed,
  buildPolicyDeniedResponse,
  getDashboardWritePolicyState,
  DashboardWritePolicyDisabledError,
} from '../policy/dashboard-write-policy.js';
import { decryptDashboardSealedWrite } from '../secrets/ephemeral-keys.js';
import { resolveScope, type ScopedSecretStore } from '../secrets/scope-routing.js';
import type { ResolvedDashboardEncryptionKey } from '../secrets/dashboard-encryption-key.js';
import {
  DashboardSealedWriteError,
  type DashboardSealedEnvelope,
} from '@kici-dev/engine/protocol/messages/dashboard-sealed-write';

const logger = createLogger({ prefix: 'dashboard-context-handler' });

/**
 * Normalize a `held_runs.payload` jsonb column into the
 * `{ summaryMarkdown, drift }` shape the held-runs list response carries. The
 * Kysely driver may return jsonb already parsed (object) or as a string; both
 * are coerced. Returns null for an absent payload (every non-drift hold).
 */
function normalizeHeldRunPayload(raw: unknown): { summaryMarkdown: string; drift: unknown } | null {
  if (raw == null) return null;
  const obj = typeof raw === 'string' ? safeJsonParse(raw) : raw;
  if (obj && typeof obj === 'object' && 'summaryMarkdown' in obj) {
    const o = obj as { summaryMarkdown: unknown; drift?: unknown };
    if (typeof o.summaryMarkdown === 'string') {
      return { summaryMarkdown: o.summaryMarkdown, drift: o.drift };
    }
  }
  return null;
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Secret store interface (subset of PgSecretStore methods used here).
 *
 * Alias of the shared `ScopedSecretStore` so the WS plane and the HTTP admin
 * plane route scopes against one contract.
 */
type SecretStoreForDashboard = ScopedSecretStore;

export interface DashboardContextHandlerDeps {
  /** Organization ID for all operations. */
  orgId: string;
  /** Send a response message back to Platform over the WS connection. */
  send: (msg: unknown) => void;
  contextStore: ContextStore;
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
  /**
   * Dashboard-encryption key resolver. Present when KICI_SECRET_KEY is
   * configured. Under the `encrypted` posture the secret/variable set handlers
   * decrypt the browser-sealed envelope with the resolved private key. Absent ⇒
   * `encrypted` writes fail closed (`encryption_unavailable`).
   */
  dashboardEncryption?: {
    resolve: () => Promise<ResolvedDashboardEncryptionKey | null>;
  };
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
 * Handler for all dashboard context and held run WS messages.
 *
 * Dispatches incoming messages by type and calls the appropriate store.
 */
export class DashboardContextHandler {
  private readonly deps: DashboardContextHandlerDeps;
  private routingKey: string | null;
  private readonly accessLog: AccessLogWriter | undefined;

  constructor(deps: DashboardContextHandlerDeps) {
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
    orgId: string = this.deps.orgId,
  ): Promise<boolean> {
    try {
      await assertDashboardWriteAllowed(this.deps.db, orgId, op);
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
   * Resolve the plaintext value for a secret/variable set under the write
   * policy. When the client sends a `sealed` envelope, decrypt it with the
   * orchestrator's X25519 key (honored regardless of posture — the client chose
   * to seal, so never expose that plaintext through the Platform). Otherwise,
   * under the `encrypted` posture a plaintext `value` is refused (fail-closed);
   * under `permissive` the plaintext `value` is used. Returns the plaintext or a
   * structured error code the caller records + sends back.
   */
  private async resolveWriteValue(
    msg: { value?: string; sealed?: DashboardSealedEnvelope },
    op: DashboardWriteOperation,
  ): Promise<{ plaintext: string } | { error: DashboardSealedWriteError }> {
    if (msg.sealed) {
      const resolved = await this.deps.dashboardEncryption?.resolve();
      if (!resolved) {
        return { error: DashboardSealedWriteError.enum.encryption_unavailable };
      }
      const priv = await resolved.decryptPrivateKeyDer(msg.sealed.keyId);
      if (!priv) {
        return { error: DashboardSealedWriteError.enum.unknown_encryption_key };
      }
      try {
        return { plaintext: decryptDashboardSealedWrite(msg.sealed, priv) };
      } catch {
        return { error: DashboardSealedWriteError.enum.decryption_failed };
      }
    }
    const state = await getDashboardWritePolicyState(this.deps.db, this.deps.orgId, op);
    if (state === 'encrypted') {
      // Fail-closed: never accept a plaintext value under the encrypted posture.
      return { error: DashboardSealedWriteError.enum.operation_requires_encryption };
    }
    if (msg.value === undefined) {
      return { error: DashboardSealedWriteError.enum.missing_value };
    }
    return { plaintext: msg.value };
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
      // Context CRUD
      case 'dashboard.contexts.list':
        await this.handleEnvList(msg);
        return true;
      case 'dashboard.contexts.get':
        await this.handleEnvGet(msg);
        return true;
      case 'dashboard.contexts.create':
        await this.handleEnvCreate(msg);
        return true;
      case 'dashboard.contexts.update':
        await this.handleEnvUpdate(msg);
        return true;
      case 'dashboard.contexts.test_access.set':
        await this.handleTestAccessSet(msg);
        return true;
      case 'dashboard.contexts.delete':
        await this.handleEnvDelete(msg);
        return true;

      // Variables
      case 'dashboard.contexts.variables.list':
        await this.handleVarsList(msg);
        return true;
      case 'dashboard.contexts.variables.set':
        await this.handleVarSet(msg);
        return true;
      case 'dashboard.contexts.variables.delete':
        await this.handleVarDelete(msg);
        return true;

      // Source overrides
      case 'dashboard.contexts.source-overrides.list':
        await this.handleSourceOverridesList(msg);
        return true;
      case 'dashboard.contexts.source-overrides.set':
        await this.handleSourceOverrideSet(msg);
        return true;
      case 'dashboard.contexts.source-overrides.delete':
        await this.handleSourceOverrideDelete(msg);
        return true;

      // Bindings
      case 'dashboard.contexts.bindings.list':
        await this.handleBindingsList(msg);
        return true;
      case 'dashboard.contexts.bindings.set':
        await this.handleBindingsSet(msg);
        return true;

      // Secrets
      case 'dashboard.contexts.secrets.list':
        await this.handleSecretsList(msg);
        return true;
      case 'dashboard.contexts.secrets.set':
        await this.handleSecretSet(msg);
        return true;
      case 'dashboard.contexts.secrets.delete':
        await this.handleSecretDelete(msg);
        return true;

      // Scope CRUD
      case 'dashboard.contexts.secrets.scope.create':
        await this.handleScopeCreate(msg);
        return true;
      case 'dashboard.contexts.secrets.scope.rename':
        await this.handleScopeRename(msg);
        return true;
      case 'dashboard.contexts.secrets.scope.delete':
        await this.handleScopeDelete(msg);
        return true;

      // Context history
      case 'dashboard.contexts.history':
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

  // ── Context CRUD ──────────────────────────────────────────────

  private async handleEnvList(msg: ContextListRequest): Promise<void> {
    // Scope to the request's target org when the Platform carries one
    // (Platform-first dev path), falling back to the connection-level org for
    // the legacy customer-dashboard path. The orchestrator's DB only holds its
    // own tenant's rows, so honoring the requested org returns that org's data
    // or an empty list — never another tenant's secrets.
    const orgId = msg.orgId ?? this.deps.orgId;
    try {
      const envs = await this.deps.contextStore.list(orgId);
      const secretKeysByEnv = msg.includeSecrets
        ? await this.loadSecretKeysByEnv(
            orgId,
            envs.map((e) => e.id),
          )
        : undefined;
      this.recordAccess(
        msg.actor,
        'context.list.read',
        { type: 'context', id: orgId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.contexts.list.response',
        requestId: msg.requestId,
        contexts: envs.map((e) => ({
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
        'context.list.read',
        { type: 'context', id: orgId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.contexts.list.response', msg.requestId, err);
    }
  }

  /**
   * Map each context id to the distinct secret key names reachable through
   * its scope bindings. Joins `context_bindings` → `scoped_secrets` on the
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
      .selectFrom('context_bindings as eb')
      .innerJoin('scoped_secrets as ss', (join) =>
        join.onRef('ss.scope', '=', 'eb.scope_pattern').onRef('ss.org_id', '=', 'eb.org_id'),
      )
      .select(['eb.context_id as context_id', 'ss.key as key'])
      .where('eb.org_id', '=', orgId)
      .where('eb.context_id', 'in', envIds)
      .where('ss.key', '!=', '__empty__')
      .distinct()
      .execute();

    const sets = new Map<string, Set<string>>();
    for (const r of rows as Array<{ context_id: string; key: string }>) {
      let s = sets.get(r.context_id);
      if (!s) {
        s = new Set();
        sets.set(r.context_id, s);
      }
      s.add(r.key);
    }
    for (const [envId, keys] of sets) byEnv.set(envId, Array.from(keys).sort());
    return byEnv;
  }

  private async handleEnvGet(msg: ContextGetRequest): Promise<void> {
    try {
      const env = await this.deps.contextStore.get(this.deps.orgId, msg.contextId);
      if (!env) {
        this.recordAccess(
          msg.actor,
          'context.get.read',
          { type: 'context', id: msg.contextId },
          msg.requestId,
          'allowed',
          'context not found',
        );
        this.deps.send({
          type: 'dashboard.contexts.get.response',
          requestId: msg.requestId,
          error: 'Context not found',
        });
        return;
      }
      this.recordAccess(
        msg.actor,
        'context.get.read',
        { type: 'context', id: msg.contextId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.contexts.get.response',
        requestId: msg.requestId,
        context: {
          id: env.id,
          name: env.name,
          type: env.type,
          globPattern: env.glob_pattern,
          branchRestrictions: env.branch_restrictions ?? null,
          concurrencyLimit: env.concurrency_limit,
          concurrencyStrategy: env.concurrency_strategy as ConcurrencyStrategy | null,
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
        'context.get.read',
        { type: 'context', id: msg.contextId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.contexts.get.response', msg.requestId, err);
    }
  }

  private async handleEnvCreate(msg: ContextCreateRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'contexts.create',
        'dashboard.contexts.create.response',
        'context.create',
        { type: 'context', id: msg.name },
      ))
    ) {
      return;
    }
    try {
      const env = await this.deps.contextStore.create(this.deps.orgId, {
        name: msg.name,
        type: msg.contextType,
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
        'context.create',
        { type: 'context', id: env.id },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.contexts.create.response',
        requestId: msg.requestId,
        contextId: env.id,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'context.create',
        { type: 'context', id: msg.name },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.contexts.create.response', msg.requestId, err);
    }
  }

  private async handleEnvUpdate(msg: ContextUpdateRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'contexts.update',
        'dashboard.contexts.update.response',
        'context.update',
        { type: 'context', id: msg.contextId },
      ))
    ) {
      return;
    }
    try {
      const u = msg.updates;
      const env = await this.deps.contextStore.update(this.deps.orgId, msg.contextId, {
        name: u.name,
        type: u.contextType,
        globPattern: u.globPattern,
        // `undefined` = the message did not mention the field, leave it alone;
        // `null` = clear it. The two are distinct on the wire (every field here
        // is `.nullable().optional()`), so they are forwarded verbatim —
        // collapsing them makes "turn this off" a silent no-op.
        branchRestrictions: u.branchRestrictions,
        concurrencyLimit: u.concurrencyLimit,
        concurrencyStrategy: u.concurrencyStrategy,
        // The column stores a JSON array; the wire carries a count. Three-way
        // rather than `??`, so an explicit null survives as a clear.
        requiredReviewers:
          u.requiredReviewers === undefined
            ? undefined
            : u.requiredReviewers === null
              ? null
              : [String(u.requiredReviewers)],
        waitTimerSeconds: u.waitTimerSeconds,
        holdExpirySeconds: u.holdExpirySeconds,
        enabled: u.enabled,
      });
      if (!env) {
        this.recordAccess(
          msg.actor,
          'context.update',
          { type: 'context', id: msg.contextId },
          msg.requestId,
          'allowed',
          'context not found',
        );
        this.deps.send({
          type: 'dashboard.contexts.update.response',
          requestId: msg.requestId,
          error: 'Context not found',
        });
        return;
      }
      this.recordAccess(
        msg.actor,
        'context.update',
        { type: 'context', id: msg.contextId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.contexts.update.response',
        requestId: msg.requestId,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'context.update',
        { type: 'context', id: msg.contextId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.contexts.update.response', msg.requestId, err);
    }
  }

  private async handleTestAccessSet(msg: ContextTestAccessSetRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'contexts.test_access.set',
        'dashboard.contexts.test_access.set.response',
        'context.update',
        { type: 'context', id: msg.contextId },
      ))
    ) {
      return;
    }
    try {
      const env = await this.deps.contextStore.update(this.deps.orgId, msg.contextId, {
        allowLocalExecution: msg.allowLocalExecution,
      });
      if (!env) {
        this.recordAccess(
          msg.actor,
          'context.update',
          { type: 'context', id: msg.contextId },
          msg.requestId,
          'allowed',
          'context not found',
        );
        this.deps.send({
          type: 'dashboard.contexts.test_access.set.response',
          requestId: msg.requestId,
          error: 'Context not found',
        });
        return;
      }
      this.recordAccess(
        msg.actor,
        'context.update',
        { type: 'context', id: msg.contextId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.contexts.test_access.set.response',
        requestId: msg.requestId,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'context.update',
        { type: 'context', id: msg.contextId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.contexts.test_access.set.response', msg.requestId, err);
    }
  }

  private async handleEnvDelete(msg: ContextDeleteRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'contexts.delete',
        'dashboard.contexts.delete.response',
        'context.delete',
        { type: 'context', id: msg.contextId },
      ))
    ) {
      return;
    }
    try {
      const deleted = await this.deps.contextStore.delete(this.deps.orgId, msg.contextId);
      if (!deleted) {
        this.recordAccess(
          msg.actor,
          'context.delete',
          { type: 'context', id: msg.contextId },
          msg.requestId,
          'allowed',
          'context not found',
        );
        this.deps.send({
          type: 'dashboard.contexts.delete.response',
          requestId: msg.requestId,
          error: 'Context not found',
        });
        return;
      }
      this.recordAccess(
        msg.actor,
        'context.delete',
        { type: 'context', id: msg.contextId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.contexts.delete.response',
        requestId: msg.requestId,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'context.delete',
        { type: 'context', id: msg.contextId },
        msg.requestId,
        err instanceof ContextDeleteBlockedError ? 'denied' : 'error',
        toErrorMessage(err),
      );
      if (err instanceof ContextDeleteBlockedError) {
        this.deps.send({
          type: 'dashboard.contexts.delete.response',
          requestId: msg.requestId,
          error: err.message,
          errorCode: ContextDeleteErrorCode.enum.pending_held_runs,
        });
        return;
      }
      this.sendError('dashboard.contexts.delete.response', msg.requestId, err);
    }
  }

  // ── Variables ─────────────────────────────────────────────────────

  private async handleVarsList(msg: ContextVarsListRequest): Promise<void> {
    try {
      const vars = await this.deps.variableStore.listVars(this.deps.orgId, msg.contextId);
      this.recordAccess(
        msg.actor,
        'context_var.list.read',
        { type: 'context', id: msg.contextId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.contexts.variables.list.response',
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
        'context_var.list.read',
        { type: 'context', id: msg.contextId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.contexts.variables.list.response', msg.requestId, err);
    }
  }

  private async handleVarSet(msg: ContextVarSetRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'variables.set',
        'dashboard.contexts.variables.set.response',
        'context_var.set',
        { type: 'context', id: `${msg.contextId}:${msg.key}` },
      ))
    ) {
      return;
    }
    const resolved = await this.resolveWriteValue(msg, 'variables.set');
    if ('error' in resolved) {
      this.recordAccess(
        msg.actor,
        'context_var.set',
        { type: 'context', id: `${msg.contextId}:${msg.key}` },
        msg.requestId,
        'denied',
        resolved.error,
      );
      this.deps.send({
        type: 'dashboard.contexts.variables.set.response',
        requestId: msg.requestId,
        error: resolved.error,
      });
      return;
    }
    try {
      await this.deps.variableStore.setVar(
        this.deps.orgId,
        msg.contextId,
        msg.key,
        resolved.plaintext,
        msg.locked,
      );
      this.recordAccess(
        msg.actor,
        'context_var.set',
        { type: 'context', id: `${msg.contextId}:${msg.key}` },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.contexts.variables.set.response',
        requestId: msg.requestId,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'context_var.set',
        { type: 'context', id: `${msg.contextId}:${msg.key}` },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.contexts.variables.set.response', msg.requestId, err);
    }
  }

  private async handleVarDelete(msg: ContextVarDeleteRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'variables.delete',
        'dashboard.contexts.variables.delete.response',
        'context_var.delete',
        { type: 'context', id: `${msg.contextId}:${msg.key}` },
      ))
    ) {
      return;
    }
    try {
      await this.deps.variableStore.deleteVar(this.deps.orgId, msg.contextId, msg.key);
      this.recordAccess(
        msg.actor,
        'context_var.delete',
        { type: 'context', id: `${msg.contextId}:${msg.key}` },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.contexts.variables.delete.response',
        requestId: msg.requestId,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'context_var.delete',
        { type: 'context', id: `${msg.contextId}:${msg.key}` },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.contexts.variables.delete.response', msg.requestId, err);
    }
  }

  // ── Source overrides ──────────────────────────────────────────────

  private async handleSourceOverridesList(msg: ContextSourceOverridesListRequest): Promise<void> {
    try {
      const overrides = await this.deps.variableStore.listSourceOverrides(
        this.deps.orgId,
        msg.contextId,
        msg.routingKey,
      );
      this.recordAccess(
        msg.actor,
        'source_override.list.read',
        { type: 'context', id: `${msg.contextId}:${msg.routingKey}` },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.contexts.source-overrides.list.response',
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
        { type: 'context', id: `${msg.contextId}:${msg.routingKey}` },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.contexts.source-overrides.list.response', msg.requestId, err);
    }
  }

  private async handleSourceOverrideSet(msg: ContextSourceOverrideSetRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'contexts.source_overrides.set',
        'dashboard.contexts.source-overrides.set.response',
        'source_override.set',
        { type: 'context', id: `${msg.contextId}:${msg.routingKey}:${msg.key}` },
      ))
    ) {
      return;
    }
    try {
      await this.deps.variableStore.setSourceOverride(
        this.deps.orgId,
        msg.contextId,
        msg.routingKey,
        msg.key,
        msg.value,
      );
      this.recordAccess(
        msg.actor,
        'source_override.set',
        { type: 'context', id: `${msg.contextId}:${msg.routingKey}:${msg.key}` },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.contexts.source-overrides.set.response',
        requestId: msg.requestId,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'source_override.set',
        { type: 'context', id: `${msg.contextId}:${msg.routingKey}:${msg.key}` },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.contexts.source-overrides.set.response', msg.requestId, err);
    }
  }

  private async handleSourceOverrideDelete(msg: ContextSourceOverrideDeleteRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'contexts.source_overrides.delete',
        'dashboard.contexts.source-overrides.delete.response',
        'source_override.delete',
        { type: 'context', id: `${msg.contextId}:${msg.routingKey}:${msg.key}` },
      ))
    ) {
      return;
    }
    try {
      await this.deps.variableStore.deleteSourceOverride(
        this.deps.orgId,
        msg.contextId,
        msg.routingKey,
        msg.key,
      );
      this.recordAccess(
        msg.actor,
        'source_override.delete',
        { type: 'context', id: `${msg.contextId}:${msg.routingKey}:${msg.key}` },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.contexts.source-overrides.delete.response',
        requestId: msg.requestId,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'source_override.delete',
        { type: 'context', id: `${msg.contextId}:${msg.routingKey}:${msg.key}` },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.contexts.source-overrides.delete.response', msg.requestId, err);
    }
  }

  // ── Bindings ──────────────────────────────────────────────────────

  private async handleBindingsList(msg: ContextBindingsListRequest): Promise<void> {
    try {
      const bindings = await this.deps.bindingStore.list(this.deps.orgId, msg.contextId);
      this.recordAccess(
        msg.actor,
        'context_binding.list.read',
        { type: 'context', id: msg.contextId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.contexts.bindings.list.response',
        requestId: msg.requestId,
        bindings: bindings.map((b) => ({
          scopePattern: b.scope_pattern,
          hostPattern: b.host_pattern,
        })),
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'context_binding.list.read',
        { type: 'context', id: msg.contextId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.contexts.bindings.list.response', msg.requestId, err);
    }
  }

  private async handleBindingsSet(msg: ContextBindingsSetRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'contexts.bindings.set',
        'dashboard.contexts.bindings.set.response',
        'context_binding.set',
        { type: 'context', id: msg.contextId },
      ))
    ) {
      return;
    }
    try {
      await this.deps.bindingStore.set(
        this.deps.orgId,
        msg.contextId,
        msg.bindings.map((b) => ({ scopePattern: b.scopePattern, hostPattern: b.hostPattern })),
      );
      this.recordAccess(
        msg.actor,
        'context_binding.set',
        { type: 'context', id: msg.contextId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.contexts.bindings.set.response',
        requestId: msg.requestId,
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'context_binding.set',
        { type: 'context', id: msg.contextId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.contexts.bindings.set.response', msg.requestId, err);
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
    const stores = await this.getBackendStores();
    const { store, path } = resolveScope(prefixedScope, stores, this.deps.secretStore);
    return { store, scope: path };
  }

  private async handleSecretsList(msg: ContextSecretsListRequest): Promise<void> {
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
        type: 'dashboard.contexts.secrets.list.response',
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
      this.sendError('dashboard.contexts.secrets.list.response', msg.requestId, err);
    }
  }

  private async handleSecretSet(msg: ContextSecretSetRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'secrets.set',
        'dashboard.contexts.secrets.set.response',
        'secret.set',
        { type: 'secret_scope', id: `${msg.scope}:${msg.key}` },
      ))
    ) {
      return;
    }
    const resolved = await this.resolveWriteValue(msg, 'secrets.set');
    if ('error' in resolved) {
      this.recordAccess(
        msg.actor,
        'secret.set',
        { type: 'secret_scope', id: `${msg.scope}:${msg.key}` },
        msg.requestId,
        'denied',
        resolved.error,
      );
      this.deps.send({
        type: 'dashboard.contexts.secrets.set.response',
        requestId: msg.requestId,
        error: resolved.error,
      });
      return;
    }
    try {
      const { store, scope } = await this.resolveStoreForScope(msg.scope);
      assertValidScopeName(scope);
      await store.setSecret(this.deps.orgId, scope, msg.key, resolved.plaintext);
      this.recordAccess(
        msg.actor,
        'secret.set',
        { type: 'secret_scope', id: `${msg.scope}:${msg.key}` },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.contexts.secrets.set.response',
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
      this.sendError('dashboard.contexts.secrets.set.response', msg.requestId, err);
    }
  }

  private async handleSecretDelete(msg: ContextSecretDeleteRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'secrets.delete',
        'dashboard.contexts.secrets.delete.response',
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
        type: 'dashboard.contexts.secrets.delete.response',
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
      this.sendError('dashboard.contexts.secrets.delete.response', msg.requestId, err);
    }
  }

  // ── Scope CRUD ──────────────────────────────────────────────────

  private async handleScopeCreate(msg: ContextSecretScopeCreateRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'secrets.scope.create',
        'dashboard.contexts.secrets.scope.create.response',
        'secret_scope.create',
        { type: 'secret_scope', id: msg.scope },
      ))
    ) {
      return;
    }
    try {
      const { store, scope } = await this.resolveStoreForScope(msg.scope);
      assertValidScopeName(scope);
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
        type: 'dashboard.contexts.secrets.scope.create.response' as const,
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
      this.sendError('dashboard.contexts.secrets.scope.create.response', msg.requestId, err);
    }
  }

  private async handleScopeRename(msg: ContextSecretScopeRenameRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'secrets.scope.rename',
        'dashboard.contexts.secrets.scope.rename.response',
        'secret_scope.rename',
        { type: 'secret_scope', id: `${msg.oldScope}->${msg.newScope}` },
      ))
    ) {
      return;
    }
    try {
      // Both scopes resolve against ONE snapshot of the backend map. Loading it
      // twice would let a backend registered or removed between the two loads
      // decide the comparison below — the same qualifier could resolve to a
      // backend in one snapshot and fall through to the default in the other,
      // which is exactly the cross-backend rename this guard must catch.
      const stores = await this.getBackendStores();
      const from = resolveScope(msg.oldScope, stores, this.deps.secretStore);
      const to = resolveScope(msg.newScope, stores, this.deps.secretStore);
      // A rename is a per-backend operation — the source store re-encrypts each
      // row under the new scope's AAD. Moving a scope BETWEEN backends is a
      // copy plus a delete, which this path does not perform, so reject it
      // outright rather than silently renaming inside the source backend and
      // reporting success. Mirrors the HTTP admin route's 400.
      if (from.backendName !== to.backendName) {
        throw new Error(
          `Cannot rename a scope across backends ` +
            `('${from.backendName}' -> '${to.backendName}'). ` +
            `Recreate the secrets in the destination backend instead.`,
        );
      }
      if (!from.store.renameScope) {
        throw new Error('Backend does not support scope rename');
      }
      // Validate only the destination name — renaming a pre-existing malformed
      // scope to a conforming one is the built-in cleanup path.
      assertValidScopeName(to.path);
      await from.store.renameScope(this.deps.orgId, from.path, to.path);
      this.recordAccess(
        msg.actor,
        'secret_scope.rename',
        { type: 'secret_scope', id: `${msg.oldScope}->${msg.newScope}` },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.contexts.secrets.scope.rename.response' as const,
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
      this.sendError('dashboard.contexts.secrets.scope.rename.response', msg.requestId, err);
    }
  }

  private async handleScopeDelete(msg: ContextSecretScopeDeleteRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'secrets.scope.delete',
        'dashboard.contexts.secrets.scope.delete.response',
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
        type: 'dashboard.contexts.secrets.scope.delete.response' as const,
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
      this.sendError('dashboard.contexts.secrets.scope.delete.response', msg.requestId, err);
    }
  }

  // ── Context history ──────────────────────────────────────────

  private async handleEnvHistory(msg: ContextHistoryRequest): Promise<void> {
    try {
      const limit = msg.limit ?? 20;
      const offset = msg.offset ?? 0;

      // Over-fetch by one to detect whether a further page exists without a
      // separate count query: if the DB returns more than `limit` rows, there
      // is at least one more page. The probe row is sliced off below and never
      // reaches the client.
      const fetched = await this.deps.db
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
          'context',
        ])
        .where('context_id', '=', msg.contextId)
        .orderBy('started_at', 'desc')
        .limit(limit + 1)
        .offset(offset)
        .execute();

      const hasMore = fetched.length > limit;
      const runs = hasMore ? fetched.slice(0, limit) : fetched;

      this.recordAccess(
        msg.actor,
        'context.history.read',
        { type: 'context', id: msg.contextId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.contexts.history.response',
        requestId: msg.requestId,
        hasMore,
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
          context: r.context,
        })),
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'context.history.read',
        { type: 'context', id: msg.contextId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.contexts.history.response', msg.requestId, err);
    }
  }

  // ── Held runs ─────────────────────────────────────────────────────

  private async handleHeldRunsList(msg: HeldRunsListRequest): Promise<void> {
    // Scope to the request's target org when the Platform carries one
    // (Platform-first `kici run remote` path), falling back to the
    // connection-level org for the legacy customer-dashboard path. A remote
    // run's hold lives under the run's own `remote_sources` org, which differs
    // from this connection's primary webhook-source org, so honoring the
    // requested org is what surfaces the hold to `kici approve` / `--approve-all`.
    const orgId = msg.orgId ?? this.deps.orgId;
    try {
      let query = this.deps.db
        .selectFrom('held_runs')
        .leftJoin('contexts', 'contexts.id', 'held_runs.context_id')
        .leftJoin('execution_runs', 'execution_runs.run_id', 'held_runs.run_id')
        .select([
          'held_runs.id',
          'held_runs.run_id',
          'held_runs.job_id',
          'held_runs.context_id',
          'contexts.name as context_name',
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
          'held_runs.payload',
          'execution_runs.contributor_username',
          'execution_runs.trust_tier',
        ])
        .where('held_runs.org_id', '=', orgId)
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
      if (msg.heldRunId) {
        query = query.where('held_runs.id', '=', msg.heldRunId);
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
          contextId: r.context_id,
          contextName: r.context_name,
          // A row an un-upgraded orchestrator wrote may carry `approval` /
          // `wait_timer`; the wire and the UI speak one vocabulary. An unknown
          // type passes through — the field is `z.string()` so a newer
          // orchestrator's type survives an older reader.
          holdType: normalizePersistedHoldType(r.hold_type),
          // Emitted verbatim: both are plain-text columns and the wire fields
          // are `z.string()`, so a status this build does not know (or one a
          // newer orchestrator writes) still reaches the reader instead of
          // failing validation for the whole message. `?? 'context'` is a real
          // default for the nullable column read, not a cast.
          queueType: r.queue_type ?? HeldRunQueueType.enum.context,
          status: r.status,
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
          // Still a cast: the wire field is a strict `HoldScope` enum while the
          // column is plain text. Safe today because `hold_scope` is only ever
          // written from `HoldScope` (and defaults to 'job'); widen the wire
          // field the moment that stops being true.
          holdScope: (r.hold_scope ?? HoldScope.enum.job) as HoldScope,
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
          payload: normalizeHeldRunPayload(r.payload),
          decisions: (decisionsByHold.get(r.id) ?? []).map((d) => ({
            approverUserId: d.approver_user_id,
            // Same shape as `holdScope` above: strict on the wire, plain text
            // in `held_run_approvals.decision`, only ever written from
            // `ApprovalDecision`.
            decision: d.decision as ApprovalDecision,
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
  private async readAllowSelfApproval(orgId: string = this.deps.orgId): Promise<boolean> {
    try {
      const row = await this.deps.db
        .selectFrom('org_settings')
        .select('allow_self_approval')
        .where('customer_id', '=', orgId)
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
    orgId: string = this.deps.orgId,
  ): Promise<void> {
    const approvals = this.deps.approvals!;
    const responseType =
      decision === 'approve'
        ? 'dashboard.held-runs.approve.response'
        : 'dashboard.held-runs.reject.response';
    // `--approve-all` breakglass approvals audit as a distinct action so the
    // trail shows "auto-approved by the dispatcher" vs an interactive approve.
    const autoApprove =
      decision === 'approve' && (msg as HeldRunApproveRequest).autoApprove === true;
    const auditAction =
      decision === 'approve'
        ? autoApprove
          ? 'held_run.auto_approve'
          : 'held_run.approve'
        : 'held_run.reject';
    const reason = decision === 'reject' ? (msg as HeldRunRejectRequest).reason : undefined;

    const result = await applyDecision(
      {
        orgId,
        store: approvals.store,
        teamMembershipLookup: approvals.teamMembershipLookup,
        allowSelfApproval: await this.readAllowSelfApproval(orgId),
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
    // Honor the Platform-carried request org over the static connection org so a
    // remote run's hold (recorded under the run's `remote_sources` org) resolves.
    const orgId = msg.orgId ?? this.deps.orgId;
    if (
      !(await this.enforcePolicy(
        msg,
        'held_runs.approve',
        'dashboard.held-runs.approve.response',
        'held_run.approve',
        { type: 'held_run', id: msg.heldRunId },
        orgId,
      ))
    ) {
      return;
    }
    try {
      if (this.deps.approvals) {
        await this.applyApprovalDecision(msg, 'approve', orgId);
        return;
      }
      const result = await this.deps.db
        .updateTable('held_runs')
        .set({
          status: HeldRunStatus.Approved,
          resolved_at: sql`now()`,
          approved_by: 'dashboard-user',
        })
        .where('id', '=', msg.heldRunId)
        .where('org_id', '=', orgId)
        .where('status', '=', HeldRunStatus.Pending)
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
    // Honor the Platform-carried request org over the static connection org so a
    // remote run's hold (recorded under the run's `remote_sources` org) resolves.
    const orgId = msg.orgId ?? this.deps.orgId;
    if (
      !(await this.enforcePolicy(
        msg,
        'held_runs.reject',
        'dashboard.held-runs.reject.response',
        'held_run.reject',
        { type: 'held_run', id: msg.heldRunId },
        orgId,
      ))
    ) {
      return;
    }
    try {
      if (this.deps.approvals) {
        await this.applyApprovalDecision(msg, 'reject', orgId);
        return;
      }
      const result = await this.deps.db
        .updateTable('held_runs')
        .set({
          status: HeldRunStatus.Rejected,
          resolved_at: sql`now()`,
          reason: msg.reason ?? 'Rejected via dashboard',
        })
        .where('id', '=', msg.heldRunId)
        .where('org_id', '=', orgId)
        .where('status', '=', HeldRunStatus.Pending)
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
