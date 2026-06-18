/**
 * Dashboard registrations handler for the orchestrator.
 *
 * Responds to dashboard.registrations.list WS messages from Platform
 * by querying the registration store, enriching with last-triggered
 * timestamps (from execution_runs) and next-fire times (from croner
 * for schedule triggers), and sending the response.
 */
import { Cron } from 'croner';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { Kysely } from 'kysely';
import {
  SourceSubtype,
  type AccessLogAction,
  type AccessLogOutcome,
  type AccessLogTargetType,
  type ActorPrincipal,
  type LockTrigger,
} from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import type { RegistrationStore, RegistrationRow } from '../registration/registration-store.js';
import type { RegistrationIndex } from '../registration/registration-index.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import { genericProviderTypeToSubtype } from '../entry-helpers.js';
import type { DashboardWriteOperation } from '@kici-dev/engine/protocol/dashboard-write-operations';
import {
  assertDashboardWriteAllowed,
  buildPolicyDeniedResponse,
  DashboardWritePolicyDisabledError,
} from '../policy/dashboard-write-policy.js';

interface RegistrationSourceMetadata {
  routingKey: string;
  name: string | null;
  subtype: SourceSubtype | null;
  provider: string;
}

const logger = createLogger({ prefix: 'dashboard-registrations-handler' });

interface DashboardRegistrationsHandlerDeps {
  /** Organization ID for all operations. */
  orgId: string;
  /** Send a response message back to Platform over the WS connection. */
  send: (msg: unknown) => void;
  /** Registration store for DB queries. */
  registrationStore: RegistrationStore;
  /** Registration index for version info. */
  registrationIndex: RegistrationIndex;
  /** Database for execution_runs and cron_last_fired queries. */
  db: Kysely<Database>;
  /** Access log writer — records one row per read / mutation with actor attribution. */
  accessLog?: AccessLogWriter;
  /** Routing key for access_log rows (null when not run-scoped). */
  routingKey?: string | null;
}

interface RegistrationsListMessage {
  type: 'dashboard.registrations.list';
  requestId: string;
  actor: ActorPrincipal;
  triggerType?: string;
  repoIdentifier?: string;
}

interface RegistrationDisableMessage {
  type: 'dashboard.registration.disable';
  requestId: string;
  actor: ActorPrincipal;
  registrationId: string;
  disabled: boolean;
}

interface RegistrationDeleteMessage {
  type: 'dashboard.registration.delete';
  requestId: string;
  actor: ActorPrincipal;
  registrationId: string;
  cancelActiveRuns?: boolean;
}

type RegistrationMessage =
  | RegistrationsListMessage
  | RegistrationDisableMessage
  | RegistrationDeleteMessage;

/**
 * Handler for dashboard registration WS messages (list, disable, delete).
 *
 * Queries registration store, enriches with last-triggered and next-fire data,
 * and sends typed response via deps.send().
 */
export class DashboardRegistrationsHandler {
  private readonly deps: DashboardRegistrationsHandlerDeps;
  private routingKey: string | null;
  private readonly accessLog: AccessLogWriter | undefined;

