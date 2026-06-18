---
title: Peer credential management
description: Manage peer credentials for orchestrator cluster authentication
---

Orchestrator peers authenticate using persistent credentials issued during the initial join token exchange. This guide covers managing peer credentials: listing, revoking, and re-joining after revocation.

## How peer authentication works

1. **First join:** A new orchestrator authenticates with a one-time join token (`KICI_CLUSTER_JOIN_TOKEN`). The coordinator validates the token and issues a persistent credential
2. **Credential persistence:** The credential is saved to `KICI_CLUSTER_CREDENTIAL_FILE` (default: `~/.kici/peer-credential`) with `0600` permissions
3. **Subsequent connections:** The orchestrator loads its credential file and proves possession via HMAC (the credential itself is never sent over the wire)
4. **Encrypted channel:** All authentication happens over an ECDH-encrypted channel -- no auth material is transmitted in cleartext

## CLI commands

### List active peers

View all peers with active credentials:

```bash
kici-admin peer list
```

Output includes instance ID, role, credential status, and last connection time.

### Create a join token

Issue a new one-time join token for a peer:

```bash
# For a coordinator peer:
kici-admin peer create-token --role coordinator

# For a worker peer:
kici-admin peer create-token --role worker
```

Tokens expire after 1 hour by default and can only be used once.

### Revoke a peer

Invalidate a specific peer's credential:

```bash
kici-admin peer revoke --instance-id <id>
```

The revoked peer will be disconnected on its next heartbeat or reconnection attempt. It must re-join with a new token.

### Revoke all peers

Invalidate all peer credentials (emergency action):

```bash
kici-admin peer revoke-all --confirm
```

All peers will need new join tokens to reconnect. Use this for security incidents where credential compromise is suspected.

### Prune stale peer credentials (offline)

During warm redeploys the e2e tooling sometimes needs to wipe rows left behind by a previous cluster while preserving the ones created by the current test run. `prune-credentials` is a direct-DB, destructive verb that deletes every `peer_credentials` row whose `instance_id` does **not** match the supplied SQL `LIKE` pattern:

```bash
kici-admin peer prune-credentials --filter 'e2e-%' --database-url "$KICI_DATABASE_URL"
```

HTTP mode is intentionally unsupported — the call site is a preflight run while the orchestrator is stopped. Pair with `peer reset-raft-state` below when you also need the newly-booted orchestrator to self-elect with a clean Raft term.

### Reset Raft state (offline)

Deletes every row from the `raft_state` table so a freshly-started orchestrator self-elects with a clean term:

```bash
kici-admin peer reset-raft-state --database-url "$KICI_DATABASE_URL"
```

Destructive and direct-DB only, for the same reason as `prune-credentials`: the verb is meant to run while the orchestrator process is down.

## Re-joining after revocation

When a peer's credential is revoked:

1. Create a new join token on the coordinator:
   ```bash
   kici-admin peer create-token --role coordinator  # or --role worker
   ```
2. Set the new token on the revoked peer:
   ```bash
   export KICI_CLUSTER_JOIN_TOKEN=kici_join_v1.xxx.yyy
   ```
3. Restart the peer orchestrator
4. The peer authenticates with the new token and receives a fresh credential
5. Remove the `KICI_CLUSTER_JOIN_TOKEN` env var (no longer needed after first connection)

## Credential file format

The credential file (`~/.kici/peer-credential`) is a structured JSON file containing:

```json
{
  "instanceId": "orch-b-xyz789",
  "credential": "<credential-string>",
  "role": "coordinator",
  "issuedAt": "2026-03-22T14:30:00.000Z"
}
```

- **instanceId:** Unique identifier for this peer
- **credential:** The raw credential string (hashed with SHA-256 for HMAC authentication -- the credential itself is never sent over the wire)
- **role:** Peer role (`coordinator` or `worker`)
- **issuedAt:** When the credential was issued (useful for auditing)

Credentials expire after **90 days** by default. Use `kici-admin peer list` to check expiry dates. To re-issue credentials before they expire, revoke the peer with `kici-admin peer revoke --instance-id <id>`, generate a new token with `kici-admin peer create-token`, and have the peer rejoin.

## Secret key vs. join token

These are separate keys with different purposes:

| Key        | Environment variable           | Purpose                                                                                                                          |
| ---------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Secret key | `KICI_SECRET_KEY`              | Encrypts secret context values (API keys, deploy tokens) at rest. Also used for ephemeral key encryption in `run_ephemeral_keys` |
| Join token | `KICI_CLUSTER_JOIN_TOKEN`      | One-time peer authentication for cluster joining                                                                                 |
| Credential | `KICI_CLUSTER_CREDENTIAL_FILE` | Persistent file-based peer authentication for subsequent connections                                                             |

Rotating `KICI_SECRET_KEY` does not affect peer credentials. Revoking peer credentials does not affect secret encryption.

## Agent token rotation

Agent tokens are **not affected** by peer credential management. Agent authentication uses the existing create/revoke admin API flow (see [secrets management](./secrets.md)). Revoking peer credentials does not invalidate agent tokens.

## Periodic cleanup

The orchestrator automatically cleans up orphaned ephemeral keys and secret outputs from crashed or abandoned runs. By default:

- **Threshold:** Rows older than 24 hours are deleted
- **Interval:** Cleanup runs every hour

This ensures that even if a run crashes without completing its normal cleanup, the secret data does not accumulate indefinitely.
