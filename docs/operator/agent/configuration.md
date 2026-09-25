---
title: 'Agent: configuration reference'
description: Environment variables, labels, container executor setup
---

> **See also:** [Environment variable reference](../env-reference.md) — shared env vars; agent-specific vars are listed below. Regenerate the generated table with `pnpm docs:env`. Unknown `KICI_*` env vars cause the agent to refuse to start (typo catcher); set `KICI_DEV=true` for warn-only behaviour during local development.

All agent configuration is provided via environment variables.

## Environment variables

These environment variables are specific to the agent. Variables shared across
KiCI services (log level, OpenTelemetry endpoint, heartbeat/concurrency timeouts)
and the rotated-file logger live in the [environment variable reference](../env-reference.md).

<!-- BEGIN GENERATED: agent-env (do not edit; run the doc generator) -->

| Env var                                    | Required | Default    | Type                                    | Aliases | Description |
| ------------------------------------------ | -------- | ---------- | --------------------------------------- | ------- | ----------- |
| `KICI_AGENT_BETWEEN_JOBS_RESET_COMMAND`    | no       |            | string                                  |         |             |
| `KICI_AGENT_BETWEEN_JOBS_RESET_RUN_ON`     | no       | "always"   | enum:always\|on-failure                 |         |             |
| `KICI_AGENT_BETWEEN_JOBS_RESET_TIMEOUT_MS` | no       | 60000      | number                                  |         |             |
| `KICI_AGENT_COMMAND`                       | no       |            | string                                  |         |             |
| `KICI_AGENT_DRAIN_ON_RESET_FAILURE`        | no       | "false"    | string                                  |         |             |
| `KICI_AGENT_ID`                            | no       |            | string                                  |         |             |
| `KICI_AGENT_IS_ORCHESTRATOR_HOST`          | no       |            | string                                  |         |             |
| `KICI_AGENT_ORPHAN_CLEANUP`                | no       | "true"     | string                                  |         |             |
| `KICI_AGENT_PAYLOAD_DIR`                   | no       |            | string                                  |         |             |
| `KICI_AGENT_TOKEN`                         | no       |            | string                                  |         |             |
| `KICI_ALLOW_INSTALL_SCRIPTS`               | no       | "false"    | string                                  |         |             |
| `KICI_BACKPRESSURE_MODE`                   | no       | "pause"    | enum:pause\|drop                        |         |             |
| `KICI_CONTAINER_BUILD_CLI`                 | no       |            | enum:docker\|podman                     |         |             |
| `KICI_DEFAULT_STEP_TIMEOUT_MS`             | no       | 1800000    | number                                  |         |             |
| `KICI_DOCKER_KEEP_FAILED`                  | no       | "false"    | string                                  |         |             |
| `KICI_EXECUTION_MODE`                      | no       |            | enum:container\|bare-metal\|firecracker |         |             |
| `KICI_GITHUB_TOKEN`                        | no       |            | string                                  |         |             |
| `KICI_HOST_INSTALL_REGISTRIES`             | no       |            | string                                  |         |             |
| `KICI_IN_PLACE`                            | no       | "false"    | string                                  |         |             |
| `KICI_JOB_IMAGE_AGENT`                     | no       |            | string                                  |         |             |
| `KICI_LABELS`                              | no       |            | string                                  |         |             |
| `KICI_MAX_LOG_SIZE_BYTES`                  | no       | 10485760   | number                                  |         |             |
| `KICI_ORCHESTRATOR_URL`                    | yes      |            | string                                  |         |             |
| `KICI_PORT`                                | no       | 8080       | number                                  |         |             |
| `KICI_PROPERTIES`                          | no       |            | string                                  |         |             |
| `KICI_ROLES`                               | no       |            | string                                  |         |             |
| `KICI_RUNNER_DEBUG_STDIO`                  | no       | "false"    | string                                  |         |             |
| `KICI_RUNNER_USER`                         | no       |            | string                                  |         |             |
| `KICI_RUNTIME_IMAGE`                       | no       |            | string                                  |         |             |
| `KICI_RUNTIME_NODE_SOURCE`                 | no       |            | string                                  |         |             |
| `KICI_SANDBOX`                             | no       | "false"    | string                                  |         |             |
| `KICI_SANDBOX_HARDENED`                    | no       | "true"     | string                                  |         |             |
| `KICI_SANDBOX_MEMORY_BYTES`                | no       | 2147483648 | number                                  |         |             |
| `KICI_SANDBOX_NANO_CPUS`                   | no       | 2000000000 | number                                  |         |             |
| `KICI_SANDBOX_NETWORK`                     | no       | "isolated" | enum:isolated\|host                     |         |             |
| `KICI_SANDBOX_NETWORK_ISOLATION`           | no       | "true"     | string                                  |         |             |
| `KICI_SANDBOX_PIDS_LIMIT`                  | no       | 512        | number                                  |         |             |
| `KICI_SANDBOX_READONLY_ROOTFS`             | no       | "false"    | string                                  |         |             |
| `KICI_SANDBOX_USER`                        | no       |            | string                                  |         |             |
| `KICI_SCALER_CLAIM_CODE`                   | no       |            | string                                  |         |             |
| `KICI_SCALER_IDLE_TIMEOUT`                 | no       | 5000       | number                                  |         |             |
| `KICI_SCALER_MANAGED`                      | no       |            | string                                  |         |             |
| `KICI_SCALER_PENDING_DISPATCH_TIMEOUT`     | no       | 60000      | number                                  |         |             |
| `KICI_TRUSTED_ENV`                         | no       | "false"    | string                                  |         |             |

