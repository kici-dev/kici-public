---
title: CI security architecture
description: Trust model, trust resolution, lock file pinning, security approval queue, and workflow modification detection
---

KiCI implements a 3-tier trust model for CI/CD pipeline security. Every PR-triggered run evaluates the contributor's trust level and gates execution accordingly -- unknown contributors are held for approval, known contributors use the base branch lock file, and trusted contributors get full access with head lock file execution.

## Trust tiers

| Tier    | Lock file source | Secrets access             | Execution |
| ------- | ---------------- | -------------------------- | --------- |
| trusted | PR head          | Full (all contexts)        | Auto-run  |
| known   | Base branch      | Restricted (context-gated) | Auto-run  |
| unknown | Base branch      | Denied (unless approved)   | Held      |

### Tier definitions

**Trusted** -- org members with an identity link, `ci_trust:write` or higher RBAC permission, AND write/admin access to the repository via the provider API. These contributors can modify workflows and have their changes take effect immediately.

**Known** -- org members with an identity link but lower ci_trust level, or contributors without an identity link who have read access or higher via the provider API. Workflow modifications by known contributors are held for approval.

**Unknown** -- first-time contributors, fork PRs, contributors with no provider access and no identity link. All execution is held for security approval.

## Trust resolution flow

The TrustResolver combines three signals to determine the trust tier:

```
Webhook event (sender username + sender numeric id)
    |
    v
1. Fork PR check -----> Fork? -----> unknown (always)
    |
    v
2. Identity link lookup -- STRICT match by (provider, providerUserId)
    |
    +-- event has no sender.id --> refused, treated as no link
    +-- link's providerUserId is NULL --> refused, treated as no link
    +-- ids do not match --> refused, treated as no link (impersonation guard)
    +-- No link --> 3a. Provider API fallback
    |                   |
    |                   +-- read+ access --> known
    |                   +-- no access -----> unknown
    |
    +-- Has link --> 3b. Combine ci_trust RBAC + provider permission
                        |
                        +-- provider write+ AND ci_trust write+ --> trusted
                        +-- provider write+ AND ci_trust none/read --> known
                        +-- provider read --> known
                        +-- provider none --> unknown
```

### Why match on the numeric id, not the username

Provider usernames (GitHub `login`, GitLab `username`) are **mutable**. A user can rename, and after a hold period, the freed username is available for someone else to register. Trust granted to user X under their old login would otherwise transfer to whoever owns the login next. The strict numeric-id match closes this hole: the immutable IDP-side numeric id (`sender.id` on GitHub, `user_id` on GitLab) is the only field consulted for the identity-link match.

### Identity-link freshness

The strict numeric-id policy depends on the identity link's stored `provider_user_id` being filled and current. KiCI keeps it that way via three independent reconciliation paths (push from the OIDC issuer, on-demand sync at dashboard read, periodic reconcile job).

Refusals from the strict policy (event missing `sender.id`, link missing `provider_user_id`, or numeric-id mismatch) are counted under `kici_orch_trust_match_refused_no_id_total{reason}`. Steady-state should be 0 in a healthy deployment; a non-zero rate points at a forge whose normalizer drops `sender.id` or an identity-sync regression — both worth investigating.

### Decision matrix

| Provider repo access | KiCI ci_trust | Identity linked | Resulting tier |
| -------------------- | ------------- | --------------- | -------------- |
| write/admin          | write+        | yes             | trusted        |
| write/admin          | none/read     | yes             | known          |
| read                 | any           | yes             | known          |
| none                 | any           | yes             | unknown        |
| read+                | --            | no              | known          |
| none                 | --            | no              | unknown        |
| any (fork PR)        | any           | any             | unknown        |

## Identity linking

Identity links connect a provider username (e.g., GitHub `octocat`) to a KiCI user account. Two verified linking mechanisms exist:

1. **Auto-link from OAuth claims** -- when a user signs up via GitHub OAuth through the identity provider, their GitHub username is extracted from IDP claims automatically. Zero friction for the common case.

2. **Manual OAuth linking via dashboard** -- a "Link GitHub account" button in personal settings for users who signed up with email/password. Each provider has its own OAuth flow.

Self-reported usernames are not accepted (spoofable). Unlinked users are treated as unknown for CI trust purposes -- the dashboard shows a prompt to link their provider account.

### Provider API fallback

For contributors without an identity link, the orchestrator calls the provider API to determine access level. For GitHub, this uses `GET /repos/{owner}/{repo}/collaborators/{username}/permission`. This fallback can resolve to known (read access or higher) but never to trusted -- trusted requires a verified identity link plus ci_trust:write.

