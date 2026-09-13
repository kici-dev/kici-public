import type { Kysely } from 'kysely';
import { getRepoGlobMatcher } from '@kici-dev/engine';
import { invalidRepoPatternReason } from '@kici-dev/engine/protocol/dashboard-global-workflows';
import { createLogger } from '@kici-dev/shared';
import type { Database, OrgSettingsRepoPatternEntry } from '../db/types.js';
import type { ClusterSettingsReader } from '../cluster/cluster-settings-reader.js';

const logger = createLogger({ prefix: 'global-workflow-policy' });

interface GlobalWorkflowPermission {
  allowed: boolean;
  reason?: string;
}

/**
 * Permission enforcement for global workflows.
 *
 * A fleet-wide master switch gates everything first:
 * `cluster_settings.global_workflows_enabled`, held by the orchestrator
 * operator through `kici-admin cluster-settings` (NULL ⇒ the configured
 * `KICI_GLOBAL_WORKFLOWS_ENABLED` default, off by default). When the switch is
 * off — or the cluster row is unreadable, which fails closed — no repo may
 * register or dispatch a global workflow, whatever the per-org lists say.
 *
 * With the switch on, three independent per-org axes apply (each stored as a
 * jsonb array of `{routingKey?, pattern}` entries on `org_settings`). A missing
 * `org_settings` row means "no per-org restrictions" for the repo and source
 * axes, not a denial; elevated access still requires an explicit list, so a
 * missing row grants none.
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
  constructor(
    private readonly db: Kysely<Database>,
    private readonly clusterSettings: ClusterSettingsReader,
    /** Applies when the cluster column is NULL — `config.globalWorkflowsEnabled`. */
    private readonly defaultEnabled: boolean,
  ) {}

  /**
   * The fleet-wide master gate, consulted before any per-org list.
   *
   * Returns `undefined` when the gate passes, or the denial to return
   * verbatim when it does not — so all three axes share one decision and one
   * pair of reasons.
   *
   * Fails closed on `{ ok: false }`. That case is a database fault, not an
   * operator choice, and answering it from `defaultEnabled` would open the
   * feature during an outage the moment that default is ever flipped.
   */
  private async clusterGate(): Promise<GlobalWorkflowPermission | undefined> {
    const read = await this.clusterSettings.tryGetBoolean('global_workflows_enabled');
    if (!read.ok) {
      return { allowed: false, reason: 'Global workflows: cluster settings unreadable' };
    }
    const enabled = read.value ?? this.defaultEnabled;
    if (!enabled) {
      return { allowed: false, reason: 'Global workflows are disabled cluster-wide' };
    }
    return undefined;
  }

  /**
   * Check whether a workflow-authoring repository is allowed to register or
   * dispatch global workflows. The workflow's own routing key is matched
   * against each entry's optional `routingKey` qualifier.
   *
   * Decision flow:
   * 1. Cluster master switch off or unreadable → not allowed (fails closed).
   * 2. allowed list null/empty (or no org_settings row) → any repo allowed.
   * 3. Entry matches when its `routingKey` is absent OR equals
   *    `workflowRoutingKey`, AND its pattern matches the workflow repo.
   * 4. Otherwise → not allowed.
   */
  async isWorkflowRepoAllowed(
    workflowRoutingKey: string,
    workflowRepoIdentifier: string,
    customerId: string,
  ): Promise<GlobalWorkflowPermission> {
    const denied = await this.clusterGate();
    if (denied) return denied;
    const settings = await this.getSettings(customerId);
    const allowedRepos = settings?.global_workflow_allowed_repos ?? null;
    if (allowedRepos === null || allowedRepos.length === 0) {
      return { allowed: true };
    }
    // Allow list: an unstorable entry grants nothing.
    const allowed = allowedRepos.some((entry) =>
      matchesEntry(entry, workflowRoutingKey, workflowRepoIdentifier, customerId, false),
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
   * 1. Cluster master switch off or unreadable → not allowed (fails closed).
   * 2. denied list null/empty (or no org_settings row) → allowed.
   * 3. Any deny entry whose routing key (if set) equals the event's routing
   *    key AND whose pattern matches the source repo → not allowed.
   */
  async isSourceRepoAllowed(
    eventRoutingKey: string,
    sourceRepoIdentifier: string,
    customerId: string,
  ): Promise<GlobalWorkflowPermission> {
    const gate = await this.clusterGate();
    if (gate) return gate;
    const settings = await this.getSettings(customerId);
    const deniedRepos = settings?.global_workflow_denied_repos ?? null;
    if (!deniedRepos || deniedRepos.length === 0) {
      return { allowed: true };
    }
    // Deny list: an unstorable entry blocks. This is the one site whose
    // fail-closed direction is `true` — a match here denies the event.
    const denied = deniedRepos.some((entry) =>
      matchesEntry(entry, eventRoutingKey, sourceRepoIdentifier, customerId, true),
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
   * Check whether a workflow-authoring repository is on the elevated-access
   * list. The workflow's routing key is matched against each entry's optional
   * `routingKey` qualifier. Returns false if no org_settings row or the
   * elevated list is null/empty.
   *
   * @deprecated Not enforced, and not enforceable in this shape. It was meant
   * to gate a global workflow's job reading the *source* repository's secrets,
   * but the organization-wide dispatch path resolves no secrets at all — it
   * binds no secret contexts, and writes no secret material into a job config
   * (asserted by `pipeline/process-webhook-globals-secrets.test.ts`). So there
   * is no injection for a grant to widen, and this method has no caller.
   *
   * Granting it would not be a matter of calling this from the dispatch path:
   * secrets are stored `(org_id, scope, key)` with no repository dimension, so
   * "the source repository's secrets" is not a set the orchestrator can name
   * today. The list, its admin route, its CLI mutators and its wire field are
   * deprecated pending removal at v1.0.0 (`docs/user/deprecations.md`).
   */
  async isElevatedAccessAllowed(
    workflowRoutingKey: string,
    repoIdentifier: string,
    customerId: string,
  ): Promise<boolean> {
    if (await this.clusterGate()) return false;
    const settings = await this.getSettings(customerId);
    if (!settings?.global_workflow_elevated_repos) return false;
    // Elevated list: an unstorable entry grants nothing.
    return settings.global_workflow_elevated_repos.some((entry) =>
      matchesEntry(entry, workflowRoutingKey, repoIdentifier, customerId, false),
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
 * The pattern is matched with the shared repo-identifier matcher, the same one
 * a workflow's own `repos:` patterns use. A repo identifier is an owner/name
 * pair, not a file path, so a leading dot carries no meaning of its own and a
 * wildcard segment matches one: `myorg/*` covers `myorg/.github`.
 *
 * That is what an operator writing `myorg/*` means in any of the three lists,
 * and on the deny-list it is load-bearing. Under path-glob semantics no
 * wildcard segment matched a dot-prefixed one, so a deny entry of `myorg/*`,
 * `myorg/**`, or even `**` silently ADMITTED `myorg/.github` — a control that
 * did not do what its pattern said, in the one direction where failing means
 * letting an event through. `.github` is an ordinary repository name, so this
 * was reachable rather than theoretical.
 *
 * A pattern the write path refuses (`invalidRepoPatternReason`) can still be
 * present in a stored row, so the match resolves it to `onInvalid` rather than
 * handing it to the glob matcher, whose negation semantics would invert the
 * entry's meaning.
 */
function matchesEntry(
  entry: OrgSettingsRepoPatternEntry,
  routingKey: string,
  repoIdentifier: string,
  customerId: string,
  /**
   * The verdict for an entry whose pattern is invalid. Always the fail-closed
   * direction of the list being evaluated: `false` on an allow list or the
   * elevated list (the entry grants nothing), `true` on a deny list (the entry
   * blocks).
   */
  onInvalid: boolean,
): boolean {
  if (entry.routingKey !== undefined && entry.routingKey !== routingKey) return false;
  const invalid = invalidRepoPatternReason(entry.pattern);
  if (invalid) {
    logger.warn('Invalid global-workflow policy pattern fails closed', {
      customerId,
      pattern: entry.pattern,
      reason: invalid,
      onInvalid,
    });
    return onInvalid;
  }
  return getRepoGlobMatcher(entry.pattern)(repoIdentifier);
}
