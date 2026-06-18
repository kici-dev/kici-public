import type { Kysely } from 'kysely';
import picomatch from 'picomatch';
import type { Database, OrgSettingsRepoPatternEntry } from '../db/types.js';

interface GlobalWorkflowPermission {
  allowed: boolean;
  reason?: string;
}

/**
 * Org-level permission enforcement for global workflows.
 *
 * Three independent axes (each stored as a jsonb array of
 * `{routingKey?, pattern}` entries on `org_settings`):
 *
 * - Workflow-repo allow-list (`global_workflow_allowed_repos`): which repos
 *   may author global workflows. null/empty = any repo. Checked at
 *   registration-extraction time and at dispatch time against the
 *   REGISTRATION's repo (the repo that defined the workflow).
 *
 * - Source-repo deny-list (`global_workflow_denied_repos`): which repos
 *   must never have global workflows run against their events (e.g., forks,
 *   untrusted contrib repos). Checked at dispatch time against the EVENT's
 *   repo (the repo that emitted the webhook).
 *
 * - Elevated access (`global_workflow_elevated_repos`): which workflow-
 *   authoring repos can read source-repo secrets during execution.
 *
 * Each entry can optionally pin a `routingKey`, restricting the entry to
 * one webhook source. An entry without a routing key applies to any source
 * in the org. An entry whose routing key no longer matches any current
 * source becomes a no-op (orphan, never matches) — by design, so deleting
 * a source does not silently rebind its policy entries to an unrelated
 * source.
 */
export class GlobalWorkflowPolicy {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Check whether a workflow-authoring repository is allowed to register or
   * dispatch global workflows. The workflow's own routing key is matched
   * against each entry's optional `routingKey` qualifier.
   *
   * Decision flow:
   * 1. No org_settings row or globally disabled → not allowed (opt-in).
   * 2. allowed list null/empty → any repo allowed.
   * 3. Entry matches when its `routingKey` is absent OR equals
   *    `workflowRoutingKey`, AND its pattern matches the workflow repo.
   * 4. Otherwise → not allowed.
   */
  async isWorkflowRepoAllowed(
    workflowRoutingKey: string,
    workflowRepoIdentifier: string,
    customerId: string,
  ): Promise<GlobalWorkflowPermission> {
    const settings = await this.getSettings(customerId);
    if (!settings) {
      return { allowed: false, reason: 'Global workflows not enabled for this organization' };
    }
    if (!settings.global_workflows_enabled) {
      return { allowed: false, reason: 'Global workflows disabled in organization settings' };
    }
    const allowedRepos = settings.global_workflow_allowed_repos;
    if (allowedRepos === null || allowedRepos.length === 0) {
      return { allowed: true };
    }
    const allowed = allowedRepos.some((entry) =>
      matchesEntry(entry, workflowRoutingKey, workflowRepoIdentifier),
    );
    if (!allowed) {
      return {
        allowed: false,
        reason: `Repository ${workflowRepoIdentifier} not in allowed global workflow repos`,
      };
    }
    return { allowed: true };
  }

  /**
   * Check whether events from a source repository may trigger any global
   * workflows. Each deny entry is matched against the EVENT's routing key
   * (so a source-qualified deny only applies to that specific source).
   *
   * Decision flow:
   * 1. No org_settings row or globally disabled → not allowed (opt-in).
   * 2. denied list null/empty → allowed.
   * 3. Any deny entry whose routing key (if set) equals the event's routing
   *    key AND whose pattern matches the source repo → not allowed.
   */
  async isSourceRepoAllowed(
    eventRoutingKey: string,
    sourceRepoIdentifier: string,
    customerId: string,
  ): Promise<GlobalWorkflowPermission> {
    const settings = await this.getSettings(customerId);
    if (!settings) {
      return { allowed: false, reason: 'Global workflows not enabled for this organization' };
    }
    if (!settings.global_workflows_enabled) {
      return { allowed: false, reason: 'Global workflows disabled in organization settings' };
    }
    const deniedRepos = settings.global_workflow_denied_repos;
    if (!deniedRepos || deniedRepos.length === 0) {
      return { allowed: true };
    }
    const denied = deniedRepos.some((entry) =>
      matchesEntry(entry, eventRoutingKey, sourceRepoIdentifier),
    );
    if (denied) {
      return {
        allowed: false,
        reason: `Source repository ${sourceRepoIdentifier} is in denied source-repo list`,
      };
    }
    return { allowed: true };
  }

  /**
   * Check whether a workflow-authoring repository has elevated access (i.e.,
   * may read source-repo secrets during execution). The workflow's routing
   * key is matched against each entry's optional `routingKey` qualifier.
   *
   * Returns false if no org_settings row or the elevated list is null/empty.
   */
  async isElevatedAccessAllowed(
    workflowRoutingKey: string,
    repoIdentifier: string,
    customerId: string,
  ): Promise<boolean> {
    const settings = await this.getSettings(customerId);
    if (!settings?.global_workflow_elevated_repos) return false;
    return settings.global_workflow_elevated_repos.some((entry) =>
      matchesEntry(entry, workflowRoutingKey, repoIdentifier),
    );
  }

  private async getSettings(customerId: string) {
    return this.db
      .selectFrom('org_settings')
      .selectAll()
      .where('customer_id', '=', customerId)
      .executeTakeFirst();
  }
}

/**
 * Decide whether a single `{routingKey?, pattern}` entry applies to a given
 * routing key + repo identifier. The qualifier rules:
 *
 *   - `entry.routingKey` is absent ↦ entry applies to any source in the org.
 *   - `entry.routingKey` equals the call-site's routing key ↦ entry applies.
 *   - Otherwise ↦ entry does not apply (and is treated as a no-op).
 *
 * The pattern match keeps the picomatch.isMatch semantics from before this
 * refactor, so a glob authored as `myorg/ci-*` still resolves to the same
 * matches it used to.
 */
function matchesEntry(
  entry: OrgSettingsRepoPatternEntry,
  routingKey: string,
  repoIdentifier: string,
): boolean {
  if (entry.routingKey !== undefined && entry.routingKey !== routingKey) return false;
  return picomatch.isMatch(repoIdentifier, entry.pattern);
}
