---
title: 'Auto-scaler: Firecracker backend'
description: Firecracker microVM scaler backend — VM networking, jailer fields, rootfs, and the MMDS credential model
---

The Firecracker backend provisions agents as ephemeral KVM-backed microVMs. Each job runs in a dedicated VM with hardware-level isolation, sub-125 ms boot times, and automatic cleanup — the strongest isolation model KiCI supports. For fields shared across all backends, see [Common configuration](./common-config.md). For host setup, see the [Firecracker host setup](../firecracker/host-setup.md).

## When to choose Firecracker

- **Security isolation:** Hardware-level isolation via KVM. No shared kernel with the host.
- **Untrusted workloads:** Safe for running CI jobs from public repositories or untrusted contributors.
- **Compliance:** Meets requirements for workload isolation in regulated environments.

### What isolates one job from another

Three mechanisms, each covering a boundary the others do not:

- **The KVM boundary.** Each job runs in its own microVM with its own kernel. A
  job cannot read another job's memory or filesystem.
- **Bridge port isolation.** Every VM's TAP device is enslaved to the bridge
  with `isolated on`, so a VM can reach the gateway — and through it, the
  internet — but cannot reach another VM on the same bridge. Without it, VM
  traffic is switched at layer 2 and no packet filter ever sees it. The
  orchestrator refuses to start if the host kernel rejects the flag.
- **The nftables chain.** Per-VM rules matching the VM's own address deny
  RFC1918 ranges and the cloud-metadata address, and apply the label set's
  [`networkPolicy`](./common-config.md). They sit ahead of the host baseline,
  which the chain reaches through a `jump` as its last rule — so a per-VM
  `denyAll` or allowlist decides the packet before the baseline can.

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
  autoProvisionHost: true # Verify + provision this host bridge on startup (self-heal). Default: true.
```

With `autoProvisionHost` at its default (`true`), the orchestrator verifies and, if needed, provisions this host bridge when it starts — a fresh host needs no manual `kici-admin firecracker provision` step. Set it `false` to keep explicit operator control and provision the host network yourself. See [Firecracker host setup](../firecracker/host-setup.md#automatic-host-provisioning-on-startup) for the full behavior and the manual/`--persist` opt-out flow.

Give each bridge on a host its own `table`, for example when two orchestrators run Firecracker scalers on one host. Provisioning replaces the NAT and baseline rules in its table, so a second bridge in the same table removes the NAT of the first, and the VMs on the first bridge lose internet access. `kici-admin firecracker verify` and `kici-admin diagnose` report the missing NAT. Provisioning the first bridge again only moves the problem to the second bridge: the fix is a separate `table` for each bridge.

## Firecracker-specific fields

**Scaler-level fields:**

- `firecrackerPath` — Path to the Firecracker binary. Required. Its file name must be `firecracker`: the jailer names each VM's chroot and PID file after the binary, and the backend looks for them under `<chrootBaseDir>/firecracker/`. To keep several versions, put each in its own directory (for example `/opt/firecracker/v1.13.1/firecracker`).
- `jailerPath` — Path to the jailer binary. Required.
- `kernelPath` — Default kernel path. Required.
- `chrootBaseDir` — Jailer chroot base directory. Optional; default `/srv/jailer`.
- `uid` / `gid` — Jailer UID / GID. Required.
- `vcpuCount` — Default vCPU count for VMs. Optional; default `2`.
- `memSizeMib` — Default memory in MiB for VMs. Optional; default `512`.
- `extraHosts` — Extra `host:address` mappings that each VM adds to its `/etc/hosts`, for example `registry.local:host-gateway` or `cache.example.internal:10.1.2.3`. The address is an IPv4 or IPv6 address, or `host-gateway`, which stands for the bridge `gateway`: the address a VM reaches its host at. Optional; a VM gets no mapping by default.
  - Write each entry as `host:address`. The container runtime also accepts `host=address` and a bracketed IPv6 address, but a Firecracker scaler does not. An entry that is not a hostname and an address stops the orchestrator at startup.
  - A mapping names a host; it does not open a path to it. The per-VM chain blocks private (RFC 1918) addresses, the gateway included, unless the label set's [`networkPolicy`](./common-config.md#network-policy) allows them.
  - The VM `/init` applies the mappings. A rootfs built before a KiCI release that supports this field ignores them: refresh it with `build-agent-rootfs.sh --agent-only <the rootfsPath image>` from a checkout of the current release (see [Firecracker rootfs](../firecracker/rootfs.md#upgrading)).
- `requireSudo` — Wrap the privileged commands the backend runs (`ip`, `chown`, `chmod`, and `nft` for per-VM network isolation) with `sudo -n`, and stop a VM through `sudo -n -u '#<uid>' kill` as the jailer user when `kill(2)` refuses the signal. Optional; default `false`. Set it `true` when the orchestrator runs as a non-root user (for example a user-mode systemd unit) and the operator has a NOPASSWD sudoers entry for those binaries. Leave it unset when the orchestrator is root or already holds the required capabilities — `-n` fails fast rather than prompting, so an unnecessary `true` turns a working setup into a spawn failure.

**Label-set-level fields:**

- `rootfsPath` — Path to a pre-built ext4 rootfs image. Required on every Firecracker label set.
- `kernelPath` — Override the scaler-level kernel path for this label set. Optional.
- `vcpuCount` / `memSizeMib` — Override the scaler-level VM CPU / memory for this label set. Optional.
- `overlayDriveSizeMib` — Copy-on-write overlay drive size in MiB. Optional; default `2048`. The orchestrator keeps one pre-formatted template for each size on the host (see [Overlay drive templates](../firecracker/host-setup.md#overlay-drive-templates)).

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
        rootfsPath: /var/lib/kici/agent-rootfs.ext4
```

