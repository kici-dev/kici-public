---
title: Troubleshooting
description: Operator diagnostics for common KiCI failure modes
---

Operator-facing diagnostics for runtime failures that aren't already covered by the monitoring or observability guides.

## Investigating a failed run

When a run ends in `failed`, work outward from the highest-signal surface to the lowest.

### 1. Read the run's failure reason and per-job error

A failed run carries a top-level `failureReason` and each job carries an `errorMessage`. The fastest way to see them:

- **Dashboard → run detail.** The run header shows a red banner with the `failureReason`; the job tree marks the failed job, and selecting it shows its logs. This is the recommended starting point.
- **`kici-admin runs show <runId>`.** Prints the run header (including `failureReason`), the jobs table, and per-job steps. `kici-admin runs list --status failed` finds recent failures; `kici-admin runs jobs <runId>` lists jobs with their `errorMessage`.

`kici runs show <runId>` is the workflow author's quick check — it shows the run status and the jobs-and-steps tree (including each step's exit code). `kici runs logs <runId>` replays the step logs.

### 2. Read the step logs

For failures that happen **inside** a step (a command exited non-zero, a script threw), the step's own log output is the answer:

- Dashboard → run detail → select the failed job/step → **Logs** tab (live for running steps, historical for completed ones).
- `kici runs logs <runId> --job <name>` from the CLI.

### 3. Low-level provisioning / agent-init failures

A distinct failure class happens **before** any step runs — the orchestrator dispatched the job but the agent never came up. Examples: the bare-metal scaler can't find the `node` binary it was told to launch (`spawn node ENOENT`), a container image fails to pull or start, or a Firecracker microVM fails to boot.

This is the dividing line for log-gathering: a failure **after** the agent connects shows up in the step logs (covered in step 2 above), so collect the agent's logs. A failure **before** the agent connects produces no step logs — the agent never ran — so the signal lives in the provisioning surfaces described here.

The scaler captures the underlying error (including a bounded tail of the agent process's stdout/stderr) and surfaces it everywhere a run failure shows up:

- The **dashboard run detail** shows it in the **Provisioning logs** section (collapsible, in the Logs view) and as a **Provisioning failed** entry in the **Provisioning** milestones of the **Timeline** tab.
- When the job ultimately fails because no agent ever registered (the dispatch queue times out), the captured error becomes the run's `failureReason` and the failed job's `errorMessage` instead of a generic "No agents available to dispatch jobs". It shows in the dashboard failure banner, `kici-admin runs show <runId>`, and `kici runs show <runId>`.
- The job may be marked `timed_out_stale` if no agent ever registered a heartbeat (see [Stale run detection](./stale-detection.md)).

If a run failed at provisioning (no agent ever came up), run `kici-admin diagnose` and check the `scaler:<name>` rows — a **fail** there confirms the backend could not spawn an agent for a queued job, and the row message carries the captured provisioning error.

So for a suspected provisioning failure:

1. Read the `failureReason` / job `errorMessage` from any of the surfaces in section 1 — the captured scaler error names the root cause directly (missing binary, unpullable image, boot failure).
2. For deeper detail than the captured tail, read the orchestrator logs for the dispatch window. The captured tail is bounded; the full agent-process output and the scaler's launch sequence live in the orchestrator's own structured logs. On a self-hosted orchestrator with file logging, that is `${KICI_LOG_DIR}/orchestrator-*.log`; grep for the scaler backend and the run/job id, and look for the scaler launch attempt and any spawn / container / boot error around that timestamp.
3. Cross-check the scaler config against the host: for a bare-metal scaler, verify the configured `binaryPath` exists and is executable as the orchestrator's user; for a container scaler, verify the image reference is pullable; for Firecracker, verify the kernel/rootfs paths. See [Auto-scaler common configuration](./orchestrator/auto-scaler/common-config.md) and the per-backend pages ([container](./orchestrator/auto-scaler/container.md), [bare-metal](./orchestrator/auto-scaler/bare-metal.md), [Firecracker](./orchestrator/auto-scaler/firecracker.md)).

If you operate the orchestrator under systemd or a container runtime without a `KICI_LOG_DIR` file sink, read its stdout/stderr the way you read any other service (`journalctl`, `podman logs`, your aggregator). Capturing a `kici-admin debug-bundle` (see below) also bundles the recent log window for sharing.

### Capturing a diagnostics bundle

`kici-admin debug-bundle` generates a ZIP with redacted config, system info, cluster health, metrics, and a window of recent logs — the single artifact to attach when escalating a failure you can't resolve from the surfaces above. `kici-admin inspect-bundle <path>` reads one back offline.

### Init failures — runs that never started

A run can fail before any step executes. The dashboard surfaces these as a
banner above the logs panel and the metadata panel's failure summary carries
the same message.

Categories you may see:

- **Secret context resolution failed** — the workflow's secret contexts couldn't be resolved.
- **Install-secrets resolution rejected** — the .npmrc / install-secrets resolution rejected the dispatch.
- **Lock-file / dependency resolution failed** — a lock file was present for the repository but could not be parsed or validated, so the orchestrator records the delivery as a failed run instead of silently skipping it. This covers corrupt JSON, a missing schema version, malformed routing labels, and a **schema-version mismatch**: a lock compiled by a different engine version than the one your orchestrator runs is rejected with a clear "recompile with `kici compile`" message rather than dispatched. The orchestrator and the lock move together (no backward compatibility across schema versions), so the fix is always to recompile the lock against your current toolchain and push again — never to force the old lock through. A repository with no lock file at all is not an error and produces no run.
- **Build coordination failed** — the build job dispatch was rejected or the build coordinator timed out.
- **Rejected by environment protection rules** — a protection rule (review / wait timer / branch restriction) rejected the job.
- **Dynamic / deferred-init evaluation failed** — a dynamic or deferred-init job dispatch failed.
- **No agent available to run this job** — no agent matching the job's `runs-on` labels was reachable.
- **Matrix expansion failed** — a job's dynamic matrix function threw or timed out while resolving its matrix values, so that job is marked failed before any of its steps run.

For run-scoped failures (the whole run never started), the dashboard offers
four entry points: in-dashboard tabs (Timeline, Summary, metadata),
`kici runs show <runId>`, `kici-admin` (`diagnose`, `runs show`, `debug-bundle`),
and this troubleshooting page.

### Log content is served by the orchestrator

If the dashboard shows "Log content is served by the orchestrator, which is
currently offline" above an otherwise-empty panel, the run-detail page is
working from Platform's cached metadata — start the orchestrator (or wait
for its WebSocket to reconnect) to retrieve step output.

