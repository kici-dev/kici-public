---
title: Firecracker rootfs build guide
description: Building the agent root filesystem for Firecracker microVM execution
---

The Firecracker scaler runs agent jobs inside microVMs for strong isolation. Each microVM boots from a root filesystem (rootfs) image that contains the full agent runtime: Debian base system, Node.js, npm, the native TypeScript loader binding (consumed by the `@kici-dev/core/ts-loader-hook` loader hook), and the bundled agent code.

Because the rootfs image is large (~500MB+), it is **not distributed as a pre-built download**. Instead, operators build it from the KiCI source repository with the build script the repository carries, and cache it locally. The build script supports incremental rebuilds: after the first build, it re-injects only the agent code.

## Prerequisites

| Requirement            | Details                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------ |
| **Linux host**         | Required for `debootstrap`, mount operations, and Firecracker execution              |
| **Root access**        | Build script uses `mount`, `chroot`, and `mkfs.ext4`                                 |
| **debootstrap**        | Debian/Ubuntu bootstrap tool (`apt install debootstrap`)                             |
| **curl**               | For downloading Node.js                                                              |
| **mkfs.ext4**          | Part of `e2fsprogs` (usually pre-installed)                                          |
| **util-linux**         | `flock`, `losetup` and `findmnt` (usually pre-installed)                             |
| **Git**                | To clone the source repository                                                       |
| **Node.js 24**         | Builds the workspace and bundles the agent. The rootfs gets the same Node.js version |
| **pnpm 11**            | Installs and builds the workspace                                                    |
| **Firecracker binary** | For running the microVM (not needed for building the rootfs)                         |
| **Kernel image**       | Linux kernel 5.10+ for Firecracker (not needed for building the rootfs)              |

## Prepare a source checkout

