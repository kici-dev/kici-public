---
title: Firecracker rootfs build guide
description: Building the agent root filesystem for Firecracker microVM execution
---

The Firecracker scaler runs agent jobs inside microVMs for strong isolation. Each microVM boots from a root filesystem (rootfs) image that contains the full agent runtime: Debian base system, Node.js, npm, the native TypeScript loader binding (consumed by the `@kici-dev/core/ts-loader-hook` loader hook), and the bundled agent code.

Because the rootfs image is large (~500MB+), it is **not distributed as a pre-built download**. Instead, operators build it once using the provided build script and cache it locally. The build script supports incremental rebuilds -- only the agent code is re-injected on subsequent deploys.

## Prerequisites

| Requirement            | Details                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| **Linux host**         | Required for `debootstrap`, mount operations, and Firecracker execution |
| **Root access**        | Build script uses `mount`, `chroot`, and `mkfs.ext4`                    |
| **debootstrap**        | Debian/Ubuntu bootstrap tool (`apt install debootstrap`)                |
| **curl**               | For downloading Node.js                                                 |
| **mkfs.ext4**          | Part of `e2fs-progs` (usually pre-installed)                            |
| **Node.js**            | Must be available on the build host (version is matched in the rootfs)  |
| **Firecracker binary** | For running the microVM (not needed for building the rootfs)            |
| **Kernel image**       | Linux kernel 5.10+ for Firecracker (not needed for building the rootfs) |

## Build script

The rootfs is built using `scripts/firecracker/build-agent-rootfs.sh` from the monorepo root.

### Basic usage

```bash
sudo env PATH="$PATH" scripts/firecracker/build-agent-rootfs.sh
```

This produces an ext4 image at `/var/lib/kici/agent-rootfs.ext4` (1024 MB by default).

### Options

```bash
# Custom output path and size
sudo env PATH="$PATH" scripts/firecracker/build-agent-rootfs.sh /path/to/rootfs.ext4 2048

# Re-inject only the agent code (fast, ~seconds)
sudo env PATH="$PATH" scripts/firecracker/build-agent-rootfs.sh --agent-only

# Force full base image rebuild
sudo env PATH="$PATH" scripts/firecracker/build-agent-rootfs.sh --force-base
```

| Flag           | Purpose                                                                   |
| -------------- | ------------------------------------------------------------------------- |
| `--agent-only` | Skip base image check, re-inject agent bundles into existing output image |
| `--force-base` | Force rebuild of the base image even if cached                            |

| Environment variable | Default                          | Purpose                           |
| -------------------- | -------------------------------- | --------------------------------- |
| `BASE_CACHE_PATH`    | `/var/lib/kici/rootfs-base.ext4` | Location of the cached base image |

## Two-phase build process

The build script uses a two-phase approach to minimize rebuild time:

### Phase 1: Base image (slow, cached)

Creates the base rootfs with the operating system and runtime dependencies. This phase runs only when:

- No cached base image exists
- The host Node.js version has changed
- `--force-base` is passed

**What it installs:**

1. Debian 13 (trixie) minimal base via debootstrap
2. Essential packages: `curl`, `ca-certificates`, `git`
3. Node.js (matching the host version) with npm and npx
4. pnpm (for workspace dependency management)
5. The native TypeScript transform binding (matching the monorepo version, with native NAPI bindings) so the runtime TS loader hook resolves inside the VM. The `@kici-dev/core/ts-loader-hook` stub under `/opt/kici/node_modules/` is also seeded here, but it is refreshed on every agent injection (see Phase 2) so it always matches the bundled agent code
6. Dockerode ESM shim (agent imports it, but Docker is not available in Firecracker VMs)
7. `/init` script (PID 1 process that bootstraps the VM and starts the agent)

> **`--force-base` after upgrades:** When rolling this out to a new host or after a Node.js version change, rebuild the base image explicitly: `sudo env PATH="$PATH" scripts/firecracker/build-agent-rootfs.sh --force-base`. The native TypeScript transform binding (a native NAPI build) lives in the base image and only updates on a base rebuild, so a Node major bump needs `--force-base`. The fast-path (`--agent-only`) re-injects the agent bundle **and** refreshes the `@kici-dev/core/ts-loader-hook` stub, so an agent version bump that changes the bundle's externalized loader-hook dependency does not require a base rebuild.

