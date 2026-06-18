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
| Approval expiry            | Duration (hours)            | 72      | How long a security hold waits before expiring                                     |

### Default behavior

KiCI defaults to **fail-closed, deny-untrusted**:

- Fork PRs are held for approval
- Unknown contributors are held for approval
- Workflow modifications by non-trusted contributors are held
- Contributors without identity links are treated as unknown
- If trust policy cannot be fetched from Platform, all contributors are treated as unknown

### Changing defaults

To change the default policy:

1. Navigate to **Settings > CI trust** in the dashboard
2. Adjust the policy values (e.g., set fork PR policy to `allow` for open-source projects, or `reject` to block fork PRs entirely)
3. Save -- the policy is pushed to all connected orchestrators via WebSocket

## ci_trust RBAC resource

The `ci_trust` resource is one of the 15 RBAC resources and controls CI security permissions:

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

The security approval queue is separate from environment approval queues. View it in **Settings > CI trust > Approval queue**.

### Hold reasons

| Reason                  | Trigger                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| `workflow_modification` | PR modifies `.kici/` files by non-trusted user                           |
| `environment_trust`     | Environment `minimumTrust` gate blocks contributor with lower trust tier |

### Approving or rejecting

**Dashboard:** Click approve or reject in the security approval queue.

**PR comment:** Post `/kici approve` or `/kici reject` as a PR comment. The commenter must have ci_trust:write or higher (verified via identity link + RBAC).

### Expiry

Held runs expire after the configured approval expiry duration (default 72 hours). Expired runs transition to `expired` status and a GitHub Check is updated with a timeout explanation.

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
