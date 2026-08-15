---
title: CI security
description: Trust policy configuration, identity linking, approval workflows, and monitoring
---

KiCI's CI security system protects your pipelines from unauthorized code execution. This guide covers how to configure trust policies, manage identity links, handle security approvals, and monitor security events.

## Trust policy configuration

Trust policies control how KiCI handles PR-triggered runs based on contributor trust level. Configure them in the dashboard under **Settings > CI trust**.

### Policy options

| Policy                     | Values                      | Default | Description                                                                        |
| -------------------------- | --------------------------- | ------- | ---------------------------------------------------------------------------------- |
| Fork PR policy             | `hold` / `reject` / `allow` | `hold`  | Whether fork PRs are held for approval, rejected outright, or allowed              |
| Unknown contributor policy | `hold` / `reject`           | `hold`  | Whether unknown contributors are held for approval or rejected                     |
| Workflow change policy     | `hold` / `reject` / `allow` | `hold`  | Whether workflow modifications by non-trusted users are held, rejected, or allowed |
| Approval expiry            | Duration (hours)            | 72      | How long a security hold stays approvable before it expires                        |

### Default behavior

KiCI defaults to **fail-closed, deny-untrusted**:

- Fork PRs are held for approval
- Unknown contributors are held for approval
- Workflow modifications by non-trusted contributors are held
- Contributors without identity links are treated as unknown
- If trust policy cannot be fetched from Platform, all contributors are treated as unknown

The policy applies to sources with a contributor model (GitHub today). Sources
without one -- generic webhooks, local sources, plain Git remotes -- have no
contributor to resolve and are not gated by it.

Note that the workflow change policy is not fork-only: it applies to a same-repo
PR from any contributor below the `trusted` tier, which is the default for
ordinary org members.

An organization that has never opened **Settings > CI trust** is pushed these
same documented defaults, so its orchestrator enforces exactly what this table
describes rather than waiting for a policy that was never created.

### Organization-wide global workflows

Organization-wide global workflows do not run for a pull request that the trust
policy holds or rejects. Approving the hold releases the pull request's own
workflows; it does not retroactively run the organization's global workflows for
that event. A separate neutral check, `KiCI: Organization workflows`, reports
that they were skipped -- the `KiCI Security` check keeps showing the hold.

This matters because a global workflow runs with **organization** credentials
against the pull request's head commit, so letting one run for an untrusted
event would defeat the policy that held the event in the first place.

The master switch that turns global workflows on at all is **operator-held and
fleet-wide** (`cluster_settings.global_workflows_enabled`, set with
`kici-admin cluster-settings`). It cannot be flipped from the dashboard — an org
admin can tune the per-org authoring / source lists, but only the orchestrator
operator can enable the feature for the cluster.

### Allowing fork pull requests

Setting fork PR policy to `allow` dispatches a fork pull request even though
fork contributors always resolve to the `unknown` trust tier -- the fork is what
made them unknown, so the fork setting decides the outcome.

This is deliberately narrow. A **non-fork** unknown contributor is still governed
by the unknown contributor policy, and a fork pull request that edits `.kici/`
workflow definitions is still governed by the workflow change policy. So `allow`
opens exactly one door: pull requests from forks by contributors you cannot
identify, which is the open-source case it exists for.

### Allowing workflow changes

Setting workflow change policy to `allow` is narrow in the same way, and for the
same reason: it removes only the workflow-change objection. The pull request is
still evaluated against the other policies, so a fork PR is still governed by the
fork PR policy and a contributor you cannot identify is still governed by the
unknown contributor policy -- and that policy has no `allow` value. A pull
request from an unidentified contributor that also edits `.kici/` workflow
definitions is therefore still held or rejected under `allow`; what changes is
the reason, from workflow modification to unknown contributor.

`allow` never means "dispatch this pull request". It means "this particular
objection no longer applies".

### Changing defaults

To change the default policy:

1. Navigate to **Settings > CI trust** in the dashboard
2. Adjust the policy values (e.g., set fork PR policy to `allow` for open-source projects, or `reject` to block fork PRs entirely)
3. Save -- the policy is pushed to all connected orchestrators via WebSocket

An **independent** orchestrator has no Platform to push the policy, so it is managed with the orchestrator admin CLI instead: `kici-admin trust-policy show --customer-id <id>` and `kici-admin trust-policy set --customer-id <id> --fork-policy <hold|reject|allow> …`. On a Platform-attached orchestrator `set` refuses with a 409, because the next Platform push would overwrite a local write. See [kici-admin: org settings](../orchestrator/kici-admin/org-settings.md).

The admin token behind those commands needs the orchestrator-side `ci_trust.read` permission to `show` and `ci_trust.admin` to `set` — both held by the `owner` and `admin` roles, and by neither `auditor` nor a routing-key-scoped token (the policy is org-wide, not per routing key). Every successful `set` writes a `trust_policy.updated` row to the access log in the same transaction as the policy itself, so a policy change can never land unattributed; read it back with `kici-admin access-log list --action trust_policy.updated`.

Until an independent orchestrator has a policy stored, no policy arm is in force at all — only the legacy rule that holds a workflow change by a non-trusted contributor. `trust-policy show` reports that state as `Enforcement: legacy` and prints **no** policy values, rather than showing defaults it is not applying.

## ci_trust RBAC resource

The `ci_trust` resource is one of the 16 RBAC resources and controls CI security permissions:

| Level   | Capabilities                                                                 |
| ------- | ---------------------------------------------------------------------------- |
| `none`  | No CI trust -- PRs use base lock file, restricted secret access              |
| `read`  | View trust policies and security approval queue                              |
| `write` | Workflow modifications auto-approved, can approve held runs, `/kici approve` |
| `admin` | Modify org-wide trust policies, manage identity links                        |

