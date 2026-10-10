---
title: Deprecations and compatibility
description: What KiCI has deprecated, what to use instead, and when each deprecated form is removed.
---

KiCI keeps its published surfaces working across `0.x` releases. When a
surface changes, the old form is **deprecated**: it keeps working, beside the
new form, until it is removed. A deprecated form is removed only at a **major
version bump**. While KiCI is on the `0.x` line, that first removal is
**v1.0.0**.

This page lists everything currently deprecated on a customer- or
operator-facing surface: the SDK, the `kici` and `kici-admin` CLIs, `.kici/`
configuration, and the customer-facing side of the wire protocol, lock file,
secret resolution, and storage layout.

## How to read this table

| Column            | Meaning                                                                           |
| ----------------- | --------------------------------------------------------------------------------- |
| **Surface**       | Where the deprecation applies (SDK export, CLI flag, config field, behaviour, …). |
| **Deprecated**    | The old form that still works but is deprecated.                                  |
| **Replacement**   | What to migrate to.                                                               |
| **Deprecated in** | The release that introduced the deprecation.                                      |
| **Removal**       | The release that removes the old form (`v1.0.0` on the `0.x` line).               |

## Deprecated surfaces

| Surface                                            | Deprecated                                      | Replacement                                                                                | Deprecated in | Removal  |
| -------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------- | -------- |
| `kici-admin cold-store reconcile` flag             | `--confirm-cleanup`, which never had an effect  | None: omit the flag. `reconcile` rebuilds missing manifests and changes no chunk counters. | `0.16.0`      | `v1.0.0` |
| `kici-admin api-key` (`create`, `add-routing-key`) | the whole command group, which no server serves | `kici-admin token create <label> --role <role> --subject <who> --expires <duration>`       | `0.17.0`      | `v1.0.0` |
| `kici run remote` flag                             | `--routing-key`, which never had an effect      | None: omit the flag. The orchestrator chooses the routing key.                             | `0.17.0`      | `v1.0.0` |
| `kici login` flag                                  | `--routing-key`, whose value nothing reads      | None: omit the flag.                                                                       | `0.17.0`      | `v1.0.0` |
| `~/.kici/config` field                             | `routingKey`, which nothing reads               | None: delete the field.                                                                    | `0.17.0`      | `v1.0.0` |
