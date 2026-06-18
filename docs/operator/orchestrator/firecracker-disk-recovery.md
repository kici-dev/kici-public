---
title: Firecracker data disk recovery
description: Recover a Firecracker orchestrator node whose data disk has filled with leaked jailer chroots.
---

## Symptom

A Firecracker scaler node — especially a rootless edge worker — can fill its data
disk with leaked jailer chroots. When the disk reaches 100%, the orchestrator can
no longer write its log and database files and crash-loops at startup with:

```
ENOSPC: no space left on device, write
```

The systemd unit sits in `activating (auto-restart)` and never reaches a healthy
state. The data volume (the scaler's `chrootBaseDir`, default `/srv/jailer`) is
full of leftover per-VM chroot directories under `firecracker/`.

This is a bootstrap deadlock: the in-process orphan sweep that would free the disk
only runs once the orchestrator is up, but the orchestrator cannot start while the
disk is full.

## Recovery

Run the standalone reaper on the affected host:

```bash
kici-admin scaler reap-orphans
```

The command loads the orchestrator's local config, reconstructs the Firecracker
scaler backends without a running orchestrator or database, and frees leaked
resources. It is the supported recovery path — no manual `chown` / `rm` of chroot
directories is needed.

What it does:

- **Reaps only dead VMs.** A liveness pre-scan reads each chroot's
  `firecracker.pid` and protects any VM whose process is still alive. Chroots and
  TAP devices belonging to dead VMs are removed; live VMs are never touched.
- **Reclaims ownership first.** On rootless nodes the reaper reclaims ownership of
  each leaked chroot before deleting it, so disk owned by the jailer's subuid is
  actually freed.
- **No-ops while healthy.** The command probes the local orchestrator health
  endpoint. If the orchestrator is up and healthy, the command prints a notice and
  exits without doing anything — the running orchestrator already reaps its own
  orphans. Pass `--force` to reap anyway.

Useful flags:

- `--force` — skip the health gate and reap even if the orchestrator reports
  healthy.
- `--config <path>` — point at a non-default orchestrator config location (also
  honoured via the `KICI_CONFIG` environment variable).
- `--json` — emit machine-readable counts, for scripting and host timers.

## Automatic recovery

Two mechanisms recover a full data disk without operator intervention:

- **Startup disk-space guard.** Before opening its log and database handles, the
  orchestrator checks free space on the chroot volume. If it is below the
  threshold, it reaps Firecracker orphans inline and continues startup only if
  enough space was freed. If the reap cannot free enough, the orchestrator logs a
  single actionable line naming `kici-admin scaler reap-orphans` instead of
  crash-looping opaquely on a buffered write.
- **Host safety timer (remote peers).** Remote Firecracker peers run a host-level
  timer that invokes `kici-admin scaler reap-orphans` on a cadence. Because the
  command no-ops while the orchestrator is healthy and reaps only when the node is
  wedged, the timer is a safe periodic backstop that self-heals a full disk even
  if the startup guard alone cannot free enough.

## See also

- [Firecracker auto-scaler](./auto-scaler/firecracker.md) — Firecracker scaler
  configuration and operation.
- [Firecracker host setup](./firecracker-host-setup.md) — host networking and
  jailer prerequisites.
