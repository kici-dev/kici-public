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

| Surface                                                                                | Deprecated                                                                                                                                                                                                                      | Replacement                                                                                                                                                                                                                                              | Deprecated in | Removal |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------- |
| Secret resolution (`<context>:<secret-name>` in `gitCredentials` and container `auth`) | A reference that names a context by its exact name, where no secret scope bound to that context carries the secret, reads the scope that has the context's name. The orchestrator logs a deprecation warning each time it does. | Bind the scope to the context with `kici-admin context bind`. The reference then resolves through the binding, as every other reference does. See [git credentials](patterns/git-credentials.md) and [private images](container-jobs.md#private-images). | v0.10.0       | v1.0.0  |