  constructor(deps: DashboardRegistrationsHandlerDeps) {
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
   * operation is allowed and the caller should proceed. Returns false
   * when the policy is disabled — also records a `denied` access_log row
   * and emits a structured `operation_disabled` envelope on the WS.
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

  async handle(msg: RegistrationMessage): Promise<void> {
    switch (msg.type) {
      case 'dashboard.registrations.list':
        return this.handleList(msg);
      case 'dashboard.registration.disable':
        return this.handleDisable(msg);
      case 'dashboard.registration.delete':
        return this.handleDelete(msg);
    }
  }

  private async handleDisable(msg: RegistrationDisableMessage): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'registration.disable',
        'dashboard.registration.disable.result',
        'registration.disable',
        { type: 'registration', id: msg.registrationId },
      ))
    ) {
      return;
    }
    try {
      // Look up the registration to get the workflow name for the push event
      const registration = await this.deps.registrationStore.getById(msg.registrationId);
      if (!registration) {
        this.recordAccess(
          msg.actor,
          'registration.disable',
          { type: 'registration', id: msg.registrationId },
          msg.requestId,
          'allowed',
          'registration not found',
        );
        // Not-found is signalled by `success: false` alone — the `error`
        // field is the internal-error channel, which the Platform maps to
        // HTTP 500. Omitting it lets the Platform serve a structured 404.
        this.deps.send({
          type: 'dashboard.registration.disable.result',
          requestId: msg.requestId,
          success: false,
        });
        return;
      }

      const updated = await this.deps.registrationStore.setDisabled(
        msg.registrationId,
        msg.disabled,
      );
      if (!updated) {
        this.recordAccess(
          msg.actor,
          'registration.disable',
          { type: 'registration', id: msg.registrationId },
          msg.requestId,
          'allowed',
          'registration not found',
        );
        // Same not-found signalling as above: no `error` field.
        this.deps.send({
          type: 'dashboard.registration.disable.result',
          requestId: msg.requestId,
          success: false,
        });
        return;
      }

      // Bump version to trigger peer reload
      await this.deps.registrationStore.bumpVersion();
      await this.deps.registrationIndex.loadFromDb();

      // Emit push event for real-time UI updates
      const eventType = msg.disabled ? 'registration.disabled' : 'registration.enabled';
      this.deps.send({
        type: eventType,
        registrationId: msg.registrationId,
        workflowName: registration.workflow_name,
      });

      this.recordAccess(
        msg.actor,
        'registration.disable',
        { type: 'registration', id: msg.registrationId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.registration.disable.result',
        requestId: msg.requestId,
        success: true,
      });
    } catch (err) {
      const message = toErrorMessage(err);
      logger.error('Error handling dashboard.registration.disable', {
        requestId: msg.requestId,
        registrationId: msg.registrationId,
        error: message,
      });
      this.recordAccess(
        msg.actor,
        'registration.disable',
        { type: 'registration', id: msg.registrationId },
        msg.requestId,
        'error',
        message,
      );
      this.deps.send({
        type: 'dashboard.registration.disable.result',
        requestId: msg.requestId,
        success: false,
        error: message,
      });
    }
  }

  private async handleDelete(msg: RegistrationDeleteMessage): Promise<void> {
    if (
      !(await this.enforcePolicy(
        msg,
        'registration.delete',
        'dashboard.registration.delete.result',
        'registration.delete',
        { type: 'registration', id: msg.registrationId },
      ))
    ) {
      return;
    }
    try {
      // If cancelActiveRuns, cancel active runs for this workflow
      if (msg.cancelActiveRuns) {
        const registration = await this.deps.registrationStore.getById(msg.registrationId);
        if (registration) {
          try {
            // Find active runs and cancel them
            const activeRuns = await this.deps.db
              .selectFrom('execution_runs')
              .select(['run_id'])
              .where('workflow_name', '=', registration.workflow_name)
              .where('repo_identifier', '=', registration.repo_identifier)
              .where('status', 'not in', ['success', 'failed', 'cancelled', 'skipped'])
              .execute();

            for (const run of activeRuns) {
              await this.deps.db
                .updateTable('execution_runs')
                .set({ status: 'cancelled', completed_at: new Date() })
                .where('run_id', '=', run.run_id)
                .execute();
            }

            if (activeRuns.length > 0) {
              logger.info('Cancelled active runs for deleted workflow', {
                registrationId: msg.registrationId,
                cancelledCount: activeRuns.length,
              });
            }
          } catch (err) {
            logger.warn('Failed to cancel active runs during registration delete', {
              registrationId: msg.registrationId,
              error: toErrorMessage(err),
            });
          }
        }
      }

      const deleted = await this.deps.registrationStore.deleteById(msg.registrationId);
      if (!deleted) {
        this.recordAccess(
          msg.actor,
          'registration.delete',
          { type: 'registration', id: msg.registrationId },
          msg.requestId,
          'allowed',
          'registration not found',
        );
        // Not-found is signalled by `success: false` alone — the `error`
        // field is the internal-error channel, which the Platform maps to
        // HTTP 500. Omitting it lets the Platform serve a structured 404.
        this.deps.send({
          type: 'dashboard.registration.delete.result',
          requestId: msg.requestId,
          success: false,
        });
        return;
      }

      // Bump version to trigger peer reload
      await this.deps.registrationStore.bumpVersion();
      await this.deps.registrationIndex.loadFromDb();

      this.recordAccess(
        msg.actor,
        'registration.delete',
        { type: 'registration', id: msg.registrationId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.registration.delete.result',
        requestId: msg.requestId,
        success: true,
      });
    } catch (err) {
      const message = toErrorMessage(err);
      logger.error('Error handling dashboard.registration.delete', {
        requestId: msg.requestId,
        registrationId: msg.registrationId,
        error: message,
      });
      this.recordAccess(
        msg.actor,
        'registration.delete',
        { type: 'registration', id: msg.registrationId },
        msg.requestId,
        'error',
        message,
      );
      this.deps.send({
        type: 'dashboard.registration.delete.result',
        requestId: msg.requestId,
        success: false,
        error: message,
      });
    }
  }

  /**
   * Batch-fetch source metadata for the routing keys in the registrations,
   * keyed on `routing_key`. The map combines rows from `sources` (native,
   * currently always GitHub Apps) and `generic_webhook_sources` (generic /
   * universal-git / internal). When a routing key is present in both, the
   * native row wins.
   *
   * Each query is wrapped in its own try/catch so a transient failure on
   * one table still allows enrichment from the other; rows missing in both
   * fall through to the synthetic fallback in `buildRegistrationSource`.
   */
  private async loadSourceMetadata(
    registrations: RegistrationRow[],
  ): Promise<Map<string, RegistrationSourceMetadata>> {
    const result = new Map<string, RegistrationSourceMetadata>();
    const routingKeys = [
      ...new Set(registrations.map((r) => r.routing_key).filter((rk) => rk.length > 0)),
    ];
    if (routingKeys.length === 0) return result;

    try {
      const genericRows = await this.deps.db
        .selectFrom('generic_webhook_sources')
        .select(['routing_key', 'name', 'provider_type', 'git_config'])
        .where('deleted_at', 'is', null)
        .where('routing_key', 'in', routingKeys)
        .execute();
      for (const row of genericRows) {
        const subtype = genericProviderTypeToSubtype(row.provider_type, {
          hasGitConfig: row.git_config !== null,
        });
        result.set(row.routing_key, {
          routingKey: row.routing_key,
          name: row.name,
          subtype,
          provider: 'generic',
        });
      }
    } catch (err) {
      logger.warn('Failed to fetch generic_webhook_sources metadata', {
        error: toErrorMessage(err),
      });
    }

    try {
      const nativeRows = await this.deps.db
        .selectFrom('sources')
        .select(['routing_key', 'name', 'provider'])
        .where('routing_key', 'in', routingKeys)
        .execute();
      for (const row of nativeRows) {
        result.set(row.routing_key, {
          routingKey: row.routing_key,
          name: row.name,
          subtype: SourceSubtype.enum.github_app,
          provider: row.provider,
        });
      }
    } catch (err) {
      logger.warn('Failed to fetch sources metadata', { error: toErrorMessage(err) });
    }

    return result;
  }

  private async handleList(msg: RegistrationsListMessage): Promise<void> {
    try {
      // 1. Fetch registrations
      let registrations: RegistrationRow[];
      if (msg.repoIdentifier) {
        // Without customer scoping, get all and filter by repo
        registrations = (await this.deps.registrationStore.getAll()).filter(
          (r) => r.repo_identifier === msg.repoIdentifier,
        );
      } else {
        registrations = await this.deps.registrationStore.getAll();
      }

      // 2. Filter by trigger type if provided
      if (msg.triggerType) {
        registrations = registrations.filter((r) => r.trigger_types.includes(msg.triggerType!));
      }

      // 3. Batch-fetch last-triggered timestamps from execution_runs
      const lastTriggeredMap = new Map<string, Date>();
      if (registrations.length > 0) {
        try {
          const repoIds = [...new Set(registrations.map((r) => r.repo_identifier))];
          const lastTriggered = await this.deps.db
            .selectFrom('execution_runs')
            .select(['workflow_name', 'repo_identifier'])
            .select((eb) => eb.fn.max('started_at').as('last_triggered_at'))
            .where('repo_identifier', 'in', repoIds)
            .groupBy(['workflow_name', 'repo_identifier'])
            .execute();

          for (const row of lastTriggered) {
            const key = `${row.repo_identifier}:${row.workflow_name}`;
            if (row.last_triggered_at) {
              lastTriggeredMap.set(
                key,
                row.last_triggered_at instanceof Date
                  ? row.last_triggered_at
                  : new Date(String(row.last_triggered_at)),
              );
            }
          }
        } catch {
          // execution_runs query failed; last triggered will be null
          logger.warn('Failed to fetch last-triggered timestamps');
        }
      }

      // 4. Fetch cron_last_fired for schedule registrations
      const cronLastFiredMap = new Map<string, Date>();
      const scheduleRegIds = registrations
        .filter((r) => r.trigger_types.includes('schedule'))
        .map((r) => r.id);

      if (scheduleRegIds.length > 0) {
        try {
          const cronRows = await this.deps.db
            .selectFrom('cron_last_fired')
            .select(['registration_id', 'last_fired_at'])
            .where('registration_id', 'in', scheduleRegIds)
            .execute();

          for (const row of cronRows) {
            cronLastFiredMap.set(
              row.registration_id,
              row.last_fired_at instanceof Date
                ? row.last_fired_at
                : new Date(String(row.last_fired_at)),
            );
          }
        } catch {
          logger.warn('Failed to fetch cron last-fired timestamps');
        }
      }

      // 5. Get registry version
      let registryVersion = 0;
      let registryUpdatedAt = new Date().toISOString();
      try {
        const versionRow = await this.deps.db
          .selectFrom('registry_versions')
          .selectAll()
          .where('id', '=', 'default')
          .executeTakeFirst();

        if (versionRow) {
          registryVersion = versionRow.version;
          registryUpdatedAt =
            versionRow.updated_at instanceof Date
              ? versionRow.updated_at.toISOString()
              : String(versionRow.updated_at);
        }
      } catch {
        logger.warn('Failed to fetch registry version');
      }

      // 6. Batch-fetch source metadata keyed by routing_key. We look in both
      //    `sources` (native — currently always GitHub Apps) and
      //    `generic_webhook_sources` (generic / universal-git / internal). When
      //    a routing key exists in both we prefer the native row.
      const sourceMetaMap = await this.loadSourceMetadata(registrations);

      // 7. Build enriched registration items
      const items = registrations.map((reg) => {
        const lastTriggeredKey = `${reg.repo_identifier}:${reg.workflow_name}`;
        const lastTriggeredFromRuns = lastTriggeredMap.get(lastTriggeredKey);
        const lastTriggeredFromCron = cronLastFiredMap.get(reg.id);

        // Pick the most recent of runs vs cron
        let lastTriggeredAt: string | null = null;
        if (lastTriggeredFromRuns && lastTriggeredFromCron) {
          const latest =
            lastTriggeredFromRuns > lastTriggeredFromCron
              ? lastTriggeredFromRuns
              : lastTriggeredFromCron;
          lastTriggeredAt = latest.toISOString();
        } else if (lastTriggeredFromRuns) {
          lastTriggeredAt = lastTriggeredFromRuns.toISOString();
        } else if (lastTriggeredFromCron) {
          lastTriggeredAt = lastTriggeredFromCron.toISOString();
        }

        // Compute next fire for schedule triggers
        let nextFireAt: string | null = null;
        const scheduleTriggers = reg.lock_entry.triggers.filter(
          (t: LockTrigger) => t._type === 'schedule',
        );
        if (scheduleTriggers.length > 0) {
          let earliest: Date | null = null;
          for (const trigger of scheduleTriggers) {
            if (trigger._type === 'schedule') {
              try {
                const cron = new Cron(trigger.cronExpression, { timezone: trigger.timezone });
                const next = cron.nextRun();
                if (next && (!earliest || next < earliest)) {
                  earliest = next;
                }
              } catch {
                // Invalid cron expression; skip
              }
            }
          }
          if (earliest) {
            nextFireAt = earliest.toISOString();
          }
        }

        // Extract source repos from triggers (kici_event, workflow_complete, etc.)
        const sourceRepos = extractSourceRepos(reg.lock_entry.triggers);

        return {
          id: reg.id,
          repoIdentifier: reg.repo_identifier,
          workflowName: reg.workflow_name,
          triggerTypes: reg.trigger_types,
          triggers: reg.lock_entry.triggers as unknown[],
          lastTriggeredAt,
          nextFireAt,
          sourceRepos,
          createdAt:
            reg.created_at instanceof Date ? reg.created_at.toISOString() : String(reg.created_at),
          updatedAt:
            reg.updated_at instanceof Date ? reg.updated_at.toISOString() : String(reg.updated_at),
          disabled: reg.disabled,
          commitSha: reg.commitSha ?? undefined,
          sourceFile: reg.sourceFile ?? undefined,
          source: buildRegistrationSource(reg.routing_key, sourceMetaMap),
        };
      });

      this.recordAccess(
        msg.actor,
        'registration.list.read',
        { type: 'registration', id: this.deps.orgId },
        msg.requestId,
        'allowed',
      );
      this.deps.send({
        type: 'dashboard.registrations.list.response',
        requestId: msg.requestId,
        registrations: items,
        registryVersion,
        registryUpdatedAt,
      });
    } catch (err) {
      const message = toErrorMessage(err);
      logger.error('Error handling dashboard.registrations.list', {
        requestId: msg.requestId,
        error: message,
      });
      this.recordAccess(
        msg.actor,
        'registration.list.read',
        { type: 'registration', id: this.deps.orgId },
        msg.requestId,
        'error',
        message,
      );
      this.deps.send({
        type: 'dashboard.registrations.list.response',
        requestId: msg.requestId,
        registryVersion: 0,
        registryUpdatedAt: new Date().toISOString(),
        error: message,
      });
    }
  }
}

