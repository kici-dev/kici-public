import type { LockWorkflow } from '@kici-dev/engine';

import type { RegistrationStore, RegistrationRow } from './registration-store.js';

/**
 * A registered workflow entry with typed fields for fast in-memory lookup.
 */
export interface RegisteredWorkflow {
  id: string;
  repoIdentifier: string;
  workflowName: string;
  lockEntry: LockWorkflow;
  triggerTypes: string[];
  routingKey: string;
  providerContext: Record<string, unknown>;
  disabled: boolean;
  /** Whether this is a global workflow (has repo patterns) */
  isGlobal: boolean;
  /**
   * Customer/org ID that owns this registration. Drives org-scoped lookups
   * via getByOrgAndEvent — cross-org leakage is structurally impossible
   * because the byOrgAndEvent key is namespaced by customerId.
   */
  customerId: string;
  commitSha: string | null;
  sourceFile: string | null;
}

/**
 * In-memory index of workflow registrations with version-based reload.
 *
 * Provides fast lookups by trigger type, customer/repo, and event type.
 * Updates happen only via loadFromDb/refreshIfNeeded -- the index is
 * read-only from the outside.
 */
export class RegistrationIndex {
  /** Current version matching the DB registry_versions counter */
  private version = 0;

  /** Primary index: keyed by `{routingKey}:{repoIdentifier}` */
  private entries = new Map<string, RegisteredWorkflow[]>();

  /** Secondary index: keyed by trigger type for fast event routing */
  private byTriggerType = new Map<string, RegisteredWorkflow[]>();

  /** Tertiary index: global workflows keyed by `{routingKey}:{triggerType}` */
  private globalByTriggerType = new Map<string, RegisteredWorkflow[]>();

  /**
   * Tertiary-b index: global workflows keyed by `{customerId}|{triggerType}`.
   * Used for cross-provider global workflow dispatch within an org — e.g.
   * a universal-git Forgejo source authors a global workflow, a GitHub App
   * source in the same org delivers a push, and the global is dispatched
   * even though the inbound routing key differs from the registration's.
   * Cross-org isolation is structurally enforced by the customer_id prefix.
   */
  private globalByOrgAndTriggerType = new Map<string, RegisteredWorkflow[]>();

  /**
   * Quaternary index: webhook-trigger registrations keyed by
   * `${customerId}|${eventName}`. Drives the cross-source webhook lookup
   * (a generic webhook arriving in org A finds all webhook-trigger
   * registrations in org A whose lock_entry has a matching event). Cross-org
   * isolation is structurally enforced by the customer_id-prefixed key.
   */
  private byOrgAndEvent = new Map<string, RegisteredWorkflow[]>();

  /**
   * Quinary index: registrations keyed by `${customerId}|${repoIdentifier}`.
   * Drives the cross-source repo lookup (phase 28.5): when a generic webhook
   * carries a repository identifier in its payload, the dispatcher looks up
   * registrations for that (org, repo) pair across ALL routing keys and uses
   * each registration's stored `providerContext` + `routingKey` to reach the
   * owning provider bundle (e.g. a github source) for credential minting and
   * trigger evaluation. Cross-org isolation is structurally enforced by the
   * customer_id-prefixed key.
   */
  private byOrgAndRepo = new Map<string, RegisteredWorkflow[]>();

  constructor(private readonly store: RegistrationStore) {}

