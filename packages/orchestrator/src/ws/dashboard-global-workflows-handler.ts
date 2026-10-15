/**
 * Handles `dashboard.global-workflows.*` WS messages from Platform by reading or
 * upserting the `org_settings` row keyed by `customer_id`. The row holds the per-org
 * repo-pattern lists (allow / deny) of `{routingKey?, pattern}` entries; `routingKey`
 * optionally pins an entry to one source. The fleet-wide master switch
 * (`cluster_settings.global_workflows_enabled`) is read-only here: projected as
 * `enabled`, never written.
 *
 * `customerId` binds at construction (from the sources / generic_webhook_sources lookup
 * at server startup) and updates via setOrgId() when a real customer source registers.
 */
import { sql, type Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { AccessLogAction, AccessLogTargetType, ActorPrincipal } from '@kici-dev/engine';
import type {
  GlobalWorkflowsGetRequest,
  GlobalWorkflowsUpdateRequest,
  GlobalWorkflowSettings,
  RepoPatternEntry,
} from '@kici-dev/engine/protocol/dashboard-global-workflows';
import { invalidRepoPatternReason } from '@kici-dev/engine/protocol/dashboard-global-workflows';
import type { Database, OrgSettings } from '../db/types.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import type { ClusterSettingsReader } from '../cluster/cluster-settings-reader.js';
import type { DashboardWriteOperation } from '@kici-dev/engine/protocol/dashboard-write-operations';
import {
  assertDashboardWriteAllowed,
  buildPolicyDeniedResponse,
  DashboardWritePolicyDisabledError,
} from '../policy/dashboard-write-policy.js';
import { DashboardAccessRecorder } from './dashboard-access.js';
import { toIsoString } from '@kici-dev/engine';

const logger = createLogger({ prefix: 'dashboard-global-workflows-handler' });

interface DashboardGlobalWorkflowsHandlerDeps {
  /** Primary key on org_settings. */
  customerId: string;
  send: (msg: unknown) => void;
  db: Kysely<Database>;
  /** Reads the fleet-wide master switch for the read-only `enabled` projection. */
  clusterSettings: ClusterSettingsReader;
  /** Applies when the cluster column is NULL — `config.globalWorkflowsEnabled`. */
  globalWorkflowsEnabledDefault: boolean;
  /** Records one row per read / mutation with actor attribution. */
  accessLog?: AccessLogWriter;
}

type GlobalWorkflowsMessage = GlobalWorkflowsGetRequest | GlobalWorkflowsUpdateRequest;

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
  private readonly access: DashboardAccessRecorder;

  constructor(deps: DashboardGlobalWorkflowsHandlerDeps) {
    this.deps = deps;
    this.access = new DashboardAccessRecorder(
      deps.accessLog,
      () => ({ orgId: this.deps.customerId || null, routingKey: null }),
      logger,
    );
  }

  setOrgId(customerId: string | null): void {
    this.deps.customerId = customerId ?? '';
  }

  /**
   * Defense-in-depth dashboard-write policy gate. On denial it sends a structured
   * `operation_disabled` envelope, writes a `denied` access_log row and returns false.
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
        this.access.record(
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
      this.access.record(
        msg.actor,
        'global_workflows.get.read',
        { type: 'context', id: this.deps.customerId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.global-workflows.get.response',
        requestId: msg.requestId,
        settings: rowToSettings(this.deps.customerId, row, await this.effectiveEnabled()),
      });
    } catch (err) {
      this.access.record(
        msg.actor,
        'global_workflows.get.read',
        { type: 'context', id: this.deps.customerId },
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
        { type: 'context', id: this.deps.customerId },
      ))
    ) {
      return;
    }
    const patternError = firstInvalidPattern(msg);
    if (patternError) {
      this.access.record(
        msg.actor,
        'global_workflows.update',
        { type: 'context', id: this.deps.customerId },
        msg.requestId,
        'error',
        patternError,
      );
      this.sendClientError(
        'dashboard.global-workflows.update.response',
        msg.requestId,
        patternError,
      );
      return;
    }
    try {
      const existing = await this.readRow();
      const patch = buildPatch(existing, msg);
      await this.upsertRow(patch);
      const updated = await this.readRow();
      this.access.record(
        msg.actor,
        'global_workflows.update',
        { type: 'context', id: this.deps.customerId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.global-workflows.update.response',
        requestId: msg.requestId,
        settings: rowToSettings(this.deps.customerId, updated, await this.effectiveEnabled()),
      });
    } catch (err) {
      this.access.record(
        msg.actor,
        'global_workflows.update',
        { type: 'context', id: this.deps.customerId },
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

  /**
   * The effective master switch, rendered by the dashboard as a status badge.
   *
   * Uses the shared 10s-cached reader, unlike the admin route, which reads uncached for
   * set-then-show. A badge up to 10s stale is fine; an uncached read per poll is not.
   *
   * An unreadable row resolves to the configured default rather than failing closed:
   * this only drives the UI, and the actual gate, `GlobalWorkflowPolicy`, fails closed.
   */
  private async effectiveEnabled(): Promise<boolean> {
    const read = await this.deps.clusterSettings.tryGetBoolean('global_workflows_enabled');
    if (!read.ok) return this.deps.globalWorkflowsEnabledDefault;
    return read.value ?? this.deps.globalWorkflowsEnabledDefault;
  }

  private async upsertRow(patch: NormalizedPatch): Promise<void> {
    // jsonb columns: serialise arrays with JSON.stringify. The
    // OrgSettingsTable type accepts `string` on insert (a stringified jsonb
    // payload) so we serialise explicitly to avoid driver-dependent
    // implicit coercion.
    const allowed = patch.allowedRepos === null ? null : JSON.stringify(patch.allowedRepos);
    const denied = patch.deniedRepos === null ? null : JSON.stringify(patch.deniedRepos);
    await this.deps.db
      .insertInto('org_settings')
      .values({
        customer_id: this.deps.customerId,
        global_workflow_allowed_repos: allowed,
        global_workflow_denied_repos: denied,
      })
      .onConflict((oc) =>
        oc.column('customer_id').doUpdateSet({
          global_workflow_allowed_repos: allowed,
          global_workflow_denied_repos: denied,
          // The generated type expects a Date, but the DB-side `now()` is the correct value.
          updated_at: sql<Date>`now()`,
        }),
      )
      .execute();
  }

  /**
   * `sendError`'s envelope for bad client input, logged at warn: it is not a server
   * fault, and error-level rows would pollute the operator's error dashboards.
   */
  private sendClientError(type: string, requestId: string, message: string): void {
    logger.warn(`Rejected ${type.replace('.response', '')}`, { requestId, error: message });
    this.deps.send({ type, requestId, error: message });
  }

  private sendError(type: string, requestId: string, err: unknown): void {
    const message = toErrorMessage(err);
    logger.error(`Error handling ${type}`, { requestId, error: message });
    this.deps.send({ type, requestId, error: message });
  }
}

