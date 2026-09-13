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

| Command                        | What it does                                                                                                                                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kici local up`                | Start the plane, or return the already-running one (idempotent). Prints the orchestrator URL and control commands. Fails with the reason the port could not be freed, rather than booting over a still-held port and reporting a readiness timeout. |
| `kici local status`            | Report whether the plane is serving, its port, pid, and Postgres backend. A plane that is running but not ready is reported as such, with its readiness checks, rather than as stopped.                                                             |
| `kici local down`              | Stop the orchestrator and Postgres and confirm the port was released before reporting success. Exits non-zero, naming the process still holding the port, when it cannot free it.                                                                   |
| `kici local logs`              | Print the paths of the plane's logs and how they are rotated.                                                                                                                                                                                       |
| `kici local attach`            | Attach the plane to the hosted Platform (hybrid), so `kici run --local` uses real Platform-minted OIDC and attestation.                                                                                                                             |
| `kici local detach`            | Detach the plane from the Platform and return it to offline (independent) mode.                                                                                                                                                                     |
| `kici local trust-root <file>` | Export the plane's dev-signed identity trust root (`{ issuer, jwks }`) to a file, for offline `kici verify-attestation --trust-root`.                                                                                                               |

### Machine-readable status

`kici local status --json` prints one object and exits 0 for every state, so a
consumer reads the state from the payload rather than from the exit code:

```bash
$ kici local status --json
{"state":"ready","running":true,"pid":3768093,"port":4319,
 "url":"http://127.0.0.1:4319","pgKind":"embedded","stampVersion":3,
 "mode":"independent"}
```

`state` is one of `stopped`, `ready`, `unready`, `foreign-kici`,
`foreign-unknown`. This is the supported way for host tooling to ask whether a
plane is alive — prefer it over reading the state directory's stamp file, whose
layout is internal and changes with the stamp version. The key set is a fixed
allow-list that excludes the plane's admin token, so the output is safe to log.

Every key is always present, but only `state`, `running` and `mode` always carry
a value. The rest are `null` whenever the plane cannot supply them: for
`stopped` that is all of them, and `stampVersion` is populated only for `ready`.
Read them defensively (`jq -r '.pid // empty'`), not as guaranteed values.

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

| Path                                  | Contents                                                                                |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `~/.kici/local/pgdata/`               | Embedded PostgreSQL data directory (persistent across restarts).                        |
| `~/.kici/local/plane.pid`             | Orchestrator process id.                                                                |
| `~/.kici/local/stamp.json`            | Boot record: pid, port, Postgres backend, `kici` version, build commit, layout version. |
| `~/.kici/local/orchestrator.log`      | Orchestrator log (printed by `kici local logs`).                                        |
| `~/.kici/local/orchestrator.log.1`    | Previous generation of the orchestrator log, kept after a rotation.                     |
| `~/.kici/local/orchestrator.log.pg`   | PostgreSQL log of the plane's embedded cluster.                                         |
| `~/.kici/local/orchestrator.log.pg.1` | Previous generation of the PostgreSQL log, kept after a rotation.                       |
| `~/.kici/local/dev-identity/`         | Dev-signed identity keypair (private JWK at mode 0600, published public JWK).           |
| `~/.kici/local/cache/`                | Filesystem cache + provenance bundle store for offline runs.                            |

Default ports are `4319` for the orchestrator (HTTP + WebSocket) and `45432` for Postgres,
overridable via `KICI_LOCAL_ORCH_PORT` and `KICI_LOCAL_PG_PORT`.

### Log rotation

Both plane logs are rotated at plane start. When `kici local up` (or the first `kici run --local`
after the plane stops) finds a log of 50 MB or more, it renames it to the `.1` sibling and starts a
fresh one, discarding whatever `.1` held before. The plane therefore keeps at most two generations
of each log.

Rotation happens only at start, because that is the one moment no process holds the file open. A
plane that stays up for a long time keeps appending to the current log; stop and start it
(`kici local down && kici local up`) to rotate immediately.

## The plane listens on loopback only

Everything the plane runs lives on your machine: the orchestrator, its scalers, and the
agents they spawn. So it binds `127.0.0.1` and its storage endpoint is a loopback URL —
nothing it serves is reachable from another host, on a café network or an office LAN.

That is load-bearing rather than incidental. The plane runs with agent authentication
disabled (`KICI_AGENT_AUTH=none`), which answers any agent registration without a
credential. On a routable listener, any host that could open a WebSocket to the port would
register as an agent and be dispatched your next job — with your organization's resolved
secrets, in attached mode. The orchestrator refuses to start on that pairing, so the plane
cannot regress into it.

You cannot point the plane at another interface, and a remote agent cannot join it. To run
jobs on other machines, deploy an orchestrator (see
[orchestrator setup](orchestrator-setup.md)) with real agent authentication.

## The plane is a single-node cluster

The plane runs exactly one orchestrator process, so it declares itself a single-node
cluster at boot. A multi-node orchestrator waits out a peer-discovery window before it
elects itself leader, which is correct there — a node that self-elects during a network
partition splits the cluster. The plane has no peer to discover, so it skips that window
and elects itself on its first election tick.

That matters for the first run after a cold start. The plane's readiness endpoint reports
that the process has finished booting and is serving, not that it has elected a leader.
Without the single-node declaration, `kici local status` would report a healthy plane while
a dispatch still had nowhere to land, and `kici run <event> --local` would spend its whole
60-second trigger budget waiting for it.

You cannot join another orchestrator to the plane; to run a real cluster, deploy an
orchestrator (see [orchestrator setup](orchestrator-setup.md)).

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

The plane stamps the `kici` build identity — its version **and** its git build commit — plus
an on-disk layout version each time it boots. On the next `kici local up` **or**
`kici run --local`, a running plane whose stamped build identity differs from the current
`kici` build is self-healing:

- **Different build identity, compatible layout** — a running plane booted from a different
  `kici` build (a version bump, or a different build commit at the same version) is torn down
  and rebooted from the current build, **keeping** its data directory; the orchestrator runs
  any pending schema migrations on boot. This is what stops a plane left over from an earlier
  build from serving runs at a stale version.
- **Incompatible layout version** — the plane is torn down, its data directory is wiped, and
  a fresh plane is booted, so the plane never runs against a schema it cannot understand.
- **Same build identity** — the running plane is reused as-is.

Running `kici` from an unbuilt source tree (no concrete build identity) never triggers a
reboot, so a source-context run reuses whatever plane is healthy.