/**
 * Build the per-registration `source` payload. Returns null when the
 * registration has no routing key (legacy / global-workflow rows). When the
 * routing key is present but missing from the metadata map (the source row
 * was deleted but the registration still exists), returns a synthetic
 * descriptor with provider derived from the prefix so the dashboard can
 * still render a sensible icon.
 */
function buildRegistrationSource(
  routingKey: string | null | undefined,
  sourceMap: Map<string, RegistrationSourceMetadata>,
): RegistrationSourceMetadata | null {
  if (!routingKey || routingKey.length === 0) return null;
  const meta = sourceMap.get(routingKey);
  if (meta) return meta;
  const colonIdx = routingKey.indexOf(':');
  const provider = colonIdx > 0 ? routingKey.slice(0, colonIdx) : 'unknown';
  return { routingKey, name: null, subtype: null, provider };
}

/**
 * Extract source repos from triggers that reference external repos.
 * kici_event triggers have a `source` field, lifecycle triggers have `sources`.
 */
function extractSourceRepos(triggers: readonly LockTrigger[]): string[] {
  const repos = new Set<string>();
  for (const trigger of triggers) {
    if (trigger._type === 'kici_event' && trigger.source) {
      repos.add(trigger.source);
    }
    if (trigger._type === 'workflow_complete' && trigger.source) {
      repos.add(trigger.source);
    }
    if (trigger._type === 'job_complete' && trigger.source) {
      repos.add(trigger.source);
    }
    if (trigger._type === 'lifecycle' && trigger.sources) {
      for (const src of trigger.sources) {
        repos.add(src);
      }
    }
  }
  return [...repos];
}
