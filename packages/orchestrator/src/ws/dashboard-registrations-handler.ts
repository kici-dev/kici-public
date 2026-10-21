/**
 * Answers dashboard.registrations.list from the registration store, enriched
 * with last-triggered timestamps (execution_runs) and schedule next-fire times
 * (croner).
 */
import { Cron } from 'croner';
import {
  COMPILE_SCHEMA_VERSION,
  createLogger,
  lockCompileSchema,
  toErrorMessage,
} from '@kici-dev/shared';
import type { Kysely } from 'kysely';
import {
  SourceSubtype,
  TERMINAL_RUN_STATES,
  type AccessLogAction,
  type AccessLogTargetType,
  type ActorPrincipal,
  type LockTrigger,
  type LockBranchPattern,
  toIsoString,
} from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import type { RegistrationStore, RegistrationRow } from '../registration/registration-store.js';
import type { RegistrationIndex } from '../registration/registration-index.js';
import { definingRepoOfRun, runsDefinedByRepos } from '../registration/registration-run-match.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import { genericProviderTypeToSubtype } from '../entry-helpers.js';
import { cleanupPendingJobContexts } from '../pipeline/processor.js';
import type { DashboardWriteOperation } from '@kici-dev/engine/protocol/dashboard-write-operations';
import {
  assertDashboardWriteAllowed,
  buildPolicyDeniedResponse,
  DashboardWritePolicyDisabledError,
} from '../policy/dashboard-write-policy.js';
import { DashboardAccessRecorder } from './dashboard-access.js';

interface RegistrationSourceMetadata {
  routingKey: string;
  name: string | null;
  subtype: SourceSubtype | null;
  provider: string;
}

const logger = createLogger({ prefix: 'dashboard-registrations-handler' });

interface DashboardRegistrationsHandlerDeps {
  orgId: string;
  send: (msg: unknown) => void;
  registrationStore: RegistrationStore;
  registrationIndex: RegistrationIndex;
  db: Kysely<Database>;
  /** Records one row per read / mutation with actor attribution. */
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
  RegistrationsListMessage | RegistrationDisableMessage | RegistrationDeleteMessage;

/** Dashboard registration WS messages: list, disable, delete. */
export class DashboardRegistrationsHandler {
  private readonly deps: DashboardRegistrationsHandlerDeps;
  private routingKey: string | null;
  private readonly access: DashboardAccessRecorder;

  constructor(deps: DashboardRegistrationsHandlerDeps) {
    this.deps = deps;
    this.routingKey = deps.routingKey ?? null;
    this.access = new DashboardAccessRecorder(
      deps.accessLog,
      () => ({ orgId: this.deps.orgId, routingKey: this.routingKey }),
      logger,
    );
  }

  /** Called once the orgId resolves from the DB. */
  setOrgId(orgId: string): void {
    this.deps.orgId = orgId;
  }

  setRoutingKey(routingKey: string | null): void {
    this.routingKey = routingKey;
  }

