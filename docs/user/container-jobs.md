---
title: Container jobs
description: Run a job inside any container image, including a private one, without that image shipping Node or git
---

A job can run inside a container image you choose. Set `container` on the job:

```typescript
job('build', {
  runsOn: ['kici:os:linux'],
  container: 'python:3.12-slim',
  steps: [compile, test],
});
```

Every step then runs inside that image.

## Your image needs almost nothing

KiCI supplies its own runtime. It mounts a Node build and the step runner into
the container, read-only, and runs the steps with that Node. In most setups it
also clones your repository outside the image and copies the tree in.

So the image does **not** need Node, and does **not** need npm.

### What the image must provide

Every container job needs these two:

| Requirement                                                                                                                | Why                                                   | When it is checked    |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------- |
| **A GNU C library (glibc)** — the loader at `/lib64/ld-linux-x86-64.so.2` on x64, or `/lib/ld-linux-aarch64.so.1` on arm64 | The Node build KiCI mounts in is linked against glibc | Before the job starts |
| **A shell at `/bin/sh`**                                                                                                   | Steps run shell commands                              | Before the job starts |

If the image fails either, the job fails immediately and the error names the
reason — you do not wait for a build to reach its first step.

Two more apply only when your pool runs your image **as the agent**. See
[Which pool runs your image how](#which-pool-runs-your-image-how) to find out
which case you are in:

| Requirement          | Why                                                                       | When it is checked |
| -------------------- | ------------------------------------------------------------------------- | ------------------ |
| **`git` on `PATH`**  | The agent clones your repository, and here the agent is inside your image | At agent startup   |
| **`bash` on `PATH`** | The agent needs it to run steps                                           | At agent startup   |

These two are not checked ahead of time. The agent fails to start, and the job
waits for an agent that never arrives.

Most build images provide all four. `python`, `golang`, `node` and `rust` ship
git and bash; their `-slim` variants often drop git — `python:3.12-slim` is one
that does.

### Alpine and other musl images

Alpine uses musl instead of glibc, so KiCI refuses it:

```
image 'alpine:3.20' uses musl libc; the musl runtime variant is not enabled
(glibc images only in this version). Use a glibc image — for example the
'-slim' rather than the '-alpine' tag.
```

Pick the glibc build of the same image. `python:3.12-slim` instead of
`python:3.12-alpine`, `node:24-slim` instead of `node:24-alpine`.

### Which pool runs your image how

A pool runs your image one of two ways, and they ask for different things.

- **The agent stays outside your image** and starts a second container from it.
  The agent clones and copies the tree in, so your image needs only glibc and a
  shell. A bare-metal pool works this way, and so does any agent that has its
  own container runtime.
- **The agent runs inside your image.** A container pool does this for a job
  that names its own image: your image becomes the agent. Your image then needs
  git and bash as well.

The second form fails at agent startup with:

```
Agent required-tools validation failed:
  - 'git' not found on PATH — required for repository checkout
This agent runs inside the job's own container image, so that image must provide
these tools. Either add them to the image, or run the job on a pool whose agent
stays outside it.
```

If your image lacks git or bash, either add them, or run the job on a pool of
the first kind.

## Build the image from a Dockerfile

Point `container` at a Dockerfile in your repository instead of naming an image.
KiCI builds it before the job starts, and runs the job in the result:

```typescript
job('build', {
  runsOn: ['kici:os:linux'],
  container: {
    dockerfile: '.kici/ci.Dockerfile',
    context: '.', // default: the repository root
    target: 'ci', // optional build stage
    args: { NODE_VERSION: '24' },
  },
  steps: [compile],
});
```

Set `image` or `dockerfile`, never both. KiCI rejects a workflow that sets both,
or neither, when you define it.

The build runs on the agent that runs the job, after it clones your repository.
So the build context is the tree at the commit that triggered the run, and your
Dockerfile's `COPY` sees exactly that code. `.dockerignore` applies as usual.

### What is reused between runs

The image is built every run. Your container runtime's layer cache does the
work, exactly as it does on your own machine: a run that changes nothing below a
`COPY` reuses those layers and finishes in seconds.

Nothing is uploaded. The image lives on the agent host that built it, and KiCI
removes the tag after the job. A different host, or a host whose cache was
pruned, builds again.

### Build arguments are not secrets

A build argument is recorded in the built image's history, so anyone who can
read the image can read the value. `args` therefore takes plain strings only —
you cannot point one at a secret. Pass a secret to a step instead.

### Who may build

A Dockerfile build runs your `RUN` commands on the agent host, **outside** the
sandbox that contains your job's steps. So KiCI refuses one on an untrusted
ref — a fork pull request, or a contributor whose access it cannot confirm.

Your operator allows it per organization:

```bash
kici-admin org-settings allow-untrusted-dockerfile-builds true --org <org>
```

A trusted ref — a push to your default branch, or a pull request from a
contributor with write access — builds without that setting.

A schedule fire and the [auto-scaler's](workflows/autoscaling-workflows.md)
`kici.scaler.scale-up` / `kici.scaler.scale-down` events are trusted refs. No run
causes them. So a cron-fired Dockerfile job builds, and so does one in a
provisioning or teardown workflow.

Every other internal trigger runs at the
[trust tier](events.md#trust-tiers-on-internal-triggers) of the run that caused
it. A workflow triggered by `ctx.emit()` carries the emitting run's tier. A
workflow triggered by a run completing carries that run's tier. So a completion
or an emit from an untrusted ref cannot build a Dockerfile.

### Requirements

The agent host needs `docker` or `podman` on its `PATH`, not only a container
runtime socket. Agents report this themselves, and KiCI routes a Dockerfile job
only to one that can build — so a pool without a CLI is skipped rather than
failing your job partway. The built image itself needs only what
[any container job's image needs](#what-the-image-must-provide): a glibc and
`/bin/sh`. It never needs git or bash, because a built image is always run by an
agent that stays outside it.

## Private images

Point `auth` at secrets that hold the registry credentials. Every value is the
**name** of a secret, in `<context>:<secret-name>` form — the same form
`gitCredentials` uses:

```typescript
job('build', {
  runsOn: ['kici:os:linux'],
  container: {
    image: 'reg.internal:5000/acme/ci:1.2',
    auth: { usernameSecret: 'prod:REGISTRY_USER', tokenSecret: 'prod:REGISTRY_TOKEN' },
  },
  steps: [compile],
});
```

Store the secrets first with `kici-admin secret set`. Pasting a token straight
into the workflow is rejected when the workflow is defined, because a token
written into `.kici/` would be committed to your repository.

The username is not a secret, so you may write it directly:

```typescript
auth: { username: 'ci-bot', tokenSecret: 'prod:REGISTRY_TOKEN' }
```

Your orchestrator resolves these names at dispatch and sends only the resolved
credentials to the agent. The agent never reads your secret store.

### Credentials that only exist at run time

A token fetched during the run — from a cloud registry's login command, for
example — has no secret to name. Use the `*Value` half of the pair instead:

```typescript
auth: { username: 'AWS', tokenValue: fetchedAtRuntime }
```

## Where container jobs run

A container job needs a container runtime on the host that runs it. KiCI does
not check that for you: your orchestrator cannot see what a given agent host
has installed.

The host also needs a copy of the KiCI runtime to mount in. Every pool your
auto-scaler provisions gets one automatically, from the agent image the pool is
configured with. An agent you start by hand needs `KICI_RUNTIME_IMAGE` set to a
`kici-agent` image — see
[Agent configuration](../operator/agent/configuration.md). Without it, the job
runs on the image's own `node`, so the image must ship one.

If some of your pools have a runtime and some do not, label them and say so on
the job:

```typescript
job('build', {
  runsOn: ['kici:os:linux', 'kici:runtime:docker'],
  container: 'python:3.12-slim',
  steps: [compile],
});
```

A job that reaches a host with no runtime fails with an error naming what is
missing, rather than running incorrectly.

## Limits worth knowing

- **glibc only.** A musl image fails the preflight. Support for musl is a
  planned follow-up.
- **The image is pulled fresh when it is not already on the host.** A large
  image costs that pull on the first job that uses it.
- **`git` inside your steps still needs git in the image.** KiCI clones for you,
  but a step that runs `git` itself uses the image's own copy.
