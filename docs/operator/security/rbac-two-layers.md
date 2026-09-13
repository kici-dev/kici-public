---
title: Two-layer RBAC
description: How dashboard RBAC and orchestrator-CLI RBAC differ, why the asymmetry is intentional, and how to keep the two surfaces in sync
---

KiCI ships with two independent RBAC surfaces — one in the SaaS control plane that authorizes dashboard users, and one in the orchestrator that authorizes `kici-admin` bearer tokens. They are not converged at launch: they answer different questions, key on different identifiers, and have different granularities. This page explains the asymmetry, why it exists, and how to operate the two surfaces without creating gaps.

The asymmetry IS the industry-standard pattern for systems with a SaaS control plane and a customer-deployed data plane (Kubernetes cluster RBAC under a higher-level platform RBAC, CI runner permissions under CI vendor org permissions, …). What matters is that you understand which surface controls what, and that you keep token issuance in sync with the role assignments you make in the dashboard.

## The two surfaces at a glance

| Property                                    | Dashboard path (control plane)                                                                                                                                                              | CLI path (orchestrator)                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Audience                                    | Developers, release engineers                                                                                                                                                               | Ops / SRE / operators                  |
| Authority                                   | Control-plane database (`roles`, `role_assignments`)                                                                                                                                        | Orchestrator database (`admin_tokens`) |
| Granularity                                 | Per-user, per-resource, per-verb                                                                                                                                                            | Three fixed roles                      |
| Identity key                                | OIDC `sub` from the user's session                                                                                                                                                          | Opaque bearer token                    |
| Configured via                              | Dashboard → Settings → Roles + Members                                                                                                                                                      | `kici-admin token create`              |
| Resources                                   | 18 typed resources (`runs`, `secrets`, `contexts`, `workflows`, `members`, `api_keys`, `webhook_sources`, `org_settings`, `audit`, `event_log`, `ci_trust`, `support`, `teams`, `fleet`, …) | Coarse — admin tokens get every write  |
| Verbs                                       | `none`, `read`, `read_payload`, `write`, `admin`                                                                                                                                            | Fixed per role                         |
| Per-resource scoping                        | Yes (give `contexts:write` without `secrets:write`)                                                                                                                                         | No (admin = every write)               |
| Per-path scoping (e.g. "scope `prod` only") | Not today                                                                                                                                                                                   | Per-source only (`--routing-key`)      |

## Dashboard RBAC (control plane)

The control plane authorizes every dashboard-routed write. The check runs **before** any request reaches the orchestrator, and it runs **after** the membership / cross-tenant check.

- **Resources** map to the dashboard's nouns: `runs`, `workflows`, `secrets`, `contexts`, `members`, `api_keys`, `webhook_sources`, `webhook_endpoints`, `org_settings`, `billing`, `audit`, `event_log`, `event_dlq`, `ci_trust`, `support`, `teams`, `fleet`, `notifications`.
- **Verbs** are `none`, `read`, `read_payload` (for log payloads + webhook bodies), `write`, `admin`. Each role assignment picks one verb per resource.
- **Built-in roles** ship with sensible defaults: `Owner` gets the highest level on every resource (`admin` everywhere except `fleet`, whose gates top out at `write`), `Member` gets `read` on most things and `none` on the privileged ones — `ci_trust`, `support`, and `fleet` (members must be explicitly granted write).
- **Custom roles** are configured per-org in the dashboard's Settings → Roles tab. A custom role is a typed `{resource → verb}` map.
- **Identity** is the user's OIDC `sub`, resolved from the session cookie issued at login.

The control plane returns a `403` with the resource and the required verb in the response body when the check fails.

### Denied-page experience

Sidebar entries for a resource are hidden when the viewer lacks its read permission. Because pages remain reachable by direct URL or bookmark, a gated page that a viewer cannot read renders a "Permission required" panel rather than a dead-end error. The panel names the exact permission the viewer is missing (for example `fleet:read`), tells them to ask an organization owner or admin to grant it, and links to the members page when the viewer can see it. This applies to the fleet roster, fleet host detail, activity log, and event DLQ pages.

