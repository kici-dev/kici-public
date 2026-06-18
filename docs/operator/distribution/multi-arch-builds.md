---
title: Multi-architecture builds
description: Building and deploying KiCI images for x64 (amd64) and ARM64 (aarch64)
---

KiCI supports deployment on both x64 (amd64) and ARM64 (aarch64) platforms. Images are built
natively on each architecture for maximum performance -- no QEMU emulation is used.

## Prerequisites

Each build machine requires:

- **Podman 5.x** (or Docker with equivalent commands)
- **Git** and access to the KiCI source repository
- **Node.js 24** and **pnpm 10.x** (for building TypeScript before containerization)

The build script handles image creation and multi-arch manifest assembly. It runs from the
repository root, where the Dockerfiles reference `packages/` paths relative to the workspace.

## Building per-architecture images

KiCI provides a build script at `scripts/build-multi-arch.sh` that automates the process.

### On an x64 machine

```bash
# Clone the repository
git clone https://github.com/kici-dev/kici-public.git && cd kici-public

# Build all three services for amd64
./scripts/build-multi-arch.sh orchestrator stg
./scripts/build-multi-arch.sh agent stg
./scripts/build-multi-arch.sh platform stg
```

This produces images tagged with the architecture suffix:

- `localhost/kici-orchestrator:stg-amd64`
- `localhost/kici-agent:stg-amd64`
- `localhost/kici-platform:stg-amd64`

### On an ARM64 machine

```bash
# Same commands -- architecture is auto-detected
./scripts/build-multi-arch.sh orchestrator stg
./scripts/build-multi-arch.sh agent stg
./scripts/build-multi-arch.sh platform stg
```

This produces:

- `localhost/kici-orchestrator:stg-arm64`
- `localhost/kici-agent:stg-arm64`
- `localhost/kici-platform:stg-arm64`

### Overriding architecture

Use `--arch` to force a specific architecture tag (the actual binary architecture still depends on
the host machine):

```bash
./scripts/build-multi-arch.sh orchestrator stg --arch arm64
```

## Multi-arch manifests (optional)

### What are manifests?

An OCI multi-arch manifest (also called a manifest list or image index) is a pointer that maps a
single image tag to multiple platform-specific images. When a container runtime pulls the image, it
automatically selects the correct variant for its architecture.

### When are they useful?

Manifests are useful when you push images to a registry. A single tag like
`registry.example.com/kici-orchestrator:stg` resolves to the correct amd64 or arm64 image
depending on the pulling machine. Without a registry, the manifest serves as local verification
that both architecture images are present and correctly tagged.

### Creating a manifest

Both per-arch images must exist in the same Podman store. Transfer images between machines if
needed:

```bash
# Transfer from x64 to ARM64 machine (or vice versa)
podman save localhost/kici-orchestrator:stg-amd64 | ssh arm64-host podman load
podman save localhost/kici-orchestrator:stg-arm64 | ssh x64-host podman load
```

Then create the manifest:

```bash
./scripts/build-multi-arch.sh orchestrator stg --manifest-only
```

This creates `localhost/kici-orchestrator:stg` as a multi-arch manifest containing both the amd64
and arm64 variants. The script validates that both images exist before creating the manifest.

### Pushing to a registry

When a private registry is available:

```bash
podman manifest push localhost/kici-orchestrator:stg \
  docker://registry.example.com/kici-orchestrator:stg
```

## Deployment on heterogeneous clusters

KiCI supports mixed-architecture deployments where x64 and ARM64 machines run together. The
multi-orchestrator clustering feature (see [Clustering](../orchestrator/clustering.md)) enables this pattern.

### Architecture-specific deployments

Each machine runs the image built for its native architecture:

```
x64 Machine                          ARM64 Machine
+---------------------------+        +---------------------------+
| kici-orchestrator:stg-amd64 |      | kici-orchestrator:stg-arm64 |
| kici-agent:stg-amd64       |      | kici-agent:stg-arm64        |
+---------------------------+        +---------------------------+
         |                                    |
         +------------- Platform Relay -----------+
```

### Multi-orchestrator configuration

Both orchestrators register the same routing key with the Platform relay. The Platform layer
round-robins incoming webhooks across connected orchestrators. Each orchestrator dispatches jobs to
its local agents, which run natively on the matching architecture.

