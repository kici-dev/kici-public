---
title: Environments, secrets, and approvals
description: Deployment environments, secret scopes, and the approval queue.
---

## Environments

The environments page (`/orgs/:customerId/environments`) lists all deployment environments for the organization. Each environment shows its name, type (fixed or glob pattern), protection status (branch restrictions, concurrency limits, required reviewers, wait timers), and enabled/disabled state.

Users with `environments:admin` permission can create new environments via a modal dialog, choosing between fixed and glob (pattern-matching) types. Clicking an environment row navigates to the environment detail page.

### Environment detail

The environment detail page (`/orgs/:customerId/environments/:environmentId`) shows a header with the environment name, type badge, enabled/disabled toggle, and a delete button. Below the header, a tabbed layout provides four sections:

1. **Variables** (default) -- environment-scoped variables
2. **Secrets** -- secrets bound to this environment
3. **Protection** -- protection rules (branch restrictions, concurrency limits, required reviewers, wait timers)
4. **History** -- audit history of changes to this environment

Tab selection syncs with the URL path (`/orgs/:customerId/environments/:environmentId/variables`, `/orgs/:customerId/environments/:environmentId/protection`, etc.).

## Secrets

The secrets page (`/orgs/:customerId/secrets`) provides a scope-centric view of all secrets in the organization. Secrets are organized into a scope tree with environment binding checkboxes, allowing you to control which secret scopes are available in which environments.

Permission-gated: `secrets:read` to view scopes, `secrets:write` to add or delete secrets, `environments:write` to modify environment bindings.

### Where secrets live

Secret values are stored in the orchestrator's secret store and authorized through the orchestrator's RBAC. The dashboard surfaces secret **names** and scope membership for every secret regardless of where the value was entered.

Whether secret **values** can be set from the dashboard depends on the orchestrator's [dashboard-write policy](/operator/security/dashboard-write-policy):

- **Permissive (default):** the "Add secret" and "Edit value" controls accept plaintext directly in the dashboard. This is how a typical SaaS CI tool works and is the right default for small teams.
- **`secrets.set` disabled by policy:** the controls render with a lock icon, grayed out. Hovering shows the exact `kici-admin secret set` invocation needed; a copy button puts it on the clipboard. The control is inert — the dashboard issues no mutating request. Use the CLI to enter values; the dashboard refreshes within ~30 seconds and shows the new secret name.

The policy state is visible at three layers in the UI:

- A **lock-icon prefix** on every disabled control, with a per-control CLI hint.
- A **per-page banner** on any page containing at least one disabled operation, listing every disabled op on that page and its CLI equivalent.

The Security policy page (Settings → Security → Dashboard policy) renders the full 24-row read-only matrix with the current state and the `kici-admin` command for each row. The policy itself cannot be changed from the dashboard — the orchestrator operator manages it via `kici-admin org-settings dashboard-writes`. See [Dashboard-write policy](/operator/security/dashboard-write-policy) for the operator-side details.

## Approval queue

The approval queue page (`/orgs/:customerId/approval-queue`) shows held runs that are pending approval. Runs can be held due to environment protection rules (required reviewers, wait timers). The page supports filtering by status (pending, approved, rejected, expired) and provides approve/reject actions for users with `environments:write` permission. Users with `environments:admin` permission can skip wait timers.
