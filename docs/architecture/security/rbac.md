---
title: Role-based access control (RBAC)
description: Permission model, custom roles, enforcement, and member lifecycle
---

KiCI uses an in-house RBAC system for all authorization decisions. The OIDC issuer handles authentication only (login, user creation, email invites). All permission data lives in the KiCI database, giving operators full control over access policies without external dependencies.

## Overview

Every organization in KiCI has a set of roles. Each role defines a permission matrix mapping 18 resources to 5 access levels. Users can have multiple roles assigned simultaneously -- their effective permissions are computed as the union (most permissive wins) across all assigned roles.

```
User -> [Role A, Role B, Role C] -> merge(permsA, permsB, permsC) -> Effective Permissions
```

This additive model means roles only grant access -- there are no deny rules. Adding a role can never reduce a user's permissions.

## Permission model

### Resources

| Resource            | Description                                                                                                                                                              | Scope       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| `runs`              | Workflow runs, jobs, steps, logs                                                                                                                                         | Repo-scoped |
| `workflows`         | Workflow definitions and lock files                                                                                                                                      | Repo-scoped |
| `secrets`           | Encrypted secret values and contexts                                                                                                                                     | Global      |
| `api_keys`          | User API keys, orchestrator keys, and service accounts                                                                                                                   | Global      |
| `webhook_sources`   | Webhook source registration and secrets                                                                                                                                  | Global      |
| `org_settings`      | Organization display name, configuration                                                                                                                                 | Global      |
| `members`           | Member management, roles, invitations                                                                                                                                    | Global      |
| `billing`           | Plan management, checkout, subscriptions                                                                                                                                 | Global      |
| `audit`             | Audit log viewing (read-only resource)                                                                                                                                   | Global      |
| `contexts`          | Deployment context definitions, variables, and protection rules; `write` is required to approve or reject a reviewer or concurrency hold, `admin` to act on a timer hold | Global      |
| `ci_trust`          | CI trust level management; required to approve or reject a security hold                                                                                                 | Global      |
| `webhook_endpoints` | Webhook endpoint configuration and management                                                                                                                            | Global      |
| `event_log`         | Webhook event log metadata and payload viewing                                                                                                                           | Global      |
| `event_dlq`         | Webhook event dead-letter queue (requeue, discard)                                                                                                                       | Global      |
| `support`           | Enable/disable KiCI support sessions for the org                                                                                                                         | Global      |
| `teams`             | Operator-defined teams: membership and team-role grants                                                                                                                  | Global      |
| `fleet`             | Fleet management: host roster, host declare/remove, agent control                                                                                                        | Global      |
| `notifications`     | Notification channels and subscriptions (Slack, delivery config)                                                                                                         | Global      |

### Access levels

| Level          | Numeric | Description                                                         |
| -------------- | ------- | ------------------------------------------------------------------- |
| `none`         | 0       | No access (resource hidden from API responses)                      |
| `read`         | 1       | View resource data                                                  |
| `read_payload` | 2       | `event_log` only: read raw webhook payload bodies (may contain PII) |
| `write`        | 3       | Create and modify resources                                         |
| `admin`        | 4       | Full control including deletion and management                      |

Levels are hierarchical: `admin` implies `write`, which implies `read_payload`, which implies `read`. A check for `read` access passes if the user has any level >= `read`. The `read_payload` level is meaningful only for the `event_log` resource (reading raw webhook bodies that may contain PII); for other resources it behaves equivalently to `read`.

### Repo-scoped operations vs global resources

Repo scoping is a property of each **operation**, not of a resource. Every
developer operation declares whether it acts on a specific repository's
resource, and an operation that does must honour the caller's repo glob patterns
on every entrypoint that exposes it — the web UI and `kici` CLI (which share one
REST API), and the developer MCP tool surface.

**Repo-scoped operations:**

- **Runs** — listing, reading, step logs, cancel, cancel-by-branch, and re-run.
- **Workflow registrations** — listing, trigger ("run now"), disable, and delete.
- **Held runs** — listing the approval queue, and approving or rejecting a hold.

A role with pattern `myorg/backend-*` therefore sees and drives only those
repositories' runs, registrations, and held runs.

