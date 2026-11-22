---
title: Test run architecture
description: Architecture deep-dive on the test run pipeline
---

This document describes the end-to-end data flow for remote test runs triggered by `kici run remote`, including the upload encryption scheme, overlay application, log following, and how test runs integrate with the existing production pipeline.

## High-level data flow

```
Developer workstation            Orchestrator              Agent
       |                              |                      |
  1. kici run remote push-main        |                      |
       |                              |                      |
  2. Compile fixture                  |                      |
       |                              |                      |
  3. POST /uploads/init  ------------>|                      |
       |<---- { signedUrl,            |                      |
       |        uploadId,             |                      |
       |        publicKey } --------- |                      |
       |                              |                      |
  4. Create overlay tarball           |                      |
       |                              |                      |
  5. Encrypt tarball (ECDH)           |                      |
       |                              |                      |
  6. PUT signed URL (S3) -----> [Object Storage]             |
       |                              |                      |
  7. POST /test/trigger  ------------>|                      |
       |<---- { runs[] } ------------ |                      |
       |                              |                      |
  8. Begin polling logs + status      |                      |
       |                              |                      |
       |                         9. Trigger match            |
       |                              |                      |
       |                        10. Dispatch -----> job.dispatch
       |                              |              (with tarballUrl,
       |                              |               cliPublicKey,
       |                              |               orchestratorPrivateKey)
       |                              |                      |
       |                              |                11. Download tarball
       |                              |                      |
       |                              |                12. Decrypt (ECDH)
       |                              |                      |
       |                              |                13. Verify checksums
       |                              |                      |
       |                              |                14. Extract overlay
       |                              |              (working tree + .git
       |                              |               into empty workspace,
       |                              |               no clone)
       |                              |                      |
       |                              |                15. Execute steps
       |                              |                      |
       | GET /test/runs/:id/logs ---->|<---- log.chunk ------|
       | GET /test/runs/:id --------->|<---- step.status ----|
       |   (polled to completion)     |<---- job.status -----|
       |                              |                      |
  16. Show summary + exit code        |                      |
```

### Request path

The diagram draws the CLI's control calls as if they go straight to the orchestrator. On the default path they reach it through the hosted KiCI Platform. The CLI calls the Platform's `/api/v1/orgs/:customerId/test/...` endpoints with the developer's personal access token. The Platform relays each call to the orchestrator over the orchestrator's WebSocket connection as a `test.relay.*` message: `test.relay.uploads.init`, `test.relay.trigger`, `test.relay.run.status`, `test.relay.run.logs`, or `test.relay.cancel`. So the orchestrator does not have to be reachable from the developer's network. Each relayed request carries the developer's identity, which the orchestrator writes to its `access_log`.

In direct mode (`kici connect`, `--orchestrator-url`, or `KICI_ORCHESTRATOR_TOKEN`) the calls do go straight to the orchestrator: the CLI calls its `/api/v1/test/*` routes (`whoami`, `uploads/init`, `trigger`, `runs/:runId`, `runs/:runId/logs`, `runs/:runId/cancel`) with an orchestrator admin token. The routes run the same handlers as the relay, with the same payloads. The orchestrator authenticates the token itself, attributes the run to the token's service account, and chooses the org and routing key.

The overlay tarball does not go through either control path. The CLI uploads it straight to object storage through the presigned URL that the upload-init call returns. The orchestrator signs it with `KICI_STORAGE_UPLOAD_ENDPOINT`, falling back to `KICI_STORAGE_EXTERNAL_ENDPOINT`, then `KICI_STORAGE_ENDPOINT`. Once the upload step ends, whether it succeeded or failed, the CLI deletes the local tarball and its temporary directory. Before it builds a new tarball, the CLI also deletes overlay temporary directories older than a day. These are left by a run that was killed during its upload, or by an earlier CLI version.

## Upload encryption