  /**
   * Bulk load all registrations from the DB store.
   * Rebuilds both in-memory indexes and updates the version.
   */
  async loadFromDb(): Promise<void> {
    // Read version BEFORE rows to avoid TOCTOU: if a version bump happens
    // between these two queries, we end up with newer data + older version
    // (harmless extra refresh) instead of stale data + newer version (missed refresh).
    const version = await this.store.getVersion();
    const rows = await this.store.getAll();

    // Rebuild indexes
    const entries = new Map<string, RegisteredWorkflow[]>();
    const byTriggerType = new Map<string, RegisteredWorkflow[]>();
    const globalByTriggerType = new Map<string, RegisteredWorkflow[]>();
    const globalByOrgAndTriggerType = new Map<string, RegisteredWorkflow[]>();
    const byOrgAndEvent = new Map<string, RegisteredWorkflow[]>();
    const byOrgAndRepo = new Map<string, RegisteredWorkflow[]>();

    for (const row of rows) {
      const registered = rowToRegistered(row);
      const key = `${registered.routingKey}:${registered.repoIdentifier}`;

      // Primary index
      const existing = entries.get(key);
      if (existing) {
        existing.push(registered);
      } else {
        entries.set(key, [registered]);
      }

      // Secondary index by trigger type
      for (const triggerType of registered.triggerTypes) {
        const byType = byTriggerType.get(triggerType);
        if (byType) {
          byType.push(registered);
        } else {
          byTriggerType.set(triggerType, [registered]);
        }
      }

      // Tertiary index: global workflows by `{routingKey}:{triggerType}`
      // and by `{customerId}|{triggerType}` (cross-provider org scope).
      if (registered.isGlobal) {
        for (const triggerType of registered.triggerTypes) {
          const globalKey = `${registered.routingKey}:${triggerType}`;
          const globalList = globalByTriggerType.get(globalKey);
          if (globalList) {
            globalList.push(registered);
          } else {
            globalByTriggerType.set(globalKey, [registered]);
          }

          const orgKey = `${registered.customerId}|${triggerType}`;
          const orgList = globalByOrgAndTriggerType.get(orgKey);
          if (orgList) {
            orgList.push(registered);
          } else {
            globalByOrgAndTriggerType.set(orgKey, [registered]);
          }
        }
      }

      // Quaternary index: webhook-trigger registrations by (customerId, eventName).
      // Walks the lock_entry triggers once and indexes each (customerId, eventName)
      // pair. Non-webhook triggers are skipped entirely so the index never holds
      // anything that doesn't belong to a cross-source dispatch path.
      if (registered.triggerTypes.includes('webhook')) {
        for (const trigger of registered.lockEntry.triggers) {
          if (trigger._type !== 'webhook') continue;
          for (const eventName of trigger.events) {
            const key = `${registered.customerId}|${eventName}`;
            const list = byOrgAndEvent.get(key);
            if (list) list.push(registered);
            else byOrgAndEvent.set(key, [registered]);
          }
        }
      }

      // Quinary index: (customerId, repoIdentifier). Populated for every
      // registration that has a concrete repo (skip repo patterns — those are
      // global workflows without a fixed repo). Drives cross-source dispatch
      // for git-trigger workflows (push, pr, tag, …) when a generic webhook
      // carries the repo identifier in its payload — phase 28.5.
      if (registered.repoIdentifier) {
        const repoKey = `${registered.customerId}|${registered.repoIdentifier}`;
        const repoList = byOrgAndRepo.get(repoKey);
        if (repoList) repoList.push(registered);
        else byOrgAndRepo.set(repoKey, [registered]);
      }
    }

    // Swap atomically
    this.entries = entries;
    this.byTriggerType = byTriggerType;
    this.globalByTriggerType = globalByTriggerType;
    this.globalByOrgAndTriggerType = globalByOrgAndTriggerType;
    this.byOrgAndEvent = byOrgAndEvent;
    this.byOrgAndRepo = byOrgAndRepo;
    this.version = version;
  }

  /**
   * Reload from DB if the remote version is newer than the local version.
   * Called when a peer heartbeat reports a higher registryVersion.
   */
  async refreshIfNeeded(remoteVersion: number): Promise<void> {
    if (remoteVersion > this.version) {
      await this.loadFromDb();
    }
  }

  /**
   * Get the current in-memory version.
   */
  getVersion(): number {
    return this.version;
  }

  /**
   * Look up a single registration by ID (includes disabled entries).
   * Used by manual schedule to distinguish "not found" from "disabled".
   */
  getById(id: string): RegisteredWorkflow | undefined {
    for (const entries of this.entries.values()) {
      for (const entry of entries) {
        if (entry.id === id) return entry;
      }
    }
    return undefined;
  }

  /**
   * Get all workflows registered for a specific trigger type.
   * Used for event routing (e.g., find all workflows listening for 'kici_event').
   */
  getByTriggerType(triggerType: string): RegisteredWorkflow[] {
    const entries = this.byTriggerType.get(triggerType) ?? [];
    return entries.filter((e) => !e.disabled);
  }

  /**
   * Get all workflows registered for a specific routing key and repo.
   */
  getByRoutingKeyAndRepo(routingKey: string, repoIdentifier: string): RegisteredWorkflow[] {
    const key = `${routingKey}:${repoIdentifier}`;
    return this.entries.get(key) ?? [];
  }

