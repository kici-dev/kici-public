---
title: Firecracker host setup
description: ''
---

Complete guide for setting up a host machine to run KiCI's Firecracker scaler backend. This covers kernel configuration, binary installation, network setup, privilege configuration, and the three supported deployment modes.

## Overview

The Firecracker scaler runs agent jobs inside microVMs for strong workload isolation. Each VM boots in ~150ms, runs the CI job, and is destroyed. The orchestrator manages VM lifecycle including:

- **TAP device creation** (`ip tuntap add`, `ip link set`) for VM networking
- **nftables rules** for RFC1918 isolation and NAT
- **Jailer chroot** for filesystem isolation between VMs
- **IP allocation** from a dedicated CIDR range

These operations require Linux capabilities beyond a normal user process. This guide explains how to grant them.

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
| `debootstrap`     | Builds the Debian agent rootfs (Step 7) without needing Docker                             |
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
# container or use a pre-built rootfs (see firecracker-rootfs.md).
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

Download the Firecracker release for your architecture:

```bash
ARCH=$(uname -m)  # x86_64 or aarch64
FC_VERSION="1.12.0"

# Download and extract
curl -fSL "https://github.com/firecracker-microvm/firecracker/releases/download/v${FC_VERSION}/firecracker-v${FC_VERSION}-${ARCH}.tgz" \
  | tar -xz -C /tmp

# Install binaries
sudo install -m 755 "/tmp/release-v${FC_VERSION}-${ARCH}/firecracker-v${FC_VERSION}-${ARCH}" /usr/local/bin/firecracker
sudo install -m 755 "/tmp/release-v${FC_VERSION}-${ARCH}/jailer-v${FC_VERSION}-${ARCH}" /usr/local/bin/jailer

# Verify
firecracker --version
jailer --version
```

## Step 4: Set file capabilities on jailer

The jailer binary needs capabilities to create chroot environments and switch UID/GID for VM isolation. Instead of running it as root, grant file capabilities:

```bash
sudo setcap 'cap_sys_chroot,cap_setuid,cap_setgid+ep' /usr/local/bin/jailer

# Verify
getcap /usr/local/bin/jailer
# Expected: /usr/local/bin/jailer cap_setgid,cap_setuid,cap_sys_chroot=ep
```

**Note:** File capabilities are cleared when the binary is replaced (e.g., during a Firecracker upgrade). Re-run `setcap` after upgrading.

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

Firecracker requires a Linux kernel binary (not a bzImage — an uncompressed vmlinux):

```bash
ARCH=$(uname -m)
KERNEL_VERSION="5.10"

# x86_64
curl -fSL -o /opt/kici/vmlinux.bin \
  "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.12/${ARCH}/vmlinux-${KERNEL_VERSION}"

# Verify it's a valid ELF binary
file /opt/kici/vmlinux.bin
# Expected: ELF 64-bit LSB executable...
```

## Step 7: Build the agent rootfs

See [Firecracker rootfs build guide](firecracker-rootfs.md) for detailed instructions. Quick version:

```bash
sudo bash scripts/firecracker/build-agent-rootfs.sh /opt/kici/agent-rootfs.ext4 1024
```

## Step 8: Network setup

The Firecracker scaler uses a Linux bridge with NAT for VM networking. Each VM gets a TAP device attached to the bridge.

### Create the bridge and NAT rules

```bash
sudo kici-admin firecracker provision --bridge kici-br0 --cidr 10.0.0.1/24 --persist
```

This command:

- Creates a bridge interface (`kici-br0`) with the gateway IP from `--cidr`
- Enables IP forwarding (`sysctl net.ipv4.ip_forward=1`)
- Sets up nftables NAT masquerading for outbound traffic in a dedicated table (`--table`, default `kici`)
- Adds RFC1918 + cloud-metadata isolation rules, source-scoped to the bridge subnet (VMs cannot reach private networks)
- Marks `kici-*` interfaces unmanaged by NetworkManager when present
- Auto-detects the egress interface from the default route (override with `--host-iface`)

### Persistence across reboots

The bridge and NAT rules are non-persistent kernel state. The `--persist` flag (above) installs a per-bridge systemd oneshot unit (`kici-fc-net-kici-br0.service`) that recreates the bridge on boot from a dependency-free boot script — the egress interface is re-detected at boot, so a NIC rename does not break recovery. Confirm it is enabled:

```bash
systemctl is-enabled kici-fc-net-kici-br0.service   # -> enabled
```

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
  kici-orchestrator:latest