Test run tarballs are encrypted using ephemeral X25519 ECDH key exchange with AES-256-GCM symmetric encryption. This ensures that uploaded content is protected in transit and at rest in object storage.

### Key exchange flow

```
    CLI                     Orchestrator                Agent
     |                           |                        |
     |  POST /uploads/init       |                        |
     |-------------------------->|                        |
     |                           |                        |
     |  Generate orchestrator    |                        |
     |  ephemeral X25519 keypair |                        |
     |                           |                        |
     |  { publicKey, uploadId }  |                        |
     |<--------------------------|                        |
     |                           |                        |
     |  Generate CLI             |                        |
     |  ephemeral X25519 keypair |                        |
     |                           |                        |
     |  ECDH shared secret:      |                        |
     |  cliPrivate + orchPublic  |                        |
     |       = AES-256 key       |                        |
     |                           |                        |
     |  Encrypt tarball          |                        |
     |  AES-256-GCM              |                        |
     |                           |                        |
     |  Upload encrypted +       |                        |
     |  send cliPublicKey        |                        |
     |-------------------------->|                        |
     |                           |                        |
     |                           |  Dispatch job with:    |
     |                           |  tarballUrl,           |
     |                           |  cliPublicKey,         |
     |                           |  orchestratorPrivateKey|
     |                           |----------------------->|
     |                           |                        |
     |                           |  ECDH shared secret:   |
     |                           |  orchPrivate + cliPub  |
     |                           |       = AES-256 key    |
     |                           |                        |
     |                           |  Decrypt tarball       |
     |                           |  AES-256-GCM           |
```

### Crypto details

| Component            | Algorithm                                       |
| -------------------- | ----------------------------------------------- |
| Key exchange         | X25519 (Curve25519 ECDH)                        |
| Key derivation       | HKDF-SHA256 with info `kici-upload-encryption`  |
| Symmetric encryption | AES-256-GCM                                     |
| Wire format          | `[12-byte IV][16-byte auth tag][ciphertext]`    |
| Key serialization    | DER format (SPKI for public, PKCS8 for private) |

The shared secret is derived via `crypto.diffieHellman()` and stretched through HKDF to produce a 32-byte AES key. Each upload uses fresh ephemeral keypairs -- keys are never reused.

### Security properties

- **Forward secrecy:** Ephemeral keypairs mean compromising stored ciphertext later is useless without the keys (which are deleted after use)
- **Integrity:** AES-256-GCM auth tag prevents tampering
- **No key reuse:** Every upload generates fresh keypairs on both sides
- **No plaintext in storage:** Object storage only ever holds encrypted data

## Overlay application

`kici run remote` sends a full-repo trigger: the overlay holds the developer's whole working tree and a `.git` that the CLI builds to match a fresh checkout of the repository. The agent clones nothing for such a run. It extracts the overlay into an empty workspace, which produces the same file state as the developer's working tree.

### What the CLI builds

- **Files:** every tracked file with its staged and unstaged changes, and every untracked file that `.gitignore` does not exclude, minus `.kiciignore` matches.
- **`.git`:** a new repository that the CLI fetches from the developer's repository over `file://`, at the depth and tag policy of the jobs that can run (or the `--git-depth` / `--git-tags` / `--no-git-tags` flags). Only objects reachable from the shipped refs within that depth arrive. The CLI generates `.git/config` with the developer's `origin` URL minus its credentials. Hooks, reflogs, stashes and other local state never ship.
- **Synthetic commit:** when the working tree differs from `HEAD`, the CLI writes one commit on top of `HEAD` that holds the changes, and the shipped repository checks it out. With `--no-commit`, the shipped repository checks out `HEAD` and the changes stay uncommitted.
- **Event:** the event's commit is the commit the workspace checks out. A push event's `before` is its parent, unless the fixture sets its own `sha`: such an event gets no `before`. The CLI also sends the changed files it computed from the local history, so the agent never fetches from a git host to compute them.