Because scoping is per operation, an operation's repo scoping is independent of
the resource its permission level is checked against. Approving a held run is
gated on the permission matching the hold's type (`contexts:write`,
`contexts:admin` for a timer hold, `ci_trust:write` for a security hold).
`contexts` and `ci_trust` are both global resources, so patterns do not narrow
what a role may edit — yet the approval itself acts on one
repository's run and is therefore repo-scoped. Reading the queue is scoped for
the same reason: `contexts:read` alone would otherwise enumerate every hold in
the org, so the read would answer what acting on it refuses.

A registration is matched on the repository it was **registered from**. For a
workflow that runs against other repositories, that authoring repository is what
the patterns are checked against.

**A run of an organization-wide workflow belongs to two repositories.** Such a
workflow lives in one repository and fires on events from many others, so its
runs carry both: the repository the run acted on, and the repository that
defines the workflow. A member scoped to **either** repository reaches the run —
the team that triggered it and the team that authored the workflow both see it,
in the run list, the filter dropdown (which offers both repositories), the
`?repository=` filter, every run sub-resource, and the equivalent MCP tools.
Cancelling is granted on the same either-repository rule, so the team whose
workflow is running can always stop it. Releasing a **held** run is the one
exception: approving or rejecting a hold permits code to execute against the
repository the run acts on, so it stays with a member scoped to that repository.
The held-runs **list** is scoped the same narrow way, so it keeps agreeing with
the approve and reject routes — a member scoped only to the defining repository
sees the run itself but not its hold, rather than seeing a hold they would then
be refused.

The widened rule applies only to a run whose two repositories genuinely differ.
An ordinary run records no separate workflow repository, so it is matched on its
own repository exactly as before, and a member scoped to neither repository is
refused in every case.

**Secrets are NOT repo-scoped.** Scoped secrets are keyed by context /
environment on the customer's orchestrator, so there is no repository to scope
against: a role's repo patterns do not narrow secret access. Access to secrets
is governed by the permission level (`secrets:read` / `secrets:write`) together
with the context the secret is bound to.

**Enforcement:**

