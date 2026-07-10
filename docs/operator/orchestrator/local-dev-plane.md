---
title: Local dev plane
description: The warm per-user local orchestrator and Postgres that kici local manages for local development
---

The **local dev plane** is a warm, per-user pair of real processes on your machine — an
orchestrator running in independent mode plus a local PostgreSQL — that local development
runs dispatch through. It reuses the exact orchestrator and database the hosted service
runs, so a workflow you execute locally exercises the same engine as a routed run rather
than a separate simulator.

You manage it with the `kici local` command group. The plane is lazy: it boots on first
use and stays warm for subsequent runs.

## Commands

| Command                        | What it does                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `kici local up`                | Start the plane, or return the already-running one (idempotent). Prints the orchestrator URL and control commands.                    |
| `kici local status`            | Report whether the plane is running, its port, pid, and Postgres backend.                                                             |
| `kici local down`              | Stop the orchestrator and Postgres, and clear the plane's pidfile and stamp.                                                          |
| `kici local logs`              | Print the path of the plane orchestrator's log file.                                                                                  |
| `kici local attach`            | Attach the plane to the hosted Platform (hybrid), so `kici run --local` uses real Platform-minted OIDC and attestation.               |
| `kici local detach`            | Detach the plane from the Platform and return it to offline (independent) mode.                                                       |
| `kici local trust-root <file>` | Export the plane's dev-signed identity trust root (`{ issuer, jwks }`) to a file, for offline `kici verify-attestation --trust-root`. |

## PostgreSQL: embedded, with a Podman fallback

The plane needs a real PostgreSQL — the orchestrator's queue relies on Postgres features
(`ON CONFLICT`, partial indexes) that a lightweight substitute cannot provide. Two backends
are supported, selected automatically:

1. **Embedded PostgreSQL (preferred).** A bundled PostgreSQL binary is downloaded once on
   first boot and run against a data directory under the plane's state directory. No
   external dependency is required.
2. **Podman Postgres container (fallback).** When the embedded binary is unavailable on the
   platform, the plane starts a Postgres container with Podman instead. Force this path with
   `KICI_LOCAL_PG_MODE=podman`.

Either way it is the same PostgreSQL, so the local plane behaves identically to a hosted
deployment.

## State directory and ports

The plane persists its state under `~/.kici/local/` (or `$KICI_CONFIG_DIR/local` when
`KICI_CONFIG_DIR` is set):

| Path                             | Contents                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `~/.kici/local/pgdata/`          | Embedded PostgreSQL data directory (persistent across restarts).              |
| `~/.kici/local/plane.pid`        | Orchestrator process id.                                                      |
| `~/.kici/local/stamp.json`       | Boot record: pid, port, Postgres backend, `kici` version, layout version.     |
| `~/.kici/local/orchestrator.log` | Orchestrator log (printed by `kici local logs`).                              |
| `~/.kici/local/dev-identity/`    | Dev-signed identity keypair (private JWK at mode 0600, published public JWK). |
| `~/.kici/local/cache/`           | Filesystem cache + provenance bundle store for offline runs.                  |

Default ports are `4319` for the orchestrator (HTTP + WebSocket) and `45432` for Postgres,
overridable via `KICI_LOCAL_ORCH_PORT` and `KICI_LOCAL_PG_PORT`.

## Dev-signed identity (offline)

An offline routed run (`kici run --local --offline`) has no hosted platform to mint OIDC
tokens or attest build provenance, so the plane signs them locally. On first boot it
generates a fresh ES256 keypair under `~/.kici/local/dev-identity/` (the private key is
written at mode 0600 and is **never** derived from any real secret) and uses it to back
`ctx.kici.oidc.token()` and `ctx.attestProvenance()`. Every token and bundle carries the
fixed, clearly-non-production issuer `kici-local`.

`kici-local` can never masquerade as the hosted issuer. `kici verify-attestation` pins the
token issuer to a trust root supplied out-of-band, defaulting to the hosted issuer — so a
dev-signed bundle **rejects** against the default trust root. To verify a dev-signed bundle
offline, export the plane's trust root and pass it explicitly:

```bash
kici local trust-root ./local-trust-root.json
kici verify-attestation --bundle <bundle> --trust-root ./local-trust-root.json
```

## Attaching to the Platform (hybrid)

By default the plane runs offline (independent), with local secrets and the dev-signed
identity above. Attaching it to the hosted KiCI Platform switches it to **hybrid** mode, so
`kici run --local` mints OIDC tokens and provenance attestations through the **real
Platform** — verifiable against the Platform's trust root — instead of the dev-signed
substitute.

- After `kici login`, an interactive prompt offers to attach the plane. Answer **Y** to
  attach, **n** to stay offline (`--no-attach` on `kici login` skips the prompt).
- Attach or detach a running plane at any time with `kici local attach` / `kici local detach`.
  `kici logout` detaches automatically.
- Attaching provisions a per-user, org-scoped orchestrator key with your logged-in
  credentials and boots the plane against the Platform relay; the key is stored locally with
  owner-only permissions and revoked on detach. `kici local status` reports whether the plane
  is attached and to which organization.
- `kici run --local` auto-selects: attached and the Platform reachable → hybrid; otherwise
  offline. `--connected` forces hybrid (and errors if the plane is not attached); `--offline`
  forces the offline plane. If the Platform becomes unreachable, a `--local` run
  automatically falls back to the offline plane with a prominent banner rather than failing.

The agent always runs on this machine regardless of attachment — attaching only changes where
secrets and identity come from.

This dev-signed path is active only for the offline local dev plane. An orchestrator
connected to the hosted platform always mints identity through the platform, never with the
local key.

## Trusted execution profile (`--trusted`)

By default a `kici run --local` step runs credential-isolated: only a fixed system-variable
allowlist reaches the step, so your ambient host credentials (sops age key, SSH agent socket,
cloud credentials) never leak into workflow code. For your **own** host-configuration or
fleet workloads — a step that runs `sops`, `ssh`, or `aws` against your machine — add
`--trusted`:

```bash
kici run --local --trusted push          # isolated tmp checkout
kici run --local --trusted --in-place push   # against the real working tree
```

`--trusted` routes the run to the plane's **trusted agent profile**: steps run with your
ambient host environment passed through (minus the agent's own KiCI identity secrets, which
are always scrubbed) and without bubblewrap namespace isolation. `--no-sandbox` is an alias
for `--trusted`. A loud banner line marks a trusted run so it is never silent. Because on the
local plane you are both the operator and the only trigger source, the flag _is_ your
configuration choice — it selects a pre-configured trusted scaler label set rather than
setting any per-dispatch flag, so the "trusted-env is an agent-launch property, never
wire-derived" guarantee holds identically here. See
[Agent execution security](../security/agent-security.md#trusted-fleet-agent-profile-kici_trusted_env)
for the full trust model.

## Staleness on upgrade

The plane stamps the `kici` version and an on-disk layout version each time it boots. On the
next `kici local up` after a `kici` upgrade:

- **Compatible layout, newer `kici` version** — the data directory is kept and the
  orchestrator runs any pending schema migrations on boot.
- **Incompatible layout version** — the plane is torn down, its data directory is wiped, and
  a fresh plane is booted, so the plane never runs against a schema it cannot understand.
