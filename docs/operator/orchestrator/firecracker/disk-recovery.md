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

The command loads the orchestrator's local config, reconstructs the scaler
backends without a running orchestrator or database, and frees leaked resources.
It is the supported recovery path — no manual `chown` / `rm` of chroot
directories is needed.

What it does:

- **Reaps only dead VMs.** A liveness pre-scan reads each chroot's
  `firecracker.pid` and protects any VM whose process is still alive. Chroots and
  TAP devices belonging to dead VMs are removed; live VMs are never touched.
- **Reclaims ownership first.** On rootless nodes the reaper reclaims ownership of
  each leaked chroot before deleting it, so disk owned by the jailer's subuid is
  actually freed.
- **Also sweeps container scalers, unconditionally.** Once the health gate has
  passed, every `container` scaler on the host is swept too, and that sweep
  removes **every** agent container it manages — there is no per-container
  liveness check, unlike the Firecracker pass. The health gate is what makes this
  safe: it only runs when the orchestrator is down.
- **No-ops while healthy.** The command probes the local orchestrator health
  endpoint. If the orchestrator is up and healthy, the command prints a notice and
  exits without doing anything — the running orchestrator already reaps its own
  orphans. Pass `--force` to reap anyway.

Useful flags:

- `--force` — skip the health gate and reap even if the orchestrator reports
  healthy. Use it only on a node you know is wedged: it bypasses the one check
  that protects the unconditional container sweep, so on a healthy node it kills
  running agent containers.
- `--config <path>` — point at a non-default orchestrator config location (also
  honoured via the `KICI_CONFIG` environment variable).
- `--json` — emit machine-readable counts, for scripting and host timers.

## Automatic recovery

**Startup disk-space guard.** Before opening its log and database handles, the
orchestrator checks free space on the chroot volume. If it is below the
threshold, it reaps Firecracker orphans inline and continues startup only if
enough space was freed. If the reap cannot free enough, the orchestrator logs a
single actionable line naming `kici-admin scaler reap-orphans` instead of
crash-looping opaquely on a buffered write.

This guard is the only recovery the orchestrator performs on its own, and it
only runs at startup. A node that fills its disk between restarts stays full
until something reaps it.

## Recommended: a host timer as a backstop

`kici-admin scaler reap-orphans` is built to be safe on a schedule, but nothing
schedules it for you — set up a host timer yourself on each Firecracker node,
especially a rootless edge peer you do not watch closely. Every 30 minutes is a
reasonable cadence.

Two properties make a periodic run safe:

- It probes the local orchestrator health endpoint first, so on a healthy node it
  prints a notice and exits 0 without touching anything.
- The Firecracker reap is liveness-driven, so even when it does run it only
  removes chroots and TAP devices of dead VMs.

Use `--json` so the timer's journal records what each run freed. Do **not** add
`--force` to a scheduled run: it skips the health gate, and the container sweep
behind that gate removes every agent container unconditionally.

## See also

- [Firecracker auto-scaler](../auto-scaler/firecracker.md) — Firecracker scaler
  configuration and operation.
- [Firecracker host setup](./host-setup.md) — host networking and
  jailer prerequisites.
