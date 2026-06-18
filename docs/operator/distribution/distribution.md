---
title: Distribution
description: How KiCI packages are distributed and deployed
---

KiCI distributes via three channels: **npm packages**, **OCI container images**, and **Firecracker rootfs**. This guide covers what each channel provides, when to use it, and how to obtain artifacts.

> **Note:** The Platform relay tier is internal-only -- it is not distributed to customers. Customers connect to the hosted Platform or use independent orchestrator mode.

> **Note:** KiCI also offers standalone packages with an embedded Node.js binary for deployments where npm is not available. See the [Packaging guide](sea-binaries.md) for details on full and light package types.

---

## npm packages

All KiCI packages are published to the public npm registry (`npmjs.com`).

### Scoped packages

| Package                  | Purpose                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `@kici-dev/sdk`          | Workflow definition API (triggers, jobs, steps, rules, matrices)                                      |
| `@kici-dev/compiler`     | CLI tooling (compile, test, init, run, fixture, hook)                                                 |
| `@kici-dev/core`         | Light shared utilities (logging, errors, formatting, crypto, TS loader hook) — no server dependencies |
| `@kici-dev/shared`       | Shared utilities (logger, database, crypto, telemetry); re-exports `@kici-dev/core`                   |
| `@kici-dev/engine`       | Business logic (protocol, triggers, state machine, providers)                                         |
| `@kici-dev/orchestrator` | Customer-deployable orchestrator with provider abstraction                                            |
| `@kici-dev/agent`        | Customer-deployable job execution agent                                                               |

### Wrapper CLIs

| Package      | Command      | Wraps                        |
| ------------ | ------------ | ---------------------------- |
| `kici`       | `kici`       | `@kici-dev/compiler/cli`     |
| `kici-admin` | `kici-admin` | `@kici-dev/orchestrator/cli` |

### User installation (workflow authors)

Install the SDK and compiler as dev dependencies in your project:

```bash
npm install -D @kici-dev/sdk @kici-dev/compiler
```

Or use the interactive setup:

```bash
npx kici init
```

This creates a `.kici/` directory with workflow templates, installs dependencies, and optionally sets up a pre-commit compile hook.

### Operator installation (orchestrator setup)

Install and configure the orchestrator using the admin CLI:

```bash
npx kici-admin orchestrator install --wizard --instance-dir ~/kici-deploy
```

