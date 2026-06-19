---
title: Two-layer RBAC
description: How dashboard RBAC and orchestrator-CLI RBAC differ, why the asymmetry is intentional, and how to keep the two surfaces in sync
---

KiCI ships with two independent RBAC surfaces — one in the SaaS control plane that authorizes dashboard users, and one in the orchestrator that authorizes `kici-admin` bearer tokens. They are not converged at launch: they answer different questions, key on different identifiers, and have different granularities. This page explains the asymmetry, why it exists, and how to operate the two surfaces without creating gaps.

The asymmetry IS the industry-standard pattern for systems with a SaaS control plane and a customer-deployed data plane (Kubernetes cluster RBAC under a higher-level platform RBAC, CI runner permissions under CI vendor org permissions, …). What matters is that you understand which surface controls what, and that you keep token issuance in sync with the role assignments you make in the dashboard.

## The two surfaces at a glance

| Property                                    | Dashboard path (control plane)                                                                                                                                                  | CLI path (orchestrator)               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Audience                                    | Developers, release engineers                                                                                                                                                   | Ops / SRE / operators                 |
| Authority                                   | Control-plane database (`roles`, `role_assignments`)                                                                                                                            | Orchestrator database (`api_keys`)    |
| Granularity                                 | Per-user, per-resource, per-verb                                                                                                                                                | Three fixed roles                     |
| Identity key                                | OIDC `sub` from the user's session                                                                                                                                              | Opaque bearer token                   |
| Configured via                              | Dashboard → Settings → Roles + Members                                                                                                                                          | `kici-admin api-key create`           |
| Resources                                   | 16 typed resources (`runs`, `secrets`, `environments`, `workflows`, `members`, `api_keys`, `webhooks`, `org-settings`, `audit`, `event_log`, `ci_trust`, `support`, `teams`, …) | Coarse — admin tokens get every write |
| Verbs                                       | `none`, `read`, `read_payload`, `write`, `admin`                                                                                                                                | Fixed per role                        |
| Per-resource scoping                        | Yes (give `environments:write` without `secrets:write`)                                                                                                                         | No (admin = every write)              |
| Per-path scoping (e.g. "scope `prod` only") | Not today                                                                                                                                                                       | Not today                             |

## Dashboard RBAC (control plane)

The control plane authorizes every dashboard-routed write. The check runs **before** any request reaches the orchestrator, and it runs **after** the membership / cross-tenant check.

- **Resources** map to the dashboard's nouns: `runs`, `workflows`, `secrets`, `environments`, `members`, `api_keys`, `webhooks`, `org-settings`, `audit`, `event_log`, `ci_trust`, `support`, plus a small number of admin-mode resources visible only to the SaaS operator's own org.
- **Verbs** are `none`, `read`, `read_payload` (for log payloads + webhook bodies), `write`, `admin`. Each role assignment picks one verb per resource.
- **Built-in roles** ship with sensible defaults: `Owner` gets `admin` on every resource, `Member` gets `read` on most things and `none` on the privileged ones (members must be explicitly granted write).
- **Custom roles** are configured per-org in the dashboard's Settings → Roles tab. A custom role is a typed `{resource → verb}` map.
- **Identity** is the user's OIDC `sub`, resolved from the session cookie issued at login.

The control plane returns a `403` with the resource and the required verb in the response body when the check fails.

Under the [dashboard-write policy](./dashboard-write-policy.md), the `secrets:write` permission becomes mostly vestigial when `secrets.set` is disabled — the value-write route is gated at a higher layer and the dashboard user never reaches the permission check. **Keep `secrets:write` configured anyway**: it still gates the dashboard's secret-name and scope CRUD (the operations that stay on the dashboard even when value writes are CLI-only).

## Orchestrator RBAC (CLI)

The orchestrator authorizes every `kici-admin` bearer token. The check runs on every orchestrator HTTP admin route — the dashboard never traverses this path.

Three fixed roles:

| Role      | Permissions                                                                                                                                                | Use case                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `owner`   | Every operation, including key rotation and admin-token management                                                                                         | Bootstrap token, break-glass operator |
| `admin`   | Every operation except `token.manage` and `key.rotate`                                                                                                     | Day-to-day operations, CI scripts     |
| `auditor` | Read-only: `context.read`, `audit.read`, `run.read`, `event_log.read`, `access_log.read`, `event_dlq.read` (metadata, no payload bodies, no secret values) | Compliance review, log inspection     |

The full permission list (19 fine-grained permissions in total) lives in the orchestrator's `secrets/rbac.ts` and is exposed via `kici-admin api-key permissions show`.

- **Identity** is the opaque bearer token. The orchestrator looks up the token's role from its `api_keys` table; nothing about the token's identity exists outside the orchestrator.
- **Per-resource scoping** is intentionally absent at this layer. An `admin` token can write every secret in every scope. The granularity is "operator-equivalent or read-only".

## The asymmetry to manage

The two layers don't enforce each other's constraints. The asymmetry that matters most in practice:

> Issuing an orchestrator admin token to someone whose dashboard role doesn't include `secrets:write` effectively grants them secret access. The orchestrator doesn't ask the control plane whether the recipient has the dashboard-side permission.

