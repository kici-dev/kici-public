---
title: Fleet management
description: View and manage your organization's declared host fleet from the dashboard
---

Fleet management lets an organization view and manage its declared host fleet from the dashboard: a roster of every declared host, per-host detail, and controls to declare or remove hosts. It is always available; who can see and manage the fleet is governed by the `fleet` permission.

## The fleet view

A **Fleet** section appears in the dashboard for members who hold the `fleet:read` permission (Owners by default). It surfaces the declared host fleet read-only — viewing the fleet never changes it.

### Roster


The roster reads through the orchestrator that owns the organization's host fleet, so the status you see is the orchestrator's live view of each host.

### Host detail


A host's recent runs link back to the run detail page so you can trace what each host has executed. The fan-outs list is a read-only, derived view — it never starts a run.

## Managing hosts

Members who hold the `fleet:write` permission can change the host inventory from the dashboard: declare a new static host into the roster, and remove a host that nobody confirmed. The command-line equivalents, `kici-admin host declare` and `kici-admin host remove`, can change and remove any host.

### Declare a host


A host declared with `kici-admin host declare --agent-id <id> --labels <a,b>` is confirmed at once. It names an expected member of the fleet ahead of time, so a `runsOnAll` fan-out can target it (and report it as unreachable) instead of silently skipping a host that has not connected yet.

The dashboard only creates hosts. It refuses a declare for an agent id that already exists (HTTP 409 `host_exists`). It also refuses labels or properties in the reserved `kici:` namespace (HTTP 400 `reserved_property`). To change an existing host, or to set reserved keys such as the agent restart commands, use `kici-admin host declare`. When the agent registers, its own labels, hostname and properties replace the declared ones.

### Remove a host


The command-line equivalent is `kici-admin host remove --agent-id <id>`.

### Per-operation policy

Both writes are governed by the orchestrator's per-operation dashboard-write policy. An operator can disable either one for an organization with `kici-admin org-settings dashboard-writes`, which makes the dashboard control render disabled with the matching command-line equivalent to run instead. When an operation is disabled, the dashboard request is refused and the attempt is recorded in the access log.