Key configuration points:

- Both orchestrators register the same routing key (e.g., `github:12345`) via their shared GitHub App source configuration
- Each orchestrator has its own agent pool with architecture-matched labels
- Cluster mode enables job rerouting if one orchestrator cannot handle a job locally
- See [Clustering](../orchestrator/clustering.md) for detailed configuration

### Scalers configuration

When using the auto-scaler, configure architecture-appropriate settings in `scalers.yaml` on each
machine. The agent images referenced in scaler label-sets must match the host architecture:

```yaml
# On x64 machine
label_sets:
  - labels: [linux, x64]
    type: container
    container:
      image: localhost/kici-agent:stg-amd64
```

```yaml
# On ARM64 machine
label_sets:
  - labels: [linux, arm64]
    type: container
    container:
      image: localhost/kici-agent:stg-arm64
```

## Container runtime requirements

| Service      | Special Capabilities                                                      |
| ------------ | ------------------------------------------------------------------------- |
| Orchestrator | `NET_ADMIN` if using Firecracker (see [Orchestrator docs](orchestrator/)) |
| Agent        | None (standard container)                                                 |
| Platform     | None (standard container)                                                 |

All three services run as non-root (`USER node`) inside their containers.

## ARM64 Firecracker support

Firecracker requires hardware virtualization support (KVM). On ARM64, this means the host machine
must expose `/dev/kvm` with the necessary CPU features. Not all ARM64 hosting options provide KVM
access.

### Current status

**Hetzner CAX11 (shared vCPU): KVM is NOT available.** Shared vCPU instances on Hetzner Cloud do
not expose `/dev/kvm` to the guest. This is an infrastructure limitation of shared-tenancy cloud
instances -- the hypervisor does not pass through nested virtualization to shared vCPU guests.

Verified on 2026-02-19:

- `/dev/kvm` does not exist
- `lscpu` reports no virtualization capabilities
- CPU features include `fp`, `asimd`, `aes`, `pmull`, `sha1`, `sha2`, `crc32`, `atomics` -- but no
  SVE or nested virtualization extensions

### Implications

- **Firecracker cannot run on the ARM64 test machine** -- it exits immediately without KVM
- **Container and bare-metal scaler backends work normally on ARM64** without KVM
- ARM64 Firecracker E2E tests are deferred until a KVM-capable ARM64 machine is available

### What is needed for ARM64 Firecracker

To run Firecracker on ARM64, you need one of:

| Option                    | KVM Available | Notes                                     |
| ------------------------- | ------------- | ----------------------------------------- |
| Hetzner CAX dedicated CPU | Likely yes    | Dedicated vCPU instances may expose KVM   |
| Hetzner bare-metal ARM64  | Yes           | Full hardware access                      |
| AWS Graviton bare-metal   | Yes           | `a1.metal` or `m6g.metal` instances       |
| Ampere Altra bare-metal   | Yes           | Various hosting providers                 |
| Raspberry Pi 4/5 (Linux)  | Yes           | Useful for development, limited resources |

Once a KVM-capable ARM64 machine is available, the existing Firecracker E2E test suite
(`cd e2e && pnpm e2e:firecracker`) should work with the ARM64 kernel and rootfs images.

## Current limitations

- **No private registry**: Images are local-only per machine. Cross-machine transfer requires
  `podman save`/`podman load` or setting up a registry.
- **No automated build pipeline**: The build process is manual (run the script on each machine).
- **No cross-compilation**: Images must be built natively on each architecture. QEMU-based
  cross-builds are not supported due to performance and reliability concerns.
- **Manifest creation requires both images locally**: The `--manifest-only` flag needs both
  per-arch images in the same Podman store, which typically means transferring one image.

## Quick reference

```bash
# Build for current architecture
./scripts/build-multi-arch.sh <service> <tag>

# Force specific architecture tag
./scripts/build-multi-arch.sh <service> <tag> --arch <amd64|arm64>

# Create multi-arch manifest (both arch images must exist locally)
./scripts/build-multi-arch.sh <service> <tag> --manifest-only

# Transfer image to another machine
podman save localhost/kici-<service>:<tag>-<arch> | ssh <host> podman load

# Services: orchestrator, agent, platform
```
