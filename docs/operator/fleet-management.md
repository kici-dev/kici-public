---
title: Fleet management
description: The three-tier per-org gate that controls who can use fleet management
---

Fleet management lets an organization view and manage its declared host fleet from the dashboard. Access is controlled by a **three-tier gate** so the feature can be rolled out deliberately: an organization must be marked eligible, then turn the feature on for itself, before it appears.

## The three tiers

The feature is effectively on for an organization when:

```
effectiveEnabled = globalDefault || (eligible && enabled)
```

| Tier               | Controlled by                           | Default | Answers                                     |
| ------------------ | --------------------------------------- | ------- | ------------------------------------------- |
| **1. Eligibility** | KiCI operator                           | off     | "May this org use fleet management at all?" |
| **2. Activation**  | Org owner                               | off     | "Has the org turned it on?"                 |
| **3. GA**          | `KICI_FLEET_MANAGEMENT_DEFAULT_ENABLED` | off     | "Is it on for everyone?"                    |

- **Eligibility** allows but does not activate — once an org is eligible, it still self-enables (tier 2). An org that is not eligible never sees the activation toggle and cannot turn the feature on.
- **Activation** is the org owner's self-service switch, gated by the `fleet:admin` permission (owners hold it by default).
- **GA** is the global override: when `KICI_FLEET_MANAGEMENT_DEFAULT_ENABLED` is `true`, fleet management is effectively on for every org regardless of tiers 1 and 2.

## The activation toggle


The activation toggle lives in the organization's settings under **Fleet management**. It is shown only when the organization is eligible — until then, the feature is invisible to the organization.

## The global GA flag

`KICI_FLEET_MANAGEMENT_DEFAULT_ENABLED` (Platform env, default `false`) is the cluster-wide override. Setting it to `true` makes fleet management effectively enabled for every organization, bypassing the per-org eligibility and activation flags. Leave it unset until the feature is ready for general availability.

## The fleet view

Once fleet management is effectively enabled for an organization, a **Fleet** section appears in the dashboard for members who hold the `fleet:read` permission (Owners by default). It surfaces the declared host fleet read-only — viewing the fleet never changes it.

### Roster


The roster reads through the orchestrator that owns the organization's host fleet, so the status you see is the orchestrator's live view of each host.

### Host detail


A host's recent runs link back to the run detail page so you can trace what each host has executed. The `runsOnAll` preview is a read-only what-if — it never starts a run.

## Managing hosts

Members who hold the `fleet:write` permission can change the host inventory from the dashboard: declare a static host into the roster, and remove a host. Both actions are also available from the command line via `kici-admin host declare` and `kici-admin host remove`.

### Declare a host


Declaring a host names an expected member of the fleet ahead of time, so a `runsOnAll` fan-out can target it (and report it as unreachable) instead of silently skipping a host that has not connected yet. The command-line equivalent is `kici-admin host declare --agent-id <id> --labels <a,b>`.

### Remove a host


The command-line equivalent is `kici-admin host remove --agent-id <id>`.

### Per-operation policy

Both writes are governed by the orchestrator's per-operation dashboard-write policy. An operator can disable either one for an organization with `kici-admin org-settings dashboard-writes`, which makes the dashboard control render disabled with the matching command-line equivalent to run instead. When an operation is disabled, the dashboard request is refused and the attempt is recorded in the access log.