**Stripping:** Man pages, docs, locales, and apt caches are removed to minimize image size.

### Phase 2: Agent injection (fast, every deploy)

Bundles the agent and workflow runner into single-file JavaScript artifacts (build-time only; at runtime TS is transformed via the loader hook) and copies them into the rootfs:

- `agent.js` at `/opt/kici/agent.js`
- `workflow-runner.js` at `/opt/kici/sandbox/workflow-runner.js`
- The `@kici-dev/core/ts-loader-hook` stub at `/opt/kici/node_modules/@kici-dev/core/` (`package.json` + the loader-hook dist files)

The bundles externalize `@kici-dev/core/ts-loader-hook` and resolve it at runtime, so the stub is a property of the current bundle, not of the base image. Refreshing it on every injection keeps the stub in lockstep with the agent code — an agent bundle that changes which package the loader hook ships from stays self-sufficient without a base rebuild.

This phase takes seconds and runs on every invocation (unless skipped with specific flags).

## Output

The build produces an ext4 filesystem image:

```
/var/lib/kici/agent-rootfs.ext4    # Final rootfs image
/var/lib/kici/rootfs-base.ext4     # Cached base (reused across builds)
```

## Scaler configuration

Point the Firecracker scaler to the rootfs and kernel:

```yaml
# scalers.yaml
scalers:
  - type: firecracker
    rootfsPath: /var/lib/kici/agent-rootfs.ext4
    kernelPath: /var/lib/kici/vmlinux-5.10
    labels: [linux, x64, isolated]
```

## Kernel requirements

Firecracker requires a Linux kernel image (not the host kernel). Use version 5.10 or later.

**Critical:** The kernel must be booted with `random.trust_cpu=on` in the boot arguments. Without this, the kernel's entropy pool is empty in minimal VMs, causing `getrandom()` to block indefinitely and breaking all TLS/HTTPS operations (git clone, npm install, agent WebSocket connection).

Example boot arguments:

```
console=ttyS0 reboot=k panic=1 pci=off random.trust_cpu=on ip=172.16.0.2::172.16.0.1:255.255.255.0::eth0:off
```

Kernel images are available from the Firecracker CI bucket:

```
s3://spec.ccfc.min/firecracker-ci/v1.14/x86_64/vmlinux-5.10.245
s3://spec.ccfc.min/firecracker-ci/v1.14/aarch64/vmlinux-5.10.245
```

## VM /init process

The rootfs includes an `/init` script that runs as PID 1 inside the microVM. It:

1. Mounts `/proc`, `/sys`, `/dev`
2. Configures DNS (`8.8.8.8`, `1.1.1.1`)
3. Reads configuration from Firecracker MMDS (orchestrator URL, agent ID, labels, token)
4. Starts a background resource monitor (memory, processes, OOM events)
5. Executes the agent: `exec /usr/local/bin/node /opt/kici/agent.js`

The agent receives its configuration via MMDS metadata, injected by the Firecracker scaler at VM launch time.

## Troubleshooting

### TLS connections hang or time out

Ensure `random.trust_cpu=on` is in the kernel boot arguments. Without it, `getrandom()` blocks indefinitely in minimal VMs with no entropy sources.

### Permission denied errors

The Firecracker jailer drops privileges to UID 10000. All files in the chroot must be owned by this UID:

```bash
chown -R 10000:10000 /srv/jailer/firecracker/*/root/
```

### ext4 journal errors on mount

After a VM is killed (SIGKILL), the journal may be dirty. Mount the image read-write (not read-only) to allow journal recovery:

```bash
mount /var/lib/kici/agent-rootfs.ext4 /mnt
umount /mnt
```

### Base image rebuild not triggered

If Node.js was updated but the base isn't rebuilding, check the version stamp at `/var/lib/kici/rootfs-base.node-version`. Delete it to force a rebuild, or use `--force-base`.