This is not a bug — it's a direct consequence of the orchestrator being independently deployable. The orchestrator must continue to function under network partitions, control-plane outages, and operator-side disaster-recovery scenarios where the control plane is unreachable. It cannot delegate every authorization decision to the control plane.

The mitigation is operational: keep the two surfaces' authority equivalent for any given individual.

### Recommended pattern: one token per ops engineer, never shared

1. **Issue one orchestrator admin token per ops engineer.** No shared tokens. Sharing makes audit attribution impossible and increases the radius of a leak.
2. **Match the orchestrator role to the dashboard role.** If a person has dashboard `admin` on `secrets`, `environments`, and `runs`, give them an orchestrator `admin` token. If a person has only read access in the dashboard, give them an orchestrator `auditor` token — never an `admin` token, and never an `owner` token.
3. **Use `owner` tokens only for break-glass.** Lock the bootstrap `owner` token in the operator's vault, alongside the recovery procedures for `KICI_SECRET_KEY` and the postgres credentials. Day-to-day ops uses `admin` tokens.
4. **Revoke promptly.** When a person leaves the ops team, revoke both their dashboard membership and their orchestrator token. `kici-admin api-key revoke` writes an `access_log` row, so the revocation is itself auditable.
5. **Rotate the bootstrap token after orchestrator first-boot.** The orchestrator generates a bootstrap `owner` token on first start and prints it to the logs. After you've created at least one named `owner` token via `kici-admin api-key create`, revoke the bootstrap token.

### Worked example

Alice is a release engineer. Her dashboard role grants `environments:write` but not `secrets:write`.

- **Wrong:** issue Alice an orchestrator `admin` token "so she can use the CLI." The `admin` role on the orchestrator includes every secret write — Alice now has higher authority on the CLI than she does on the dashboard, and the audit trail shows two different identities for the same human.
- **Right:** if Alice needs CLI access for read-only inspection, issue her an orchestrator `auditor` token. If she needs CLI access for environment writes, ask whether her dashboard role should include `secrets:write` too — the answer is almost always "yes, expand the dashboard role" rather than "issue a more privileged CLI token that bypasses the dashboard role."

### When the asymmetry helps you

Under the [dashboard-write policy](./dashboard-write-policy.md), customers who disable the `plaintext` operations route secret and variable values **exclusively** through the CLI. The dashboard RBAC's `secrets:write` permission becomes vestigial for value writes (the route is gated at the policy layer). In this configuration, the orchestrator's CLI RBAC is the **only** layer that authorizes secret value writes — the dashboard cannot reach them.

The asymmetry shifts from "two layers, watch the gap" to "two layers, one of them is intentionally turned off for this operation class." The mental model is the same: every write is authorized by exactly one layer; the operator's job is to know which.

## Where each surface lives in the dashboard

- **Settings → Members** — invite users, assign built-in roles, remove members. Identity is the OIDC `sub`; this page maps it to org membership.
- **Settings → Roles** — define custom roles. Each role is a `{resource → verb}` map. Save → the role becomes selectable on the Members tab.
- **Settings → API keys** — dashboard / programmatic API keys (used for SaaS API access, not orchestrator CLI).
- **Settings → Orchestrator keys** — orchestrator-to-control-plane WebSocket auth tokens (used by the orchestrator process itself; not CLI bearer tokens).
- **Settings → Security → Dashboard policy** — the read-only view of the [dashboard-write policy](./dashboard-write-policy.md).

Orchestrator CLI tokens are **not** visible in the dashboard. They live entirely in the orchestrator's database and are managed via `kici-admin api-key`.

## Common questions

### Can I have a single sign-on for both surfaces?

No. The dashboard authenticates via OIDC; the orchestrator's CLI uses bearer tokens. They are separate sign-ins.

### How do I audit what each surface authorized?

Both surfaces write to an audit log:

- The control plane's `audit_log` records every dashboard-routed mutation, including the resource, verb, OIDC `sub`, and outcome.
- The orchestrator's `access_log` records every orchestrator action, including the CLI bearer token's role, the action, and the outcome.

The dashboard's **Activity** page federates both streams into one chronological view so you can answer "what did X do" without checking two systems.

### What if the control plane is unreachable?

The orchestrator continues to function — the orchestrator's CLI is intentionally the operator's escape hatch. Dashboard users see a "control plane unreachable" banner; orchestrator CLI users see no impact.

### Can I scope an orchestrator token to a specific environment or scope?

No. Orchestrator tokens are not path-scoped — a token's role (`admin`, `auditor`, …) applies across every scope. The operational advice is: don't issue `admin` tokens to people who shouldn't have access to every scope. Use `auditor` tokens for read-only access; `auditor` has zero write capability.

## See also

- [Dashboard-write policy](./dashboard-write-policy.md) — the per-operation policy that decides which surface a given mutation is reachable on.
- [Secrets management](./secrets.md) — the secret store, master key rotation, multi-backend backends.
- [Audit log](./audit-log.md) — querying `audit_log` and `access_log`.
- [Role-based access control (architecture)](../../architecture/security/rbac.md) — the control-plane permission model: 16 resources, 5 access levels, custom roles, and enforcement.