The build script, and the agent code it bundles, come from the KiCI source repository at [github.com/kici-dev/kici-public](https://github.com/kici-dev/kici-public). Check out the release tag of the orchestrator that boots the VMs, so the agent in the image matches that orchestrator. The build runs code from this checkout as root, so keep the checkout owned by root, out of reach of the account that runs the orchestrator. Then install and build the workspace:

```bash
sudo git clone --branch v<version> https://github.com/kici-dev/kici-public.git /usr/local/src/kici-public
cd /usr/local/src/kici-public
sudo env PATH="$PATH" pnpm install --frozen-lockfile
sudo env PATH="$PATH" pnpm build
```

Replace `<version>` with your orchestrator version, for example `v0.12.0`. The source repository carries the build script from KiCI 0.12.0 on. For an older orchestrator, upgrade it first. The repository's `.mise.toml` pins Node.js and pnpm. On Node.js 24, `corepack enable` also provides the pnpm version the repository names.

Run the commands on this page from the root of this checkout. The build script stops with an error when the workspace is not installed and built. To check the workspace without building anything, and without root, run `bash scripts/firecracker/build-agent-rootfs.sh --check-workspace`.

## Build script

The rootfs is built using `scripts/firecracker/build-agent-rootfs.sh`.

### Basic usage

```bash
sudo env PATH="$PATH" bash scripts/firecracker/build-agent-rootfs.sh
```

This produces an ext4 image at `/var/lib/kici/agent-rootfs.ext4` (1024 MB by default). The script creates `/var/lib/kici` when it does not exist.

`sudo env PATH="$PATH"` keeps your `PATH` under `sudo`, so the script finds the Node.js you built the workspace with, for example one that a version manager installed.

### Options

```bash
# Custom output path and size
sudo env PATH="$PATH" bash scripts/firecracker/build-agent-rootfs.sh /path/to/rootfs.ext4 2048

# Re-inject only the agent code (fast, ~seconds)
sudo env PATH="$PATH" bash scripts/firecracker/build-agent-rootfs.sh --agent-only

# Force full base image rebuild
sudo env PATH="$PATH" bash scripts/firecracker/build-agent-rootfs.sh --force-base
```

| Flag                | Purpose                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `--agent-only`      | Skip base image check, re-inject agent bundles into existing output image |
| `--force-base`      | Force rebuild of the base image even if cached                            |
| `--check-workspace` | Check that the workspace is installed and built, then exit (no root)      |

| Environment variable | Default                          | Purpose                                                                                                               |
| -------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `BASE_CACHE_PATH`    | `/var/lib/kici/rootfs-base.ext4` | Location of the cached base image. Its stamp files sit beside it                                                      |
| `KICI_NPM_REGISTRY`  | unset (npmjs)                    | npm registry for the base image's installs (pnpm and the TypeScript transform binding), for example a registry mirror |

`sudo` resets the environment, so set these variables inside the `env` command:

```bash
sudo env PATH="$PATH" BASE_CACHE_PATH=/srv/kici/rootfs-base.ext4 \
  bash scripts/firecracker/build-agent-rootfs.sh /srv/kici/agent-rootfs.ext4
```

## Two-phase build process

The build script uses a two-phase approach to minimize rebuild time:

### Phase 1: Base image (slow, cached)

Creates the base rootfs with the operating system and runtime dependencies. This phase runs only when:

- No cached base image exists
- The host Node.js version has changed
- The build script has changed, for example in a new KiCI release
- `--force-base` is passed

**What it installs:**

1. Debian 13 (trixie) minimal base via debootstrap
2. Essential packages: `curl`, `ca-certificates`, `git`
3. Node.js (matching the host version) with npm and npx
4. pnpm (for workspace dependency management)
5. The native TypeScript transform binding (matching the version the workspace installs, with native NAPI bindings) so the runtime TS loader hook resolves inside the VM. The `@kici-dev/core/ts-loader-hook` stub under `/opt/kici/node_modules/` is also seeded here, but it is refreshed on every agent injection (see Phase 2) so it always matches the bundled agent code
6. Dockerode ESM shim (agent imports it, but Docker is not available in Firecracker VMs)

> **`--force-base` after upgrades:** When rolling this out to a new host or after a Node.js version change, rebuild the base image explicitly: `sudo env PATH="$PATH" bash scripts/firecracker/build-agent-rootfs.sh --force-base`. The native TypeScript transform binding (a native NAPI build) lives in the base image and only updates on a base rebuild, so a Node major bump needs `--force-base`. The fast-path (`--agent-only`) re-injects the agent bundle **and** refreshes the `@kici-dev/core/ts-loader-hook` stub and the `/init` script, so an agent version bump that changes the bundle's externalized loader-hook dependency does not require a base rebuild.

**Stripping:** Man pages, docs, locales, and apt caches are removed to minimize image size.

### Phase 2: Agent injection (fast, every deploy)

Bundles the agent, the workflow runner and the eval runner into single-file JavaScript artifacts (build-time only; at runtime TS is transformed via the loader hook) and copies them into the rootfs:

- `agent.js` at `/opt/kici/agent.js`
- `workflow-runner.js` at `/opt/kici/sandbox/workflow-runner.js`
- `eval-runner.js` at `/opt/kici/eval-runner.js` — the agent forks it for every evaluation job (a workflow with a `filter`, a dynamic `env` / `environment` / `concurrencyGroup` / `matrix`, or a dynamic job). It sits beside `agent.js` because the agent resolves it from its own directory
- The `@kici-dev/core/ts-loader-hook` stub at `/opt/kici/node_modules/@kici-dev/core/` (`package.json` + the loader-hook dist files)
- The `/init` script (PID 1 process that bootstraps the VM and starts the agent), from `scripts/firecracker/agent-init.sh` beside the build script. It reads the metadata the orchestrator writes, so it is refreshed with the agent and matches the orchestrator version

The bundles externalize `@kici-dev/core/ts-loader-hook` and resolve it at runtime, so the stub is a property of the current bundle, not of the base image. Refreshing it on every injection keeps the stub in lockstep with the agent code — an agent bundle that changes which package the loader hook ships from stays self-sufficient without a base rebuild.

This phase takes seconds and runs on every invocation (unless skipped with specific flags).

## Output

The build produces an ext4 filesystem image:

```
/var/lib/kici/agent-rootfs.ext4             # Final rootfs image
/var/lib/kici/rootfs-base.ext4              # Cached base (reused across builds)
/var/lib/kici/rootfs-base.node-version      # Node.js version the base was built with
/var/lib/kici/rootfs-base.script-hash       # Build script the base was built with
```

## Upgrading

When you upgrade the orchestrator, rebuild the image from the matching release. Pass the image path your scaler's `rootfsPath` names, and the same `BASE_CACHE_PATH` as the first build if you set one:

```bash
cd /usr/local/src/kici-public
sudo git fetch --tags
sudo git checkout v<version>
sudo env PATH="$PATH" pnpm install --frozen-lockfile
sudo env PATH="$PATH" pnpm build
sudo env PATH="$PATH" bash scripts/firecracker/build-agent-rootfs.sh /path/to/agent-rootfs.ext4
```

The run without flags re-injects the agent code, and it rebuilds the base image when the build script or the host Node.js version changed. `--agent-only` re-injects the agent code into the existing image and keeps the cached base as it is. Without an image path, the script builds `/var/lib/kici/agent-rootfs.ext4`, and a scaler that reads another path keeps booting the old agent.

## Scaler configuration

Point each Firecracker label set at the rootfs, and the scaler at the kernel:

```yaml
# scalers.yaml
scalers:
  - name: firecracker-vms
    type: firecracker
    firecrackerPath: /usr/local/bin/firecracker
    jailerPath: /usr/local/bin/jailer
    kernelPath: /opt/kici/vmlinux.bin
    uid: 10000
    gid: 10000
    labelSets:
      - labels: [linux, x64, isolated]
        rootfsPath: /var/lib/kici/agent-rootfs.ext4
```

See the [Firecracker scaler backend](../auto-scaler/firecracker.md) for every field.

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
4. Adds the scaler's [`extraHosts`](../auto-scaler/firecracker.md#firecracker-specific-fields) mappings to `/etc/hosts`. A scaler that sets none gets no mapping
5. Starts a background resource monitor (memory, processes, OOM events)
6. Executes the agent: `exec /usr/local/bin/node /opt/kici/agent.js`

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

If Node.js was updated but the base isn't rebuilding, check the version stamp beside the base image (`/var/lib/kici/rootfs-base.node-version` by default). Delete it to force a rebuild, or use `--force-base`. A run with `--agent-only` never rebuilds the base.