  /**
   * Defense-in-depth policy gate: false when the policy disables the op, after
   * recording a `denied` row and sending the `operation_disabled` envelope.
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
      const registration = await this.deps.registrationStore.getById(msg.registrationId);
      if (!registration) {
        this.access.record(
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
        this.access.record(
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

      // The version bump triggers a peer reload.
      await this.deps.registrationStore.bumpVersion();
      await this.deps.registrationIndex.loadFromDb();

      const eventType = msg.disabled ? 'registration.disabled' : 'registration.enabled';
      this.deps.send({
        type: eventType,
        registrationId: msg.registrationId,
        workflowName: registration.workflow_name,
      });

      this.access.record(
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
      this.access.record(
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
      if (msg.cancelActiveRuns) {
        const registration = await this.deps.registrationStore.getById(msg.registrationId);
        if (registration) {
          try {
            // Matched on the repository that DEFINES the workflow, so a global
            // registration reaches its own runs and a same-named registration in
            // the acted-on repository does not — see `runsDefinedByRepos`.
            const activeRuns = await this.deps.db
              .selectFrom('execution_runs')
              .select(['run_id'])
              .where('workflow_name', '=', registration.workflow_name)
              .where((eb) => runsDefinedByRepos(eb, [registration.repo_identifier]))
              .where('status', 'not in', [...TERMINAL_RUN_STATES])
              .execute();

            for (const run of activeRuns) {
              await this.deps.db
                .updateTable('execution_runs')
                .set({ status: 'cancelled', completed_at: new Date() })
                .where('run_id', '=', run.run_id)
                .execute();
              // The direct UPDATE bypasses the execution tracker, so neither
              // `onExecutionComplete` nor `onRunTerminalCleanup` fires; without
              // this, the pending job contexts of the cancelled run's needs-gated
              // jobs would outlive it.
              await cleanupPendingJobContexts(this.deps.db, run.run_id);
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
        this.access.record(
          msg.actor,
          'registration.delete',
          { type: 'registration', id: msg.registrationId },
          msg.requestId,
          'allowed',
          'registration not found',
        );
        // Same not-found signalling as disable: no `error` field.
        this.deps.send({
          type: 'dashboard.registration.delete.result',
          requestId: msg.requestId,
          success: false,
        });
        return;
      }

      await this.deps.registrationStore.bumpVersion();
      await this.deps.registrationIndex.loadFromDb();

      this.access.record(
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
      this.access.record(
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
   * Source metadata keyed on `routing_key`, from `sources` (native, currently
   * always GitHub Apps) and `generic_webhook_sources` (generic / universal-git /
   * internal); the native row wins when a key is in both. Each query fails on
   * its own, so one table's transient failure still enriches from the other;
   * keys missing from both get the synthetic fallback in `buildRegistrationSource`.
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
      let registrations: RegistrationRow[];
      if (msg.repoIdentifier) {
        registrations = (await this.deps.registrationStore.getAll()).filter(
          (r) => r.repo_identifier === msg.repoIdentifier,
        );
      } else {
        registrations = await this.deps.registrationStore.getAll();
      }

      if (msg.triggerType) {
        registrations = registrations.filter((r) => r.trigger_types.includes(msg.triggerType!));
      }

      const lastTriggeredMap = new Map<string, Date>();
      if (registrations.length > 0) {
        try {
          const repoIds = [...new Set(registrations.map((r) => r.repo_identifier))];
          // Folded to the DEFINING repository below, so a global workflow's runs
          // land under its defining registration, not the repository they acted
          // on — see `runsDefinedByRepos`.
          const lastTriggered = await this.deps.db
            .selectFrom('execution_runs')
            .select(['workflow_name', 'repo_identifier', 'workflow_repo_identifier'])
            .select((eb) => eb.fn.max('started_at').as('last_triggered_at'))
            .where((eb) => runsDefinedByRepos(eb, repoIds))
            .groupBy(['workflow_name', 'repo_identifier', 'workflow_repo_identifier'])
            .execute();

          for (const row of lastTriggered) {
            const key = `${definingRepoOfRun(row)}:${row.workflow_name}`;
            if (row.last_triggered_at) {
              const startedAt =
                row.last_triggered_at instanceof Date
                  ? row.last_triggered_at
                  : new Date(String(row.last_triggered_at));
              // Two groups can fold onto one key (a per-repository run and a global
              // run acting on a third repository, both defined here): keep the later.
              const existing = lastTriggeredMap.get(key);
              if (!existing || startedAt > existing) {
                lastTriggeredMap.set(key, startedAt);
              }
            }
          }
        } catch {
          // Last triggered stays null.
          logger.warn('Failed to fetch last-triggered timestamps');
        }
      }

      const cronLastFiredMap = new Map<string, Date>();
      const scheduleRegIds = registrations
        .filter((r) => r.trigger_types.includes('schedule'))
        .map((r) => r.id);

      if (scheduleRegIds.length > 0) {
        try {
          // One cron_last_fired row per schedule() trigger: "last triggered from
          // cron" is the MAX across a registration's schedules.
          const cronRows = await this.deps.db
            .selectFrom('cron_last_fired')
            .select(['registration_id'])
            .select((eb) => eb.fn.max('last_fired_at').as('last_fired_at'))
            .where('registration_id', 'in', scheduleRegIds)
            .groupBy('registration_id')
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

      const sourceMetaMap = await this.loadSourceMetadata(registrations);

      const items = registrations.map((reg) => {
        const lastTriggeredKey = `${reg.repo_identifier}:${reg.workflow_name}`;
        const lastTriggeredFromRuns = lastTriggeredMap.get(lastTriggeredKey);
        const lastTriggeredFromCron = cronLastFiredMap.get(reg.id);

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
                // Invalid cron expression: no next fire from it.
              }
            }
          }
          if (earliest) {
            nextFireAt = earliest.toISOString();
          }
        }

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
          createdAt: toIsoString(reg.created_at),
          updatedAt: toIsoString(reg.updated_at),
          disabled: reg.disabled,
          commitSha: reg.commitSha ?? undefined,
          sourceFile: reg.sourceFile ?? undefined,
          source: buildRegistrationSource(reg.routing_key, sourceMetaMap),
          isGlobal: reg.isGlobal,
          compileSchemaVersion: lockCompileSchema(reg.lock_entry),
          agentCompileSchemaVersion: COMPILE_SCHEMA_VERSION,
        };
      });

      this.access.record(
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
      this.access.record(
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
 * Null when the registration has no routing key (legacy / global-workflow
 * rows). A key missing from the map (source row deleted, registration kept)
 * gets a synthetic descriptor with the provider derived from the prefix, so
 * the dashboard still renders a sensible icon.
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

/** Render one repo pattern for display: a regex keeps its delimiters, a glob is literal. */
function formatRepoPattern(pattern: LockBranchPattern): string {
  return pattern.type === 'regex' ? `/${pattern.pattern}/${pattern.flags ?? ''}` : pattern.pattern;
}

/**
 * Which repos' events feed this workflow: kici_event `source`, lifecycle
 * `sources`, and a global workflow's `repos:` patterns, so a glob (`myorg/*`)
 * and a literal identifier share the set. Exclusions (`!myorg/old-*`) are
 * carried verbatim: the carve-outs are part of the answer.
 */
function extractSourceRepos(triggers: readonly LockTrigger[]): string[] {
  const repos = new Set<string>();
  for (const trigger of triggers) {
    if ('repos' in trigger && trigger.repos) {
      for (const pattern of trigger.repos) {
        repos.add(formatRepoPattern(pattern));
      }
    }
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
