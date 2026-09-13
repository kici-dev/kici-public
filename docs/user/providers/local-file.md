---
title: Local filesystem (file://) source
description: Register a git repo present on the agent filesystem as a file:// source, triggered by the kici-admin CLI or a push hook
---

The **local** provider lets the orchestrator run workflows from a git
repository that already lives on the agent's filesystem — cloned via a
`file://` URL rather than fetched from a remote forge. There is no webhook
from GitHub or GitLab; the operator drives runs explicitly with the
`kici-admin` CLI or a generated `post-receive` hook.

> **This is an operator-curated source, not daily developer CI.** Use it for
> globally-registered or policy workflows the operator controls — a vendored
> repo baked into an agent image, a repo synced onto a host out-of-band, a
> golden internal pipeline. For ordinary per-developer CI driven by pull
> requests and pushes, use the [GitHub App provider](./github.md) or the
> [universal-git provider](./universal-git.md) against a real forge.

## Trust caveat (read first)

A local source uses signature verification `none` — there is no remote forge
to sign the webhook payload, so the orchestrator cannot authenticate the
trigger. **Only register repos you trust.** Anyone who can reach the
orchestrator's webhook route for this source, or push to the repo on disk,
can drive a run. Treat the repo path as a trusted operator input, the same
way you treat the orchestrator's own configuration.

## Register a source

```bash
kici-admin source add local \
  --org <orgId> \
  --path /abs/path/to/repo \
  --name my-local-repo
```

- `--path` must be an **absolute** directory on the agent filesystem. It is
  the base path the orchestrator's lock-file fetcher reads
  (`<path>/.kici/kici.lock.json`) and the base for the `file://` clone the
  agent performs.
- `--clone-url-base <url>` is optional. By default the agent clones via
  `file://<path>`. Supply a `git://` or `http://` base when the agent does
  **not** share the orchestrator's filesystem and must fetch the repo over a
  git server instead (see "Per-scaler reachability" below).

Update the path or name later:

```bash
kici-admin source update-local <id> --path /new/abs/path
kici-admin source update-local <id> --name new-name
```

Remove it:

```bash
kici-admin source remove <routingKey> --local
```

List and inspect (local sources render their `repoBasePath`):

```bash
kici-admin source list --org <orgId>
kici-admin source get <id>
```

## Trigger runs

A local repo has no forge to send webhooks, so you trigger runs yourself.

**One-shot, by hand:**

```bash
kici-admin source trigger-local <id>
```

The command reads the repo's current HEAD ref and commit SHA, builds a
GitHub-shaped `push` payload, and POSTs it to the orchestrator's generic
webhook route. Override the ref/sha/event explicitly when needed:

```bash
kici-admin source trigger-local <id> --event push --ref refs/heads/main --sha <sha>
```

**On every push, via a hook:**

```bash
kici-admin source install-hook <id>
```

This writes a `post-receive` hook into the repo so that every push to it
triggers a run automatically — the local equivalent of a forge webhook.

## Per-scaler reachability (operator's responsibility)

The orchestrator accepts a local source on **any** scaler backend and does
**not** verify that the repo is actually reachable inside the agent. Making
the path reachable is the operator's job. On a container or Firecracker
scaler the orchestrator logs a reachability warning when it registers the
source, but it does not reject it.

| Scaler      | How the repo must be reachable in the agent                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bare-metal  | The agent runs on the host, so the `--path` host directory is used directly.                                                                                                                                   |
| container   | Bake the repo into the agent image, or bind-mount it at the **same absolute path** the source was registered with. Alternatively register `--clone-url-base` pointing at a git server the container can reach. |
| Firecracker | The repo must be present on the microVM rootfs at the registered path, or reachable via a `--clone-url-base` git server.                                                                                       |

If the path is not reachable inside the agent, the clone fails at run time —
the run is created and then fails, rather than being silently dropped.

## See also

- [Universal-git provider](./universal-git.md) — for a remote forge (or any
  `http://` git server) when there is no shared filesystem.
- [GitHub App provider](./github.md) — the flagship source for pull-request
  CI with Checks.
