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
       |<---- { runId } ------------- |                      |
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
       |                              |                11. Clone repo
       |                              |                      |
       |                              |                12. Download tarball
       |                              |                      |
       |                              |                13. Decrypt (ECDH)
       |                              |                      |
       |                              |                14. Verify checksums
       |                              |                      |
       |                              |                15. Apply overlay
       |                              |                      |
       |                              |                16. Execute steps
       |                              |                      |
       | GET /test/runs/:id/logs ---->|<---- log.chunk ------|
       | GET /test/runs/:id --------->|<---- step.status ----|
       |   (polled to completion)     |<---- job.status -----|
       |                              |                      |
  17. Show summary + exit code        |                      |
```

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

The agent applies the developer's local changes on top of a fresh git clone. This produces the exact same file state as the developer's working tree.

### Application flow

1. Agent clones repo at the SHA specified in the fixture
2. Agent downloads encrypted tarball from the URL provided in the job dispatch
3. Agent derives shared secret using orchestrator's private key + CLI's public key
4. Agent decrypts tarball using AES-256-GCM
5. Agent extracts tar.gz to a temporary directory
6. Agent reads `manifest.json` from `.kici-overlay-tmp/` in the extracted files
7. Agent verifies SHA256 checksums of every extracted file against the manifest
8. Agent copies files from the extracted overlay to the clone directory
9. Agent deletes files listed in the manifest's `deletions` array
10. Agent cleans up temporary files

### Tarball structure

```
overlay.tar.gz
  .kici-overlay-tmp/
    manifest.json       # Checksums, deletions, HEAD SHA
  src/
    modified-file.ts    # Changed files at their repo-relative paths
    new-file.ts
  tests/
    added-test.ts
```

### Manifest format

```json
{
  "sha": "abc123def456...",
  "deletions": ["src/removed-file.ts", "docs/old-guide.md"],
  "checksums": {
    "src/modified-file.ts": "sha256-hex-hash",
    "src/new-file.ts": "sha256-hex-hash",
    "tests/added-test.ts": "sha256-hex-hash"
  }
}
```

- **sha**: The HEAD commit SHA the overlay is based on. The agent clones this exact commit.
- **deletions**: Files the developer deleted locally. The agent removes these from the clone.
- **checksums**: SHA256 hashes of each included file. The agent verifies these after extraction to detect corruption.

## Following a test run

The CLI follows a test run by **polling**, over the same HTTP surface it used to trigger it — there is no streaming socket between the CLI and the orchestrator.

### Poll loop

1. The trigger response returns the `runId`.
2. The CLI polls two endpoints in lockstep on a fixed interval: `GET /api/v1/orgs/:customerId/test/runs/:runId/logs?cursor=<n>` for the next log chunk, and `GET /api/v1/orgs/:customerId/test/runs/:runId` for the status snapshot.
3. Each log response carries a `nextCursor`; the CLI advances a **monotonic line-offset cursor** so a chunk is never re-printed and never skipped.
4. The run is finished only when the status is terminal **and** the log stream has drained (`logs.done`). A terminal status alone is not enough — the tail of the log can still be arriving.

Because the cursor lives in the CLI and every request is an ordinary authenticated HTTP call, a network blip needs no reconnection protocol: the next poll resumes from the same cursor. `Ctrl-C` cancels the run through the same client rather than just detaching.

Two grace behaviors keep the loop honest against a run the control plane has not observed yet: a `404` before the first successful read is retried until a visibility grace period elapses, and approval holds surfaced by a non-terminal tick are reported once each rather than on every poll.

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
| Repo state          | Exact commit from webhook        | Clone + overlay of local changes                    |
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
4. Builds a dispatch context per matched workflow — a synthetic `WebhookInfo`, the test provenance fields, and a CLI-secret overlay that wins over orchestrator env secrets — and calls the shared core.
5. Marks the execution as `isTestRun` for the orchestrator-side observer broadcast and secret gating.

Because the test adapter calls the same core, a `kici run` exercises the full dispatch behavior — needs-DAG scheduling, `runsOnAll` host fan-out, matrix and fan-out edge wiring, and deferred init/dynamic job dispatch — exactly as a webhook does. A multi-job `needs` workflow run via `kici run` honors the dependency DAG (a downstream job dispatches only after its upstream reaches a matching state), and a `runsOnAll` job fans out to one pinned execution per matching roster host.

### Dispatch parity

A test-run `job.dispatch` carries the same execution-shaping fields as a production dispatch, all derived from the fixture's simulated event: the normalized event envelope (`{ type, action, targetBranch, sourceBranch, changedFiles, payload, … }`), the resolved job `env`, the resolved environment name, and that environment's variables. Dynamic functions evaluate against this envelope exactly as they do in production. A **pure inline** `environment` expression is evaluated at the orchestrator and its resolved name is subject to the bound-environment test-run gate below. Because the test adapter routes through the shared core, an **impure dynamic** field (a `__init__` job) and a dynamic job generator (`__dynamic__`) both dispatch for a test run too, and a fixture `secrets:` mapping supplies additional namespaced secret contexts.

#### Two intentional environment gates

A test run applies **two different** `allowLocalExecution` gates, deliberately, because the two declarations mean different things:

- **A bound `job.context` is allow-and-warn.** A test run never rejects on a bound environment. If a statically-named environment is a non-test environment (`allowLocalExecution: false`) or is not configured, it is **skipped** — its variables, secrets, and protection rules do not participate — and the run proceeds. A user-visible warning names the skipped environment(s), surfaced both on the `kici run remote` CLI output and on the dashboard run view. This keeps a job that deploys to a production environment in real runs still locally testable for its non-secret logic, while the `allowLocalExecution: false` boundary that keeps production secrets out of local runs is preserved (the secrets do not flow).
- **A fixture `secrets:` mapping is fail-closed.** Mapping a secret context to an environment is an explicit request for that environment's secrets. If the named environment is missing or `allowLocalExecution: false`, the run is **rejected** at trigger time with `Fixture secret context '<ctx>' maps to environment '<env>' which does not allow test runs`.

## Upload storage

Test tarballs are stored in the same S3-compatible object storage as dependency caches:

| Setting     | Value                                                 |
| ----------- | ----------------------------------------------------- |
| Bucket      | Same as `KICI_STORAGE_BUCKET`                         |
| Prefix      | `test-uploads/`                                       |
| Path format | `test-uploads/{routing-key}/{sha}/{timestamp}.tar.gz` |
| Retention   | 24 hours (S3 lifecycle rule on prefix)                |
| Encryption  | Client-side ECDH + AES-256-GCM (described above)      |

No additional bucket configuration is required -- operators only need to ensure the `test-uploads/` prefix has a 24-hour lifecycle rule.

## See also

- [Data Flows](../data-flows.md) -- production webhook and job execution flows
- [Protocol Messages](../protocol-messages.md) -- full protocol schema reference
- [Secrets Management](../security/secrets.md) -- configuring the `allowLocalExecution` flag