Under the [dashboard-write policy](./dashboard-write-policy.md), the `secrets:write` permission becomes mostly vestigial when `secrets.set` is disabled — the value-write route is gated at a higher layer and the dashboard user never reaches the permission check. **Keep `secrets:write` configured anyway**: it still gates the dashboard's secret-name and scope CRUD (the operations that stay on the dashboard even when value writes are CLI-only).

## Orchestrator RBAC (CLI)

The orchestrator authorizes every `kici-admin` bearer token. The check runs on every orchestrator HTTP admin route — the dashboard never traverses this path.

Three fixed roles:

| Role      | Permissions                                                                                                                                                | Use case                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `owner`   | Every operation, including key rotation and admin-token management                                                                                         | Bootstrap token, break-glass operator |
| `admin`   | Every operation except `token.manage` and `key.rotate`                                                                                                     | Day-to-day operations, CI scripts     |
| `auditor` | Read-only: `context.read`, `audit.read`, `run.read`, `event_log.read`, `access_log.read`, `event_dlq.read` (metadata, no payload bodies, no secret values) | Compliance review, log inspection     |

The full permission list (23 fine-grained permissions in total) lives in the orchestrator's `secrets/rbac.ts`, and the per-role matrix is in the [`kici-admin` CLI reference](../orchestrator/kici-admin-cli.md#rbac-roles).

- **Identity** is the opaque bearer token. The orchestrator looks up the token's role from its `admin_tokens` table; nothing about the token's identity exists outside the orchestrator.
- **Per-resource scoping** is intentionally absent at this layer. An unscoped `admin` token can write every secret in every scope. The granularity is the role, plus the optional single-source scope below.

### Scoping a token to one source with `--routing-key`

`kici-admin token create <label> --role admin --routing-key github:42` restricts the token to one webhook source. This is the least-privilege tool at this layer, and it is a real reduction, not a label:

- On a route that targets a routing key (runs, sources, the event log), the token acts only on its own key. A request for a different key is refused with `403`.
- On every route that has no per-routing-key slice — **all** secret routes, contexts, org settings, and the trust policy — a scoped token is refused with `403` outright, whatever its role.

So a routing-key-scoped `admin` token cannot reach the secret store at all. Issue one whenever an operator's work is confined to a single source.

