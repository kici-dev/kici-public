---
title: Role-based access control (RBAC)
description: Permission model, custom roles, enforcement, and member lifecycle
---

KiCI uses an in-house RBAC system for all authorization decisions. The OIDC issuer handles authentication only (login, user creation, email invites). All permission data lives in the KiCI database, giving operators full control over access policies without external dependencies.

## Overview

Every organization in KiCI has a set of roles. Each role defines a permission matrix mapping 16 resources to 5 access levels. Users can have multiple roles assigned simultaneously -- their effective permissions are computed as the union (most permissive wins) across all assigned roles.

```
User -> [Role A, Role B, Role C] -> merge(permsA, permsB, permsC) -> Effective Permissions
```

This additive model means roles only grant access -- there are no deny rules. Adding a role can never reduce a user's permissions.

## Permission model

### Resources

| Resource            | Description                                             | Scope       |
| ------------------- | ------------------------------------------------------- | ----------- |
| `runs`              | Workflow runs, jobs, steps, logs                        | Repo-scoped |
| `workflows`         | Workflow definitions and lock files                     | Repo-scoped |
| `secrets`           | Encrypted secret values and contexts                    | Repo-scoped |
| `api_keys`          | User API keys, orchestrator keys, and service accounts  | Global      |
| `webhook_sources`   | Webhook source registration and secrets                 | Global      |
| `org_settings`      | Organization display name, configuration                | Global      |
| `members`           | Member management, roles, invitations                   | Global      |
| `billing`           | Plan management, checkout, subscriptions                | Global      |
| `audit`             | Audit log viewing (read-only resource)                  | Global      |
| `environments`      | Environment definitions and approval policies           | Global      |
| `ci_trust`          | CI trust level management and security approvals        | Global      |
| `webhook_endpoints` | Webhook endpoint configuration and management           | Global      |
| `event_log`         | Webhook event log metadata and payload viewing          | Global      |
| `event_dlq`         | Webhook event dead-letter queue (requeue, discard)      | Global      |
| `support`           | Enable/disable KiCI support sessions for the org        | Global      |
| `teams`             | Operator-defined teams: membership and team-role grants | Global      |

### Access levels

| Level          | Numeric | Description                                                         |
| -------------- | ------- | ------------------------------------------------------------------- |
| `none`         | 0       | No access (resource hidden from API responses)                      |
| `read`         | 1       | View resource data                                                  |
| `read_payload` | 2       | `event_log` only: read raw webhook payload bodies (may contain PII) |
| `write`        | 3       | Create and modify resources                                         |
| `admin`        | 4       | Full control including deletion and management                      |

Levels are hierarchical: `admin` implies `write`, which implies `read_payload`, which implies `read`. A check for `read` access passes if the user has any level >= `read`. The `read_payload` level is meaningful only for the `event_log` resource (reading raw webhook bodies that may contain PII); for other resources it behaves equivalently to `read`.

### Repo-scoped vs global resources

Repo-scoped resources (`runs`, `workflows`, `secrets`) are filtered by **repo glob patterns** defined on each role. A role with pattern `myorg/backend-*` only grants access to runs, workflows, and secrets for repositories matching that pattern.

**Enforcement:**

