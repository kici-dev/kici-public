/**
 * Dashboard global-workflows handler for the orchestrator.
 *
 * Responds to `dashboard.global-workflows.*` WS messages from Platform by
 * reading or upserting the `org_settings` row keyed by `customer_id`. The
 * row holds the org-level global-workflow policy: master enable, plus the
 * three repo-pattern lists (allow / deny / elevate). Each list entry is a
 * `{routingKey?, pattern}` object that may optionally pin to one source.
 *
 * The handler binds a single `customerId` at construction time (via the
 * sources / generic_webhook_sources lookup at server startup) and updates
 * via setOrgId() when a real customer source registers.
 */
import { sql, type Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type {
  AccessLogAction,
  AccessLogOutcome,
  AccessLogTargetType,
  ActorPrincipal,
} from '@kici-dev/engine';
import type {
  GlobalWorkflowsGetRequest,
  GlobalWorkflowsUpdateRequest,
  GlobalWorkflowSettings,
  RepoPatternEntry,
} from '@kici-dev/engine/protocol/dashboard-global-workflows';
import type { Database, OrgSettings } from '../db/types.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import type { DashboardWriteOperation } from '@kici-dev/engine/protocol/dashboard-write-operations';
import {
  assertDashboardWriteAllowed,
  buildPolicyDeniedResponse,
  DashboardWritePolicyDisabledError,
} from '../policy/dashboard-write-policy.js';

const logger = createLogger({ prefix: 'dashboard-global-workflows-handler' });

interface DashboardGlobalWorkflowsHandlerDeps {
  /** Customer / org identifier — primary key on org_settings. */
  customerId: string;
  /** Send a response message back to Platform over the WS connection. */
  send: (msg: unknown) => void;
  db: Kysely<Database>;
  /** Access log writer — records one row per read / mutation with actor attribution. */
  accessLog?: AccessLogWriter;
}

type GlobalWorkflowsMessage = GlobalWorkflowsGetRequest | GlobalWorkflowsUpdateRequest;

/**
 * Returns true when the message is one this handler can dispatch. Used by the
 * server to route incoming WS messages.
 */
export function isDashboardGlobalWorkflowsMessage(
  msg: { type: string } | null | undefined,
): msg is GlobalWorkflowsMessage {
  if (!msg) return false;
  return (
    msg.type === 'dashboard.global-workflows.get' ||
    msg.type === 'dashboard.global-workflows.update'
  );
}

export class DashboardGlobalWorkflowsHandler {
  private readonly deps: DashboardGlobalWorkflowsHandlerDeps;
  private readonly accessLog: AccessLogWriter | undefined;

  constructor(deps: DashboardGlobalWorkflowsHandlerDeps) {
    this.deps = deps;
    this.accessLog = deps.accessLog;
  }

  /** Update the customer / org id this handler operates on. */
  setOrgId(customerId: string | null): void {
    this.deps.customerId = customerId ?? '';
  }

  /**
   * Defense-in-depth dashboard-write policy gate. Returns true when the
   * operation is allowed; false (with a structured `operation_disabled`
   * envelope and a `denied` access_log row) when policy says no.
   */
  private async enforcePolicy(
    msg: { actor: ActorPrincipal; requestId: string },
    op: DashboardWriteOperation,
    responseType: string,
    action: AccessLogAction,
    target: { type: AccessLogTargetType; id: string } | null,
  ): Promise<boolean> {
    if (!this.deps.customerId) return true;
    try {
      await assertDashboardWriteAllowed(this.deps.db, this.deps.customerId, op);
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
      orgId: this.deps.customerId || null,
      routingKey: null,
      actor,
      action,
      target,
      requestId,
      source: 'platform_proxy',
      outcome,
      errorMessage: errorMessage ?? null,
    });
  }

  async handleMessage(msg: GlobalWorkflowsMessage): Promise<boolean> {
    switch (msg.type) {
      case 'dashboard.global-workflows.get':
        await this.handleGet(msg);
        return true;
      case 'dashboard.global-workflows.update':
        await this.handleUpdate(msg);
        return true;
      default:
        return false;
    }
  }

  private async handleGet(msg: GlobalWorkflowsGetRequest): Promise<void> {
    try {
      const row = await this.readRow();
      this.recordAccess(
        msg.actor,
        'global_workflows.get.read',
        { type: 'environment', id: this.deps.customerId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.global-workflows.get.response',
        requestId: msg.requestId,
        settings: rowToSettings(this.deps.customerId, row),
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'global_workflows.get.read',
        { type: 'environment', id: this.deps.customerId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.global-workflows.get.response', msg.requestId, err);
    }
  }

  private async handleUpdate(msg: GlobalWorkflowsUpdateRequest): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'global_workflows.update',
        'dashboard.global-workflows.update.response',
        'global_workflows.update',
        { type: 'environment', id: this.deps.customerId },
      ))
    ) {
      return;
    }
    try {
      const existing = await this.readRow();
      const patch = buildPatch(existing, msg);
      await this.upsertRow(patch);
      const updated = await this.readRow();
      this.recordAccess(
        msg.actor,
        'global_workflows.update',
        { type: 'environment', id: this.deps.customerId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.global-workflows.update.response',
        requestId: msg.requestId,
        settings: rowToSettings(this.deps.customerId, updated),
      });
    } catch (err) {
      this.recordAccess(
        msg.actor,
        'global_workflows.update',
        { type: 'environment', id: this.deps.customerId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.sendError('dashboard.global-workflows.update.response', msg.requestId, err);
    }
  }

  private async readRow(): Promise<OrgSettings | undefined> {
    return this.deps.db
      .selectFrom('org_settings')
      .selectAll()
      .where('customer_id', '=', this.deps.customerId)
      .executeTakeFirst();
  }

  private async upsertRow(patch: NormalizedPatch): Promise<void> {
    // jsonb columns: pass arrays through the Kysely json helper. The
    // OrgSettingsTable type accepts `string` on insert (a stringified jsonb
    // payload) so we serialise explicitly to avoid driver-dependent
    // implicit coercion.
    const allowed = patch.allowedRepos === null ? null : JSON.stringify(patch.allowedRepos);
    const denied = patch.deniedRepos === null ? null : JSON.stringify(patch.deniedRepos);
    const elevated = patch.elevatedRepos === null ? null : JSON.stringify(patch.elevatedRepos);
    await this.deps.db
      .insertInto('org_settings')
      .values({
        customer_id: this.deps.customerId,
        global_workflows_enabled: patch.enabled,
        global_workflow_allowed_repos: allowed,
        global_workflow_denied_repos: denied,
        global_workflow_elevated_repos: elevated,
      })
      .onConflict((oc) =>
        oc.column('customer_id').doUpdateSet({
          global_workflows_enabled: patch.enabled,
          global_workflow_allowed_repos: allowed,
          global_workflow_denied_repos: denied,
          global_workflow_elevated_repos: elevated,
          // Bump updated_at via a raw SQL expression; the generated type
          // for the column expects a Date, but the DB-side `now()` is the
          // operationally correct value.
          updated_at: sql<Date>`now()`,
        }),
      )
      .execute();
  }

  private sendError(type: string, requestId: string, err: unknown): void {
    const message = toErrorMessage(err);
    logger.error(`Error handling ${type}`, { requestId, error: message });
    this.deps.send({ type, requestId, error: message });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

interface NormalizedPatch {
  enabled: boolean;
  allowedRepos: RepoPatternEntry[] | null;
  deniedRepos: RepoPatternEntry[] | null;
  elevatedRepos: RepoPatternEntry[] | null;
}

/**
 * Derive the effective storage state from an existing row (may be undefined)
 * plus a partial update message. Unset fields fall back to the existing value;
 * an explicit `null` clears the corresponding column.
 */
export function buildPatch(
  existing: OrgSettings | undefined,
  msg: GlobalWorkflowsUpdateRequest,
): NormalizedPatch {
  const start: NormalizedPatch = {
    enabled: existing?.global_workflows_enabled ?? false,
    allowedRepos: existing?.global_workflow_allowed_repos ?? null,
    deniedRepos: existing?.global_workflow_denied_repos ?? null,
    elevatedRepos: existing?.global_workflow_elevated_repos ?? null,
  };

  if (msg.enabled !== undefined) start.enabled = msg.enabled;
  if (msg.allowedRepos !== undefined) start.allowedRepos = msg.allowedRepos;
  if (msg.deniedRepos !== undefined) start.deniedRepos = msg.deniedRepos;
  if (msg.elevatedRepos !== undefined) start.elevatedRepos = msg.elevatedRepos;

  return start;
}

/**
 * Project a row into the public settings shape. Returns a defaulted "disabled"
 * settings object when the row does not yet exist, so callers always get a
 * renderable state.
 */
export function rowToSettings(
  customerId: string,
  row: OrgSettings | undefined,
): GlobalWorkflowSettings {
  if (!row) {
    return {
      customerId,
      enabled: false,
      allowedRepos: null,
      deniedRepos: null,
      elevatedRepos: null,
      createdAt: null,
      updatedAt: null,
    };
  }
  return {
    customerId,
    enabled: row.global_workflows_enabled,
    allowedRepos: row.global_workflow_allowed_repos,
    deniedRepos: row.global_workflow_denied_repos,
    elevatedRepos: row.global_workflow_elevated_repos,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}