This pulls `@kici-dev/orchestrator` and runs the interactive setup wizard, which configures the database, Platform connection, scaler backends, and service installation. The `--instance-dir` flag chooses the deploy folder where the instance manifest (`.kici-orchestrator.json`) is written; lifecycle commands later resolve their target through that manifest. See the [Instance directory and manifest](service-installation.md#instance-directory-and-manifest) section for the full model.

### Agent bare-metal installation

For the bare-metal scaler backend, install the agent globally:

```bash
npm install -g @kici-dev/agent
```

The agent requires `git`, a shell (`bash` on Linux/macOS, `pwsh` on Windows), `node`, and `npm` to be available on the host. See [Agent runtime dependencies](#agent-runtime-dependencies) below.

### Publishing (maintainers)

Packages are published in dependency order using `packages/ci/src/release.ts` (invoked as `pnpm release <pkg>` or `pnpm release --all`). The script publishes one or more workspace packages to the npm registry, then bumps every workspace `package.json` version (root + 8 publishables) so subsequent local builds emit prereleases against the new base. Each package's `prepublishOnly` script regenerates `sbom.spdx.json` before the tarball is packed, so the published SBOM always matches the published version.

### Public release phase (maintainers)

`pnpm release:prod` runs the full production release. After it publishes the npm packages and the container images, it runs a **public-repo phase** that projects the public-facing packages, docs, and examples to the `kici-dev/kici-public` repository, maintains an accumulating repo-root `CHANGELOG.md`, and creates a GitHub release for the version. The phase runs **after** the npm/image publish and **before** the version bump, so the projected repository ships the exact package versions that were just released.

The phase has four steps:

1. **Release notes (interactive).** AI-drafts a release-notes section from the public-facing commits since the previous version tag, then opens the draft in your editor — VSCode (`code --wait`) when a VSCode session is connected, otherwise `nano` — with an accept / re-edit / re-draft loop. On accept, the approved section is prepended to the repo-root `CHANGELOG.md` and committed. This commit lands **before** the git tag, so the tag includes the changelog. This step **requires an interactive terminal**: it cannot run under a non-TTY / fully-automated environment and fails fast if `stdin` is not a TTY.
2. **Quickstart regeneration.** Regenerates the quickstart compose and scaler files for the released version so the projected repository's quickstart pins the just-released image tags.
3. **Publish.** Projects the public packages, public docs, and examples into `kici-dev/kici-public` as **one squashed commit appended on top of the previous release** (a linear, browsable release history — never a force-push), then tags `v<version>`. `git log main` on the public repo shows exactly one commit per release.
4. **GitHub release.** Creates the GitHub release `v<version>` on `kici-dev/kici-public`, using the new `CHANGELOG.md` section as the release body.

#### Prerequisite: the public-repo GitHub App

All git and `gh` operations in the public phase authenticate as a **GitHub App installation**. The App is org-owned, its installation tokens are short-lived and auto-refreshed, and it is scoped to exactly **`Contents: read & write`** on `kici-dev/kici-public` — which covers both pushing code and creating releases. Three sops-encrypted values in `infra/ci/creds.enc.yaml` carry the App identity, loaded the same way as the npm and registry credentials:

- `GITHUB_KICI_DEV_PUBLIC_CI_APP_ID`
- `GITHUB_KICI_DEV_PUBLIC_CI_APP_INSTALLATION_ID`
- `GITHUB_KICI_DEV_PUBLIC_CI_APP_PRIVATE_KEY`

The release tooling mints an installation token in-process from these values at run time; the token is never written to disk and is redacted from any logged git output.

A read-only pre-flight step, `preflight/github-public-app`, runs early and fails fast if the credentials are missing, cannot mint a token, or the App cannot resolve the repository. Edit the credentials with:

```bash
sops infra/ci/creds.enc.yaml
```

#### Skipping and idempotency

- **`--skip-public`** skips the entire public phase. Use it for infra-only re-runs that should not touch the public repository.
- The phase is **idempotent**. Re-running a release at the same version detects already-completed work and skips it: the changelog step skips when a `## v<version>` section is already present, the projection/push skips when the `v<version>` tag already exists, and the GitHub-release step skips when a release for that version already exists.

---

## Container images

OCI-compliant container images are built for the orchestrator and agent.

### Available images

| Image                         | Contents                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `kici-orchestrator:<version>` | Orchestrator with all dependencies, ready for Docker/Podman/Kubernetes                  |
| `kici-agent:<version>`        | Agent with git, bash, node, npm, and the native TypeScript loader binding pre-installed |

The agent container image is self-contained -- it includes all required runtime dependencies and can execute workflows without any additional host-level tools.

### Multi-architecture support

Images are built natively for **amd64** and **arm64** platforms. No QEMU emulation is used -- each architecture is built on its native hardware.

```bash
# Build on the current architecture
scripts/build-multi-arch.sh agent <tag>

# Create a multi-arch manifest after building on both architectures
scripts/build-multi-arch.sh agent <tag> --manifest-only
```

See [Multi-architecture builds](multi-arch-builds.md) for the full workflow including cross-machine image transfer and manifest creation.

### Building images

Build from the monorepo root:

```bash
# Agent image
podman build -t kici-agent:<version> -f packages/agent/Dockerfile .

# Orchestrator image
podman build -t kici-orchestrator:<version> -f packages/orchestrator/Dockerfile .
```

Both Dockerfiles use multi-stage builds: a builder stage with full dev dependencies produces the compiled output, and a slim runtime stage contains only production dependencies.

### Container registry

The container registry is configurable -- images are built locally and can be pushed to any OCI-compliant registry (Docker Hub, GitHub Container Registry, Quay.io, a self-hosted registry, etc.). The build pipeline is registry-agnostic by design.

```bash
# Tag and push to your registry
podman tag kici-agent:latest registry.example.com/kici-agent:latest
podman push registry.example.com/kici-agent:latest
```

---

## Firecracker rootfs

Firecracker microVM execution requires a root filesystem image containing the agent and all its dependencies. Due to image size (~500MB+), the rootfs is **not distributed as a pre-built artifact**. Instead, operators build it once and cache it locally.

See the dedicated [Firecracker rootfs build guide](../orchestrator/firecracker-rootfs.md) for full instructions.

---

## Orchestrator deployment modes

The orchestrator supports four deployment modes, all officially supported.

### Container image (Docker/Podman/Kubernetes)

Deploy the orchestrator as a container. This is the simplest approach for production.

```yaml
# docker-compose.yml
services:
  orchestrator:
    image: kici-orchestrator:latest
    ports:
      - '10143:10143'
    environment:
      MODE: platform
      KICI_PLATFORM_URL: wss://relay.kici.dev
      KICI_PLATFORM_TOKEN: ${KICI_PLATFORM_TOKEN}
      KICI_DATABASE_URL: ${KICI_DATABASE_URL}
    depends_on:
      - postgres
```

For Kubernetes, deploy as a `Deployment` or `StatefulSet` (StatefulSet is recommended for clustered setups with stable instance IDs).

### npm + systemd (Linux)

Install the orchestrator via npm and configure a systemd service:

```bash
npx kici-admin orchestrator install --wizard --instance-dir ~/kici-deploy
cd ~/kici-deploy && npx kici-admin orchestrator start
```

The `kici-admin orchestrator install` command writes an instance manifest to the deploy folder, generates a systemd unit file, enables the service, and registers the instance in the host's index. The unit is configured with automatic restart, journald logging, and environment file support. Per-instance config, log, and install directories are name-scoped (`/etc/kici/<name>/`, `/var/log/kici/<name>/`, `/opt/kici/<name>/`), so two instances with different `--name` values are fully isolated.

See [Service installation](service-installation.md) for the full reference.

### npm + launchd (macOS)

Install the orchestrator via npm and configure a launchd agent:

```bash
npx kici-admin orchestrator install --wizard --instance-dir ~/kici-deploy
cd ~/kici-deploy && npx kici-admin orchestrator start
```

The command writes an instance manifest to the deploy folder, generates a launchd plist, loads the agent, and starts the service. Logs go to `~/Library/Logs/kici/<name>/`.

See [Service installation](service-installation.md) for the full reference.

### npm + Windows service

Install the orchestrator via npm and configure a Windows service:

```bash
npx kici-admin orchestrator install --wizard --instance-dir C:\kici-deploy
cd C:\kici-deploy
npx kici-admin orchestrator start
```

The command writes an instance manifest to the deploy folder and registers the orchestrator as a Windows service with automatic start. Logs go to the Windows Event Log and a local per-instance log directory (`C:\ProgramData\kici\<name>\logs\`).

See [Service installation](service-installation.md) for the full reference.

---

## Agent deployment formats

The agent supports three deployment formats, each suited to a different scaler backend.

### Container image

Used by the **container scaler**. The orchestrator pulls and runs the agent container image for each job.

The image name and tag are configured in the scaler YAML:

```yaml
# scalers.yaml
scalers:
  - type: container
    image: kici-agent:latest
    labels: [linux, x64]
```

The container image includes git, bash, node, npm, and the native TypeScript loader binding -- no additional dependencies are needed.

### npm package (bare-metal)

Used by the **bare-metal scaler**. The agent is installed on the host machine and spawned as a process for each job.

```bash
npm install -g @kici-dev/agent
```

The host must have git, a shell (bash on Linux/macOS, pwsh on Windows), node, and npm available. The bare-metal scaler starts agent processes directly, passing job configuration via environment variables.

### Firecracker rootfs

Used by the **Firecracker scaler**. The operator builds a rootfs image containing the agent, and the scaler launches Firecracker microVMs with that image.

```yaml
# scalers.yaml
scalers:
  - type: firecracker
    rootfsPath: /var/lib/kici/agent-rootfs.ext4
    kernelPath: /var/lib/kici/vmlinux-5.10
    labels: [linux, x64, isolated]
```

See [Firecracker rootfs build guide](../orchestrator/firecracker-rootfs.md) for building the image.

---

## Agent runtime dependencies

Every agent deployment requires the following runtime dependencies, regardless of deployment format:

### Required

| Dependency                                   | Purpose                                                                                          | Notes                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| **git** (CLI)                                | Repository cloning                                                                               | Any recent version                                                                                                         |
| **bash** (Linux/macOS) or **pwsh** (Windows) | Step execution via zx                                                                            | Shell for workflow steps. On Windows, PowerShell 7 (`pwsh`) is required — the agent auto-installs it via winget if missing |
| **node**                                     | Runtime + child process spawning                                                                 | Must match the version used to build the agent                                                                             |
| **npm**                                      | `.kici/` dependency installation                                                                 | Ships with Node.js                                                                                                         |
| **TypeScript loader binding**                | TS transform on `import()` (native NAPI bindings, consumed by `@kici-dev/shared/ts-loader-hook`) | Must be in `node_modules`, not lazy-downloaded                                                                             |

The container image and Firecracker rootfs include all required dependencies. For bare-metal deployment, the operator must ensure these are available on the host.

npm is the only package manager used -- pnpm is not bundled. npm ships with Node.js and the agent resolves `npm-cli.js` from the Node installation directory.

### Optional host-level tools

| Tool                    | Purpose                         | When needed                         |
| ----------------------- | ------------------------------- | ----------------------------------- |
| **bwrap** (bubblewrap)  | Sandbox isolation on bare-metal | Bare-metal scaler with sandbox mode |
| **docker** / **podman** | Container sandbox mode          | Container-based step isolation      |

These are not bundled in any deployment format -- they are host-level tools the operator installs if the feature is needed.

---

## Choosing a deployment model

| Scenario                         | Orchestrator               | Agent                      |
| -------------------------------- | -------------------------- | -------------------------- |
| **Quick start (single machine)** | Container image            | Container image            |
| **Production Linux server**      | npm + systemd              | Container or bare-metal    |
| **macOS CI runner**              | npm + launchd              | Bare-metal (npm)           |
| **Windows CI runner**            | npm + Windows service      | Bare-metal (npm)           |
| **Kubernetes cluster**           | Container image            | Container image            |
| **High-security isolation**      | Container or systemd       | Firecracker rootfs         |
| **Multi-architecture**           | Container image (per-arch) | Container image (per-arch) |