- `computeEffectivePermissions()` merges repo patterns from all assigned roles using union semantics (deduplicated). If any role has `*`, the effective pattern is `['*']` (unrestricted).
- The `repoPatterns` array is stored on the HTTP request context alongside `effectivePermissions`.
- **List endpoints** (e.g., `GET /runs`): resolve allowed repos via `resolveAllowedRepos()` and add a `WHERE repo_identifier IN (...)` filter to the query. This ensures pagination counts are correct.
- **Single-resource endpoints** (e.g., `GET /runs/:runId`): check `matchesRepoPattern()` after fetching the resource, returning 403 if the repo doesn't match.
- **API keys and service accounts** always get `['*']` — repo scoping applies only to role-based human users.
- Pattern matching uses [picomatch](https://github.com/micromatch/picomatch) (same library as orchestrator environments).

Global resources (`api_keys`, `webhook_sources`, `org_settings`, `members`, `billing`, `audit`, `environments`, `ci_trust`, `webhook_endpoints`, `event_log`, `event_dlq`, `support`, `teams`) are governed by permission level alone -- repo patterns do not apply.

Every role has at least one repo pattern. The default pattern `*` matches all repositories.

## Custom roles

Organizations can create unlimited custom roles. Each role has:

- **Name** -- unique within the organization (max 100 characters)
- **Description** -- optional (max 500 characters)
- **Permission matrix** -- 16 resources x 5 levels
- **Repo patterns** -- array of glob patterns for scoping repo-bound resources

### Additive stacking

Users can have multiple roles. The effective permission for each resource is the maximum level across all assigned roles:

```
Role "Member":    { runs: 'read',  api_keys: 'read',  members: 'read'  }
Role "Deployer":  { runs: 'write', api_keys: 'read',  members: 'none'  }
────────────────────────────────────────────────────────────────────────
Effective:        { runs: 'write', api_keys: 'read',  members: 'read'  }
```

A `mergePermissions()` helper inside the Platform implements this union logic.

### Zero-role members

Users with no role assignments see the dashboard shell but cannot access any org data. They remain org members -- to fully revoke access, remove them from the organization.

## Built-in roles

### Owner

- **Immutable** -- cannot be edited, deleted, or renamed
- All 16 resources set to `admin`
- Repo pattern: `*`
- Marked with `is_owner = true` in the database
- Visible in the roles tab with a "Built-in" badge
- At least one Owner must exist per organization (last-owner protection)

### Member

- **Default custom role** -- editable and deletable by Owners
- All resources set to `read` by default, except `ci_trust` and `support` which default to `none` (see `DEFAULT_MEMBER_PERMISSIONS` in `permissions.ts`)
- Ships with every new organization
- Assigned automatically to new members on invite acceptance

## Enforcement

All org-scoped dashboard API routes enforce RBAC through a middleware chain:

```
orgContextMiddleware(db) -> requirePermission(db, resource, level) -> route handler
```

### orgContextMiddleware

1. Verifies the authenticated user is a member of the target org (for service accounts, verifies the SA's org_id matches)
2. Blocks disabled organizations (returns 403 with `disabled_at`)
3. Blocks suspended members (returns 403)
4. Computes effective permissions: uses API key permissions if present, otherwise calls `computeEffectivePermissions()` to merge the user's assigned roles
5. Sets `effectivePermissions`, `isOwner`, and `orgRole` on the request context

### requirePermission middleware

Factory function that creates a middleware checking a specific resource + level:

```typescript
requirePermission(db, 'runs', 'write');
// Checks c.get('effectivePermissions').runs >= PERMISSION_HIERARCHY['write']
```

Returns a descriptive 403 error if the check fails:

```json
{ "error": "Insufficient permission: runs.write needed" }
```

### requireAnyPermission middleware

OR-semantics variant that passes if **any** of the given permission checks are satisfied. Returns 403 only when none pass:

```typescript
requireAnyPermission(db, [
  { resource: 'runs', required: 'write' },
  { resource: 'org_settings', required: 'admin' },
]);
// Passes if the user has runs.write OR org_settings.admin
```

### Stateless enforcement

Permissions are checked from the database on every API request. There is no session cache to invalidate -- role changes take effect immediately on the next request.

## Authentication

The dashboard API authenticates callers via OIDC and resolves the calling user's org membership before evaluating permissions.

## Orchestrator-side RBAC: access log and run cancel

The orchestrator has its own fixed 3-role (`owner` / `admin` / `auditor`) RBAC model for its admin HTTP surface (`packages/orchestrator/src/secrets/rbac.ts`). Several permissions added alongside the read-attribution and admin-surface expansion features:

| Permission               | Granted to            | Guards                                                                              |
| ------------------------ | --------------------- | ----------------------------------------------------------------------------------- |
| `access_log.read`        | owner, admin, auditor | `GET /api/v1/admin/access-log` + `GET /api/v1/admin/access-log/:id` + CLI list/show |
| `event_log.read`         | owner, admin, auditor | List/show webhook event-log metadata rows                                           |
| `event_log.read_payload` | owner, admin          | Read raw webhook payload bodies (may contain PII)                                   |
| `event_dlq.read`         | owner, admin, auditor | List/show entries in the webhook event dead-letter queue                            |
| `event_dlq.manage`       | owner, admin          | Requeue or discard webhook event DLQ entries                                        |
| `run.cancel`             | owner, admin          | `POST /api/v1/admin/runs/:runId/cancel` (moved from `/api/v1/runs/:runId/cancel`)   |
| `secret.reveal`          | owner, admin          | The `?reveal=true` variant of the run secret-outputs admin route (decrypts values)  |
| `scheduled_job.trigger`  | owner, admin          | `POST /api/v1/admin/scheduled-jobs:name/trigger` (manually fire a scheduled job)    |

`access_log.read`, `event_log.read`, and `event_dlq.read` are deliberately granted to the `auditor` role — an auditor's job is to read the access log, the webhook event log, and the webhook event DLQ without being able to mutate anything. `event_log.read_payload`, `event_dlq.manage`, `run.cancel`, `secret.reveal`, and `scheduled_job.trigger` are restricted to `owner` + `admin` because each either discloses sensitive payload data or mutates state (read raw payload bodies that may contain PII, requeue/discard a DLQ entry, cancel a run, decrypt and disclose a stored secret value, or fire a periodic job out-of-band) and is not appropriate for a read-only auditor role.

These permissions guard the orchestrator's admin HTTP surface only. The Platform-side dashboard routes continue to use the Platform RBAC resources (`runs:write` for cancel, `audit:read` for the Data access tab).

## Member lifecycle

- **Join** -- via invite acceptance (records the user as an org member with an initial role assignment)
- **Role change** -- Owner assigns or removes roles
- **Suspension** -- Owner suspends the member, which blocks all API access
- **Self-leave** -- member can leave unless they are the last Owner
- **Removal** -- Owner removes the member, which cascades to role assignments, org membership rows, and any user API keys the member created

### Last-owner protection

- The sole Owner of an org cannot leave or be removed
- The sole Owner's Owner role assignment cannot be removed
- These checks run inside database transactions for consistency

## See also

- `packages/orchestrator/src/secrets/rbac.ts` (in the OSS source tree) -- the orchestrator's fixed 3-role model and the permission constants used by its admin HTTP surface
- [Two-layer RBAC (operator guide)](../../operator/security/rbac-two-layers.md) — how this control-plane RBAC relates to the orchestrator-CLI RBAC surface, and how to keep the two in sync.