The scope axis is the source, not the secret scope. Routing keys and secret scopes are different namespaces (see [Routing-key-scoped tokens cannot manage secrets](../orchestrator/kici-admin/secrets-tokens-context.md#routing-key-scoped-tokens-cannot-manage-secrets)), so there is no way to grant a token "the `prod` secret scope only".

## The asymmetry to manage

The two layers don't enforce each other's constraints. The asymmetry that matters most in practice:

> Issuing an orchestrator admin token to someone whose dashboard role doesn't include `secrets:write` effectively grants them secret access. The orchestrator doesn't ask the control plane whether the recipient has the dashboard-side permission.

This is not a bug — it's a direct consequence of the orchestrator being independently deployable. The orchestrator must continue to function under network partitions, control-plane outages, and operator-side disaster-recovery scenarios where the control plane is unreachable. It cannot delegate every authorization decision to the control plane.

The mitigation is operational: keep the two surfaces' authority equivalent for any given individual.

### Recommended pattern: one token per ops engineer, never shared

1. **Issue one orchestrator admin token per ops engineer** with `kici-admin token create <label> --role admin --subject <their-email>`. No shared tokens. Sharing makes audit attribution impossible and increases the radius of a leak. `--subject` is what lets the [reconciliation report](#reconciling-the-two-layers) name the holder later.
2. **Match the orchestrator role to the dashboard role.** If a person has dashboard `admin` on `secrets`, `contexts`, and `runs`, give them an orchestrator `admin` token. If a person has only read access in the dashboard, give them an orchestrator `auditor` token — never an `admin` token, and never an `owner` token.
3. **Use `owner` tokens only for break-glass.** Lock the bootstrap `owner` token in the operator's vault, alongside the recovery procedures for `KICI_SECRET_KEY` and the postgres credentials. Day-to-day ops uses `admin` tokens.
4. **Revoke promptly.** When a person leaves the ops team, revoke both their dashboard membership and their orchestrator token. `kici-admin token revoke <id>` (list ids with `kici-admin token list`) writes an `access_log` row, so the revocation is itself auditable. The token revocation takes effect on the orchestrator at once. The dashboard revocation takes effect on the control plane at once, and reaches the orchestrator's CI-trust decisions on the next push — see [How a CI-trust change reaches the orchestrator](#how-a-ci-trust-change-reaches-the-orchestrator).
5. **Rotate the bootstrap token after orchestrator first-boot.** The orchestrator generates a bootstrap `owner` token on first start and prints it to the logs. After you've created at least one named `owner` token via `kici-admin token create <label> --role owner`, revoke the bootstrap token.

### How a CI-trust change reaches the orchestrator

Your orchestrator decides `/kici approve` comments on held runs. It decides them against a cached copy of your organization's approval directory — the identity links, the per-member CI trust levels, and the team memberships. The hosted Platform owns that directory and pushes it to your orchestrator whenever it changes.

A CI-trust or membership change is therefore eventually consistent on the orchestrator, by design:

- On the Platform, the change takes effect at once.
- On the orchestrator, it takes effect when the next push lands. That normally follows within the control-plane handshake.
- While your orchestrator cannot reach the Platform, no push arrives. It keeps deciding approvals against the directory it last received, for as long as the connection stays down.

The cache is deliberately never expired. An expiring directory would refuse every approval during exactly the outage the cache exists to survive. That is the same property as [What if the control plane is unreachable?](#what-if-the-control-plane-is-unreachable) above: your orchestrator keeps working when the control plane does not.

Two ways to see how far behind your orchestrator is:

- `kici-admin trust-policy directory --customer-id <org-id>` prints when the directory was stored and how long ago. It warns when the Platform connection is down and no push can arrive.
- The `kici_orch_trust_directory_age_seconds` metric reports that age in seconds. Alert on it climbing past the longest outage you accept approvals through. It reports nothing until the first push arrives.

To cut a person off from every surface at once, revoke their orchestrator token as well. A token revocation is decided by the orchestrator itself, so it needs no push.

### Worked example

Alice is a release engineer. Her dashboard role grants `contexts:write` but not `secrets:write`.

- **Wrong:** issue Alice an orchestrator `admin` token "so she can use the CLI." The `admin` role on the orchestrator includes every secret write — Alice now has higher authority on the CLI than she does on the dashboard, and the audit trail shows two different identities for the same human.
- **Right:** if Alice needs CLI access for read-only inspection, issue her an orchestrator `auditor` token. If she needs CLI access for environment writes, ask whether her dashboard role should include `secrets:write` too — the answer is almost always "yes, expand the dashboard role" rather than "issue a more privileged CLI token that bypasses the dashboard role."

### Reconciling the two layers

The recommended pattern above is a set of habits, and habits drift. **Settings → Security → Orchestrator token reconciliation** in the dashboard checks them for you. It reads your orchestrator's live admin tokens, joins each one against your organization's membership and roles, and reports where the two layers disagree.


**Record the holder when you issue a token.** `kici-admin token create <label> --role admin --subject alice@example.com` stores the intended holder — an OIDC subject or an email address. The orchestrator **cannot verify it**, and never reads it when it authorizes a request: the token's role and `--routing-key` scope decide that. `--subject` exists so the report can say whose token this is. A token created without it shows as `unlinked` in `kici-admin token list` and in the report.

The report has three categories:

| Category            | What it means                                                                                                                    | What to do                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Unlinked**        | The token records no holder. Nobody can say whose it is.                                                                         | Re-issue with `--subject`, then `kici-admin token revoke <id>` the old one.                         |
| **Orphaned**        | The recorded holder is not an active member of the organization — they left, were removed, or are suspended.                     | `kici-admin token revoke <id>`. This is step 4 of the pattern above, caught late.                   |
| **Over-privileged** | The token's orchestrator role grants more than its holder's dashboard role does. The worked example above is the canonical case. | Widen the dashboard role, or re-issue a narrower token (`auditor`, or `admin --routing-key <key>`). |

Two things the report deliberately does **not** do:

- **It does not converge the layers.** The orchestrator still authorizes every `kici-admin` request on its own, and never asks the control plane. That independence is the whole point of the split, so the report is a read, and only a read.
- **It does not judge a scoped token on its role alone.** A `--routing-key`-scoped `admin` token cannot reach the secret store, so reporting it against `secrets:write` would be wrong. The report reads the scope.

When the orchestrator is unreachable, the report says so rather than showing an empty result. A report you cannot tell apart from "no drift" is worse than no report.

### When the asymmetry helps you

Under the [dashboard-write policy](./dashboard-write-policy.md), customers who disable the `plaintext` operations route secret and variable values **exclusively** through the CLI. The dashboard RBAC's `secrets:write` permission becomes vestigial for value writes (the route is gated at the policy layer). In this configuration, the orchestrator's CLI RBAC is the **only** layer that authorizes secret value writes — the dashboard cannot reach them.

The asymmetry shifts from "two layers, watch the gap" to "two layers, one of them is intentionally turned off for this operation class." The mental model is the same: every write is authorized by exactly one layer; the operator's job is to know which.

## Where each surface lives in the dashboard

- **Settings → Members** — invite users, assign built-in roles, remove members. Identity is the OIDC `sub`; this page maps it to org membership.
- **Settings → Roles** — define custom roles. Each role is a `{resource → verb}` map. Save → the role becomes selectable on the Members tab.
- **Settings → API keys** — dashboard / programmatic API keys (used for SaaS API access, not orchestrator CLI).
- **Settings → Orchestrator keys** — orchestrator-to-control-plane WebSocket auth tokens (used by the orchestrator process itself; not CLI bearer tokens).
- **Settings → Security → Dashboard policy** — the read-only view of the [dashboard-write policy](./dashboard-write-policy.md).
- **Settings → Security → Orchestrator token reconciliation** — the [drift report](#reconciling-the-two-layers) between orchestrator tokens and dashboard roles. Read-only, and needs `members:admin`.

Orchestrator CLI tokens are **not** managed from the dashboard. They live entirely in the orchestrator's database and are created, listed, and revoked with `kici-admin token`. The reconciliation report reads them; it never changes one.

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

To a **source**, yes. To a **secret scope**, no.

The model is three fixed roles, times an optional single-source scope. `kici-admin token create <label> --role admin --routing-key github:42` confines the token to one webhook source, and a scoped token is refused on every secret, context, org-settings and trust-policy route — so it cannot reach the secret store at all. Use it whenever an operator's work is confined to one source.

There is no per-secret-scope token authority, and none is planned. For read-only access, use an `auditor` token; `auditor` has zero write capability. For anything wider, the advice stands: don't issue an unscoped `admin` token to someone who shouldn't reach every secret.

## See also

- [Dashboard-write policy](./dashboard-write-policy.md) — the per-operation policy that decides which surface a given mutation is reachable on.
- [Secrets management](./secrets.md) — the secret store, master key rotation, multi-backend backends.
- [Audit log](./audit-log.md) — querying `audit_log` and `access_log`.
- [Role-based access control (architecture)](../../architecture/security/rbac.md) — the control-plane permission model: 18 resources, 5 access levels, custom roles, and enforcement.
