---
title: Peer credential management
description: Manage peer credentials for orchestrator cluster authentication
---

Orchestrator peers authenticate using persistent credentials. A peer gets its credential from a join token exchange, or, for a coordinator without a token, from the coordinator itself. This guide covers managing peer credentials: listing, revoking, and re-joining after revocation.

## How peer authentication works

1. **First join:** A worker, or a coordinator given a token, authenticates with a one-time join token (`KICI_CLUSTER_JOIN_TOKEN`); the coordinator it connects to validates the token and issues a persistent credential. A coordinator without a token issues its own credential from the shared database on its first peer connection, unless an operator revoked its credential
2. **Credential persistence:** The credential is saved to `KICI_CLUSTER_CREDENTIAL_FILE` (default: `~/.kici/peer-credential`) with `0600` permissions
3. **Subsequent connections:** The orchestrator loads its credential file and proves possession with a proof bound to the handshake (the credential itself is never sent over the wire)
4. **Mutual proof:** The orchestrator it connects to answers with its own proof that it holds the same credential, and the connecting orchestrator accepts nothing until that proof verifies. On first join the joining peer proves its token the same way and never sends the token
5. **Rejections:** A coordinator keeps its credential file when a peer rejects a credential that the coordinator's own database holds as valid. It deletes the file only when its database also no longer holds the credential (revoked, expired or missing), and then issues a new one

## CLI commands

### List active peers

View all peers with active credentials:

```bash
kici-admin peer list
```

Output lists each peer's instance ID, role, creation time, last-seen time, and credential expiry. It reads the orchestrator database directly, so it needs `KICI_DATABASE_URL`. Add `--json` for a JSON record that also says whether a coordinator issued the credential to itself (`selfIssued`) and which coordinator last validated it (`lastValidatedBy`).

### Create a join token

Issue a new one-time join token for a peer:

```bash
# For a coordinator peer:
kici-admin peer create-token --role coordinator

# For a worker peer:
kici-admin peer create-token --role worker
```

Tokens expire after 1 hour by default. A peer that joins with a token binds it to its own instance; `kici-admin join` can repeat with the same token until it expires, so treat a token like a password.

### Revoke a peer

Invalidate a specific peer's credential:

```bash
kici-admin peer revoke --instance-id <id>
```

A revoke does not close the peer's open connections. The peer's next connection attempt is refused, and the peer must re-join with a new token. This applies to a coordinator with a stable `KICI_CLUSTER_INSTANCE_ID` too: it does not issue itself a new credential after a revoke. A revoke applies to one instance ID. A coordinator without a stable instance ID gets a new ID when it restarts, and the new ID issues its own credential.

### Revoke all peers

Invalidate all peer credentials (emergency action):

```bash
kici-admin peer revoke-all --confirm
```

All peers will need new join tokens to reconnect, including every coordinator with a stable `KICI_CLUSTER_INSTANCE_ID`. Use this for security incidents where credential compromise is suspected.

### Prune stale peer credentials (offline)

When you redeploy a cluster in place, rows left behind by the previous cluster stay in the database. Give the instances of the new cluster a common ID prefix, and keep only the rows that match it. `prune-credentials` is a direct-DB, destructive verb that deletes every `peer_credentials` row whose `instance_id` does **not** match the supplied SQL `LIKE` pattern:

```bash
kici-admin peer prune-credentials --filter 'cluster-b-%' --database-url "$KICI_DATABASE_URL"
```

HTTP mode is intentionally unsupported: run it as a preflight step while the orchestrator is stopped. Pair with `peer reset-raft-state` below when you also need the newly-booted orchestrator to self-elect with a clean Raft term.

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
