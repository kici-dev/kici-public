---
title: Firecracker setup guide
description: Set up Firecracker microVMs for hardware-isolated ephemeral CI agents
---

The Firecracker backend provisions CI agents as ephemeral microVMs using [Firecracker](https://github.com/firecracker-microvm/firecracker), the VMM built by AWS for Lambda and Fargate. Each job runs in a dedicated VM with hardware-level isolation (KVM), sub-second boot times, and automatic cleanup. This is the strongest isolation model KiCI supports -- suitable for untrusted workloads, multi-tenant environments, and security-sensitive CI pipelines.

## Overview

### What Firecracker provides

- **Hardware-level isolation:** Each VM runs in its own KVM-backed virtual machine. No shared kernel, no container escape vectors.
- **Fast boot:** VMs boot in under 125ms (Firecracker specification). With rootfs copy overhead, typical agent startup is 2--5 seconds.
- **Ephemeral agents:** One VM per job. No state leaks between jobs. No container cleanup concerns.
- **Resource limits:** Per-VM vCPU and memory limits enforced at the hypervisor level.
- **Jailer security:** The jailer binary provides chroot, cgroups, seccomp filters, and privilege dropping for defense in depth.

### When to use Firecracker

| Use Case                                            | Recommended Backend |
| --------------------------------------------------- | ------------------- |
| Trusted internal workloads, fast startup            | Container           |
| GPU/specialized hardware, no container support      | Bare-metal          |
| **Untrusted code, multi-tenant, security-critical** | **Firecracker**     |
| Public repository CI                                | **Firecracker**     |
| Compliance requirements (strong isolation)          | **Firecracker**     |

Firecracker adds operational complexity compared to Docker (kernel management, rootfs images, network setup). Choose it when the isolation guarantees justify that overhead.

## Prerequisites

### Hardware

- **KVM-capable host:** Intel VT-x or AMD-V hardware virtualization must be enabled in BIOS/UEFI.
- `/dev/kvm` must be accessible by the orchestrator process (or by the jailer uid).
- Both **amd64** (x86_64) and **arm64** (aarch64) architectures are supported.

### Software

| Binary                  | Purpose                                       | Source                                                                              |
| ----------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------- |
| `firecracker`           | MicroVM hypervisor                            | [Firecracker releases](https://github.com/firecracker-microvm/firecracker/releases) |
| `jailer`                | Security isolation (chroot, cgroups, seccomp) | Included in Firecracker release archive                                             |
| `ip` (iproute2)         | TAP device and bridge management              | System package (`iproute2`)                                                         |
| `nft` (nftables)        | NAT masquerade and network isolation rules    | System package (`nftables`)                                                         |
| `mkfs.ext4` (e2fsprogs) | Per-VM overlay drive creation                 | System package (`e2fsprogs`)                                                        |

### Architecture notes

Firecracker requires architecture-specific kernel images:

| Architecture        | Kernel Format    | Filename Convention |
| ------------------- | ---------------- | ------------------- |
| **amd64** (x86_64)  | Uncompressed ELF | `vmlinux`           |
| **arm64** (aarch64) | PE format        | `Image`             |

Using the wrong kernel format for your architecture will cause silent boot failures. Firecracker publishes pre-built kernels for both architectures on their [releases page](https://github.com/firecracker-microvm/firecracker/releases).

### Running the validation script

KiCI includes a host validation script that checks all prerequisites:

```bash
bash scripts/firecracker/validate.sh
```

The script checks:

- `/dev/kvm` existence and permissions
- Firecracker and jailer binary availability
- Network tools (iproute2, nftables)
- IPv4 forwarding
- Bridge interface (optional, with `--bridge-name`)

Options:

```bash
# Custom binary paths
bash scripts/firecracker/validate.sh \
  --firecracker-path /usr/local/bin/firecracker \
  --jailer-path /usr/local/bin/jailer

# Include bridge check
bash scripts/firecracker/validate.sh --bridge-name kici-br0
```

## Host setup

### 1. Install Firecracker binaries

Download the appropriate release for your architecture from the [Firecracker releases page](https://github.com/firecracker-microvm/firecracker/releases):

```bash
# Example for amd64
ARCH=$(uname -m)  # x86_64 or aarch64
RELEASE="v1.10.1"  # Check for latest release

curl -L "https://github.com/firecracker-microvm/firecracker/releases/download/${RELEASE}/firecracker-${RELEASE}-${ARCH}.tgz" \
  | tar xz

sudo mv release-${RELEASE}-${ARCH}/firecracker-${RELEASE}-${ARCH} /usr/local/bin/firecracker
sudo mv release-${RELEASE}-${ARCH}/jailer-${RELEASE}-${ARCH} /usr/local/bin/jailer
sudo chmod +x /usr/local/bin/firecracker /usr/local/bin/jailer

# Verify
firecracker --version
```

### 2. Download a kernel

Firecracker publishes pre-built kernel binaries for both architectures. Download from the [Firecracker releases page](https://github.com/firecracker-microvm/firecracker/releases) or build your own following the [Firecracker kernel setup guide](https://github.com/firecracker-microvm/firecracker/blob/main/docs/rootfs-and-kernel-setup.md).

```bash
# Example: download to /var/lib/kici/
sudo mkdir -p /var/lib/kici

# amd64: use vmlinux (uncompressed ELF)
sudo cp vmlinux-5.10-x86_64.bin /var/lib/kici/vmlinux

# arm64: use Image (PE format)
# sudo cp vmlinux-5.10-aarch64.bin /var/lib/kici/Image
```

### 3. Network setup

The Firecracker backend uses a bridge+NAT networking model. A host bridge interface connects all VM TAP devices, and nftables rules provide outbound NAT.

Provision the bridge with `kici-admin firecracker provision`:

```bash
sudo kici-admin firecracker provision --bridge kici-br0 --cidr 10.0.0.1/24 --persist
```

This creates:

- A bridge interface (`kici-br0`) with the gateway IP you pass as `--cidr` (`10.0.0.1/24`)
- nftables NAT masquerade rules for outbound traffic, in a dedicated table (`kici` by default; override with `--table`)
- Network isolation rules, source-scoped to the bridge subnet: RFC1918 blocking (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) and cloud metadata blocking (169.254.0.0/16) with a gateway exception
- IP forwarding enabled
- TCP MSS clamping (prevents TLS handshake hangs through NAT)

Options:

```bash
# Custom bridge name, gateway CIDR, nft table, and egress interface
sudo kici-admin firecracker provision \
  --bridge kici-br0 \
  --cidr 172.16.0.1/24 \
  --table kici \
  --host-iface eth0

# Teardown (remove bridge and NAT rules)
sudo kici-admin firecracker teardown --bridge kici-br0 --table kici
```

The egress interface is auto-detected from the default route when `--host-iface` is omitted.

#### Survive reboots

The bridge + nftables rules are non-persistent kernel state, so they vanish on a host reboot. The `--persist` flag installs a per-bridge systemd oneshot unit (`kici-fc-net-<bridge>.service`) that recreates the bridge on boot from a dependency-free boot script — the egress interface is re-detected at boot, so a NIC rename does not break recovery. Without `--persist` you must recreate the bridge after every reboot (or wire up your own boot-time provisioning).

#### Verify your networking

Check a bridge is up with its gateway address and nft table:

```bash
sudo kici-admin firecracker verify --bridge kici-br0 --cidr 10.0.0.1/24 --table kici
```

`verify` exits non-zero with a precise message on any miss (bridge down, address not assigned, nft table absent) and `0` when healthy. `kici-admin diagnose` also reports a `firecracker:<bridge>` health row for every bridge the orchestrator's scaler config references, so a broken bridge surfaces in routine diagnostics.

### 4. Jailer setup

The jailer provides security isolation for Firecracker processes. Run the setup script to prepare the directory structure, permissions, and cgroups:

```bash
sudo bash scripts/firecracker/jailer-setup.sh --uid 10000 --gid 10000
```

This creates:

- The jailer base directory (`/srv/jailer/`) with correct ownership
- Verifies `/dev/kvm` and `/dev/net/tun` device nodes
- Configures cgroup directories (v1 and v2 supported)
- Recommends `nofile` and `nproc` limits for the jailer user

Options:

```bash
# Custom base directory
sudo bash scripts/firecracker/jailer-setup.sh \
  --uid 10000 --gid 10000 \
  --base-dir /opt/kici/jailer
```

**UID/GID requirements:** The jailer drops privileges from root to the specified uid/gid. Use a dedicated non-root user (e.g., uid 10000). The jailer binary itself must be invoked as root (it drops privileges internally).

## Building rootfs images

A rootfs (root filesystem) is an ext4 disk image containing the operating system and the KiCI agent binary. Each VM boots from a copy of this image.

### Using the rootfs builder

The rootfs builder converts a Docker image to an ext4 image suitable for Firecracker:

```bash
sudo bash scripts/firecracker/rootfs-builder.sh \
  --image alpine:3.19 \
  --output /var/lib/kici/rootfs-alpine.ext4
```

Options:

```bash
# Custom size, with agent binary and init script
sudo bash scripts/firecracker/rootfs-builder.sh \
  --image alpine:3.19 \
  --output /var/lib/kici/rootfs-alpine.ext4 \
  --size 2048 \
  --agent-binary ./kici-agent
```

### Starting from Docker images (recommended)

The recommended workflow for building rootfs images:

1. **Create a Dockerfile** based on a minimal image (Alpine recommended):

```dockerfile
FROM alpine:3.19

# Install runtime dependencies
RUN apk add --no-cache curl ca-certificates git

# Copy the KiCI agent binary
COPY kici-agent /usr/local/bin/kici-agent
RUN chmod +x /usr/local/bin/kici-agent
```

2. **Build the Docker image** for the target architecture:

```bash
# Build for current architecture
docker build -t kici-agent-rootfs:latest .

# Or build for a specific architecture
docker build --platform linux/arm64 -t kici-agent-rootfs:arm64 .
```

3. **Convert to rootfs** using the builder script:

```bash
sudo bash scripts/firecracker/rootfs-builder.sh \
  --image kici-agent-rootfs:latest \
  --output /var/lib/kici/rootfs-alpine.ext4 \
  --size 1024
```

### Including the KiCI agent binary

The rootfs must contain the KiCI agent binary at `/usr/local/bin/kici-agent`. You have two options:

- **Via Dockerfile** (recommended): Include `COPY kici-agent /usr/local/bin/kici-agent` in your Dockerfile before building the rootfs.
- **Via `--agent-binary` flag**: Pass the binary path to the rootfs builder, which copies it into the image during build.

### MMDS-based agent bootstrap

The rootfs builder automatically creates an init script at `/usr/local/bin/kici-init.sh`. This script:

1. Waits for the Firecracker MMDS (Metadata Service) to become available
2. Acquires an MMDS v2 session token
3. Reads agent configuration from MMDS metadata:
   - `kici-orchestrator-url` -- Orchestrator WebSocket URL
   - `kici-agent-id` -- Pre-generated agent ID
   - `kici-labels` -- Comma-separated label set
   - `kici-scaler-managed` -- Flag indicating scaler-managed agent
   - `kici-gateway-ip` -- Bridge gateway IP for network configuration
   - `kici-agent-token` -- (optional) Ephemeral auth token
   - `kici-backpressure-mode` -- (optional) Log backpressure mode (`pause` or `drop`)
4. Exports environment variables and starts the KiCI agent via `exec`

The orchestrator injects this metadata via the Firecracker MMDS API after VM boot. The guest init system must call `/usr/local/bin/kici-init.sh` during startup.

**For Alpine (OpenRC):** Create an OpenRC service that calls the init script:

```bash
#!/sbin/openrc-run
command="/usr/local/bin/kici-init.sh"
command_background="yes"
pidfile="/run/kici-agent.pid"
```

**For Ubuntu/Debian (systemd):** Create a systemd unit:

```ini
[Unit]
Description=KiCI Agent
After=network.target

[Service]
ExecStart=/usr/local/bin/kici-init.sh
Restart=no

[Install]
WantedBy=multi-user.target
```

### Architecture considerations

- **amd64 rootfs images** can only run on amd64 hosts (and vice versa for arm64).
- Ensure the Docker image you start from matches the target architecture: `docker build --platform linux/amd64` or `docker build --platform linux/arm64`.
- The rootfs builder detects the host architecture and logs it. Cross-architecture building requires QEMU user emulation (`docker buildx`).

### Keeping images minimal

Rootfs image size directly affects VM spawn time (the orchestrator copies the full image per VM). Recommendations:

- **Base image:** Alpine Linux (5 MB base vs 70+ MB for Ubuntu)
- **Install only what you need:** `curl`, `ca-certificates`, `git`, and any build tools your CI jobs require.
- **Use `--size` wisely:** Size is the virtual size; sparse files only allocate used blocks. But smaller virtual sizes mean faster `mkfs.ext4` and less disk space.
- **Consider tmpfs:** Copy rootfs to `/tmp` (tmpfs) for faster I/O during VM boot.
- **Target:** Aim for rootfs images under 500 MB for sub-5-second spawn times.

## Configuration

Add a Firecracker scaler to your `scalers.yaml`:

```yaml
version: 1
globalMaxAgents: 50

# Global Firecracker network configuration (shared across all Firecracker scalers)
firecracker:
  cidr: '10.0.0.0/24'
  bridgeName: kici-br0
  gateway: '10.0.0.1'
  netmask: '255.255.255.0'

scalers:
  - name: fc-linux
    type: firecracker
    maxAgents: 20

    # Required: paths to Firecracker and jailer binaries
    firecrackerPath: /usr/local/bin/firecracker
    jailerPath: /usr/local/bin/jailer

    # Required: default kernel path (overridable per label set)
    kernelPath: /var/lib/kici/vmlinux

    # Required: jailer uid/gid
    uid: 10000
    gid: 10000

    # Optional: jailer chroot base directory (default: /srv/jailer)
    chrootBaseDir: /srv/jailer

    # Optional: default VM resources (overridable per label set)
    vcpuCount: 2
    memSizeMib: 512

    # Optional: orchestrator URL for VMs to connect back (important for bridge networking)
    orchestratorUrl: 'ws://10.0.0.1:8080/ws'

    labelSets:
      - labels: [linux, vm]
        rootfsPath: /var/lib/kici/rootfs-alpine.ext4

      - labels: [linux, vm, gpu]
        rootfsPath: /var/lib/kici/rootfs-gpu.ext4
        vcpuCount: 4
        memSizeMib: 2048
```

### Configuration reference

**Scaler-level fields (Firecracker-specific):**

| Field             | Required | Default       | Description                                  |
| ----------------- | -------- | ------------- | -------------------------------------------- |
| `firecrackerPath` | Yes      | --            | Path to the `firecracker` binary             |
| `jailerPath`      | Yes      | --            | Path to the `jailer` binary                  |
| `kernelPath`      | Yes      | --            | Default kernel image path for all label sets |
| `uid`             | Yes      | --            | Jailer user ID (must be non-root)            |
| `gid`             | Yes      | --            | Jailer group ID (must be non-root)           |
| `chrootBaseDir`   | No       | `/srv/jailer` | Jailer chroot base directory                 |
| `vcpuCount`       | No       | `2`           | Default vCPU count per VM                    |
| `memSizeMib`      | No       | `512`         | Default memory in MiB per VM                 |
| `orchestratorUrl` | No       | not set       | URL for VMs to connect to the orchestrator   |

**Label-set fields (Firecracker-specific overrides):**

| Field                 | Required | Default      | Description                                  |
| --------------------- | -------- | ------------ | -------------------------------------------- |
| `rootfsPath`          | Yes      | --           | Path to ext4 rootfs image for this label set |
| `kernelPath`          | No       | scaler-level | Override kernel path for this label set      |
| `vcpuCount`           | No       | scaler-level | Override vCPU count for this label set       |
| `memSizeMib`          | No       | scaler-level | Override memory for this label set           |
| `overlayDriveSizeMib` | No       | `2048`       | Overlay drive size in MiB (Firecracker CoW)  |

**Global Firecracker network config (top-level `firecracker` key):**

| Field        | Required | Default         | Description                       |
| ------------ | -------- | --------------- | --------------------------------- |
| `cidr`       | No       | `10.0.0.0/24`   | IP address pool for VM allocation |
| `bridgeName` | No       | `kici-br0`      | Host bridge interface name        |
| `gateway`    | No       | `10.0.0.1`      | Gateway IP (assigned to bridge)   |
| `netmask`    | No       | `255.255.255.0` | Subnet mask for guest networking  |

### Orchestrator URL for bridge networking

VMs on a bridge network cannot reach `localhost` on the host. Set `orchestratorUrl` to the bridge gateway IP so VMs can connect to the orchestrator:

```yaml
orchestratorUrl: 'ws://10.0.0.1:8080/ws'
```

The URL resolution priority is:

1. Scaler-level `orchestratorUrl` (in YAML config)
2. `KICI_ORCHESTRATOR_URL` environment variable
3. Default: `ws://localhost:8080/ws`

### DB migration for IP allocations

The Firecracker backend requires the `ip_allocations` PostgreSQL table. This is created by migration `001_initial`. Run migrations before using the Firecracker backend:

```bash
# Migrations run automatically on orchestrator startup
# Or run manually via the kici-admin CLI:
kici-admin db migrate
```

## Dual-architecture setup

For environments with both amd64 and arm64 hosts, use separate label sets with architecture-specific kernel and rootfs paths:

```yaml
version: 1
globalMaxAgents: 40

firecracker:
  cidr: '10.0.0.0/24'
  bridgeName: kici-br0
  gateway: '10.0.0.1'
  netmask: '255.255.255.0'

scalers:
  - name: fc-amd64
    type: firecracker
    maxAgents: 20
    firecrackerPath: /usr/local/bin/firecracker
    jailerPath: /usr/local/bin/jailer
    kernelPath: /var/lib/kici/vmlinux # amd64: uncompressed ELF
    uid: 10000
    gid: 10000
    vcpuCount: 2
    memSizeMib: 1024
    orchestratorUrl: 'ws://10.0.0.1:8080/ws'
    labelSets:
      - labels: [linux, vm, amd64]
        rootfsPath: /var/lib/kici/rootfs-amd64.ext4

  - name: fc-arm64
    type: firecracker
    maxAgents: 20
    firecrackerPath: /usr/local/bin/firecracker
    jailerPath: /usr/local/bin/jailer
    kernelPath: /var/lib/kici/Image # arm64: PE format
    uid: 10000
    gid: 10000
    vcpuCount: 2
    memSizeMib: 1024
    orchestratorUrl: 'ws://10.0.0.1:8080/ws'
    labelSets:
      - labels: [linux, vm, arm64]
        rootfsPath: /var/lib/kici/rootfs-arm64.ext4
```

**Note:** On arm64, the `SendCtrlAltDel` graceful shutdown is not available (it requires the i8042 keyboard controller, which is x86-only). The orchestrator falls back to process kill for arm64 VMs.

## IP allocation

### How the CIDR pool works

The orchestrator allocates IP addresses from the configured CIDR range (default: `10.0.0.0/24`). The pool is global across all Firecracker scalers on the orchestrator.

- **Gateway IP** (e.g., `10.0.0.1`) is reserved for the bridge interface.
- **Usable range:** First IP after the gateway through the last usable IP before broadcast.
  - For `10.0.0.0/24`: `10.0.0.2` through `10.0.0.254` (253 usable addresses).
- **Allocation:** On each VM spawn, the orchestrator finds the lowest available IP and inserts it into the `ip_allocations` table.
- **Release:** On VM destroy, the IP row is deleted (not soft-deleted).

### DB-backed allocation

IP allocations are stored in PostgreSQL (`ip_allocations` table):

| Column         | Type        | Description                               |
| -------------- | ----------- | ----------------------------------------- |
| `ip`           | TEXT (PK)   | Allocated IP address                      |
| `vm_id`        | TEXT        | Firecracker VM ID (= agent ID)            |
| `scaler_name`  | TEXT        | Which scaler backend owns this allocation |
| `tap_device`   | TEXT        | TAP device name on the host               |
| `mac_address`  | TEXT        | Guest MAC address                         |
| `allocated_at` | TIMESTAMPTZ | When the IP was allocated                 |

This design ensures:

- **Crash recovery:** Allocations survive orchestrator restarts.
- **HA visibility:** Multiple orchestrator instances can see each other's allocations.
- **No double allocation:** The IP is the primary key, preventing duplicates.

### What happens on restart

On orchestrator startup (and every 15 minutes thereafter -- see "Periodic orphan sweep" below), the Firecracker backend runs orphan cleanup:

1. **DB scan:** Queries all `ip_allocations` for this scaler. For each allocation, checks if the Firecracker process is still running (reads PID file from jailer directory). Dead VMs have their IP released, TAP device deleted, and chroot directory cleaned.
2. **Filesystem scan:** Scans the jailer directory for VM directories that have no corresponding DB record. Removes them.
3. **Network scan:** Scans host interfaces for TAP devices matching the `kici-XXXXXXXX` pattern with no DB allocation. Removes them. Skips `kici-br0`, `kici-br1`, `kici-m01` and any TAP currently tracked in the backend's in-memory agent map.

### Periodic orphan sweep

In addition to the startup sweep, the backend invokes `cleanupOrphans()` on a 15-minute timer while the orchestrator is running. This exists because long-lived orchestrators (weeks of uptime is normal) would otherwise accumulate leaked TAPs -- for example from a vitest worker that was SIGKILLed mid-destroy -- until the next restart. Each tick re-reads DB allocations before and after listing host interfaces, which closes the narrow race where a spawn's `ipAllocator.allocate()` lands between the two reads.

This complements -- but does not replace -- the external host-level sweep (`kici-leak-sweep.timer` in the devops repo), which skips TAP cleanup while the orchestrator is active and therefore only catches orphans that survive an orchestrator stop.

### NetworkManager interaction

If the host runs NetworkManager, it **must** be configured to leave `kici-*` interfaces unmanaged. NetworkManager otherwise auto-adopts every TAP/bridge as a `connection-assumed` profile and polls each one; under heavy TAP churn this has been observed to wedge the NetworkManager main thread in a 100%-CPU spinloop (incident on 2026-04-14).

`kici-admin firecracker provision` installs this rule automatically (in `/etc/NetworkManager/conf.d/90-kici-unmanaged.conf`) when NetworkManager is present on the host. To verify:

```bash
cat /etc/NetworkManager/conf.d/90-kici-unmanaged.conf
# Should contain: unmanaged-devices=interface-name:kici-*

nmcli -t -f DEVICE,TYPE,STATE dev | grep kici-
# Every kici-* device should show "unmanaged"
```

The conf file is **host-scoped**, not bridge-scoped: the `interface-name:kici-*` pattern protects every kici-\* interface on the host (TAPs and any number of `kici-brN` bridges that coexist for separate orchestrators). Because of that, `kici-admin firecracker teardown` deliberately leaves the file in place — only the per-bridge state (the bridge interface itself + its nftables table) is removed. Removing the conf file from a per-bridge teardown would let NetworkManager adopt the bridges that aren't being torn down and silently strip their gateway IP, breaking every other Firecracker coordinator on the host.

### MAC address generation

MAC addresses are generated deterministically from the allocated IP using the `06:00:AC` prefix (locally-administered unicast). The last three octets of the MAC are derived from the last three octets of the IP address (e.g., `10.0.1.42` produces `06:00:AC:00:01:2A`). This ensures consistent, collision-free MACs that are easy to debug (you can derive the IP from the MAC).

### TAP device naming

TAP devices are named `kici-XXXXXXXX` where `XXXXXXXX` is the last 8 characters of the VM ID. VM IDs have the format `scaler-firecracker-XXXXXXXX` where the unique random suffix is at the end, so using the last 8 characters ensures uniqueness. This stays within the Linux 15-character interface name limit (IFNAMSIZ) while providing easy identification for orphan cleanup.

## Security

### Jailer benefits

The Firecracker jailer provides multiple layers of isolation:

- **chroot:** The VM process sees only its own directory tree. No access to the host filesystem.
- **cgroups:** CPU and memory limits enforced by the kernel. VMs cannot consume host resources beyond their allocation.
- **seccomp:** System call filtering. Only the syscalls Firecracker needs are allowed; all others are blocked.
- **uid/gid:** The Firecracker process runs as an unprivileged user. Even if a VM escape occurs, the attacker has limited privileges.
- **New PID namespace:** The VM process is isolated in its own PID namespace.

### Production host hardening

For production deployments, follow the [Firecracker production host setup guide](https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md):

- Disable SMT (Simultaneous Multi-Threading / Hyper-Threading) to prevent side-channel attacks
- Use seccomp profiles shipped with Firecracker
- Limit `/dev/kvm` access to the jailer uid only
- Monitor mount point count (jailer performance degrades above 500 mount points)
- Use dedicated hosts for Firecracker VMs (no mixed workloads)

### Comparison with Docker isolation

| Property                    | Docker                     | Firecracker                      |
| --------------------------- | -------------------------- | -------------------------------- |
| Kernel                      | Shared with host           | Dedicated per VM                 |
| Escape difficulty           | Container escape possible  | Hardware-level isolation (KVM)   |
| Syscall filtering           | Optional seccomp           | Mandatory seccomp + KVM boundary |
| Resource enforcement        | cgroups (kernel)           | cgroups + hypervisor             |
| Filesystem isolation        | Overlay FS (shared layers) | Full rootfs copy (no sharing)    |
| Suitable for untrusted code | With restrictions          | Yes                              |

## Troubleshooting

### VM won't boot

**Symptom:** VM spawn times out or Firecracker process exits immediately.

**Common causes:**

- `/dev/kvm` not accessible. Check with: `ls -la /dev/kvm`
- Wrong kernel format for architecture. amd64 needs `vmlinux` (ELF), arm64 needs `Image` (PE).
- Kernel or rootfs paths incorrect in config. Paths must exist on the host.
- Jailer uid/gid does not have access to the chroot base directory.

**Debug steps:**

1. Run `bash scripts/firecracker/validate.sh` to check prerequisites.
2. Check orchestrator logs for Firecracker error output.
3. Verify file permissions on kernel and rootfs paths.

### Agent can't reach orchestrator

**Symptom:** VM boots but agent never connects. Jobs stay in `dispatching` state.

**Common causes:**

- Bridge interface not created. Run `ip link show kici-br0`.
- NAT rules missing. Run `nft list table kici`.
- IP forwarding disabled. Check `cat /proc/sys/net/ipv4/ip_forward`.
- `orchestratorUrl` not set or points to `localhost` (VMs can't reach host localhost via bridge).

**Debug steps:**

1. Verify bridge is up: `ip addr show kici-br0`
2. Verify NAT: `nft list ruleset | grep kici`
3. Check orchestrator URL in scaler config -- must be the bridge gateway IP (e.g., `ws://10.0.0.1:8080/ws`).

### IP pool exhausted

**Symptom:** VM spawn fails with "no available IPs" error.

**Common causes:**

- CIDR range too small for the number of concurrent VMs.
- Orphaned IP allocations from crashed VMs.

**Fix:**

1. Check current allocations: query `SELECT * FROM ip_allocations;`
2. Increase CIDR range in `scalers.yaml` (e.g., `/23` for 509 usable IPs).
3. Restart orchestrator to trigger orphan cleanup.
4. Manual cleanup: `DELETE FROM ip_allocations WHERE vm_id NOT IN (select active vm ids)`.

### Slow VM spawn

**Symptom:** VM spawn times are consistently above 5 seconds.

**Common causes:**

- Large rootfs images (500 MB+ copy per VM).
- Slow disk I/O on the host.
- Many mount points degrading jailer performance.

**Fix:**

1. Keep rootfs images minimal (Alpine-based, <500 MB).
2. Copy rootfs to tmpfs: use a tmpfs mount for `chrootBaseDir`.
3. Check mount point count: `wc -l /proc/mounts` (keep under 500).
4. Enable warm pools to pre-copy rootfs and hide latency from job dispatch.

### TAP devices accumulating

**Symptom:** `ip link show` reveals many stale `kici-*` TAP devices.

**Common causes:**

- Orchestrator crashed (SIGKILL) before cleaning up TAP devices.
- Bug in destroy pipeline (should not happen in normal operation).

**Fix:**

1. Restart orchestrator -- orphan cleanup runs on startup.
2. Manual cleanup:
   ```bash
   # List orphaned TAP devices
   ip link show | grep 'kici-'
   # Delete specific device
   sudo ip link del kici-a1b2c3d4
   # Delete all kici TAP devices
   ip link show | grep -oP 'kici-\w+' | xargs -I{} sudo ip link del {}
   ```

## See also

- [Auto-scaler configuration](auto-scaler.md) -- general auto-scaler concepts, Docker/bare-metal backends, label matching, warm pools, SIGHUP reload, monitoring
- [Configuration Reference](configuration.md) -- orchestrator environment variables including `KICI_SCALER_CONFIG_PATH`
- [Agent Configuration](../agent/configuration.md) -- environment variables for agents connecting to the orchestrator
- [Architecture Overview](../../architecture/overview.md) -- three-tier relay model and component responsibilities
