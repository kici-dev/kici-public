---
title: Multi-architecture images
description: Running KiCI on x64 (amd64) and ARM64 (aarch64) machines with the published multi-arch images
---

KiCI runs on x64 (amd64) and ARM64 (aarch64) machines. Every release publishes the orchestrator
and agent images to `quay.io/kici-dev` as multi-arch manifest lists for `linux/amd64` and
`linux/arm64`. Pull the same reference on each machine. The container runtime selects the image for
the architecture of that machine.

## Pull the published images

```bash
podman pull quay.io/kici-dev/kici-orchestrator:<version>
podman pull quay.io/kici-dev/kici-agent:<version>
```

[Release artifacts](./release-artifacts.md) lists the digest of each image for the current release.
The digest is the manifest-list digest, so a digest-pinned reference also resolves on both
architectures.

## Build the images yourself

[Distribution § Building images](./distribution.md#building-images) shows how to build an image
from source. A build produces an image for the architecture of the build machine only. For both
architectures, build on an x64 machine and on an ARM64 machine.

## Clusters with x64 and ARM64 machines

One cluster can run agents on both architectures. Give each architecture its own scaler, and set the
architecture in the `platform` field of the scaler. An ARM64 pool accepts only the jobs whose
`runsOn` includes `arm64`, so other jobs stay on the x64 pool.
[Clustering § x64 + ARM64 pool](../orchestrator/clustering.md#x64--arm64-pool) shows the
orchestrator configuration.

With the published images, the scalers on both machines use the same image reference:

```yaml
# scalers.yaml on the ARM64 machine
version: 1

scalers:
  - name: container-arm64
    type: container
    maxAgents: 10
    platform:
      os: linux
      arch: arm64
    labelSets:
      - labels: ['linux', 'container']
        image: 'quay.io/kici-dev/kici-agent:<version>'
```

On the x64 machine, name the scaler `container-x64` and set `arch: x64`. A job for the ARM64 pool
sets `runsOn: ['linux', 'container', 'arm64']`.

## Container runtime requirements

| Service      | Special capabilities                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| Orchestrator | `NET_ADMIN` if using Firecracker (see [Firecracker host setup](../orchestrator/firecracker/host-setup.md)) |
| Agent        | None (standard container)                                                                                  |

Both services run as non-root (`USER node`) inside their containers.

## Firecracker on ARM64

Firecracker needs hardware virtualization (KVM) on ARM64 too: the host must expose `/dev/kvm`. Many
ARM64 cloud instances with shared vCPUs do not expose it. For example, Hetzner Cloud CAX instances
do not. Bare-metal ARM64 hosts, such as AWS Graviton `.metal` instances, do.

The container and bare-metal scaler backends do not need KVM, so they run on any ARM64 host.

[Firecracker host setup](../orchestrator/firecracker/host-setup.md) shows how to check for KVM, and
which kernel format ARM64 needs.