  /**
   * Cross-source webhook lookup: return all webhook-trigger registrations
   * within a customer/org that listen for `eventName`.
   *
   * Used by the cross-source dispatch branch in `processWebhook()` so that an
   * inbound generic webhook in org A can fan out to webhook-trigger workflows
   * registered to ANY source in org A. Org isolation is structurally enforced:
   * the lookup key is `${customerId}|${eventName}`, so registrations in a
   * different customer's bucket cannot leak through this method even if the
   * eventName matches.
   *
   * Disabled rows are filtered out, mirroring the other typed lookups.
   */
  getByOrgAndEvent(customerId: string, eventName: string): RegisteredWorkflow[] {
    return (this.byOrgAndEvent.get(`${customerId}|${eventName}`) ?? []).filter((e) => !e.disabled);
  }

  /**
   * Cross-source repo lookup: return all registrations in a given customer/org
   * that target a specific repo identifier, across all routing keys.
   *
   * Used by the cross-source dispatch branch in `processWebhook()` so that a
   * generic webhook carrying `repository.full_name` (or an equivalent payload
   * field) can be routed to git-trigger workflows (push, pr, tag, …) owned by
   * any source in the same org. Each returned registration carries its own
   * `routingKey` + `providerContext`, which the caller uses to resolve the
   * correct provider bundle and mint credentials for the owning provider.
   *
   * Org isolation is structurally enforced: the lookup key is
   * `${customerId}|${repoIdentifier}`, so registrations in a different
   * customer's bucket cannot leak through even if the repo identifier matches.
   *
   * Disabled rows are filtered out, mirroring the other typed lookups.
   */
  getByOrgAndRepo(customerId: string, repoIdentifier: string): RegisteredWorkflow[] {
    return (this.byOrgAndRepo.get(`${customerId}|${repoIdentifier}`) ?? []).filter(
      (e) => !e.disabled,
    );
  }

  /**
   * Get global workflows matching a trigger type within a routing key.
   * Used by the webhook processor for dual-query (per-repo + global).
   */
  getGlobalByTriggerType(triggerType: string, routingKey: string): RegisteredWorkflow[] {
    const key = `${routingKey}:${triggerType}`;
    return (this.globalByTriggerType.get(key) ?? []).filter((e) => !e.disabled);
  }

  /**
   * Get global workflows matching a trigger type within an org, across ALL
   * routing keys. Used by the webhook processor for cross-provider global
   * workflow dispatch.
   */
  getGlobalByOrgAndTriggerType(customerId: string, triggerType: string): RegisteredWorkflow[] {
    const key = `${customerId}|${triggerType}`;
    return (this.globalByOrgAndTriggerType.get(key) ?? []).filter((e) => !e.disabled);
  }

  /**
   * Convenience: get all workflows with 'schedule' trigger type.
   * Used by the cron scheduler to evaluate pending schedules.
   */
  getCronSchedules(): RegisteredWorkflow[] {
    return this.getByTriggerType('schedule');
  }

  /**
   * Get workflows matching an event type string.
   * Maps event type strings to trigger type strings for lookup.
   *
   * Event type -> trigger type mapping:
   * - 'kici_event' -> 'kici_event'
   * - 'workflow_complete' -> 'workflow_complete' or 'lifecycle'
   * - 'job_complete' -> 'job_complete' or 'lifecycle'
   * - 'generic_webhook' -> 'generic_webhook'
   * - 'schedule' -> 'schedule'
   * - lifecycle event names -> 'lifecycle'
   */
  getByEventType(eventType: string): RegisteredWorkflow[] {
    // Direct trigger type match (filter disabled)
    const direct = (this.byTriggerType.get(eventType) ?? []).filter((e) => !e.disabled);

    // Lifecycle triggers also listen for workflow_complete and job_complete
    if (eventType === 'workflow_complete' || eventType === 'job_complete') {
      const lifecycle = (this.byTriggerType.get('lifecycle') ?? []).filter((e) => !e.disabled);
      if (lifecycle.length === 0) return direct;
      if (direct.length === 0) return lifecycle;
      // Merge unique entries
      return [...direct, ...lifecycle.filter((l) => !direct.includes(l))];
    }

    return direct;
  }
}

/**
 * Convert a RegistrationRow to a RegisteredWorkflow.
 */
function rowToRegistered(row: RegistrationRow): RegisteredWorkflow {
  return {
    id: row.id,
    repoIdentifier: row.repo_identifier,
    workflowName: row.workflow_name,
    lockEntry: row.lock_entry,
    triggerTypes: row.trigger_types,
    routingKey: row.routing_key,
    providerContext: row.provider_context,
    disabled: row.disabled,
    isGlobal: row.isGlobal,
    customerId: row.customerId,
    commitSha: row.commitSha,
    sourceFile: row.sourceFile,
  };
}