```

**Required capabilities:**

| Capability  | Purpose                                                             |
| ----------- | ------------------------------------------------------------------- |
| `NET_ADMIN` | Create/delete TAP devices, manage nftables rules, configure bridges |
| `SYS_ADMIN` | Mount operations (cgroups, jailer chroot)                           |
| `CHOWN`     | Change ownership of VM chroot directories to jailer UID             |
| `FOWNER`    | Bypass permission checks on files owned by other users              |

**Required device:**

| Device     | Purpose                                         |
| ---------- | ----------------------------------------------- |
| `/dev/kvm` | KVM hardware virtualization for Firecracker VMs |

**Required volumes:**

| Volume        | Purpose                                   |
| ------------- | ----------------------------------------- |
| `/srv/jailer` | Jailer chroot base directory (read-write) |
| `/opt/kici`   | Kernel and rootfs images (read-only)      |

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

Add a Firecracker scaler entry to your `scalers.yaml`:

```yaml
version: 1

firecracker:
  cidr: '10.0.0.0/24'
  bridgeName: 'kici-fc-br0'
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

See [Auto-scaler common configuration](auto-scaler/common-config.md) and the [Firecracker backend](auto-scaler/firecracker.md) for the full configuration reference including warm pools, network policies, and multi-backend setups.

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
ip link show kici-fc-br0
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
# Expected: ELF 64-bit LSB executable
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

### "Device does not exist" when spawning VMs

The bridge interface is missing. Run `sudo kici-admin firecracker provision --bridge kici-br0 --cidr 10.0.0.1/24 --persist` and check that it completed without errors (or `kici-admin firecracker verify --bridge kici-br0 --cidr 10.0.0.1/24` to confirm). Common causes:

- Bridge was torn down by a previous test/restart
- The `kici-fc-net-kici-br0.service` boot unit didn't start after reboot (check `systemctl status kici-fc-net-kici-br0.service`)
- `ip link show kici-br0` returns nothing

### "Permission denied" on `/dev/kvm`

Add the orchestrator user to the `kvm` group:

```bash
sudo usermod -aG kvm <orchestrator-user>
# Restart the service for group changes to take effect
```

### VM fails to boot (jailer errors)

Check jailer capabilities:

```bash
getcap /usr/local/bin/jailer
```

If empty, re-run the `setcap` command from Step 4. File capabilities are cleared when the binary is replaced.

### nftables rules not working (VMs can reach private networks)

Verify the kici table exists and has the correct chains:

```bash
sudo nft list table kici
```

If missing, the network setup script didn't complete. Re-run it and check for errors.

### `sudo` prompts for password on a command that should be allowed

If you're using [Step 2 Variant A1](#variant-a1-narrowed-nopasswd-allowlist-recommended)
and `sudo <cmd>` prompts for a password (which the `kici` account does not
have), the command isn't on the NOPASSWD allowlist. Either add the binary
with `sudo visudo -f /etc/sudoers.d/kici` or run the command via an allowed
wrapper (e.g., `sudo install` instead of `sudo cp`). Inspect the effective
policy with `sudo -ll`.

If `sudo -ll` shows two entries for `kici` — one from `/etc/sudoers` (the
`%sudo` group rule, `Commands: ALL`) and one from `/etc/sudoers.d/kici`
(your allowlist) — `kici` was added to the `sudo` group at some point and
should be removed: `sudo gpasswd -d kici sudo`.

## Orphan cleanup on startup

On every startup, the Firecracker backend runs `cleanupOrphans()` to reconcile host state with the DB:

1. **DB allocations with dead processes** — TAP deleted, IP released, chroot removed.
2. **Chroot directories without DB records** — directory removed.
3. **Host TAP interfaces without DB allocations** — any interface matching `kici-[0-9a-f]{8}` that is not in `PROTECTED_INTERFACES` (`kici-br0`, `kici-br1`, `kici-m01`) and is not associated with a live DB allocation is deleted.

Pass 3 matters because NetworkManager polls every link on the host, so a handful of leaked TAPs from a SIGKILLed orchestrator can peg a CPU. If you add custom permanent kici-prefixed interfaces (e.g., additional bridges), add them to `PROTECTED_INTERFACES` in `packages/orchestrator/src/scaler/firecracker-backend.ts` so they survive sweeps. The per-VM pattern is narrow (`kici-<8-hex>`), so arbitrary operator-named interfaces like `kici-debug` are naturally ignored.

## Security considerations

- **Network isolation**: VMs are blocked from RFC1918 ranges and cloud metadata services (169.254.0.0/16) by default. Per-label-set network policies can further restrict or allow specific CIDR ranges.
- **Filesystem isolation**: Each VM runs in a jailer chroot with its own rootfs copy. The overlay drive provides a writable layer without modifying the base rootfs.
- **Capability minimization**: Use container capabilities (option A) or systemd ambient capabilities (option B) rather than running as root. Only grant the specific capabilities listed above.
- **Jailer user separation**: The jailer user (UID 10000) has no login shell and cannot be used for interactive access. VM processes run under this user, not as root.
