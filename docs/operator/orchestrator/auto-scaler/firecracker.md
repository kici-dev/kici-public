---
title: 'Auto-scaler: Firecracker backend'
description: Firecracker microVM scaler backend — VM networking, jailer fields, rootfs, and the MMDS credential model
---

The Firecracker backend provisions agents as ephemeral KVM-backed microVMs. Each job runs in a dedicated VM with hardware-level isolation, sub-125 ms boot times, and automatic cleanup — the strongest isolation model KiCI supports. For fields shared across all backends, see [Common configuration](./common-config.md). For host setup, see the [Firecracker setup guide](../firecracker-setup.md).

## When to choose Firecracker

- **Security isolation:** Hardware-level isolation via KVM. No shared kernel with the host.
- **Untrusted workloads:** Safe for running CI jobs from public repositories or untrusted contributors.
- **Multi-tenancy:** Strong isolation between jobs from different tenants.
- **Compliance:** Meets requirements for workload isolation in regulated environments.

For how Firecracker compares to the container and bare-metal backends for confining customer workflow code, see [Agent execution security](../../security/agent-security.md).

## Network configuration

The top-level `firecracker:` key defines VM networking, shared across all Firecracker scalers:

```yaml
firecracker:
  cidr: '10.0.0.0/24' # CIDR range for VM IP allocation. Default: '10.0.0.0/24'.
  bridgeName: 'kici-br0' # Host bridge interface name. Default: 'kici-br0'.
  gateway: '10.0.0.1' # Gateway IP (assigned to the bridge). Default: '10.0.0.1'.
  netmask: '255.255.255.0' # Subnet mask for guest networking. Default: '255.255.255.0'.
  table: 'kici' # nftables table name for this host bridge (disjoint per bridge). Default: 'kici'.
```

## Firecracker-specific fields

**Scaler-level fields:**

- `firecrackerPath` — Path to the Firecracker binary. Required.
- `jailerPath` — Path to the jailer binary. Required.
- `kernelPath` — Default kernel path. Required.
- `chrootBaseDir` — Jailer chroot base directory. Optional; default `/srv/jailer`.
- `uid` / `gid` — Jailer UID / GID. Required.
- `vcpuCount` — Default vCPU count for VMs. Optional; default `2`.
- `memSizeMib` — Default memory in MiB for VMs. Optional; default `512`.

**Label-set-level fields:**

- `rootfsPath` — Path to a pre-built ext4 rootfs image. Required on every Firecracker label set.
- `kernelPath` — Override the scaler-level kernel path for this label set. Optional.
- `vcpuCount` / `memSizeMib` — Override the scaler-level VM CPU / memory for this label set. Optional.
- `overlayDriveSizeMib` — Copy-on-write overlay drive size in MiB. Optional; default `2048`.

## Configuration

```yaml
version: 1
globalMaxAgents: 50

firecracker:
  cidr: '10.0.0.0/24'
  bridgeName: kici-br0
  gateway: '10.0.0.1'
  netmask: '255.255.255.0'

scalers:
  - name: fc-linux
    type: firecracker
    maxAgents: 20
    firecrackerPath: /usr/local/bin/firecracker
    jailerPath: /usr/local/bin/jailer
    kernelPath: /var/lib/kici/vmlinux
    chrootBaseDir: /srv/jailer # Optional, default: /srv/jailer
    uid: 10000
    gid: 10000
    vcpuCount: 2
    memSizeMib: 512
    orchestratorUrl: 'ws://10.0.0.1:8080/ws'
    labelSets:
      - labels: [linux, vm]
        rootfsPath: /var/lib/kici/rootfs-alpine.ext4
```

Key differences from container/bare-metal:

- The `firecracker` top-level key defines global network configuration (CIDR pool, bridge name).
- Scaler-level fields include `firecrackerPath`, `jailerPath`, `kernelPath`, `chrootBaseDir`, `uid`, `gid`.
- Each label set requires a `rootfsPath` pointing to a pre-built ext4 image.
- `orchestratorUrl` should point to the bridge gateway IP (VMs cannot reach `localhost`).

## DB migration

The Firecracker backend requires the `ip_allocations` PostgreSQL table for DB-backed IP allocation. This is created by migration `001_initial` and runs automatically on orchestrator startup.

## MMDS credential model

Firecracker VMs use a hybrid credential model to prevent customer workflow code from reading orchestrator credentials:

1. **Boot:** The orchestrator URL, agent ID, labels, scaler-managed flag, gateway IP, and optionally an auth token and backpressure mode are injected via MMDS metadata at VM startup
2. **Registration:** The agent connects via WebSocket and sends `agent.register`
3. **Config delivery:** The orchestrator replies with `register.ack` containing the agent's confirmed config (labels, max concurrent jobs, scaler-managed flag)
4. **Agent-side blocking:** After receiving `register.ack`, the agent blocks MMDS access via `iptables -A OUTPUT -d 169.254.169.254 -j DROP`
5. **Agent acknowledgment:** The agent sends `config.ack` to confirm it received and applied the config
6. **Host-side clearing:** The orchestrator clears MMDS data via the Firecracker API after receiving `config.ack`

This two-sided approach (agent blocks + orchestrator clears) ensures MMDS data is inaccessible to customer code even if one side fails. The MMDS contains only agent bootstrap data (orchestrator URL, agent ID, labels including auto-injected `kici:agent:*`, `kici:scaler:*`, and `kici:role:*` labels, scaler-managed flag, gateway IP, optionally an ephemeral agent token, optionally a backpressure mode, and optionally `KICI_AGENT_ENV_*`-forwarded env vars under `meta-data/kici-env/`) -- no long-lived API keys or secrets.

## Helper scripts

KiCI provides host-setup tooling — `kici-admin firecracker` for networking, plus helper scripts in `scripts/firecracker/`:

| Tool                               | Purpose                                                              |
| ---------------------------------- | -------------------------------------------------------------------- |
| `validate.sh`                      | Check host prerequisites (KVM, binaries, network)                    |
| `kici-admin firecracker provision` | Create bridge interface + NAT rules; `--persist` for reboot survival |
| `jailer-setup.sh`                  | Prepare jailer directory structure and cgroups                       |
| `rootfs-builder.sh`                | Convert Docker images to ext4 rootfs                                 |

For the complete setup guide, see [Firecracker setup guide](../firecracker-setup.md).
