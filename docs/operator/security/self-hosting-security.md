---
title: Is self-hosting the agents a security risk?
description: 'How KiCI contains the classic self-hosted-runner risks: ephemeral sandboxes, fork-PR holds, default-on egress blocking, and environment-free secrets'
---

GitHub's own documentation recommends self-hosted runners only for private repositories, because on a public repository anyone who can open a pull request can attempt to run code on your machine. If you are evaluating KiCI and asking _"isn't bringing my own agents a security downgrade compared to hosted CI?"_ — this page is the honest answer.

## The short answer

> Self-hosted CI runners carry real risks — fork-PR code execution and lateral movement are the classic ones. KiCI's answer is ephemeral, isolated agents — container or Firecracker microVM sandboxes destroyed after every job — combined with fail-closed defaults: fork PRs are held for approval, egress to private network ranges is blocked, and secrets never enter the job environment unless a workflow explicitly exposes them. Self-hosting is not risk-free, but with these defaults it is a defensible posture — and in exchange, your code, secrets, and logs never leave your infrastructure.

## The risks, stated honestly

Self-hosted runner risk is not hypothetical. Three patterns account for most real-world incidents:

- **Fork-PR code execution.** CI exists to run code. On a public repository, anyone can open a pull request — so without controls, a stranger's branch executes on your hardware. This is why GitHub recommends self-hosted runners for private repositories only.
- **Lateral movement.** A job that escapes (or was never contained) can reach whatever its host can reach: internal services, cloud metadata endpoints, neighboring machines. Supply-chain attacks have used compromised CI runners as persistent footholds inside victim networks.
- **State that outlives the job.** A long-lived runner accumulates toolchains, caches, and credentials. One poisoned job can contaminate every job that follows it.

## How KiCI contains each risk

### Nothing survives the job

Every job runs in a disposable sandbox — a fresh container, or a fresh microVM with its own root filesystem copy — torn down when the job ends. Workflow code never executes inside a long-lived agent process, so there is no persistent runner state for a compromised job to poison.

### Fork PRs are held by default

KiCI's trust policy is fail-closed out of the box: pull requests from forks are **held for approval**, unknown contributors are held, and workflow-file modifications by non-trusted contributors are held. Code from a stranger does not run until someone with approval rights releases it. See [CI security](./security.md) for policy configuration.

### Pick the isolation tier that matches your trust level

- **Container (default).** Each job runs in its own container with filesystem, process, and network isolation, destroyed afterwards. The right choice for most deployments.
- **Bare metal (+ sandbox namespaces).** Process-level isolation for trusted, internal-only workflows — optionally hardened with bubblewrap namespaces (read-only system mounts, loopback-only network).
- **Firecracker microVM.** Hardware-virtualization isolation — a separate kernel, memory, and network stack per job, with a fresh root filesystem each time. The tier to use if you choose to run untrusted code such as fork PRs.

See [Agent execution security](./agent-security.md) for the full per-backend comparison and configuration guidance.

### Your internal network is unreachable by default

Container and Firecracker jobs run behind egress filtering that blocks private (RFC1918) address ranges **by default** — a compromised job cannot scan or call into your internal services unless you explicitly allow it. With the bare-metal namespace sandbox enabled, the job's network is loopback-only.

### Secrets never sit in the environment

Secrets are delivered to workflow code over an internal channel (`ctx.secrets`) rather than environment variables, and enter the process environment only when a workflow explicitly calls `ctx.secrets.expose()`. Agent credentials never enter the sandbox at all: the job environment is built from an explicit allowlist, and everything else — including all agent-internal variables — is excluded. See [Secrets management](./secrets.md).

### The hosted relay never sees your code

The same property that makes you self-host also protects you: KiCI's hosted Platform is a thin webhook relay. Your source, secrets, build logs, and artifacts stay on your orchestrator and agents — they never transit KiCI's infrastructure. The relay handles webhook routing and run metadata only.

## What you still own

KiCI's defaults make self-hosting defensible, not risk-free. The honest division of responsibility:

- **Prefer private repositories.** If your repository is public, keep the fork-PR policy at `hold` (the default) and review held runs before releasing them — or route them to the Firecracker backend.
- **Match the backend to the code you run.** Bare metal without the namespace sandbox is for fully trusted, internal-only workflows. Untrusted code belongs in containers at minimum, microVMs ideally.
- **Harden and patch the host.** KiCI isolates jobs from the host and your network, but the host OS, container runtime, and kernel updates are yours to maintain.
- **Scope your secrets.** Bind secret scopes to specific environments so a job only receives the secrets it needs — never hand every job every secret.

## Go deeper

- [Agent execution security](./agent-security.md) — the per-backend isolation model, safety-mechanisms comparison table, and configuration guidance.
- [CI security](./security.md) — trust policies, identity linking, and approval workflows.
- [Execution isolation architecture](../../architecture/execution/execution-isolation.md) — how the sandbox boundary is built.
- [Auto-scaler: Firecracker backend](../orchestrator/auto-scaler/firecracker.md) — microVM networking, jailer, and rootfs setup.
- [Secrets management](./secrets.md) — secret storage, scoping, and delivery.
