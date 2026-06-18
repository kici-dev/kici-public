---
title: Test run architecture
description: Architecture deep-dive on the test run pipeline
---

This document describes the end-to-end data flow for remote test runs triggered by `kici test`, including the upload encryption scheme, overlay application, observer streaming, and how test runs integrate with the existing production pipeline.

## High-level data flow

```
Developer workstation            Orchestrator              Agent
       |                              |                      |
  1. kici test push-main              |                      |
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
       |<---- { runId,                |                      |
       |        observeUrl } -------- |                      |
       |                              |                      |
  8. WS /observe/:runId  ------------>|                      |
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
       |<---- observe.log ------------|<---- log.chunk ------|
       |<---- observe.step -----------|<---- step.status ----|
       |<---- observe.complete -------|<---- job.status -----|
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

## Observer WebSocket channel

The CLI connects to a read-only observer WebSocket endpoint to receive real-time updates during execution.

### Connection flow

1. CLI receives `observeUrl` from the test trigger response
2. CLI opens WebSocket to `/api/v1/observe/:runId`
3. CLI authenticates with its API key token
4. Orchestrator streams events as they occur

### Observer message types

| Message             | Direction           | Content                                                   |
| ------------------- | ------------------- | --------------------------------------------------------- |
| `observe.subscribe` | CLI -> Orchestrator | Run ID, auth token, optional `lastSeenTimestamp`          |
| `observe.status`    | Orchestrator -> CLI | Run/job status updates (queued, running, success, failed) |
| `observe.log`       | Orchestrator -> CLI | Log lines from step execution (job-prefixed)              |
| `observe.step`      | Orchestrator -> CLI | Step start/complete events                                |
| `observe.complete`  | Orchestrator -> CLI | Final run result with job summary table                   |

### Reconnection and backfill

If the CLI's WebSocket disconnects (network blip, laptop sleep):

1. CLI reconnects to the same observer endpoint
2. CLI sends `observe.subscribe` with `lastSeenTimestamp` of the last received message
3. Orchestrator replays missed log chunks and status updates from persistent storage
4. Live streaming resumes from the current point

Multiple CLI clients can observe the same run simultaneously.

## Test runs vs production runs

Test runs share most of the production pipeline but differ in key ways:

| Aspect              | Production run               | Test run                                    |
| ------------------- | ---------------------------- | ------------------------------------------- |
| Trigger source      | GitHub webhook               | `POST /api/v1/test/trigger`                 |
| Event normalization | Provider-specific normalizer | Synthetic event from fixture                |
| Trigger matching    | Lock file triggers           | Same pipeline (or bypass with `--workflow`) |
| Repo state          | Exact commit from webhook    | Clone + overlay of local changes            |
| Secret access       | All contexts                 | Only `allowLocalExecution: true` contexts   |
| Tracking            | `execution_runs` table       | Same table with `is_test_run = true`        |
| Delivery ID         | Provider-assigned            | `test:` prefix + UUID                       |
| Observer streaming  | Not available                | WS observer channel                         |
| `ctx.isTestRun`     | `false`                      | `true`                                      |

### Pipeline reuse

Test runs inject into the existing webhook processing pipeline. The `processTestTrigger()` function:

1. Constructs a synthetic `WebhookInfo` from the fixture's event
2. Skips webhook signature verification (CLI authentication replaces it)
3. Skips provider normalization (event is already in normalized form)
4. Feeds into the same lock file fetch -> trigger match -> dispatch pipeline
5. Marks the execution as `isTestRun` for observer broadcasting and secret gating

This means test runs exercise the same trigger matching, cache resolution, job dispatch, and step execution as production -- maximizing confidence that what works in test will work in production.

### Dispatch parity

A test-run `job.dispatch` carries the same execution-shaping fields as a production dispatch, all derived from the fixture's simulated event: the normalized event envelope (`{ type, action, targetBranch, sourceBranch, changedFiles, payload, … }`), the resolved job `env`, the resolved environment name, and that environment's variables. Dynamic functions evaluate against this envelope exactly as they do in production. A **pure inline** `environment` expression is evaluated at the orchestrator and the resolved name is gated through `allowLocalExecution` like a static string, so its environment-scoped secrets and variables participate in the run. Impure dynamic environments require an init job, which test runs do not dispatch; supply such a job's secrets via a fixture `secrets:` mapping instead.

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