## Lock file source pinning

Lock file source determines which compiled workflow definition is used for execution:

- **PR events, trusted tier** -- uses the PR head lock file (contributor's branch). Workflow modifications take effect immediately.
- **PR events, known/unknown tier** -- uses the base branch lock file. Workflow modifications in the PR do not affect execution until merged.
- **Push events** -- uses the pushed commit's lock file (no pinning needed, current behavior).

This prevents untrusted contributors from modifying workflow definitions to exfiltrate secrets or execute arbitrary code.

## Workflow modification detection

When a PR modifies workflows, the orchestrator detects this by directly comparing the base and head lock files (`workflow-diff.ts`). It checks for added, removed, or modified workflows by diffing their triggers, jobs, and rules. If modifications are detected:

1. A neutral informational GitHub Check is posted on its own check name (`KiCI: Workflow changes`): "This PR adds/modifies workflows -- changes will take effect after merge."
2. Detection stops there. What happens to the PR's matched runs is decided by the org's **workflow change policy**, which has three outcomes for a contributor below the `trusted` tier:
   - `hold` (the default) -- the runs are held in the security queue with reason `workflow_modification`, and a pending `KiCI Security` "Held for approval" check is posted. The hold is a real `held_runs` row: `/kici approve` (or the dashboard approval queue) releases it and resolves the check to success, `/kici reject` fails it, and expiry fails it automatically -- the pending check never dangles.
   - `reject` -- the run fails before any job starts, recorded as a run-scoped `trust_policy` init failure, and a `KiCI Security` failure check is posted.
   - `allow` -- this arm raises no objection and the next applicable arm decides. The neutral informational check is still posted.
3. Trusted contributors (ci_trust:write+) can modify workflows without triggering a security hold, whatever the policy says.

`allow` removes the workflow-change objection; it does not dispatch the pull request. Arms are evaluated in a fixed order -- workflow modification, fork PR, unknown contributor -- with any `reject` beating any `hold`, so a PR that trips several arms yields one verdict whose reason comes from the first applicable arm rather than from evaluation accident. A workflow-modifying PR from a same-repo contributor who resolves to `unknown` is therefore still held under `allow`, with the reason moving from `workflow_modification` to `unknown_contributor` -- and the unknown contributor policy has no `allow` value, so no configuration dispatches it. That reason flip is what `e2e/tests/trust-policy-gate.test.ts` asserts.

Two scoping points matter here. The policy is only evaluated for sources with a contributor model (GitHub today); a generic webhook, local source, or plain Git remote has no contributor to resolve and is never gated by it. And this arm is **not fork-only** -- it fires on a same-repo PR from any contributor below `trusted`, which is the default for ordinary org members.

## The verdict is a property of the event

The trust policy is evaluated once per webhook event, before any dispatch path runs, and the resulting verdict is threaded to every path that could start a job. Stating the verdict is mandatory: the dispatch context's field is required, so a path that fails to carry one does not compile rather than silently dispatching. A verdict the build does not recognise denies -- the policy columns are plain text, so a newer Platform can emit a value this orchestrator has never seen, and for a security control the safe reading of "I do not understand this" is to refuse.

### Organization-wide global workflows

Organization-wide global workflows do not run for a pull request that the trust policy holds or rejects, on either dispatch path (with or without a per-repo lock file). A neutral informational check on its own check name (`KiCI: Organization workflows`) records that they were skipped, so it never writes over the `KiCI Security` check the hold or rejection owns; the failure check on a `reject` is posted once, by the pull request's own dispatch path.

When the repository has no lock file of its own there is no such path -- and no run to fail -- so a rejected event there produces only the neutral skipped notice. Nothing is dispatched either way; the difference is only in how much the pull request is told.

A skipped global workflow has no run row and therefore no held run, so approving the event's hold releases the pull request's own workflows only -- it does not retroactively run the organization's global workflows for that event.

This gate exists because a global workflow runs with **organization** credentials against the event's head commit. Running one for an event the policy refused would hand an untrusted contributor exactly the capability the policy was protecting.

### Fork pull requests and the unknown tier

`TrustResolver` returns the `unknown` tier for every fork pull request unconditionally, so the unknown-contributor arm would otherwise fire for every fork -- and because the unknown contributor policy has no `allow` member, no configuration could ever let a fork run. When the fork is what caused the unknown tier and the operator has explicitly set fork PR policy to `allow`, the fork arm wins and the unknown-contributor arm is suppressed.

The suppression is deliberately narrow: a non-fork unknown contributor is unaffected, and the workflow change arm is still evaluated first, so an allowed fork that edits `.kici/` is still governed by the workflow change policy.

## Security approval queue

Security holds are stored in the `held_runs` table with `queue_type = 'security'`, separate from context approval holds (`queue_type = 'context'`). This separation ensures:

- Security approvals require ci_trust:write+ permission
- Context approvals require contexts:write+ permission
- Cross-queue approval is prevented (the `approveByQueueType` method enforces queue_type matching)

### Hold reasons

| Reason                  | Trigger                                                              | Required to approve |
| ----------------------- | -------------------------------------------------------------------- | ------------------- |
| `workflow_modification` | Known/unknown contributor modifies `.kici/` files                    | ci_trust:write+     |
| `fork_pr`               | PR opened from a fork, with fork PR policy set to `hold`             | ci_trust:write+     |
| `unknown_contributor`   | Contributor could not be resolved to a known identity                | ci_trust:write+     |
| `context_trust`         | Context `minimumTrust` gate blocks contributor with lower trust tier | ci_trust:write+     |

The first three are raised by the org trust policy; `context_trust` is raised by a context's `minimumTrust` gate. A PR that trips several policy arms yields exactly one hold: the arms are evaluated in the order above and any `reject` outcome takes precedence over any `hold`. The trust policy is evaluated before the context gate, so a policy-held run never also lands a competing `context_trust` hold.

### Approval channels

1. **Dashboard** -- security approval queue in org settings CI trust tab
2. **Comment-based** -- `/kici approve` and `/kici reject` in PR comments (case-insensitive). The commenter's identity is resolved via identity link, and their ci_trust level is verified before processing. A command acts **only on the held runs for the PR (and repo) the comment was posted on** -- a bare `/kici approve` releases every pending security hold for that PR, and never touches holds from other PRs or repos. An explicit `/kici approve <runId>` is narrowed within that PR's holds, so a run id belonging to a different PR or repo matches nothing.

### Approval expiry

Security holds expire on a deadline set when the hold is created. A hold raised by the org trust policy — `workflow_modification`, `fork_pr`, or `unknown_contributor`, each covering a whole PR and not attached to any context — uses the org's approval expiry (default 72 hours). A `context_trust` hold is raised by a context rather than by the org policy, so it uses that context's own hold expiry (`hold_expiry_seconds`, default one hour). Expired runs transition to the `expired` status. The GitHub Check is updated with a timeout explanation.

## GitHub Check status posting

The CheckStatusPoster provider interface posts check statuses for security events:

| Event                        | Check status | Title                          |
| ---------------------------- | ------------ | ------------------------------ |
| Security hold created        | pending      | Held for approval              |
| Workflow modifications       | neutral      | Workflow changes detected      |
| Organization globals skipped | neutral      | Organization workflows skipped |
| Security hold approved       | success      | Approved                       |
| Security hold rejected       | failure      | Rejected                       |

Security holds use a fixed GitHub Check run name `KiCI Security` to enable update-in-place as a hold progresses through its lifecycle (pending -> approved/rejected). The two informational (neutral) checks each use their own check name -- `KiCI: Workflow changes` for workflow modifications and `KiCI: Organization workflows` for globals skipped by the trust policy -- so neither can overwrite the security-hold check. That matters concretely: the security check is a single run per commit which the hold posts as pending and approve / reject later complete, so an informational write onto it would resolve a still-held run's check and release whatever branch protection waits on it. The "Title" column shows the check output title.

## CI trust level resolution

A member's effective `ci_trust` level is computed from two sources with a clear precedence:

1. **Per-member override** -- when set, this value is used directly, bypassing all role-based calculation. Set via the members tab in the dashboard or `PUT /api/v1/orgs/:customerId/members/:userId/ci-trust`.

2. **Role-derived** -- when no override is set (null), the trust level comes from the member's assigned roles:
   - Owner role always yields `admin`
   - Multiple roles: permissions are merged (highest level wins per resource), then `ci_trust` is extracted from the merged result
   - No roles: defaults to `none`

The roles page shows the `ci_trust` value configured on each role (what members assigned to that role inherit). The members page shows the **effective** trust level (after override and role merging). These are not duplicates -- roles define the baseline, and the members column shows the computed result (which may differ if an override is set or if multiple roles are merged).

## Trust policy sync

Trust policies are cached locally on the orchestrator and pushed from the Platform via WebSocket (`trust_policy.update` message). The fail-closed design means:

- If the trust policy is stale and Platform is unreachable, all contributors are treated as unknown
- Identity links are pushed alongside trust policy and cached indefinitely on the orchestrator
- ci_trust RBAC levels are included in the policy push for offline resolution

An organization whose policy row was never created still receives a push carrying the documented defaults. The row is created lazily on a dashboard read, so an organization that has never opened **Settings > CI trust** would otherwise receive no push at all -- and because the push also carries identity links and ci_trust levels, withholding it would leave every contributor in that organization unresolvable, not merely un-policied.

## Contributor resolution caching

The orchestrator maintains an in-memory LRU cache for provider API permission checks:

- **Cache key:** `{provider}:{repoFullName}:{username}`
- **TTL:** 15 minutes
- **Invalidation:** TTL acts as the fallback. In addition, the orchestrator proactively drops matching entries when it receives any of four GitHub membership-related webhook events, so access decisions do not rely on up-to-15-minutes-stale data after a permission shift.

Event-to-scope mapping (implemented in the GitHub normalizer's `getAccessCacheInvalidations` hook and executed by `processWebhook` before trigger matching):

| GitHub event                                               | Scope           | Entries dropped                              |
| ---------------------------------------------------------- | --------------- | -------------------------------------------- |
| `member` (`added` / `removed` / `edited`)                  | **repo-user**   | `{provider}:{repo}:{user}` — the exact entry |
| `organization` (`member_added` / `member_removed`)         | **user-in-org** | every `{provider}:{org}/*:{user}` entry      |
| `membership` (`added` / `removed`, typically team)         | **user-in-org** | every `{provider}:{org}/*:{user}` entry      |
| `team` (`added_to_repository` / `removed_from_repository`) | **repo**        | every `{provider}:{repo}:*` entry            |

Other `team` actions (`created` / `deleted` / `edited`) carry no repo context and are skipped. Malformed payloads (missing fields) are skipped rather than rejected — invalidation is best-effort, and the TTL guarantees any entry we miss ages out within 15 minutes regardless.

Proactive invalidation only fires for events the GitHub App actually receives. To get it, the App must subscribe to `member`, `organization`, `membership`, and `team`, and (for the org-scoped events) hold the **Organization -> Members** read permission on an org-level install. See the [GitHub provider setup guide](../../user/providers/github.md) for the exact App configuration. If those events are not subscribed, trust decisions are still correct — the cache just relies entirely on the 15-minute TTL, so a permission change can take up to 15 minutes to reflect.

## Data model

### orchestrator DB (initial migration)

```
execution_runs
  + trust_tier         TEXT  -- 'trusted' | 'known' | 'unknown' | null
  + lock_file_source   TEXT  -- 'head' | 'base' | null
  + contributor_username TEXT  -- provider username of the PR author

held_runs
  + id                 UUID PRIMARY KEY
  + org_id             VARCHAR(12) NOT NULL
  + run_id             UUID NOT NULL
  + job_id             TEXT NOT NULL
  + context_id         UUID (FK to contexts.id; null for context-free holds like workflow_modification)
  + hold_type          TEXT NOT NULL  -- gate types 'reviewer' | 'timer' | 'concurrency' | 'security'
  + status             TEXT NOT NULL DEFAULT 'pending'  -- 'pending' | 'approved' | 'rejected' | 'expired' | 'released'
  + queue_type         TEXT NOT NULL DEFAULT 'context'  -- 'context' | 'security'
  + reason             TEXT
  + approved_by        TEXT
  + created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
  + expires_at         TIMESTAMPTZ NOT NULL
  + resolved_at        TIMESTAMPTZ

Indexes:
  - held_runs_org_id_status_idx (org_id, status)
  - held_runs_org_queue_type_status_idx (org_id, queue_type, status)
```

## Data flow diagram

```
GitHub webhook
    |
    v
Platform relay (verify signature, route via WS)
    |
    v
Orchestrator processor
    |
    +-- 1. Normalize event (WebhookNormalizer)
    +-- 2. Detect fork PR (head/base repo full_name comparison)
    +-- 3. Resolve trust tier (TrustResolver)
    |       |
    |       +-- Identity link lookup
    |       +-- ci_trust RBAC check
    |       +-- Provider API permission (ContributorResolver + cache)
    |
    +-- 4. Fetch lock file (LockFileFetcher -- head for trusted, base for known/unknown)
    +-- 5. Detect workflow modifications (workflow-diff lock file comparison)
    +-- 6. Create security hold if needed (HeldRunStore)
    +-- 7. Post check status (CheckStatusPoster)
    +-- 8. Match triggers against lock file
    +-- 9. Dispatch jobs (skip held/rejected)
    +-- 10. Record trust context on execution_runs
```