<!-- END GENERATED: agent-env -->

## Health and metrics endpoints

The agent exposes three HTTP endpoints on the configured `KICI_PORT`:

| Endpoint   | Purpose            | Response                                                                                                                                                                                                                                          |
| ---------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/health`  | Liveness probe     | Always `200`. Body includes `agentId`, `activeJobs`, `connected` status, and the build identity (`version`, `buildCommit`, plus the SDK / shared / engine versions and bundle hashes) so operators can correlate deployed builds across services. |
| `/ready`   | Readiness probe    | `200` when connected to orchestrator, `503` when disconnected.                                                                                                                                                                                    |
| `/metrics` | Prometheus metrics | Prometheus text format with `kici_agent_` prefixed metrics.                                                                                                                                                                                       |

## Label-based routing

Labels allow the orchestrator to route jobs to specific agents. When a workflow specifies `runsOn: 'linux'`, the orchestrator dispatches the job only to agents that have the `linux` label.

```bash
# Agent with Linux and Docker capabilities
KICI_LABELS=linux,docker

# Agent with GPU support
KICI_LABELS=linux,gpu,cuda

# Agent with macOS for Apple-specific builds
KICI_LABELS=macos,arm64
```

Multiple agents can share labels. The orchestrator selects from available agents with matching labels.

## Agent roles

Roles control which types of special jobs an agent can handle. The two built-in roles are `builder` (dependency cache build jobs) and `init-runner` (dynamic init jobs). Roles manifest as reserved `kici:role:*` auto-labels used internally for routing.

```bash
# Accept all roles (default when KICI_ROLES is unset)
# Equivalent to KICI_ROLES=all
unset KICI_ROLES

# Only handle builder jobs (no init-runner)
KICI_ROLES=builder

# Both roles explicitly
KICI_ROLES=builder,init-runner

