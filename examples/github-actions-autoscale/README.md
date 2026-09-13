# GitHub Actions as a burst pool

Turn your GitHub Actions minutes into elastic CI capacity for KiCI. A `type: event`
scaler emits `kici.scaler.scale-up`; a provisioning workflow you write dispatches
`kici-agent.yml` here; the run boots a one-shot agent that runs a single job and exits.

## Files

| File                                               | Goes where                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| [`kici-agent.yml`](./kici-agent.yml)               | `.github/workflows/` of the repo whose Actions minutes you want to use  |
| [`provision.workflow.ts`](./provision.workflow.ts) | `.kici/workflows/` — dispatches a runner run on `kici.scaler.scale-up`  |
| [`teardown.workflow.ts`](./teardown.workflow.ts)   | `.kici/workflows/` — cancels a stranded run on `kici.scaler.scale-down` |
| [`scalers.yaml`](./scalers.yaml)                   | The orchestrator host — the file `KICI_SCALER_CONFIG_PATH` points at    |

## Wiring it up

1. Copy `kici-agent.yml` into the runner repo's `.github/workflows/`.
2. Declare a `type: event` scaler in the orchestrator's `scalers.yaml` — see
   `scalers.yaml` here — whose `provisioningTargets` name the repo holding your
   provisioning workflow.
3. Copy `provision.workflow.ts` and `teardown.workflow.ts` into your
   `.kici/workflows/`. Give the `github-actions` context a secret with
   `actions: write` on the runner repo.

### Pointing the workflows at your runner repo

Both workflows read `GITHUB_RUNNER_REPO` from the `github-actions` context — the
same context that holds the `GITHUB_DISPATCH_TOKEN` secret. The provisioning
workflow reads one more:

| Variable                      | Meaning                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_RUNNER_REPO`          | `owner/repo` of the repo holding `kici-agent.yml`                                                                                     |
| `GITHUB_AGENT_BUNDLE_RELEASE` | Optional, provisioning only. A release tag holding a `kici-admin agent package` tarball to install instead of the published npm agent |

```bash
kici-admin variable set <orgId> github-actions GITHUB_RUNNER_REPO --value myorg/ci-runners
```

The token stays a secret — variables are plaintext at rest, so never put a
credential in one.

The full walkthrough, including the provisioning and teardown workflows, is in
[Autoscaling workflows](https://kici.dev/docs/user/workflows/autoscaling-workflows/).

## The token never travels

GitHub logs `workflow_dispatch` inputs. So the dispatch carries only a **claim code** —
single-use, short-lived, and worthless once redeemed. The agent exchanges it for its own
short-lived token over the WebSocket it has to open anyway. Never put an agent token in a
dispatch input.

## Installing the agent

By default the run installs the published agent from npm. Set `agent_bundle_release` to a
release tag in the runner repo holding a `kici-admin agent package` tarball
(`kici-agent-linux-x64.tar.gz` plus its `.sha256`) to pin an exact build instead, or to
serve runners that cannot reach npm. The bundle vendors its own Node, so that path skips
the Node setup entirely.