## SDK bundle drift (`Lock file is out of date`)

### Symptom

Every workflow an agent picks up fails with:

```
Lock file is out of date: workflow source changed without regenerating kici.lock.json
(expected contentHash <X>, got <Y>, agent baked @kici-dev/sdk@<V> bundleHash=<Z>).
Run 'kici compile' and commit the updated lock file.
```

The `agent baked ...` suffix identifies the `@kici-dev/sdk` version + bundle hash that was compiled into the agent at build time.

### Root cause

The agent and the host that produced `kici.lock.json` compiled the same workflow source against **different builds of `@kici-dev/sdk`**, so their computed `contentHash` values disagree even though the `.ts` source is identical. This is protocol-level drift: the bundle format didn't change, but the bytes did.

This happens when the host that wrote the lock file and the agent image were built against **different `@kici-dev/sdk` bundles** — for example, the lock file was generated against one published `@kici-dev/sdk` version while the agent image was rebuilt from a different one. Any time those two SDK bundle hashes disagree, every workflow fails with the message above.

### Diagnostic (3-way hash compare)

Three signals tell you which side drifted:

**1. The agent's baked SDK hash** — from the startup log or `/health`:

```bash
# From the agent log files:
grep '"agent.build.info"' ${KICI_LOG_DIR}/agent-*.log | tail -1 | jq .

# Or over HTTP on a running agent:
curl -s http://<agent-host>:<agent-port>/health | jq '.sdkBundleHash, .sdkVersion'
```

**2. The orchestrator's baked SDK hash** — same shape:

```bash
grep '"orchestrator.build.info"' ${KICI_LOG_DIR}/orchestrator-*.log | tail -1 | jq .

curl -s http://<orch-host>:<orch-port>/health | jq '.sdkBundleHash, .sdkVersion'
```

**3. The host SDK hash** — the `@kici-dev/sdk` the host compiled against when it wrote the lock file. Compute the bundle hash of that SDK:

```bash
# If the host compile used a published SDK from a registry:
curl -s <registry-url>/@kici-dev/sdk/-/sdk-<version>.tgz | \
  tar -xzOf - package/dist/index.js | sha256sum

# If the host compile used the workspace source directly:
sha256sum <repo-root>/packages/sdk/dist/index.js
```

The enriched drift error prints the agent's `sdkBundleHash` directly. Compare that value against the orchestrator's (from its log / `/health`) and against whatever SDK the lock file was generated against. The odd one out is the side that drifted.

### Resolution

- **Agent image stale:** rebuild the agent image against the current workspace: `podman build -f packages/agent/Dockerfile .` (or the relevant multi-arch target).
- **Lock file stale:** run `kici compile` against the workflow repo and commit the updated `kici.lock.json`.
- **SDK publish lagging behind:** republish `@kici-dev/sdk` so the host and agent compile against the same bundle.

### Why the existing `--frozen-lockfile` check is not enough

`packages/agent/Dockerfile` already does `COPY pnpm-lock.yaml` + `pnpm install --frozen-lockfile`. That guarantees **image/lockfile parity** — the agent image can't ship a different `@kici-dev/sdk` than the lockfile declares. It does **not** cover the case described above, where the host **workflow-author** compile sees one SDK and the agent compile sees a different SDK even though both came from the same repo. The only guard that catches that class is the runtime bundle-hash echo this page documents.

### Extending the diagnostic

All three services (agent, orchestrator, Platform) mirror the same six fields:

| Field              | Meaning                                                    |
| ------------------ | ---------------------------------------------------------- |
| `sdkVersion`       | `package.json#version` of `@kici-dev/sdk` at build time    |
| `sdkBundleHash`    | sha256 of `packages/sdk/dist/index.js` at build time       |
| `sharedVersion`    | `package.json#version` of `@kici-dev/shared` at build time |
| `sharedBundleHash` | sha256 of `packages/shared/dist/index.js` at build time    |
| `engineVersion`    | `package.json#version` of `@kici-dev/engine` at build time |
| `engineBundleHash` | sha256 of `packages/engine/dist/index.js` at build time    |

An `unknown` value means the peer's `dist/index.js` didn't exist when the service was bundled (self-build, or a broken workspace build order) — investigate before trusting the service.