The developer's repository stays unchanged: the CLI writes no ref, index, object or reflog in it.

### Application flow

1. Agent downloads encrypted tarball from the URL provided in the job dispatch
2. Agent derives shared secret using orchestrator's private key + CLI's public key
3. Agent decrypts tarball using AES-256-GCM
4. Agent extracts tar.gz to a temporary directory
5. Agent reads `manifest.json` from `.kici-overlay-tmp/` in the extracted files
6. Agent verifies SHA256 checksums of every extracted file against the manifest
7. Agent deletes files listed in the manifest's `deletions` array, so a path that changed between a file, a link and a directory is cleared first
8. Agent copies files from the extracted overlay into the workspace. A job with `checkout: false` takes only the `.kici/` entries.
9. Agent recreates the symbolic links: each directory link from the manifest's `symlinks` map, then each file link whose text stays inside the repository
10. Agent compares the job's `checkoutOptions` with the manifest's `git` record and writes a warning to the job's setup log when the job asks for more history or tags than shipped
11. Agent cleans up temporary files

A test trigger that is not full-repo gets a clone at the run's commit first, and the overlay applies on top of it. The commit is the SHA the fixture event names (a push `after`, a pull request head, a status or workflow-run SHA). When the event names none, it is the commit the overlay was built from, and when there is no overlay, the event branch.

### Tarball structure

```
overlay.tar.gz
  .kici-overlay-tmp/
    manifest.json       # Checksums, deletions, symlinks, git record, HEAD SHA
  .git/                 # Checkout-style repository built by the CLI
  src/
    modified-file.ts    # Working-tree files at their repo-relative paths
    new-file.ts
  tests/
    added-test.ts
```

The CLI writes the manifest into the tarball from a temporary directory. It never writes into the working tree. `.kici-overlay-tmp/` is reserved: the CLI never uploads a file at that path in the repository, because it would collide with the manifest.

### Manifest format

```json
{
  "sha": "abc123def456...",
  "deletions": ["src/removed-file.ts", "docs/old-guide.md"],
  "checksums": {
    "src/modified-file.ts": "sha256-hex-hash",
    "src/new-file.ts": "sha256-hex-hash",
    "tests/added-test.ts": "sha256-hex-hash"
  },
  "symlinks": { "lib/shared": "../shared" },
  "git": { "fetchDepth": 1, "allTags": false }
}
```

- **sha**: The developer's `HEAD` commit SHA the overlay is based on.
- **deletions**: Files the developer deleted locally. The agent removes these from the workspace.
- **checksums**: SHA256 hashes of each included file, the `.git` files included. The agent verifies these after extraction to detect corruption.
- **symlinks**: Directory symlinks, as repo-relative path to link text. Absent when there is none.
- **git**: What the shipped `.git` holds: `fetchDepth` (`0` = full history) and `allTags`. Absent when no `.git` ships. The agent compares it with the job's checkout options.

## Following a test run

The CLI follows a test run by **polling**, over the same HTTP surface it used to trigger it — there is no streaming socket between the CLI and the orchestrator.

### Poll loop

1. The trigger response returns `runs`: one `{ runId, workflowName, jobIds }` per matched workflow, because each matched workflow runs as its own run. The CLI follows every run at once and passes only when every run passed. `Ctrl-C` cancels every run. The deprecated top-level `runId` names the first run, for a client that reads only it.
2. For each run, the CLI polls two endpoints in lockstep on a fixed interval: `GET /api/v1/orgs/:customerId/test/runs/:runId/logs?cursor=<n>&logCursor=<opaque>` for the next log chunk, and `GET /api/v1/orgs/:customerId/test/runs/:runId` for the status snapshot. Both address the cluster the trigger was relayed to.
3. Each log response carries `lineJobNames`, the job that wrote each line, so the CLI prints an error block per failed job with only that job's output. Each log response also carries `nextLogCursor`, an opaque cursor that records how many lines of each log file were delivered. The CLI sends it on the next poll, so a chunk is never re-printed and never skipped, even when a step's log file appears after a file that sorts later. The first poll sends an empty `logCursor`. When a response has no `nextLogCursor`, because the Platform or the orchestrator is older, the CLI uses the numeric line cursor `nextCursor`.
4. The run is finished only when the status is terminal **and** the log stream has drained (`logs.done`). A terminal status alone is not enough — the tail of the log can still be arriving.