- `computeEffectivePermissions()` merges repo patterns from all assigned roles using union semantics (deduplicated). If any role has `*`, the effective pattern is `['*']` (unrestricted).
- On the HTTP plane the `repoPatterns` array is stored on the request context alongside `effectivePermissions`. The developer MCP plane has no request context — it resolves the org per tool call — so it resolves the same patterns per call and threads them into the shared operation layer.
- **List endpoints** (e.g., `GET /runs`, `GET /registrations`, `GET /held-runs`, and the MCP `list_runs` / `list_workflows` / `cancel_runs_by_branch` tools): narrow the result to the repositories the caller may see. For runs this is a SQL filter over both of a run's repositories, which keeps pagination counts correct; for registrations and held runs, which the control plane relays rather than stores, the relayed set is filtered on return. A held run carries no repository of its own, so its owning run is resolved against the Platform's mirrored `execution_runs` and a hold whose run has not been mirrored yet is dropped — the filter fails closed. Either way a repo-restricted caller cancelling a shared branch never reaches another repository's runs.
- **Single-resource endpoints** (e.g., `GET /runs/:runId`, `POST /registrations/:id/trigger`, `POST /held-runs/:heldRunId/approve`): apply the check after resolving the target's repository, returning 403 if it does not match. The denial also writes an `authz.denied` audit row with `target_type = 'repo'`, the same way an insufficient-permission denial is recorded. On the held-run approve and reject routes the repo check runs **before** the hold-type branch, and its refusal names neither the hold type nor the permission that type would have required — otherwise the refusal itself would tell the caller what kind of hold they are not allowed to see.
- **Single-resource MCP tools** (`get_run`, `get_step_logs`, `cancel_run`, `rerun_run`, `trigger_run`, `approve_run`, `reject_run`): apply the same policy after resolving the target, but report the denial as an indistinguishable "not found" rather than an explicit refusal — an agent surface must not become an enumeration oracle for repositories the caller cannot see. The `authz.denied` audit row still records the real reason and the repository.
- **Live run subscriptions** (the dashboard's WebSocket plane): the live step-log and provisioning-log subscriptions resolve the caller's patterns against the run's repositories when the subscription is accepted, and a run outside them is refused with the same indistinguishable response a run in another organization gets. The organization-level status stream is not run-scoped, so it is matched per message instead: a repo-restricted subscriber receives status, step and context updates only for runs it may see. The patterns are re-resolved periodically, so narrowing a member's scope — or removing them from the organization — stops an already-open stream without waiting for them to close the page.
- **The `kici run remote` control plane** (`/orgs/:customerId/test/*`) is scoped by **ownership**, not by repository. A remote test run of a local working tree carries the synthetic identifier `local/<name>`, which matches no member's patterns, and the Platform's mirrored run row has not arrived when the CLI makes its first status poll — so a repository check there would deny the developer their own run. The Platform records the triggering principal when it relays the trigger, and the status, logs and cancel routes admit that principal, plus any caller whose patterns are `['*']` (who can already read these runs on the dashboard run plane, where they are mirrored and rendered). A run with no recorded owner is refused: the check fails closed. Denials are an indistinguishable "run not found" and write an `authz.denied` audit row with `target_type = 'run'`.
- **API keys and service accounts** always get `['*']` — repo scoping applies only to role-based human users. This holds on both planes: a user agent PAT inherits the minting user's patterns, while an org agent API key is unrestricted within its permission level.
- Patterns are matched as globs: `*` does not cross a `/` separator (so `org/*` covers `org/backend` but not `org/sub/deep`), and matching is case-sensitive. The orchestrator's context bindings use the same glob semantics.

Global resources (`api_keys`, `webhook_sources`, `org_settings`, `members`, `billing`, `audit`, `contexts`, `secrets`, `ci_trust`, `webhook_endpoints`, `event_log`, `event_dlq`, `support`, `teams`, `fleet`, `notifications`) are governed by permission level alone -- repo patterns do not apply.

Every role has at least one repo pattern. The default pattern `*` matches all repositories.

#### Patterns are an allow-list — there is no deny semantic

A role's repo patterns only ever **grant** access — the model carries no deny semantic. Patterns from all assigned roles are unioned, so a deny in one role could not be reconciled with an allow in another. To restrict a role, list the repositories it may reach.

Four negation forms would turn a restriction into a grant. A leading `!` — `!myorg/secret-keys` — expands to "every repository except `myorg/secret-keys`". The extglob complement `!( … )` does the same wherever it appears in the pattern, so `myorg/!(secret-keys)` expands to "every repository under `myorg/` except `secret-keys`" — narrower, and the same defect. The negated character class `[^ … ]` does it one character at a time: `myorg/[^s]*` expands to "every repository under `myorg/` whose name does not begin with `s`", excluding the one repository it names and admitting the rest. The negative assertions `(?! … )` and `(?<! … )` are the widest, because each can spell a whole repository identifier rather than one character: `(?!myorg/secret-keys)**` expands to "every repository in every organization except `myorg/secret-keys`". Both layers refuse all four forms:

- **At write time**, a pattern that begins with `!`, or contains `!(`, `[^`, `(?!` or `(?<!`, is rejected. This applies to the role create and update endpoints (HTTP 400), to `kici-platform-admin role create --repo-patterns` (non-zero exit, nothing written), and to the shared role writer itself, so no future write path can skip the rule.
- **At match time**, such a pattern matches no repository. Nothing is granted through it, so it cannot widen access.

The other extglob heads — `*( … )`, `+( … )`, `@( … )`, `?( … )` — do not complement and are accepted. So are the positive assertions `(?= … )` and `(?<= … )`, a non-capturing group `(?: … )`, and a plain group, each of which grants only what it names. So is the bracket form `[! … ]`, which is **not** the POSIX negation here: the matcher reads it as a literal class containing `!` and the characters listed, so `myorg/[!s]*` admits exactly the repositories whose name begins with `!` or `s` — a genuine restriction rather than a grant.

A `!` that is part of a repository name — `myorg/we!rd` — is matched literally, so such a repository still matches normally.

#### Repository scope is part of the grant ceiling

Repository scope is a privilege in its own right, so a member cannot hand out a
scope wider than the one they hold. Every path that writes or grants a role runs
the containment rule below: role create, role update, assigning a role to a
member, granting a role to a team, and inviting a member into a role. The check
is independent of the permission-level ceiling, so widening a role's patterns is
refused even when the request changes no permission at all.

The rule is deliberately conservative. A pattern is grantable when:

- the caller's own scope is `*` (they may grant anything), or
- the caller already holds that exact pattern, or
- the request names one concrete repository that the caller's own patterns
  already reach.

Everything else is refused with **403**, naming the pattern. That includes `*`
requested by a scoped caller, a repository outside the caller's patterns, and a
glob the caller does not hold literally — even one that is genuinely narrower,
such as `myorg/backend-*` requested by a caller holding `myorg/*`. Deciding glob
containment in general is not tractable, and a wrong verdict on an authorization
boundary hands out access; the workaround is to grant the literal pattern
instead. A caller whose scope cannot be determined grants nothing.

Creating a role with `repoPatterns` **omitted** is the same as requesting `*`,
because that is the field's default — so a scoped caller is refused there too.

Organization API keys carry no repository scope of their own and operate across
every repository within their permission level. Minting one from a
repository-restricted account would therefore launder that account into
unrestricted access, so `POST /orgs/:customerId/api-keys` refuses with **403**
for a caller whose own scope is not `*`. An unrestricted caller is unaffected.

The break-glass `kici-platform-admin role create` is exempt: it is an operator
tool that runs against the database directly and has no user ceiling to measure
against.

## Custom roles

Organizations can create unlimited custom roles. Each role has:

- **Name** -- unique within the organization (max 100 characters)
- **Description** -- optional (max 500 characters)
- **Permission matrix** -- 18 resources x 5 levels
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
- Every resource set to its highest level: `admin` on 17 of the 18 resources, and `write` on `fleet` (whose gates top out at `fleet:write`, so `write` already grants full fleet control). See `DEFAULT_OWNER_PERMISSIONS` in `permissions.ts`
- Repo pattern: `*`
- Marked with `is_owner = true` in the database
- Visible in the roles tab with a "Built-in" badge
- At least one Owner must exist per organization (last-owner protection)

### Member

- **Default custom role** -- editable and deletable by Owners
- All resources set to `read` by default, except `ci_trust`, `support`, and `fleet` which default to `none` (see `DEFAULT_MEMBER_PERMISSIONS` in `permissions.ts`)
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

The orchestrator has its own fixed 3-role (`owner` / `admin` / `auditor`) RBAC model for its admin HTTP surface (`packages/orchestrator/src/secrets/rbac.ts`), spanning 23 fine-grained permissions. The read-attribution and admin-surface permissions are:

| Permission               | Granted to            | Guards                                                                              |
| ------------------------ | --------------------- | ----------------------------------------------------------------------------------- |
| `access_log.read`        | owner, admin, auditor | `GET /api/v1/admin/access-log` + `GET /api/v1/admin/access-log/:id` + CLI list/show |
| `event_log.read`         | owner, admin, auditor | List/show webhook event-log metadata rows                                           |
| `event_log.read_payload` | owner, admin          | Read raw webhook payload bodies (may contain PII)                                   |
| `event_dlq.read`         | owner, admin, auditor | List/show entries in the webhook event dead-letter queue                            |
| `event_dlq.manage`       | owner, admin          | Requeue or discard webhook event DLQ entries                                        |
| `run.cancel`             | owner, admin          | `POST /api/v1/admin/runs/:runId/cancel`                                             |
| `secret.reveal`          | owner, admin          | The `?reveal=true` variant of the run secret-outputs admin route (decrypts values)  |
| `scheduled_job.trigger`  | owner, admin          | `POST /api/v1/admin/scheduled-jobs:name/trigger` (manually fire a scheduled job)    |
| `attestation.retry`      | owner, admin          | Drain / re-arm the deferred-attestation outbox                                      |
| `orchestrator.drain`     | owner, admin          | `GET`/`POST /api/v1/admin/orchestrator/drain` (drain, resume, status)               |
| `ci_trust.read`          | owner, admin          | `GET /api/v1/admin/trust-policy` (read the org-wide CI trust policy)                |
| `ci_trust.admin`         | owner, admin          | `PATCH /api/v1/admin/trust-policy` (modify org-wide trust policies)                 |

`access_log.read`, `event_log.read`, and `event_dlq.read` are deliberately granted to the `auditor` role — an auditor's job is to read the access log, the webhook event log, and the webhook event DLQ without being able to mutate anything. The remaining permissions are restricted to `owner` + `admin` because each either discloses sensitive payload data or mutates state (read raw payload bodies that may contain PII, requeue/discard a DLQ entry, cancel a run, decrypt and disclose a stored secret value, fire a periodic job out-of-band, re-arm the deferred-attestation outbox, quiesce the coordinator, or read and change the org trust policy that decides whether a fork PR runs at all) and is not appropriate for a read-only auditor role.

The full 23-permission matrix, including the `context.*` / `secret.*` / `token.manage` / `key.rotate` permissions, is in the [`kici-admin` CLI reference](../../operator/orchestrator/kici-admin-cli.md#rbac-roles).

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
