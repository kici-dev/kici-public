---
title: Workflows, diagnostics, and orchestrators
description: Registered workflows, infrastructure health, and the per-cluster orchestrator views.
---

## Workflows

The workflows page (`/orgs/:customerId/workflows`) shows permanently registered workflows listening for events. It displays a filterable table with columns for workflow name, repository, trigger types, last triggered time, next fire time (for scheduled workflows), source repos, and actions.

Each row is expandable to show trigger configuration details. Rows include action controls: a "Run now" button for manual triggering, a toggle switch to enable/disable the workflow, and a delete button with a confirmation modal (optionally cancelling active runs). Stale workflows (no triggers in the last 30 days) show a yellow "Stale" badge. Registry health indicators (version, sync status, last updated) appear above the table.

Filters include trigger type, repository, and workflow name.

## Diagnostics

The diagnostics page (`/orgs/:customerId/diagnostics`) provides infrastructure health monitoring. It has four sections:

1. **Execution metrics** -- cards showing total runs (24h), success rate, average duration, and active jobs (queued + running). Refreshes every 30 seconds.
2. **Infrastructure alerts** -- banner summarizing any critical or warning alerts from connected orchestrators
3. **Infrastructure tree** -- hierarchical view of orchestrators, their scalers, and agents. Refreshes every 10 seconds. Each orchestrator row shows:
   - **`orchestrator:`** (bold monospace, left group) -- the orchestrator's cluster instance ID, set via `KICI_CLUSTER_INSTANCE_ID` env var or auto-generated as a UUID. If no instance ID is set, the first 8 characters of the connection ID are shown here instead.
   - **`conn:`** (dimmed monospace, left group) -- first 8 characters of the WebSocket connection ID assigned by the Platform relay. Only shown when an explicit instance ID is present.
   - Connection status badge, role badge (coordinator or worker), version badge (left group, after the ID labels)
   - **`host:`** badge (right side) -- the system hostname of the machine running the orchestrator process
   - Additional badges on the right side: running-as user, CPU count, memory usage, uptime

   Each orchestrator lists its **scalers** (indented at level 1) showing scaler name, type badge (container/firecracker/bare-metal), active/max agent count, and a config info popover. Below each scaler, its **agents** (indented at level 2) display agent ID, platform/arch, heartbeat age, hostname, running-as user, CPU count, memory, uptime, and version. Labels (both user-defined and auto-generated `kici:` prefixed) are shown on a separate row beneath scalers and stateful agents, with a tooltip distinguishing user labels from auto labels.

4. **Secret backends** -- health cards for each configured secret backend (e.g. OpenBao), showing connection status with sync and test actions. Allows triggering a manual sync or connectivity test per backend.

## Orchestrators