Because the cursor lives in the CLI and every request is an ordinary authenticated HTTP call, a network blip needs no reconnection protocol: the CLI retries a failed read from the same cursor. The CLI retries a read with backoff when it gets a 5xx, 408 or 429 answer, gets no answer within 30 seconds, or loses its connection, also mid-body. It retries for up to 2 minutes of consecutive failures. After that it stops following the run and leaves it running. A 401, 403 or 404 fails at once, with one exception. `Ctrl-C` cancels the run through the same client rather than only detaching, and stops a read or a retry in progress.

The exception is the Platform's answer while the run's orchestrator is not connected. The Platform answers the run's status, log and cancel requests with `404`, the message `No orchestrator with that cluster name`, and `code: orchestrator_not_found`. The status and the message are the same for every client. Only the `code` field tells a reconnecting orchestrator apart from a missing run, so the CLI retries a `404` that carries it. A run triggered before the Platform recorded each run's cluster has no cluster to address. While no orchestrator is connected, its polls get `422 no_cluster`, which is final.

Two grace behaviors keep the loop honest against a run the control plane has not observed yet. The CLI retries a `404` before the first successful read until a visibility grace period elapses, and reports each approval hold a non-terminal tick surfaces once rather than on every poll.

### Orchestrator-side broadcast

Inside the orchestrator, a per-run observer registry buffers the run's `observe.log` / `observe.step` / `observe.status` / `observe.complete` messages with monotonic sequence numbers — up to 1000 messages per run, retained for five minutes after completion. The execution tracker and log writer publish into it only for runs marked as test runs. It is internal machinery: the buffer exists so a future subscriber can be backfilled from a sequence number, and nothing subscribes to it today.

## Test runs vs production runs

Test runs share most of the production pipeline but differ in key ways:

| Aspect              | Production run                   | Test run                                            |
| ------------------- | -------------------------------- | --------------------------------------------------- |
| Trigger source      | GitHub webhook                   | `POST /api/v1/orgs/:customerId/test/trigger`        |
| Event normalization | Provider-specific normalizer     | Synthetic event from fixture                        |
| Trigger matching    | Lock file triggers               | Same pipeline (or bypass with `--workflow`)         |
| Dispatch core       | Shared `dispatchMatchedWorkflow` | Same shared core (needs DAG, host fan-out, dynamic) |
| Repo state          | Exact commit from webhook        | Working tree + checkout-style `.git` from the CLI   |
| Secret access       | All contexts                     | Only `allowLocalExecution: true` contexts           |
| Tracking            | `execution_runs` table           | Same table with `is_test_run = true`                |
| Delivery ID         | Provider-assigned                | `test:` prefix + UUID                               |
| Log following       | Dashboard / `kici runs` only     | CLI polls logs + status to completion               |
| `ctx.isTestRun`     | `false`                          | `true`                                              |

### One dispatch core, two adapters

There is a single dispatch core (`dispatchMatchedWorkflow`) and two thin adapters that feed it: the webhook adapter (real provider event) and the test adapter (`processTestTrigger`, for `kici run`). The webhook-only preamble — delivery dedup, Platform relay, provider normalization, source registration — runs in the caller, not inside the core, so the test adapter reaches the same core without it.

The test adapter:

1. Resolves the lock file (inline for a local repo with no remote, or the same provider-driven fetch the webhook uses).
2. Selects matched workflow decisions (normal trigger matching, or a direct `--workflow` bypass).
3. Enforces the `allowLocalExecution` environment gate and stores the fixture payload.
4. Mints one run id per matched workflow, as the webhook adapter does, then builds a dispatch context per matched workflow — a synthetic `WebhookInfo`, the test provenance fields, and a CLI-secret overlay that wins over orchestrator env secrets — and calls the shared core. A run keys its needs edges, pending contexts, placeholders, holds and log paths by job name, so two workflows that define a job of the same name must not share one. A caller that does not send `acceptsMultipleRuns: true` (a `kici` older than 0.21.0) follows only one run: for it, the adapter runs the matched workflows as one shared run when no job name collides, and refuses the trigger when one can.
5. Marks the execution as `isTestRun` for the orchestrator-side observer broadcast and secret gating.

Because the test adapter calls the same core, a `kici run` exercises the full dispatch behavior — needs-DAG scheduling, `runsOnAll` host fan-out, matrix and fan-out edge wiring, and deferred init/dynamic job dispatch — exactly as a webhook does. A multi-job `needs` workflow run via `kici run` honors the dependency DAG (a downstream job dispatches only after its upstream reaches a matching state), and a `runsOnAll` job fans out to one pinned execution per matching roster host.

### Dispatch parity

A test-run `job.dispatch` carries the same execution-shaping fields as a production dispatch, all derived from the fixture's simulated event: the normalized event envelope (`{ type, action, targetBranch, sourceBranch, changedFiles, payload, … }`), the resolved job `env`, the resolved environment name, and that environment's variables. Dynamic functions evaluate against this envelope exactly as they do in production. A **pure inline** `environment` expression is evaluated at the orchestrator and its resolved name is subject to the bound-environment test-run gate below. Because the test adapter routes through the shared core, an **impure dynamic** field (a `__init__` job) and a dynamic job generator (`__dynamic__`) both dispatch for a test run too, and a fixture `secrets:` mapping supplies additional namespaced secret contexts.

#### Two intentional environment gates

A test run applies **two different** `allowLocalExecution` gates, deliberately, because the two declarations mean different things:

- **A bound `job.context` is allow-and-warn.** A test run never rejects on a bound environment. If a statically-named environment is a non-test environment (`allowLocalExecution: false`) or is not configured, it is **skipped** — its variables, secrets, and protection rules do not participate — and the run proceeds. A user-visible warning names the skipped environment(s), surfaced both on the `kici run remote` CLI output and on the dashboard run view. This keeps a job that deploys to a production environment in real runs still locally testable for its non-secret logic, while the `allowLocalExecution: false` boundary that keeps production secrets out of local runs is preserved (the secrets do not flow).
- **A fixture `secrets:` mapping is fail-closed.** Mapping a secret context to an environment is an explicit request for that environment's secrets. If the named environment is missing or `allowLocalExecution: false`, the run is **rejected** at trigger time with `Fixture secret context '<ctx>' maps to context '<env>' which does not allow test runs`.

## Upload storage

Test tarballs are stored in the same S3-compatible object storage as dependency caches:

| Setting     | Value                                                     |
| ----------- | --------------------------------------------------------- |
| Bucket      | Same as `KICI_STORAGE_BUCKET`                             |
| Prefix      | `test-uploads/`                                           |
| Path format | `test-uploads/{routing-key}/{sha}/{upload-id}.tar.gz.enc` |
| Retention   | 24 hours (S3 lifecycle rule on prefix)                    |
| Encryption  | Client-side ECDH + AES-256-GCM (described above)          |

No additional bucket configuration is required -- operators only need to ensure the `test-uploads/` prefix has a 24-hour lifecycle rule.

## See also

- [Data Flows](../data-flows.md) -- production webhook and job execution flows
- [Protocol Messages](../protocol-messages.md) -- full protocol schema reference
- [Secrets Management](../security/secrets.md) -- configuring the `allowLocalExecution` flag