Key differences from container/bare-metal:

- The `firecracker` top-level key defines global network configuration (CIDR pool, bridge name).
- Scaler-level fields include `firecrackerPath`, `jailerPath`, `kernelPath`, `chrootBaseDir`, `uid`, `gid`.
- Each label set requires a `rootfsPath` pointing to a pre-built ext4 image.
- `orchestratorUrl` should point to the bridge gateway IP (VMs cannot reach `localhost`). It resolves in priority order: the scaler-level `orchestratorUrl` field, then the `KICI_ORCHESTRATOR_URL` environment variable, then the default `ws://127.0.0.1:<orchestrator port>/ws` (the orchestrator's own `KICI_PORT`, `4000` unless you changed it).

### Sizing memory

The `memSizeMib` default of 512 boots the agent. It does not run a job. A job
installs its `.kici/` dependencies inside the VM, and that install is the peak.
At 1024 MiB the install fails after several minutes with out-of-memory kills.
The failure looks like a hang, not an error. Give a VM that runs jobs **2048
MiB or more**. Raise it further for a workflow with a large dependency tree.

Set it per label set when only some of your jobs are heavy, so a small VM still
serves the light ones.

## Launch failures

A VM that stops before its agent connects to the orchestrator is a failed
launch. The scaler reports it in `kici-admin diagnose` and on the waiting job,
frees the VM's slot, and defers the scaler with the same backoff a bare-metal
scaler uses. See [Launch failures](./bare-metal.md#launch-failures).

## DB migration

The Firecracker backend requires the `ip_allocations` PostgreSQL table for DB-backed IP allocation. This is created by migration `001_initial` and runs automatically on orchestrator startup.

## MMDS credential model

Firecracker VMs use a hybrid credential model to prevent customer workflow code from reading orchestrator credentials:

1. **Boot:** The orchestrator URL, agent ID, labels, scaler-managed flag, and optionally an auth token, a backpressure mode and the scaler's `extraHosts` mappings are injected via MMDS metadata at VM startup
2. **Registration:** The agent connects via WebSocket and sends `agent.register`
3. **Config delivery:** The orchestrator replies with `register.ack` containing the agent's confirmed config (labels, max concurrent jobs, scaler-managed flag)
4. **Agent-side blocking:** After receiving `register.ack`, the agent blocks MMDS access via `iptables -A OUTPUT -d 169.254.169.254 -j DROP`
5. **Agent acknowledgment:** The agent sends `config.ack` to confirm it received and applied the config
6. **Host-side clearing:** The orchestrator clears MMDS data via the Firecracker API after receiving `config.ack`

This two-sided approach (agent blocks + orchestrator clears) ensures MMDS data is inaccessible to customer code even if one side fails. The MMDS contains only agent bootstrap data, and no long-lived API keys or secrets. It holds the orchestrator URL, the agent ID, the labels (including the auto-injected `kici:agent:*`, `kici:scaler:*` and `kici:role:*` labels) and the scaler-managed flag. It can also hold an ephemeral agent token, the scaler's `extraHosts` mappings, a backpressure mode, and `KICI_AGENT_ENV_*`-forwarded env vars under `meta-data/kici-env/`.

## Helper scripts

KiCI provides host-setup tooling: `kici-admin firecracker` for networking, plus helper scripts in `scripts/firecracker/` of the source repository, [github.com/kici-dev/kici-public](https://github.com/kici-dev/kici-public), from KiCI 0.12.0 on. Run the scripts from a checkout of the release tag that matches your orchestrator:

| Tool                               | Purpose                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `validate.sh`                      | Check host prerequisites (KVM, binaries, network)                            |
| `install-firecracker.sh`           | Install the pinned Firecracker and jailer binaries, with jailer capabilities |
| `kici-admin firecracker provision` | Create bridge interface + NAT rules; `--persist` for reboot survival         |
| `jailer-setup.sh`                  | Prepare jailer directory structure and cgroups                               |
| `build-agent-rootfs.sh`            | Build the agent rootfs image; needs the workspace installed and built        |

For the complete setup guide, see [Firecracker host setup](../firecracker/host-setup.md).
