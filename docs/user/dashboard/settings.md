---
title: Settings
description: 'Organization settings — members, roles, teams, keys, sources, billing, security, and support access.'
---

## Settings

The settings page (`/orgs/:customerId/settings`) uses a tabbed layout:

1. **General** -- displays the organization name (editable by owners via inline click-to-edit) and the organization ID
2. **Members** -- team management with invite, role assignment, and member removal
3. **Roles** -- custom role management with granular permission matrix
4. **Teams** -- named groups of members whose granted roles are inherited by every member (visible with `teams:read`; managed with `teams:admin`)
5. **API keys** -- API key creation and revocation for dashboard/programmatic access
6. **Orchestrator keys** -- orchestrator API key management for Platform WebSocket connections
7. **Sources** -- read-only list of registered webhook sources (see below)
8. **Billing** -- plan and payment management
9. **CI trust** -- trust policy configuration for CI runs (visible with `ci_trust:read` permission)
10. **Global workflows** -- org-level security knobs for cross-repo workflows (visible with `org_settings:read` permission)
11. **Webhooks** -- outbound webhook endpoint management with delivery logs and test ping
12. **Event log** -- inbound webhook delivery log (visible with `event_log:read` permission)
13. **Security** -- read-only view of the orchestrator's dashboard-write policy matrix (visible with `org_settings:read` permission)
14. **Support access** -- opt-in switch that controls whether KiCI support staff may open read-only support sessions against your org (visible with `support:read`; toggled with `support:admin`)

Audit-log-style entries are not a settings tab; they live on the dedicated **Activity** page accessible from the sidebar.

Tab selection syncs with the URL path (`/settings/members`, `/settings/api-keys`, etc.), making tabs bookmarkable.

## General


## Members


## Roles


## Teams


## API keys


## Orchestrator keys


The orchestrator keys tab manages API keys used to authenticate orchestrator-to-Platform WebSocket connections. These are separate from user API keys (which grant dashboard/API access).

**List view** -- shows all active orchestrator keys with name, description, key prefix, creation date, and last used date.

**Create** -- opens a modal to enter a name and optional description. After creation, the raw key is shown once in a copyable box. Set this key as the `KICI_PLATFORM_TOKEN` environment variable in your orchestrator configuration.

**Revoke** -- opens a confirmation modal before soft-deleting the key. Any orchestrators using the revoked key will be disconnected.

## Sources


The sources tab shows webhook sources registered by connected orchestrators. Sources appear here **automatically** when an orchestrator connects to the Platform -- there is no manual "add source" action in the UI.

**Each source displays:**

- **Routing key** -- the source identifier (e.g., `github:12345` for a GitHub App, `generic:my-source` for a generic webhook)
- **Webhook URL** -- the URL to configure in your provider's webhook settings
- **Registered at** -- when the orchestrator first registered this source
- **Copy button** -- copies the webhook URL to the clipboard

**Read-only** -- sources cannot be created, edited, or deleted from the dashboard. They are managed entirely by orchestrator connections. When an orchestrator disconnects, its sources remain visible (they are not automatically removed).

**Empty state** -- if no orchestrator has connected yet, the tab shows "No webhook sources registered" with a link to the operator setup guide.

**Webhook secrets** -- webhook secrets are not visible in the dashboard. They are configured on the orchestrator (see the operator guide), never in the dashboard, and are used to verify incoming webhook signatures.

**Adding a new source** requires:

1. Configure a new provider in the orchestrator (e.g., add a GitHub App to the orchestrator's provider config)
2. Configure the webhook secret on the orchestrator (see the operator guide)
3. Restart the orchestrator -- it will register the new source with the Platform on connection
4. Configure the webhook URL (shown in the sources tab) in the provider's settings (e.g., GitHub App webhook URL)

## Billing






## CI trust


## Global workflows






## Webhooks



## Notifications






## Event log



The event log tab (`/orgs/:customerId/settings/event-log`) shows every inbound webhook this organization has received. The event log records, for each delivery: routing key, event, action, repo, status, processing outcome (`processed` / `duplicate` / `lockfile_missing` / `failed`), the matched workflow count, and the first run spawned (if any).

The list view supports filters for routing key, event type, status, and free-text delivery ID search. Click a row to open a detail panel with the full delivery record plus the payload viewer.

**Permissions:**

- `event_log:read` -- list rows and view metadata in the detail panel.
- `event_log:read_payload` -- additionally view the raw webhook payload body. (Owners and admins inherit this. Lower-tier roles see "Payload not available" with a hint to ask for an elevated role.)

**Edge cases the UI surfaces:**

- **Payload omitted** -- when the inbound payload exceeded the configured size cap, the row is still recorded with the payload shown as "omitted".
- **Orchestrator unavailable** -- when the orchestrator does not respond in time, the list still loads with the delivery metadata only, marked with an `orchestrator unavailable` banner.
- **Orchestrator-only deliveries** -- direct-ingress deliveries that never crossed the Platform appear marked `orchestrator_only`.

Retention is 30 days.

## Security


## Support access


The Support access tab controls whether KiCI support staff may open a read-only **support session** against your organization to help diagnose an issue. The setting is **off by default** -- until you opt in here, no one outside your org can read your data.

When support access is enabled:

- A KiCI operator can open a time-boxed (30-minute, renewable), read-only support session scoped to a stated reason.
- A support session is **runs-only**: the operator can browse your run list and, by confirming each run individually, view that run's detail and step logs. Nothing else is visible, and no write is ever possible.
- Every run an operator opens is recorded in your [Activity](./activity-and-dlq.md#activity) audit trail, attributed to the operator with the support reason -- so you can see exactly what was looked at and why.

**Disabling immediately ends any active session.** Toggling the switch off closes every in-progress support session for your org at once. Enabling and disabling the setting is itself audited, attributed to the user who changed it.

Viewing the setting requires the `support:read` permission; changing it requires `support:admin` (granted to owners by default).
