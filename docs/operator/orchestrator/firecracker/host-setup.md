---
title: Firecracker host setup
description: "Set up a host to run KiCI's Firecracker microVM scaler: packages, users, binaries, capabilities, kernel, networking, jailer, dual-arch, IP allocation, and troubleshooting."
---

The Firecracker backend provisions CI agents as ephemeral microVMs using [Firecracker](https://github.com/firecracker-microvm/firecracker), the VMM built by AWS for Lambda and Fargate. Each job runs in a dedicated VM with hardware-level isolation (KVM), sub-second boot times, and automatic cleanup — the strongest isolation model KiCI supports, suitable for untrusted workloads, multi-tenant environments, and security-sensitive CI pipelines. This guide covers host provisioning end to end: system packages, users, binary installation, capabilities, kernel, networking, jailer directories, IP allocation, and troubleshooting.

For the ext4 rootfs image the VMs boot from, see the [Firecracker rootfs build guide](./rootfs.md). For the `scalers.yaml` configuration reference, see the [Firecracker scaler backend](../auto-scaler/firecracker.md).

## Overview

The Firecracker scaler runs agent jobs inside microVMs for strong workload isolation. Each VM boots in ~150ms, runs the CI job, and is destroyed. The orchestrator manages VM lifecycle including:

- **TAP device creation** (`ip tuntap add`, `ip link set`) for VM networking
- **nftables rules** for RFC1918 isolation and NAT
- **Jailer chroot** for filesystem isolation between VMs
- **IP allocation** from a dedicated CIDR range

These operations require Linux capabilities beyond a normal user process. This guide explains how to grant them.

### When to use Firecracker

| Use case                                            | Recommended backend |
| --------------------------------------------------- | ------------------- |
| Trusted internal workloads, fast startup            | Container           |
| GPU/specialized hardware, no container support      | Bare-metal          |
| **Untrusted code, multi-tenant, security-critical** | **Firecracker**     |
| Public repository CI                                | **Firecracker**     |
| Compliance requirements (strong isolation)          | **Firecracker**     |

Firecracker adds operational complexity compared to containers (kernel management, rootfs images, network setup). Choose it when the isolation guarantees justify that overhead.

## Prerequisites

| Requirement         | Details                                                  |
| ------------------- | -------------------------------------------------------- |
| **Linux host**      | x86_64 or aarch64 with KVM support                       |
| **Kernel 5.10+**    | Required by Firecracker; 6.1+ recommended                |
| **KVM enabled**     | `/dev/kvm` must exist and be accessible                  |
| **Node.js 24+**     | Runtime for the orchestrator process                     |
| **System packages** | See [Step 1](#step-1-install-host-system-packages) below |

### Verify KVM support

```bash
# Check KVM is available
ls -la /dev/kvm
# Expected: crw-rw---- 1 root kvm 10, 232 ... /dev/kvm

# Check CPU virtualization support (x86_64 only — /proc/cpuinfo on aarch64
# does not expose a virt feature flag)
grep -Ec '(vmx|svm)' /proc/cpuinfo
# Expected on x86_64: > 0 (number of CPU cores with virtualization)

# On aarch64, look for the KVM init line in dmesg instead:
sudo dmesg | grep -iE 'kvm|hyp'
# Expected: "kvm [N]: Hyp mode initialized successfully" (or "VHE mode" /
# "nVHE mode initialized successfully"). If you see this line, KVM is live
# and Firecracker can run.

# Load KVM module if needed (skip on hosts where KVM is built into the kernel)
sudo modprobe kvm
sudo modprobe kvm_intel  # or kvm_amd
```

**ARM64 / Raspberry Pi note:** the CPU must boot at EL2 for KVM to initialize.
Modern 64-bit Raspberry Pi OS images do this automatically (the firmware sets
`arm_64bit=1` and starts Linux at EL2). If `dmesg` does not show the KVM init
line, the firmware is booting at EL1 — check `/boot/firmware/config.txt` for
`arm_64bit=1` and re-flash a current 64-bit Raspberry Pi OS image. Cortex-A72
(Pi 4) and Cortex-A76 (Pi 5) both support EL2 in silicon.

### Architecture-specific kernel format

Firecracker requires architecture-specific kernel images:

| Architecture        | Kernel format    | Filename convention |
| ------------------- | ---------------- | ------------------- |
| **amd64** (x86_64)  | Uncompressed ELF | `vmlinux`           |
| **arm64** (aarch64) | PE format        | `Image`             |

Using the wrong kernel format for your architecture causes silent boot failures. Firecracker publishes pre-built kernels for both architectures on their [releases page](https://github.com/firecracker-microvm/firecracker/releases).

### Running the validation script

KiCI includes a host validation script that checks all prerequisites:

```bash
bash scripts/firecracker/validate.sh
```

The script checks `/dev/kvm` existence and permissions, Firecracker and jailer binary availability, network tools (iproute2, nftables), IPv4 forwarding, and (with `--bridge-name`) the bridge interface. Pass custom binary paths with `--firecracker-path` / `--jailer-path`.

## Step 1: Install host system packages

A from-scratch Firecracker host needs a small set of distribution packages
beyond the Firecracker binaries themselves. The full list, with what each one
is used for:

| Package           | Used for                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `nftables`        | NAT masquerading + RFC1918 isolation rules around the VM bridge                            |
| `iproute2`        | `ip tuntap`, `ip link`, `ip addr` for TAP device + bridge management                       |
| `bridge-utils`    | Optional `brctl` legacy tool; useful for inspection (`iproute2` covers actual bridge mgmt) |
| `libcap2-bin`     | `setcap` / `getcap` for granting jailer file capabilities (Step 4)                         |
| `debootstrap`     | Builds the Debian agent rootfs (Step 7) without needing a container runtime                |
| `e2fsprogs`       | `mkfs.ext4` to format the agent rootfs image                                               |
| `acl`             | `setfacl` if you need fine-grained `/dev/kvm` permissions (rarely needed)                  |
| `curl`            | Downloads the Firecracker release tarball + kernel image                                   |
| `ca-certificates` | TLS roots for `curl` against GitHub releases / S3                                          |
| `xz-utils`        | Decompresses upstream kernel and rootfs artifacts                                          |
| `jq`              | Optional; convenience for inspecting interface / VM JSON by hand                           |

Debian 12+ / Ubuntu 22.04+:

```bash
sudo apt update
sudo apt install -y \
  nftables iproute2 bridge-utils libcap2-bin debootstrap e2fsprogs acl \
  curl ca-certificates xz-utils jq
```

Fedora / RHEL 9+:

```bash
sudo dnf install -y \
  nftables iproute bridge-utils libcap libcap-ng-utils \
  e2fsprogs acl curl ca-certificates xz jq
# debootstrap is Debian-only; on RPM hosts, build the rootfs from a Debian
# container or use a pre-built rootfs (see the rootfs build guide).
```

Verify everything is on `PATH`:

```bash
for t in nft ip brctl setcap debootstrap mkfs.ext4 setfacl curl xz jq; do
  command -v "$t" >/dev/null && echo "OK   $t" || echo "MISS $t"
done
```

## Step 2: Create the operator user

Firecracker hosts have **two** distinct unprivileged users by design — do not
conflate them:

| User          | UID    | Shell                                                               | Sudo                           | Owns                                                                    |
| ------------- | ------ | ------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------- |
| `kici`        | ≥ 1000 | `/bin/bash` (interactive) **or** `/usr/sbin/nologin` (systemd-only) | yes (interactive variant only) | The orchestrator process, `/opt/kici/`, the kernel/rootfs images        |
| `kici-jailer` | 10000  | `/usr/sbin/nologin`                                                 | no                             | The per-VM chroots under `/srv/jailer/`. VM processes run as this user. |

The jailer user is created later in [Step 5](#step-5-create-the-jailer-user).
This step creates the **operator** user.

All three variants below share the same base `useradd` + SSH-key setup; they
differ only in **how much sudo authority** the `kici` user gets. Pick one and
stick with it — mixing them (e.g., adding `kici` to the `sudo` group **and**
shipping a narrowed allowlist) creates two parallel sudo rules and causes
exactly the confusion the narrowed rule is meant to avoid.

The shared base — run this first regardless of which variant you pick.
Substitute `<your-ssh-key>` with the public key that should have access:

```bash
sudo useradd --create-home --shell /bin/bash --user-group kici
sudo usermod -aG kvm kici
sudo install -d -m 700 -o kici -g kici /home/kici/.ssh
echo '<your-ssh-key>' | sudo tee /home/kici/.ssh/authorized_keys
sudo chmod 600 /home/kici/.ssh/authorized_keys
sudo chown kici:kici /home/kici/.ssh/authorized_keys
```

Then layer **one** of the three sudo policies below.

### Variant A1: narrowed NOPASSWD allowlist (recommended)

`kici` can only run the specific binaries needed for Firecracker setup, all
without password prompts. Anything outside the list (`cat`, `rm`, `bash`, …)
is denied — and because `kici` has no password, the dead-end "sudo asked for
a password" prompt is the canonical "you're trying to do something outside
the allowlist" signal.

This is the right default for a dev / lab / single-host setup: explicit
binaries are easy to audit and easy to teardown, and the blast radius of a
leaked SSH key is bounded to the listed commands rather than to full root.

**Important:** do **not** add `kici` to the `sudo` group with this variant.
Group membership grants a parallel `kici ALL=(ALL:ALL) ALL` rule via Debian's
default `%sudo` line in `/etc/sudoers`. With no password set on `kici` that
rule is technically dead, but it muddies `sudo -ll` output and turns into a
real escalation path the moment anyone sets a password on the account. The
shared base above deliberately omits `sudo` from `usermod -aG`.

```bash
# Note: NO `usermod -aG sudo kici` — the shared base only added kvm.
sudo tee /etc/sudoers.d/kici >/dev/null <<'SUDOERS'
kici ALL=(ALL) NOPASSWD: /usr/bin/apt, /usr/bin/apt-get, /usr/sbin/setcap, \
    /usr/sbin/usermod, /usr/sbin/useradd, /usr/sbin/groupadd, \
    /sbin/ip, /usr/sbin/nft, /sbin/sysctl, \
    /usr/bin/install, /usr/bin/tee, /usr/sbin/modprobe, /usr/bin/curl
SUDOERS
sudo chmod 440 /etc/sudoers.d/kici
```

If you later need to add a binary, edit the file with
`sudo visudo -f /etc/sudoers.d/kici` (visudo runs the syntax check before
saving — never edit it with a regular editor and risk a parse error that
locks you out of sudo entirely).

If `kici` was previously added to the `sudo` group (e.g., from an earlier
broad-NOPASSWD setup), tighten down with:

```bash
sudo gpasswd -d kici sudo
```

### Variant A2: broad NOPASSWD (fastest, single-purpose lab hosts)

`kici` gets full root with no password prompt. Simpler to type and easy to
extend ad-hoc, but a leaked SSH key is full root. Use only on hosts where
that's acceptable — typically a one-shot lab Pi behind a firewall.

```bash
sudo usermod -aG sudo kici                        # group-based fallback
echo 'kici ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/kici
sudo chmod 440 /etc/sudoers.d/kici
```

### Variant B: production system user (hardened, systemd-only)

`kici` has no login shell, no sudo, no home directory beyond what `systemd`
needs. Capabilities are granted at service start time via `AmbientCapabilities`
(see [Step 10](#step-10-grant-orchestrator-capabilities), Option B) — `sudo`
is never needed at runtime.

```bash
# Replaces the shared base (no shell, no SSH key for kici, no sudoers file).
sudo useradd --system --shell /usr/sbin/nologin --create-home kici
sudo usermod -aG kvm kici
```

Setup tasks (apt installs, network config, etc.) are run as `root` by the
operator over SSH, **not** as the `kici` user. The orchestrator process
itself runs as `kici` via systemd.

> **Picking between the three:** A1 is the recommended default for any host
> a human will SSH into for setup and iteration — explicit binaries with
> NOPASSWD give ergonomics without ceding the whole host. A2 trades that
> safety for a few seconds of typing convenience and is fine on a sealed lab
> Pi. B is the right call for any host that will run jobs from external
> customers — the `kici` account cannot escalate at all, even if an
> orchestrator bug or supply-chain compromise lets an attacker run code as
> it.

After picking a variant, all further steps in this guide should be run as
`kici`. To tear down later: `sudo userdel -r kici && sudo rm -f /etc/sudoers.d/kici`.

## Step 3: Install Firecracker and jailer binaries

Run the pinned installer — it downloads the release for your architecture,
installs the `firecracker` + `jailer` binaries to `/usr/local/bin`, and applies
the jailer file capabilities:

```bash
sudo bash scripts/firecracker/install-firecracker.sh
```

The Firecracker version is pinned in that script (`FC_VERSION`), the single
source of truth. To upgrade, bump `FC_VERSION` there and re-run the script on
every Firecracker host.

## Step 4: Jailer file capabilities

Step 3's installer already applies the jailer capabilities
(`cap_sys_chroot,cap_setuid,cap_setgid+ep`). To verify:

```bash
getcap /usr/local/bin/jailer
# Expected: /usr/local/bin/jailer cap_setgid,cap_setuid,cap_sys_chroot=ep
```

**Note:** File capabilities are cleared when the binary is replaced, so a
Firecracker upgrade must re-run the installer (which re-applies `setcap`).

## Step 5: Create the jailer user

The jailer runs VM processes under a dedicated non-login user to isolate them from the host:

```bash
# Create a system user with no login shell and no home directory
sudo groupadd --system --gid 10000 kici-jailer
sudo useradd --system --uid 10000 --gid 10000 --shell /usr/sbin/nologin --no-create-home kici-jailer

# Verify
id kici-jailer
# Expected: uid=10000(kici-jailer) gid=10000(kici-jailer)
```

The UID/GID (10000) must match the `uid`/`gid` values in your `scalers.yaml` configuration.

## Step 6: Download a Linux kernel

Firecracker requires a Linux kernel binary — an uncompressed `vmlinux` (ELF)
on amd64, or an `Image` (PE) on arm64. See
[Architecture-specific kernel format](#architecture-specific-kernel-format)
above; using the wrong format causes silent boot failures.

```bash
ARCH=$(uname -m)
KERNEL_VERSION="5.10"

# amd64: uncompressed ELF vmlinux
curl -fSL -o /opt/kici/vmlinux.bin \
  "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.12/${ARCH}/vmlinux-${KERNEL_VERSION}"

# Verify it's a valid ELF binary (amd64)
file /opt/kici/vmlinux.bin
# Expected: ELF 64-bit LSB executable...

# arm64: download the PE-format Image instead and reference it as kernelPath
# (e.g. /opt/kici/Image) in scalers.yaml.
```

Firecracker also publishes pre-built kernels for both architectures on their
[releases page](https://github.com/firecracker-microvm/firecracker/releases).

## Step 7: Build the agent rootfs

Each VM boots from a copy of an ext4 rootfs image containing the operating system and the KiCI agent binary. Build it with:

```bash
sudo bash scripts/firecracker/build-agent-rootfs.sh /opt/kici/agent-rootfs.ext4 1024
```

See the [Firecracker rootfs build guide](./rootfs.md) for the full walkthrough — starting from a container image, including the agent binary, the MMDS-based bootstrap init script, and keeping images minimal. Build the rootfs on (or for) the same architecture as the host that will boot it.

## Step 8: Network setup

The Firecracker scaler uses a Linux bridge with NAT for VM networking. Each VM gets a TAP device attached to the bridge.

### Automatic host provisioning on startup

By default the orchestrator provisions this host bridge **itself** on startup: for each Firecracker bridge in the scaler config it verifies the bridge and, if it is missing or unhealthy, creates it (the same bridge, gateway, NAT, isolation, and MSS-clamp setup the `provision` command below performs). A fresh host with only the binaries + toolchain installed therefore boots and spawns microVMs with **no manual network step** — the orchestrator logs `self-provisioning bridge kici-br0 …` (or `bridge kici-br0 already healthy …`) as it runs. A self-provision failure is logged and startup continues; VM spawns then fail with the usual clear errors and `kici-admin diagnose` reports the bridge health.

This is controlled by `firecracker.autoProvisionHost` in the scaler config (default `true`). Set it to `false` to keep explicit operator control of the host network — the orchestrator will then never touch the bridge on startup, and you provision it yourself with the `provision` command below:

```yaml
# scalers.yaml
firecracker:
  bridgeName: kici-br0
  cidr: 10.0.0.0/24
  gateway: 10.0.0.1
  autoProvisionHost: false # opt out of startup self-provisioning
```

Self-provisioning re-creates the bridge on every orchestrator start and does not install a boot unit; for a bridge that survives reboots independent of the orchestrator, use the `--persist` flow below (it is complementary — keep `autoProvisionHost` on and add `--persist` for a boot-independent bridge).

The orchestrator needs the same privileges for self-provisioning that it already needs to manage TAP devices and nftables rules at spawn time — see Step 10.

### Create the bridge and NAT rules

Manual provisioning is the opt-out path (`autoProvisionHost: false`) and the way to install a boot-independent bridge (`--persist`):

```bash
sudo kici-admin firecracker provision --bridge kici-br0 --cidr 10.0.0.1/24 --persist
```

This command:

- Creates a bridge interface (`kici-br0`) with the gateway IP from `--cidr`
- Enables IP forwarding (`sysctl net.ipv4.ip_forward=1`)
- Sets up nftables NAT masquerading for outbound traffic in a dedicated table (`--table`, default `kici`)
- Adds RFC1918 + cloud-metadata isolation rules, source-scoped to the bridge subnet (VMs cannot reach private networks or `169.254.0.0/16`, with a gateway exception)
- Applies TCP MSS clamping (prevents TLS handshake hangs through NAT)
- Marks `kici-*` interfaces unmanaged by NetworkManager when present
- Auto-detects the egress interface from the default route (override with `--host-iface`)
- Coexists with Docker when it is installed on the same host: it accepts the VM
  subnet in Docker's `DOCKER-USER` chain, so Docker's default `FORWARD` DROP
  policy does not block guest internet/NAT (a no-op on hosts without Docker)

### Persistence across reboots

The bridge and NAT rules are non-persistent kernel state. The `--persist` flag (above) installs a per-bridge systemd oneshot unit (`kici-fc-net-kici-br0.service`) that recreates the bridge on boot from a dependency-free boot script — the egress interface is re-detected at boot, so a NIC rename does not break recovery. Confirm it is enabled:

```bash
systemctl is-enabled kici-fc-net-kici-br0.service   # -> enabled
```

### Verify your networking

```bash
sudo kici-admin firecracker verify --bridge kici-br0 --cidr 10.0.0.1/24 --table kici
```

`verify` exits non-zero with a precise message on any miss (bridge down, address not assigned, nft table absent) and `0` when healthy. `kici-admin diagnose` also reports a `firecracker:<bridge>` health row for every bridge the orchestrator's scaler config references, so a broken bridge surfaces in routine diagnostics.

To remove the bridge + its nft table (the host-scoped NetworkManager conf is left in place so other bridges keep their gateway IP):

```bash
sudo kici-admin firecracker teardown --bridge kici-br0 --table kici
```

## Step 9: Jailer directory setup

Create the chroot base directory and cgroup hierarchy:

```bash
sudo bash scripts/firecracker/jailer-setup.sh \
  --uid 10000 \
  --gid 10000 \
  --base-dir /srv/jailer
```

This script:

- Creates `/srv/jailer/firecracker/` owned by the jailer user
- Sets up cgroups v2 (or v1 fallback) under `/sys/fs/cgroup/firecracker`
- Enables `cpu`, `cpuset`, and `memory` controllers
- Sets ownership so the jailer process can manage per-VM cgroups

## Step 10: Grant orchestrator capabilities

The orchestrator process needs elevated privileges to manage TAP devices, nftables rules, and file ownership for the jailer chroot. Choose one of the three deployment modes below.

### Option A: container deployment (recommended)

Run the orchestrator in a Docker or Podman container with the necessary capabilities and device access:

```bash
podman run -d \
  --name kici-orchestrator \
  --cap-add NET_ADMIN \
  --cap-add SYS_ADMIN \
  --cap-add CHOWN \
  --cap-add FOWNER \
  --device /dev/kvm \
  --network host \
  -v /srv/jailer:/srv/jailer \
  -v /opt/kici:/opt/kici:ro \
  -v /path/to/scalers.yaml:/etc/kici/scalers.yaml:ro \
  quay.io/kici-dev/kici-orchestrator:latest
```

**Required capabilities:**

| Capability  | Purpose                                                             |
| ----------- | ------------------------------------------------------------------- |
| `NET_ADMIN` | Create/delete TAP devices, manage nftables rules, configure bridges |
| `SYS_ADMIN` | Mount operations (cgroups, jailer chroot)                           |
| `CHOWN`     | Change ownership of VM chroot directories to jailer UID             |
| `FOWNER`    | Bypass permission checks on files owned by other users              |

**Required device:** `/dev/kvm` (KVM hardware virtualization for Firecracker VMs).

**Required volumes:** `/srv/jailer` (jailer chroot base, read-write) and `/opt/kici` (kernel and rootfs images, read-only).

**Network mode:** Use `--network host` so the orchestrator can manage the host bridge and TAP devices directly. Bridge networking mode is not supported for Firecracker because the orchestrator needs to create host-level TAP devices.

### Option B: systemd service

For bare-metal deployments, use systemd's `AmbientCapabilities` to grant capabilities without running as root:

```ini
# /etc/systemd/system/kici-orchestrator.service
[Unit]
Description=KiCI orchestrator with Firecracker scaler
After=network-online.target kici-firecracker-network.service
Wants=network-online.target
Requires=kici-firecracker-network.service

[Service]
Type=simple
User=kici
Group=kici

# Grant specific capabilities instead of running as root
AmbientCapabilities=CAP_NET_ADMIN CAP_SYS_ADMIN CAP_CHOWN CAP_FOWNER

# Allow the process to use these capabilities
CapabilityBoundingSet=CAP_NET_ADMIN CAP_SYS_ADMIN CAP_CHOWN CAP_FOWNER

# KVM device access
SupplementaryGroups=kvm
DeviceAllow=/dev/kvm rw

# Environment
Environment=KICI_MODE=platform
Environment=KICI_SCALER_CONFIG_PATH=/etc/kici/scalers.yaml
EnvironmentFile=-/etc/kici/orchestrator.env

ExecStart=/usr/local/bin/node /opt/kici/orchestrator/server.js

# Security hardening (optional but recommended)
ProtectSystem=strict
ReadWritePaths=/srv/jailer /tmp /var/log/kici
PrivateTmp=true
NoNewPrivileges=false

[Install]
WantedBy=multi-user.target
```

**Important:** `NoNewPrivileges=false` is required — ambient capabilities are dropped when `NoNewPrivileges=true`, which would prevent child processes (jailer, ip, nft) from inheriting them.

The `kici` system user used here is the production variant created in
[Step 2 Variant B](#variant-b-production-system-user-hardened-systemd-only).

### Option C: run as root

The simplest option for development or single-tenant deployments. Run the orchestrator directly as root:

```bash
sudo node /opt/kici/orchestrator/server.js
```

This is the least secure option — the orchestrator has full root access. Use option A or B for production deployments.

## Step 11: Configure the Firecracker scaler

Add a Firecracker scaler entry to your `scalers.yaml`, pointing at the binaries, kernel, jailer UID/GID, and rootfs you provisioned above:

```yaml
version: 1

firecracker:
  cidr: '10.0.0.0/24'
  bridgeName: 'kici-br0'
  gateway: '10.0.0.1'

scalers:
  - name: firecracker-vms
    type: firecracker
    maxAgents: 10
    firecrackerPath: /usr/local/bin/firecracker
    jailerPath: /usr/local/bin/jailer
    kernelPath: /opt/kici/vmlinux.bin
    chrootBaseDir: /srv/jailer
    uid: 10000
    gid: 10000
    vcpuCount: 2
    memSizeMib: 1024
    labelSets:
      - labels: [default]
        rootfsPath: /opt/kici/agent-rootfs.ext4
```

If the orchestrator runs as a non-root user that reaches privileged commands through the sudoers allowlist from [Step 2 Variant A1](#variant-a1-narrowed-nopasswd-allowlist-recommended) or [A2](#variant-a2-broad-nopasswd-fastest-single-purpose-lab-hosts), also set `requireSudo: true` on the scaler entry so `ip`, `chown`, `chmod`, and `nft` are invoked through `sudo -n`. Leave it unset for the capability-based ([Option A](#option-a-container-deployment-recommended) / [Option B](#option-b-systemd-service)) and root ([Option C](#option-c-run-as-root)) deployments — those already have the access, and `sudo -n` would fail instead of prompting.

See the [Firecracker scaler backend](../auto-scaler/firecracker.md) and [Common configuration](../auto-scaler/common-config.md) for the full configuration reference including all Firecracker-specific fields, warm pools, network policies, and multi-backend setups.

## Dual-architecture setup

For environments with both amd64 and arm64 hosts, use separate scalers with architecture-specific kernel and rootfs paths — `/opt/kici/vmlinux.bin` (uncompressed ELF) on amd64 and `/opt/kici/Image` (PE format) on arm64, each with a matching same-architecture `rootfsPath`. An amd64 rootfs only boots on an amd64 host and vice versa.

```yaml
version: 1

firecracker:
  cidr: '10.0.0.0/24'
  bridgeName: 'kici-br0'
  gateway: '10.0.0.1'

scalers:
  - name: fc-amd64
    type: firecracker
    maxAgents: 20
    firecrackerPath: /usr/local/bin/firecracker
    jailerPath: /usr/local/bin/jailer
    kernelPath: /opt/kici/vmlinux.bin # amd64: uncompressed ELF
    uid: 10000
    gid: 10000
    labelSets:
      - labels: [linux, vm, amd64]
        rootfsPath: /opt/kici/rootfs-amd64.ext4

  - name: fc-arm64
    type: firecracker
    maxAgents: 20
    firecrackerPath: /usr/local/bin/firecracker
    jailerPath: /usr/local/bin/jailer
    kernelPath: /opt/kici/Image # arm64: PE format
    uid: 10000
    gid: 10000
    labelSets:
      - labels: [linux, vm, arm64]
        rootfsPath: /opt/kici/rootfs-arm64.ext4
```

**Note:** On arm64, the `SendCtrlAltDel` graceful shutdown is not available (it requires the i8042 keyboard controller, which is x86-only). The orchestrator falls back to process kill for arm64 VMs.

## IP allocation

### How the CIDR pool works

The orchestrator allocates IP addresses from the configured CIDR range (default: `10.0.0.0/24`). The pool is global across all Firecracker scalers on the orchestrator.

- **Gateway IP** (e.g., `10.0.0.1`) is reserved for the bridge interface.
- **Usable range:** first IP after the gateway through the last usable IP before broadcast. For `10.0.0.0/24`: `10.0.0.2` through `10.0.0.254` (253 usable addresses).
- **Allocation:** on each VM spawn, the orchestrator finds the lowest available IP and inserts it into the `ip_allocations` table.
- **Release:** on VM destroy, the IP row is deleted (not soft-deleted).

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

Making the IP the primary key means allocations survive orchestrator restarts, multiple orchestrator instances can see each other's allocations, and the same IP can never be double-allocated. The `ip_allocations` table is created by migration `001_initial`; migrations run automatically on orchestrator startup, or manually via `kici-admin db migrate`.

### MAC address generation

MAC addresses are generated deterministically from the allocated IP using the `06:00:AC` prefix (locally-administered unicast). The last three octets of the MAC are derived from the last three octets of the IP address (e.g., `10.0.1.42` produces `06:00:AC:00:01:2A`). This ensures consistent, collision-free MACs that are easy to debug — you can derive the IP from the MAC.

### TAP device naming

TAP devices are named `kici-XXXXXXXX` where `XXXXXXXX` is the last 8 characters of the VM ID. VM IDs have the format `scaler-firecracker-XXXXXXXX` where the unique random suffix is at the end, so using the last 8 characters ensures uniqueness. This stays within the Linux 15-character interface name limit (IFNAMSIZ) while providing easy identification for orphan cleanup.

### NetworkManager interaction

If the host runs NetworkManager, it **must** be configured to leave `kici-*` interfaces unmanaged. NetworkManager otherwise auto-adopts every TAP/bridge as a `connection-assumed` profile and polls each one; under heavy TAP churn this can wedge the NetworkManager main thread in a 100%-CPU spinloop.

`kici-admin firecracker provision` installs this rule automatically (in `/etc/NetworkManager/conf.d/90-kici-unmanaged.conf`) when NetworkManager is present on the host. To verify:

```bash
cat /etc/NetworkManager/conf.d/90-kici-unmanaged.conf
# Should contain: unmanaged-devices=interface-name:kici-*

nmcli -t -f DEVICE,TYPE,STATE dev | grep kici-
# Every kici-* device should show "unmanaged"
```

The conf file is **host-scoped**, not bridge-scoped: the `interface-name:kici-*` pattern protects every kici-\* interface on the host (TAPs and any number of `kici-brN` bridges that coexist for separate orchestrators). Because of that, `kici-admin firecracker teardown` deliberately leaves the file in place — only the per-bridge state (the bridge interface itself + its nftables table) is removed. Removing the conf file from a per-bridge teardown would let NetworkManager adopt the bridges that aren't being torn down and silently strip their gateway IP, breaking every other Firecracker coordinator on the host.

## Verification

After completing all steps, verify the setup:

```bash
# 1. KVM access
ls -la /dev/kvm
# Should be accessible by the orchestrator user/group

# 2. Jailer capabilities
getcap /usr/local/bin/jailer
# Expected: cap_setgid,cap_setuid,cap_sys_chroot=ep

# 3. Bridge exists
ip link show kici-br0
# Should show the bridge interface in UP state

# 4. nftables rules
sudo nft list table kici
# Should show the NAT and isolation chains

# 5. Jailer directory
ls -la /srv/jailer/firecracker/
# Should be owned by the jailer user (10000:10000)

# 6. Cgroups
ls /sys/fs/cgroup/firecracker/
# Should exist and be owned by the jailer user

# 7. Kernel and rootfs
file /opt/kici/vmlinux.bin
# Expected: ELF 64-bit LSB executable (amd64)
file /opt/kici/agent-rootfs.ext4
# Expected: Linux rev 1.0 ext4 filesystem data

# 8. Orchestrator health
curl -s http://localhost:10143/health
# Expected: {"status":"ok"}
```

## Troubleshooting

### "EPERM: operation not permitted" on `ip tuntap add`

The orchestrator process lacks `CAP_NET_ADMIN`. Check your deployment mode:

- Container: verify `--cap-add NET_ADMIN` is set
- systemd: verify `AmbientCapabilities=CAP_NET_ADMIN` and `NoNewPrivileges=false`
- Root: verify the process is actually running as root (`ps aux | grep orchestrator`)

### "ENOENT: nft not found"

Install nftables: `apt install nftables`. The `nft` binary must be in the orchestrator's `PATH`.

### VM won't boot

VM spawn times out or Firecracker exits immediately. Common causes:

- `/dev/kvm` not accessible (`ls -la /dev/kvm`).
- Wrong kernel format for the architecture: amd64 needs `vmlinux` (ELF), arm64 needs `Image` (PE).
- Kernel or rootfs paths incorrect in config — the paths must exist on the host.
- Jailer uid/gid does not have access to the chroot base directory. Re-check the `setcap` output (Step 4); file capabilities are cleared when the binary is replaced.

Debug: run `bash scripts/firecracker/validate.sh`, check the orchestrator logs for Firecracker error output, and verify file permissions on the kernel and rootfs paths.

### Agent can't reach orchestrator

The VM boots but the agent never connects and jobs stay in `dispatching`. Common causes:

- Bridge interface missing (`ip link show kici-br0`) — re-run `kici-admin firecracker provision …` (or `kici-admin firecracker verify …`). If it was torn down by a restart, check `systemctl status kici-fc-net-kici-br0.service`.
- NAT rules missing (`nft list table kici`).
- IP forwarding disabled (`cat /proc/sys/net/ipv4/ip_forward`).
- `orchestratorUrl` unset or pointing at `localhost` — VMs on a bridge cannot reach host `localhost`; set it to the bridge gateway IP (e.g., `ws://10.0.0.1:8080/ws`).

### "Permission denied" on `/dev/kvm`

Add the orchestrator user to the `kvm` group, then restart the service so the group change takes effect:

```bash
sudo usermod -aG kvm <orchestrator-user>
```

### IP pool exhausted

VM spawn fails with "no available IPs". Either the CIDR range is too small for the number of concurrent VMs, or orphaned allocations remain from crashed VMs. Increase the CIDR range in `scalers.yaml` (e.g., `/23` for 509 usable IPs) and restart the orchestrator to trigger orphan cleanup.

### Slow VM spawn

Spawn times consistently above 5 seconds usually mean large rootfs images (500 MB+ copy per VM), slow host disk I/O, or too many mount points degrading jailer performance. Keep rootfs images minimal (see the [rootfs build guide](./rootfs.md)), copy the rootfs to tmpfs for faster I/O, keep the mount-point count under 500 (`wc -l /proc/mounts`), and enable warm pools to hide copy latency from job dispatch.

### TAP devices accumulating

`ip link show` reveals many stale `kici-*` TAP devices, typically after the orchestrator was SIGKILLed before cleaning up. Restart the orchestrator — orphan cleanup runs on startup. For a manual sweep:

```bash
# Delete a specific device
sudo ip link del kici-a1b2c3d4
# Delete all per-VM kici TAP devices (leaves bridges intact)
ip link show | grep -oP 'kici-[0-9a-f]{8}' | xargs -rI{} sudo ip link del {}
```

### `sudo` prompts for password on a command that should be allowed

If you're using [Step 2 Variant A1](#variant-a1-narrowed-nopasswd-allowlist-recommended)
and `sudo <cmd>` prompts for a password (which the `kici` account does not
have), the command isn't on the NOPASSWD allowlist. Either add the binary
with `sudo visudo -f /etc/sudoers.d/kici` or run the command via an allowed
wrapper (e.g., `sudo install` instead of `sudo cp`). Inspect the effective
policy with `sudo -ll`. If `sudo -ll` shows two entries for `kici` — one from
`/etc/sudoers` (the `%sudo` group rule, `Commands: ALL`) and one from
`/etc/sudoers.d/kici` (your allowlist) — `kici` was added to the `sudo` group
and should be removed: `sudo gpasswd -d kici sudo`.

## Orphan cleanup on startup

On every startup, and again on a 15-minute timer while it runs, the Firecracker backend runs `cleanupOrphans()` to reconcile host state with the DB:

1. **DB allocations with dead processes** — the Firecracker process is gone (PID file check), so the TAP is deleted, the IP released, and the chroot removed.
2. **Chroot directories without DB records** — directory removed.
3. **Host TAP interfaces without DB allocations** — any interface matching `kici-[0-9a-f]{8}` that is not in `PROTECTED_INTERFACES` (`kici-br0`, `kici-br1`, `kici-m01`) and is not associated with a live DB allocation is deleted.

Pass 3 matters because NetworkManager polls every link on the host, so a handful of leaked TAPs from a SIGKILLed orchestrator can peg a CPU. The periodic timer exists because long-lived orchestrators (weeks of uptime is normal) would otherwise accumulate leaked TAPs — for example from a test worker SIGKILLed mid-destroy — until the next restart. If you add custom permanent kici-prefixed interfaces (e.g., additional bridges), add them to `PROTECTED_INTERFACES` in `packages/orchestrator/src/scaler/firecracker-backend.ts` so they survive sweeps. The per-VM pattern is narrow (`kici-<8-hex>`), so arbitrary operator-named interfaces like `kici-debug` are naturally ignored.

This complements — but does not replace — the external host-level sweep (`kici-leak-sweep.timer`), which skips TAP cleanup while the orchestrator is active and therefore only catches orphans that survive an orchestrator stop.

## Security considerations

### Jailer isolation

The Firecracker jailer provides multiple layers of isolation:

- **chroot:** the VM process sees only its own directory tree — no access to the host filesystem.
- **cgroups:** CPU and memory limits enforced by the kernel; VMs cannot consume host resources beyond their allocation.
- **seccomp:** system-call filtering — only the syscalls Firecracker needs are allowed.
- **uid/gid:** the Firecracker process runs as an unprivileged user (10000), so even a VM escape has limited privileges.
- **New PID namespace:** the VM process is isolated in its own PID namespace.

### Host hardening and capability minimization

- **Network isolation:** VMs are blocked from RFC1918 ranges and cloud metadata services (169.254.0.0/16) by default. Per-label-set network policies can further restrict or allow specific CIDR ranges.
- **Filesystem isolation:** each VM runs in a jailer chroot with its own rootfs copy; the overlay drive provides a writable layer without modifying the base rootfs.
- **Capability minimization:** use container capabilities (Option A) or systemd ambient capabilities (Option B) rather than running as root, and grant only the specific capabilities listed in Step 10.
- **Jailer user separation:** the jailer user (UID 10000) has no login shell and cannot be used for interactive access.

For production deployments, follow the [Firecracker production host setup guide](https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md): disable SMT/Hyper-Threading to prevent side-channel attacks, use the seccomp profiles shipped with Firecracker, limit `/dev/kvm` access to the jailer uid only, keep the mount-point count low (jailer performance degrades above 500 mount points), and use dedicated hosts for Firecracker VMs (no mixed workloads).

### Comparison with container isolation

| Property                    | Container                  | Firecracker                      |
| --------------------------- | -------------------------- | -------------------------------- |
| Kernel                      | Shared with host           | Dedicated per VM                 |
| Escape difficulty           | Container escape possible  | Hardware-level isolation (KVM)   |
| Syscall filtering           | Optional seccomp           | Mandatory seccomp + KVM boundary |
| Resource enforcement        | cgroups (kernel)           | cgroups + hypervisor             |
| Filesystem isolation        | Overlay FS (shared layers) | Full rootfs copy (no sharing)    |
| Suitable for untrusted code | With restrictions          | Yes                              |

## See also

- [Firecracker rootfs build guide](./rootfs.md) — build the ext4 agent image the VMs boot from
- [Firecracker disk recovery](./disk-recovery.md) — reclaim disk after leaked jailer chroots fill the host
- [Firecracker scaler backend](../auto-scaler/firecracker.md) — the `scalers.yaml` configuration reference
- [Auto-scaler common configuration](../auto-scaler/common-config.md) — fields shared across all backends
- [Agent configuration](../../agent/configuration.md) — environment variables for agents connecting to the orchestrator