# Execution only — no special role jobs, only regular workflow jobs
KICI_ROLES=
```

The `kici:*` label prefix is reserved for internal use. User-provided labels in `KICI_LABELS` must not use this prefix.

## Concurrency

Each agent executes one job at a time. When a job is already running, the agent rejects additional dispatches, and the orchestrator routes them to another available agent or queues them.

## Execution profiles

Two agent-launch profiles change how a dispatched job is prepared. Both are set **only** by the operator at agent (or scaler) launch — neither is derivable from a dispatch payload or from workflow code, so a Platform-connected agent can never be pushed onto them.

| Variable           | Default | Effect                                                                                                                                                                                                                                                              |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KICI_TRUSTED_ENV` | `false` | Trusted fleet-agent profile: step sandboxes receive the ambient host environment (minus the agent's own KiCI identity and operational secrets) instead of the system-variable allowlist. See [Agent security](../security/agent-security.md).                       |
| `KICI_IN_PLACE`    | `false` | In-place no-clone profile: when the dispatched source is a `file://` local source, the agent uses that source's real repository path as the job work directory and skips the git clone. Any other source is unaffected and still clones into a throwaway directory. |

`KICI_IN_PLACE` exists for running an operator's own already-built working tree directly — module-relative paths, installed dependencies, and build output are all present because nothing is copied. See [Local development plane](../orchestrator/local-dev-plane.md).

## Between-jobs lifecycle (reused agents)

A reused agent serves many jobs in turn on a shared host (the bare-metal / in-place profiles). After every job it runs a supervisor-owned cleanup phase, so one job's leftovers never reach the next. The phase runs four stages in order. First it re-runs declared cleanup out-of-band, when the job process was hard-killed before its completion hooks ran. Then it reaps the finished job's process tree, deletes the work directory, and runs the optional operator reset command. Each stage is isolated, so an earlier failure never skips the reset — leaving host state un-reset is the residue the phase exists to prevent. The phase also runs on an ephemeral agent, which is discarded after one job, so there is no next job for it to protect.

| Variable                                   | Default   | Effect                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KICI_AGENT_ORPHAN_CLEANUP`                | `true`    | Reap a finished job's leaked process tree. The agent runs each job in its own process group and signals the whole group when the job ends, so a backgrounded daemon cannot survive into the next job. Set `false` to signal only the runner and leave a backgrounded process alive on purpose. |
| `KICI_AGENT_BETWEEN_JOBS_RESET_COMMAND`    | _(unset)_ | A host-reset command run between jobs (for example, pruning a container cache). Unset disables it. It runs after the reap and work-directory deletion. Fail-open: a failure never fails the finished job and never crashes the agent.                                                          |
| `KICI_AGENT_BETWEEN_JOBS_RESET_TIMEOUT_MS` | `60000`   | Timeout for the reset command.                                                                                                                                                                                                                                                                 |
| `KICI_AGENT_BETWEEN_JOBS_RESET_RUN_ON`     | `always`  | When the reset command runs: `always`, or `on-failure` to run it only after a failed job.                                                                                                                                                                                                      |
| `KICI_AGENT_DRAIN_ON_RESET_FAILURE`        | `false`   | When `true`, the agent stops accepting new jobs after repeated consecutive reset failures, so a persistently dirty host stops taking work.                                                                                                                                                     |

Set a reset command when jobs on a shared host leave state the reap and work-directory deletion do not cover — a container image cache, a package cache, or a scratch mount. The `orphanCleanup` reap and the out-of-band cleanup re-run apply to the bare-metal / in-place profiles; the reset command runs for any backend but is meaningful only where jobs share a host. This phase is the primary cross-job cleanup; the agent's startup temp-directory sweep stays as a backstop.

## Co-located orchestrator guard

Set `KICI_AGENT_IS_ORCHESTRATOR_HOST=true` when the agent shares a host with the orchestrator. A workflow's `restartHost()` step is then refused locally (`refusing to reboot the orchestrator host`), so a fleet-wide reboot workflow cannot take the control plane down with it. Defaults to `false`; the orchestrator refuses the same request independently.

## Bring-up payload source

An ops agent holding the `kici:capability:ssh-transport` capability stages a self-contained agent plus vendored Node runtime onto a fresh box during [init-runner bring-up](../orchestrator/host-roster.md#payload-delivery). By default that payload comes from the orchestrator's own object storage. Two variables, read only by the agent performing the bring-up, override that:

| Variable                 | Effect                                                                                                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KICI_AGENT_PAYLOAD_DIR` | Local directory holding version-keyed payloads (`<dir>/<version>/kici-agent-<platform>.tar.gz`) as produced by `kici-admin agent package`. When set, the payload is read from disk instead of pulled from object storage — the air-gapped path. |
| `KICI_AGENT_COMMAND`     | Golden-image escape hatch: a fixed command that starts the init-runner on a target that already ships `kici-agent` and a Node runtime at a known path. When set, payload staging is skipped entirely.                                           |

## Container job requirements

For workflows that specify `container` in their job configuration, the agent executes the job inside a disposable Docker or Podman container.

Requirements:

- A container runtime (Docker or Podman) must be installed and accessible on the agent host
- `KICI_RUNTIME_IMAGE` set to a `kici-agent` image, so the job's image needs neither Node nor git (see [The injected runtime](#the-injected-runtime) below)
- When the agent itself runs in a container, the runtime socket must be mounted into it:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

Podman exposes its socket at a different path (`/run/podman/podman.sock` rootful, or `/run/user/<uid>/podman/podman.sock` rootless). Mount that path instead and point `DOCKER_HOST` at it; the agent talks to whichever socket that variable resolves to, falling back to `/var/run/docker.sock`.

The agent:

1. Creates a job container from the specified image (already-present images are used as-is; a missing image is pulled on demand first) with `/workspace` as a container-owned volume
2. Clones the repository on the host and, when the conditions below hold, installs its `.kici/` dependencies there. It then copies the tree into the container's `/workspace` volume — so the job's image needs no git, and clone credentials never enter it
3. Starts the workflow runner inside the container via a single exec — every step, and any dependency install the host did not do, runs inside the container
4. Removes the container (and its workspace volume) after job completion

### Where `.kici/` dependencies install

The agent installs a container job's `.kici/` dependencies on its own host,
into the checkout, when all of these are true:

- `KICI_ALLOW_INSTALL_SCRIPTS` is unset or `false`. When it is `true`, a
  container job's install and its lifecycle scripts run inside the job
  container.
- A runtime is injected (`KICI_RUNTIME_IMAGE` or `KICI_RUNTIME_NODE_SOURCE`). The
  runner then runs on the KiCI runtime, and the image preflight admits glibc
  images only. The job container shares the host's CPU architecture, so modules
  installed on the host load inside it.
- The dispatch carries no cached dependency tarball.
- `.kici/` is a plain npm or pnpm project. The agent refuses the host install,
  and the job container installs instead, when any of these holds:
  - The project uses yarn, or carries `yarn.lock`, `.yarnrc`, `.yarnrc.yml` or
    `.pnp.cjs` in `.kici/` or at the repository root.
  - `.kici/` sits in a workspace: a `pnpm-workspace.yaml` or a `workspaces`
    field in `.kici/` or at the repository root.
  - pnpm hooks are declared: a `.pnpmfile.cjs`, `.pnpmfile.mjs` or
    `.pnpmfile.js`, or a `pnpmfile`, `global-pnpmfile`, `config-dependencies`
    or `hooks` key in an `.npmrc`, in `.kici/` or at the repository root.
  - `.kici/package.json` has a `pnpm` field key other than `overrides`,
    `onlyBuiltDependencies`, `neverBuiltDependencies`,
    `ignoredBuiltDependencies`, `allowedDeprecatedVersions`,
    `peerDependencyRules`, `packageExtensions` or `auditConfig`.
  - A dependency or an override in `.kici/package.json`, or an entry in its
    lockfile, is not a registry package: a git, file, link, `workspace:`,
    tarball or URL source. The `overrides`, `resolutions` and `pnpm.overrides`
    fields are checked like the dependency fields. In `package-lock.json`, a
    `version` must be a version, a range, a dist-tag or an `npm:` alias. npm
    installs an entry with no `resolved` URL from what its `version` names,
    such as `http:127.0.0.1:8080/x.tgz` or a directory on the agent host.
  - A registry the job's `registries:` resolved, or a `registry` or
    `@scope:registry` in `.kici/.npmrc`, is on an origin outside the
    [registries the host install may contact](#registries-the-host-install-may-contact).
  - A lockfile tarball URL is not a package tarball on one of those registries.
    This covers `resolved` in `package-lock.json` and `resolution.tarball` in
    `pnpm-lock.yaml`.
  - A registry-auth value in `.kici/.npmrc` or `~/.npmrc` references a variable
    that npm, pnpm or Node reads, as `${NAME}`. Examples are the proxy
    variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `PROXY`, in any case),
    names that start with `NODE_`, `NPM_`, `PNPM_`, `SSL_`, `OPENSSL_` or
    `LD_`, names that contain `DEBUG`, and config roots such as `HOME`, `PATH`
    and `PREFIX`. Two names are exempt, in upper case only: `NPM_TOKEN` and
    `NODE_AUTH_TOKEN`. No tool reads them, so `${NPM_TOKEN}` and
    `${NPM_TOKEN?}` keep the install on the host.
  - An `.npmrc` in `.kici/` or at the repository root holds a control
    character other than LF or TAB. A CR is one, so a file with CRLF line
    endings is refused.
  - A registry the job's `registries:` resolved has whitespace or a control
    character in its URL or scope.
  - `.kici`, its `package.json`, its lockfile or its `.npmrc` is a symlink, or
    so is the repository root's `package.json` or `.npmrc`. The manifest or
    the lockfile does not parse.
- The agent has its own package manager for the project: the npm bundled with
  the Node that runs the agent, version 11.10.0 or later, or pnpm `11.3.0` in
  the agent's corepack cache (`COREPACK_HOME`, else `~/.cache/node/corepack`).
  The agent never runs a corepack shim, and never follows the project's
  `packageManager` field. The agent image sets `COREPACK_HOME=/opt/corepack`
  and bakes pnpm `11.3.0` there, owned by root, so the agent user cannot
  change the pnpm the host install runs.
- The npm bundled with the Node that runs the agent is present, for a pnpm
  project too. The agent reads every `.npmrc` with that npm's parser.
- With an npm older than 11.15.0, `.kici/` has a `package-lock.json` or
  `npm-shrinkwrap.json` of lockfile version 2 or 3 that pins every package.
  That npm has no `--allow-remote`, `--allow-file` or `--allow-directory`, so
  the host install runs `npm ci`. `npm ci` resolves a dependency the lockfile
  leaves open before it refuses the lockfile, and that can fetch a URL. So the
  agent reads the lockfile with that npm's own reader. It refuses the lockfile
  when a dependency of the project or of a locked package is missing or does
  not satisfy its range. It also refuses a locked package that ships its own
  `npm-shrinkwrap.json`. A missing optional peer dependency is allowed.
  Every locked package must also have a semver version and a `resolved`
  tarball URL on one of the
  [registries the host install may contact](#registries-the-host-install-may-contact).
  A package bundled in its parent's tarball has no `resolved` URL of its own,
  so it needs only the version. A lockfile written with
  `omit-lockfile-registry-resolved` records no `resolved` URLs, so the job
  container installs it.

The host install never runs in the checkout. The agent copies
`.kici/package.json` and its lockfile into a fresh staging directory and writes
the only `.npmrc` the install reads. The agent parses `.kici/.npmrc` and the
agent user's `~/.npmrc` with the `ini` parser of the npm it runs. npm and pnpm
read `.npmrc` files with the same parser. The agent then writes a new file from
the kept key-value pairs, and copies no line of either file. The file holds only
these keys:

- From `.kici/.npmrc` and from the agent user's `~/.npmrc`: `registry`,
  `@scope:registry`, `always-auth`, and the per-registry `_authToken`, `_auth`,
  `username`, `_password` and `always-auth`.
- From the agent user's `~/.npmrc` only: `strict-ssl`, `ca`, `cafile`, `proxy`,
  `https-proxy`, `noproxy` and `no-proxy`.
- The registries and tokens the orchestrator resolved for the job, written last.

Every other key is dropped, including `node-options`, `git` and `script-shell`.
A key inside a `[section]` is dropped, and so is a value that holds a control
character. When `.kici/.npmrc` and `~/.npmrc` set the same key, the
`.kici/.npmrc` value applies. An install secret reaches the install only when a
kept registry-auth value (`_authToken`, `_auth`, `username` or `_password`)
references it as `${NAME}`. The install runs with the agent's
install environment, not the job's `env`, `contextVars` or `jobEnv`. It keeps only `PATH`, locale, timezone and
temp variables from the agent, and points `HOME` into the staging directory.
`NODE_OPTIONS`, `npm_config_*` and `pnpm_config_*` never pass.

npm 11.15.0 and later runs `npm install` with `--ignore-scripts
--allow-git=none --allow-remote=none --allow-file=none --allow-directory=none`.
An older npm runs `npm ci --ignore-scripts --allow-git=none`, which installs
only what the lockfile pins. pnpm runs
with `--ignore-scripts --ignore-pnpmfile --ignore-workspace --pm-on-fail=ignore`
and with the `runtime-on-fail=ignore`, `block-exotic-subdeps=true` and
`enable-global-virtual-store=false` settings. Cancelling the job kills the
install, and the agent then creates no job container.

In every other case the runner installs inside the job container, and the
registry must be reachable from the job network. A failed host install fails the
job with the installer's error, with registry tokens and install secrets masked.
The agent never retries the install inside the container.

All of this applies to a container job's own `.kici/` install. Other jobs
install `.kici/` on the agent host with the project's own package manager,
run in the checkout. Lifecycle scripts stay off unless
`KICI_ALLOW_INSTALL_SCRIPTS=true`, but pnpm hooks, a yarn plugin or an `.npmrc`
setting from the repository still take effect. An agent with the `builder`
role runs the `__build__` job this way. An agent with the `init-runner` role
runs the `__init__`, `__dynamic__` and `__globaleval__` jobs this way, and
those jobs also import the workflow module in a child process on the agent
host. An agent with `KICI_ROLES` unset holds both roles. To keep that work off
the hosts that run container jobs, set `KICI_ROLES=` on those agents, and run
dedicated agents with `KICI_ROLES=builder,init-runner`. See
[Agent roles](#agent-roles).

#### Registries the host install may contact

The host install runs on the agent host, outside the job network and its egress
filter (`KICI_SANDBOX_NETWORK_ISOLATION`). So it contacts only the registries
the operator chose:

- the public npm registry, `https://registry.npmjs.org/`;
- a `registry` or `@scope:registry` in the agent user's `~/.npmrc`;
- the origins listed in `KICI_HOST_INSTALL_REGISTRIES`.

`KICI_HOST_INSTALL_REGISTRIES` takes comma-separated origins, for example
`http://verdaccio.local:4873,https://npm.example.internal`. Each entry is a
scheme, a host and an optional port, with no path. The agent compares origins
exactly after it normalizes them: the host is lower-cased and a default port is
dropped. It never compares the addresses a name resolves to. An entry that is
not an http or https origin stops the agent at startup. The error names the
entry with its credentials, query and fragment removed. The agent reads this
setting from its own environment only, never from a dispatch or a workflow.

A registry that the workflow names does not widen this set. The job's
`registries:` block and `.kici/.npmrc` come from the repository, so a repository
could otherwise point the host install at the agent's loopback, its LAN or a
cloud metadata address. When one of them is on another origin, the job container
installs instead, and the job's registry tokens never reach the host install.
The install sends the token for an allowed registry only to that registry's
host.

A private registry outside this set is reached from the job container, so the
job network must reach it. `KICI_SANDBOX_NETWORK=host` runs the job container on
the host network, and `KICI_SANDBOX_NETWORK_ISOLATION=false` turns the egress
filter off. See [Agent security](../security/agent-security.md) for what each
one gives up.

Job containers are hardened by default: all Linux capabilities dropped, no-new-privileges, cgroup PID/memory/CPU caps, and a private tmpfs `/tmp`, tunable via the `KICI_SANDBOX_*` variables above. See [Agent security](../security/agent-security.md) for the full isolation model and the per-job `sandbox:` escape hatch.

Set `KICI_DOCKER_KEEP_FAILED=true` to preserve failed containers for debugging. The container name follows the pattern `kici-sandbox-{jobId}-{timestamp}`.

### What a job image must provide

| Requirement                                                                         | Applies to                                                                | Checked                                          |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| glibc (`/lib64/ld-linux-x86-64.so.2` on x64, `/lib/ld-linux-aarch64.so.1` on arm64) | every container job                                                       | image preflight, before the container is created |
| `/bin/sh`                                                                           | every container job                                                       | image preflight, before the container is created |
| `git` on `PATH`                                                                     | only an image that runs the agent itself (a scaler's per-job-image spawn) | agent startup                                    |
| `bash` on `PATH`                                                                    | only an image that runs the agent itself                                  | agent startup                                    |

Node and npm are never required — both come from the injected runtime. The
preflight runs only when a runtime is injected; without one the image supplies
its own Node and the glibc requirement does not apply. The two startup checks
are not preflighted: the agent exits and the job waits for an agent that never
registers, so the message names the image as the thing that must supply them.

See [Container jobs](../../user/container-jobs.md) for the same table from the
workflow author's side.

### Building the job image from a Dockerfile

A job may point `container` at a Dockerfile in the repository instead of naming
an image. The agent clones, builds, and runs the job in the result.

That needs `docker` or `podman` on the agent host's **`PATH`** — a runtime
socket alone is not enough, because KiCI shells out to the CLI rather than
driving the build over the API. One build path means one set of Dockerfile
semantics: `.dockerignore` and BuildKit behave as they do on the author's own
machine, instead of depending on which agent picked the job up. A host without a
CLI fails the job with a message naming what to install.

The agent reports what it found at registration, as self-reported labels
alongside `kici:os:*` and `kici:arch:*`:

| Label                          | Meaning                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `kici:runtime:docker`          | a docker socket is present — the agent can run a job container                              |
| `kici:runtime:podman`          | a podman socket is present                                                                  |
| `kici:runtime:container-build` | a build CLI is on `PATH` — the agent can build a job image                                  |
| `kici:runtime:job-image`       | the agent runs inside one job's own image (`KICI_JOB_IMAGE_AGENT=1`) and takes no other job |

The socket labels report that the socket file exists, not that a daemon answered on it. Registration must not block on a runtime that is slow or wedged. So the label answers the routing question — is there a runtime on this host at all — and a job that reaches a broken daemon fails with that daemon's own error.

The agent starts a job container on `DOCKER_HOST` when it is set, and on nothing else: a `DOCKER_HOST` socket that does not exist means no runtime, and neither socket label is reported. A `DOCKER_HOST` that names a remote daemon (`tcp://…`) reports `kici:runtime:docker`. With no `DOCKER_HOST`, the agent uses the first of `/var/run/docker.sock`, the rootful podman socket and the rootless podman socket that exists, so a host that runs only Podman starts job containers on Podman. A container job on a host with none fails before the clone, with a message naming the missing runtime and the agent's labels.

The orchestrator routes a container job to an agent only when the auto-scaler started that agent for the job, or the agent reports `kici:runtime:docker` or `kici:runtime:podman`. An agent from a release before 0.10.0 does not report a remote `DOCKER_HOST` as a runtime. So the orchestrator does not hold a missing label against it, and a container job that reaches such an agent without a runtime fails there instead. An agent that reports `kici:runtime:job-image` takes no job but the one it was started for.

The last one is separate on purpose: an agent given only a mounted runtime
socket can **run** a container but not **build** one, because the build shells
out to the CLI. The orchestrator routes a Dockerfile job only to an agent that
reports `kici:runtime:container-build`, so a pool without a CLI is skipped at
routing time rather than failing the job at build time.

You may also name any of these in a job's `runsOn` to steer work yourself.

`KICI_CONTAINER_BUILD_CLI` (`docker` | `podman`) picks which. Unset, the agent
prefers `docker` and falls back to `podman`. Set it explicitly on a host that has
both CLIs but whose container runtime is the other one. The build and the job
container must land on the same daemon; otherwise the sandbox starts on a daemon
that has never seen the image.

The built image is tagged `kici-build:<jobName>-<jobId>`, labelled
`kici-managed=true`, and removed when the job finishes. The layer cache is what
makes the next build fast, and it is not a tag, so it survives.

The build runs on the host, outside the job container's hardened posture. The
orchestrator refuses one on an untrusted ref unless the organization opted in
(`kici-admin org-settings allow-untrusted-dockerfile-builds`).

### The injected runtime

A job may name any image, and that image is not required to ship Node. The agent
mounts its own Node build into the job container, read-only at `/opt/kici/node`,
and starts the workflow runner with it.

`KICI_RUNTIME_IMAGE` names where that build comes from: a `kici-agent` image,
which carries it at `/opt/kici`. The agent copies the build out of the image
into a named volume the first time it is needed on that host, then reuses the
volume. Point it at the image whose version matches this agent.

An agent an auto-scaler spawns gets this set for you, from the image the pool is
configured with. Set it yourself on an agent you start by hand.

Two consequences of leaving it unset:

- A `container` job runs on the image's own `node`. That works for an image
  that ships one, and fails for one that does not. The job then fails at once
  with a message that names the image and these two settings.
- The image preflight does not run, so a musl image such as `alpine` is not
  refused up front.

`KICI_RUNTIME_NODE_SOURCE` is the alternative for a host that provisions the
build out of band: a directory whose `bin/node` is the runtime, or the name of
a volume holding it. It takes precedence over `KICI_RUNTIME_IMAGE`, and nothing
is copied.

## Authentication

### Orchestrator connection (agent token)

The agent authenticates with the orchestrator using a pre-shared key (PSK) token. When the orchestrator has `KICI_AGENT_AUTH=token` (the default), the agent must provide a valid token via the `KICI_AGENT_TOKEN` environment variable.

**Obtaining a token:**

```bash
# On the orchestrator host (or via the admin CLI)
kici-admin agent register --labels linux,x64
# Save the displayed token -- it cannot be recovered
```

**Configuring the agent:**

```bash
KICI_AGENT_TOKEN=kat_<64 hex chars>
```

**Authentication flow:**

1. Agent connects to the orchestrator's WebSocket endpoint
2. Agent sends `auth.request` with the token before registration
3. Orchestrator validates the token against its SHA-256 hash database
4. On success, orchestrator responds with `auth.success` and the agent proceeds to send `agent.register`
5. On failure, the orchestrator responds with `auth.failure` and closes the connection

**Auth failure behavior:** If authentication fails, the agent logs an error and **permanently stops reconnection**. A bad token cannot self-heal, so retrying wastes resources. Fix the token and restart the agent.

**Scaler-managed agents:** Agents spawned by the orchestrator's auto-scaler receive automatically generated ephemeral tokens. No manual token configuration is needed for scaler-managed agents.

**Unauthenticated mode:** When the orchestrator is configured with `KICI_AGENT_AUTH=none`, agents connect without tokens. The `KICI_AGENT_TOKEN` variable is ignored. This is a single-machine affordance: the orchestrator refuses to start unless its listener is machine-local (`KICI_HOST=127.0.0.1`), because a listener other hosts can reach hands anyone who opens a WebSocket to the port a registered agent. Only an agent on the same machine can connect.

### GitHub token

Set `KICI_GITHUB_TOKEN` for cloning private repositories. The token is passed via git's `http.extraHeader` configuration (not embedded in the URL) to prevent exposure in logs.

If the orchestrator provides a short-lived installation token in the job dispatch, it takes precedence over the agent-local token.

## Graceful shutdown signals

| Signal    | Behavior                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| `SIGTERM` | Start graceful shutdown. Wait up to 10s for running jobs to complete, then force-kill child processes and exit.      |
| `SIGINT`  | Same as SIGTERM.                                                                                                     |
| `SIGUSR1` | Enter drain mode. Stop accepting new jobs. Once all active jobs complete, exit cleanly. Use for rolling deployments. |

### Drain mode for zero-downtime deployments

1. Send `SIGUSR1` to the running agent
2. Agent stops accepting new job dispatches
3. Currently running jobs continue to completion
4. Once all jobs finish, agent exits with code 0
5. Start the new agent version

```bash
# In a deployment script
kill -USR1 $(pidof node)
# Wait for exit, then start new version
```

## Reconnection behavior

If the WebSocket connection to the orchestrator drops, the agent automatically reconnects with exponential backoff:

- Initial delay: 1 second
- Multiplier: 1.5x per attempt
- Jitter: 0-50% randomness
- Maximum delay: 60 seconds

Messages generated during disconnection are buffered and flushed on reconnection: up to 10,000 log lines and up to 5,000 other events (job status, heartbeats). This preserves job status and log data even during brief network interruptions.

## Example configurations

### Minimal

```bash
KICI_ORCHESTRATOR_URL=ws://localhost:4000/ws
```

### Production

```bash
KICI_ORCHESTRATOR_URL=ws://orchestrator.internal:4000/ws
KICI_AGENT_ID=agent-prod-01
KICI_LABELS=linux,docker,x86_64
KICI_PORT=8080
KICI_LOG_LEVEL=info
KICI_GITHUB_TOKEN=ghp_xxxx
KICI_MAX_LOG_SIZE_BYTES=10485760
KICI_DEFAULT_STEP_TIMEOUT_MS=3600000
```

## See also

- [Agent Getting Started](getting-started.md) -- deployment guide with Docker and Kubernetes
- [Orchestrator Configuration](../orchestrator/configuration.md) -- environment variables for the orchestrator agents connect to
- [Job Execution Lifecycle](../../architecture/execution/job-execution.md) -- how the agent uses these configuration values during execution
- [Protocol Messages](../../architecture/protocol-messages.md) -- agent-to-orchestrator message schemas