### Built-in role defaults

| Role   | ci_trust default |
| ------ | ---------------- |
| Owner  | admin            |
| Member | none             |

Members must be explicitly granted ci_trust permissions via custom roles.

## Identity linking

Identity links connect a provider username (e.g., GitHub `octocat`) to a KiCI user account. They are required for trusted-tier resolution.

### Auto-linking from the identity provider

When a user signs up via GitHub OAuth through the identity provider, their GitHub username is automatically extracted from IDP claims. This is the zero-friction path that covers most users.

### OAuth linking via GitHub

For users who signed up with email/password, KiCI provides a direct GitHub OAuth flow:

1. Navigate to **Personal settings > Linked accounts** in the dashboard
2. Click the **Link** button next to GitHub
3. Authorize KiCI on GitHub (only `read:user` scope is requested -- public profile info)
4. The link appears automatically after redirect

#### CSRF protection

The OAuth flow uses a random state parameter to prevent authorization code injection attacks. State tokens are single-use and expire after 10 minutes.

### Unlinking

Users can unlink a provider account from their personal settings. After unlinking, they are treated as unknown for CI trust (unless they have provider API access, which resolves to known).

## GitHub App permissions

For the trust resolution provider API fallback to work, your GitHub App needs:

- **Repository Administration: read** -- allows checking collaborator permissions via `GET /repos/{owner}/{repo}/collaborators/{username}/permission`

Without this permission, the provider API fallback returns "no access" and unlinked contributors are always treated as unknown.

## Environment minimumTrust gate

The `minimumTrust` protection rule on environments gates job execution based on trust tier:

| minimumTrust | Effect                                              |
| ------------ | --------------------------------------------------- |
| `known`      | Blocks unknown contributors; allows known + trusted |
| `trusted`    | Blocks unknown + known; allows only trusted         |
| (unset)      | No trust-based gating                               |

Configure per-environment in **Settings > Environments > [env] > Protection**.

Example: set production to `minimumTrust: 'trusted'` so only verified org members with ci_trust:write can deploy. Set staging to `minimumTrust: 'known'` to block fork PRs but allow returning contributors.

## Security approval queue

The security approval queue is separate from context approval queues. View it in **Settings > CI trust > Approval queue**.

### Hold reasons

| Reason                  | Trigger                                                              |
| ----------------------- | -------------------------------------------------------------------- |
| `workflow_modification` | PR modifies `.kici/` files by non-trusted user                       |
| `fork_pr`               | PR opened from a fork, with fork PR policy set to `hold`             |
| `unknown_contributor`   | Contributor could not be resolved to a known identity                |
| `context_trust`         | Context `minimumTrust` gate blocks contributor with lower trust tier |

A PR that trips several policy arms produces exactly one hold. The arms are
evaluated in the order above, and any `reject` outcome takes precedence over any
`hold`. The trust policy is evaluated before the context `minimumTrust` gate, so
a run held by policy never also lands a competing `context_trust` hold.

### Approving or rejecting

**Dashboard:** Click approve or reject in the security approval queue.

**PR comment:** Post `/kici approve` or `/kici reject` as a PR comment. The commenter must have ci_trust:write or higher (verified via identity link + RBAC). The command acts only on the held runs for the PR (and repo) the comment was posted on -- it never releases or rejects holds belonging to other PRs or repos.

### Expiry

A hold raised by the trust policy -- `workflow_modification`, `fork_pr`, or `unknown_contributor` -- covers a whole PR and is not attached to an environment, so it uses the org's **Approval expiry** setting (default 72 hours). A `context_trust` hold is raised by an environment rather than by the org policy, so it uses that environment's own hold expiry (`hold_expiry_seconds`, default one hour), configurable under **Settings > Environments > [env] > Protection**. Expired runs transition to `expired` status and a GitHub Check is updated with a timeout explanation.

## Monitoring

### Log prefixes

Security events are logged with structured fields:

| Field                | Description                                 |
| -------------------- | ------------------------------------------- |
| `trust_tier`         | Resolved trust tier (trusted/known/unknown) |
| `lock_file_source`   | Lock file source used (head/base)           |
| `securityHold`       | Security hold reason if applicable          |
| `identityLinked`     | Whether contributor has an identity link    |
| `providerPermission` | Provider API permission level               |
| `ciTrustLevel`       | ci_trust RBAC level                         |

### Key log messages

- `Trust tier resolved` -- trust resolution completed for a PR event
- `Workflow modifications detected in PR` -- `.kici/` files changed in PR
- `Failed to post security hold check` -- GitHub Check posting failed (non-blocking)
- `Job held by protection rules` -- job entered security hold

### Database queries

Check pending security holds:

```sql
SELECT h.id, h.run_id, h.hold_type, h.reason, h.created_at, h.expires_at,
       r.workflow_name, r.contributor_username, r.trust_tier
FROM held_runs h
JOIN execution_runs r ON r.run_id = h.run_id
WHERE h.queue_type = 'security' AND h.status = 'pending'
ORDER BY h.created_at DESC;
```

Check trust tier distribution:

```sql
SELECT trust_tier, COUNT(*) as count
FROM execution_runs
WHERE trust_tier IS NOT NULL AND created_at > NOW() - INTERVAL '7 days'
GROUP BY trust_tier;
```

### Held run expiry

The stale detector automatically expires overdue held runs. Monitor the `held_runs` table for expired entries:

```sql
SELECT COUNT(*) FROM held_runs
WHERE status = 'expired' AND resolved_at > NOW() - INTERVAL '24 hours';
```