interface NormalizedPatch {
  allowedRepos: RepoPatternEntry[] | null;
  deniedRepos: RepoPatternEntry[] | null;
}

/**
 * Names the list, index and pattern of the first negation-form pattern in an update, or
 * null when every entry is storable.
 *
 * The wire schema stays permissive so existing `org_settings` rows keep parsing on read
 * paths; the refusal applies only where a dashboard write would store a new pattern.
 */
function firstInvalidPattern(msg: GlobalWorkflowsUpdateRequest): string | null {
  const lists = [
    ['allowedRepos', msg.allowedRepos],
    ['deniedRepos', msg.deniedRepos],
  ] as const;
  for (const [name, entries] of lists) {
    if (!entries) continue;
    for (const [i, entry] of entries.entries()) {
      const reason = invalidRepoPatternReason(entry.pattern);
      if (reason) return `${name}[${i}] '${entry.pattern}': ${reason}`;
    }
  }
  return null;
}

/** Unset fields keep the existing value; an explicit `null` clears the column. */
export function buildPatch(
  existing: OrgSettings | undefined,
  msg: GlobalWorkflowsUpdateRequest,
): NormalizedPatch {
  const start: NormalizedPatch = {
    allowedRepos: existing?.global_workflow_allowed_repos ?? null,
    deniedRepos: existing?.global_workflow_denied_repos ?? null,
  };

  if (msg.allowedRepos !== undefined) start.allowedRepos = msg.allowedRepos;
  if (msg.deniedRepos !== undefined) start.deniedRepos = msg.deniedRepos;

  return start;
}

/**
 * `enabled` is the effective master switch, supplied by the caller. A missing row
 * projects its lists as null so callers always get a renderable state.
 */
export function rowToSettings(
  customerId: string,
  row: OrgSettings | undefined,
  enabled: boolean,
): GlobalWorkflowSettings {
  if (!row) {
    return {
      customerId,
      enabled,
      allowedRepos: null,
      deniedRepos: null,
      createdAt: null,
      updatedAt: null,
    };
  }
  return {
    customerId,
    enabled,
    allowedRepos: row.global_workflow_allowed_repos,
    deniedRepos: row.global_workflow_denied_repos,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}
