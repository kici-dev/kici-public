---
title: CI security architecture
description: Trust model, trust resolution, lock file pinning, security approval queue, and workflow modification detection
---

KiCI implements a 3-tier trust model for CI/CD pipeline security. Every PR-triggered run evaluates the contributor's trust level and gates execution accordingly -- unknown contributors are held for approval, known contributors use the base branch lock file, and trusted contributors get full access with head lock file execution.

## Trust tiers

| Tier    | Lock file source | Secrets access           | Execution |
| ------- | ---------------- | ------------------------ | --------- |
| trusted | PR head          | Full (all environments)  | Auto-run  |
| known   | Base branch      | Restricted (env-gated)   | Auto-run  |
| unknown | Base branch      | Denied (unless approved) | Held      |

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

1. A GitHub Check is posted: "This PR adds/modifies workflows -- changes will take effect after merge."
2. For known and unknown contributors, a security hold is created (workflow modifications require ci_trust:write or higher to auto-approve).
3. Trusted contributors (ci_trust:write+) can modify workflows without triggering a security hold.

## Security approval queue

Security holds are stored in the `held_runs` table with `queue_type = 'security'`, separate from environment approval holds (`queue_type = 'environment'`). This separation ensures:

- Security approvals require ci_trust:write+ permission
- Environment approvals require environments:write+ permission
- Cross-queue approval is prevented (the `approveByQueueType` method enforces queue_type matching)

### Hold reasons

| Reason                  | Trigger                                                                  | Required to approve |
| ----------------------- | ------------------------------------------------------------------------ | ------------------- |
| `workflow_modification` | Known/unknown contributor modifies `.kici/` files                        | ci_trust:write+     |
| `environment_trust`     | Environment `minimumTrust` gate blocks contributor with lower trust tier | ci_trust:write+     |

### Approval channels

1. **Dashboard** -- security approval queue in org settings CI trust tab
2. **Comment-based** -- `/kici approve` and `/kici reject` in PR comments (case-insensitive). The commenter's identity is resolved via identity link, and their ci_trust level is verified before processing.

### Approval expiry

Security holds expire after a configurable duration (default: 72 hours). Expired runs transition to the `expired` status. The GitHub Check is updated with a timeout explanation.

## GitHub Check status posting

The CheckStatusPoster provider interface posts check statuses for security events:

| Event                  | Check status | Title                     |
| ---------------------- | ------------ | ------------------------- |
| Security hold created  | pending      | Held for approval         |
| Workflow modifications | neutral      | Workflow changes detected |
| Security hold approved | success      | Approved                  |
| Security hold rejected | failure      | Rejected                  |

Security holds use a fixed GitHub Check run name `KiCI Security` to enable update-in-place as a hold progresses through its lifecycle (pending -> approved/rejected). Workflow modifications use a separate check name `KiCI: Workflow changes` since they are informational (neutral conclusion) and should not conflict with security hold statuses. The "Title" column shows the check output title.

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
  + environment_id     UUID NOT NULL (FK to environments.id)
  + hold_type          TEXT NOT NULL  -- 'reviewer' | 'timer' | 'concurrency' | 'security'
  + status             TEXT NOT NULL DEFAULT 'pending'  -- 'pending' | 'approved' | 'rejected' | 'expired' | 'released'
  + queue_type         TEXT NOT NULL DEFAULT 'environment'  -- 'environment' | 'security'
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
