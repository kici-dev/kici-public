---
title: Workflows and infrastructure
description: Registered workflows, infrastructure health, and the per-cluster orchestrator views.
---

## Workflows

The workflows page (`/orgs/:customerId/workflows`) shows permanently registered workflows listening for events. It displays a filterable table with columns for workflow name, repository, trigger types, last triggered time, next fire time (for scheduled workflows), source repos, and actions.

Each row is expandable to show trigger configuration details. Rows include action controls: a "Run now" button for manual triggering, a toggle switch to enable/disable the workflow, and a delete button with a confirmation modal (optionally cancelling active runs). Stale workflows (no triggers in the last 30 days) show a yellow "Stale" badge. Registry health indicators (version, sync status, last updated) appear above the table.

Filters include trigger type, repository, and workflow name.

## Infrastructure

The infrastructure page (`/orgs/:customerId/infrastructure`) provides infrastructure health monitoring. The orchestrator → scaler → agent tree is the canonical list of every orchestrator connected to this org — each top-level row carries a **Manage →** link into that cluster's per-cluster views. It has four sections plus a filter:


- **Filter** -- a search box plus Status and Scaler-type facets above the tree. Typing narrows the tree to matching orchestrators, scalers, and agents (a node stays visible if it or any descendant matches), auto-expands branches that match on a descendant, and shows a running result count. While a filter is active, every scaler's agents are loaded up front so agent-level matches resolve across collapsed branches; with no filter the tree loads agents lazily on expand.

1. **Execution metrics** -- cards showing total runs (24h), success rate, average duration, and active jobs (queued + running). Refreshes every 30 seconds.
2. **Infrastructure alerts** -- banner summarizing any critical or warning alerts from connected orchestrators. Each alert carries a type (`zero-agents`, `capacity`, `label-gaps`, `no-raft-leader`) and a severity (`warning` or `critical`). A severity the page does not recognize is rendered at the critical level, so an unfamiliar alert is never shown as less urgent than it might be.
3. **Infrastructure tree** -- hierarchical view of orchestrators, their scalers, and agents. Refreshes every 10 seconds. Each orchestrator row shows:
   - **`orchestrator:`** (bold monospace, left group) -- the orchestrator's cluster instance ID, set via `KICI_CLUSTER_INSTANCE_ID` env var or auto-generated as a UUID. If no instance ID is set, the first 8 characters of the connection ID are shown here instead.
   - **`conn:`** (dimmed monospace, left group) -- first 8 characters of the WebSocket connection ID assigned by the Platform relay. Only shown when an explicit instance ID is present.
   - Connection status badge, role badge (coordinator or worker), version badge (left group, after the ID labels)
   - **`host:`** badge (right side) -- the system hostname of the machine running the orchestrator process
   - Additional badges on the right side: running-as user, CPU count, memory usage, uptime

   Each orchestrator lists its **scalers** (indented at level 1) showing scaler name, type badge (container/firecracker/bare-metal), active/max agent count, and a config info popover. Below each scaler, its **agents** (indented at level 2) display agent ID, platform/arch, heartbeat age, hostname, running-as user, CPU count, memory, uptime, and version. Labels (both user-defined and auto-generated `kici:` prefixed) are shown on a separate row beneath scalers and stateful agents, with a tooltip distinguishing user labels from auto labels.

4. **Secret backends** -- health cards for each configured secret backend (e.g. OpenBao), showing connection status with sync and test actions. Allows triggering a manual sync or connectivity test per backend.

## Per-cluster views

Click an orchestrator's **Manage →** link in the infrastructure tree to drill into that cluster's per-orch surfaces (security policy, contexts, secrets, DLQ, registrations, global workflows), keyed by **cluster name** — the human-friendly name set on the orch via `kici-admin cluster-name set <name>`, or an auto-generated `cluster-<6hex>` if no operator has renamed it. Different clusters in the same org can have different settings, so the tree row is the entry point that lets you pick which cluster you're configuring.

